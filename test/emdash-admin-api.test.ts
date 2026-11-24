import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AdminApiError,
	BACKOFF_MS,
	FAILS_BEFORE_COULD_NOT_CHECK,
	POLL_MS,
	RETRY_POLL_MS,
	createAdminApi,
	detailsStale,
	retrying,
	watchStatus,
	type AdminStatus,
	type ApiFetch,
	type Scheduler,
	type StatusWatch,
} from "../src/emdash/admin/api.ts";
import { ROUTE_BASE } from "../src/emdash/core/routes.ts";
import { DEFAULT_SETTINGS } from "../src/emdash/core/settings.ts";
import type { IndexesResponse, SearchSettings } from "../src/emdash/core/ports.ts";

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { "content-type": "application/json" } });
const fail = (status: number, code: string, message: string) =>
	new Response(JSON.stringify({ success: false, error: { code, message } }), { status, headers: { "content-type": "application/json" } });

interface Call {
	url: string;
	method: string;
	body: unknown;
}

function fakeFetch(reply: (call: Call) => Response | Promise<Response>): { fetch: ApiFetch; calls: Call[] } {
	const calls: Call[] = [];
	const fetch: ApiFetch = async (input, init) => {
		const call = { url: String(input), method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
		calls.push(call);
		return reply(call);
	};
	return { fetch, calls };
}

/** A manual scheduler: `advance(ms)` runs due timers in order and waits for their async work. */
function fakeScheduler() {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const scheduler: Scheduler = {
		setTimeout(fn, ms) {
			const id = nextId++;
			timers.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimeout(id) {
			timers.delete(id as number);
		},
	};
	const flush = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await new Promise((r) => setImmediate(r));
	};
	return {
		scheduler,
		pending: () => [...timers.values()].map((t) => t.at - now),
		async advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = due[1].at;
				due[1].fn();
				await flush();
			}
			now = end;
		},
		flush,
	};
}

test("the route base matches the core's", () => {
	const { fetch, calls } = fakeFetch(() => ok({ state: "idle", pending: false }));
	return createAdminApi(fetch)
		.status()
		.then(() => {
			assert.equal(calls[0]!.url, `${ROUTE_BASE}status`);
		});
});

test("list indexes unwraps the envelope", async () => {
	const indexes: IndexesResponse = [
		{ name: "default", active: { gzBytes: 1200, rawBytes: 4000, pages: 42, sections: 0, builtAt: 5 }, budgetKB: 300, history: [] },
	];
	const { fetch, calls } = fakeFetch(() => ok(indexes));
	const got = await createAdminApi(fetch).indexes();
	assert.deepEqual(got, indexes);
	assert.equal(calls[0]!.url, `${ROUTE_BASE}indexes`);
	assert.equal(calls[0]!.method, "GET");
});

test("an error response throws the server's code and message", async () => {
	const { fetch } = fakeFetch(() => fail(403, "FORBIDDEN", "Not allowed"));
	await assert.rejects(createAdminApi(fetch).indexes(), (e: unknown) => {
		assert.ok(e instanceof AdminApiError);
		assert.equal(e.code, "FORBIDDEN");
		assert.equal(e.status, 403);
		assert.equal(e.message, "Not allowed");
		return true;
	});
});

test("a network failure and a non-JSON body are AdminApiErrors", async () => {
	const down = fakeFetch(() => Promise.reject(new TypeError("Failed to fetch")));
	await assert.rejects(createAdminApi(down.fetch).status(), (e: unknown) => e instanceof AdminApiError && e.code === "network");
	const html = fakeFetch(() => new Response("<html>", { status: 502 }));
	await assert.rejects(createAdminApi(html.fetch).status(), (e: unknown) => e instanceof AdminApiError && e.status === 502);
});

