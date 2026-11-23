import assert from "node:assert/strict";
import { test } from "node:test";
import { embedSeeAll, parseEmbedConfig, readConfigTag, type EmbedConfig } from "../src/browser/config.ts";

const full = {
	manifest: "/_search/manifest.json",
	index: "main",
	lang: "fr",
	results: "https://example.com/",
	queryParam: "s",
	paramPrefix: "z_",
	keys: ["mod+k", "/"],
	strings: { placeholder: "Find", seeAll: "All results" },
	browse: [{ label: "Docs", href: "/docs" }],
	takeover: { enabled: true, inputName: "s", skip: ".no-zing", allowFields: ["lang", "post_type"] },
	standDown: null,
	theme: "dark",
};

test("parseEmbedConfig: a full tag gives every field", () => {
	assert.deepEqual(parseEmbedConfig(JSON.stringify(full)), full);
});

const defaults: EmbedConfig = {
	manifest: "/m.json",
	index: "default",
	results: "/search",
	queryParam: "q",
	paramPrefix: "",
	keys: [],
	strings: {},
	browse: [],
	takeover: { enabled: false, inputName: "q", skip: ".no-search-takeover", allowFields: ["lang"] },
	standDown: null,
};

test('parseEmbedConfig: defaults (index "default", results "/search", queryParam "q", paramPrefix "", keys [], takeover off, inputName "q", skip ".no-search-takeover", allowFields ["lang"])', () => {
	assert.deepEqual(parseEmbedConfig('{"manifest":"/m.json"}'), defaults);
	assert.equal(parseEmbedConfig('{"manifest":"/m.json"}')!.lang, undefined);
	assert.equal(parseEmbedConfig('{"manifest":"/m.json"}')!.theme, undefined);
});

test('parseEmbedConfig: theme is "light" or "dark"; any other value is left out (the device decides)', () => {
	for (const theme of ["light", "dark"]) assert.equal(parseEmbedConfig(JSON.stringify({ manifest: "/m.json", theme }))!.theme, theme);
	for (const theme of ["", "auto", "Light", "DARK", 1, true, null, ["dark"], { dark: true }])
		assert.equal(parseEmbedConfig(JSON.stringify({ manifest: "/m.json", theme }))!.theme, undefined, JSON.stringify(theme));
});

test("parseEmbedConfig: bad JSON, no manifest or a non-string manifest gives null (fail open), never a throw", () => {
	for (const text of [null, undefined, "", "{", "null", "[]", '"x"', "{}", '{"manifest":""}', '{"manifest":3}', '{"manifest":["/m.json"]}']) {
		assert.equal(parseEmbedConfig(text), null, String(text));
	}
});

test("parseEmbedConfig: unknown keys are ignored; wrong-typed values fall back to defaults", () => {
	const got = parseEmbedConfig(
		JSON.stringify({
			manifest: "/m.json",
			extra: 1,
			index: 4,
			lang: 5,
			results: {},
			queryParam: "",
			paramPrefix: 7,
			keys: ["mod+k", 3, null],
			strings: "x",
			browse: [{ label: "Docs", href: "/docs" }, { label: 1, href: "/x" }, "y", null],
			takeover: { enabled: "yes", inputName: 1, skip: [], allowFields: "lang", other: true },
			standDown: 9,
		}),
	);
	assert.deepEqual(got, { ...defaults, keys: ["mod+k"], browse: [{ label: "Docs", href: "/docs" }] });
	assert.deepEqual(parseEmbedConfig('{"manifest":"/m.json","takeover":"on","strings":[]}'), defaults);
	assert.deepEqual(parseEmbedConfig('{"manifest":"/m.json","takeover":{"allowFields":["lang",2,"x"]}}')!.takeover.allowFields, ["lang", "x"]);
	// A query name the type or the index takes would make every URL throw: the default.
	assert.equal(parseEmbedConfig('{"manifest":"/m.json","paramPrefix":"z_","queryParam":"z_type"}')!.queryParam, "q");
	assert.equal(parseEmbedConfig('{"manifest":"/m.json","paramPrefix":"a&b"}')!.paramPrefix, "");
});

