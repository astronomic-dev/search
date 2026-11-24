import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeKv, type FakeKv } from "./emdash/fake-kv.ts";
import { createFakeContent } from "./emdash/fake-content.ts";
import { STATE_KEY, chunkKey, emptyState, writeChunks } from "../src/emdash/core/store.ts";
import { MANIFEST_PATH, PUBLIC_CACHE_CONTROL, ROUTE_BASE, createRoutes } from "../src/emdash/core/routes.ts";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/emdash/core/settings.ts";
import { SCHEMA, type Manifest } from "../src/core/types.ts";
import type { ActiveIndex, RequestRebuild, RouteMethod, RouteRequest, SearchPorts, SearchState } from "../src/emdash/core/ports.ts";

const NOW = 1_700_000_000_000;

function ports(kv: FakeKv, defaultLocale = "en"): SearchPorts {
	const { content, schema } = createFakeContent({ defaultLocale });
	return {
		kv,
		content,
		schema,
		log: { info() {}, warn() {}, error() {} },
		queue: async () => {},
		defer: () => {},
		now: () => NOW,
	};
}

function req(method: RouteMethod, query: Record<string, string> = {}, headers: Record<string, string> = {}, body?: unknown): RouteRequest {
	const h = new Headers(headers);
	return { method, query: new URLSearchParams(query), headers: { get: (n) => h.get(n) }, body };
}

const FILE_EN = JSON.stringify({ schema: SCHEMA, index: "default", locale: "en", text: 'say "hi" — Zürich' });
const FILE_ES = JSON.stringify({ schema: SCHEMA, index: "default", locale: "es", text: "hola" });

function active(over: Partial<ActiveIndex> = {}): ActiveIndex {
	return {
		runId: "run1",
		version: "v1",
		builtAt: NOW - 5000,
		locales: {
			en: { chunks: 1, etag: '"e-en-1"', gzBytes: 1200, rawBytes: 4000 },
			es: { chunks: 1, etag: '"e-es-1"', gzBytes: 900, rawBytes: 3000 },
		},
		pages: 12,
		sections: 3,
		records: 15,
		skipped: 1,
		...over,
	};
}

async function built(over: Partial<SearchState> = {}): Promise<FakeKv> {
	const kv = createFakeKv();
	const a = over.active === undefined ? active() : over.active;
	if (a) {
		await writeChunks(kv, a.runId, "en", FILE_EN);
		await writeChunks(kv, a.runId, "es", FILE_ES);
	}
	await kv.set(STATE_KEY, { ...emptyState(), dirty: 4, builtGen: 4, active: a, history: [{ builtAt: NOW - 5000, gzBytes: 1200, rawBytes: 9000, pages: 12, sections: 3 }], ...over });
	return kv;
}

const noRebuild: RequestRebuild = async () => {
	throw new Error("not called");
};

const routes = (kv: FakeKv, rebuild = noRebuild, o = {}) => createRoutes(ports(kv), o, rebuild);

test("routes: the table (which are public, which methods)", () => {
	const r = routes(createFakeKv());
	const table = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { public: v.public, methods: [...v.methods] }]));
	assert.deepEqual(table, {
		manifest: { public: true, methods: ["GET", "HEAD"] },
		index: { public: true, methods: ["GET", "HEAD"] },
		indexes: { public: false, methods: ["GET"] },
		status: { public: false, methods: ["GET"] },
		rebuild: { public: false, methods: ["POST"] },
		settings: { public: false, methods: ["GET", "POST"] },
	});
	assert.equal(PUBLIC_CACHE_CONTROL, "public, max-age=0, must-revalidate");
	assert.equal(MANIFEST_PATH, "/_emdash/api/plugins/astronomic-search/manifest");
});

test("manifest: 503 with retry-after before the first build", async () => {
	const r = routes(createFakeKv());
	const res = await r.manifest.handle(req("GET"));
	assert.equal(res.status, 503);
	assert.equal(res.headers["retry-after"], "30");
	assert.match(res.headers["content-type"], /^application\/json/);
	const head = await r.manifest.handle(req("HEAD"));
	assert.equal(head.status, 503);
	assert.equal(head.body, undefined);
});

test("manifest: the package's Manifest, with absolute index paths, and ETag + 304", async () => {
	const kv = await built();
	const r = createRoutes(ports(kv, "es"), {}, noRebuild);
	const res = await r.manifest.handle(req("GET"));
	assert.equal(res.status, 200);
	assert.match(res.headers["content-type"], /^application\/json/);
	const m = JSON.parse(res.body!) as Manifest;
	assert.deepEqual(m, {
		schema: SCHEMA,
		defaultLocale: "es",
		indexes: {
			default: {
				version: "v1",
				locales: { en: `${ROUTE_BASE}index?v=v1&l=en`, es: `${ROUTE_BASE}index?v=v1&l=es` },
			},
		},
	});
	const etag = res.headers.etag;
	assert.match(etag, /^"[^"]+"$/);
	const again = await r.manifest.handle(req("GET", {}, { "if-none-match": `"x", W/${etag}` }));
	assert.equal(again.status, 304);
	assert.equal(again.body, undefined);
	assert.equal(again.headers.etag, etag);
	assert.equal((await r.manifest.handle(req("GET", {}, { "if-none-match": "*" }))).status, 304);
	assert.equal((await r.manifest.handle(req("GET", {}, { "if-none-match": '"other"' }))).status, 200);
	const head = await r.manifest.handle(req("HEAD"));
	assert.deepEqual([head.status, head.headers, head.body], [200, res.headers, undefined]);
});

