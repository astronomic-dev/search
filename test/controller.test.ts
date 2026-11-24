import { test } from "node:test";
import assert from "node:assert/strict";
import { createController, type ControllerOptions } from "../src/controller/index.ts";
import type { Capabilities, IndexSettings, Query, SearchRecord, SearchResult, Searcher } from "../src/core/types.ts";

const settings: IndexSettings = {
	weights: { title: 3, heading: 2, text: 1, keywords: 1 },
	group: { dialog: "type", page: false },
	groupOrder: "best",
	types: { docs: { label: "Docs" }, learn: { label: "Learn" } },
	facets: { theme: { label: "Theme" } },
};

function rec(id: string, kind: SearchRecord["kind"] = "page", extra: Partial<SearchRecord> = {}): SearchRecord {
	return { id, kind, locale: "en", type: "docs", url: `/${id}`, title: id, text: "", facets: {}, source: "collection", ...extra } as SearchRecord;
}

const hl = { title: [], snippet: { text: "", ranges: [] } };

/** A stub Searcher: returns `count` pages (each with one heading) for any query; "none" finds nothing. */
function stub(caps: Partial<Capabilities> = {}) {
	const calls: Query[] = [];
	const searcher: Searcher = {
		capabilities: { fuzzy: true, prefix: true, facets: true, highlights: true, ...caps },
		settings,
		run(query: Query): SearchResult {
			calls.push(query);
			const n = query.q === "none" ? 0 : query.q === "one" ? 1 : query.q === "many" ? 12 : 2;
			const items = Array.from({ length: n }, (_, i) => ({
				page: rec(`p${i}`),
				score: 10 - i,
				highlight: hl,
				headings: i < 2 ? [{ record: rec(`p${i}#h`, "heading", { pageId: `p${i}`, url: `/p${i}#h` }), score: 1, highlight: hl }] : [],
			}));
			const groups = n === 0 ? [] : [{ key: "docs", label: "Docs", items: items.slice(0, 1) }, ...(n > 1 ? [{ key: "learn", label: "Learn", items: items.slice(1) }] : [])];
			return { query, total: n, groups, types: [], facets: {} };
		},
	};
	return { searcher, calls };
}

function make(opts: Partial<ControllerOptions> = {}, caps?: Partial<Capabilities>) {
	const s = stub(caps);
	let loads = 0;
	let fail = false;
	let release: () => void = () => {};
	let gate: Promise<void> | null = null;
	const c = createController({
		index: "site",
		surface: "dialog",
		storage: null,
		load: async () => {
			loads++;
			if (gate) await gate;
			if (fail) throw new Error("nope");
			return s.searcher;
		},
		...opts,
	});
	return {
		c,
		s,
		get loads() {
			return loads;
		},
		setFail(v: boolean) {
			fail = v;
		},
		hold() {
			gate = new Promise((r) => (release = r));
		},
		release() {
			gate = null;
			release();
		},
	};
}

async function ready(c: ReturnType<typeof make>["c"]) {
	await c.preload();
}

test("open starts the load: loading, then ready; a query typed while loading runs when ready", async () => {
	const t = make();
	t.hold();
	t.c.open();
	assert.equal(t.c.getState().open, true);
	assert.equal(t.c.getState().status, "loading");
	t.c.input("abc");
	assert.equal(t.c.getState().result, null);
	assert.equal(t.c.getState().announce, "");
	t.release();
	await ready(t.c);
	const s = t.c.getState();
	assert.equal(s.status, "ready");
	assert.equal(s.result?.query.q, "abc");
	assert.equal(s.options.length, 4);
	assert.equal(s.capabilities?.facets, true);
});

test("a failed load gives error and preload rejects; retry loads again", async () => {
	const t = make();
	t.setFail(true);
	t.c.open();
	await assert.rejects(t.c.preload());
	assert.equal(t.c.getState().status, "error");
	t.setFail(false);
	t.c.retry();
	assert.equal(t.c.getState().status, "loading");
	await ready(t.c);
	assert.equal(t.c.getState().status, "ready");
	assert.equal(t.loads, 2);
});

