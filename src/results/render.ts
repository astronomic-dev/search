/**
 * The framework-free results page's markup, as pure functions from the controller's State to DOM nodes, for a shadow
 * root (the styles are results/styles.ts). It follows the kit's SearchPage: a <search> landmark with a plain GET form,
 * the type row, the facet rows, the count, the results (a breadcrumb, the title link, a two-line snippet, the matched
 * sections as sub-links with a hidden `#`), the message, "Show more results" and one polite live region.
 *
 * Record text only ever becomes text nodes and <mark> elements from highlight ranges, never markup. No listeners here:
 * Lists carry role="list": Safari drops list semantics under list-style: none. The mount wires actions by `data-action`, the tabs by role, and selection by `data-search-position`. Only
 * createElement, createTextNode, setAttribute and append are used, so a stand-in document runs these under node.
 */
import type { State } from "../controller/index.ts";
import { fill, type Strings } from "../controller/strings.ts";
import { own } from "../core/own.ts";
import type { IndexSettings, Ranges, ResultGroup, ResultItem, SearchRecord, SuggestedLink } from "../core/types.ts";
import { marked } from "../dom/marked.ts";
import { isSafeUrl } from "../dom/safe-url.ts";
import type { PageWords } from "../page/words.ts";

export interface BrowseLink {
	label: string;
	href: string;
}

export type HeadingTag = "h2" | "h3" | "h4";

export interface PageContext {
	strings: Strings;
	words: PageWords;
	/** The box's name, so the form with no JavaScript submits the query the server reads. */
	queryParam: string;
	/** The results URL: the form's action. */
	action: string;
	/** An element id for a name (unique within the shadow root). */
	idFor: (name: string) => string;
	typeLabel: (type: string) => string;
	facetLabel: (facet: string) => string;
	/** A page result's breadcrumb parts (crumbOf()); none draws no breadcrumb. */
	crumb: (record: SearchRecord) => string[];
	/** Links for the error state. */
	browse: BrowseLink[];
	/** The index's suggested links, for no results. */
	suggested?: SuggestedLink[];
	/** The results' title level; grouped, the group label takes it and the titles one below. Default h2. */
	headingTag?: HeadingTag;
}

export interface PageShell {
	root: HTMLElement;
	form: HTMLFormElement;
	input: HTMLInputElement;
	submit: HTMLButtonElement;
	typeRow: HTMLElement;
	tablist: HTMLElement;
	facets: HTMLElement;
	/** The results area: a named group around the panel, which a script can focus (the panel's role comes and goes with the tabs). */
	area: HTMLElement;
	panel: HTMLElement;
	count: HTMLElement;
	list: HTMLElement;
	message: HTMLElement;
	more: HTMLButtonElement;
	live: HTMLElement;
}

type Child = Node | string | null | undefined | false;

function h(doc: Document, tag: string, attrs: Record<string, string | undefined>, ...children: Child[]): HTMLElement {
	const el = doc.createElement(tag);
	for (const [name, value] of Object.entries(attrs)) if (value !== undefined) el.setAttribute(name, value);
	for (const c of children) if (c !== null && c !== undefined && c !== false && c !== "") el.append(c);
	return el;
}

/** Record text with <mark part="mark"> around each range. */
function text(doc: Document, tag: string, attrs: Record<string, string | undefined>, value: string, ranges: Ranges = []): HTMLElement {
	const el = h(doc, tag, attrs);
	el.append(...marked(doc, value, ranges));
	return el;
}

function button(doc: Document, attrs: Record<string, string | undefined>, ...children: Child[]): HTMLElement {
	// tabindex: WebKit on macOS skips plain buttons on Tab without one.
	return h(doc, "button", { type: "button", tabindex: "0", ...attrs }, ...children);
}

const SVG = "http://www.w3.org/2000/svg";

