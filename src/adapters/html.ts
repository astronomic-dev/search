/**
 * A scan of the built HTML pages, for pages that no collection gives (a home page, pricing). Runs in Node after the
 * build, over Astro's output folder. In dev there is no output, so it gives nothing.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { DOCUMENT_NODE, ELEMENT_NODE, parse, type Node } from "ultrahtml";
import { querySelectorAll } from "ultrahtml/selector";
import type { SearchRecord, SourcedRecord } from "../core/types.ts";
import { buildLocale } from "../core/locale.ts";
import { matchPath } from "../core/match-path.ts";
import { squash } from "../core/text.ts";
import { cleanUrl, type UrlOptions } from "../core/url.ts";
import { find as findShown, htmlSections, textOf } from "./sections.ts";

export interface HtmlOptions {
	/** Paths to scan: exact ("/pricing"), where each "*" segment is any one segment ("/ui/components/*"). Default: every page. */
	include?: string[];
	/** Paths to leave out, in the same form. "/404" and "/500" are always left out. */
	exclude?: string[];
	/** The records' type. Default "pages". */
	type?: string;
	/** The type's label. Default "Pages". */
	label?: string;
	/** A CSS selector for the page's searchable part. Default `[data-search-body]`, else `main`, else the body. */
	selector?: string;
}

export interface HtmlSource extends HtmlOptions {
	kind: "html";
}

export interface ScanContext {
	urlOptions: UrlOptions;
	defaultLocale: string;
	/** The site's locales (Astro's `i18n.locales`). Default: the default locale alone. */
	locales?: string[];
}

const KEYS = new Set(["include", "exclude", "type", "label", "selector"]);
const ALWAYS_OUT = ["/404", "/500"];

export function html(options: HtmlOptions = {}): HtmlSource {
	for (const key of Object.keys(options)) if (!KEYS.has(key)) throw new Error(`Search: html() has no setting "${key}" (known: ${[...KEYS].join(", ")})`);
	return { kind: "html", ...options };
}

