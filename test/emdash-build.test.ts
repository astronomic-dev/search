import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createFakeKv, type FakeKv } from "./emdash/fake-kv.ts";
import { collection, createFakeContent, entry, portableText, type FakeContent } from "./emdash/fake-content.ts";
import { BUILD_DEADLINE_MS, INTERRUPTED_LIMIT, INTERRUPTED_MESSAGE, runIfDue, startRebuild } from "../src/emdash/core/build.ts";
import { MAX_WAIT_MS, QUIET_MS, SOON_MS, countsAsChange, isDue, markDirty, onContentEvent, type ContentEvent } from "../src/emdash/core/refresh.ts";
import { LEASE_MS, MAX_INDEX_BYTES, emptyState, readIndex, readState, takeLease, updateState } from "../src/emdash/core/store.ts";
import { minisearchEngine } from "../src/core/minisearch.ts";
import type { IndexFile } from "../src/core/types.ts";
import type { KvPort, SearchPorts, SearchState } from "../src/emdash/core/ports.ts";
import type { EmDashEntry as Entry } from "../src/emdash/core/ports.ts";

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);

interface Rig {
	p: SearchPorts;
	kv: FakeKv;
	fc: FakeContent;
	clock: { now: number };
	queued: Date[];
	deferred: Array<() => Promise<void>>;
	logs: Array<{ level: string; message: string }>;
}

function rig(input: Parameters<typeof createFakeContent>[0] = {}, kv: KvPort = createFakeKv()): Rig {
	const fc = createFakeContent({ collections: [collection("posts")], pageSize: 50, ...input });
	const clock = { now: T0 };
	const queued: Date[] = [];
	const deferred: Array<() => Promise<void>> = [];
	const logs: Rig["logs"] = [];
	const log = (level: string) => (message: string) => void logs.push({ level, message });
	const p: SearchPorts = {
		kv,
		content: fc.content,
		schema: fc.schema,
		log: { info: log("info"), warn: log("warn"), error: log("error") },
		queue: async (at) => void queued.push(at),
		defer: (task) => void deferred.push(task),
		now: () => clock.now,
	};
	return { p, kv: kv as FakeKv, fc, clock, queued, deferred, logs };
}

async function state(kv: KvPort): Promise<SearchState> {
	return (await readState(kv)).state;
}

/** Loads the active index file of a locale into the engine. */
async function loadActive(kv: KvPort, locale = "en") {
	const s = await state(kv);
	assert.ok(s.active, "an active index");
	const json = await readIndex(kv, s, s.active.version, locale);
	assert.ok(json, `the ${locale} file reads back`);
	return { file: JSON.parse(json) as IndexFile, json, engine: minisearchEngine.load(JSON.parse(json) as IndexFile), active: s.active };
}

const urls = (engine: ReturnType<typeof minisearchEngine.load>) => engine.records().map((r) => r.url).sort();

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

test("runIfDue on a fresh install builds an index the engine loads, and fuzzy search finds it", async () => {
	const r = rig({ entries: [entry("posts", "northwind-rebrand", { data: { title: "Northwind rebrand", content: portableText("A new look for Northwind.") } }), entry("posts", "other")] });
	const result = await runIfDue(r.p, {}, "tick");
	assert.equal(result.ok, true);
	assert.ok("active" in result);
	const { engine, file } = await loadActive(r.kv);
	assert.equal(file.locale, "en");
	assert.equal(file.index, "default");
	assert.deepEqual(file.settings.types, { posts: { label: "Posts" } });
	const hits = engine.search("nortwind");
	assert.equal(hits[0]?.id, "en:/posts/northwind-rebrand");
	const s = await state(r.kv);
	assert.equal(s.lease, null);
	assert.equal(s.last?.ok, true);
});

test("one index file per locale; the default locale always has one", async () => {
	const r = rig({
		defaultLocale: "en",
		entries: [entry("posts", "hola", { locale: "es", data: { title: "Hola mundo" } })],
		paths: {},
	});
	await runIfDue(r.p, {}, "tick");
	const s = await state(r.kv);
	assert.deepEqual(Object.keys(s.active!.locales).sort(), ["en", "es"]);
	const es = await loadActive(r.kv, "es");
	assert.deepEqual(urls(es.engine), ["/posts/hola"]);
	const en = await loadActive(r.kv, "en");
	assert.deepEqual(urls(en.engine), []);
});

test("not due: a built, clean state skips", async () => {
	const r = rig({ entries: [entry("posts", "a")] });
	await runIfDue(r.p, {}, "tick");
	r.clock.now += 120_000;
	assert.deepEqual(await runIfDue(r.p, {}, "tick"), { ok: true, skipped: "not-due" });
});

test("nightly forces a build of a clean state", async () => {
	const r = rig({ entries: [entry("posts", "a")] });
	await runIfDue(r.p, {}, "tick");
	const first = (await state(r.kv)).active!.builtAt;
	r.clock.now += 60_000;
	const result = await runIfDue(r.p, {}, "nightly");
	assert.ok(result.ok && "active" in result);
	const s = await state(r.kv);
	assert.notEqual(s.active!.builtAt, first);
	assert.equal(s.force, false);
});

test("a live lease gives code running, and force stays set", async () => {
	const r = rig({ entries: [entry("posts", "a")] });
	await updateState(r.kv, (s) => ({ ...s, force: true }));
	const lease = await takeLease(r.kv, T0);
	assert.ok(lease);
	await updateState(r.kv, (s) => ({ ...s, force: true }));
	assert.deepEqual(await runIfDue(r.p, {}, "tick"), { ok: false, code: "running" });
	assert.equal((await state(r.kv)).force, true);
});

