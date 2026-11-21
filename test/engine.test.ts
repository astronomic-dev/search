import { test } from "node:test";
import assert from "node:assert/strict";
import { createMinisearchEngine, minisearchEngine } from "../src/core/minisearch.ts";
import { unpack } from "../src/core/pack.ts";
import { highlight } from "../src/core/highlight.ts";
import { foldText } from "../src/core/text.ts";
import type { IndexSettings, SearchRecord } from "../src/core/types.ts";

const settings: IndexSettings = {
	weights: { title: 3, heading: 2, text: 1, keywords: 1 },
	group: { dialog: "type", page: false },
	groupOrder: "best",
	types: { docs: { label: "Docs" } },
	facets: {},
};

const rec = (id: string, title: string, text = "", extra: Partial<SearchRecord> = {}): SearchRecord => ({
	id: `en:${id}`,
	kind: "page",
	locale: "en",
	type: "docs",
	url: id,
	title,
	text,
	facets: {},
	source: "collection",
	...extra,
}) as SearchRecord;

const records = [
	rec("/poets", "Tennyson", "Poems of the Victorian age."),
	rec("/agency", "Northwind", "A theme for agencies."),
	rec("/food", "Café menu", "Coffee and cake."),
	rec("/bistro", "Bistro", "Our cafe serves lunch."),
	rec("/red", "Red apples", "Fresh fruit."),
	rec("/green", "Green pears", "Ripe fruit."),
	rec("/a-title", "Zenith guide", "A short page."),
	rec("/b-text", "Another page", "Read about the zenith here, and more words to pad the text out a little."),
];

const load = (s = settings, r = records) => minisearchEngine.load(JSON.parse(JSON.stringify(minisearchEngine.build("site", "en", r, s))));
const ids = (hits: { id: string }[]) => hits.map((h) => h.id);

test("capabilities", () => {
	assert.deepEqual(minisearchEngine.capabilities, { fuzzy: true, prefix: true, facets: true, highlights: true, synonyms: true });
	assert.equal(minisearchEngine.name, "minisearch");
});

test("build then load round-trips through JSON, records sorted by id", () => {
	const file = minisearchEngine.build("site", "en", [...records].reverse(), settings);
	assert.equal(file.schema, 2);
	assert.equal(file.index, "site");
	assert.equal(file.locale, "en");
	assert.equal(file.engine, "minisearch");
	assert.deepEqual(
		unpack(file.records, "en").map((r) => r.id),
		records.map((r) => r.id).sort(),
	);
	assert.equal(JSON.stringify(file), JSON.stringify(minisearchEngine.build("site", "en", records, settings)));
	const engine = load();
	assert.equal(engine.records().length, records.length);
	assert.equal(engine.record("en:/poets")?.title, "Tennyson");
});

test("long text: kept whole by default, every word found, the snippet marks a word near the end", () => {
	const text = `${"word ".repeat(400)}anchoremulator end`;
	const file = minisearchEngine.build("site", "en", [rec("/long", "Long", text)], settings);
	assert.equal(file.records.pages[0]!.text, text);
	assert.equal(file.data, undefined);
	const engine = minisearchEngine.load(JSON.parse(JSON.stringify(file)));
	const hit = engine.search("anchoremulator")[0]!;
	assert.equal(hit.id, "en:/long");
	const h = highlight(engine.record(hit.id)!, hit.terms);
	assert.ok(h.snippet.text.includes("anchoremulator"));
	assert.equal(h.snippet.ranges.length, 1);
});

test("clip cuts the kept text on a word boundary; the words past it stay searchable, new ones once each", () => {
	const clipped = { ...settings, clip: 1000 };
	const long = rec("/long", "Long", `${"word ".repeat(400)}anchoremulator Word café anchoremulator`);
	const file = minisearchEngine.build("site", "en", [long, rec("/short", "Short", "anchor")], clipped);
	assert.ok(file.records.pages[0]!.text!.length <= 1001);
	assert.ok(file.records.pages[0]!.text!.endsWith("word…"));
	assert.deepEqual(file.data, { more: { "en:/long": "anchoremulator cafe" } });
	const engine = minisearchEngine.load(JSON.parse(JSON.stringify(file)));
	assert.deepEqual(ids(engine.search("anchoremulator")), ["en:/long"]);
	assert.ok(ids(engine.search("cafe")).includes("en:/long"));
});