test("open after a failed load starts a new load", async () => {
	const t = make();
	t.setFail(true);
	t.c.open();
	await assert.rejects(t.c.preload());
	t.c.close();
	t.setFail(false);
	t.c.open();
	assert.equal(t.c.getState().status, "loading");
	await ready(t.c);
	assert.equal(t.c.getState().status, "ready");
	assert.equal(t.loads, 2);
});

test("input before open or preload starts the load and runs when ready", async () => {
	const t = make({ surface: "page" });
	t.c.input("abc");
	assert.equal(t.c.getState().status, "loading");
	await ready(t.c);
	assert.equal(t.c.getState().result?.query.q, "abc");
	assert.equal(t.loads, 1);
});

test("load is called once for many opens", async () => {
	const t = make();
	t.c.open();
	t.c.close();
	t.c.open();
	t.c.toggle();
	t.c.toggle();
	await ready(t.c);
	await t.c.preload();
	assert.equal(t.loads, 1);
	assert.equal(t.c.getState().open, true);
});

test("while composing, input stores the query and runs no search; compositionEnd runs it", async () => {
	const t = make();
	t.c.open();
	await ready(t.c);
	t.c.compositionStart();
	assert.equal(t.c.getState().composing, true);
	t.c.input("か");
	assert.equal(t.c.getState().query, "か");
	assert.equal(t.s.calls.length, 0);
	t.c.compositionEnd("漢字");
	assert.equal(t.c.getState().composing, false);
	assert.equal(t.s.calls.length, 1);
	assert.equal(t.s.calls[0]!.q, "漢字");
});

test("a new result sets active to 0, or -1 with no options; move wraps; moveTo", async () => {
	const t = make();
	t.c.open();
	await ready(t.c);
	t.c.input("x");
	assert.equal(t.c.getState().active, 0);
	t.c.move(-1);
	assert.equal(t.c.getState().active, 3);
	t.c.move(1);
	assert.equal(t.c.getState().active, 0);
	t.c.moveTo("last");
	assert.equal(t.c.getState().active, 3);
	t.c.moveTo("first");
	assert.equal(t.c.getState().active, 0);
	t.c.moveTo(2);
	assert.equal(t.c.getState().active, 2);
	t.c.moveTo(99);
	assert.equal(t.c.getState().active, 3);
	t.c.input("none");
	assert.equal(t.c.getState().active, -1);
	t.c.move(1);
	assert.equal(t.c.getState().active, -1);
});

test("options follow groups order: page, its headings, next page", async () => {
	const t = make();
	t.c.open();
	await ready(t.c);
	t.c.input("x");
	assert.deepEqual(
		t.c.getState().options.map((o) => [o.id, o.kind, o.url]),
		[
			["p0", "page", "/p0"],
			["p0#h", "heading", "/p0#h"],
			["p1", "page", "/p1"],
			["p1#h", "heading", "/p1#h"],
		],
	);
});

test("the search sends the surface's types, group and the dialog limit", async () => {
	const t = make({ types: ["docs"] });
	t.c.open();
	await ready(t.c);
	t.c.input("x");
	const q = t.s.calls[0]!;
	assert.deepEqual(q.types, ["docs"]);
	assert.equal(q.group, "type");
	assert.equal(q.limit, 20);
	const p = make({ surface: "page" });
	await p.c.preload();
	p.c.input("x");
	assert.equal(p.s.calls[0]!.group, false);
});

