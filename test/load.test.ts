import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSearcher, pickLocale } from "../src/controller/load.ts";
import { prefetch, type Prefetch } from "../src/controller/prefetch.ts";
import type { EngineFactory, IndexFile, IndexSettings, Manifest, SearchEngine, Searcher } from "../src/core/types.ts";

const settings: IndexSettings = {
	weights: { title: 3, heading: 2, text: 1, keywords: 1 },
	group: { dialog: "type", page: false },
	groupOrder: "best",
	types: {},
	facets: {},
};

const manifest: Manifest = {
	schema: 2,
	defaultLocale: "en",
	indexes: {
		site: { version: "a1", locales: { en: "/_search/site.en.a1.json", fr: "/_search/site.fr.a1.json", "pt-BR": "/_search/site.pt-BR.a1.json" } },
	},
};

test("pickLocale: exact, then primary subtag, then the default", () => {
	assert.equal(pickLocale("fr", manifest, "site"), "fr");
	assert.equal(pickLocale("en-US", manifest, "site"), "en");
	assert.equal(pickLocale("pt-br", manifest, "site"), "pt-BR");
	assert.equal(pickLocale("pt", manifest, "site"), "pt-BR");
	assert.equal(pickLocale("de", manifest, "site"), "en");
	assert.equal(pickLocale("", manifest, "site"), "en");
	assert.equal(pickLocale(null, manifest, "site"), "en");
});

test("pickLocale: BCP 47 lookup drops subtags from the end before trying a sibling", () => {
	const m: Manifest = { schema: 2, defaultLocale: "en", indexes: { site: { version: "a", locales: { en: "e", "zh-Hans": "s", "zh-Hant": "t" } } } };
	assert.equal(pickLocale("zh-Hant-TW", m, "site"), "zh-Hant");
	assert.equal(pickLocale("ZH-hant-tw", m, "site"), "zh-Hant");
	assert.equal(pickLocale("zh-Hans-CN", m, "site"), "zh-Hans");
	const n: Manifest = { ...m, indexes: { site: { version: "a", locales: { en: "e", "zh-Hans": "s", zh: "z" } } } };
	assert.equal(pickLocale("zh-Hant-TW", n, "site"), "zh");
	assert.equal(pickLocale("zh-TW", n, "site"), "zh");
});

test("pickLocale: maximizes the tag when the plain lookup fails, and prefers a sibling with the same script", () => {
	const m: Manifest = { schema: 2, defaultLocale: "en", indexes: { site: { version: "a", locales: { en: "e", "zh-Hans": "s", "zh-Hant": "t" } } } };
	assert.equal(pickLocale("zh-TW", m, "site"), "zh-Hant");
	assert.equal(pickLocale("zh-CN", m, "site"), "zh-Hans");
	const n: Manifest = { ...m, indexes: { site: { version: "a", locales: { en: "e", "zh-Hans-CN": "s", "zh-Hant-HK": "t" } } } };
	assert.equal(pickLocale("zh-TW", n, "site"), "zh-Hant-HK");
	assert.equal(pickLocale("zh", n, "site"), "zh-Hans-CN");
	assert.equal(pickLocale("not a tag!", n, "site"), "en");
});

function file(locale: string): IndexFile {
	return { schema: 2, engine: "stub", engineVersion: "1", index: "site", locale, settings, records: { pages: [], sections: [] } };
}

const engine: EngineFactory = {
	name: "stub",
	version: "1",
	capabilities: { fuzzy: false, prefix: false, facets: false, highlights: false },
	build: () => {
		throw new Error("not used");
	},
	load(f: IndexFile): SearchEngine {
		return { name: "stub", capabilities: engine.capabilities, search: () => [], terms: () => [], record: () => undefined, records: () => [] };
	},
};

