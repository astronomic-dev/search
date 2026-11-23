import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, type HistoryState } from "../src/page/history.ts";

const wp = { query: "s", prefix: "z_" };
const state = (query: string, picks: Record<string, string[]> = {}, type: string | null = null): HistoryState => ({ query, type, picks });

test("history: the first mount marks the original entry; a later mount on a marked entry does not", () => {
	const h = createHistory({ search: "?s=vega", mark: undefined, names: wp });
	assert.deepEqual(h.start(), [{ op: "replace", search: "?s=vega", pretty: false }]);
	assert.deepEqual(createHistory({ search: "?s=vega", mark: false, names: wp }).start(), []);
});

test("history: a change replaces the entry only when the URL differs", () => {
	const h = createHistory({ search: "?s=vega", mark: false, names: wp });
	assert.deepEqual(h.changed(state("vega")), []);
	assert.deepEqual(h.changed(state("vegas")), [{ op: "replace", search: "?s=vegas", pretty: false }]);
	assert.deepEqual(h.changed(state("vegas")), []);
});

test("history: a submit puts the last committed URL back on the entry, then pushes the new one", () => {
	const h = createHistory({ search: "?s=vega", mark: false, names: wp });
	h.changed(state("docs"));
	assert.deepEqual(h.submitted(state("docs")), [
		{ op: "replace", search: "?s=vega", pretty: false },
		{ op: "push", search: "?s=docs", pretty: false },
	]);
	// Submitting the same search again adds nothing.
	assert.deepEqual(h.submitted(state("docs")), []);
});

test("history: an encoded URL is rebased to the page's spelling, so the same search adds no entry", () => {
	const h = createHistory({ search: "?s=dark%20mode", mark: false, names: wp });
	const first = h.changed(state("dark mode"));
	assert.deepEqual(first, [{ op: "replace", search: "?s=dark+mode", pretty: false }]);
	h.rebase("?s=dark+mode");
	assert.deepEqual(h.submitted(state("dark mode")), []);
});

test("history: Back restores the entry's query and takes its URL as the committed one", () => {
	const h = createHistory({ search: "?s=docs", mark: false, names: wp });
	h.popped("?s=vega%20theme", false);
	assert.equal(h.query(), "vega theme");
	assert.deepEqual(h.changed(state("vega theme")), [{ op: "replace", search: "?s=vega+theme", pretty: false }]);
	h.rebase("?s=vega+theme");
	assert.deepEqual(h.submitted(state("vega theme")), []);
	// Back to the original pretty entry: the server's query applies again.
	const p = createHistory({ search: "?s=x", mark: false, serverQuery: "foo", names: wp });
	p.popped("", true);
	assert.equal(p.pretty, true);
	assert.equal(p.query(), "foo");
});

test("history: a pretty entry keeps the server's query out of its URL until the box is cleared", () => {
	const h = createHistory({ search: "", mark: undefined, serverQuery: "foo", names: wp });
	assert.equal(h.pretty, true);
	assert.equal(h.query(), "foo");
	assert.deepEqual(h.start(), [{ op: "replace", search: "", pretty: true }]);
	assert.deepEqual(h.changed(state("foo")), []);
	assert.deepEqual(h.changed(state("foo", {}, "docs")), [{ op: "replace", search: "?z_type=docs", pretty: true }]);
	// Clearing the box ends the server's query on this entry, even when the URL stays the same.
	assert.deepEqual(h.changed(state("", {}, "docs")), [{ op: "replace", search: "?z_type=docs", pretty: false }]);
	assert.equal(h.pretty, false);
	assert.equal(h.query(), "");
	assert.deepEqual(h.changed(state("foo", {}, "docs")), [{ op: "replace", search: "?s=foo&z_type=docs", pretty: false }]);
});

test("history: a submit from a pretty entry puts it back pretty and pushes an explicit URL", () => {
	const h = createHistory({ search: "", mark: true, serverQuery: "foo", names: wp });
	// Submitting the server's query as it is adds nothing.
	assert.deepEqual(h.submitted(state("foo")), []);
	h.changed(state("bar"));
	assert.deepEqual(h.submitted(state("bar")), [
		{ op: "replace", search: "", pretty: true },
		{ op: "push", search: "?s=bar", pretty: false },
	]);
	assert.equal(h.pretty, false);
});

test("history: an explicit query parameter is never pretty, and a later mount reads the marker", () => {
	assert.equal(createHistory({ search: "?s=foo", mark: undefined, serverQuery: "foo", names: wp }).pretty, false);
	assert.equal(createHistory({ search: "", mark: false, serverQuery: "foo", names: wp }).pretty, false);
	assert.equal(createHistory({ search: "", mark: false, serverQuery: "foo", names: wp }).query(), "");
});

test("history: the URL's picks apply on the first load only, so a Retry keeps the visitor's picks", () => {
	const h = createHistory({ search: "?s=vega&z_theme=vega&z_campaign=x", mark: false, names: wp });
	assert.deepEqual({ ...h.firstPicks(["theme"]) }, { theme: ["vega"] });
	assert.equal(h.firstPicks(["theme"]), null);
});

test("history: URLs keep the index, the facets the loaded index declares and other parameters", () => {
	let facets: string[] = [];
	const h = createHistory({ search: "?s=a&z_index=main&tag=t", mark: false, names: wp, index: "main", facets: () => facets });
	facets = ["theme"];
	assert.deepEqual(h.changed(state("a", { theme: ["vega"] })), [{ op: "replace", search: "?s=a&z_index=main&z_theme=vega&tag=t", pretty: false }]);
});

test("history: URL writes keep a parameter a host script changed after the mount, and the committed search stays", () => {
	const h = createHistory({ search: "?s=vega", mark: false, names: wp });
	// A host replaced the URL with its own parameter; the page's state is unchanged.
	assert.deepEqual(h.changed(state("vega"), "?s=vega&tab=2"), []);
	assert.deepEqual(h.changed(state("docs"), "?s=vega&tab=2"), [{ op: "replace", search: "?s=docs&tab=2", pretty: false }]);
	// The submit puts back the last committed search, then pushes the new one, both with the host's parameter.
	assert.deepEqual(h.submitted(state("docs"), "?s=docs&tab=2"), [
		{ op: "replace", search: "?s=vega&tab=2", pretty: false },
		{ op: "push", search: "?s=docs&tab=2", pretty: false },
	]);
});

test("history: a host parameter change alone is no new search, and putting the committed search back keeps the host's parameters", () => {
	const h = createHistory({ search: "?s=vega&tab=1", mark: false, names: wp });
	assert.deepEqual(h.submitted(state("vega"), "?s=vega&tab=2"), []);
	h.changed(state("docs"), "?s=vega&tab=2");
	assert.deepEqual(h.submitted(state("docs"), "?s=docs&tab=2"), [
		{ op: "replace", search: "?s=vega&tab=2", pretty: false },
		{ op: "push", search: "?s=docs&tab=2", pretty: false },
	]);
});