test("escape clears the text first, then closes", async () => {
	const t = make();
	t.c.open();
	await ready(t.c);
	t.c.input("x");
	assert.equal(t.c.escape(), "cleared");
	const s = t.c.getState();
	assert.equal(s.query, "");
	assert.equal(s.result, null);
	assert.deepEqual(s.options, []);
	assert.equal(s.active, -1);
	assert.equal(s.open, true);
	assert.equal(t.c.escape(), "closed");
	assert.equal(t.c.getState().open, false);
});

test("activate saves the trimmed query first in recent, no duplicates, at most recentMax", async () => {
	const store = new Map<string, string>();
	const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
	const t = make({ storage, recentMax: 3 });
	t.c.open();
	await ready(t.c);
	for (const q of [" a ", "b", "c", "a", "d"]) {
		t.c.input(q);
		t.c.activate();
	}
	assert.deepEqual(t.c.getState().recent, ["d", "a", "c"]);
	// Read back by a new controller on the same storage.
	const u = make({ storage, recentMax: 3 });
	assert.deepEqual(u.c.getState().recent, ["d", "a", "c"]);
	// activate returns the active option.
	t.c.input("x");
	t.c.move(1);
	assert.equal(t.c.activate()?.id, "p0#h");
	t.c.input("none");
	assert.equal(t.c.activate(), null);
});

test("a storage that throws on every call breaks nothing", async () => {
	const storage = {
		getItem(): string | null {
			throw new Error("blocked");
		},
		setItem(): void {
			throw new Error("blocked");
		},
	};
	const t = make({ storage });
	assert.deepEqual(t.c.getState().recent, []);
	t.c.open();
	await ready(t.c);
	t.c.input("hello");
	assert.equal(t.c.activate()?.id, "p0");
	assert.deepEqual(t.c.getState().recent, ["hello"]);
});

test("bad JSON in storage gives no recent searches", () => {
	const storage = { getItem: () => "{oops", setItem: () => {} };
	const t = make({ storage });
	assert.deepEqual(t.c.getState().recent, []);
});

test("setType and togglePick search again and keep the query; searchAllTypes clears both", async () => {
	const t = make();
	t.c.open();
	await ready(t.c);
	t.c.input("x");
	t.c.setType("learn");
	assert.equal(t.s.calls.at(-1)!.type, "learn");
	assert.equal(t.s.calls.at(-1)!.q, "x");
	t.c.togglePick("theme", "vega");
	t.c.togglePick("theme", "vesper");
	assert.deepEqual(t.s.calls.at(-1)!.picks, { theme: ["vega", "vesper"] });
	t.c.togglePick("theme", "vega");
	assert.deepEqual(t.c.getState().picks, { theme: ["vesper"] });
	t.c.togglePick("theme", "vesper");
	assert.deepEqual(t.c.getState().picks, {});
	t.c.togglePick("theme", "vega");
	t.c.searchAllTypes();
	const s = t.c.getState();
	assert.equal(s.type, null);
	assert.deepEqual(s.picks, {});
	assert.equal(s.query, "x");
	assert.equal(t.s.calls.at(-1)!.type, null);
	assert.equal(t.s.calls.length, 8);
});

test("announce: No results, 1 result, 12 results; empty while loading and for an empty box", async () => {
	const t = make();
	t.hold();
	t.c.open();
	t.c.input("many");
	assert.equal(t.c.getState().announce, "");
	t.release();
	await ready(t.c);
	assert.equal(t.c.getState().announce, "12 results");
	t.c.input("one");
	assert.equal(t.c.getState().announce, "1 result");
	t.c.input("none");
	assert.equal(t.c.getState().announce, "No results");
	t.c.input("  ");
	assert.equal(t.c.getState().announce, "");
	assert.equal(t.c.getState().result, null);
});

test("strings replace the defaults, results deep-merged", async () => {
	const t = make({ strings: { results: { zero: "Nada", one: "Uno", other: "{count} hits" } } });
	await t.c.preload();
	t.c.input("many");
	assert.equal(t.c.getState().announce, "12 hits");
});

