import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PluginContext, PluginRoute } from "emdash";
import { renderFragments } from "emdash/page";
import { createPlugin, search } from "../src/emdash/index.ts";
import {
	CRON_TIMEOUT_MS,
	NIGHTLY,
	NIGHTLY_SCHEDULE,
	pageFragments,
	PLUGIN_ID,
	pluginDefinition,
	REBUILD_SOON,
	searchRoutes,
	TICK,
	TICK_SCHEDULE,
	VERSION,
	type WrapperDeps,
} from "../src/emdash/plugin.ts";
import { readState } from "../src/emdash/core/store.ts";
import { configJson, DEFAULT_SETTINGS } from "../src/emdash/core/settings.ts";
import { PUBLIC_CACHE_CONTROL } from "../src/emdash/core/routes.ts";
import { parseEmbedConfig } from "../src/browser/config.ts";
import { createFakeKv } from "./emdash/fake-kv.ts";
import { collection, entry, portableText } from "./emdash/fake-content.ts";
import type { EmDashEntry } from "../src/emdash/core/ports.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

interface Ctx {
	ctx: PluginContext;
	schedules: Array<{ name: string; schedule: string }>;
	deferred: Array<() => Promise<void>>;
	deps: WrapperDeps & { request: { editMode?: boolean; preview?: unknown } | undefined };
}

/** A fake EmDash plugin context over the fake KV, with one published post and one draft. */
function fakeCtx(entries: EmDashEntry[] = [entry("posts", "hello", { data: { title: "Northwind rebrand", content: portableText("A fresh look.") } })]): Ctx {
	const schedules: Ctx["schedules"] = [];
	const deferred: Ctx["deferred"] = [];
	const log = () => {};
	const ctx = {
		plugin: { id: PLUGIN_ID, version: VERSION },
		kv: createFakeKv(),
		log: { debug: log, info: log, warn: log, error: log },
		site: { name: "Test", url: "https://example.com", locale: "en", trailingSlash: "ignore" },
		cron: {
			schedule: async (name: string, opts: { schedule: string }) => void schedules.push({ name, schedule: opts.schedule }),
			cancel: async () => {},
			list: async () => [],
		},
		schema: { listCollections: async () => [{ ...collection("posts"), labelSingular: null, description: null, hasSeo: false, titleField: "title", dateField: null, fields: [] }] },
		content: {
			list: async (c: string, o: { where?: { status?: string } }) => ({
				items: entries.filter((e) => e.type === c && (!o.where?.status || e.status === o.where.status)),
				hasMore: false,
			}),
			getPublicUrl: async (c: string, id: string) => {
				const e = entries.find((x) => x.id === id);
				return e?.slug ? `https://example.com/${c}/${e.slug}` : null;
			},
		},
	} as unknown as PluginContext;
	const deps: Ctx["deps"] = {
		request: undefined,
		after: (fn) => void deferred.push(fn),
		getRequestContext: () => deps.request,
	};
	return { ctx, schedules, deferred, deps };
}

function routeCtx(ctx: PluginContext, method: string, path: string, init: { headers?: Record<string, string>; input?: unknown } = {}) {
	return { ...ctx, request: new Request(`https://example.com${path}`, { method, headers: init.headers }), input: init.input, requestMeta: {} } as unknown as Parameters<PluginRoute["handler"]>[0];
}

type Hook = (event: unknown, ctx: PluginContext) => Promise<unknown>;
const hookOf = (h: unknown): Hook => (typeof h === "function" ? (h as Hook) : (h as { handler: Hook }).handler);

test("search() gives the native descriptor", () => {
	const d = search({ collections: ["posts"], budget: { gzipKB: 200 } });
	assert.deepEqual(d, {
		id: "astronomic-search",
		version: VERSION,
		entrypoint: "@astronomic-dev/search/emdash",
		format: "native",
		options: { collections: ["posts"], budget: { gzipKB: 200 } },
		capabilities: ["content:read", "schema:read", "hooks.page-fragments:register"],
		adminEntry: "@astronomic-dev/search/emdash/admin",
		adminPages: [{ path: "/settings", label: "Search", icon: "magnifying-glass" }],
	});
	assert.deepEqual(JSON.parse(JSON.stringify(d.options)), d.options);
	assert.deepEqual(search().options, {});
});

test("search() throws on options that do not survive JSON", () => {
	for (const bad of [{ clip: () => 3 }, { collections: [/posts/] }, { budget: { gzipKB: new Date() } }, { clip: undefined }, { clip: Number.NaN }]) {
		assert.throws(() => search(bad as never), /plain JSON/);
	}
});

test("VERSION matches package.json", () => {
	assert.equal(VERSION, pkg.version);
});

