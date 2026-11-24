import { test } from "node:test";
import assert from "node:assert/strict";
import { createController, defaultStrings, type State } from "../src/controller/index.ts";
import type { FacetCount, ResultGroup, SearchRecord, SearchResult } from "../src/core/types.ts";
import { foldLabel, marked, renderFacets, renderMessage, renderResults, renderShell, renderTabs, seeAllHref, seeAllLink, type RenderContext, type SeeAllState } from "../src/ui/render.ts";

/** A stand-in document: just enough DOM for render.ts (createElement, createTextNode, attributes, append). */
class Text {
	readonly nodeType = 3;
	data: string;
	constructor(data: string) {
		this.data = data;
	}
	get textContent(): string {
		return this.data;
	}
}
class El {
	readonly nodeType = 1;
	readonly attributes = new Map<string, string>();
	readonly childNodes: (El | Text)[] = [];
	tagName: string;
	constructor(tagName: string) {
		this.tagName = tagName;
	}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, String(value));
	}
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	hasAttribute(name: string) {
		return this.attributes.has(name);
	}
	append(...nodes: (El | Text | string)[]) {
		for (const n of nodes) this.childNodes.push(typeof n === "string" ? new Text(n) : n);
	}
	get children(): El[] {
		return this.childNodes.filter((n): n is El => n instanceof El);
	}
	get textContent(): string {
		return this.childNodes.map((n) => n.textContent).join("");
	}
	/** Every element under this one (depth first) that matches `test`. */
	all(test: (e: El) => boolean): El[] {
		const out: El[] = [];
		for (const c of this.children) {
			if (test(c)) out.push(c);
			out.push(...c.all(test));
		}
		return out;
	}
	parts(name: string): El[] {
		return this.all((e) => (e.getAttribute("part") ?? "").split(" ").includes(name));
	}
}
const doc = {
	createElement: (tag: string) => new El(tag),
	createTextNode: (text: string) => new Text(text),
} as unknown as Document;
const wrap = (nodes: unknown[]) => {
	const root = new El("root");
	root.append(...(nodes as El[]));
	return root;
};

function rec(id: string, extra: Partial<SearchRecord> = {}): SearchRecord {
	return { id, kind: "page", locale: "en", type: "docs", url: `/${id}`, title: id, text: "", facets: {}, source: "collection", ...extra } as SearchRecord;
}

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
	strings: defaultStrings,
	idFor: (id) => `opt-${id.replace(/[^a-z0-9]/gi, "-")}`,
	group: "type",
	typeLabel: (t) => ({ docs: "Docs", themes: "Themes" })[t] ?? t,
	facetLabel: (f) => (f === "theme" ? "Theme" : f),
	browse: [
		{ label: "Docs", href: "/docs" },
		{ label: "Pricing", href: "/pricing" },
	],
	...over,
});

const install = rec("install", { title: "Install the theme", text: "Run the installer." });
const installHeading = rec("install#node", { kind: "heading", pageId: "install", url: "/install#node", title: "Install the theme", heading: "Node version", text: "Use Node 22." });
const vesper = rec("vesper", { type: "themes", title: "Vesper", text: "A calm blog." });

function result(groups: ResultGroup[], extra: Partial<SearchResult> = {}): SearchResult {
	const total = groups.reduce((n, g) => n + g.items.length, 0);
	return { query: { q: "x" }, total, groups, types: [], facets: {}, ...extra };
}

const grouped = result([
	{
		key: "docs",
		label: "Docs",
		items: [
			{
				page: install,
				score: 2,
				highlight: { title: [[0, 7]], snippet: { text: "Run the installer.", ranges: [[8, 17]] } },
				headings: [{ record: installHeading, score: 1, highlight: { title: [], heading: [[0, 4]], snippet: { text: "Use Node 22.", ranges: [[4, 8]] } } }],
			},
		],
	},
	{ key: "themes", label: "Themes", items: [{ page: vesper, score: 1, highlight: { title: [], snippet: { text: "A calm blog.", ranges: [] } }, headings: [] }] },
]);

function state(over: Partial<State> = {}): State {
	return {
		open: true,
		status: "ready",
		query: "inst",
		composing: false,
		type: null,
		picks: {},
		result: null,
		options: [],
		active: -1,
		recent: [],
		announce: "",
		capabilities: { fuzzy: true, prefix: true, facets: true, highlights: true },
		locale: "en",
		...over,
	};
}