test("a facet pick is ignored, with one dev warning, when facets are not supported", async () => {
	const warn = console.warn;
	const seen: unknown[][] = [];
	console.warn = (...a: unknown[]) => void seen.push(a);
	try {
		const t = make({ dev: true }, { facets: false });
		t.c.open();
		await ready(t.c);
		t.c.input("x");
		const before = t.s.calls.length;
		t.c.togglePick("theme", "vega");
		t.c.togglePick("theme", "vesper");
		assert.deepEqual(t.c.getState().picks, {});
		assert.equal(t.s.calls.length, before);
		assert.equal(seen.length, 1);
		assert.match(String(seen[0]![0]), /facets/);
		// Not in dev: no warning.
		const u = make({}, { facets: false });
		await u.c.preload();
		u.c.togglePick("theme", "vega");
		assert.equal(seen.length, 1);
	} finally {
		console.warn = warn;
	}
});

test("subscribers get one call per command", async () => {
	const t = make();
	let n = 0;
	const off = t.c.subscribe(() => n++);
	t.hold();
	t.c.open();
	assert.equal(n, 1);
	t.c.input("x");
	assert.equal(n, 2);
	t.release();
	await ready(t.c);
	assert.equal(n, 3); // the load finishing (and running the waiting query) is one update
	t.c.setType("docs");
	t.c.togglePick("theme", "a");
	t.c.move(1);
	t.c.activate();
	t.c.escape();
	assert.equal(n, 8);
	off();
	t.c.close();
	assert.equal(n, 8);
});

test("a searcher that throws gives error, not a crash", async () => {
	const t = make();
	await t.c.preload();
	t.s.searcher.run = () => {
		throw new Error("boom");
	};
	const err = console.error;
	console.error = () => {};
	try {
		t.c.input("x");
	} finally {
		console.error = err;
	}
	assert.equal(t.c.getState().status, "error");
});

test("strings: the new-tab notice has a default, and a site can replace it", async () => {
	const { mergeStrings } = await import("../src/controller/strings.ts");
	assert.equal(mergeStrings().newTab, "Links open in a new tab");
	assert.equal(mergeStrings({ newTab: "Opens in a new tab" }).newTab, "Opens in a new tab");
});

test("suggested links: options in an empty box once loaded, none active; arrows reach them; a query replaces them", async () => {
	const base = stub().searcher;
	const suggested = [{ label: "Start here", href: "/docs/start" }, { label: "Pricing", href: "/pricing", type: "pages" }];
	const searcher: Searcher = { ...base, settings: { ...settings, suggested }, run: base.run };
	const c = createController({ index: "site", surface: "dialog", storage: null, load: async () => searcher });
	assert.deepEqual(c.getState().options, []);
	c.open();
	await c.preload();
	const want = [
		{ id: "suggested:0", kind: "suggested", url: "/docs/start", label: "Start here" },
		{ id: "suggested:1", kind: "suggested", url: "/pricing", label: "Pricing", type: "pages" },
	];
	assert.deepEqual(c.getState().options, want);
	assert.equal(c.getState().active, -1);
	assert.equal(c.getState().result, null);
	c.move(1);
	assert.equal(c.getState().active, 0);
	assert.deepEqual(c.activate(), want[0]);
	assert.deepEqual(c.getState().recent, [], "an empty box saves no recent search");

	c.input("abc");
	assert.equal(c.getState().options.every((o) => o.kind !== "suggested"), true);
	c.escape();
	assert.deepEqual(c.getState().options, want, "cleared: back to the suggested links");
	c.input("abc");
	c.input("");
	assert.deepEqual(c.getState().options, want);
	assert.equal(c.getState().active, -1);

	// A page surface, or an index with none: no suggested options.
	const page = createController({ index: "site", surface: "page", storage: null, load: async () => searcher });
	await page.preload();
	assert.deepEqual(page.getState().options, []);
	const plain = make();
	await ready(plain.c);
	assert.deepEqual(plain.c.getState().options, []);
});

