import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeRecords } from "../src/core/merge.ts";
import type { RecordSource, SearchRecord, SourcedRecord } from "../src/core/types.ts";

const page = (url: string, source: RecordSource, title = "T"): SearchRecord => ({ id: `en:${url}`, kind: "page", locale: "en", type: "docs", url, title, text: `${source} text`, facets: {}, source });
const heading = (url: string, anchor: string, source: RecordSource): SearchRecord => ({
	id: `en:${url}#${anchor}`,
	kind: "heading",
	pageId: `en:${url}`,
	locale: "en",
	type: "docs",
	url: `${url}#${anchor}`,
	title: "T",
	heading: anchor,
	text: `${source} ${anchor}`,
	facets: {},
	source,
});
const s = (record: SearchRecord, origin: string): SourcedRecord => ({ record, origin });

test("a collection page and its headings replace the scanned page and its headings as a whole", () => {
	const out = mergeRecords([
		s(page("/a", "html", "Scanned"), "dist/a.html"),
		s(heading("/a", "one", "html"), "dist/a.html"),
		s(heading("/a", "two", "html"), "dist/a.html"),
		s(heading("/a", "three", "html"), "dist/a.html"),
		s(page("/a", "collection", "Written"), "docs/a.md"),
		s(heading("/a", "one", "collection"), "docs/a.md"),
		s(heading("/a", "two", "collection"), "docs/a.md"),
	]);
	assert.deepEqual(
		out.map((r) => r.id),
		["en:/a", "en:/a#one", "en:/a#two"],
	);
	assert.ok(out.every((r) => r.source === "collection"));
	assert.equal(out[0]?.title, "Written");
	assert.equal(out[0]?.text, "collection text");
});

test("an HTML page with no collection twin stays", () => {
	const out = mergeRecords([s(page("/b", "html"), "dist/b.html"), s(heading("/b", "x", "html"), "dist/b.html"), s(page("/a", "collection"), "docs/a.md")]);
	assert.deepEqual(
		out.map((r) => r.id),
		["en:/a", "en:/b", "en:/b#x"],
	);
});

test("two collection records with the same id fail, naming both origins", () => {
	assert.throws(() => mergeRecords([s(page("/a", "collection"), "docs/a.md"), s(page("/a", "collection"), "docs/a/index.md")]), /docs\/a\.md[\s\S]*docs\/a\/index\.md/);
});

test("two HTML records with the same id fail, naming both origins", () => {
	assert.throws(() => mergeRecords([s(page("/a", "html"), "dist/a.html"), s(page("/a", "html"), "dist/a/index.html")]), /dist\/a\.html[\s\S]*dist\/a\/index\.html/);
});

test("a hook record and a collection record with the same id fail", () => {
	assert.throws(() => mergeRecords([s(page("/a", "collection"), "docs/a.md"), s(page("/a", "hook"), "hook:records")]), /docs\/a\.md[\s\S]*hook:records/);
});

test("a hook page replaces an HTML page like a collection page", () => {
	const out = mergeRecords([s(page("/a", "html"), "dist/a.html"), s(heading("/a", "x", "html"), "dist/a.html"), s(page("/a", "hook"), "hook:records")]);
	assert.deepEqual(
		out.map((r) => [r.id, r.source]),
		[["en:/a", "hook"]],
	);
});

test("records come out sorted by id", () => {
	const out = mergeRecords([s(page("/c", "html"), "c"), s(page("/a", "html"), "a"), s(heading("/a", "z", "html"), "a"), s(page("/b", "collection"), "b")]);
	assert.deepEqual(
		out.map((r) => r.id),
		["en:/a", "en:/a#z", "en:/b", "en:/c"],
	);
});
