import { test } from "node:test";
import assert from "node:assert/strict";
import { minisearchEngine } from "../src/core/minisearch.ts";
import { createSearch } from "../src/core/search.ts";
import type { IndexSettings, SearchRecord } from "../src/core/types.ts";

const settings: IndexSettings = {
	weights: { title: 3, heading: 2, text: 1, keywords: 1 },
	group: { dialog: "type", page: false },
	groupOrder: "best",
	types: { docs: { label: "Docs" }, learn: { label: "Learn" } },
	facets: { theme: { label: "Theme" } },
};

const page = (slug: string, type: string, title: string, text: string, facets: Record<string, string[]> = {}): SearchRecord => ({
	id: `en:/${slug}`,
	kind: "page",
	locale: "en",
	type,
	url: `/${slug}`,
	title,
	text,
	facets,
	source: "collection",
});
const heading = (p: SearchRecord, slug: string, h: string, text = ""): SearchRecord => ({ ...p, id: `${p.id}#${slug}`, kind: "heading", pageId: p.id, url: `${p.url}#${slug}`, heading: h, text }) as SearchRecord;

const a = page("a", "docs", "Comet guide", "An introduction.", { theme: ["vega"] });
const b = page("b", "docs", "Sky", "Look up at night.", { theme: ["vesper"] });
const c = page("c", "learn", "Star map", "Where a comet goes.");
const records = [
	a,
	heading(a, "tails", "Comet tails"),
	heading(a, "setup", "Setup", "Point the comet finder north."),
	heading(a, "notes", "Notes", "Nothing else to add."),
	heading(a, "dust", "Comet dust"),
	heading(a, "path", "Comet path"),
	b,
	heading(b, "watch", "Comet watch"),
	heading(b, "moon", "Moon"),
	c,
];
const engine = minisearchEngine.load(JSON.parse(JSON.stringify(minisearchEngine.build("site", "en", records, settings))));
const searcher = createSearch(engine, settings);
const items = (r: ReturnType<typeof searcher.run>) => r.groups.flatMap((g) => g.items);

test("run returns the full result, grouped by the dialog setting by default", () => {
	const q = { q: "comet" };
	const r = searcher.run(q);
	assert.deepEqual(r.query, q);
	assert.equal(r.total, 3);
	assert.deepEqual(
		r.groups.map((g) => [g.key, g.label]),
		[
			["docs", "Docs"],
			["learn", "Learn"],
		],
	);
	assert.deepEqual(Object.keys(r.facets), ["theme"]);
	assert.equal(searcher.settings, settings);
	assert.deepEqual(searcher.capabilities, minisearchEngine.capabilities);
});

test("headings: only heading or text matches, at most 3 by default, by score", () => {
	const r = searcher.run({ q: "comet", group: false });
	const first = items(r).find((i) => i.page.id === "en:/a")!;
	assert.equal(first.headings.length, 3);
	const slugs = first.headings.map((h) => h.record.url!.split("#")[1]);
	assert.ok(!slugs.includes("notes"), "a title-only heading hit is not listed");
	const scores = first.headings.map((h) => h.score);
	assert.deepEqual(scores, [...scores].sort((x, y) => y - x));
	assert.ok(first.headings.every((h) => h.highlight.heading !== undefined));
	assert.equal(searcher.run({ q: "comet", headingsPerPage: 1 }).groups[0]!.items[0]!.headings.length, 1);
	// "setup" matches only in its text, and the page's own title already answers "comet": it is left out.
	assert.equal(searcher.run({ q: "comet", headingsPerPage: 10 }).groups[0]!.items.find((i) => i.page.id === "en:/a")!.headings.length, 3);
});

test("headings: when the page's own record matches every term and its title, only headings that match in their heading text show", () => {
	const finder = (q: string) => items(searcher.run({ q, group: false, headingsPerPage: 10 })).find((i) => i.page.id === "en:/a")!;
	const slugs = (q: string) => finder(q).headings.map((h) => h.record.url!.split("#")[1]).sort();
	assert.deepEqual(slugs("comet"), ["dust", "path", "tails"]);
	// "finder" is not in the page's own record, so text matches still show.
	assert.deepEqual(slugs("comet finder"), ["dust", "path", "setup", "tails"]);
	// The title does not match "north": the page does not answer alone, so text matches show.
	assert.deepEqual(slugs("north"), ["setup"]);
});

test("a word only near the end of a long section links to that section's heading", () => {
	const p = page("long", "docs", "Guide", "Intro.");
	const h = heading(p, "deep", "Deep part", `${"filler ".repeat(200)}anchoremulator`);
	const e = minisearchEngine.load(JSON.parse(JSON.stringify(minisearchEngine.build("site", "en", [p, h], settings))));
	const [item] = createSearch(e, settings).run({ q: "anchoremulator" }).groups.flatMap((g) => g.items);
	assert.equal(item?.page.id, p.id);
	assert.equal(item?.headings[0]?.record.id, h.id);
	assert.ok(item?.headings[0]?.highlight.snippet.text.includes("anchoremulator"));
});

