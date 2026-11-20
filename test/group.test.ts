import { test } from "node:test";
import assert from "node:assert/strict";
import { groupItems } from "../src/core/group.ts";
import { minisearchEngine } from "../src/core/minisearch.ts";
import { createSearch } from "../src/core/search.ts";
import type { IndexSettings, ResultItem, SearchRecord } from "../src/core/types.ts";

const settings: IndexSettings = {
	weights: { title: 3, heading: 2, text: 1, keywords: 1 },
	group: { dialog: "type", page: false },
	groupOrder: "best",
	types: { docs: { label: "Docs" }, themes: { label: "Themes" }, learn: { label: "Learn" } },
	facets: { theme: { label: "Theme", values: { vega: "Vega" } } },
};

const item = (n: number, type: string, score: number, theme?: string): ResultItem => {
	const page: SearchRecord = { id: `en:/p${n}`, kind: "page", locale: "en", type, url: `/p${n}`, title: `P${n}`, text: "", facets: theme ? { theme: [theme, "z"] } : {}, source: "html" };
	return { page, score, highlight: { title: [], snippet: { text: "", ranges: [] } }, headings: [] };
};
// Already in score order, as search.ts passes them.
const items = [item(1, "docs", 9, "vesper"), item(2, "themes", 8, "vega"), item(3, "learn", 7), item(4, "docs", 6, "vega"), item(5, "themes", 5)];
const shape = (gs: ReturnType<typeof groupItems>) => gs.map((g) => [g.key, g.label, g.items.map((i) => i.page.id.slice(4))]);

test('group "type" puts pages under type labels, best group first', () => {
	assert.deepEqual(shape(groupItems(items, "type", settings)), [
		["docs", "Docs", ["p1", "p4"]],
		["themes", "Themes", ["p2", "p5"]],
		["learn", "Learn", ["p3"]],
	]);
});

test('"best" orders groups by their best page score', () => {
	const later = [item(1, "learn", 10), ...items.slice(1)];
	assert.deepEqual(
		groupItems(later, "type", settings).map((g) => g.key),
		["learn", "themes", "docs"],
	);
});

test("an array fixes the order and appends the rest by best", () => {
	const s = { ...settings, groupOrder: ["learn"] };
	assert.deepEqual(
		groupItems(items, "type", s).map((g) => g.key),
		["learn", "docs", "themes"],
	);
	const all = { ...settings, groupOrder: ["themes", "learn", "docs", "missing"] };
	assert.deepEqual(
		groupItems(items, "type", all).map((g) => g.key),
		["themes", "learn", "docs"],
	);
});

test("false gives one group with key empty", () => {
	assert.deepEqual(shape(groupItems(items, false, settings)), [["", "", ["p1", "p2", "p3", "p4", "p5"]]]);
	assert.deepEqual(groupItems([], false, settings), []);
});

test('a facet groups by its first value; pages with none go last under key ""', () => {
	assert.deepEqual(shape(groupItems(items, "theme", settings)), [
		["vesper", "vesper", ["p1"]],
		["vega", "Vega", ["p2", "p4"]],
		["", "", ["p3", "p5"]],
	]);
	const s = { ...settings, groupOrder: ["vega"] };
	assert.deepEqual(
		groupItems(items, "theme", s).map((g) => g.key),
		["vega", "vesper", ""],
	);
});

test('a real facet value "other" is its own group, not the no-value group', () => {
	const withOther = [item(1, "docs", 9, "other"), item(2, "docs", 8)];
	assert.deepEqual(shape(groupItems(withOther, "theme", settings)), [
		["other", "other", ["p1"]],
		["", "", ["p2"]],
	]);
});

test("a facet named type throws at build", () => {
	const bad: IndexSettings = { ...settings, facets: { type: { label: "Type" } } };
	const good = minisearchEngine.load(minisearchEngine.build("site", "en", [], settings));
	assert.throws(() => createSearch(good, bad), /"type"/);
	assert.throws(() => minisearchEngine.build("site", "en", [], bad), /"type"/);
});
