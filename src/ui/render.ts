/**
 * The default dialog's markup, as pure functions from the controller's State to DOM nodes. Record text only ever
 * becomes text nodes and <mark> elements from highlight ranges, never markup. No listeners here: the element wires
 * actions by `data-action` on its shadow root.
 *
 * Only createElement, createTextNode, setAttribute and append are used, so a stand-in document runs these under node.
 */
import type { Option, State } from "../controller/index.ts";
import { fill, type Strings } from "../controller/strings.ts";
import type { GroupBy, Highlight, Ranges, SearchRecord } from "../core/types.ts";
import { marked } from "../dom/marked.ts";
import { isSafeUrl } from "../dom/safe-url.ts";

export interface BrowseLink {
	label: string;
	href: string;
}

export interface RenderContext {
	strings: Strings;
	/** The option element id for a record id (dom's idFor with this dialog's prefix). */
	idFor: (recordId: string) => string;
	/** The grouping in effect: the dialog's `group` attribute, else the index setting. */
	group: GroupBy;
	typeLabel: (type: string) => string;
	facetLabel: (facet: string) => string;
	/** Links for the error state. */
	browse: BrowseLink[];
	/** Links open in a new tab, and the footer says so. */
	newTab?: boolean;
}

type Child = Node | string | null | undefined | false;

function h(doc: Document, tag: string, attrs: Record<string, string | undefined>, ...children: Child[]): HTMLElement {
	const el = doc.createElement(tag);
	for (const [name, value] of Object.entries(attrs)) if (value !== undefined) el.setAttribute(name, value);
	for (const c of children) if (c !== null && c !== undefined && c !== false && c !== "") el.append(c);
	return el;
}

/** The attributes of a link that opens in a new tab; none without newTab. */
const linkTarget = (ctx: RenderContext): Record<string, string> => (ctx.newTab ? { target: "_blank", rel: "noopener" } : {});

/** The id of the footer's new-tab notice; undefined (no attribute) without newTab. */
const noticeId = (ctx: RenderContext): string | undefined => (ctx.newTab ? ctx.idFor("label:new-tab") : undefined);

/** Record text with <mark part="mark"> around each range: the dom layer's marked(), re-exported for the default dialog. */
export { marked };

function span(doc: Document, part: string, nodes: Node[]): HTMLElement {
	const el = h(doc, "span", { part });
	el.append(...nodes);
	return el;
}

function option(doc: Document, record: SearchRecord, hl: Highlight, ctx: RenderContext): HTMLElement {
	// Only a relative or http(s) URL becomes a link; any other scheme renders as a plain option.
	const link = record.url !== undefined && isSafeUrl(record.url);
	const el = h(doc, link ? "a" : "div", {
		role: "option",
		id: ctx.idFor(record.id),
		part: "option",
		"data-kind": record.kind,
		href: link ? record.url : undefined,
		// A link inside the listbox is never a tab stop: focus stays in the box.
		tabindex: link ? "-1" : undefined,
		...(link && linkTarget(ctx)),
	});
	if (record.kind === "heading") {
		el.append(span(doc, "option-heading", marked(doc, record.heading, hl.heading ?? [])));
	} else {
		const title = span(doc, "option-title", marked(doc, record.title, hl.title));
		if (ctx.group === false) el.append(h(doc, "span", { class: "line" }, title, h(doc, "span", { part: "type-label" }, ctx.typeLabel(record.type))));
		else el.append(title);
	}
	if (hl.snippet.text) el.append(span(doc, "snippet", marked(doc, hl.snippet.text, hl.snippet.ranges)));
	return el;
}

/** The suggested links in an empty box: one labeled group of link options. */
function suggestedGroup(doc: Document, options: Option[], ctx: RenderContext): HTMLElement[] {
	const links = options.filter((o) => o.kind === "suggested" && o.url !== undefined && isSafeUrl(o.url));
	if (!links.length) return [];
	const labelId = ctx.idFor("label:suggested");
	const label = h(doc, "div", { part: "group-label", id: labelId, role: "presentation" }, ctx.strings.suggested);
	const items = links.map((o) =>
		h(doc, "a", { role: "option", id: ctx.idFor(o.id), part: "option", "data-kind": "suggested", href: o.url, tabindex: "-1", ...linkTarget(ctx) }, span(doc, "option-title", [doc.createTextNode(o.label ?? o.url!)])),
	);
	// "group suggested": styled as a results group, with a part of its own to style it apart.
	return [h(doc, "div", { role: "group", part: "group suggested", "aria-labelledby": labelId }, label, ...items)];
}