test("the stats are right for a fixed fixture", async () => {
	const r = rig({
		collections: [collection("posts"), collection("docs")],
		entries: [
			entry("posts", "one", { data: { title: "One", content: portableText("First post.") } }),
			entry("posts", "two", { data: { title: "Two" } }),
			entry("posts", "draft", { status: "draft" }),
			entry("posts", "gone", { id: "nopath" }),
			entry("docs", "intro", { data: { title: "Intro" } }),
		],
		paths: { nopath: null },
	});
	await runIfDue(r.p, {}, "tick");
	const { active, json } = await loadActive(r.kv);
	assert.equal(active.pages, 3);
	assert.equal(active.sections, 0);
	assert.equal(active.records, 3);
	assert.equal(active.skipped, 1);
	const file = active.locales.en;
	assert.equal(file.rawBytes, Buffer.byteLength(json, "utf8"));
	// CompressionStream and zlib differ by a few header bytes at most.
	assert.ok(Math.abs(file.gzBytes - gzipSync(json).length) <= 32, `gzBytes ${file.gzBytes} vs ${gzipSync(json).length}`);
	assert.equal(file.etag, `"${createHash("sha256").update(json).digest("hex").slice(0, 10)}"`);
	assert.equal(file.chunks, 1);
	const s = await state(r.kv);
	assert.equal(s.history.length, 1);
	assert.equal(s.history[0].pages, 3);
});

test("clip is applied to the engine settings", async () => {
	const long = "word ".repeat(400);
	const r = rig({ entries: [entry("posts", "long", { data: { title: "Long", content: portableText(long) } })] });
	await runIfDue(r.p, { clip: 300 }, "tick");
	const { file } = await loadActive(r.kv);
	assert.equal(file.settings.clip, 300);
});

test("the version and the file change together: publish adds, unpublish removes", async () => {
	const r = rig({ entries: [entry("posts", "a", { id: "a" })] });
	await runIfDue(r.p, {}, "tick");
	const v1 = (await state(r.kv)).active!.version;

	r.fc.put(entry("posts", "b", { id: "b", data: { title: "Bravo" } }));
	await onContentEvent(r.p, "afterPublish", { collection: "posts", content: { id: "b", status: "published" } });
	r.clock.now += QUIET_MS;
	await runIfDue(r.p, {}, "tick");
	const second = await loadActive(r.kv);
	assert.notEqual(second.active.version, v1);
	assert.deepEqual(urls(second.engine), ["/posts/a", "/posts/b"]);
	// The old version is no longer served.
	assert.equal(await readIndex(r.kv, await state(r.kv), v1, "en"), null);

	r.fc.put(entry("posts", "b", { id: "b", status: "draft" }));
	await onContentEvent(r.p, "afterUnpublish", { collection: "posts", content: { id: "b", status: "draft" } });
	r.clock.now += QUIET_MS;
	await runIfDue(r.p, {}, "tick");
	const third = await loadActive(r.kv);
	assert.notEqual(third.active.version, second.active.version);
	assert.deepEqual(urls(third.engine), ["/posts/a"]);
	// Only the active run's chunks are left.
	assert.deepEqual(
		r.kv.keys("chunk:").map((k) => k.split(":")[1]),
		[third.active.runId],
	);
});

test("change during a build: it publishes, stays dirty, and the next tick builds the new entry", async () => {
	const r = rig({ entries: [entry("posts", "a", { id: "a" })] });
	const list = r.fc.content.list;
	let once = true;
	r.p.content = {
		...r.fc.content,
		async list(c, cursor) {
			const page = await list(c, cursor);
			if (once) {
				once = false;
				r.fc.put(entry("posts", "late", { id: "late", data: { title: "Late arrival" } }));
				await onContentEvent(r.p, "afterPublish", { collection: "posts", content: { id: "late", status: "published" } });
			}
			return page;
		},
	};
	const first = await runIfDue(r.p, {}, "tick");
	assert.ok(first.ok && "active" in first);
	const s = await state(r.kv);
	assert.ok(s.dirty > s.builtGen, "still dirty");
	assert.deepEqual(urls((await loadActive(r.kv)).engine), ["/posts/a"]);

	r.clock.now += QUIET_MS;
	const second = await runIfDue(r.p, {}, "tick");
	assert.ok(second.ok && "active" in second);
	assert.deepEqual(urls((await loadActive(r.kv)).engine), ["/posts/a", "/posts/late"]);
	const after = await state(r.kv);
	assert.equal(after.dirty, after.builtGen);
	assert.equal(after.dirtySince, null);
});

test("deadline: past 2 min before a chunk write, the run stops, deletes its chunks and keeps active", async () => {
	const kv = createFakeKv();
	const r = rig({ entries: [entry("posts", "a", { id: "a" })] }, kv);
	await runIfDue(r.p, {}, "tick");
	const before = await state(kv);

	// Two locales; the clock jumps past the deadline after the first chunk write.
	r.fc.put(entry("posts", "b", { id: "b", locale: "es" }));
	await onContentEvent(r.p, "afterPublish", { collection: "posts", content: { id: "b", status: "published" } });
	r.clock.now += QUIET_MS;
	const sets: string[] = [];
	const wrapped: KvPort = {
		get: (k) => kv.get(k),
		getVersioned: (k) => kv.getVersioned(k),
		compareAndSet: (k, rev, v) => kv.compareAndSet(k, rev, v),
		delete: (k) => kv.delete(k),
		async set(k, v) {
			await kv.set(k, v);
			if (k.startsWith("chunk:")) {
				sets.push(k);
				r.clock.now += BUILD_DEADLINE_MS + 1;
			}
		},
	};
	r.p.kv = wrapped;
	const result = await runIfDue(r.p, {}, "tick");
	assert.equal(!result.ok && "code" in result && result.code, "deadline");
	assert.equal(sets.length, 1, "no chunk written after the deadline");
	const s = await state(kv);
	assert.equal(s.active!.runId, before.active!.runId);
	assert.deepEqual(r.kv.keys("chunk:").map((k) => k.split(":")[1]), [before.active!.runId]);
	assert.ok(s.lease, "the lease is left to expire");
	assert.equal(s.last?.errorCode, "deadline");
	assert.ok(s.dirty > s.builtGen, "still dirty, so a later tick retries");

	// After the lease expires, the next tick builds.
	r.p.kv = kv;
	r.clock.now = s.lease!.until + 1;
	const retry = await runIfDue(r.p, {}, "tick");
	assert.ok(retry.ok && "active" in retry);
	assert.deepEqual(Object.keys((await state(kv)).active!.locales).sort(), ["en", "es"]);
});