test("manifest: a new version gives a new ETag", async () => {
	const a = await routes(await built()).manifest.handle(req("GET"));
	const b = await routes(await built({ active: active({ runId: "run2", version: "v2" }) })).manifest.handle(req("GET"));
	assert.notEqual(a.headers.etag, b.headers.etag);
});

test("manifest: the index path resolves to the index route from a slashed or plain manifest URL", async () => {
	const m = JSON.parse((await routes(await built()).manifest.handle(req("GET"))).body!) as Manifest;
	const path = m.indexes.default!.locales.en!;
	for (const manifestUrl of [`https://example.com${MANIFEST_PATH}`, `https://example.com${MANIFEST_PATH}/`]) {
		assert.equal(new URL(path, manifestUrl).pathname, `${ROUTE_BASE}index`);
	}
});

test("index: the active version is 200 with the file, ETag and 304 from state alone", async () => {
	const kv = await built();
	const r = routes(kv);
	const res = await r.index.handle(req("GET", { v: "v1", l: "en" }));
	assert.equal(res.status, 200);
	assert.equal(res.body, FILE_EN);
	assert.match(res.headers["content-type"], /^application\/json/);
	assert.equal(res.headers.etag, '"e-en-1"');
	assert.equal((await r.index.handle(req("GET", { v: "v1", l: "es" }))).body, FILE_ES);

	kv.resetCalls();
	const cached = await r.index.handle(req("GET", { v: "v1", l: "en" }, { "if-none-match": '"e-en-1"' }));
	assert.equal(cached.status, 304);
	assert.equal(cached.body, undefined);
	assert.equal(cached.headers.etag, '"e-en-1"');
	assert.deepEqual(kv.calls.filter((c) => c.key.startsWith("chunk:")), [], "a 304 reads no chunk");
	assert.ok(kv.calls.some((c) => c.key === STATE_KEY));
});

test("index: HEAD gives the same headers and no body", async () => {
	const r = routes(await built());
	const get = await r.index.handle(req("GET", { v: "v1", l: "en" }));
	const head = await r.index.handle(req("HEAD", { v: "v1", l: "en" }));
	assert.equal(head.status, 200);
	assert.deepEqual(head.headers, get.headers);
	assert.equal(head.body, undefined);
	assert.equal((await r.index.handle(req("HEAD", { v: "v0", l: "en" }))).status, 404);
});

test("index: any other version, an unknown locale, a missing query or no build is 404", async () => {
	const r = routes(await built({ active: active({ runId: "run2", version: "v2" }), retired: [{ runId: "run1", locales: { en: 1 } }] }));
	const queries: Array<Record<string, string>> = [{ v: "v1", l: "en" }, { v: "nope", l: "en" }, { v: "v2", l: "fr" }, { v: "v2" }, { l: "en" }, {}];
	for (const q of queries) {
		const res = await r.index.handle(req("GET", q));
		assert.equal(res.status, 404, JSON.stringify(q));
		assert.match(res.headers["content-type"], /^application\/json/);
	}
	assert.equal((await routes(createFakeKv()).index.handle(req("GET", { v: "v1", l: "en" }))).status, 404);
});

test("index: a chunk gone between the state read and the chunk read is 404", async () => {
	const kv = await built();
	await kv.delete(chunkKey("run1", "en", 0));
	assert.equal((await routes(kv).index.handle(req("GET", { v: "v1", l: "en" }))).status, 404);
});

test("indexes: the default index with its sizes, budget and history", async () => {
	const kv = await built();
	const res = await routes(kv, noRebuild, { budget: { gzipKB: 120 } }).indexes.handle(req("GET"));
	assert.equal(res.status, 200);
	assert.deepEqual(JSON.parse(res.body!), [
		{
			name: "default",
			active: { gzBytes: 1200, rawBytes: 4000, pages: 12, sections: 3, builtAt: NOW - 5000 },
			budgetKB: 120,
			history: [{ builtAt: NOW - 5000, gzBytes: 1200, rawBytes: 9000, pages: 12, sections: 3 }],
		},
	]);
	const none = JSON.parse((await routes(createFakeKv()).indexes.handle(req("GET"))).body!);
	assert.deepEqual(none, [{ name: "default", active: null, budgetKB: 300, history: [] }]);
});

async function statusOf(over: Partial<SearchState>) {
	const res = await routes(await built(over)).status.handle(req("GET"));
	assert.equal(res.status, 200);
	return JSON.parse(res.body!);
}