/** The listbox's children: one group per result group (or the options alone when grouping is off). In an empty box, the suggested links. */
export function renderResults(doc: Document, state: State, ctx: RenderContext): HTMLElement[] {
	const result = state.result;
	if (!result) return suggestedGroup(doc, state.options, ctx);
	const out: HTMLElement[] = [];
	// Grouped by type, a group's count is its type's match count (the number on its tab), not only the pages listed.
	const typeCounts = ctx.group === "type" ? new Map(result.types.map((t) => [t.value, t.count])) : null;
	for (const group of result.groups) {
		const options: HTMLElement[] = [];
		for (const item of group.items) {
			options.push(option(doc, item.page, item.highlight, ctx));
			for (const heading of item.headings) options.push(option(doc, heading.record, heading.highlight, ctx));
		}
		if (ctx.group === false) {
			out.push(...options);
			continue;
		}
		const labelId = ctx.idFor(`group:${group.key}`);
		// The name labels the group; the count sits on its right, seen but not part of the name.
		const label = h(
			doc,
			"div",
			{ part: "group-label", role: "presentation" },
			h(doc, "span", { id: labelId }, group.key === "" ? ctx.strings.other : group.label),
			h(doc, "span", { part: "group-count", "aria-hidden": "true" }, String(typeCounts?.get(group.key) ?? group.items.length)),
		);
		out.push(h(doc, "div", { role: "group", part: "group", "aria-labelledby": labelId }, label, ...options));
	}
	return out;
}

function button(doc: Document, attrs: Record<string, string | undefined>, ...children: Child[]): HTMLElement {
	// tabindex: WebKit on macOS skips plain buttons on Tab without one.
	return h(doc, "button", { type: "button", tabindex: "0", ...attrs }, ...children);
}

function recentList(doc: Document, state: State, ctx: RenderContext): HTMLElement | null {
	if (!state.recent.length) return null;
	const items = state.recent.map((q) => h(doc, "li", {}, button(doc, { class: "recent-item", "data-action": "recent", "data-query": q, "data-key": `recent:${q}` }, q)));
	const labelId = ctx.idFor("label:recent");
	return h(doc, "div", { part: "recent" }, h(doc, "p", { class: "label", id: labelId }, ctx.strings.recent), h(doc, "ul", { "aria-labelledby": labelId }, ...items));
}

/** The message under the box: the error state, loading, no results, or recent searches. Null when there is none. */
export function renderMessage(doc: Document, state: State, ctx: RenderContext): HTMLElement | null {
	const { strings } = ctx;
	const q = state.query.trim();
	if (state.status === "error") {
		// Only a relative or http(s) URL becomes a link (the build checks them too).
		const links = ctx.browse.filter((l) => isSafeUrl(l.href)).map((l) => h(doc, "li", {}, h(doc, "a", { href: l.href, tabindex: "0", "aria-describedby": noticeId(ctx), ...linkTarget(ctx) }, l.label)));
		const browseId = ctx.idFor("label:browse");
		return h(
			doc,
			"div",
			{ part: "error" },
			h(doc, "p", { class: "lead" }, strings.unavailable),
			button(doc, { class: "action", "data-action": "retry", "data-key": "retry" }, strings.retry),
			links.length > 0 && h(doc, "p", { class: "label", id: browseId }, strings.browse),
			links.length > 0 && h(doc, "ul", { class: "browse", "aria-labelledby": browseId }, ...links),
		);
	}
	if (!q) return recentList(doc, state, ctx);
	if (state.status === "loading" || state.status === "idle") return h(doc, "p", { class: "loading" }, strings.loading);
	if (state.result && state.result.total === 0) {
		const narrowed = state.type !== null || Object.keys(state.picks).length > 0;
		return h(
			doc,
			"div",
			{ part: "empty" },
			h(doc, "p", { class: "lead" }, fill(strings.noResults, { query: q })),
			narrowed && button(doc, { class: "action", "data-action": "all-types", "data-key": "all-types" }, strings.searchAllTypes),
			recentList(doc, state, ctx),
		);
	}
	return null;
}

