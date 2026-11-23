/**
 * src/page (the results page's pure helpers): the query, the type, the index and the filter picks in the URL, with
 * names a host can change (`queryParam`, a prefix); the toggles that take one set of picks to another; the first
 * `shown` pages of a result; and the page's words. Ported from the kit's search-page tests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGE_SIZE, defaultPageWords, pageStrings, pickToggles, readUrl, slicePages, writeUrl } from "../src/page/index.ts";

/** Picks as readUrl gives them: a null-prototype object, so a facet named like an Object.prototype key is a plain own key. */
const P = (picks: Record<string, string[]> = {}) => Object.assign(Object.create(null), picks);

test("the page size: 20 results at a time", () => {
	assert.equal(PAGE_SIZE, 20);
});

test("readUrl: the query, the type and the picks", () => {
	assert.deepEqual(readUrl("?q=dark+mode&type=docs&theme=vega"), { query: "dark mode", type: "docs", index: null, picks: P({ theme: ["vega"] }) });
	assert.deepEqual(readUrl("q=dark%20mode"), { query: "dark mode", type: null, index: null, picks: P({}) }, "with or without the ?");
	assert.deepEqual(readUrl(""), { query: "", type: null, index: null, picks: P({}) });
});

test("readUrl: a facet picked twice is two values, once each; empty values are left out", () => {
	assert.deepEqual(readUrl("?q=x&theme=vega&theme=apogee&theme=vega&theme=&type="), { query: "x", type: null, index: null, picks: P({ theme: ["vega", "apogee"] }) });
});

test("readUrl: with the index's facets, only those are picks", () => {
	assert.deepEqual(readUrl("?q=x&theme=vega&utm_source=news", ["theme"]), { query: "x", type: null, index: null, picks: P({ theme: ["vega"] }) });
	assert.deepEqual(readUrl("?q=x&utm_source=news", []), { query: "x", type: null, index: null, picks: P({}) });
});

test("writeUrl: the query, the type and the picks, empty values left out", () => {
	assert.equal(writeUrl({ query: "dark mode", type: "docs", index: null, picks: { theme: ["vega"] } }), "?q=dark+mode&type=docs&theme=vega");
	assert.equal(writeUrl({ query: "  dark mode ", type: null, index: null, picks: {} }), "?q=dark+mode", "the query is trimmed");
	assert.equal(writeUrl({ query: "", type: null, index: null, picks: { theme: [] } }), "");
	assert.equal(writeUrl({ query: " ", type: "", index: null, picks: {} }), "");
});

test("writeUrl: unknown parameters are kept, after ours; old picks and old values are replaced", () => {
	const current = "?utm_source=news&q=old&type=learn&theme=apogee&ref=a";
	assert.equal(writeUrl({ query: "new", type: null, index: null, picks: { theme: ["vega"] } }, current, ["theme"]), "?q=new&theme=vega&utm_source=news&ref=a");
	assert.equal(writeUrl({ query: "", type: null, index: null, picks: {} }, current, ["theme"]), "?utm_source=news&ref=a", "a facet with no pick is dropped");
	assert.equal(writeUrl({ query: "x", type: null, index: null, picks: {} }, "?utm_source=news"), "?q=x&utm_source=news");
});

test("writeUrl and readUrl: picks round-trip, several values and several facets", () => {
	const state = { query: "card", type: "components", index: null, picks: { theme: ["vega", "apogee"], tier: ["free"] } };
	assert.deepEqual(readUrl(writeUrl(state)), { ...state, picks: P(state.picks) });
	const odd = { query: "a&b=c ?#", type: null, index: null, picks: { "the theme": ["x&y", "z=1"] } };
	assert.deepEqual(readUrl(writeUrl(odd)), { ...odd, picks: P(odd.picks) });
});

test("readUrl: without the index's facets, a parameter named like an Object.prototype property is no pick, and nothing throws", () => {
	for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
		const state = readUrl(`?q=card&${name}=x&theme=vega`);
		assert.equal(state.query, "card", name);
		assert.deepEqual(Object.keys(state.picks), ["theme"], name);
		assert.deepEqual(state.picks.theme, ["vega"], name);
		assert.equal(Object.getPrototypeOf(state.picks), null, `${name}: the picks have no prototype`);
		assert.equal(state.picks[name], undefined, `${name}: nothing inherited reads through`);
		// writeUrl keeps it as a parameter that is not ours.
		assert.equal(writeUrl(state, `?q=card&${name}=x&theme=vega`), `?q=card&theme=vega&${encodeURIComponent(name)}=x`, name);
	}
});