test("a page found only by its headings is shown, with the best heading's score", () => {
	const hits = engine.search("comet");
	const r = items(searcher.run({ q: "comet", group: false }));
	const bItem = r.find((i) => i.page.id === "en:/b")!;
	assert.ok(!hits.some((h) => h.id === "en:/b"));
	assert.equal(bItem.score, hits.find((h) => h.id === "en:/b#watch")!.score);
	assert.deepEqual(
		bItem.headings.map((h) => h.record.id),
		["en:/b#watch"],
	);
});

test("a page's score is the max of its own and its headings' scores; pages in score order", () => {
	const hits = engine.search("comet");
	const aMax = Math.max(...hits.filter((h) => h.id === "en:/a" || h.id.startsWith("en:/a#")).map((h) => h.score));
	const r = items(searcher.run({ q: "comet", group: false }));
	assert.equal(r.find((i) => i.page.id === "en:/a")!.score, aMax);
	const scores = r.map((i) => i.score);
	assert.deepEqual(scores, [...scores].sort((x, y) => y - x));
});

test("limit cuts pages after counting", () => {
	const r = searcher.run({ q: "comet", limit: 1, group: false });
	assert.equal(items(r).length, 1);
	assert.equal(r.total, 3);
});

test("types limit the surface with no second file", () => {
	const r = searcher.run({ q: "comet", types: ["learn"] });
	assert.equal(r.total, 1);
	assert.deepEqual(
		items(r).map((i) => i.page.id),
		["en:/c"],
	);
});

test("total is unique pages after picks", () => {
	assert.equal(searcher.run({ q: "comet", picks: { theme: ["vega"] } }).total, 1);
	assert.equal(searcher.run({ q: "comet", type: "docs" }).total, 2);
});

test("highlights mark the matched words", () => {
	const r = items(searcher.run({ q: "comet finder", group: false, headingsPerPage: 10 }));
	const aItem = r.find((i) => i.page.id === "en:/a")!;
	assert.deepEqual(aItem.highlight.title, [[0, 5]]);
	const setup = aItem.headings.find((h) => h.record.id === "en:/a#setup")!;
	assert.deepEqual(setup.highlight.heading, []);
	assert.deepEqual(setup.highlight.snippet.ranges, [[10, 15], [16, 22]]);
});

test("an empty query gives an empty result", () => {
	const r = searcher.run({ q: "  " });
	assert.equal(r.total, 0);
	assert.deepEqual(r.groups, []);
	assert.deepEqual(r.types, []);
	assert.deepEqual(r.facets, { theme: [] });
});

// Page-level AND and the fallback: records are sections, so a page's terms may sit in different headings.
const g = page("g", "docs", "Looks guide", "Colors.", { theme: ["vega"] });
const h = page("h", "docs", "Dark corners", "Only one word here.", { theme: ["vega"] });
const k = page("k", "learn", "Dark mode primer", "Why dark mode.", { theme: ["vesper"] });
const m = page("m", "docs", "Moods", "The dark side.", { theme: ["vesper"] });
const andRecords = [g, heading(g, "dark", "Dark colors"), heading(g, "mode", "Mode switch"), h, k, m];
const andSearch = createSearch(minisearchEngine.load(minisearchEngine.build("site", "en", andRecords, settings)), settings);
const ids = (r: ReturnType<typeof searcher.run>) => items(r).map((i) => i.page.id);

test("page-level AND: a page whose terms sit in different headings matches all the terms", () => {
	assert.deepEqual(new Set(ids(andSearch.run({ q: "dark mode", group: false }))), new Set(["en:/g", "en:/k"]));
});

test("the fallback to OR runs after the surface types: AND hits in other types do not hide docs", () => {
	assert.deepEqual(new Set(ids(andSearch.run({ q: "dark mode", types: ["learn", "pages"] }))), new Set(["en:/k"]));
	const docsOnly = createSearch(minisearchEngine.load(minisearchEngine.build("site", "en", [h, k, m], settings)), settings);
	const r = docsOnly.run({ q: "dark mode", types: ["docs"], group: false });
	assert.deepEqual(new Set(ids(r)), new Set(["en:/h", "en:/m"]));
	assert.equal(r.total, 2);
});