/** The type tabs: All, then each type this dialog shows, with counts once there is a result. */
export function renderTabs(doc: Document, state: State, ctx: RenderContext, types: string[]): HTMLElement[] {
	const counts = new Map((state.result?.types ?? []).map((t) => [t.value, t.count]));
	const has = state.result !== null;
	const total = types.reduce((n, t) => n + (counts.get(t) ?? 0), 0);
	const tab = (value: string, label: string, count: number) =>
		h(doc, "button", { type: "button", role: "tab", part: "tab", "data-type": value, "data-key": `tab:${value}` }, h(doc, "span", { class: "name" }, label), has && h(doc, "span", { class: "count" }, String(count)));
	return [tab("", ctx.strings.allTypes, total), ...types.map((t) => tab(t, ctx.typeLabel(t), counts.get(t) ?? 0))];
}

/** One group of toggle buttons per facet: values with matches, and every picked value. None without the capability. */
export function renderFacets(doc: Document, state: State, ctx: RenderContext): HTMLElement[] {
	if (!state.capabilities?.facets || !state.result) return [];
	const out: HTMLElement[] = [];
	for (const [facet, values] of Object.entries(state.result.facets)) {
		const shown = values.filter((v) => v.count > 0 || v.picked);
		if (!shown.length) continue;
		const labelId = ctx.idFor(`facet:${facet}`);
		const buttons = shown.map((v) =>
			button(
				doc,
				{ part: "facet", "aria-pressed": String(v.picked), "data-action": "facet", "data-facet": facet, "data-value": v.value, "data-key": `facet:${facet}:${v.value}` },
				h(doc, "span", { class: "name" }, v.label),
				h(doc, "span", { class: "count" }, String(v.count)),
			),
		);
		out.push(h(doc, "div", { role: "group", class: "facet-group", "aria-labelledby": labelId }, h(doc, "span", { class: "label", id: labelId }, ctx.facetLabel(facet)), ...buttons));
	}
	return out;
}

/**
 * The name of the toggle that folds the facet groups on a narrow screen: the one group's label (with tabs on its row),
 * the facets' label for two or more groups, or null for no toggle (no groups, or one group and no tabs: it is a row).
 */
export function foldLabel(tabs: boolean, labels: string[], word: string): string | null {
	return labels.length > 1 ? word : labels.length && tabs ? labels[0]! : null;
}

/**
 * Where "See all results" goes: the trigger's href with `q` set to the query (or removed when the query is empty), other parameters and the fragment kept.
 * A same-origin href stays a path; `baseURI` is the page's (document.baseURI).
 */
export function seeAllHref(href: string, q: string, baseURI: string): string {
	let url: URL;
	try {
		url = new URL(href, baseURI);
	} catch {
		return href;
	}
	if (q) url.searchParams.set("q", q);
	else url.searchParams.delete("q");
	// %20 for a space, as encodeURIComponent; a literal + is %2B already.
	url.search = url.searchParams.toString().replace(/\+/g, "%20");
	return url.origin === new URL(baseURI).origin ? url.pathname + url.search + url.hash : url.href;
}

/** What a host's `seeAll` gets: the box's query, type and picks. */
export interface SeeAllState {
	query: string;
	type: string | null;
	picks: Record<string, string[]>;
}

/** Builds the dialog's "See all results" href from its base, the box's state and the dialog's index. */
export type SeeAll = (base: string, s: SeeAllState, index: string) => string;

/** The parts of the element's settings "See all results" reads. */
export interface SeeAllConfig {
	results?: string;
	seeAll?: SeeAll;
}

/**
 * The "See all results" href: the base is the first trigger's href, else the config's `results`, else "/search". With
 * the config's `seeAll`, the host builds it from the base, the state and the index; else seeAllHref.
 */
export function seeAllLink(cfg: SeeAllConfig, triggerHref: string | null | undefined, s: SeeAllState, index: string, baseURI: string): string {
	const base = triggerHref || cfg.results || "/search";
	return cfg.seeAll ? cfg.seeAll(base, s, index) : seeAllHref(base, s.query.trim(), baseURI);
}

