import { test } from "node:test";
import assert from "node:assert/strict";
import { createController } from "../src/controller/index.ts";
import type { IndexSettings, Query, SearchRecord, SearchResult, Searcher } from "../src/core/types.ts";
import { bindEvents } from "../src/dom/events.ts";

const settings: IndexSettings = {
	weights: { title: 3, heading: 2, text: 1, keywords: 1 },
	group: { dialog: "type", page: false },
	groupOrder: "best",
	types: { docs: { label: "Docs" } },
	facets: {},
};

const rec = (id: string): SearchRecord => ({ id, kind: "page", locale: "en", type: "docs", url: `/${id}`, title: id, text: "", facets: {}, source: "collection" });
const hl = { title: [], snippet: { text: "", ranges: [] } };

/** "none" finds nothing; anything else finds two pages. */
const searcher: Searcher = {
	capabilities: { fuzzy: true, prefix: true, facets: true, highlights: true },
	settings,
	locale: "en",
	run(query: Query): SearchResult {
		const n = query.q === "none" ? 0 : 2;
		const items = Array.from({ length: n }, (_, i) => ({ page: rec(`p${i}`), score: 1, highlight: hl, headings: [] }));
		return { query, total: n, groups: n ? [{ key: "docs", label: "Docs", items }] : [], types: [], facets: {} };
	},
};

async function setup(t: import("node:test").TestContext) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const c = createController({ index: "site", surface: "dialog", storage: null, load: async () => searcher });
	await c.preload();
	const target = new EventTarget();
	const seen: { type: string; detail: unknown; bubbles: boolean; composed: boolean }[] = [];
	for (const name of ["search:query", "search:select", "search:noresults"]) {
		target.addEventListener(name, (e) => {
			const ce = e as CustomEvent;
			seen.push({ type: ce.type, detail: ce.detail, bubbles: ce.bubbles, composed: ce.composed });
		});
	}
	const events = bindEvents(target, c, { delay: 600 });
	return { c, seen, events, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test("search:query fires once after typing stops, with the query, index, locale, total and type", async (t) => {
	const { c, seen, tick } = await setup(t);
	c.input("c");
	tick(300);
	c.input("co");
	tick(300);
	c.input("com");
	assert.equal(seen.length, 0);
	tick(599);
	assert.equal(seen.length, 0);
	tick(1);
	assert.deepEqual(seen, [{ type: "search:query", detail: { query: "com", index: "site", locale: "en", total: 2, type: null }, bubbles: true, composed: true }]);
	// Moving through the options is not a new search.
	c.move(1);
	tick(1000);
	assert.equal(seen.length, 1);
	// A type tab is.
	c.setType("docs");
	tick(600);
	assert.equal(seen.length, 2);
	assert.deepEqual(seen[1]?.detail, { query: "com", index: "site", locale: "en", total: 2, type: "docs" });
});

test("search:noresults fires with the query and index, after search:query, when a settled query has none", async (t) => {
	const { c, seen, tick } = await setup(t);
	c.input("none");
	tick(600);
	assert.deepEqual(
		seen.map((e) => [e.type, e.detail]),
		[
			["search:query", { query: "none", index: "site", locale: "en", total: 0, type: null }],
			["search:noresults", { query: "none", index: "site" }],
		],
	);
});

test("no event for an empty box or during composition; the same query again does not repeat", async (t) => {
	const { c, seen, tick } = await setup(t);
	c.input("   ");
	tick(1000);
	c.compositionStart();
	c.input("ab");
	tick(1000);
	assert.equal(seen.length, 0);
	c.compositionEnd("abc");
	tick(600);
	assert.equal(seen.length, 1);
	c.input("abc ");
	tick(600);
	assert.equal(seen.length, 1);
	// Cleared, then typed again: a new search.
	c.escape();
	tick(600);
	c.input("abc");
	tick(600);
	assert.equal(seen.length, 2);
});

test("search:select carries the query, index, id, url, type and 1-based position; a pending query fires first", async (t) => {
	const { c, seen, events, tick } = await setup(t);
	c.input("star");
	c.move(1);
	const option = c.getState().options[c.getState().active]!;
	events.select(option, c.getState().active + 1);
	assert.deepEqual(
		seen.map((e) => [e.type, e.detail]),
		[
			["search:query", { query: "star", index: "site", locale: "en", total: 2, type: null }],
			["search:select", { query: "star", index: "site", id: "p1", url: "/p1", type: "docs", position: 2 }],
		],
	);
	tick(1000);
	assert.equal(seen.length, 2);
});

test("closing the dialog fires a pending query at once; unbind stops every event", async (t) => {
	const { c, seen, events, tick } = await setup(t);
	c.open();
	c.input("moon");
	c.close();
	assert.equal(seen.length, 1);
	c.open();
	c.input("sun");
	events.unbind();
	tick(1000);
	assert.equal(seen.length, 1);
});

test("search:select for a suggested link: id null, the empty query, its url, type and position", async (t) => {
	const { seen, events } = await setup(t);
	events.select({ id: "suggested:1", kind: "suggested", url: "/pricing", label: "Pricing", type: "pages" }, 2);
	assert.deepEqual(seen.map((e) => e.detail), [{ query: "", index: "site", id: null, url: "/pricing", type: "pages", position: 2 }]);
});