function icon(doc: Document, d: string): Node {
	// A stand-in document may not have createElementNS; the icon is decoration only.
	if (typeof doc.createElementNS !== "function") return doc.createTextNode("");
	const svg = doc.createElementNS(SVG, "svg");
	for (const [k, v] of Object.entries({ viewBox: "0 0 20 20", width: "20", height: "20", "aria-hidden": "true", focusable: "false", part: "icon" })) svg.setAttribute(k, v);
	const path = doc.createElementNS(SVG, "path");
	for (const [k, v] of Object.entries({ d, fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round" })) path.setAttribute(k, v);
	svg.append(path);
	return svg;
}

/**
 * A page result's breadcrumb, from the index settings: its type's label, then each facet's value labels in the
 * settings' order; a record with no facet value reads its type alone. A label the settings lack shows as written.
 */
export function crumbOf(record: SearchRecord, settings: Pick<IndexSettings, "types" | "facets"> | null | undefined): string[] {
	const out = [own(settings?.types, record.type)?.label ?? record.type];
	for (const [facet, setting] of Object.entries(settings?.facets ?? {})) {
		const labels = (own(record.facets, facet) ?? []).map((v) => own(setting.values, v) ?? v).filter(Boolean);
		if (labels.length) out.push(labels.join(", "));
	}
	return out;
}

/** The fixed frame, in page order (the Tab order): the form, the type row, the facets, then the results panel. */
export function renderPage(doc: Document, ctx: PageContext): PageShell {
	const { strings, words } = ctx;
	const inputId = ctx.idFor("input");
	const input = h(doc, "input", {
		id: inputId,
		part: "input",
		type: "search",
		name: ctx.queryParam,
		placeholder: strings.placeholder,
		spellcheck: "false",
		autocapitalize: "off",
		autocorrect: "off",
		autocomplete: "off",
		enterkeyhint: "search",
	}) as HTMLInputElement;
	const submit = h(doc, "button", { type: "submit", tabindex: "0", part: "submit" }, words.submit) as HTMLButtonElement;
	const form = h(
		doc,
		"form",
		{ method: "get", action: ctx.action, part: "form" },
		h(doc, "label", { for: inputId, class: "visually-hidden" }, words.label),
		h(doc, "div", { part: "field" }, icon(doc, "M9 15.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM13.75 13.75L17.5 17.5"), input),
		submit,
	) as HTMLFormElement;
	const tablist = h(doc, "div", { part: "tabs pills", "aria-label": strings.typesLabel });
	// The visible "Type" is decoration; the tablist keeps its own name.
	const typeRow = h(doc, "div", { part: "type-row filter-row", hidden: "" }, h(doc, "span", { part: "filter-label", "aria-hidden": "true" }, words.typeText), tablist);
	const facets = h(doc, "div", { part: "facets", role: "group", "aria-label": strings.facetsLabel, hidden: "" });
	const count = h(doc, "p", { part: "count", hidden: "" });
	const list = h(doc, "div", { part: "list" });
	const message = h(doc, "div", { part: "message" });
	const more = button(doc, { part: "more", hidden: "" }, words.showMore) as HTMLButtonElement;
	const panel = h(doc, "div", { part: "panel" }, count, list, message, h(doc, "div", { class: "more-row" }, more));
	// Its name is the count's own word with no number ("results"), so it is in the site's language.
	const area = h(doc, "div", { part: "area", role: "group", tabindex: "-1", "aria-label": fill(strings.results.other, { count: "" }).trim() }, panel);
	const live = h(doc, "div", { part: "status", role: "status", "aria-live": "polite", class: "visually-hidden" });
	const root = h(doc, "search", { role: "search", part: "page" }, h(doc, "div", { part: "head" }, form, typeRow, facets), area, live);
	return { root, form, input, submit, typeRow, tablist, facets, area, panel, count, list, message, more, live };
}

function setLink(a: HTMLElement, record: SearchRecord, position: number): void {
	// Only a relative or http(s) URL becomes a link; any other scheme draws as text.
	if (record.url !== undefined && isSafeUrl(record.url)) a.setAttribute("href", record.url);
	a.setAttribute("data-search-position", String(position));
}

/** One result: the breadcrumb, the title link, the snippet and the matched sections as sub-links. */
export function renderResult(doc: Document, item: ResultItem, ctx: PageContext, next: () => number, titleTag: string): HTMLElement {
	const li = h(doc, "li", { part: "result" });
	const parts = ctx.crumb(item.page).filter(Boolean);
	if (parts.length) {
		const crumb = h(doc, "p", { part: "crumb" });
		parts.forEach((p, i) => {
			if (i > 0) crumb.append(h(doc, "span", { part: "crumb-sep", "aria-hidden": "true" }, ctx.words.crumbMark));
			crumb.append(h(doc, "span", {}, p));
		});
		li.append(crumb);
	}
	const link = text(doc, "a", { part: "link", tabindex: "0" }, item.page.title, item.highlight.title);
	setLink(link, item.page, next());
	li.append(h(doc, titleTag, { part: "title" }, link));
	if (item.highlight.snippet.text) li.append(text(doc, "p", { part: "snippet" }, item.highlight.snippet.text, item.highlight.snippet.ranges));
	if (item.headings.length) {
		const list = h(doc, "ul", { part: "headings", role: "list" });
		for (const sub of item.headings) {
			const a = h(
				doc,
				"a",
				{ part: "heading-link", tabindex: "0" },
				h(doc, "span", { part: "heading-mark", "aria-hidden": "true" }, ctx.words.headingMark),
				text(doc, "span", { part: "heading-title" }, sub.record.heading ?? sub.record.title, sub.highlight.heading ?? sub.highlight.title),
			);
			setLink(a, sub.record, next());
			const row = h(doc, "li", { part: "heading" }, a);
			if (sub.highlight.snippet.text) row.append(text(doc, "p", { part: "heading-snippet" }, sub.highlight.snippet.text, sub.highlight.snippet.ranges));
			list.append(row);
		}
		li.append(list);
	}
	return li;
}

export interface ListOptions {
	/** A group's count beside its label: its type's or value's match count, else the pages shown. */
	count: (key: string, shown: number) => number;
	/** The position of the first result, less one (after "Show more results", the ones already drawn). Default 0. */
	start?: number;
}

/** The results: one list, or a section per group under its label, the titles one level down. Positions run in screen order. */
export function renderList(doc: Document, groups: ResultGroup[], ctx: PageContext, options: ListOptions): HTMLElement[] {
	let n = options.start ?? 0;
	const next = () => ++n;
	const tag = ctx.headingTag ?? "h2";
	const grouped = groups.some((g) => g.key !== "");
	const sub = `h${Math.min(6, Number(tag.slice(1)) + 1)}`;
	const out: HTMLElement[] = [];
	for (const g of groups) {
		const list = h(doc, "ol", { part: "results", role: "list" });
		for (const item of g.items) list.append(renderResult(doc, item, ctx, next, grouped ? sub : tag));
		if (!grouped) {
			out.push(list);
			continue;
		}
		const labelId = ctx.idFor(`group:${g.key}`);
		const label = h(
			doc,
			"div",
			{ part: "group-label" },
			h(doc, tag, { id: labelId, part: "group-name" }, g.key === "" ? ctx.strings.other : g.label),
			h(doc, "span", { part: "group-count" }, String(options.count(g.key, g.items.length))),
		);
		out.push(h(doc, "section", { part: "group", "aria-labelledby": labelId }, label, list));
	}
	return out;
}

/** A pill's name and, once there is a result, its count. */
function pillBody(doc: Document, name: string, count: number | null): Child[] {
	return [h(doc, "span", { class: "name" }, name), count !== null && h(doc, "span", { class: "count" }, String(count))];
}

/** The type tabs: All, then each type with a match (or the selected one); every type before a result. */
export function renderTabs(doc: Document, state: State, ctx: PageContext, types: string[]): HTMLElement[] {
	const counts = new Map((state.result?.types ?? []).map((t) => [t.value, t.count]));
	const has = state.result !== null;
	const total = types.reduce((n, t) => n + (counts.get(t) ?? 0), 0);
	const shown = types.filter((t) => !has || (counts.get(t) ?? 0) > 0 || t === state.type);
	const selected = state.type !== null && shown.includes(state.type) ? state.type : "";
	const tab = (value: string, label: string, count: number) =>
		h(
			doc,
			"button",
			{ type: "button", role: "tab", part: "tab pill", "data-type": value, "data-key": `tab:${value}`, "aria-selected": String(value === selected), tabindex: value === selected ? "0" : "-1" },
			...pillBody(doc, label, has ? count : null),
		);
	return [tab("", ctx.strings.allTypes, total), ...shown.map((t) => tab(t, ctx.typeLabel(t), counts.get(t) ?? 0))];
}

/** One labeled row of toggle buttons per facet: values with matches, and every picked value. None without the capability. */
export function renderFacets(doc: Document, state: State, ctx: PageContext): HTMLElement[] {
	if (!state.capabilities?.facets || !state.result) return [];
	const out: HTMLElement[] = [];
	for (const [facet, values] of Object.entries(state.result.facets)) {
		const shown = values.filter((v) => v.count > 0 || v.picked);
		if (!shown.length) continue;
		const labelId = ctx.idFor(`facet:${facet}`);
		const pills = h(doc, "div", { part: "pills" });
		for (const v of shown) {
			pills.append(
				button(
					doc,
					{ part: "facet pill", "aria-pressed": String(v.picked), "data-action": "facet", "data-facet": facet, "data-value": v.value, "data-key": `facet:${facet}:${v.value}` },
					...pillBody(doc, v.label, v.count),
				),
			);
		}
		out.push(h(doc, "div", { role: "group", part: "facet-group filter-row", "aria-labelledby": labelId }, h(doc, "span", { part: "filter-label", id: labelId }, ctx.facetLabel(facet)), pills));
	}
	return out;
}

/** A labeled row of plain links, the ones it can follow; null when none. */
function links(doc: Document, label: string, id: string, items: BrowseLink[]): HTMLElement | null {
	const safe = items.filter((l) => typeof l?.href === "string" && isSafeUrl(l.href));
	if (!safe.length) return null;
	return h(
		doc,
		"div",
		{ class: "links" },
		h(doc, "p", { part: "label", id }, label),
		h(doc, "ul", { role: "list", "aria-labelledby": id }, ...safe.map((l) => h(doc, "li", {}, h(doc, "a", { href: l.href, tabindex: "0", part: "text-link" }, l.label)))),
	);
}

/** The message under the results: the error state, loading, or no results. Null when there is none. */
export function renderMessage(doc: Document, state: State, ctx: PageContext): HTMLElement | null {
	const { strings } = ctx;
	const q = state.query.trim();
	if (state.status === "error") {
		return h(
			doc,
			"div",
			{ part: "error" },
			h(doc, "p", { class: "lead" }, strings.unavailable),
			button(doc, { part: "action pill", "data-action": "retry", "data-key": "retry" }, strings.retry),
			links(doc, strings.browse, ctx.idFor("label:browse"), ctx.browse),
		);
	}
	if (!q) return null;
	if (state.status === "loading" || state.status === "idle") return h(doc, "p", { part: "loading" }, strings.loading);
	if (state.result && state.result.total === 0) {
		const narrowed = state.type !== null || Object.keys(state.picks).length > 0;
		return h(
			doc,
			"div",
			{ part: "empty" },
			h(
				doc,
				"div",
				{ class: "stack" },
				h(doc, "p", { class: "lead" }, fill(strings.noResults, { query: q })),
				narrowed && button(doc, { part: "action pill", "data-action": "all-types", "data-key": "all-types" }, strings.searchAllTypes),
			),
			links(doc, strings.suggested, ctx.idFor("label:suggested"), ctx.suggested ?? []),
		);
	}
	return null;
}
