/**
 * Astro content collections as search records. The settings are serializable (they go to the records route through a
 * virtual module); the route calls `getCollection` and `render`, and `entryRecords` turns one entry into records.
 */
import { buildLocale } from "../core/locale.ts";
import { squash } from "../core/text.ts";
import type { SearchRecord, SourcedRecord } from "../core/types.ts";
import { cleanUrl, type UrlOptions } from "../core/url.ts";
import { markdownSections, type RenderedHeading } from "./sections.ts";

export interface CollectionSpec {
	/** The records' type, so two collections can share one (a site's `hubs` are Learn). Default: the collection's name. */
	type?: string;
	/** The type's label, for tabs and group headings. Default: the label another collection of the same type sets, else the type, capitalized. */
	label?: string;
	/** "{id}" and "{slug}" in a pattern. Default "/<collection>/{id}". */
	url?: string;
	/** A data field per facet, or "id:0" for the first part of the entry's id ("vega/search" gives "vega"). The array form reads the field of the same name. */
	facets?: string[] | Record<string, string>;
	/** Extra data fields indexed as page text, for data-only collections (themes .yaml). */
	fields?: string[];
	/** Data field for the title. Default "title". */
	title?: string;
	/** Heading depths that start a section. Default [2, 3]. */
	depths?: number[];
	/** Data field for the page's keywords: an array of strings or a comma-separated string. Default "searchKeywords"; false turns it off. */
	keywords?: string | false;
	/**
	 * Which entries to index: called once per entry (drafts and `noindex` ones are already left out), and an entry is
	 * indexed when it returns true. It runs after the build, in the integration, so `data` is the entry's data as JSON
	 * (a date is an ISO string).
	 */
	filter?: (entry: FilterEntry) => boolean;
}

/** What a collection's `filter` sees of an entry. */
export interface FilterEntry {
	id: string;
	collection: string;
	/** The entry's data as JSON: a date is an ISO string. */
	data: Record<string, unknown>;
}

/** Facet names a source may not take: the search page reads `type` as the content type and `q` as the query. */
export const RESERVED_FACETS: Record<string, string> = { type: "it is the content type", q: "the search page reads it as the query" };

/** Fails on a reserved facet name. */
export function checkFacetName(where: string, name: string): void {
	if (Object.hasOwn(RESERVED_FACETS, name)) throw new Error(`Search: ${where}: a facet may not be named "${name}" (${RESERVED_FACETS[name]})`);
}

export interface CollectionsSource {
	kind: "collections";
	specs: Record<string, CollectionSpec>;
}

/** The collections to index, by name. The records' type is the spec's `type`, else the collection's name. */
export function collections(specs: Record<string, CollectionSpec>): CollectionsSource {
	if (!specs || typeof specs !== "object" || Array.isArray(specs)) throw new Error("Search: collections() takes an object of collection names");
	for (const [name, spec] of Object.entries(specs)) {
		facetFields(name, spec ?? {});
		const k = spec?.keywords;
		if (k !== undefined && k !== false && (typeof k !== "string" || k === "")) throw new Error(`Search: collection "${name}": keywords must be a field name or false`);
		const t = spec?.type;
		if (t !== undefined && (typeof t !== "string" || t.trim() === "")) throw new Error(`Search: collection "${name}": type must be a non-empty string`);
		if (spec?.filter !== undefined && typeof spec.filter !== "function") throw new Error(`Search: collection "${name}": filter must be a function (entry) => boolean`);
	}
	typeLabels([{ kind: "collections", specs }]);
	return { kind: "collections", specs };
}

/** The type a collection's records get. */
export const collectionType = (collection: string, spec: CollectionSpec | undefined) => spec?.type ?? collection;

/**
 * The label each collection type sets, across sources: a spec's `label`, else none. Fails when two collections of
 * one type set different labels.
 */
export function typeLabels(sources: CollectionsSource[]): Map<string, string | undefined> {
	const out = new Map<string, string | undefined>();
	const from = new Map<string, string>();
	for (const source of sources) {
		for (const [collection, spec] of Object.entries(source.specs)) {
			const type = collectionType(collection, spec);
			const label = spec?.label;
			const had = out.get(type);
			if (label !== undefined && had !== undefined && had !== label) {
				throw new Error(`Search: collections "${from.get(type)}" and "${collection}" share the type "${type}" but have different labels ("${had}" and "${label}"); set the label on one of them, or the same on both`);
			}
			if (label !== undefined && had === undefined) from.set(type, collection);
			out.set(type, had ?? label);
		}
	}
	return out;
}

/** The part of a collection entry the adapter reads. */
export interface EntryLike {
	id: string;
	collection: string;
	data: Record<string, unknown>;
	/** The raw Markdown or MDX body, without frontmatter. Missing for data-only entries. */
	body?: string;
}