test("marked: text nodes and <mark> at the ranges, clamped, sorted and merged", () => {
	const root = wrap(marked(doc, "Install the theme", [[12, 17], [0, 3], [2, 7], [30, 40]]));
	assert.equal(root.textContent, "Install the theme");
	const marks = root.all((e) => e.tagName === "mark");
	assert.deepEqual(
		marks.map((m) => m.textContent),
		["Install", "theme"],
	);
	for (const m of marks) assert.equal(m.getAttribute("part"), "mark");
	assert.equal(wrap(marked(doc, "plain", [])).children.length, 0);
});

test("results: groups with labels, a page option and its heading option under it, marks at the right ranges", () => {
	const root = wrap(renderResults(doc, state({ result: grouped }), ctx()));
	const groups = root.parts("group");
	assert.equal(groups.length, 2);
	assert.equal(groups[0]!.getAttribute("role"), "group");
	const label = groups[0]!.parts("group-label")[0]!;
	// The label row: the name (the group's accessible name) and, on the right, the group's page count (not in the name).
	const name = label.children[0]!;
	assert.equal(name.textContent, "Docs");
	assert.equal(groups[0]!.getAttribute("aria-labelledby"), name.getAttribute("id"));
	const count = label.parts("group-count")[0]!;
	assert.equal(count.textContent, String(grouped.groups[0]!.items.length));
	assert.equal(count.getAttribute("aria-hidden"), "true");
	// Grouped by type, the count is the type's match count, the same number as its tab (the list may stop short of it).
	const counted = wrap(renderResults(doc, state({ result: { ...grouped, types: [{ value: "docs", label: "Docs", count: 9, picked: false }] } }), ctx()));
	assert.equal(counted.parts("group-count")[0]!.textContent, "9");

	const options = root.all((e) => e.getAttribute("role") === "option");
	assert.deepEqual(
		options.map((o) => o.getAttribute("id")),
		["opt-install", "opt-install-node", "opt-vesper"],
	);
	const [page, heading] = options;
	assert.equal(page!.tagName, "a");
	assert.equal(page!.getAttribute("href"), "/install");
	assert.equal(page!.getAttribute("tabindex"), "-1");
	assert.equal(page!.getAttribute("data-kind"), "page");
	assert.deepEqual(
		page!.parts("option-title")[0]!.all((e) => e.tagName === "mark").map((m) => m.textContent),
		["Install"],
	);
	assert.deepEqual(
		page!.parts("snippet")[0]!.all((e) => e.tagName === "mark").map((m) => m.textContent),
		["installer"],
	);
	assert.equal(heading!.getAttribute("data-kind"), "heading");
	assert.equal(heading!.getAttribute("href"), "/install#node");
	assert.deepEqual(
		heading!.parts("option-heading")[0]!.all((e) => e.tagName === "mark").map((m) => m.textContent),
		["Node"],
	);
	// The heading option sits right after its page, in the same group.
	assert.ok(groups[0]!.children.includes(heading!));
	// Grouped by type: no type label on the options.
	assert.equal(root.parts("type-label").length, 0);
	// Record text never becomes markup.
	assert.equal(root.all((e) => e.tagName === "script").length, 0);
});

test("results: a type label on each option when grouping is false, and no group wrapper", () => {
	const mixed = result([{ key: "", label: "", items: [...grouped.groups[0]!.items, ...grouped.groups[1]!.items] }]);
	const root = wrap(renderResults(doc, state({ result: mixed }), ctx({ group: false })));
	assert.equal(root.parts("group").length, 0);
	const pages = root.all((e) => e.getAttribute("data-kind") === "page");
	assert.deepEqual(
		pages.map((p) => p.parts("type-label")[0]?.textContent),
		["Docs", "Themes"],
	);
});

test("results: grouped by a facet, the no-value group is labeled from strings.other", () => {
	const byFacet = result([{ key: "", label: "", items: grouped.groups[1]!.items }]);
	const root = wrap(renderResults(doc, state({ result: byFacet }), ctx({ group: "theme" })));
	assert.equal(root.parts("group-label")[0]!.children[0]!.textContent, "Other");
});