test("readUrl: a facet the index declares is a pick, even one named like an Object.prototype property", () => {
	for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
		const state = readUrl(`?q=card&${name}=x&${name}=y&${name}=x&theme=vega&other=z`, [name, "theme"]);
		assert.deepEqual(state, { query: "card", type: null, index: null, picks: P({ [name]: ["x", "y"], theme: ["vega"] }) }, name);
		assert.ok(Object.hasOwn(state.picks, name), `${name}: an own pick`);
		assert.deepEqual(Object.keys(state.picks), [name, "theme"], name);
		assert.equal(Object.getPrototypeOf(state.picks), null, name);
		assert.equal(writeUrl(state, "", [name, "theme"]), `?q=card&${encodeURIComponent(name)}=x&${encodeURIComponent(name)}=y&theme=vega`, `${name}: round-trips`);
		assert.deepEqual(readUrl(`?q=card&theme=vega`, [name, "theme"]).picks[name], undefined, `${name}: not picked, not inherited`);
	}
});

test("pickToggles: picks named like Object.prototype properties are compared as own picks only", () => {
	assert.deepEqual(pickToggles({ constructor: ["x"] }, {}), [["constructor", "x"]]);
	assert.deepEqual(pickToggles({}, { toString: ["y"] }), [["toString", "y"]]);
	assert.deepEqual(pickToggles({ theme: ["vega"] }, { theme: ["vega"], valueOf: ["z"] }), [["valueOf", "z"]]);
});

test("pickToggles: the facet values to toggle to go from one set of picks to another", () => {
	assert.deepEqual(pickToggles({}, {}), []);
	assert.deepEqual(pickToggles({ theme: ["vega"] }, { theme: ["vega"] }), []);
	assert.deepEqual(
		pickToggles({ theme: ["vega", "apogee"], tier: ["pro"] }, { theme: ["vega", "lodestar"] }),
		[
			["theme", "apogee"],
			["tier", "pro"],
			["theme", "lodestar"],
		],
	);
});

/** A page result, loose: only the fields slicePages reads are real. */
const page = (n: number, headings = 0): never =>
	({
	page: { id: `p${n}`, kind: "page", type: "docs", url: `/p${n}`, title: `P${n}` },
	score: 1,
	highlight: { title: [], snippet: { text: "", ranges: [] } },
	headings: Array.from({ length: headings }, (_, i) => ({ record: { id: `p${n}#${i}` }, score: 1, highlight: { title: [], snippet: { text: "", ranges: [] } } })),
	}) as never;

test("slicePages: the first `shown` pages, in group order, groups with none left out", () => {
	const result = {
		total: 5,
		groups: [
			{ key: "docs", label: "Docs", items: [page(1, 2), page(2)] },
			{ key: "learn", label: "Learn", items: [page(3), page(4), page(5)] },
		],
	};
	const three = slicePages(result, 3);
	assert.deepEqual(
		three.groups.map((g) => [g.key, g.items.map((i) => i.page.id)]),
		[
			["docs", ["p1", "p2"]],
			["learn", ["p3"]],
		],
	);
	assert.equal(three.shown, 3);
	assert.equal(three.more, true);
	assert.deepEqual(slicePages(result, 2).groups.map((g) => g.key), ["docs"]);
	const all = slicePages(result, 20);
	assert.equal(all.shown, 5);
	assert.equal(all.more, false);
	assert.equal(slicePages(null, 20).shown, 0);
});

test("slicePages: the flat option list of what is shown, each page then its headings (the positions for search:select)", () => {
	const result = { total: 2, groups: [{ key: "", label: "", items: [page(1, 2), page(2)] }] };
	assert.deepEqual(
		slicePages(result, 1).options.map((o) => o.id),
		["p1", "p1#0", "p1#1"],
	);
	assert.deepEqual(
		slicePages(result, 2).options.map((o) => o.id),
		["p1", "p1#0", "p1#1", "p2"],
	);
});

const Z = { query: "s", prefix: "z_" };

test('readUrl with names: queryParam "s" reads ?s=, and the type, index and facets read prefixed names (z_type, z_index, z_tag)', () => {
	assert.deepEqual(readUrl("?s=dark+mode&z_type=docs&z_index=blog&z_tag=news&z_tag=tips", undefined, Z), {
		query: "dark mode",
		type: "docs",
		index: "blog",
		picks: P({ tag: ["news", "tips"] }),
	});
	assert.deepEqual(readUrl("?s=x&z_tag=news&q=other", ["tag"], Z), { query: "x", type: null, index: null, picks: P({ tag: ["news"] }) });
	assert.deepEqual(readUrl("?s=x", undefined, { query: "s" }), { query: "x", type: null, index: null, picks: P({}) }, "a query name alone");
	assert.deepEqual(readUrl("?q=x&index=blog"), { query: "x", type: null, index: "blog", picks: P({}) }, "defaults: index is read");
});

test("readUrl with a prefix ignores unprefixed WordPress vars (tag, category_name, post_type, paged)", () => {
	const state = readUrl("?s=x&tag=a&category_name=b&post_type=post&paged=2&z_tag=news", undefined, Z);
	assert.deepEqual(state, { query: "x", type: null, index: null, picks: P({ tag: ["news"] }) });
	assert.deepEqual(readUrl("?s=x&tag=a&category_name=b", ["tag", "category_name"], Z).picks, P({}), "even when the index declares them");
});