export interface Shell {
	dialog: HTMLDialogElement;
	panel: HTMLElement;
	input: HTMLInputElement;
	close: HTMLElement;
	tablist: HTMLElement;
	/** The tabs' row: the tablist, then the toggle (shown on a narrow screen with data-fold) for the facets. */
	filters: HTMLElement;
	toggle: HTMLElement;
	facets: HTMLElement;
	body: HTMLElement;
	listbox: HTMLElement;
	message: HTMLElement;
	seeAll: HTMLAnchorElement;
	live: HTMLElement;
}

const SVG = "http://www.w3.org/2000/svg";

function icon(doc: Document, d: string): Node {
	// A stand-in document may not have createElementNS; the icon is decoration only.
	if (typeof doc.createElementNS !== "function") return doc.createTextNode("");
	const svg = doc.createElementNS(SVG, "svg");
	for (const [k, v] of Object.entries({ viewBox: "0 0 20 20", width: "20", height: "20", "aria-hidden": "true", focusable: "false", class: "icon" })) svg.setAttribute(k, v);
	const path = doc.createElementNS(SVG, "path");
	for (const [k, v] of Object.entries({ d, fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round" })) path.setAttribute(k, v);
	svg.append(path);
	return svg;
}

/** The fixed frame: header with the box, tabs, facets, the close button, results, footer and the live region. */
export function renderShell(doc: Document, ctx: RenderContext): Shell {
	const { strings } = ctx;
	const kbd = (key: string) => h(doc, "kbd", { part: "kbd" }, key);
	const input = h(doc, "input", {
		part: "input",
		type: "text",
		"aria-label": strings.placeholder,
		placeholder: strings.placeholder,
		spellcheck: "false",
		autocapitalize: "off",
		autocorrect: "off",
		enterkeyhint: "go",
		// Once here, not on each option: focus stays in the box.
		"aria-describedby": noticeId(ctx),
	}) as HTMLInputElement;
	const close = button(doc, { part: "close", "aria-label": strings.close }, icon(doc, "M5 5l10 10M15 5L5 15"));
	const tablist = h(doc, "div", { part: "tabs", hidden: "" });
	const facetsId = ctx.idFor("facets:");
	const facets = h(doc, "div", { part: "facets", id: facetsId, role: "group", "aria-label": strings.facetsLabel, hidden: "" });
	const toggle = button(doc, { part: "filters-toggle", "aria-expanded": "false", "aria-controls": facetsId }, h(doc, "span", {}), h(doc, "span", { class: "count" }), icon(doc, "M6 8l4 4 4-4"));
	const filters = h(doc, "div", { class: "filters" }, tablist, toggle);
	const listbox = h(doc, "div", { part: "results", role: "listbox", "aria-label": strings.dialogLabel, hidden: "" });
	const message = h(doc, "div", { class: "message" });
	const body = h(doc, "div", { class: "body" }, listbox, message);
	const seeAll = h(doc, "a", { part: "see-all", href: "", tabindex: "0", "aria-describedby": noticeId(ctx), ...linkTarget(ctx) }, strings.seeAll) as HTMLAnchorElement;
	const hints = h(
		doc,
		"p",
		// For sighted keyboard users; the combobox and dialog roles already tell a screen reader the keys.
		{ class: "hints", "aria-hidden": "true" },
		h(doc, "span", {}, kbd("↑"), kbd("↓"), ` ${strings.keys.move}`),
		h(doc, "span", {}, kbd("↵"), ` ${strings.keys.open}`),
		h(doc, "span", {}, kbd("esc"), ` ${strings.keys.close}`),
	);
	const notice = ctx.newTab && h(doc, "p", { part: "new-tab", id: noticeId(ctx) }, strings.newTab);
	const footer = h(doc, "div", { part: "footer" }, hints, notice, seeAll);
	const live = h(doc, "div", { part: "status", class: "visually-hidden" });
	const header = h(doc, "div", { part: "header" }, h(doc, "label", { class: "field" }, icon(doc, "M9 15.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM13.75 13.75L17.5 17.5"), input));
	// The close button sits after the tabs and facets, so Tab goes box, tabs, toggle, facets, close; CSS shows it in the header.
	const panel = h(doc, "div", { part: "panel" }, header, filters, facets, close, body, footer, live);
	const dialog = h(doc, "dialog", { part: "dialog" }, panel) as HTMLDialogElement;
	return { dialog, panel, input, close, tablist, filters, toggle, facets, body, listbox, message, seeAll, live };
}