test("createPlugin() registers the hooks, cron with its timeout, fragments and the routes", () => {
	const p = createPlugin({});
	assert.equal(p.id, "astronomic-search");
	const hooks = Object.keys(p.hooks).sort();
	assert.deepEqual(hooks, [
		"content:afterDelete",
		"content:afterPublish",
		"content:afterRestore",
		"content:afterSave",
		"content:afterSchedule",
		"content:afterUnpublish",
		"content:afterUnschedule",
		"cron",
		"page:fragments",
		"plugin:activate",
		"plugin:install",
	]);
	assert.equal((p.hooks.cron as { timeout: number }).timeout, CRON_TIMEOUT_MS);
	assert.equal(CRON_TIMEOUT_MS, 150_000);
	assert.deepEqual(Object.keys(p.routes).sort(), ["index", "indexes", "manifest", "rebuild", "settings", "status"]);
	assert.deepEqual(p.admin.pages, [{ path: "/settings", label: "Search", icon: "magnifying-glass" }]);
});

test("route table: only manifest and index are public, every route lists its methods", () => {
	const table = Object.fromEntries(
		Object.entries(searchRoutes({})).map(([name, r]) => [name, { public: r.public === true, methods: r.methods, permission: r.permission ?? null, response: r.response ?? "json", cacheControl: r.cacheControl ?? null }]),
	);
	const pub = { public: true, methods: ["GET", "HEAD"], permission: null, response: "raw", cacheControl: PUBLIC_CACHE_CONTROL };
	const priv = (methods: string[]) => ({ public: false, methods, permission: "plugins:manage", response: "json", cacheControl: null });
	assert.deepEqual(table, {
		manifest: pub,
		index: pub,
		indexes: priv(["GET"]),
		status: priv(["GET"]),
		rebuild: priv(["POST"]),
		settings: priv(["GET", "POST"]),
	});
});

for (const name of ["plugin:install", "plugin:activate"] as const) {
	test(`${name} schedules tick and nightly and marks the index dirty with force`, async () => {
		const f = fakeCtx();
		await hookOf(pluginDefinition({}, f.deps).hooks![name])({}, f.ctx);
		assert.deepEqual(f.schedules, [
			{ name: TICK, schedule: TICK_SCHEDULE },
			{ name: NIGHTLY, schedule: NIGHTLY_SCHEDULE },
			{ name: REBUILD_SOON, schedule: f.schedules[2]?.schedule ?? "" },
		]);
		assert.match(f.schedules[2]!.schedule, /^\d{4}-\d\d-\d\dT/);
		const { state } = await readState(f.ctx.kv);
		assert.equal(state.force, true);
		assert.equal(state.dirty, 1);
	});
}

test("a content hook marks only a change that counts", async () => {
	const f = fakeCtx();
	const hooks = pluginDefinition({}, f.deps).hooks!;
	await hookOf(hooks["content:afterSave"])({ collection: "posts", content: { id: "x", status: "draft" }, isNew: true }, f.ctx);
	assert.equal((await readState(f.ctx.kv)).state.dirty, 0);
	await hookOf(hooks["content:afterPublish"])({ collection: "posts", content: { id: "x", status: "published" } }, f.ctx);
	assert.equal((await readState(f.ctx.kv)).state.dirty, 1);
});

test("the cron tick builds, then the public routes serve the manifest and the index", async () => {
	const f = fakeCtx();
	const def = pluginDefinition({}, f.deps);
	const routes = def.routes!;
	const before = (await routes.manifest!.handler(routeCtx(f.ctx, "GET", "/manifest"))) as { status: number };
	assert.equal(before.status, 503);
	await hookOf(def.hooks!.cron)({ name: TICK, scheduledAt: new Date().toISOString() }, f.ctx);
	const m = (await routes.manifest!.handler(routeCtx(f.ctx, "GET", "/manifest"))) as { status: number; headers: Array<[string, string]>; body: { kind: string; value: string } };
	assert.equal(m.status, 200);
	const manifest = JSON.parse(m.body.value) as { indexes: { default: { version: string; locales: Record<string, string> } } };
	const path = manifest.indexes.default.locales.en!;
	assert.match(path, /^\/_emdash\/api\/plugins\/astronomic-search\/index\?v=/);
	const etag = new Map(m.headers).get("etag")!;
	const again = (await routes.manifest!.handler(routeCtx(f.ctx, "GET", "/manifest", { headers: { "if-none-match": etag } }))) as { status: number; body: unknown };
	assert.equal(again.status, 304);
	assert.equal(again.body, null);
	const idx = (await routes.index!.handler(routeCtx(f.ctx, "GET", path))) as { status: number; body: { value: string } };
	assert.equal(idx.status, 200);
	assert.match(idx.body.value, /Northwind rebrand/);
	const head = (await routes.index!.handler(routeCtx(f.ctx, "HEAD", path))) as { status: number; body: unknown };
	assert.equal(head.status, 200);
	assert.equal(head.body, null);
});