/** A document whose elements' matches() throws the way the browser does on a selector it cannot parse. */
const selectorDoc = {
	createElement: () => ({
		matches(sel: string) {
			if (/[[(]$|^[>+~]|^$|\)\)/.test(sel.trim())) throw new SyntaxError(`'${sel}' is not a valid selector`);
			return false;
		},
	}),
} as unknown as Document;

test("parseEmbedConfig: an inputName with a quote or bracket, and a skip that is not a valid selector (checked with a try of matches()), fall back to the defaults", () => {
	const take = (t: object) => parseEmbedConfig(JSON.stringify({ manifest: "/m.json", takeover: { enabled: true, ...t } }), selectorDoc)!.takeover;
	for (const name of ['s"', "s'", "s]", "a[b", "s[]]", "s x", ""]) assert.equal(take({ inputName: name }).inputName, "q", name);
	assert.equal(take({ inputName: "s" }).inputName, "s");
	assert.equal(take({ inputName: "tag[]" }).inputName, "tag[]");
	assert.equal(take({ inputName: "post-type_2" }).inputName, "post-type_2");
	for (const skip of [".a[", "> .b", "", "(("]) assert.equal(take({ skip }).skip, ".no-search-takeover", skip);
	assert.equal(take({ skip: ".no-zing, #header form" }).skip, ".no-zing, #header form");
});

test('parseEmbedConfig: standDown "Astra Pro" turns takeover off but keeps placements', () => {
	const c = parseEmbedConfig(JSON.stringify({ ...full, standDown: "Astra Pro" }))!;
	assert.equal(c.standDown, "Astra Pro");
	assert.equal(c.takeover.enabled, false);
	assert.equal(c.takeover.inputName, "s");
	assert.equal(c.manifest, full.manifest);
	assert.deepEqual(c.keys, full.keys);
});

/** A stand-in document: its config tags, each inside a [data-search-page] or not. */
function docWith(tags: { text: string; inPage: boolean }[]): Document {
	const els = tags.map((t) => ({ textContent: t.text, closest: (sel: string) => (sel === "[data-search-page]" && t.inPage ? {} : null) }));
	return {
		querySelectorAll(sel: string) {
			assert.equal(sel, 'script[type="application/json"][data-search-config]');
			return els;
		},
	} as unknown as Document;
}

test("readConfigTag ignores a tag inside [data-search-page]", () => {
	assert.equal(readConfigTag(docWith([])), null);
	assert.equal(readConfigTag(docWith([{ text: '{"manifest":"/page.json"}', inPage: true }])), null);
	const got = readConfigTag(docWith([
		{ text: '{"manifest":"/page.json"}', inPage: true },
		{ text: '{"manifest":"/embed.json"}', inPage: false },
		{ text: '{"manifest":"/second.json"}', inPage: false },
	]));
	assert.equal(got?.manifest, "/embed.json");
});

test("seeAll for an embed: a non-default index writes z_index; the picked type and facets go along; the default index is written too", () => {
	const wp = parseEmbedConfig(JSON.stringify({ manifest: "/m.json", index: "main", results: "https://example.com/", queryParam: "s", paramPrefix: "z_" }))!;
	const seeAll = embedSeeAll(wp);
	assert.equal(seeAll("https://example.com/", { query: " dark mode ", type: "docs", picks: { theme: ["vega", "lodestar"] } }, "shop"), "https://example.com/?s=dark+mode&z_type=docs&z_index=shop&z_theme=vega&z_theme=lodestar");
	assert.equal(seeAll("https://example.com/", { query: "dark", type: null, picks: {} }, "main"), "https://example.com/?s=dark&z_index=main");
	// The base keeps its own parameters (a language) and its fragment; an empty query leaves only those.
	assert.equal(seeAll("/fr/?lang=fr#top", { query: "chat", type: null, picks: {} }, "main"), "/fr/?s=chat&z_index=main&lang=fr#top");
	assert.equal(seeAll("/fr/?lang=fr&s=old", { query: "", type: null, picks: {} }, "main"), "/fr/?z_index=main&lang=fr");
	// The defaults give the Astro kit's URLs.
	const plain = embedSeeAll(parseEmbedConfig('{"manifest":"/m.json"}')!);
	assert.equal(plain("/search", { query: "a b", type: "docs", picks: { tag: ["x"] } }, "default"), "/search?q=a+b&type=docs&index=default&tag=x");
});