test("a refused rebuild returns the server's code", async () => {
	const { fetch, calls } = fakeFetch(() => ok({ started: false, code: "no-collections", status: { state: "idle", pending: false } }));
	const r = await createAdminApi(fetch).rebuild();
	assert.equal(r.started, false);
	assert.equal(r.code, "no-collections");
	assert.equal(calls[0]!.method, "POST");
	assert.equal(calls[0]!.url, `${ROUTE_BASE}rebuild`);
});

test("save settings posts JSON and returns the server's values", async () => {
	const sent: SearchSettings = { ...DEFAULT_SETTINGS, placeholder: "Find", results: "javascript:alert(1)" };
	const server: SearchSettings = { ...sent, results: "/search" };
	const { fetch, calls } = fakeFetch(() => ok(server));
	const got = await createAdminApi(fetch).saveSettings(sent);
	assert.deepEqual(got, server);
	assert.equal(calls[0]!.method, "POST");
	assert.equal(calls[0]!.url, `${ROUTE_BASE}settings`);
	assert.deepEqual(calls[0]!.body, sent);
});

test("get settings", async () => {
	const { fetch, calls } = fakeFetch(() => ok(DEFAULT_SETTINGS));
	assert.deepEqual(await createAdminApi(fetch).settings(), DEFAULT_SETTINGS);
	assert.equal(calls[0]!.method, "GET");
});

test("error codes pass through as strings (plan-limit)", async () => {
	const { fetch } = fakeFetch(() => ok({ state: "failed", pending: true, error: "D1 limit", errorCode: "plan-limit" }));
	const s: AdminStatus = await createAdminApi(fetch).status();
	assert.equal(s.errorCode, "plan-limit");
});

// --- polling -----------------------------------------------------------------

function watch(replies: Array<AdminStatus | "error">) {
	const clock = fakeScheduler();
	let i = 0;
	const { fetch, calls } = fakeFetch(() => {
		const r = replies[Math.min(i++, replies.length - 1)]!;
		return r === "error" ? fail(500, "INTERNAL_ERROR", "boom") : ok(r);
	});
	const updates: Parameters<Parameters<typeof watchStatus>[1]>[0][] = [];
	let w: StatusWatch | undefined;
	return {
		clock,
		calls,
		updates,
		start() {
			w = watchStatus(createAdminApi(fetch), (u) => updates.push(u), { scheduler: clock.scheduler });
			return w;
		},
	};
}

const running: AdminStatus = { state: "running", pending: true };
const queued: AdminStatus = { state: "queued", pending: true };
const idle: AdminStatus = { state: "idle", pending: false, pages: 3, sections: 0 };
const failed: AdminStatus = { state: "failed", pending: false, error: "too big", errorCode: "too-large" };

test("polls every 2 s while queued or running, stops on idle", async () => {
	const h = watch([queued, running, running, idle]);
	h.start();
	await h.clock.flush();
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.clock.pending(), [POLL_MS]);
	assert.equal(POLL_MS, 2000);
	await h.clock.advance(1999);
	assert.equal(h.calls.length, 1);
	await h.clock.advance(1);
	assert.equal(h.calls.length, 2);
	await h.clock.advance(4000);
	assert.equal(h.calls.length, 4);
	assert.deepEqual(h.clock.pending(), []);
	assert.deepEqual(h.updates.at(-1), { status: idle, couldNotCheck: false, failures: 0 });
	await h.clock.advance(60_000);
	assert.equal(h.calls.length, 4);
});

test("stops polling on a settled failure and keeps the server's error", async () => {
	const h = watch([running, failed]);
	h.start();
	await h.clock.flush();
	await h.clock.advance(POLL_MS);
	assert.equal(h.calls.length, 2);
	assert.deepEqual(h.clock.pending(), []);
	assert.equal(h.updates.at(-1)!.status!.errorCode, "too-large");
});