test("writeUrl with names writes s, z_type, z_index and z_<facet>, and keeps every other parameter in its order", () => {
	const state = { query: "dark mode", type: "docs", index: "blog", picks: { tag: ["news", "tips"] } };
	assert.equal(writeUrl(state, "", ["tag"], Z), "?s=dark+mode&z_type=docs&z_index=blog&z_tag=news&z_tag=tips");
	const current = "?lang=fr&s=old&z_tag=old&tag=keep&z_type=learn&paged=2&z_other=1";
	assert.equal(writeUrl(state, current, ["tag"], Z), "?s=dark+mode&z_type=docs&z_index=blog&z_tag=news&z_tag=tips&lang=fr&tag=keep&paged=2&z_other=1");
	assert.equal(writeUrl({ query: "", type: null, index: null, picks: {} }, current, ["tag"], Z), "?lang=fr&tag=keep&paged=2&z_other=1");
	assert.deepEqual(readUrl(writeUrl(state, current, ["tag"], Z), ["tag"], Z), { ...state, picks: P(state.picks) }, "round-trips");
});

test('reserved names: a facet named "type", "index" or the query name is never read or written as a pick, with or without a prefix', () => {
	for (const names of [undefined, Z]) {
		const q = names?.query ?? "q";
		const pre = names?.prefix ?? "";
		const facets = ["type", "index", q, "theme"];
		const search = `?${q}=x&${pre}type=docs&${pre}index=blog&${pre}${q}=y&${pre}theme=vega`;
		const expect = { query: "x", type: "docs", index: "blog", picks: P({ theme: ["vega"] }) };
		assert.deepEqual(readUrl(search, facets, names), expect, `with facets, ${pre || "no prefix"}`);
		assert.deepEqual(readUrl(search, undefined, names).picks.theme, ["vega"]);
		for (const name of ["type", "index", q]) assert.equal(readUrl(search, undefined, names).picks[name], undefined, `${name} is no pick`);
		const out = writeUrl({ query: "x", type: null, index: null, picks: { type: ["a"], index: ["b"], [q]: ["c"], theme: ["vega"] } }, "", facets, names);
		assert.equal(out, `?${q}=x&${pre}theme=vega`, `written, ${pre || "no prefix"}`);
	}
});

test("defaults keep today's URLs: ?q=dark+mode&type=docs&theme=vega round-trips byte for byte", () => {
	const url = "?q=dark+mode&type=docs&theme=vega";
	assert.equal(writeUrl(readUrl(url)), url);
	assert.equal(writeUrl(readUrl(url, ["theme"]), url, ["theme"]), url);
	assert.equal(writeUrl({ query: "x", type: null, index: "blog", picks: {} }), "?q=x&index=blog", "index is written only when set");
});

test("pageStrings: the defaults with the input's strings on top; non-strings ignored", () => {
	assert.deepEqual(pageStrings(), defaultPageWords);
	assert.equal(pageStrings({ submit: "Go" }).submit, "Go");
	assert.equal(pageStrings({ submit: 3 as unknown as string }).submit, "Search");
	assert.notEqual(pageStrings(), defaultPageWords, "a copy");
});

test("reserved names: with dev, one warning per reserved facet name", (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	readUrl("?q=x&type=a", ["type"], { dev: true });
	readUrl("?q=x&type=a", ["type"], { dev: true });
	writeUrl({ query: "x", type: null, index: null, picks: { type: ["a"] } }, "", [], { dev: true });
	assert.equal(warn.mock.callCount(), 1);
	readUrl("?q=x", ["index"]);
	assert.equal(warn.mock.callCount(), 1, "no warning without dev");
});

test("URL names must be distinct: a query name equal to the prefixed type or index throws a clear error", () => {
	for (const query of ["z_type", "z_index"]) {
		assert.throws(() => readUrl("?x=1", undefined, { query, prefix: "z_" }), /Search: the URL names .* must be distinct/, query);
		assert.throws(() => writeUrl({ query: "a", type: null, index: null, picks: {} }, "", [], { query, prefix: "z_" }), /must be distinct/, query);
	}
	assert.throws(() => readUrl("", undefined, { query: "type" }), /must be distinct/, "no prefix");
});

test("reserved names: with dev, a declared reserved facet warns from the facets list alone", (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	readUrl("?q=x", ["theme", "index"], { dev: true, prefix: "w_" });
	assert.equal(warn.mock.callCount(), 1, "readUrl, no index value in the URL");
	writeUrl({ query: "x", type: null, index: null, picks: {} }, "", ["s"], { dev: true, query: "s", prefix: "w_" });
	assert.equal(warn.mock.callCount(), 2, "writeUrl, no pick");
});

test("readUrl and writeUrl: a declared empty facet name is a pick, as in the kit", () => {
	const state = readUrl("?q=card&=vega", [""]);
	assert.deepEqual(state, { query: "card", type: null, index: null, picks: P({ "": ["vega"] }) });
	assert.equal(writeUrl(state, "", [""]), "?q=card&=vega");
});