test("private routes return plain data and turn a core error into a PluginRouteError", async () => {
	const f = fakeCtx();
	const routes = pluginDefinition({}, f.deps).routes!;
	const settings = await routes.settings!.handler(routeCtx(f.ctx, "GET", "/settings"));
	assert.deepEqual(settings, DEFAULT_SETTINGS);
	await assert.rejects(routes.settings!.handler(routeCtx(f.ctx, "POST", "/settings", { input: [1] })), (e: { name: string; status: number }) => e.name === "PluginRouteError" && e.status === 400);
	const status = (await routes.status!.handler(routeCtx(f.ctx, "GET", "/status"))) as { state: string };
	assert.equal(typeof status.state, "string");
});

test("rebuild runs the build through after()", async () => {
	const f = fakeCtx();
	const routes = pluginDefinition({}, f.deps).routes!;
	const r = (await routes.rebuild!.handler(routeCtx(f.ctx, "POST", "/rebuild", { input: {} }))) as { started: boolean };
	assert.equal(r.started, true);
	assert.equal(f.deferred.length, 1);
	await f.deferred[0]!();
	assert.ok((await readState(f.ctx.kv)).state.active);
});

test("page:fragments gives the boot and the config tag, and nothing on preview or edit mode", async () => {
	const f = fakeCtx();
	const fragments = hookOf(pluginDefinition({}, f.deps).hooks!["page:fragments"]);
	const out = await fragments({ page: {} }, f.ctx);
	assert.deepEqual(out, pageFragments(configJson(DEFAULT_SETTINGS)));
	f.deps.request = { editMode: true };
	assert.equal(await fragments({ page: {} }, f.ctx), null);
	f.deps.request = { editMode: false, preview: { contentId: "x" } };
	assert.equal(await fragments({ page: {} }, f.ctx), null);
	f.deps.request = { editMode: false };
	assert.ok(await fragments({ page: {} }, f.ctx));
});

test("no site URL: page:fragments writes nothing, whatever the host, and the first tick builds a path-only index", async () => {
	const f = fakeCtx();
	(f.ctx.site as { url: string }).url = "";
	const def = pluginDefinition({}, f.deps);
	const fragments = hookOf(def.hooks!["page:fragments"]);
	await fragments({ page: { url: "http://localhost:5225/posts/hello" } }, f.ctx);
	await fragments({ page: { url: "https://other.example.com/" } }, f.ctx);
	assert.equal(f.deferred.length, 0, "a page view defers no write");
	await hookOf(def.hooks!.cron)({ name: TICK, scheduledAt: new Date().toISOString() }, f.ctx);
	const active = (await readState(f.ctx.kv)).state.active;
	assert.ok(active, "built with no site URL");
	assert.equal(active.siteUrl, undefined);
	assert.equal(await f.ctx.kv.get("origin"), null);
});

test("Rebuild now with no site URL builds; a request's host is not kept", async () => {
	const f = fakeCtx();
	(f.ctx.site as { url: string }).url = "";
	const def = pluginDefinition({}, f.deps);
	await def.routes!.rebuild!.handler(routeCtx(f.ctx, "POST", "/rebuild", { input: {} }));
	await f.deferred[0]!();
	const active = (await readState(f.ctx.kv)).state.active;
	assert.ok(active);
	assert.equal(active.siteUrl, undefined);
});

test("EmDash renders the fragments with type=module and a JSON config tag", () => {
	const settings = { ...DEFAULT_SETTINGS, placeholder: "</script><b>" };
	const html = renderFragments(pageFragments(configJson(settings)), "body:end");
	const [boot, config] = html.split("\n");
	assert.equal(boot, `<script src="/_search/embed/search-embed.js?ver=${VERSION}" type="module"></script>`);
	const m = /^<script type="application\/json" data-search-config="">(.*)<\/script>$/.exec(config!);
	assert.ok(m, config);
	assert.doesNotMatch(m[1]!, /<\//);
	const parsed = parseEmbedConfig(m[1]);
	assert.ok(parsed);
	assert.equal(parsed.strings.placeholder, "</script><b>");
});

test("filesPath moves the boot", () => {
	const [boot] = pageFragments("{}", "/assets/search");
	assert.equal((boot as { src: string }).src, `/assets/search/search-embed.js?ver=${VERSION}`);
});