function createSearch(e: SearchEngine, s: IndexSettings): Searcher {
	return { capabilities: e.capabilities, settings: s, run: () => ({ query: { q: "" }, total: 0, groups: [], types: [], facets: {} }) };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function fakeFetch(routes: Record<string, () => Response>): { fetch: Fetch; seen: string[]; inits: (RequestInit | undefined)[] } {
	const seen: string[] = [];
	const inits: (RequestInit | undefined)[] = [];
	return {
		seen,
		inits,
		fetch: async (url: string, init?: RequestInit) => {
			seen.push(url);
			inits.push(init);
			const r = routes[url];
			return r ? r() : new Response("missing", { status: 404 });
		},
	};
}

const json = (v: unknown) => () => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

test("loadSearcher fetches the manifest, then the one file for the locale", async () => {
	const f = fakeFetch({ "/_search/manifest.json": json(manifest), "/_search/site.fr.a1.json": json(file("fr")) });
	const s = await loadSearcher({ index: "site", lang: "fr-CA", manifestUrl: "/_search/manifest.json", fetch: f.fetch, engine, createSearch });
	assert.deepEqual(f.seen, ["/_search/manifest.json", "/_search/site.fr.a1.json"]);
	assert.deepEqual(s.settings.weights, settings.weights);
});

test("the manifest is fetched with cache no-cache; a hashed file is not", async () => {
	const f = fakeFetch({ "/_search/manifest.json": json(manifest), "/_search/site.en.a1.json": json(file("en")) });
	await loadSearcher({ index: "site", lang: "en", manifestUrl: "/_search/manifest.json", fetch: f.fetch, engine, createSearch });
	assert.deepEqual(f.inits, [{ cache: "no-cache" }, undefined]);
});

test("a 404 on the index file refetches the manifest once, then loads the new file", async () => {
	const newer: Manifest = { ...manifest, indexes: { site: { version: "b2", locales: { en: "/_search/site.en.b2.json" } } } };
	let calls = 0;
	const f = fakeFetch({ "/m.json": () => json(calls++ === 0 ? manifest : newer)(), "/_search/site.en.b2.json": json(file("en")) });
	await loadSearcher({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: f.fetch, engine, createSearch });
	assert.deepEqual(f.seen, ["/m.json", "/_search/site.en.a1.json", "/m.json", "/_search/site.en.b2.json"]);
	// The same manifest again: the 404 stands, with no third try.
	const g = fakeFetch({ "/m.json": json(manifest) });
	await assert.rejects(loadSearcher({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: g.fetch, engine, createSearch }), /404/);
	assert.deepEqual(g.seen, ["/m.json", "/_search/site.en.a1.json", "/m.json"]);
});

test("a file URL resolves against the manifest URL", async () => {
	const m: Manifest = { ...manifest, indexes: { site: { version: "a1", locales: { en: "site.en.a1.json" } } } };
	const f = fakeFetch({ "https://x.dev/_search/manifest.json": json(m), "https://x.dev/_search/site.en.a1.json": json(file("en")) });
	await loadSearcher({ index: "site", lang: "en", manifestUrl: "https://x.dev/_search/manifest.json", fetch: f.fetch, engine, createSearch });
	assert.equal(f.seen[1], "https://x.dev/_search/site.en.a1.json");
});

test("a missing index name rejects with an error naming it", async () => {
	const f = fakeFetch({ "/m.json": json(manifest) });
	await assert.rejects(loadSearcher({ index: "kit", lang: "en", manifestUrl: "/m.json", fetch: f.fetch, engine, createSearch }), /"kit"/);
});

test("a 404 rejects with a short message", async () => {
	const f = fakeFetch({});
	await assert.rejects(
		loadSearcher({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: f.fetch, engine, createSearch }),
		(e: Error) => /404/.test(e.message) && /\/m\.json/.test(e.message) && e.message.length < 120,
	);
	const g = fakeFetch({ "/m.json": json(manifest) });
	await assert.rejects(loadSearcher({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: g.fetch, engine, createSearch }), /404/);
});

test("bad JSON rejects with a short message", async () => {
	const f = fakeFetch({ "/m.json": () => new Response("{not json") });
	await assert.rejects(
		loadSearcher({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: f.fetch, engine, createSearch }),
		(e: Error) => /JSON/.test(e.message) && e.message.length < 120,
	);
	const g = fakeFetch({ "/m.json": json(manifest), "/_search/site.en.a1.json": () => new Response("<html>") });
	await assert.rejects(loadSearcher({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: g.fetch, engine, createSearch }), /JSON/);
});

test("a file for another engine or schema rejects", async () => {
	const f = fakeFetch({ "/m.json": json(manifest), "/_search/site.en.a1.json": json({ ...file("en"), engine: "other" }) });
	await assert.rejects(loadSearcher({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: f.fetch, engine, createSearch }), /engine/);
	const g = fakeFetch({ "/m.json": json({ ...manifest, schema: 1 }) });
	await assert.rejects(loadSearcher({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: g.fetch, engine, createSearch }), /schema/);
});

test("a file for another index, locale or engine version rejects (swapped manifest entries)", async () => {
	const swapped = fakeFetch({ "/m.json": json(manifest), "/_search/site.en.a1.json": json({ ...file("en"), index: "docs" }) });
	await assert.rejects(loadSearcher({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: swapped.fetch, engine, createSearch }), /^Error: Search: .*index "docs".*"site"/);
	const locale = fakeFetch({ "/m.json": json(manifest), "/_search/site.fr.a1.json": json(file("en")) });
	await assert.rejects(loadSearcher({ index: "site", lang: "fr", manifestUrl: "/m.json", fetch: locale.fetch, engine, createSearch }), /^Error: Search: .*locale "en".*"fr"/);
	const version = fakeFetch({ "/m.json": json(manifest), "/_search/site.en.a1.json": json({ ...file("en"), engineVersion: "2" }) });
	await assert.rejects(loadSearcher({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: version.fetch, engine, createSearch }), /^Error: Search: .*version "2".*"1"/);
});

test("a file in the fallback locale (no default-locale file) loads", async () => {
	const m: Manifest = { ...manifest, indexes: { site: { version: "a1", locales: { fr: "/_search/site.fr.a1.json" } } } };
	const f = fakeFetch({ "/m.json": json(m), "/_search/site.fr.a1.json": json(file("fr")) });
	await loadSearcher({ index: "site", lang: "de", manifestUrl: "/m.json", fetch: f.fetch, engine, createSearch });
});

test("an index named like an Object.prototype key is not in the manifest", async () => {
	for (const index of ["constructor", "__proto__", "toString"]) {
		const f = fakeFetch({ "/_search/manifest.json": json(manifest) });
		await assert.rejects(loadSearcher({ index, lang: "en", manifestUrl: "/_search/manifest.json", fetch: f.fetch, engine, createSearch }), new RegExp(`no index named "${index}"`));
		assert.equal(pickLocale("en", manifest, index), "en");
	}
});

// Prefetch: boot starts the manifest and the file loads before the app is in; loadSearcher takes them.

const base = { index: "site", manifestUrl: "/m.json", engine, createSearch };

test("prefetch fetches the manifest (no-cache), then the file for the lang, before any loadSearcher", async () => {
	const f = fakeFetch({ "/m.json": json(manifest), "/_search/site.fr.a1.json": json(file("fr")) });
	const p = prefetch({ index: "site", lang: "fr-CA", manifestUrl: "/m.json", fetch: f.fetch });
	assert.deepEqual(await p.file, { url: "/_search/site.fr.a1.json", data: file("fr") });
	assert.deepEqual(f.seen, ["/m.json", "/_search/site.fr.a1.json"]);
	assert.deepEqual(f.inits, [{ cache: "no-cache" }, undefined]);
});

test("prefetch picks the same file as loadSearcher: plain lookup, one locale, no lang; else nothing", async () => {
	const one: Manifest = { ...manifest, indexes: { site: { version: "a1", locales: { fr: "/f.json" } } } };
	const cases: [Manifest, string, string | undefined][] = [
		[manifest, "pt-br", "/_search/site.pt-BR.a1.json"],
		[manifest, "EN-us", "/_search/site.en.a1.json"],
		[manifest, "", "/_search/site.en.a1.json"],
		[one, "de", "/f.json"],
		// Needs Intl maximizing ("de" has no sibling, the loader takes the default): left to loadSearcher.
		[manifest, "de", undefined],
	];
	for (const [m, lang, want] of cases) {
		const f = fakeFetch({ "/m.json": json(m), [want ?? "-"]: json(file("x")) });
		const got = await prefetch({ index: "site", lang, manifestUrl: "/m.json", fetch: f.fetch }).file.then((x) => x.url, () => undefined);
		assert.equal(got, want, lang);
	}
});

test("loadSearcher uses a prefetch in place of fetching", async () => {
	const early = fakeFetch({ "/m.json": json(manifest), "/_search/site.en.a1.json": json(file("en")) });
	const p = prefetch({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: early.fetch });
	const f = fakeFetch({});
	const s = await loadSearcher({ ...base, lang: "en", fetch: f.fetch, prefetch: p });
	assert.equal(s.locale, "en");
	assert.deepEqual(f.seen, []);
});

test("a failed prefetch falls back to the plain fetch, with no unhandled rejection", async () => {
	const unhandled: unknown[] = [];
	const on = (e: unknown) => unhandled.push(e);
	process.on("unhandledRejection", on);
	try {
		const down: Fetch = async () => {
			throw new TypeError("offline");
		};
		const p = prefetch({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: down });
		const bad = prefetch({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: fakeFetch({ "/m.json": () => new Response("x", { status: 503 }) }).fetch });
		// A manifest that is not an object: its file prefetch rejects, handled.
		prefetch({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: fakeFetch({ "/m.json": () => new Response("null") }).fetch });
		const fileFails = prefetch({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: fakeFetch({ "/m.json": json(manifest), "/_search/site.en.a1.json": () => new Response("x", { status: 500 }) }).fetch });
		await new Promise((r) => setTimeout(r, 10));
		for (const given of [p, bad, fileFails]) {
			const f = fakeFetch({ "/m.json": json(manifest), "/_search/site.en.a1.json": json(file("en")) });
			await loadSearcher({ ...base, lang: "en", fetch: f.fetch, prefetch: given });
			assert.ok(f.seen.includes("/_search/site.en.a1.json"));
		}
		await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", on);
	}
});

test("a prefetch for another index, manifest URL or locale is not used", async () => {
	const early = fakeFetch({ "/m.json": json(manifest), "/_search/site.en.a1.json": json(file("en")), "/other.json": json(manifest) });
	const p = prefetch({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: early.fetch });
	// The lang changed after a route swap: the manifest is reused, the French file is fetched.
	const fr = fakeFetch({ "/_search/site.fr.a1.json": json(file("fr")) });
	assert.equal((await loadSearcher({ ...base, lang: "fr", fetch: fr.fetch, prefetch: p })).locale, "fr");
	assert.deepEqual(fr.seen, ["/_search/site.fr.a1.json"]);
	const other = fakeFetch({ "/other.json": json(manifest), "/_search/site.en.a1.json": json(file("en")) });
	await loadSearcher({ ...base, manifestUrl: "/other.json", lang: "en", fetch: other.fetch, prefetch: p });
	assert.deepEqual(other.seen, ["/other.json", "/_search/site.en.a1.json"]);
	const kit: Prefetch = { ...p, index: "kit" };
	const g = fakeFetch({ "/m.json": json(manifest), "/_search/site.en.a1.json": json(file("en")) });
	await loadSearcher({ ...base, lang: "en", fetch: g.fetch, prefetch: kit });
	assert.deepEqual(g.seen, ["/m.json", "/_search/site.en.a1.json"]);
});

test("a prefetched 404 on the file revalidates the manifest (not the prefetched one) and loads the new file", async () => {
	const newer: Manifest = { ...manifest, indexes: { site: { version: "b2", locales: { en: "/_search/site.en.b2.json" } } } };
	const early = fakeFetch({ "/m.json": json(manifest) });
	const p = prefetch({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: early.fetch });
	const f = fakeFetch({ "/m.json": json(newer), "/_search/site.en.b2.json": json(file("en")) });
	await loadSearcher({ ...base, lang: "en", fetch: f.fetch, prefetch: p });
	assert.deepEqual(early.seen, ["/m.json", "/_search/site.en.a1.json"]);
	assert.deepEqual(f.seen, ["/m.json", "/_search/site.en.b2.json"]);
	assert.deepEqual(f.inits, [{ cache: "no-cache" }, undefined]);
});

test("a stalled prefetch of another file is not waited on: the URL is compared first", async () => {
	// Hover on an English page, then a route swap to a French one before the app loads; the English file never answers.
	const early: Fetch = (url) => (url === "/m.json" ? Promise.resolve(json(manifest)()) : new Promise<Response>(() => {}));
	const p = prefetch({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: early });
	assert.equal(await p.fileUrl, "/_search/site.en.a1.json");
	const fr = fakeFetch({ "/_search/site.fr.a1.json": json(file("fr")) });
	const s = await Promise.race([loadSearcher({ ...base, lang: "fr", fetch: fr.fetch, prefetch: p }), new Promise<never>((_, no) => setTimeout(() => no(new Error("waited on the stalled file")), 200))]);
	assert.equal(s.locale, "fr");
	assert.deepEqual(fr.seen, ["/_search/site.fr.a1.json"]);
});

test("the same prefetch passed twice is used once: the second load fetches fresh", async () => {
	const early = fakeFetch({ "/m.json": json(manifest), "/_search/site.en.a1.json": json(file("en")) });
	const p = prefetch({ index: "site", lang: "en", manifestUrl: "/m.json", fetch: early.fetch });
	const first = fakeFetch({});
	await loadSearcher({ ...base, lang: "en", fetch: first.fetch, prefetch: p });
	assert.deepEqual(first.seen, []);
	const again = fakeFetch({ "/m.json": json(manifest), "/_search/site.en.a1.json": json(file("en")) });
	await loadSearcher({ ...base, lang: "en", fetch: again.fetch, prefetch: p });
	assert.deepEqual(again.seen, ["/m.json", "/_search/site.en.a1.json"]);
});