test("too large: fails before any chunk, keeps active, records too-large", async () => {
	const r = rig({ entries: [entry("posts", "a", { id: "a" })] });
	await runIfDue(r.p, {}, "tick");
	const before = await state(r.kv);
	const huge = "lorem ipsum dolor ".repeat(Math.ceil(MAX_INDEX_BYTES / 18) + 1000);
	r.fc.put(entry("posts", "huge", { id: "huge", data: { title: "Huge", content: portableText(huge) } }));
	await onContentEvent(r.p, "afterPublish", { collection: "posts", content: { id: "huge", status: "published" } });
	r.clock.now += QUIET_MS;
	r.kv.resetCalls();
	const result = await runIfDue(r.p, {}, "tick");
	assert.equal(result.ok, false);
	assert.equal(!result.ok && "code" in result && result.code, "too-large");
	assert.ok(!r.kv.calls.some((c) => c.op === "set" && c.key.startsWith("chunk:")), "no chunk written");
	const s = await state(r.kv);
	assert.equal(s.active!.runId, before.active!.runId);
	assert.equal(s.last?.ok, false);
	assert.equal(s.last?.errorCode, "too-large");
	assert.match(s.last?.error ?? "", /bytes/);
	assert.equal(s.lease, null);
	// Settled: it waits for the next change instead of failing every minute.
	r.clock.now += 120_000;
	assert.deepEqual(await runIfDue(r.p, {}, "tick"), { ok: true, skipped: "not-due" });
});

test("no site URL: the build needs none; the index holds paths and keeps no site URL", async () => {
	const r = rig({ siteUrl: null, entries: [entry("posts", "a")] });
	assert.equal((await runIfDue(r.p, {}, "tick")).ok, true);
	const s = await state(r.kv);
	assert.equal(s.active?.siteUrl, undefined);
	assert.deepEqual(urls((await loadActive(r.kv)).engine), ["/posts/a"]);
	assert.deepEqual(r.kv.keys().filter((k) => !k.startsWith("chunk:")), ["state"], "no other key is written (no origin store)");
});

test("a site URL in EmDash is kept on the index for the admin; the index still holds paths", async () => {
	const r = rig({ entries: [entry("posts", "a")] });
	assert.equal((await runIfDue(r.p, {}, "tick")).ok, true);
	assert.equal((await state(r.kv)).active?.siteUrl, "https://example.com");
	assert.ok(urls((await loadActive(r.kv)).engine).every((u) => !!u && u.startsWith("/")));
});

test("never built: the first tick builds with no Rebuild now; no-collections retries once a collection opts in", async () => {
	const collections = [collection("posts", { supports: [] })];
	const r = rig({ collections, entries: [entry("posts", "a")] });
	const first = await runIfDue(r.p, {}, "tick");
	assert.equal(!first.ok && "code" in first && first.code, "no-collections");
	const at = (await state(r.kv)).last?.at;
	r.clock.now += 60_000;
	assert.deepEqual(await runIfDue(r.p, {}, "tick"), { ok: true, skipped: "not-due" }, "still none: no lease, nothing recorded");
	assert.equal((await state(r.kv)).last?.at, at);
	// A template's seed adds the collection with no content hook.
	collections[0] = collection("posts");
	r.clock.now += 60_000;
	assert.equal((await runIfDue(r.p, {}, "tick")).ok, true);
});

test("no-collections after a successful build does not retry by itself", async () => {
	const collections = [collection("posts")];
	const r = rig({ collections, entries: [entry("posts", "a")] });
	assert.equal((await runIfDue(r.p, {}, "tick")).ok, true);
	collections[0] = collection("posts", { supports: [] });
	await markDirty(r.p);
	r.clock.now += MAX_WAIT_MS;
	const off = await runIfDue(r.p, {}, "tick");
	assert.equal(!off.ok && "code" in off && off.code, "no-collections");
	collections[0] = collection("posts");
	r.clock.now += 60_000;
	assert.deepEqual(await runIfDue(r.p, {}, "tick"), { ok: true, skipped: "not-due" });
});

test("a no-collections retry paused while another run publishes does not build again", async () => {
	const collections = [collection("posts", { supports: [] })];
	const r = rig({ collections, entries: [entry("posts", "a")] });
	assert.equal((await runIfDue(r.p, {}, "tick")).ok, false);
	collections[0] = collection("posts");
	r.clock.now += 60_000;
	// Run A's retry check stops in its collection read; run B builds and publishes meanwhile.
	let release!: () => void;
	const gate = new Promise<void>((done) => (release = done));
	let entered!: () => void;
	const inside = new Promise<void>((done) => (entered = done));
	const pausedSchema = { listCollections: async () => (entered(), await gate, r.fc.schema.listCollections()) };
	const a = runIfDue({ ...r.p, schema: pausedSchema }, {}, "tick");
	await inside;
	assert.equal((await runIfDue(r.p, {}, "tick")).ok, true);
	release();
	assert.deepEqual(await a, { ok: true, skipped: "not-due" });
	const s = await state(r.kv);
	assert.equal(s.history.length, 1, "one publish");
	assert.equal(s.lease, null);
});