test("a failed build the tick retries keeps polling slowly, and a background recovery shows (builtAt changes)", async () => {
	const retry: AdminStatus = { state: "failed", pending: true, error: "boom", errorCode: "error", pages: 3, sections: 0, builtAt: 1 };
	const recovered: AdminStatus = { state: "idle", pending: false, pages: 4, sections: 0, builtAt: 2 };
	const h = watch([retry, retry, recovered]);
	h.start();
	await h.clock.flush();
	assert.deepEqual(h.clock.pending(), [RETRY_POLL_MS]);
	await h.clock.advance(RETRY_POLL_MS);
	assert.equal(h.calls.length, 2);
	await h.clock.advance(RETRY_POLL_MS);
	assert.equal(h.calls.length, 3);
	assert.deepEqual(h.clock.pending(), [], "idle: stops");
	assert.deepEqual(h.updates.at(-1)!.status, recovered);
	// The page reads the index details again: the build time it shows is the old one.
	const shown = { name: "default" as const, active: { gzBytes: 1, rawBytes: 1, pages: 3, sections: 0, builtAt: 1 }, budgetKB: 300, history: [] };
	assert.equal(detailsStale(retry, recovered, shown), true);
});

test("retrying: pending failures and a never-built no-collections; settled ones are not", () => {
	assert.equal(retrying({ state: "failed", pending: true, errorCode: "deadline" }), true);
	assert.equal(retrying({ state: "failed", pending: false, errorCode: "no-collections" }), true);
	assert.equal(retrying({ state: "failed", pending: false, errorCode: "no-collections", builtAt: 1 }), false);
	assert.equal(retrying({ state: "failed", pending: false, errorCode: "plan-limit" }), false);
	assert.equal(retrying({ state: "idle", pending: true }), false);
});

test("backs off to 30 s after an error, then back to 2 s", async () => {
	const h = watch([running, "error", running, idle]);
	h.start();
	await h.clock.flush();
	await h.clock.advance(POLL_MS);
	assert.equal(h.calls.length, 2);
	assert.equal(BACKOFF_MS, 30_000);
	assert.deepEqual(h.clock.pending(), [BACKOFF_MS]);
	const afterError = h.updates.at(-1)!;
	assert.equal(afterError.failures, 1);
	assert.equal(afterError.couldNotCheck, false);
	assert.deepEqual(afterError.status, running, "the last good status is kept");
	await h.clock.advance(BACKOFF_MS);
	assert.equal(h.calls.length, 3);
	assert.deepEqual(h.clock.pending(), [POLL_MS]);
	assert.equal(h.updates.at(-1)!.failures, 0);
});

test('"could not check" after 3 failures in a row; a success clears it', async () => {
	const h = watch(["error", "error", "error", idle]);
	h.start();
	await h.clock.flush();
	await h.clock.advance(BACKOFF_MS);
	assert.equal(h.updates.at(-1)!.couldNotCheck, false);
	await h.clock.advance(BACKOFF_MS);
	assert.equal(FAILS_BEFORE_COULD_NOT_CHECK, 3);
	assert.equal(h.updates.at(-1)!.couldNotCheck, true);
	assert.equal(h.updates.at(-1)!.failures, 3);
	assert.equal(h.updates.at(-1)!.error!.code, "INTERNAL_ERROR");
	assert.equal(h.updates.at(-1)!.status, null);
	await h.clock.advance(BACKOFF_MS);
	assert.deepEqual(h.updates.at(-1), { status: idle, couldNotCheck: false, failures: 0 });
	assert.deepEqual(h.clock.pending(), []);
});

test("refresh checks now and restarts polling; stop ends it", async () => {
	const h = watch([idle, running, running]);
	const w = h.start();
	await h.clock.flush();
	assert.deepEqual(h.clock.pending(), []);
	w.refresh();
	await h.clock.flush();
	assert.equal(h.calls.length, 2);
	assert.deepEqual(h.clock.pending(), [POLL_MS]);
	w.stop();
	assert.deepEqual(h.clock.pending(), []);
	await h.clock.advance(60_000);
	assert.equal(h.calls.length, 2);
});