test("a very long word across the cut is found, with clip and without", () => {
	const word = "x".repeat(586) + "anchoremulator"; // chars 501-1100: across 1,000 and across a 600 clip
	const text = `${"a".repeat(500)} ${word} tail`;
	for (const s of [settings, { ...settings, clip: 600 }]) {
		const engine = minisearchEngine.load(JSON.parse(JSON.stringify(minisearchEngine.build("site", "en", [rec("/w", "W", text)], s))));
		assert.deepEqual(ids(engine.search(word)), ["en:/w"], String(s.clip));
	}
});

test("form B finds the words past the first 1,000 characters too", () => {
	const b = createMinisearchEngine("B");
	const file = b.build("site", "en", [rec("/long", "Long", `${"word ".repeat(400)}anchoremulator`)], settings);
	assert.deepEqual(ids(b.load(JSON.parse(JSON.stringify(file))).search("anchoremulator")), ["en:/long"]);
});

test("prefix: ten finds Tennyson", () => {
	assert.equal(load().search("ten")[0]?.id, "en:/poets");
});

test("fuzzy: nortwind finds Northwind", () => {
	assert.equal(load().search("nortwind")[0]?.id, "en:/agency");
});

test("accents fold both ways", () => {
	const e = load();
	assert.ok(ids(e.search("café")).includes("en:/bistro"));
	assert.ok(ids(e.search("cafe")).includes("en:/food"));
});

test("the engine returns OR hits, each with the query terms it matched (search.ts does the page-level AND)", () => {
	const e = load();
	const hits = e.search("red fruit");
	assert.deepEqual(new Set(ids(hits)), new Set(["en:/red", "en:/green"]));
	assert.deepEqual(hits.find((h) => h.id === "en:/red")!.queryTerms.sort(), ["fruit", "red"]);
	assert.deepEqual(hits.find((h) => h.id === "en:/green")!.queryTerms, ["fruit"]);
});

test("terms: the query as the engine tokenizes and folds it, deduped", () => {
	const e = load();
	assert.deepEqual(e.terms("Café, menu café"), ["cafe", "menu"]);
	assert.deepEqual(e.terms("  "), []);
});

test("an empty or whitespace query returns nothing", () => {
	const e = load();
	assert.deepEqual(e.search(""), []);
	assert.deepEqual(e.search("   \n"), []);
});

test("each hit has terms and match", () => {
	const [hit] = load().search("tennyson");
	assert.deepEqual(hit!.terms, ["tennyson"]);
	assert.deepEqual(hit!.match, { tennyson: ["title"] });
});

test("weights from settings change the order", () => {
	assert.deepEqual(ids(load().search("zenith")), ["en:/a-title", "en:/b-text"]);
	const low = { ...settings, weights: { ...settings.weights, title: 0.1 } };
	assert.deepEqual(ids(load(low).search("zenith")), ["en:/b-text", "en:/a-title"]);
});

test("a type weight multiplies the score of that type's records", () => {
	const two = [rec("/x", "Comet", "", { type: "docs" }), rec("/y", "Comet", "", { type: "themes" })];
	const base = load(settings, two).search("comet");
	assert.ok(Math.abs(base[0]!.score - base[1]!.score) < 1e-9);
	const s = { ...settings, types: { docs: { label: "Docs" }, themes: { label: "Themes", weight: 2 } } };
	const hits = load(s, two).search("comet");
	assert.equal(hits[0]!.id, "en:/y");
	assert.ok(Math.abs(hits[0]!.score - 2 * hits[1]!.score) < 1e-9);
});

test("facet values are searchable words", () => {
	const r = [rec("/looks", "Looks", "Colors and fonts.", { facets: { theme: ["lodestar"] } })];
	assert.equal(load(settings, r).search("lodestar")[0]?.id, "en:/looks");
});