test("a due run overtaken before its lease write decides again on the new state", async () => {
	const r = rig({ entries: [entry("posts", "a")] });
	// B builds and publishes just before A's lease write checks the revision A read.
	r.kv.beforeCompareAndSet(async () => {
		assert.equal((await runIfDue(r.p, {}, "tick")).ok, true);
	});
	assert.deepEqual(await runIfDue(r.p, {}, "tick"), { ok: true, skipped: "not-due" });
	const s = await state(r.kv);
	assert.equal(s.history.length, 1, "one publish");
	assert.equal(s.lease, null);
});

test("the no-collections retry reuses its collection read for the build", async () => {
	const collections = [collection("posts", { supports: [] })];
	const r = rig({ collections, entries: [entry("posts", "a")] });
	await runIfDue(r.p, {}, "tick");
	collections[0] = collection("posts");
	r.clock.now += 60_000;
	r.fc.calls.length = 0;
	assert.equal((await runIfDue(r.p, {}, "tick")).ok, true);
	assert.equal(r.fc.calls.filter((c) => c.op === "listCollections").length, 1);
});

test("no-collections when nothing opts into search", async () => {
	const r = rig({ collections: [collection("posts", { supports: [] })], entries: [entry("posts", "a")] });
	const result = await runIfDue(r.p, {}, "tick");
	assert.equal(!result.ok && "code" in result && result.code, "no-collections");
	assert.equal((await state(r.kv)).last?.errorCode, "no-collections");
});

test("no-collections after a successful build retires the active index and keeps the error", async () => {
	const posts = collection("posts");
	const r = rig({ collections: [posts], entries: [entry("posts", "a")] });
	assert.equal((await runIfDue(r.p, {}, "tick")).ok, true);
	const runId = (await state(r.kv)).active!.runId;
	posts.supports = [];
	r.clock.now += 1000;
	const result = await runIfDue(r.p, {}, "nightly");
	assert.equal(!result.ok && "code" in result && result.code, "no-collections");
	const s = await state(r.kv);
	assert.equal(s.active, null);
	assert.equal(s.lease, null);
	assert.equal(s.last?.errorCode, "no-collections");
	assert.deepEqual(r.kv.keys().filter((k) => k.includes(runId)), []);
});

test("an unchanged rebuild keeps the live run, so a reader of the old state still gets its chunks", async () => {
	const r = rig({ entries: [entry("posts", "a"), entry("posts", "b")] });
	assert.equal((await runIfDue(r.p, {}, "tick")).ok, true);
	const before = await state(r.kv);
	r.clock.now += 1000;
	assert.equal((await runIfDue(r.p, {}, "nightly")).ok, true);
	const after = await state(r.kv);
	assert.equal(after.active!.version, before.active!.version);
	assert.equal(after.active!.runId, before.active!.runId);
	assert.ok(await readIndex(r.kv, before, before.active!.version, "en"), "the old state's chunks still read");
	assert.deepEqual(after.retired, []);
	assert.equal(after.history.length, 2);
	assert.equal(r.kv.keys().filter((k) => !k.includes(before.active!.runId) && k !== "state").length, 0);
});

test("a lost lease does not publish", async () => {
	const kv = createFakeKv();
	const r = rig({ entries: [entry("posts", "a")] }, kv);
	// Another run takes over the (expired) lease while this one collects.
	const list = r.fc.content.list;
	r.p.content = {
		...r.fc.content,
		async list(c, cursor) {
			const page = await list(c, cursor);
			r.clock.now += LEASE_MS + 1;
			await takeLease(kv, r.clock.now);
			r.clock.now -= LEASE_MS + 1;
			return page;
		},
	};
	const result = await runIfDue(r.p, {}, "tick");
	assert.deepEqual(result, { ok: false, code: "lost-lease" });
	assert.equal((await state(kv)).active, null);
	assert.deepEqual(kv.keys("chunk:"), []);
});

test("duplicate URLs keep the first entry and warn", async () => {
	const r = rig({ entries: [entry("posts", "a", { id: "x1" }), entry("posts", "a", { id: "x2" })] });
	const result = await runIfDue(r.p, {}, "tick");
	assert.ok(result.ok && "active" in result);
	assert.equal((await state(r.kv)).active!.pages, 1);
	assert.ok(r.logs.some((l) => l.level === "warn" && /same URL/.test(l.message)));
});

test("a run past the budget warns", async () => {
	const words = Array.from({ length: 3000 }, (_, i) => `w${i.toString(36)}x${(i * 7919).toString(36)}`).join(" ");
	const r = rig({ entries: [entry("posts", "a", { data: { title: "A", content: portableText(words) } })] });
	await runIfDue(r.p, { budget: { gzipKB: 1 } }, "tick");
	assert.ok(r.logs.some((l) => l.level === "warn" && /budget/.test(l.message)));
});

