import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultStrings, type State } from "../src/controller/index.ts";
import type { ResultGroup, SearchRecord, SearchResult } from "../src/core/types.ts";
import { defaultPageWords } from "../src/page/words.ts";
import { crumbOf, renderFacets, renderList, renderMessage, renderPage, renderResult, renderTabs, type PageContext } from "../src/results/render.ts";
import { css } from "../src/results/styles.ts";

/** A stand-in document: just enough DOM for the results page's builders (createElement, createTextNode, attributes, append). */
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
	tags(tag: string): El[] {
		return this.all((e) => e.tagName === tag);
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
const el = (node: unknown) => node as El;

function rec(id: string, extra: Partial<SearchRecord> = {}): SearchRecord {
	return { id, kind: "page", locale: "en", type: "docs", url: `/${id}`, title: id, text: "", facets: {}, source: "collection", ...extra } as SearchRecord;
}

const settings = { types: { docs: { label: "Docs" }, themes: { label: "Themes" } }, facets: { theme: { label: "Theme", values: { vesper: "Vesper" } } } };

const ctx = (over: Partial<PageContext> = {}): PageContext => ({
	strings: defaultStrings,
	words: defaultPageWords,
	queryParam: "s",
	action: "/search/",
	idFor: (name) => `rp-${name.replace(/[^a-z0-9]/gi, "-")}`,
	typeLabel: (t) => settings.types[t as "docs"]?.label ?? t,
	facetLabel: (f) => (f === "theme" ? "Theme" : f),
	crumb: (r) => crumbOf(r, settings),
	browse: [{ label: "Docs", href: "/docs" }],
	suggested: [{ label: "Pricing", href: "/pricing" }],
	...over,
});

const install = rec("install", { title: "Install the theme", text: "Run the installer.", facets: { theme: ["vesper"] } });
const installHeading = rec("install#node", { kind: "heading", pageId: "install", url: "/install#node", title: "Install the theme", heading: "Node version", text: "Use Node 22." });
const vesper = rec("vesper", { type: "themes", title: "Vesper", text: "A calm blog." });

const installItem = {
	page: install,
	score: 2,
	highlight: { title: [[0, 7]] as [number, number][], snippet: { text: "Run the installer.", ranges: [[8, 17]] as [number, number][] } },
	headings: [{ record: installHeading, score: 1, highlight: { title: [], heading: [[0, 4]] as [number, number][], snippet: { text: "Use Node 22.", ranges: [[4, 8]] as [number, number][] } } }],
};
const vesperItem = { page: vesper, score: 1, highlight: { title: [], snippet: { text: "A calm blog.", ranges: [] } }, headings: [] };
const groups: ResultGroup[] = [
	{ key: "docs", label: "Docs", items: [installItem] },
	{ key: "themes", label: "Themes", items: [vesperItem] },
];

function result(extra: Partial<SearchResult> = {}): SearchResult {
	return { query: { q: "inst" }, total: 2, groups, types: [], facets: {}, ...extra };
}

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

test("renderPage builds a search landmark, a labeled GET form (input name = queryParam, action = results URL), a type row, a facets group, a count, a list, a message, a Show more button and a polite live region", () => {
	const shell = renderPage(doc, ctx());
	const root = el(shell.root);
	assert.equal(root.tagName, "search");
	assert.equal(root.getAttribute("role"), "search");
	const form = el(shell.form);
	assert.equal(form.tagName, "form");
	assert.equal(form.getAttribute("method"), "get");
	assert.equal(form.getAttribute("action"), "/search/");
	const input = el(shell.input);
	assert.equal(input.getAttribute("type"), "search");
	assert.equal(input.getAttribute("name"), "s");
	assert.equal(input.getAttribute("placeholder"), defaultStrings.placeholder);
	const label = root.tags("label")[0]!;
	assert.equal(label.getAttribute("for"), input.getAttribute("id"));
	assert.equal(label.textContent, defaultPageWords.label);
	const submit = el(shell.submit);
	assert.equal(submit.getAttribute("type"), "submit");
	assert.equal(submit.textContent, defaultPageWords.submit);
	assert.equal(submit.getAttribute("part"), "submit");
	// The type row: a quiet visible label (hidden from screen readers), then the tablist, both hidden until there are tabs.
	const typeRow = el(shell.typeRow);
	assert.ok(typeRow.hasAttribute("hidden"));
	assert.equal(typeRow.children[0]!.textContent, defaultPageWords.typeText);
	assert.equal(typeRow.children[0]!.getAttribute("aria-hidden"), "true");
	assert.equal(el(shell.tablist).getAttribute("aria-label"), defaultStrings.typesLabel);
	const facets = el(shell.facets);
	assert.equal(facets.getAttribute("role"), "group");
	assert.equal(facets.getAttribute("aria-label"), defaultStrings.facetsLabel);
	assert.ok(el(shell.count).hasAttribute("hidden"));
	assert.equal(el(shell.count).getAttribute("part"), "count");
	assert.equal(el(shell.list).getAttribute("part"), "list");
	assert.equal(el(shell.message).getAttribute("part"), "message");
	const more = el(shell.more);
	assert.equal(more.tagName, "button");
	assert.equal(more.getAttribute("type"), "button");
	assert.ok(more.hasAttribute("hidden"));
	assert.equal(more.textContent, defaultPageWords.showMore);
	const live = el(shell.live);
	assert.equal(live.getAttribute("aria-live"), "polite");
	assert.equal(live.getAttribute("role"), "status");
	// All of it sits in the landmark, in the Tab order: box, button, tabs, facets, results, more.
	for (const part of [form, typeRow, facets, el(shell.count), el(shell.list), el(shell.message), more, live]) {
		assert.ok(root.all((e) => e === part).length === 1, `${part.tagName} is inside the landmark`);
	}
});

test("renderResult: a crumb, a title link, a snippet with mark ranges, and heading links with the hidden # mark", () => {
	let n = 0;
	const li = el(renderResult(doc, installItem, ctx(), () => ++n, "h2"));
	assert.equal(li.tagName, "li");
	assert.equal(li.getAttribute("part"), "result");
	const crumb = li.parts("crumb")[0]!;
	assert.equal(crumb.textContent, "Docs›Vesper");
	const sep = crumb.parts("crumb-sep")[0]!;
	assert.equal(sep.getAttribute("aria-hidden"), "true");
	const title = li.parts("title")[0]!;
	assert.equal(title.tagName, "h2");
	const link = title.tags("a")[0]!;
	assert.equal(link.getAttribute("href"), "/install");
	assert.equal(link.getAttribute("data-search-position"), "1");
	assert.equal(link.textContent, "Install the theme");
	assert.deepEqual(
		link.tags("mark").map((m) => m.textContent),
		["Install"],
	);
	const snippet = li.parts("snippet")[0]!;
	assert.equal(snippet.textContent, "Run the installer.");
	assert.deepEqual(
		snippet.tags("mark").map((m) => m.textContent),
		["installer"],
	);
	for (const m of li.tags("mark")) assert.equal(m.getAttribute("part"), "mark");
	const headings = li.parts("headings")[0]!;
	assert.equal(headings.tagName, "ul");
	const row = headings.children[0]!;
	assert.equal(row.getAttribute("part"), "heading");
	const hl = row.tags("a")[0]!;
	assert.equal(hl.getAttribute("href"), "/install#node");
	assert.equal(hl.getAttribute("data-search-position"), "2");
	const mark = hl.parts("heading-mark")[0]!;
	assert.equal(mark.getAttribute("aria-hidden"), "true");
	assert.equal(mark.textContent, "#");
	assert.equal(hl.parts("heading-title")[0]!.textContent, "Node version");
	assert.deepEqual(
		hl.tags("mark").map((m) => m.textContent),
		["Node"],
	);
	assert.equal(row.parts("heading-snippet")[0]!.textContent, "Use Node 22.");
	// No snippet, no headings: neither box.
	const plain = el(renderResult(doc, vesperItem, ctx(), () => 9, "h3"));
	assert.equal(plain.parts("headings").length, 0);
	assert.equal(plain.parts("title")[0]!.tagName, "h3");
	assert.equal(plain.parts("crumb")[0]!.textContent, "Themes");
	// An unsafe URL is no link.
	const bad = el(renderResult(doc, { ...vesperItem, page: rec("x", { url: "javascript:alert(1)" }) }, ctx(), () => 1, "h2"));
	assert.equal(bad.tags("a")[0]!.hasAttribute("href"), false);
	// No crumb parts: no crumb.
	assert.equal(el(renderResult(doc, vesperItem, ctx({ crumb: () => [] }), () => 1, "h2")).parts("crumb").length, 0);
});

test("renderList: one list, or a section per group under its labeled heading, the titles one level down", () => {
	const flat = wrap(renderList(doc, [{ key: "", label: "", items: [installItem, vesperItem] }], ctx(), { count: (_k, shown) => shown }));
	assert.equal(flat.children.length, 1);
	assert.equal(flat.children[0]!.tagName, "ol");
	assert.equal(flat.parts("result").length, 2);
	assert.equal(flat.parts("title")[0]!.tagName, "h2");
	const out = wrap(renderList(doc, groups, ctx(), { count: (k) => (k === "docs" ? 7 : 1) }));
	const sections = out.parts("group");
	assert.equal(sections.length, 2);
	const label = sections[0]!.parts("group-label")[0]!;
	const name = label.children[0]!;
	assert.equal(name.tagName, "h2");
	assert.equal(name.textContent, "Docs");
	assert.equal(sections[0]!.getAttribute("aria-labelledby"), name.getAttribute("id"));
	assert.equal(label.parts("group-count")[0]!.textContent, "7");
	assert.equal(sections[0]!.parts("title")[0]!.tagName, "h3");
	// Positions run across groups in screen order: page, its heading, the next page.
	assert.deepEqual(
		out.all((e) => e.hasAttribute("data-search-position")).map((a) => a.getAttribute("data-search-position")),
		["1", "2", "3"],
	);
});

test("renderTabs: role=tab, aria-selected and counts; renderFacets: aria-pressed buttons", () => {
	const s = state({
		type: "docs",
		result: result({
			types: [
				{ value: "docs", label: "Docs", count: 3, picked: true },
				{ value: "themes", label: "Themes", count: 0, picked: false },
			],
			facets: {
				theme: [
					{ value: "vesper", label: "Vesper", count: 2, picked: true },
					{ value: "lodestar", label: "Lodestar", count: 0, picked: false },
					{ value: "agency", label: "Agency", count: 1, picked: false },
				],
			},
		}),
	});
	const tabs = wrap(renderTabs(doc, s, ctx(), ["docs", "themes"]));
	const all = tabs.children;
	// A type with no match shows no tab unless it is selected; All always shows.
	assert.deepEqual(
		all.map((t) => t.getAttribute("data-type")),
		["", "docs"],
	);
	for (const t of all) {
		assert.equal(t.getAttribute("role"), "tab");
		assert.equal(t.getAttribute("type"), "button");
		assert.equal(t.getAttribute("part"), "tab pill");
	}
	assert.equal(all[0]!.getAttribute("aria-selected"), "false");
	assert.equal(all[1]!.getAttribute("aria-selected"), "true");
	assert.equal(all[0]!.textContent, `${defaultStrings.allTypes}3`);
	assert.equal(all[1]!.all((e) => e.getAttribute("class") === "count")[0]!.textContent, "3");
	// Before a result: no counts, and every type.
	const cold = wrap(renderTabs(doc, state(), ctx(), ["docs", "themes"]));
	assert.equal(cold.children.length, 3);
	assert.equal(cold.all((e) => e.getAttribute("class") === "count").length, 0);

	const groupsOut = wrap(renderFacets(doc, s, ctx()));
	const group = groupsOut.children[0]!;
	assert.equal(group.getAttribute("role"), "group");
	const label = group.children[0]!;
	assert.equal(label.textContent, "Theme");
	assert.equal(group.getAttribute("aria-labelledby"), label.getAttribute("id"));
	const buttons = group.parts("facet");
	assert.deepEqual(
		buttons.map((b) => [b.getAttribute("data-value"), b.getAttribute("aria-pressed")]),
		[
			["vesper", "true"],
			["agency", "false"],
		],
	);
	for (const b of buttons) {
		assert.equal(b.tagName, "button");
		assert.equal(b.getAttribute("data-action"), "facet");
		assert.equal(b.getAttribute("data-facet"), "theme");
	}
	assert.equal(wrap(renderFacets(doc, state({ result: s.result, capabilities: { fuzzy: true, prefix: true, facets: false, highlights: true } }), ctx())).children.length, 0);
});

test("renderMessage: loading, no results with All types and the suggested links, and the error state with retry and browse links", () => {
	assert.equal(renderMessage(doc, state({ query: "" }), ctx()), null);
	assert.equal(el(renderMessage(doc, state({ status: "loading" }), ctx())).textContent, defaultStrings.loading);
	assert.equal(renderMessage(doc, state({ result: result() }), ctx()), null);
	const empty = el(renderMessage(doc, state({ type: "docs", result: result({ total: 0, groups: [] }) }), ctx()));
	assert.match(empty.textContent, /No results for “inst”/);
	assert.equal(empty.all((e) => e.getAttribute("data-action") === "all-types").length, 1);
	const suggested = empty.tags("a");
	assert.deepEqual(
		suggested.map((a) => a.getAttribute("href")),
		["/pricing"],
	);
	const plainEmpty = el(renderMessage(doc, state({ result: result({ total: 0, groups: [] }) }), ctx({ suggested: [{ label: "Bad", href: "javascript:x" }] })));
	assert.equal(plainEmpty.all((e) => e.getAttribute("data-action") === "all-types").length, 0);
	assert.equal(plainEmpty.tags("a").length, 0);
	const error = el(renderMessage(doc, state({ status: "error" }), ctx()));
	assert.equal(error.all((e) => e.getAttribute("data-action") === "retry").length, 1);
	assert.deepEqual(
		error.tags("a").map((a) => a.getAttribute("href")),
		["/docs"],
	);
});

test("every text goes in through textContent (no innerHTML from records)", () => {
	const nasty = '<img src=x onerror="alert(1)"><b>bold</b>';
	const page = rec("n", { title: nasty, type: nasty, facets: { theme: [nasty] } });
	const item = { page, score: 1, highlight: { title: [[0, 4]] as [number, number][], snippet: { text: nasty, ranges: [] } }, headings: [] };
	const li = el(renderResult(doc, item, ctx({ crumb: (r) => crumbOf(r, { types: {}, facets: { theme: { label: "Theme" } } }) }), () => 1, "h2"));
	assert.equal(li.tags("img").length, 0);
	assert.equal(li.tags("b").length, 0);
	assert.ok(li.textContent.includes(nasty));
	const tabs = wrap(renderTabs(doc, state(), ctx({ typeLabel: () => nasty }), ["docs"]));
	assert.equal(tabs.tags("img").length, 0);
	const src = readFileSync(new URL("../src/results/render.ts", import.meta.url), "utf8");
	assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment/);
});