test("status: idle, queued, running and failed from state", async () => {
	assert.deepEqual(await statusOf({}), { state: "idle", pages: 12, sections: 3, builtAt: NOW - 5000, pending: false });
	assert.deepEqual(await statusOf({ dirty: 5 }), { state: "queued", pages: 12, sections: 3, builtAt: NOW - 5000, pending: true });
	assert.deepEqual(await statusOf({ force: true }), { state: "queued", pages: 12, sections: 3, builtAt: NOW - 5000, pending: true });
	assert.deepEqual(await statusOf({ dirty: 5, lease: { runId: "r", until: NOW + 1000 } }), { state: "running", pages: 12, sections: 3, builtAt: NOW - 5000, pending: true });
	assert.equal((await statusOf({ lease: { runId: "r", until: NOW - 1 } })).state, "idle", "a dead lease is not running");
	const failed = await statusOf({ dirty: 5, lastChangeAt: NOW - 9000, last: { ok: false, at: NOW - 1000, error: "8,100,000 bytes", errorCode: "too-large" } });
	assert.deepEqual(failed, { state: "failed", pages: 12, sections: 3, builtAt: NOW - 5000, error: "8,100,000 bytes", errorCode: "too-large", pending: true });
	const changedSince = await statusOf({ dirty: 6, lastChangeAt: NOW - 500, last: { ok: false, at: NOW - 1000, errorCode: "error" } });
	assert.equal(changedSince.state, "queued", "a change after the failure queues a new try");
	assert.equal((await statusOf({ force: true, last: { ok: false, at: NOW - 1000, errorCode: "error" } })).state, "queued");
	const fresh = JSON.parse((await routes(createFakeKv()).status.handle(req("GET"))).body!);
	assert.deepEqual(fresh, { state: "idle", pending: false });
});

test("rebuild: calls requestRebuild and passes back started, code and the status", async () => {
	const kv = await built();
	let calls = 0;
	const r = routes(kv, async () => {
		calls++;
		const s = (await kv.get<SearchState>(STATE_KEY))!;
		await kv.set(STATE_KEY, { ...s, dirty: s.dirty + 1, force: true });
		return { started: true };
	});
	const res = await r.rebuild.handle(req("POST", {}, {}, {}));
	assert.equal(calls, 1);
	assert.equal(res.status, 200);
	assert.deepEqual(JSON.parse(res.body!), { started: true, status: { state: "queued", pages: 12, sections: 3, builtAt: NOW - 5000, pending: true } });

	const busy = routes(await built({ lease: { runId: "r", until: NOW + 1000 } }), async () => ({ started: false, code: "running" }));
	assert.deepEqual(JSON.parse((await busy.rebuild.handle(req("POST"))).body!), {
		started: false,
		code: "running",
		status: { state: "running", pages: 12, sections: 3, builtAt: NOW - 5000, pending: false },
	});
});

test("settings: GET gives defaults filled in, POST saves after the checks", async () => {
	const kv = createFakeKv({ [SETTINGS_KEY]: { placeholder: "Find parts" } });
	const r = routes(kv);
	const got = await r.settings.handle(req("GET"));
	assert.equal(got.status, 200);
	assert.deepEqual(JSON.parse(got.body!), { ...DEFAULT_SETTINGS, placeholder: "Find parts" });
	const saved = await r.settings.handle(req("POST", {}, {}, { theme: "blue", results: "/find", keys: ["/", "mod+k", "ctrl+j"] }));
	assert.equal(saved.status, 200);
	assert.deepEqual(JSON.parse(saved.body!), { ...DEFAULT_SETTINGS, placeholder: "Find parts", results: "/find", keys: ["/", "mod+k"] });
	assert.deepEqual(JSON.parse((await r.settings.handle(req("GET"))).body!), JSON.parse(saved.body!));
	for (const body of [undefined, null, "x", [1]]) {
		assert.equal((await r.settings.handle(req("POST", {}, {}, body))).status, 400, JSON.stringify(body));
	}
});

test("routes: a method a route does not declare is 405", async () => {
	const r = routes(await built());
	assert.equal((await r.manifest.handle(req("POST"))).status, 405);
	assert.equal((await r.rebuild.handle(req("GET"))).status, 405);
	assert.equal((await r.status.handle(req("HEAD"))).status, 405);
});

test("routes: only headers EmDash passes on a raw route (no cache-control: the route's cacheControl sets it)", async () => {
	const allowed = new Set(["content-type", "etag", "retry-after"]);
	const r = routes(await built());
	const all = [
		await r.manifest.handle(req("GET")),
		await r.index.handle(req("GET", { v: "v1", l: "en" })),
		await r.index.handle(req("GET", { v: "x", l: "en" })),
		await routes(createFakeKv()).manifest.handle(req("GET")),
		await r.status.handle(req("GET")),
	];
	for (const res of all) for (const name of Object.keys(res.headers)) assert.ok(allowed.has(name), name);
});