test("the fallback to OR runs after the picks, not the type tab", () => {
	const docsOnly = createSearch(minisearchEngine.load(minisearchEngine.build("site", "en", [h, k, m], settings)), settings);
	// AND or OR is decided once for every tab: a learn page has both words, so the docs tab is empty, as its count says.
	assert.deepEqual(ids(docsOnly.run({ q: "dark mode", type: "docs", group: false })), []);
	assert.deepEqual(ids(docsOnly.run({ q: "dark mode", picks: { theme: ["vega"] }, group: false })), ["en:/h"]);
	assert.deepEqual(ids(docsOnly.run({ q: "dark mode", group: false })), ["en:/k"]);
});

test("tab counts agree with each tab's results: AND or OR does not change with the active tab", () => {
	const recs = [page("d", "docs", "Alpha bravo", ""), page("p1", "pages", "Alpha", ""), page("p2", "pages", "Alpha two", "")];
	const s2 = createSearch(minisearchEngine.load(minisearchEngine.build("site", "en", recs, settings)), settings);
	const count = (r: ReturnType<typeof s2.run>, type: string) => r.types.find((t) => t.value === type)?.count ?? 0;
	const all = s2.run({ q: "alpha bravo", group: false });
	const tab = s2.run({ q: "alpha bravo", type: "pages", group: false });
	assert.equal(count(all, "pages"), 0);
	assert.equal(count(tab, "pages"), 0);
	assert.equal(tab.total, 0);
	assert.deepEqual(ids(tab), []);
	assert.equal(count(tab, "docs"), 1);
});

// Synonyms and pinned results.
const docsPage = page("docs-home", "docs", "Documentation", "Every guide on one page.", { theme: ["vega"] });
const install2 = page("install", "docs", "Install", "Run the installer.", { theme: ["vesper"] });
const pricing = page("pricing", "learn", "Plans", "What it costs.", { theme: ["vega"] });
const tour = page("tour", "learn", "A tour", "Start the tour here.");
const tourRecords = [docsPage, heading(docsPage, "install", "Install the guide", "Install notes."), install2, pricing, tour];
const synSettings: IndexSettings = { ...settings, synonyms: [["docs", "documentation", "guide"], ["price", "cost", "plans"]], pinned: { "get started": ["/tour", "/install"], "plans": ["/pricing"] } };
const synSearch = createSearch(minisearchEngine.load(JSON.parse(JSON.stringify(minisearchEngine.build("site", "en", tourRecords, synSettings)))), synSettings);

test("synonyms: a query word in a group also searches the rest of its group", () => {
	assert.equal(minisearchEngine.capabilities.synonyms, true);
	// "docs" is in no record; its group finds "Documentation" (and "guide" in its text).
	assert.deepEqual(ids(synSearch.run({ q: "docs", group: false })), ["en:/docs-home"]);
	// The page-level AND counts a synonym's match for the word it stands for (else it would fall back to OR, and list
	// the install page too).
	assert.deepEqual(ids(synSearch.run({ q: "install docs", group: false })), ["en:/docs-home"]);
	assert.deepEqual(ids(synSearch.run({ q: "price", group: false })), ["en:/pricing"]);
	// Folded: "Dócs" is "docs".
	assert.deepEqual(ids(synSearch.run({ q: "Dócs", group: false })), ["en:/docs-home"]);
	// Without the setting, the same index finds nothing for "price".
	const plain = createSearch(minisearchEngine.load(minisearchEngine.build("site", "en", tourRecords, settings)), settings);
	assert.deepEqual(ids(plain.run({ q: "price", group: false })), []);
});

test("pinned: the whole folded query puts its pages first, in order, even ones the words do not match", () => {
	const r = synSearch.run({ q: "  Get   STARTED ", group: false });
	assert.deepEqual(ids(r).slice(0, 2), ["en:/tour", "en:/install"]);
	assert.equal(r.total, ids(r).length);
	// Only the whole query: "get" alone pins nothing.
	assert.equal(ids(synSearch.run({ q: "get", group: false })).includes("en:/install"), false);
	// A pinned page that also matches is not listed twice.
	const plans = synSearch.run({ q: "plans", group: false });
	assert.deepEqual(ids(plans), ["en:/pricing"]);
	// Grouped by type, the pinned page's group comes first.
	assert.deepEqual(synSearch.run({ q: "get started" }).groups.map((g2) => g2.key)[0], "learn");
});

test("pinned pages pass the surface types, the type tab and the picks like any page", () => {
	assert.deepEqual(ids(synSearch.run({ q: "get started", types: ["docs"], group: false })), ["en:/install"]);
	assert.deepEqual(ids(synSearch.run({ q: "get started", type: "learn", group: false }))[0], "en:/tour");
	assert.equal(ids(synSearch.run({ q: "get started", type: "learn", group: false })).includes("en:/install"), false);
	assert.deepEqual(ids(synSearch.run({ q: "get started", picks: { theme: ["vesper"] }, group: false })), ["en:/install"]);
	assert.deepEqual(ids(synSearch.run({ q: "get started", picks: { theme: ["vega"] }, group: false })), []);
});

