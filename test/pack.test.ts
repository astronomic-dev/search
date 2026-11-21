import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { pack, unpack, UNPACKED_SOURCE } from "../src/core/pack.ts";
import { minisearchEngine } from "../src/core/minisearch.ts";
import type { IndexSettings, SearchRecord } from "../src/core/types.ts";

const settings: IndexSettings = {
	weights: { title: 3, heading: 2, text: 1, keywords: 1 },
	group: { dialog: "type", page: false },
	groupOrder: "best",
	types: { docs: { label: "Docs" } },
	facets: { theme: { label: "Theme" } },
};

/** The records as unpack gives them: sorted by id, `source` fixed. */
const expected = (records: SearchRecord[]) => [...records].map((r) => ({ ...r, source: UNPACKED_SOURCE })).sort((a, b) => (a.id < b.id ? -1 : 1));
const roundTrip = (records: SearchRecord[], locale = "en") => unpack(JSON.parse(JSON.stringify(pack(records, locale))), locale);

const page = (url: string, extra: Partial<SearchRecord> = {}) =>
	({ id: `en:${url}`, kind: "page", locale: "en", type: "docs", url, title: `Title ${url}`, text: `Text of ${url}`, facets: {}, source: "collection", ...extra }) as SearchRecord;
const heading = (url: string, anchor: string, extra: Partial<SearchRecord> = {}) =>
	({ id: `en:${url}#${anchor}`, kind: "heading", pageId: `en:${url}`, locale: "en", type: "docs", url: `${url}#${anchor}`, title: `Title ${url}`, heading: `Heading ${anchor}`, text: `Section ${anchor}`, facets: {}, source: "html", ...extra }) as SearchRecord;

const records: SearchRecord[] = [
	page("/hook", { facets: { theme: ["a"] } }),
	heading("/hook", "own", { title: "Own title", facets: { theme: ["b"] } }),
	heading("/orphan", "h"),
	page("/docs/a", { facets: { theme: ["vega", "apogee"] }, keywords: ["start", "guide"] }),
	heading("/docs/a", "install", { facets: { theme: ["vega", "apogee"] } }),
	heading("/docs/a", "setup", { facets: { theme: ["vega", "apogee"] }, text: "" }),
	page("/", { text: "", type: "pages" }),
	heading("/", "featured", { type: "pages" }),
	{ id: "en:/dark", kind: "action", locale: "en", type: "docs", url: "/dark", title: "Dark", text: "", facets: {}, source: "hook" },
	{ id: "en:dark-mode", kind: "action", locale: "en", type: "docs", command: "dark", title: "Dark mode", text: "Switch", facets: { theme: ["x"] }, source: "hook" },
];

test("pack then unpack gives the same records: pages, headings, actions with and without url, facets, keywords", () => {
	assert.deepEqual(roundTrip(records), expected(records));
	assert.deepEqual(roundTrip([]), []);
});

test("the packed form keeps page fields once and leaves out derived and empty ones", () => {
	const packed = pack(records, "en");
	assert.equal(packed.pages.length, 5);
	assert.equal(packed.sections.length, 4);
	assert.equal(packed.orphans?.length, 1);
	const a = packed.pages.findIndex((p) => p.url === "/docs/a");
	assert.deepEqual(packed.sections.find((s) => s[1] === "install"), [a, "install", "Heading install", "Section install"]);
	assert.deepEqual(packed.pages.find((p) => p.url === "/"), { url: "/", title: "Title /", type: "pages" });
	assert.deepEqual(packed.pages.find((p) => p.command), { title: "Dark mode", type: "docs", text: "Switch", facets: { theme: ["x"] }, kind: "action", command: "dark", id: "en:dark-mode" });
	assert.doesNotMatch(JSON.stringify({ pages: packed.pages, sections: packed.sections }), /"source"|"pageId"|"locale"/);
	assert.doesNotMatch(JSON.stringify(packed), /"source"/);
});

test("a section that differs from its page keeps the difference", () => {
	const odd = [page("/p", { facets: { theme: ["a"] } }), heading("/p", "h", { title: "Other", type: "learn", facets: { theme: ["b"] }, id: "en:custom" })];
	assert.deepEqual(roundTrip(odd), expected(odd));
});

test("a heading whose page is not in the file is kept whole; a record of another locale fails the pack", () => {
	const orphan = [page("/a"), heading("/gone", "h", { facets: { theme: ["z"] } }), heading("/a", "x")];
	assert.deepEqual(roundTrip(orphan), expected(orphan));
	assert.equal(pack(orphan, "en").orphans?.length, 1);
	assert.throws(() => pack([page("/a")], "de"), /locale en, but this file is de/);
});

// The site fixture stays in this repo; the published copy does not ship it.
const FIXTURE = new URL("./fixtures/astronomic-records.json", import.meta.url);

test("the site fixture round-trips", { skip: !existsSync(FIXTURE) && "no site fixture in this copy" }, () => {
	const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as SearchRecord[];
	const en = fixture.filter((r) => r.locale === "en");
	assert.deepEqual(roundTrip(en), expected(en));
});

test("the engine file holds the packed form; clip data still finds the cut words", () => {
	const long = page("/long", { text: `${"word ".repeat(400)}anchoremulator` }); // the word is only in the cut tail
	const file = minisearchEngine.build("site", "en", [long, heading("/long", "h"), page("/short")], { ...settings, clip: 300 });
	assert.equal(file.schema, 2);
	assert.equal(file.records.pages.length, 2);
	assert.deepEqual(file.data, { more: { "en:/long": "anchoremulator" } });
	const engine = minisearchEngine.load(JSON.parse(JSON.stringify(file)));
	assert.deepEqual(engine.search("anchoremulator").map((h) => h.id), ["en:/long"]);
	assert.equal(engine.records().length, 3);
	assert.equal(engine.record("en:/long#h")?.pageId, "en:/long");
	assert.ok(!engine.record("en:/long")!.text.includes("anchoremulator"));
});

test("the unpacked records keep the order by id that build gives", () => {
	const file = minisearchEngine.build("site", "en", [...records].reverse(), settings);
	assert.deepEqual(minisearchEngine.load(JSON.parse(JSON.stringify(file))).records().map((r) => r.id), records.map((r) => r.id).sort());
});