test("10,000 entries build, store in chunks and read back", { timeout: 60_000 }, async () => {
	const entries: Entry[] = [];
	for (let i = 0; i < 10_000; i++) {
		entries.push(entry("posts", `post-${i}`, { id: `p${i}`, data: { title: `Post number ${i}`, content: portableText(`Body text of post ${i} about "quoted" things — and ${"filler ".repeat(30)}`) } }));
	}
	const r = rig({ entries, pageSize: 500 });
	const result = await runIfDue(r.p, {}, "tick");
	assert.ok(result.ok && "active" in result, JSON.stringify(result));
	const { engine, active } = await loadActive(r.kv);
	assert.equal(active.pages, 10_000);
	assert.ok(active.locales.en.chunks >= 2, `chunks ${active.locales.en.chunks}`);
	assert.equal(engine.records().length, 10_000);
	assert.ok(r.logs.some((l) => l.level === "warn" && /5,000|5000/.test(l.message)), "past the engine's size warns");
});

// ---------------------------------------------------------------------------
// startRebuild (the admin's Rebuild now)
// ---------------------------------------------------------------------------

test("startRebuild forces a build through defer and returns at once", async () => {
	const r = rig({ entries: [entry("posts", "a")] });
	await runIfDue(r.p, {}, "tick");
	const before = await state(r.kv);
	const out = await startRebuild(r.p, {});
	assert.deepEqual(out, { started: true });
	const marked = await state(r.kv);
	assert.equal(marked.force, true);
	assert.equal(marked.dirty, before.dirty + 1);
	assert.equal(r.deferred.length, 1);
	await r.deferred[0]();
	const s = await state(r.kv);
	assert.equal(s.history.length, before.history.length + 1);
	assert.equal(s.force, false);
	assert.equal(s.dirty, s.builtGen);
});

test("startRebuild while a lease is live says running and keeps force", async () => {
	const r = rig({ entries: [entry("posts", "a")] });
	await takeLease(r.kv, T0);
	assert.deepEqual(await startRebuild(r.p, {}), { started: false, code: "running" });
	assert.equal((await state(r.kv)).force, true);
	assert.equal(r.deferred.length, 0);
});

test("startRebuild with no search collections says no-collections", async () => {
	const r = rig({ collections: [collection("posts", { hidden: true })] });
	assert.deepEqual(await startRebuild(r.p, {}), { started: false, code: "no-collections" });
	assert.equal(r.deferred.length, 0);
});

// ---------------------------------------------------------------------------
// Refresh rules
// ---------------------------------------------------------------------------

const EVENTS: ContentEvent[] = ["afterPublish", "afterUnpublish", "afterDelete", "afterRestore", "afterSchedule", "afterUnschedule"];

for (const event of EVENTS) {
	test(`${event} marks dirty once`, async () => {
		const r = rig();
		const payload = event === "afterDelete" ? { collection: "posts", id: "e1", permanent: false } : { collection: "posts", content: { id: "e1", status: "draft" } };
		assert.equal(countsAsChange(event, payload), true);
		await onContentEvent(r.p, event, payload);
		assert.equal((await state(r.kv)).dirty, 1);
	});
}

test("afterSave of a new draft does not mark; of an existing entry or a published one it does", async () => {
	const r = rig();
	assert.equal(countsAsChange("afterSave", { collection: "posts", content: { id: "e1", status: "draft" }, isNew: true }), false);
	assert.equal(await onContentEvent(r.p, "afterSave", { collection: "posts", content: { id: "e1", status: "draft" }, isNew: true }), false);
	assert.equal((await state(r.kv)).dirty, 0);
	// EmDash gives no previous status: an existing entry saved as a draft may have been published.
	assert.equal(await onContentEvent(r.p, "afterSave", { collection: "posts", content: { id: "e1", status: "draft" }, isNew: false }), true);
	assert.equal((await state(r.kv)).dirty, 1);
	assert.equal(await onContentEvent(r.p, "afterSave", { collection: "posts", content: { id: "e2", status: "published" }, isNew: true }), true);
	assert.equal((await state(r.kv)).dirty, 2);
});

test("a listed collections option ignores changes to other collections", async () => {
	const r = rig();
	assert.equal(countsAsChange("afterPublish", { collection: "menus", content: {} }, { collections: ["posts"] }), false);
	assert.equal(countsAsChange("afterPublish", { collection: "posts", content: {} }, { collections: ["posts"] }), true);
	assert.equal(await onContentEvent(r.p, "afterPublish", { collection: "menus", content: {} }, { collections: ["posts"] }), false);
	assert.equal((await state(r.kv)).dirty, 0);
});

test("only the first change on a clean state queues rebuild-soon 10 s ahead", async () => {
	const r = rig();
	await markDirty(r.p);
	r.clock.now += 3000;
	await markDirty(r.p);
	assert.deepEqual(r.queued.map((d) => d.getTime()), [T0 + SOON_MS]);
	const s = await state(r.kv);
	assert.equal(s.dirty, 2);
	assert.equal(s.dirtySince, T0);
	assert.equal(s.lastChangeAt, T0 + 3000);
});

test("a queue failure does not fail the mark", async () => {
	const r = rig();
	r.p.queue = async () => {
		throw new Error("cron down");
	};
	await markDirty(r.p);
	assert.equal((await state(r.kv)).dirty, 1);
	assert.ok(r.logs.some((l) => l.level === "warn"));
});

test("markDirty retries on a conflict with a racing write", async () => {
	const kv = createFakeKv();
	const r = rig({}, kv);
	kv.beforeCompareAndSet(async () => {
		await kv.set("state", { ...emptyState(), dirty: 5, builtGen: 5 });
	});
	await markDirty(r.p);
	assert.equal((await state(kv)).dirty, 6);
});