test("pinned pages count once in the type and facet counts", () => {
	const r = synSearch.run({ q: "get started", group: false });
	const count = (list: { value: string; count: number }[], v: string) => list.find((x) => x.value === v)?.count ?? 0;
	assert.equal(count(r.types, "learn"), ids(r).filter((id) => ["en:/tour", "en:/pricing"].includes(id)).length);
	assert.equal(count(r.types, "docs"), ids(r).filter((id) => ["en:/install", "en:/docs-home"].includes(id)).length);
	assert.equal(count(r.facets.theme!, "vesper"), 1, "the pinned install page, once");
	// The plans page matches by its words and is pinned: one page, one count.
	const plans = synSearch.run({ q: "plans", group: false });
	assert.equal(count(plans.types, "learn"), 1);
	assert.equal(count(plans.facets.theme!, "vega"), 1);
});

test("pinned and picks: a query or facet that is an Object.prototype name is looked up as an own key only", () => {
	for (const q of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
		assert.doesNotThrow(() => synSearch.run({ q, group: false }), q);
		assert.deepEqual(ids(synSearch.run({ q, group: false })), [], q);
		assert.doesNotThrow(() => synSearch.run({ q: "install", picks: { [q]: ["x"] }, group: false }), q);
		assert.deepEqual(ids(synSearch.run({ q: "install", picks: { [q]: ["x"] }, group: false })), [], q);
	}
	// An own "constructor" pin still works.
	const own: IndexSettings = { ...settings, pinned: JSON.parse('{"constructor":["/tour"],"__proto__":["/install"]}') };
	const s = createSearch(minisearchEngine.load(minisearchEngine.build("site", "en", tourRecords, own)), own);
	assert.deepEqual(ids(s.run({ q: "Constructor", group: false })), ["en:/tour"]);
	assert.deepEqual(ids(s.run({ q: "__proto__", group: false })), ["en:/install"]);
	assert.deepEqual(ids(s.run({ q: "toString", group: false })), []);
});

test("group labels: a facet value that is an Object.prototype name is labeled with its own text", () => {
	const p = page("p", "docs", "Proto page", "Words.", { theme: ["constructor"] });
	const q2 = page("q", "docs", "Proto other", "Words.", { theme: ["toString"] });
	const set: IndexSettings = { ...settings, facets: { theme: { label: "Theme", values: { vega: "Vega" } } } };
	const s = createSearch(minisearchEngine.load(minisearchEngine.build("site", "en", [p, q2], set)), set);
	const r = s.run({ q: "proto", group: "theme" });
	assert.deepEqual(r.groups.map((g2) => g2.label).sort(), ["constructor", "toString"]);
	assert.deepEqual(r.facets.theme!.map((f) => f.label).sort(), ["constructor", "toString"]);
	const t = page("t", "constructor", "Proto typed", "Words.");
	const typed = createSearch(minisearchEngine.load(minisearchEngine.build("site", "en", [t], settings)), settings);
	const rt = typed.run({ q: "proto" });
	assert.deepEqual(rt.groups.map((g2) => g2.label), ["constructor"]);
	assert.deepEqual(rt.types.map((f) => f.label), ["constructor"]);
});

test("highlights mark only exact and prefix matches, not fuzzy ones; fuzzy hits still show", () => {
	const fz = [
		page("code", "docs", "Write code", "Code and more code."),
		page("come", "docs", "Come along", "Come in. Node setup, bottom bar."),
		page("btn", "docs", "Button", "A button sits at the bottom."),
		page("lode", "docs", "Lodestar theme", "Lodestar is a theme."),
	];
	const s = createSearch(minisearchEngine.load(minisearchEngine.build("site", "en", fz, settings)), settings);
	const marks = (q: string, id: string) => {
		const item = items(s.run({ q, group: false })).find((i) => i.page.id === id);
		assert.ok(item, `${q} finds ${id}`);
		return { title: item.highlight.title, snippet: item.highlight.snippet };
	};
	// "code" fuzzily finds "Come" and "Node": the page shows, nothing is marked.
	assert.deepEqual(marks("code", "en:/come"), { title: [], snippet: { text: "Come in. Node setup, bottom bar.", ranges: [] } });
	assert.deepEqual(marks("code", "en:/code").title, [[6, 10]]);
	// "button" marks "button", not "bottom".
	assert.deepEqual(marks("button", "en:/btn").snippet.ranges, [[2, 8]]);
	// A prefix marks the word it starts.
	assert.deepEqual(marks("lodes", "en:/lode").title, [[0, 8]]);
	// A typo that is not a prefix finds the page with no mark.
	assert.deepEqual(marks("lodestr", "en:/lode").title, []);
});