test("the styles use --search-* tokens, inherit font and color, and have no border-left or border-inline-start accent", () => {
	for (const token of ["--search-fg", "--search-muted", "--search-border", "--search-accent", "--search-mark-bg", "--search-focus", "--search-radius"]) {
		assert.ok(css.includes(`var(${token}`), `uses ${token}`);
	}
	// Font and color come from the theme unless a site sets the tokens.
	assert.match(css, /--_font:\s*var\(--search-font,\s*inherit\)/);
	assert.match(css, /:host\s*\{[^}]*font:\s*inherit/);
	assert.match(css, /:host\s*\{[^}]*color:\s*var\(--_fg\)/);
	assert.match(css, /--_fg:\s*var\(--search-fg,\s*currentColor\)/);
	// Light and dark.
	assert.match(css, /prefers-color-scheme:\s*dark/);
	assert.match(css, /:host\(\[theme="dark"\]\)/);
	assert.doesNotMatch(css, /border-left|border-inline-start|border-right|border-inline-end/);
});

test("review fixes: forced-colors focus, focus from the text color, a wrapping form, pills that hold long labels, touch-size section links", () => {
	assert.match(css, /\[part~="input"\]:focus-visible\s*\{[^}]*outline:\s*2px solid/);
	assert.match(css, /--_focus:\s*var\(--search-focus,\s*currentColor\)/);
	assert.doesNotMatch(css, /--_focus:\s*var\(--search-focus,\s*#/);
	assert.match(css, /\[part~="form"\]\s*\{[^}]*flex-wrap:\s*wrap/);
	assert.match(css, /\[part~="field"\]\s*\{[^}]*flex:\s*1 1 12rem/);
	assert.match(css, /\[part~="pill"\] \.name\s*\{[^}]*min-width:\s*0/);
	assert.match(css, /@container search-page \(max-width: 40rem\)\s*\{[\s\S]*?\[part~="pill"\]\s*\{[^}]*max-width:\s*none/);
	assert.match(css, /@media \(pointer: coarse\)\s*\{\s*\[part~="heading-link"\]\s*\{[^}]*min-height:\s*2\.75rem/);
});

test("review fixes: the result, section and link lists keep list semantics (role=list)", () => {
	const out = wrap(renderList(doc, groups, ctx(), { count: (_k, n) => n }));
	for (const l of out.parts("results")) assert.equal(l.getAttribute("role"), "list");
	for (const l of out.parts("headings")) assert.equal(l.getAttribute("role"), "list");
	const error = el(renderMessage(doc, state({ status: "error" }), ctx()));
	assert.equal(error.tags("ul")[0]!.getAttribute("role"), "list");
});