test("the due rule", () => {
	const clean: SearchState = { ...emptyState(), dirty: 3, builtGen: 3, active: { runId: "r", version: "v", builtAt: T0, locales: {}, pages: 0, sections: 0, records: 0, skipped: 0 }, last: { ok: true, at: T0 } };
	assert.equal(isDue(clean, T0), false);
	assert.equal(isDue({ ...clean, force: true }, T0), true, "force: at once");

	const changed = { ...clean, dirty: 4, lastChangeAt: T0, dirtySince: T0 };
	assert.equal(isDue(changed, T0 + 5000), false, "5 s after a change");
	assert.equal(isDue(changed, T0 + QUIET_MS), true, "10 s after the last change");

	// Changes every 5 s keep it quiet-not-due, until 60 s after the first.
	let s = changed;
	for (let t = 5000; t < MAX_WAIT_MS; t += 5000) {
		s = { ...s, dirty: s.dirty + 1, lastChangeAt: T0 + t };
		assert.equal(isDue(s, T0 + t + 1), false, `at ${t} ms`);
	}
	assert.equal(isDue({ ...s, lastChangeAt: T0 + MAX_WAIT_MS - 1 }, T0 + MAX_WAIT_MS), true, "60 s after the first change");

	assert.equal(isDue(emptyState(), T0), true, "never built: due");
	assert.equal(isDue({ ...emptyState(), last: { ok: false, at: T0, errorCode: "too-large" } }, T0), false, "a settled failure waits for a change");
});


// ---------------------------------------------------------------------------
// Codex step 1 review: publish, lease and clean-up faults
// ---------------------------------------------------------------------------

/** A KV over `kv` whose methods the test can replace one at a time. */
function overKv(kv: FakeKv, over: Partial<KvPort>): KvPort {
	return {
		get: (k) => kv.get(k),
		getVersioned: (k) => kv.getVersioned(k),
		compareAndSet: (k, rev, v) => kv.compareAndSet(k, rev, v),
		set: (k, v) => kv.set(k, v),
		delete: (k) => kv.delete(k),
		...over,
	};
}

test("unclear publish that applied, then a failed re-read: the build keeps the chunks and the active index reads back", async () => {
	const kv = createFakeKv();
	const r = rig({ entries: [entry("posts", "a")] }, kv);
	let failNextRead = false;
	r.p.kv = overKv(kv, {
		async set(k, v) {
			await kv.set(k, v);
			if (k.startsWith("chunk:")) kv.throwOnCompareAndSet("after", (key) => key === "state");
		},
		async compareAndSet(k, rev, v) {
			try {
				return await kv.compareAndSet(k, rev, v);
			} catch (error) {
				failNextRead = true;
				throw error;
			}
		},
		async getVersioned(k) {
			if (failNextRead) {
				failNextRead = false;
				throw new Error("read failed");
			}
			return kv.getVersioned(k);
		},
	});
	const result = await runIfDue(r.p, {}, "tick");
	assert.equal(result.ok, false);
	const { engine } = await loadActive(kv);
	assert.equal(engine.records().length, 1);
});

test("unclear publish that did not apply: the build frees the lease and its chunks are cleaned up", async () => {
	const kv = createFakeKv();
	const r = rig({ entries: [entry("posts", "a")] }, kv);
	r.p.kv = overKv(kv, {
		async set(k, v) {
			await kv.set(k, v);
			if (k.startsWith("chunk:")) kv.throwOnCompareAndSet("before", (key) => key === "state");
		},
	});
	const result = await runIfDue(r.p, {}, "tick");
	assert.equal(!result.ok && "code" in result && result.code, "error");
	const s = await state(kv);
	assert.equal(s.active, null);
	assert.equal(s.lease, null);
	assert.deepEqual(s.retired, []);
	assert.deepEqual(kv.keys("chunk:"), []);
});

test("a nightly build of a clean site that crashes is retried by a tick after the lease expires", async () => {
	const r = rig({ entries: [entry("posts", "a")] });
	await runIfDue(r.p, {}, "tick");
	const first = (await state(r.kv)).active!.builtAt;
	r.clock.now += 60_000;
	// The nightly run takes the lease (clearing force), then its worker dies.
	await updateState(r.kv, (s) => ({ ...s, force: true }));
	assert.ok(await takeLease(r.kv, r.clock.now));
	r.clock.now += LEASE_MS + 1;
	const retry = await runIfDue(r.p, {}, "tick");
	assert.ok(retry.ok && "active" in retry, JSON.stringify(retry));
	assert.notEqual((await state(r.kv)).active!.builtAt, first);
});

test("a stall in the final chunk write past the deadline and the lease does not publish", async () => {
	const kv = createFakeKv();
	const r = rig({ entries: [entry("posts", "a", { id: "a" })] }, kv);
	await runIfDue(r.p, {}, "tick");
	const before = await state(kv);
	r.fc.put(entry("posts", "b", { id: "b" }));
	await onContentEvent(r.p, "afterPublish", { collection: "posts", content: { id: "b", status: "published" } });
	r.clock.now += QUIET_MS;
	r.p.kv = overKv(kv, {
		async set(k, v) {
			await kv.set(k, v);
			if (k.startsWith("chunk:")) r.clock.now += BUILD_DEADLINE_MS + LEASE_MS;
		},
	});
	const result = await runIfDue(r.p, {}, "tick");
	assert.equal(result.ok, false);
	const s = await state(kv);
	assert.equal(s.active!.runId, before.active!.runId);
});