test("a facet named type throws at build", () => {
	const bad = { ...settings, facets: { type: { label: "Type" } } };
	assert.throws(() => minisearchEngine.build("site", "en", records, bad), /type/);
});

test("highlight: title and heading ranges where a folded word starts with a term", () => {
	const r = rec("/x#h", "Café Guide", "", { kind: "heading", heading: "Dark mode, darker", pageId: "en:/x" });
	const h = highlight(r, ["cafe", "dark"], { snippet: 160 });
	assert.deepEqual(h.title, [[0, 4]]);
	assert.deepEqual(h.heading, [
		[0, 4],
		[11, 15],
	]);
});

test("highlight: whole-word folding (a final sigma)", () => {
	const r = rec("/g", "ΟΔΟΣ map", "");
	assert.deepEqual(highlight(r, [foldText("ΟΔΟΣ")]).title, [[0, 4]]);
});

test("highlight: no heading key on a page", () => {
	assert.equal(highlight(rec("/p", "Page"), ["page"]).heading, undefined);
});

test("highlight: a snippet window around the first matched word, with ellipses and ranges", () => {
	const words = Array.from({ length: 80 }, (_, i) => `w${i}`);
	words[40] = "Orbit";
	words[42] = "orbits";
	const text = words.join(" ");
	const h = highlight(rec("/p", "Page", text), ["orbit"], { snippet: 60 });
	const s = h.snippet;
	assert.ok(s.text.startsWith("…") && s.text.endsWith("…"));
	assert.ok(s.text.length <= 62, `length ${s.text.length}`);
	assert.ok(text.includes(s.text.slice(1, -1).trim()), "a slice of the text");
	assert.ok(s.text.slice(1, -1).trim().split(" ").every((w) => words.includes(w)), "cut on word boundaries");
	assert.equal(s.ranges.length, 2);
	for (const [a, b] of s.ranges) assert.equal(s.text.slice(a, b).toLowerCase(), "orbit");
	assert.ok(s.ranges[0]![0] < s.ranges[1]![0]);
});

test("highlight: text with no match gives its start, and short text has no ellipses", () => {
	assert.deepEqual(highlight(rec("/p", "Page", "Short text here."), ["zzz"]).snippet, { text: "Short text here.", ranges: [] });
	const long = "alpha ".repeat(60).trim();
	const s = highlight(rec("/p", "Page", long), ["zzz"], { snippet: 40 }).snippet;
	assert.ok(s.text.startsWith("alpha") && s.text.endsWith("…"));
	assert.ok(s.text.length <= 41);
});

test("highlight: ranges never overlap and are sorted", () => {
	const h = highlight(rec("/p", "Lodestar lodestars", ""), ["lode", "lodestar", "lodestars"]);
	assert.deepEqual(h.title, [
		[0, 8],
		[9, 18],
	]);
});

test("highlight: ASCII and folded words mark alike, whatever their first letter is before folding", () => {
	const r = rec("/p", "Éclair eclair ECLAIR Œuvre ﬁne fine", "x");
	assert.deepEqual(highlight(r, ["ecl", "fi"]).title, [[0, 3], [7, 10], [14, 17], [31, 33]]);
	assert.deepEqual(highlight(r, ["zzz"]).title, []);
});

test("owner keywords are indexed with the facet values: start finds Lodestar only when its keywords say so", () => {
	const lodestar = rec("/lodestar", "Lodestar", "A docs theme.", { facets: { theme: ["Docs"] } });
	const without = load(settings, [...records, lodestar]);
	assert.ok(!ids(without.search("start")).includes("en:/lodestar"));
	assert.ok(ids(without.search("docs")).includes("en:/lodestar"));
	const withKw = load(settings, [...records, { ...lodestar, keywords: ["start", "guide"] } as SearchRecord]);
	const hit = withKw.search("start").find((h) => h.id === "en:/lodestar");
	assert.ok(hit);
	assert.deepEqual(hit.match, { start: ["keywords"] });
	assert.ok(ids(withKw.search("docs")).includes("en:/lodestar"), "facet values stay in the keywords field");
});