// ultrahtml 1.7.0 ends a tag at the first ">", even inside a quoted attribute value (Tailwind classes such as
// "[&>*+*]:mt-5" have them, and single-quoted ones such as x-data='a>b'). Escape those first so the tree is right.
// One pass over both quote kinds, so a quote of the other kind inside a value is part of that value.
const escapeAttributes = (s: string) =>
	s.replace(/(\s[^\s=<>"']+\s*=\s*)(?:"([^"]*)"|'([^']*)')/g, (m, k: string, dq: string | undefined, sq: string | undefined) => {
		const v = dq ?? sq ?? "";
		if (!v.includes(">")) return m;
		const q = dq === undefined ? "'" : '"';
		return `${k}${q}${v.replaceAll(">", "&gt;")}${q}`;
	});

function find(node: Node, test: (n: Node) => boolean, out: Node[] = []): Node[] {
	for (const child of (node.children ?? []) as Node[]) {
		if (child.type !== ELEMENT_NODE) continue;
		if (test(child)) out.push(child);
		find(child, test, out);
	}
	return out;
}
const first = (node: Node, test: (n: Node) => boolean) => find(node, test)[0];
const attr = (n: Node | undefined, name: string): string | undefined => (n?.attributes as Record<string, string> | undefined)?.[name];

/** `docs/x/index.html` is `/docs/x`, `pricing.html` is `/pricing`, `index.html` is `/` (no base). */
export function pathFromFile(dir: string, file: string): string {
	const rel = relative(dir, file).split(sep).join("/").replace(/\.html$/i, "");
	if (rel === "index") return "/";
	return `/${rel.replace(/\/index$/i, "")}`;
}

/** One built page as records, or null when it is `noindex` or a redirect. `path` is the page's path without the base. */
export function pageRecords(source: string, path: string, options: HtmlOptions, ctx: ScanContext, origin: string): SourcedRecord[] | null {
	const doc = parse(escapeAttributes(source));
	const head = (name: string, test: (n: Node) => boolean) => first(doc, (n) => n.name === name && test(n));
	const robots = find(doc, (n) => n.name === "meta" && attr(n, "name")?.toLowerCase() === "robots");
	if (robots.some((n) => /\bnoindex\b/i.test(attr(n, "content") ?? ""))) return null;
	if (head("meta", (n) => attr(n, "http-equiv")?.toLowerCase() === "refresh")) return null;

	const own = cleanUrl(path, ctx.urlOptions);
	if (own === null) return null;
	const canonicalHref = attr(head("link", (n) => (attr(n, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")), "href");
	const canonical = canonicalHref ? cleanUrl(canonicalHref, ctx.urlOptions) : null;
	const url = (canonical ?? own).replace(/#.*$/, "");

	const lang = attr(first(doc, (n) => n.name === "html"), "lang")?.trim();
	const locale = buildLocale(lang, ctx.defaultLocale, ctx.locales);
	// Not one in a dialog or another dropped part.
	const h1 = findShown(doc, (n) => n.name === "h1")[0];
	const titleTag = first(doc, (n) => n.name === "title");
	const title = (h1 && textOf(h1)) || (titleTag && textOf(titleTag)) || url;

	let root: Node = doc;
	if (options.selector) {
		// The outermost matches outside dropped parts (a search dialog's markup above all).
		const matches = new Set(querySelectorAll(doc, options.selector));
		root = { type: DOCUMENT_NODE, children: findShown(doc, (n) => matches.has(n)), attributes: {} } as unknown as Node;
	}
	const { intro, sections } = htmlSections(root);

	const keywordsMeta = attr(head("meta", (n) => attr(n, "name")?.toLowerCase() === "search:keywords"), "content");
	const keywords = (keywordsMeta ?? "").split(",").map(squash).filter((k) => k !== "");

	const pageId = `${locale}:${url}`;
	const type = options.type ?? "pages";
	const out: SearchRecord[] = [{ id: pageId, kind: "page", locale, type, url, title, text: intro, facets: {}, ...(keywords.length > 0 ? { keywords } : {}), source: "html" }];
	// Keyed by the canonical url, so two spellings of one anchor ("über", "%C3%BCber") are one record.
	const byUrl = new Map<string, SearchRecord>();
	for (const s of sections) {
		const raw = `${url}#${s.anchor}`;
		const hurl = cleanUrl(raw, ctx.urlOptions) ?? raw;
		const known = byUrl.get(hurl);
		if (known) {
			// A repeated id: one anchor, so one record; its text joins the first one's.
			known.text = `${known.text} ${s.heading} ${s.text}`.trim();
			continue;
		}
		const r: SearchRecord = { id: `${locale}:${hurl}`, kind: "heading", pageId, locale, type, url: hurl, title, heading: s.heading || s.anchor, text: s.text, facets: {}, source: "html" };
		byUrl.set(hurl, r);
		out.push(r);
	}
	return out.map((record) => ({ record, origin }));
}

/**
 * Pages whose canonical points to another scanned page (the second page of a list with `rel=canonical` to the first)
 * are copies of it: of the pages that share one id, the one whose canonical is its own url is kept, else the first.
 * A page alone keeps its canonical url ("/pricing" with canonical "/plans" is "/plans").
 */
function dropCanonicalCopies<T extends { own: string | null; records: SourcedRecord[] }>(pages: T[]): T[] {
	const byId = new Map<string, T[]>();
	for (const p of pages) {
		const id = p.records[0]?.record.id ?? "";
		const list = byId.get(id);
		if (list) list.push(p);
		else byId.set(id, [p]);
	}
	const keep = new Set<T>();
	for (const list of byId.values()) {
		const self = list.find((p) => p.own === p.records[0]?.record.url);
		keep.add(self ?? (list[0] as T));
	}
	return pages.filter((p) => keep.has(p));
}

async function htmlFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) out.push(join(entry.parentPath, entry.name));
	}
	return out.sort();
}

/** Every built page in `dir` that the source's include and exclude allow, as records. */
export async function scanHtml(dir: string, source: HtmlOptions, ctx: ScanContext): Promise<{ records: SourcedRecord[] }> {
	const pages: { own: string | null; records: SourcedRecord[] }[] = [];
	const exclude = [...ALWAYS_OUT, ...(source.exclude ?? [])];
	for (const file of await htmlFiles(dir)) {
		const path = pathFromFile(dir, file);
		if (source.include && !matchPath(path, source.include)) continue;
		if (matchPath(path, exclude)) continue;
		const origin = relative(dir, file).split(sep).join("/");
		const page = pageRecords(await readFile(file, "utf8"), path, source, ctx, origin);
		if (page) pages.push({ own: cleanUrl(path, ctx.urlOptions), records: page });
	}
	return { records: dropCanonicalCopies(pages).flatMap((p) => p.records) };
}