test("a crashed run's chunks in a locale nothing else has are cleaned up after a takeover", async () => {
	const kv = createFakeKv();
	const r = rig({ entries: [entry("posts", "a", { id: "a" })] }, kv);
	await runIfDue(r.p, {}, "tick");
	// A run with a new locale writes its "es" chunk, then its worker dies inside the next write.
	r.fc.put(entry("posts", "b", { id: "b", locale: "es" }));
	await onContentEvent(r.p, "afterPublish", { collection: "posts", content: { id: "b", status: "published" } });
	r.clock.now += QUIET_MS;
	let crashedRun = "";
	r.p.kv = overKv(kv, {
		async set(k, v) {
			if (k.includes(":es:")) {
				crashedRun = k.split(":")[1];
				await kv.set(k, v);
				return new Promise<void>(() => {});
			}
			return kv.set(k, v);
		},
	});
	void runIfDue(r.p, {}, "tick");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.ok(crashedRun);
	assert.equal(kv.keys(`chunk:${crashedRun}:es:`).length, 1);
	// The locale goes away; the next build after the lease expires has only "en".
	r.fc.remove("b");
	r.p.kv = kv;
	r.clock.now += LEASE_MS + 1;
	await markDirty(r.p);
	r.clock.now += QUIET_MS;
	const next = await runIfDue(r.p, {}, "tick");
	assert.ok(next.ok && "active" in next, JSON.stringify(next));
	assert.deepEqual(kv.keys(`chunk:${crashedRun}:`), []);
	assert.deepEqual((await state(kv)).retired, []);
});

// ---------------------------------------------------------------------------
// Plan limits (decision 17)
// ---------------------------------------------------------------------------

/** A rig whose second build fails on its first chunk write with `error`. */
async function failingSecondBuild(error: unknown) {
	const kv = createFakeKv();
	const r = rig({ entries: [entry("posts", "a", { id: "a" })] }, kv);
	await runIfDue(r.p, {}, "tick");
	const before = await state(kv);
	let fail = true;
	r.p.kv = overKv(kv, {
		async set(k, v) {
			if (fail && k.startsWith("chunk:")) throw error;
			await kv.set(k, v);
		},
	});
	r.fc.put(entry("posts", "b", { id: "b" }));
	await onContentEvent(r.p, "afterPublish", { collection: "posts", content: { id: "b", status: "published" } });
	r.clock.now += QUIET_MS;
	const result = await runIfDue(r.p, {}, "tick");
	return { r, kv, before, result, heal: () => void (fail = false) };
}

for (const message of [
	"D1_ERROR: Too many API requests by single Worker invocation.",
	"Too many API requests by single worker invocation",
	"Worker exceeded CPU time limit.",
	"Error 1102: Worker exceeded resource limits",
	"Exceeded CPU Time Limits",
]) {
	test(`plan-limit: "${message}" is recorded as plan-limit and the old index stays live`, async () => {
		const { r, kv, before, result } = await failingSecondBuild(new Error(message));
		assert.equal(!result.ok && "code" in result && result.code, "plan-limit");
		const s = await state(kv);
		assert.equal(s.last?.ok, false);
		assert.equal(s.last?.errorCode, "plan-limit");
		assert.equal(s.active!.runId, before.active!.runId);
		assert.equal(s.lease, null);
		const { engine } = await loadActive(kv);
		assert.deepEqual(urls(engine).length, 1);
		assert.ok(r.logs.some((l) => /plan-limit/.test(l.message)));
		// Settled: it does not hit the limit again every minute.
		r.clock.now += 120_000;
		assert.deepEqual(await runIfDue(r.p, {}, "tick"), { ok: true, skipped: "not-due" });
	});
}

test("plan-limit: a non-Error thrown value with the text still maps", async () => {
	const { result } = await failingSecondBuild("Too many API requests by single Worker invocation");
	assert.equal(!result.ok && "code" in result && result.code, "plan-limit");
});

test("plan-limit: a normal failure still records error", async () => {
	const { kv, result } = await failingSecondBuild(new Error("KV is down"));
	assert.equal(!result.ok && "code" in result && result.code, "error");
	assert.equal((await state(kv)).last?.errorCode, "error");
});

test("plan-limit: the next good build clears it", async () => {
	const { r, kv, heal } = await failingSecondBuild(new Error("Worker exceeded CPU time limit."));
	assert.equal((await state(kv)).last?.errorCode, "plan-limit");
	heal();
	const result = await startRebuild(r.p, {});
	assert.equal(result.started, true);
	for (const task of r.deferred.splice(0)) await task();
	const s = await state(kv);
	assert.equal(s.last?.ok, true);
	assert.equal(s.last?.errorCode, undefined);
	const { engine } = await loadActive(kv);
	assert.equal(engine.records().length, 2);
});

// ---------------------------------------------------------------------------
// Interrupted runs (a Worker killed at a plan limit records nothing)
// ---------------------------------------------------------------------------

const D1_LIMIT = "D1_ERROR: Too many API requests by single Worker invocation.";

/**
 * A KV that, like D1 on a Worker over its query limit, rejects every call after `limit` calls in one
 * invocation (`invocation()` starts a new one). The failure write in the catch fails too, so nothing is recorded.
 */
function limitedKv(kv: FakeKv, limit: number) {
	let used = 0;
	const guard = <T,>(fn: () => Promise<T>) => (++used > limit ? Promise.reject(new Error(D1_LIMIT)) : fn());
	const port: KvPort = {
		get: (k) => guard(() => kv.get(k)),
		getVersioned: (k) => guard(() => kv.getVersioned(k)),
		compareAndSet: (k, rev, v) => guard(() => kv.compareAndSet(k, rev, v)),
		set: (k, v) => guard(() => kv.set(k, v)),
		delete: (k) => guard(() => kv.delete(k)),
	};
	return { port, invocation: () => void (used = 0) };
}