test("parseEmbedConfig: strings keep only string values, top level and in results and keys; bad ones take the defaults", () => {
	const got = parseEmbedConfig(
		JSON.stringify({
			manifest: "/m.json",
			strings: { placeholder: "Find", close: 3, seeAll: null, showMore: "More", results: { zero: "None", other: 5 }, keys: "x" },
		}),
	)!;
	assert.deepEqual(got.strings, { placeholder: "Find", showMore: "More", results: { zero: "None" } });
	assert.deepEqual(parseEmbedConfig('{"manifest":"/m.json","strings":{"results":[1],"keys":{"move":"Move","open":{}}}}')!.strings, { keys: { move: "Move" } });
});

test("parseEmbedConfig: a manifest that is not an absolute http(s) or root-relative URL gives null", () => {
	for (const m of [" ", "\t", "manifest.json", "./m.json", "//cdn.example.com/m.json", "javascript:alert(1)", "ftp://example.com/m.json", "https://", "http://exa mple.com/m.json", "/m .json", " /m.json"]) {
		assert.equal(parseEmbedConfig(JSON.stringify({ manifest: m })), null, m);
	}
	for (const m of ["/_search/manifest.json", "https://example.com/wp-content/uploads/search/manifest.json", "http://localhost:8080/m.json?v=2"]) {
		assert.equal(parseEmbedConfig(JSON.stringify({ manifest: m }))?.manifest, m);
	}
});

test("parseEmbedConfig: results keeps http(s) and relative URLs; another scheme (javascript:, data:) takes the default", () => {
	const results = (v: unknown) => parseEmbedConfig(JSON.stringify({ manifest: "/m.json", results: v }))!.results;
	for (const ok of ["/search", "search/", "?s=", "https://example.com/find", "HTTP://example.com/"]) assert.equal(results(ok), ok, ok);
	for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "vbscript:x", "mailto:a@b.c"]) {
		assert.equal(results(bad), "/search", bad);
	}
});

test("parseEmbedConfig: results and browse URLs resolve against the document's base URL, and only http(s) is kept", () => {
	const doc = (baseURI: string) => ({ ...selectorDoc, createElement: selectorDoc.createElement, baseURI }) as unknown as Document;
	const parse = (base: string, v: unknown) => parseEmbedConfig(JSON.stringify({ manifest: "/m.json", results: v, browse: [{ label: "L", href: v }] }), doc(base))!;
	// "https:?s=" on an https page is the page's own URL with ?s=; against an http base it has no host.
	assert.equal(parse("https://example.com/blog/", "https:?s=").results, "https:?s=");
	assert.equal(parse("https://example.com/blog/", "https:?s=").browse.length, 1);
	// Under an ftp: <base href> a relative URL resolves to ftp:, so it is dropped; an absolute https one stays.
	for (const rel of ["search/", "/search", "?s="]) {
		assert.equal(parse("ftp://example.com/", rel).results, "/search", rel);
		assert.equal(parse("ftp://example.com/", rel).browse.length, 0, rel);
	}
	assert.equal(parse("ftp://example.com/", "https://example.com/find").results, "https://example.com/find");
	// The default /search then resolves against the page's own http(s) address, not the ftp: base.
	const onPage = (url: string) => ({ ...selectorDoc, createElement: selectorDoc.createElement, baseURI: "ftp://example.com/", URL: url }) as unknown as Document;
	const fallback = (url: string) => parseEmbedConfig(JSON.stringify({ manifest: "/m.json", results: "javascript:x" }), onPage(url))!.results;
	assert.equal(fallback("https://site.example/blog/post?x=1"), "https://site.example/search");
	assert.equal(fallback("file:///tmp/page.html"), "/search");
});

test("parseEmbedConfig: a browse link with a javascript: or data: href is dropped; relative and http(s) ones stay", () => {
	const browse = [
		{ label: "Docs", href: "/docs" },
		{ label: "Bad", href: "javascript:alert(1)" },
		{ label: "Data", href: "data:text/html,x" },
		{ label: "Away", href: "https://example.com/" },
		{ label: "Here", href: "docs/" },
	];
	assert.deepEqual(parseEmbedConfig(JSON.stringify({ manifest: "/m.json", browse }))!.browse.map((b) => b.label), ["Docs", "Away", "Here"]);
});