test("a status known from a rebuild response seeds the watch without a fetch", async () => {
	const h = watch([idle]);
	const clock = h.clock;
	const { fetch, calls } = fakeFetch(() => ok(idle));
	const updates: unknown[] = [];
	watchStatus(createAdminApi(fetch), (u) => updates.push(u), { scheduler: clock.scheduler, initial: running });
	await clock.flush();
	assert.equal(calls.length, 0);
	assert.deepEqual(updates[0], { status: running, couldNotCheck: false, failures: 0 });
	assert.deepEqual(clock.pending(), [POLL_MS]);
	await clock.advance(POLL_MS);
	assert.equal(calls.length, 1);
});

test("a reply that lands after stop is ignored", async () => {
	const clock = fakeScheduler();
	let release!: (r: Response) => void;
	const { fetch } = fakeFetch(() => new Promise<Response>((r) => (release = r)));
	const updates: unknown[] = [];
	const w = watchStatus(createAdminApi(fetch), (u) => updates.push(u), { scheduler: clock.scheduler });
	await clock.flush();
	w.stop();
	release(ok(running));
	await clock.flush();
	assert.equal(updates.length, 0);
	assert.deepEqual(clock.pending(), []);
});

test("onUpdate that calls stop: no further poll is scheduled or sent (busy and failed checks)", async () => {
	for (const reply of [running, "error"] as const) {
		const clock = fakeScheduler();
		const { fetch, calls } = fakeFetch(() => (reply === "error" ? fail(500, "INTERNAL_ERROR", "boom") : ok(reply)));
		let w: StatusWatch | undefined;
		w = watchStatus(createAdminApi(fetch), () => w?.stop(), { scheduler: clock.scheduler });
		await clock.flush();
		assert.equal(calls.length, 1);
		assert.deepEqual(clock.pending(), [], `no timer after stop in onUpdate (${reply === "error" ? "error" : "running"})`);
		await clock.advance(120_000);
		assert.equal(calls.length, 1);
	}
});

test("a stopped watch never fires a request, even from a timer that was already due", async () => {
	const clock = fakeScheduler();
	let fired: (() => void) | undefined;
	const scheduler: Scheduler = { setTimeout: (fn) => ((fired = fn), 1), clearTimeout: () => {} };
	const { fetch, calls } = fakeFetch(() => ok(running));
	const w = watchStatus(createAdminApi(fetch), () => {}, { scheduler, initial: running });
	w.stop();
	fired!(); // a timer whose clearTimeout came too late
	await clock.flush();
	assert.equal(calls.length, 0);
});

test("a status reply without a valid state is bad-response", async () => {
	for (const data of [null, {}, { state: "busy", pending: true }, { state: "idle", pending: "no" }, [running]]) {
		const { fetch } = fakeFetch(() => ok(data));
		await assert.rejects(createAdminApi(fetch).status(), (e: unknown) => e instanceof AdminApiError && e.code === "bad-response");
	}
	const { fetch } = fakeFetch(() => ok({ started: true, status: null }));
	await assert.rejects(createAdminApi(fetch).rebuild(), (e: unknown) => e instanceof AdminApiError && e.code === "bad-response");
});

test("a bad status reply goes through the normal back-off and polling recovers", async () => {
	const clock = fakeScheduler();
	const replies: unknown[] = [null, { success: true }, idle];
	let i = 0;
	const { fetch, calls } = fakeFetch(() => ok(replies[Math.min(i++, replies.length - 1)]));
	const updates: Parameters<Parameters<typeof watchStatus>[1]>[0][] = [];
	watchStatus(createAdminApi(fetch), (u) => updates.push(u), { scheduler: clock.scheduler });
	await clock.flush();
	assert.equal(updates.at(-1)!.error?.code, "bad-response");
	assert.deepEqual(clock.pending(), [BACKOFF_MS]);
	await clock.advance(BACKOFF_MS);
	assert.equal(updates.at(-1)!.failures, 2);
	await clock.advance(BACKOFF_MS);
	assert.equal(calls.length, 3);
	assert.deepEqual(updates.at(-1), { status: idle, couldNotCheck: false, failures: 0 });
});