/** Built once, then a change; every later run on `limited` dies after the lease and plan writes. */
async function interruptedRig() {
	const kv = createFakeKv();
	const r = rig({ entries: [entry("posts", "a", { id: "a" })] }, kv);
	await runIfDue(r.p, {}, "tick");
	const before = await state(kv);
	r.fc.put(entry("posts", "b", { id: "b" }));
	await onContentEvent(r.p, "afterPublish", { collection: "posts", content: { id: "b", status: "published" } });
	r.clock.now += QUIET_MS;
	// readState + takeLease (2) + planChunks (2): the first chunk write is over the limit.
	const limited = limitedKv(kv, 5);
	r.p.kv = limited.port;
	const run = async (reason: Parameters<typeof runIfDue>[2] = "tick") => {
		limited.invocation();
		return runIfDue(r.p, {}, reason);
	};
	/** Jumps past the live lease, if any. */
	const expire = async () => {
		const s = await state(kv);
		r.clock.now = Math.max(r.clock.now, (s.lease?.until ?? r.clock.now) + 1);
	};
	return { r, kv, before, run, expire, invocation: limited.invocation, heal: () => void (r.p.kv = kv) };
}

test("interrupted: a run killed at the D1 limit records nothing and leaves its lease", async () => {
	const { kv, before, run } = await interruptedRig();
	await run();
	const s = await state(kv);
	assert.ok(s.lease, "the lease is left to expire");
	assert.equal(s.last?.ok, true, "the failure could not be recorded");
	assert.equal(s.interrupted, 0);
	assert.equal(s.active!.runId, before.active!.runId);
});

test(`interrupted: ${INTERRUPTED_LIMIT} in a row settle; the old index stays and a tick does not retry`, async () => {
	const { r, kv, before, run, expire } = await interruptedRig();
	await run(); // A dies
	await expire();
	await run(); // takes over A (1), B dies
	assert.equal((await state(kv)).interrupted, 1);
	await expire();
	const settled = await run(); // takes over B (2): settles
	assert.deepEqual(settled, { ok: false, code: "interrupted", error: INTERRUPTED_MESSAGE });
	assert.match(INTERRUPTED_MESSAGE, /Workers Paid plan/);
	const s = await state(kv);
	assert.equal(s.interrupted, 2);
	assert.equal(s.lease, null);
	assert.equal(s.last?.ok, false);
	assert.equal(s.last?.errorCode, "interrupted");
	assert.equal(s.builtGen, s.dirty);
	assert.equal(s.active!.runId, before.active!.runId);
	assert.ok(r.logs.some((l) => /interrupted/.test(l.message)));
	r.clock.now += 120_000;
	assert.deepEqual(await run(), { ok: true, skipped: "not-due" });
	r.clock.now += 3_600_000;
	assert.deepEqual(await run(), { ok: true, skipped: "not-due" });
});

for (const trigger of ["change", "nightly", "admin"] as const) {
	test(`interrupted: once settled, a ${trigger} tries again, and the next kill settles at once`, async () => {
		const { r, kv, run, expire, invocation } = await interruptedRig();
		await run();
		await expire();
		await run();
		await expire();
		await run();
		invocation();
		const settledAt = (await state(kv)).last!.at;
		r.clock.now += 60_000;
		if (trigger === "change") {
			await onContentEvent(r.p, "afterPublish", { collection: "posts", content: { id: "a", status: "published" } });
			r.clock.now += QUIET_MS;
			await run();
		} else if (trigger === "nightly") {
			await run("nightly");
		} else {
			assert.equal((await startRebuild(r.p, {})).started, true);
			for (const task of r.deferred.splice(0)) {
				invocation();
				await task();
			}
		}
		let s = await state(kv);
		assert.ok(s.lease, "a new run started (and died)");
		await expire();
		assert.equal((await run()).ok, false);
		s = await state(kv);
		assert.equal(s.last?.errorCode, "interrupted");
		assert.ok(s.last!.at > settledAt);
		assert.equal(s.lease, null);
	});
}

test("interrupted: a successful run resets the count", async () => {
	const { r, kv, run, expire, heal } = await interruptedRig();
	await run();
	await expire();
	await run();
	assert.equal((await state(kv)).interrupted, 1);
	heal();
	await expire();
	// The second takeover settles (not forced); then Rebuild now builds and succeeds.
	const ok = await runIfDue(r.p, {}, "tick");
	assert.equal(!ok.ok && "code" in ok && ok.code, "interrupted");
	await startRebuild(r.p, {});
	for (const task of r.deferred.splice(0)) await task();
	const s = await state(kv);
	assert.equal(s.last?.ok, true);
	assert.equal(s.interrupted, 0);
});

test("interrupted: a recorded failure resets the count", async () => {
	const { r, kv, run, expire } = await interruptedRig();
	await run();
	await expire();
	await run();
	assert.equal((await state(kv)).interrupted, 1);
	await expire();
	r.p.kv = overKv(kv, {
		async set(k, v) {
			if (k.startsWith("chunk:")) throw new Error("KV is down");
			await kv.set(k, v);
		},
	});
	// Forced, so the takeover (2) builds; its failure is recorded.
	const result = await runIfDue(r.p, {}, "admin");
	assert.equal(!result.ok && "code" in result && result.code, "error");
	const s = await state(kv);
	assert.equal(s.interrupted, 0);
	assert.equal(s.last?.errorCode, "error");
});

test("interrupted: a forced run that takes over the second dead lease builds instead of settling", async () => {
	const { r, kv, run, expire, heal } = await interruptedRig();
	await run();
	await expire();
	await run();
	await expire();
	heal();
	const result = await runIfDue(r.p, {}, "nightly");
	assert.ok(result.ok && "active" in result);
	assert.equal((await state(kv)).interrupted, 0);
});