test("results: an action with no URL is a plain option, not a link", () => {
	const action = rec("toggle-dark", { kind: "action", url: undefined, command: "dark", title: "Dark mode" });
	delete action.url;
	const root = wrap(renderResults(doc, state({ result: result([{ key: "", label: "", items: [{ page: action, score: 1, highlight: { title: [], snippet: { text: "", ranges: [] } }, headings: [] }] }]) }), ctx({ group: false })));
	const option = root.all((e) => e.getAttribute("role") === "option")[0]!;
	assert.equal(option.tagName, "div");
	assert.equal(option.hasAttribute("href"), false);
});

test("results: only relative and http(s) URLs become links", () => {
	const urls = ["/docs/a", "docs/b?x=1#c", "https://example.com/d", "http://example.com/e", "javascript:alert(1)", " JavaScript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "vbscript:x"];
	const items = urls.map((url, i) => ({ page: rec(`r${i}`, { url }), score: 1, highlight: { title: [], snippet: { text: "", ranges: [] } }, headings: [] }));
	const root = wrap(renderResults(doc, state({ result: result([{ key: "", label: "", items }]) }), ctx({ group: false })));
	const options = root.all((e) => e.getAttribute("role") === "option");
	assert.deepEqual(
		options.map((o) => o.getAttribute("href")),
		["/docs/a", "docs/b?x=1#c", "https://example.com/d", "http://example.com/e", null, null, null, null, null],
	);
	assert.deepEqual(options.slice(4).map((o) => o.tagName), ["div", "div", "div", "div", "div"]);
});

test("empty state: names the query; 'Search all types' only with a type or a pick; recent searches", () => {
	const none = result([]);
	const plain = renderMessage(doc, state({ query: "zzqxj", result: none }), ctx()) as unknown as El;
	assert.deepEqual(plain.getAttribute("part"), "empty");
	assert.match(plain.textContent, /No results for “zzqxj”/);
	assert.equal(plain.all((e) => e.getAttribute("data-action") === "all-types").length, 0);

	const typed = renderMessage(doc, state({ query: "zzqxj", result: none, type: "docs", recent: ["fonts", "deploy"] }), ctx()) as unknown as El;
	const all = typed.all((e) => e.getAttribute("data-action") === "all-types");
	assert.equal(all.length, 1);
	assert.equal(all[0]!.textContent, "Search all types");
	const recent = typed.parts("recent")[0]!;
	assert.match(recent.textContent, /Recent searches/);
	assert.deepEqual(
		recent.all((e) => e.getAttribute("data-action") === "recent").map((b) => b.getAttribute("data-query")),
		["fonts", "deploy"],
	);

	const picked = renderMessage(doc, state({ query: "zzqxj", result: none, picks: { theme: ["vesper"] } }), ctx()) as unknown as El;
	assert.equal(picked.all((e) => e.getAttribute("data-action") === "all-types").length, 1);
});

test("empty box: recent searches, or nothing", () => {
	assert.equal(renderMessage(doc, state({ query: "", recent: [] }), ctx()), null);
	const recent = renderMessage(doc, state({ query: " ", recent: ["fonts"] }), ctx()) as unknown as El;
	assert.equal(recent.getAttribute("part"), "recent");
	assert.equal(recent.all((e) => e.getAttribute("data-query") === "fonts").length, 1);
});

test("loading: a loading line only once there is a query", () => {
	assert.equal(renderMessage(doc, state({ status: "loading", query: "" }), ctx()), null);
	assert.match((renderMessage(doc, state({ status: "loading", query: "in" }), ctx()) as unknown as El).textContent, /Loading/);
});

test("error state: the message, a retry button and the browse links", () => {
	const err = renderMessage(doc, state({ status: "error", query: "inst" }), ctx()) as unknown as El;
	assert.equal(err.getAttribute("part"), "error");
	assert.match(err.textContent, /Search is not available right now\./);
	const retry = err.all((e) => e.getAttribute("data-action") === "retry");
	assert.equal(retry.length, 1);
	assert.equal(retry[0]!.textContent, "Try again");
	assert.deepEqual(
		err.all((e) => e.tagName === "a").map((a) => [a.textContent, a.getAttribute("href")]),
		[
			["Docs", "/docs"],
			["Pricing", "/pricing"],
		],
	);
});

test("tabs: All plus each type, counts from the result", () => {
	const types: FacetCount[] = [
		{ value: "docs", label: "Docs", count: 3, picked: false },
		{ value: "themes", label: "Themes", count: 1, picked: false },
	];
	const root = wrap(renderTabs(doc, state({ result: result([], { types }) }), ctx(), ["docs", "themes", "pages"]));
	const tabs = root.parts("tab");
	assert.deepEqual(
		tabs.map((t) => [t.getAttribute("role"), t.getAttribute("data-type")]),
		[
			["tab", ""],
			["tab", "docs"],
			["tab", "themes"],
			["tab", "pages"],
		],
	);
	assert.deepEqual(
		tabs.map((t) => t.textContent),
		["All4", "Docs3", "Themes1", "pages0"],
	);
	// No result yet: labels only.
	assert.deepEqual(
		wrap(renderTabs(doc, state(), ctx(), ["docs"])).parts("tab").map((t) => t.textContent),
		["All", "Docs"],
	);
});

test("facets: a pressed button per value with a count; none without the capability", () => {
	const facets = { theme: [{ value: "vesper", label: "Vesper", count: 2, picked: true }, { value: "vega", label: "Vega", count: 0, picked: false }, { value: "lodestar", label: "Lodestar", count: 1, picked: false }] };
	const root = wrap(renderFacets(doc, state({ result: result([], { facets }) }), ctx()));
	const buttons = root.parts("facet");
	assert.deepEqual(
		buttons.map((b) => [b.getAttribute("data-value"), b.getAttribute("aria-pressed")]),
		[
			["vesper", "true"],
			["lodestar", "false"],
		],
	);
	assert.equal(root.all((e) => e.getAttribute("role") === "group")[0]!.textContent.startsWith("Theme"), true);
	const off = state({ result: result([], { facets }), capabilities: { fuzzy: true, prefix: true, facets: false, highlights: true } });
	assert.equal(renderFacets(doc, off, ctx()).length, 0);
});

test("foldLabel: the one group's label beside tabs, the facets' word for two or more groups, else no toggle", () => {
	assert.equal(foldLabel(true, ["Theme"], "Filters"), "Theme");
	assert.equal(foldLabel(true, ["Theme", "Year"], "Filters"), "Filters");
	assert.equal(foldLabel(false, ["Theme", "Year"], "Filters"), "Filters");
	// One group and no tabs: the group is the row.
	assert.equal(foldLabel(false, ["Theme"], "Filters"), null);
	assert.equal(foldLabel(true, [], "Filters"), null);
	assert.equal(foldLabel(false, [], "Filters"), null);
});

test("shell: the facets' toggle is a button that controls the facets", () => {
	const shell = renderShell(doc, ctx());
	const toggle = shell.toggle as unknown as El;
	assert.equal(toggle.getAttribute("part"), "filters-toggle");
	assert.equal(toggle.getAttribute("type"), "button");
	assert.equal(toggle.getAttribute("aria-expanded"), "false");
	assert.equal(toggle.getAttribute("aria-controls"), (shell.facets as unknown as El).getAttribute("id"));
});

test("shell: every stable part, the input, listbox and live region", () => {
	const shell = renderShell(doc, ctx());
	const root = shell.dialog as unknown as El;
	for (const part of ["panel", "header", "input", "close", "tabs", "filters-toggle", "facets", "results", "footer", "see-all", "kbd", "status"]) {
		assert.ok(root.parts(part).length > 0, part);
	}
	assert.equal(root.getAttribute("part"), "dialog");
	assert.equal((shell.input as unknown as El).getAttribute("aria-label"), "Search");
	assert.equal((shell.seeAll as unknown as El).textContent, "See all results");
	assert.equal((shell.close as unknown as El).getAttribute("aria-label"), "Close");
});

test("shell: the close button comes after the tabs, the toggle and the facets in tab order", () => {
	const shell = renderShell(doc, ctx());
	const panel = shell.panel as unknown as El;
	// The tabs' row (no part) holds the tabs, then the facets' toggle.
	const order = panel.children.flatMap((c) => (c.getAttribute("part") ? [c.getAttribute("part")] : c.children.map((d) => d.getAttribute("part"))));
	assert.deepEqual(order.slice(0, 5), ["header", "tabs", "filters-toggle", "facets", "close"]);
	assert.equal((panel.parts("header")[0]!).parts("close").length, 0);
});

test("render.ts works with a real controller's state", () => {
	const c = createController({ index: "t", surface: "dialog", storage: null, load: () => new Promise(() => {}) });
	assert.equal(renderResults(doc, c.getState(), ctx()).length, 0);
	assert.equal(renderMessage(doc, c.getState(), ctx()), null);
});

test("empty box: suggested links as a labeled group of link options, before recent searches", () => {
	const options = [
		{ id: "suggested:0", kind: "suggested" as const, url: "/docs/start", label: "Start here" },
		{ id: "suggested:1", kind: "suggested" as const, url: "/pricing", label: "Pricing", type: "pages" },
	];
	const root = wrap(renderResults(doc, state({ query: "", result: null, options }), ctx()));
	const group = root.parts("group")[0]!;
	// Its own part, and the group parts, so it styles like a results group.
	assert.equal(root.parts("suggested")[0], group);
	assert.equal(group.getAttribute("role"), "group");
	assert.equal(group.parts("group-label")[0]!.textContent, "Suggested");
	assert.equal(group.getAttribute("aria-labelledby"), group.parts("group-label")[0]!.getAttribute("id"));
	const links = root.all((e) => e.getAttribute("role") === "option");
	assert.deepEqual(
		links.map((o) => [o.tagName, o.getAttribute("id"), o.getAttribute("href"), o.getAttribute("data-kind"), o.getAttribute("tabindex"), o.textContent]),
		[
			["a", "opt-suggested-0", "/docs/start", "suggested", "-1", "Start here"],
			["a", "opt-suggested-1", "/pricing", "suggested", "-1", "Pricing"],
		],
	);
	assert.equal(root.parts("option-title").length, 2);
	// The strings setting relabels it; no options, no group.
	const relabeled = wrap(renderResults(doc, state({ query: "", options }), ctx({ strings: { ...defaultStrings, suggested: "Popular" } })));
	assert.equal(relabeled.parts("group-label")[0]!.textContent, "Popular");
	assert.equal(renderResults(doc, state({ query: "", options: [] }), ctx()).length, 0);
});

test("error state: a browse link with an unsafe URL is never rendered", () => {
	const browse = [
		{ label: "Docs", href: "/docs" },
		{ label: "Bad", href: "javascript:alert(1)" },
		{ label: "Data", href: " data:text/html,hi" },
	];
	const err = renderMessage(doc, state({ status: "error", query: "inst" }), ctx({ browse })) as unknown as El;
	assert.deepEqual(err.all((e) => e.tagName === "a").map((a) => a.getAttribute("href")), ["/docs"]);
	const none = renderMessage(doc, state({ status: "error", query: "inst" }), ctx({ browse: [browse[1]!] })) as unknown as El;
	assert.equal(none.all((e) => e.tagName === "a" || e.tagName === "ul").length, 0);
});

test("See all results: the trigger's href with q set, keeping its other parameters and fragment", () => {
	const at = "https://example.com/docs/page";
	assert.equal(seeAllHref("/search", "", at), "/search");
	assert.equal(seeAllHref("/search", "dark mode", at), "/search?q=dark%20mode");
	assert.equal(seeAllHref("/search#results", "fonts", at), "/search?q=fonts#results");
	assert.equal(seeAllHref("/search?q=old", "new", at), "/search?q=new");
	// A cleared box drops an old q; other parameters and the fragment stay.
	assert.equal(seeAllHref("/search?q=old", "", at), "/search");
	assert.equal(seeAllHref("/search?type=docs&q=old#top", "", at), "/search?type=docs#top");
	assert.equal(seeAllHref("/search?type=docs&q=old#top", "a&b=c", at), "/search?type=docs&q=a%26b%3Dc#top");
	assert.equal(seeAllHref("/search?tag=c%2B%2B", "1+1", at), "/search?tag=c%2B%2B&q=1%2B1");
	// Relative to the page, as the link itself would be.
	assert.equal(seeAllHref("search", "x", at), "/docs/search?q=x");
	// Another origin stays a full URL.
	assert.equal(seeAllHref("https://docs.example.org/find#r", "x", at), "https://docs.example.org/find?q=x#r");
});

test("without seeAll, the See all href is unchanged; with it, the host builds it from the base, the state and the index", () => {
	const at = "https://example.com/docs/page";
	const s: SeeAllState = { query: " dark mode ", type: "docs", picks: { theme: ["vega"] } };
	assert.equal(seeAllLink({}, "/find#r", s, "main", at), seeAllHref("/find#r", "dark mode", at), "the trigger's href, as today");
	assert.equal(seeAllLink({}, null, s, "main", at), "/search?q=dark%20mode", "no trigger: /search");
	assert.equal(seeAllLink({ results: "/results/" }, null, s, "main", at), "/results/?q=dark%20mode", "no trigger: the config's results URL");
	assert.equal(seeAllLink({ results: "/results/" }, "/find", s, "main", at), "/find?q=dark%20mode", "a trigger wins");
	const calls: unknown[] = [];
	const seeAll = (base: string, st: typeof s, index: string) => (calls.push([base, st, index]), `${base}?s=${st.query.trim()}&z_index=${index}`);
	assert.equal(seeAllLink({ results: "/", seeAll }, null, s, "blog", at), "/?s=dark mode&z_index=blog");
	assert.deepEqual(calls, [["/", s, "blog"]]);
});

test("newTab: results, headings, suggested, See all and the error's links open a new tab with no opener", () => {
	const on = ctx({ newTab: true });
	const found = state({ result: grouped });
	const suggested = state({ query: "", options: [{ id: "suggested:0", kind: "suggested", url: "/docs/start", label: "Start here" }] });
	const error = state({ status: "error", query: "inst" });
	const links = (c: RenderContext) => [
		...wrap(renderResults(doc, found, c)).parts("option"),
		...wrap(renderResults(doc, suggested, c)).parts("option"),
		renderShell(doc, c).seeAll as unknown as El,
		...(renderMessage(doc, error, c) as unknown as El).all((e) => e.tagName === "a"),
	];
	assert.equal(links(on).length, 7);
	for (const a of links(on)) assert.deepEqual([a.tagName, a.getAttribute("target"), a.getAttribute("rel")], ["a", "_blank", "noopener"]);
	for (const a of links(ctx())) assert.deepEqual([a.tagName, a.hasAttribute("target"), a.hasAttribute("rel"), a.hasAttribute("aria-describedby")], ["a", false, false, false]);
	// An unsafe URL is still no link.
	const item = { page: rec("x", { url: "javascript:alert(1)" }), score: 1, highlight: { title: [], snippet: { text: "", ranges: [] } }, headings: [] };
	const unsafe = state({ result: result([{ key: "docs", label: "Docs", items: [item] }]) });
	const [plain] = wrap(renderResults(doc, unsafe, on)).parts("option");
	assert.deepEqual([plain!.tagName, plain!.hasAttribute("href"), plain!.hasAttribute("target")], ["div", false, false]);
});

test("newTab: one notice in the footer, outside the live region; the box, See all and the error's links point at it, options do not", () => {
	const on = ctx({ newTab: true, strings: { ...defaultStrings, newTab: "Opens in a new tab" } });
	const shell = renderShell(doc, on);
	const dialog = shell.dialog as unknown as El;
	const [notice, ...more] = dialog.parts("new-tab");
	assert.equal(more.length, 0);
	assert.equal(notice!.textContent, "Opens in a new tab");
	assert.ok(dialog.parts("footer")[0]!.children.includes(notice!));
	assert.equal((shell.live as unknown as El).parts("new-tab").length, 0);
	const id = notice!.getAttribute("id")!;
	assert.ok(id);
	assert.equal(shell.input.getAttribute("aria-describedby"), id);
	assert.equal(shell.seeAll.getAttribute("aria-describedby"), id);
	const err = renderMessage(doc, state({ status: "error", query: "x" }), on) as unknown as El;
	assert.deepEqual(err.all((e) => e.tagName === "a").map((a) => a.getAttribute("aria-describedby")), [id, id]);
	const options = wrap(renderResults(doc, state({ query: "", options: [{ id: "suggested:0", kind: "suggested", url: "/a", label: "A" }] }), on)).parts("option");
	assert.deepEqual(options.map((o) => o.hasAttribute("aria-describedby")), [false]);
	// Without it: no extra element, and the box has no description.
	const off = renderShell(doc, ctx());
	assert.equal((off.dialog as unknown as El).parts("new-tab").length, 0);
	assert.equal((off.dialog as unknown as El).parts("footer")[0]!.children.length, 2);
	assert.equal(off.input.hasAttribute("aria-describedby"), false);
});
