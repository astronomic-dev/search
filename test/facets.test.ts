import { test } from "node:test";
import assert from "node:assert/strict";
import { minisearchEngine } from "../src/core/minisearch.ts";
import { createSearch } from "../src/core/search.ts";
import type { FacetCount, IndexSettings, Query, SearchRecord } from "../src/core/types.ts";

const settings: IndexSettings = {
	weights: { title: 3, heading: 2, text: 1, keywords: 1 },
	group: { dialog: "type", page: false },
	groupOrder: "best",
	types: { docs: { label: "Docs" }, themes: { label: "Themes" }, learn: { label: "Learn" } },
	facets: { theme: { label: "Theme", values: { vega: "Vega" } }, kind: { label: "Kind" } },
};

const page = (n: number, type: string, title: string, text: string, facets: Record<string, string[]>): SearchRecord => ({
	id: `en:/p${n}`,
	kind: "page",
	locale: "en",
	type,
	url: `/p${n}`,
	title,
	text,
	facets,
	source: "collection",
});
const heading = (p: SearchRecord, slug: string, h: string, text = ""): SearchRecord => ({
	...p,
	id: `${p.id}#${slug}`,
	kind: "heading",
	pageId: p.id,
	url: `${p.url}#${slug}`,
	heading: h,
	text,
}) as SearchRecord;

// 6 pages, 10 headings. "orbit" matches p1 to p5, not p6.
const p1 = page(1, "docs", "Orbit setup", "Start here.", { theme: ["vega"], kind: ["guide"] });
const p2 = page(2, "docs", "Reference", "All about the orbit.", { theme: ["vesper"], kind: ["reference"] });
const p3 = page(3, "themes", "Vega orbit", "A listing theme.", { theme: ["vega"] });
const p4 = page(4, "learn", "Primer", "Why an orbit matters.", { kind: ["guide"] });
const p5 = page(5, "docs", "Looks", "Colors along the orbit.", { theme: ["lodestar"], kind: ["guide"] });
const p6 = page(6, "docs", "Install", "Clone the repository.", { theme: ["vega"], kind: ["reference"] });
const records = [
	p1,
	heading(p1, "a", "Orbit one"),
	heading(p1, "b", "Orbit two"),
	heading(p1, "c", "Orbit three"),
	p2,
	heading(p2, "a", "Orbit table"),
	p3,
	heading(p3, "a", "Pricing", "Seventy-nine dollars."),
	heading(p3, "b", "Features", "A wide orbit view."),
	p4,
	heading(p4, "a", "Further reading"),
	p5,
	heading(p5, "a", "Orbit colors"),
	heading(p5, "b", "Typefaces"),
	p6,
	heading(p6, "a", "Requirements"),
];
assert.equal(records.filter((r) => r.kind === "heading").length, 10);

const searcher = createSearch(minisearchEngine.load(JSON.parse(JSON.stringify(minisearchEngine.build("site", "en", records, settings)))), settings);
const run = (q: Partial<Query> = {}) => searcher.run({ q: "orbit", ...q });
const counts = (list: FacetCount[]) => Object.fromEntries(list.map((c) => [c.value, c.count]));

test("a page with three matching headings counts once", () => {
	const r = run();
	assert.equal(r.total, 5);
	assert.deepEqual(counts(r.types), { docs: 3, themes: 1, learn: 1 });
	assert.deepEqual(counts(r.facets.theme!), { vega: 2, vesper: 1, lodestar: 1 });
	assert.deepEqual(counts(r.facets.kind!), { guide: 3, reference: 1 });
});