test("dev: an engine without synonyms warns once that the setting is ignored", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	const base = stub({ synonyms: false }).searcher;
	const searcher: Searcher = { ...base, settings: { ...settings, synonyms: [["docs", "documentation"]] }, run: base.run };
	const c = createController({ index: "site", surface: "dialog", storage: null, dev: true, load: async () => searcher });
	await c.preload();
	assert.equal(warn.mock.callCount(), 1);
	assert.match(String(warn.mock.calls[0]!.arguments[0]), /does not support synonyms/);
	const quiet = createController({ index: "site", surface: "dialog", storage: null, dev: true, load: async () => ({ ...searcher, capabilities: { ...searcher.capabilities, synonyms: true } }) });
	await quiet.preload();
	assert.equal(warn.mock.callCount(), 1);
});

test("togglePick: a facet named like an Object.prototype key is a facet like any other", async () => {
	const t = make();
	t.c.open();
	await ready(t.c);
	t.c.input("x");
	for (const facet of ["constructor", "toString", "__proto__"]) {
		assert.doesNotThrow(() => t.c.togglePick(facet, "a"));
		assert.deepEqual(t.c.getState().picks[facet], ["a"]);
		assert.ok(Object.hasOwn(t.c.getState().picks, facet));
		t.c.togglePick(facet, "a");
		assert.equal(Object.hasOwn(t.c.getState().picks, facet), false);
	}
	assert.equal(Object.getPrototypeOf(t.c.getState().picks), Object.prototype);
});

test("open(start): opens on that query, type and picks in one commit, searched once the index is ready", async () => {
	const t = make();
	t.hold();
	let calls = 0;
	t.c.subscribe(() => calls++);
	t.c.open({ query: "abc", type: "docs", picks: { theme: ["lodestar", "lodestar", ""], empty: [] } });
	assert.equal(calls, 1);
	let s = t.c.getState();
	assert.equal(s.open, true);
	assert.equal(s.query, "abc");
	assert.equal(s.type, "docs");
	assert.deepEqual(s.picks, { theme: ["lodestar"] });
	assert.equal(s.result, null);
	t.release();
	await ready(t.c);
	s = t.c.getState();
	assert.equal(s.result?.query.q, "abc");
	assert.equal(t.s.calls.at(-1)?.type, "docs");
	assert.deepEqual(t.s.calls.at(-1)?.picks, { theme: ["lodestar"] });
	assert.equal(s.active, 0);
});

test("open(start) replaces the last search; open() keeps it", async () => {
	const t = make();
	t.c.open();
	await ready(t.c);
	t.c.input("old");
	t.c.setType("learn");
	t.c.togglePick("theme", "vega");
	t.c.close();
	t.c.open({ query: "new" });
	let s = t.c.getState();
	assert.equal(s.query, "new");
	assert.equal(s.type, null);
	assert.deepEqual(s.picks, {});
	assert.equal(s.result?.query.q, "new");
	t.c.close();
	t.c.open();
	s = t.c.getState();
	assert.equal(s.query, "new");
	assert.equal(s.open, true);
});

test("open(start): picks are dropped, with the dev warning, when the engine has no facets", async (t) => {
	const warn = t.mock.method(console, "warn", () => {});
	const m = make({ dev: true }, { facets: false });
	await m.c.preload();
	m.c.open({ query: "abc", picks: { theme: ["vega"] } });
	assert.deepEqual(m.c.getState().picks, {});
	assert.equal(m.c.getState().result?.query.q, "abc");
	assert.equal(warn.mock.callCount(), 1);
});

test("fill: a placeholder named like an Object.prototype key is left as written", async () => {
	const { fill } = await import("../src/controller/strings.ts");
	assert.equal(fill("{constructor} {toString} {count}", { count: 2 }), "{constructor} {toString} 2");
});