export interface EntryContext {
	urlOptions: UrlOptions;
	defaultLocale: string;
	/** The site's locales (Astro's `i18n.locales`). Default: the default locale alone. */
	locales?: string[];
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Facet name -> where its value comes from. Fails on a reserved facet name ("type", "q"). */
export function facetFields(collection: string, spec: CollectionSpec): Record<string, string> {
	const facets = spec.facets ?? {};
	const out: Record<string, string> = Array.isArray(facets) ? Object.fromEntries(facets.map((f) => [f, f])) : { ...facets };
	for (const name of Object.keys(out)) checkFacetName(`collection "${collection}"`, name);
	return out;
}

/** A data value as a list of non-empty strings. */
function strings(v: unknown): string[] {
	const list = Array.isArray(v) ? v : [v];
	return list.filter((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean").map((x) => squash(String(x))).filter((x) => x !== "");
}

/** Keywords from a data value: an array of strings, or one string split on commas. Trimmed, empty ones left out. */
export function keywordList(v: unknown): string[] {
	if (typeof v === "string") return v.split(",").map(squash).filter((x) => x !== "");
	return Array.isArray(v) ? strings(v) : [];
}

function facetValue(entry: EntryLike, from: string): string[] {
	const part = from.match(/^id:(\d+)$/);
	if (part) return strings(entry.id.split("/")[Number(part[1])]);
	return strings(entry.data[from]);
}

/**
 * One entry as records: a page record and one heading record per section, or null when the entry is a draft or
 * `noindex`. A Markdown entry whose headings do not match the rendered ones gives its page alone, with a warning.
 */
export function entryRecords(entry: EntryLike, headings: RenderedHeading[] | undefined, spec: CollectionSpec, ctx: EntryContext): { records: SourcedRecord[]; warnings: string[] } | null {
	const { data } = entry;
	if (data.draft === true || data.noindex === true) return null;
	const origin = `collection "${entry.collection}" entry "${entry.id}"`;
	const warnings: string[] = [];

	const locale = buildLocale(typeof data.locale === "string" ? data.locale : undefined, ctx.defaultLocale, ctx.locales);
	const slug = typeof data.slug === "string" && data.slug ? data.slug : entry.id;
	const pattern = spec.url ?? `/${entry.collection}/{id}`;
	const raw = pattern.replaceAll("{id}", entry.id).replaceAll("{slug}", slug);
	const url = cleanUrl(raw, ctx.urlOptions);
	// As the HTML scan treats a canonical link to another site: never a result that leaves the site.
	if (url === null) throw new Error(`Search: ${origin}: its URL ${raw} is not on this site (from the url pattern "${pattern}"); check the pattern and the entry's slug`);
	const pageId = `${locale}:${url}`;

	const facets: Record<string, string[]> = {};
	for (const [name, from] of Object.entries(facetFields(entry.collection, spec))) {
		const values = facetValue(entry, from);
		if (values.length > 0) facets[name] = [...new Set(values)];
	}
	const title = strings(data[spec.title ?? "title"])[0] ?? "";
	const fields = (spec.fields ?? []).flatMap((f) => strings(data[f]));
	const base = { locale, type: collectionType(entry.collection, spec), title, facets, source: "collection" as const };

	let intro = "";
	const heads: SearchRecord[] = [];
	if (typeof entry.body === "string") {
		const sections = markdownSections(entry.body, headings ?? [], spec.depths);
		if (sections) {
			intro = sections.intro;
			for (const s of sections.sections) {
				// Through cleanUrl too, so a Unicode anchor ("#überblick") is percent-encoded as the schema wants.
				const hraw = `${url}#${s.anchor}`;
				const hurl = cleanUrl(hraw, ctx.urlOptions) ?? hraw;
				heads.push({ id: `${locale}:${hurl}`, kind: "heading", pageId, url: hurl, heading: s.heading, text: s.text, ...base });
			}
		} else {
			warnings.push(`Search: ${origin}: its headings do not match the rendered ones, so it is indexed as one page with no sections`);
			intro = markdownSections(entry.body, [], [])?.intro ?? "";
		}
	}
	const keywords = spec.keywords === false ? [] : keywordList(data[spec.keywords ?? "searchKeywords"]);
	const page: SearchRecord = { id: pageId, kind: "page", url, text: squash([...fields, intro].join(" ")), ...base, ...(keywords.length > 0 ? { keywords } : {}) };
	// Key order as in SearchRecord, so files are stable and easy to read.
	const order = (r: SearchRecord): SearchRecord => {
		const { id, kind, pageId: p, locale: l, type, url: u, title: t, heading, text, facets: f, keywords: k, source } = r;
		return { id, kind, ...(p ? { pageId: p } : {}), locale: l, type, url: u, title: t, ...(heading !== undefined ? { heading } : {}), text, facets: f, ...(k ? { keywords: k } : {}), source } as SearchRecord;
	};
	return { records: [page, ...heads].map((record) => ({ record: order(record), origin })), warnings };
}