test("counts are over all matches, not the first limit", () => {
	const r = run({ limit: 1 });
	assert.equal(r.groups.flatMap((g) => g.items).length, 1);
	assert.equal(r.total, 5);
	assert.deepEqual(counts(r.types), { docs: 3, themes: 1, learn: 1 });
	assert.deepEqual(counts(r.facets.theme!), { vega: 2, vesper: 1, lodestar: 1 });
	assert.deepEqual(counts(r.facets.kind!), { guide: 3, reference: 1 });
	const picked = run({ limit: 1, picks: { theme: ["vega"] } });
	assert.equal(picked.total, 2);
	assert.deepEqual(counts(picked.facets.theme!), { vega: 2, vesper: 1, lodestar: 1 });
	assert.deepEqual(counts(picked.facets.kind!), { guide: 1 });
});

test("picks are OR inside a facet, AND across facets; no value does not match a set facet", () => {
	assert.equal(run({ picks: { theme: ["vega"] } }).total, 2);
	assert.equal(run({ picks: { theme: ["vega", "vesper"] } }).total, 3);
	const both = run({ picks: { theme: ["vega"], kind: ["guide"] } });
	assert.equal(both.total, 1);
	assert.deepEqual(
		both.groups.flatMap((g) => g.items.map((i) => i.page.id)),
		["en:/p1"],
	);
	assert.equal(run({ picks: { theme: [] } }).total, 5);
});

test("a facet's counts ignore its own picks and keep the others (disjunctive)", () => {
	const r = run({ picks: { theme: ["vega"] } });
	assert.deepEqual(counts(r.facets.theme!), { vega: 2, vesper: 1, lodestar: 1 });
	assert.deepEqual(counts(r.facets.kind!), { guide: 1 });
	const k = run({ picks: { kind: ["guide"] } });
	assert.deepEqual(counts(k.facets.kind!), { guide: 3, reference: 1 });
	assert.deepEqual(counts(k.facets.theme!), { vega: 1, lodestar: 1 });
	const both = run({ picks: { theme: ["vega"], kind: ["guide"] } });
	assert.deepEqual(counts(both.facets.theme!), { vega: 1, lodestar: 1 });
	assert.deepEqual(counts(both.facets.kind!), { guide: 1 });
});

test("type counts ignore the type tab and keep the facet picks", () => {
	const r = run({ type: "docs" });
	assert.equal(r.total, 3);
	assert.deepEqual(counts(r.types), { docs: 3, themes: 1, learn: 1 });
	assert.equal(r.types.find((t) => t.value === "docs")?.picked, true);
	assert.deepEqual(counts(r.facets.theme!), { vega: 1, vesper: 1, lodestar: 1 });
	assert.deepEqual(counts(run({ type: "docs", picks: { theme: ["vega"] } }).types), { docs: 1, themes: 1 });
});

test("a surface's types limit the counts and the results", () => {
	const r = run({ types: ["docs"] });
	assert.equal(r.total, 3);
	assert.deepEqual(counts(r.types), { docs: 3 });
	assert.deepEqual(counts(r.facets.theme!), { vega: 1, vesper: 1, lodestar: 1 });
});

test("a picked value with zero matches still shows", () => {
	const r = run({ picks: { theme: ["starter"] } });
	assert.equal(r.total, 0);
	assert.deepEqual(
		r.facets.theme!.find((c) => c.value === "starter"),
		{ value: "starter", label: "starter", count: 0, picked: true },
	);
	assert.equal(r.facets.theme!.find((c) => c.value === "vega")?.picked, false);
});

test("labels come from settings values, else the raw value", () => {
	const r = run();
	assert.equal(r.facets.theme!.find((c) => c.value === "vega")?.label, "Vega");
	assert.equal(r.facets.theme!.find((c) => c.value === "vesper")?.label, "vesper");
	assert.equal(r.types.find((c) => c.value === "docs")?.label, "Docs");
});

test("values follow the settings order, then count, then name", () => {
	assert.deepEqual(
		run().facets.theme!.map((c) => c.value),
		["vega", "lodestar", "vesper"],
	);
	assert.deepEqual(
		run().types.map((c) => c.value),
		["docs", "themes", "learn"],
	);
});
