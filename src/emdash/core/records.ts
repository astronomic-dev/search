/**
 * EmDash entries to search records: one page record per published entry (plan decisions 2-4).
 *
 * - Only `status: "published"` entries, and not `seo.noIndex`. An entry whose public path is null (not
 *   routable, no slug) is skipped and counted.
 * - The URL is the one EmDash's `getPublicUrl` gives. With `content.urlRules()` the core builds it from the
 *   listed row and its collection (`entryPath`, a copy of EmDash 1.4's resolver), so a build needs no query
 *   per entry (D1 allows 50 queries per run on Workers Free, 1,000 on Paid). Without it, one
 *   `content.publicPath` call per entry.
 * - Query budget on D1 (EmDash 1.4, counted in its source). A `content.list` page (100 rows, EmDash's cap)
 *   is 2 queries (rows and count), plus 1 for the SEO check and, on a collection with SEO, 2 more (SEO rows,
 *   50 ids a query): 3 to 5 per 100 entries. A build adds about 12-16 KV queries (state, lease, one per
 *   1.5 MB chunk, publish, clean-up) and the collection list. So 1,000 entries take about 45-65 queries and
 *   10,000 about 320-520 (it was 2 per entry more through `getPublicUrl`: about 2,050 and 20,400).
 *   Workers Paid (1,000 per run) fits about 19,000 entries with SEO, 32,000 without; Workers Free (50 per
 *   run) fits about 1,200 entries without SEO, 700 with.
 * - Text: the first of `excerpt`, `summary`, `description`, `seo.description`, then the plain text of the
 *   Portable Text `content` (every block, headings too). No heading records: EmDash's renderer prints no
 *   heading ids, and the package takes anchors only from what the page renders.
 * - Keywords: the `search_keywords` field (an array or a comma list), or `searchKeywords`.
 *
 * Platform-free: no `emdash`, `node:*`, `react` or `astro` imports.
 */
import { squash } from "../../core/text.ts";
import type { PageRecord, SearchRecord } from "../../core/types.ts";
import type { CollectionInfo, ContentPort, EmDashEntry, PluginOptions, SchemaPort, UrlRules } from "./ports.ts";

export interface CollectResult {
	/** Records per locale, in collection then list order. */
	byLocale: Record<string, SearchRecord[]>;
	/** Per type (the collection slug): its label, from the collection's label. */
	types: Record<string, { label: string }>;
	/** Entries skipped because they have no public path. */
	skipped: number;
	warnings: string[];
}

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** The first value that is a non-empty string. */
function firstText(...values: unknown[]): string | undefined {
	for (const v of values) if (isText(v)) return v;
	return undefined;
}

/** Plain text of Portable Text: the spans of every block, blocks joined by a space. Anything else gives "". */
export function portableTextToPlain(value: unknown): string {
	if (!Array.isArray(value)) return "";
	const blocks: string[] = [];
	for (const block of value) {
		if (!block || typeof block !== "object") continue;
		const children = (block as { children?: unknown }).children;
		if (!Array.isArray(children)) continue;
		const text = children.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("");
		if (text.trim()) blocks.push(text);
	}
	return squash(blocks.join(" "));
}

/** Keywords from an array of strings or a comma list, each squashed, empty ones dropped (as `collections()`). */
export function keywordList(v: unknown): string[] {
	const list = typeof v === "string" ? v.split(",") : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	return list.map(squash).filter((x) => x !== "");
}

/** Published and not `seo.noIndex`. Scheduled entries wait until they are published. */
export const isIndexable = (e: EmDashEntry): boolean => e.status === "published" && e.seo?.noIndex !== true;

/** The page record of one entry at its public path. */
export function entryRecord(e: EmDashEntry, url: string, defaultLocale: string): PageRecord {
	const d = e.data ?? {};
	const locale = isText(e.locale) ? e.locale : defaultLocale;
	const title = squash(firstText(d.title, d.name, e.seo?.title, e.slug) ?? e.id);
	const lead = firstText(d.excerpt, d.summary, d.description, e.seo?.description) ?? "";
	const text = squash(`${lead} ${portableTextToPlain(d.content)}`);
	// EmDash field slugs are lowercase (`search_keywords`); `searchKeywords` is kept as an alias.
	const keywords = keywordList(d.search_keywords ?? d.searchKeywords);
	return { id: `${locale}:${url}`, kind: "page", locale, type: e.type, url, title, text, facets: {}, source: "emdash", ...(keywords.length > 0 ? { keywords } : {}) };
}

// ---------------------------------------------------------------------------
// Public paths: a copy of EmDash 1.4's resolver (`i18n/resolve.ts`, `plugins/content-access.ts`
// `getPublicUrl`). EmDash does not export it to plugins. `test/emdash-urls.test.ts` checks it against
// EmDash's own function.
// ---------------------------------------------------------------------------

const REPEATED_SLASHES = /\/{2,}/g;
const TRAILING_SLASH = /\/$/;
const DATE_TOKEN = /\{(year|month|day|hour|minute|second)\}/g;
/** SQLite datetime with no zone ("2023-05-08 10:00:00"): stored as UTC. */
const OFFSETLESS_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** `/a//b/` to `/a/b`, always starting with "/". */
function normalizePath(path: string): string {
	let p = path.replace(REPEATED_SLASHES, "/");
	if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
	if (!p.startsWith("/")) p = `/${p}`;
	return p;
}

/** `{year}` ... `{second}` from the publish date (UTC, zero-padded); left as written with no valid date. */
function applyDateTokens(path: string, date: string | null | undefined): string {
	if (date == null) return path;
	const offsetless = OFFSETLESS_DATETIME.exec(date);
	const d = new Date(offsetless ? `${offsetless[1]}T${offsetless[2]}Z` : date);
	if (Number.isNaN(d.getTime())) return path;
	const parts: Record<string, string> = {
		year: String(d.getUTCFullYear()),
		month: pad2(d.getUTCMonth() + 1),
		day: pad2(d.getUTCDate()),
		hour: pad2(d.getUTCHours()),
		minute: pad2(d.getUTCMinutes()),
		second: pad2(d.getUTCSeconds()),
	};
	return path.replace(DATE_TOKEN, (match, key: string) => parts[key] ?? match);
}

/** The collection's URL pattern (or `/<collection>/{slug}`) with `{slug}`, `{id}` and the date tokens filled in. */
function interpolate(pattern: string | null, collection: string, slug: string, id: string, date: string | null | undefined): string {
	const base = pattern ?? `/${encodeURIComponent(collection)}/{slug}`;
	const path = applyDateTokens(base.replaceAll("{slug}", encodeURIComponent(slug)).replaceAll("{id}", encodeURIComponent(id)), date);
	return normalizePath(path);
}

/**
 * The URL segment of a locale. Null: i18n is off (no prefix). "": the default locale with
 * `prefixDefaultLocale` off. Undefined: the locale is not configured, so the site cannot serve it.
 */
function localeSegment(i18n: UrlRules["i18n"], locale: string): string | null | undefined {
	if (!i18n || !i18n.locales || i18n.locales.length <= 1) return null;
	let segment: string | undefined;
	let isDefault = locale === i18n.defaultLocale;
	for (const l of i18n.locales) {
		if (typeof l === "string") {
			if (l === locale) {
				segment = l;
				break;
			}
		} else if (l.path === locale || l.codes.includes(locale)) {
			segment = l.path;
			isDefault ||= l.path === i18n.defaultLocale || l.codes.includes(i18n.defaultLocale);
			break;
		}
	}
	if (segment === undefined) return undefined;
	if (isDefault && !i18n.prefixDefaultLocale) return "";
	return segment;
}

/**
 * The key a locale's index is stored under: the locale itself, or for an Astro custom-path locale
 * (`{ path: "portugues", codes: ["pt-BR"] }`) its first code. EmDash stores the path on the entry, but
 * the browser loader picks the index by the page's `<html lang>`, which is a code. URLs keep the path.
 */
export function indexLocale(locale: string, rules: UrlRules | undefined): string {
	for (const l of rules?.i18n?.locales ?? []) {
		if (typeof l === "string") {
			if (l === locale) return locale;
		} else if (l.path === locale || l.codes.includes(locale)) {
			return l.codes[0] ?? locale;
		}
	}
	return locale;
}

/** The default locale's index key (see `indexLocale`): the manifest's `defaultLocale` and the fallback file. */
export const indexDefaultLocale = (content: Pick<ContentPort, "defaultLocale" | "urlRules">): string => indexLocale(content.defaultLocale(), content.urlRules?.());

/**
 * The public path EmDash's `getPublicUrl(collection, entry.id)` gives for this row, without its site URL (EmDash
 * gives null with no site URL; this path needs none).
 * Null when EmDash gives null: not published, no slug, collection not routable, or a locale the site does
 * not serve.
 */
export function entryPath(c: Pick<CollectionInfo, "slug" | "routable" | "urlPattern">, e: EmDashEntry, rules: UrlRules): string | null {
	if (e.status !== "published" || !e.slug || !c.routable) return null;
	const path = interpolate(c.urlPattern ?? null, c.slug, e.slug, e.id, e.publishedAt);
	const segment = localeSegment(rules.i18n, e.locale || rules.siteLocale);
	if (segment === undefined) return null;
	const localized = segment === null || segment === "" ? normalizePath(path) : normalizePath(`/${segment}${path}`);
	if (localized === "/") return localized;
	if (rules.trailingSlash === "always") return `${localized}/`;
	if (rules.trailingSlash === "never") return localized.replace(TRAILING_SLASH, "");
	return localized;
}

/**
 * The collections to index. Default: every one with `search` in `supports`, `routable` and not `hidden`.
 * Listed ones are taken as listed; one that is missing or not routable is left out with a warning.
 */
export async function searchCollections(schema: SchemaPort, options: PluginOptions): Promise<{ collections: CollectionInfo[]; warnings: string[] }> {
	const all = await schema.listCollections();
	if (!options.collections) return { collections: all.filter((c) => c.supports.includes("search") && c.routable && !c.hidden), warnings: [] };
	const warnings: string[] = [];
	const collections: CollectionInfo[] = [];
	for (const slug of new Set(options.collections)) {
		const c = all.find((x) => x.slug === slug);
		if (!c) warnings.push(`Search: collection "${slug}" is listed, but there is no such collection; it is left out`);
		else if (!c.routable) warnings.push(`Search: collection "${slug}" is not routable (its entries have no public URL); it is left out`);
		else collections.push(c);
	}
	return { collections, warnings };
}

/** Every indexable entry of the search collections as page records, per locale. `found`: the collections already read this run. */
export async function collectRecords(ports: { content: ContentPort; schema: SchemaPort }, options: PluginOptions, found?: Awaited<ReturnType<typeof searchCollections>>): Promise<CollectResult> {
	const { content, schema } = ports;
	const { collections, warnings: seen } = found ?? (await searchCollections(schema, options));
	const warnings = [...seen];
	const byLocale: Record<string, SearchRecord[]> = Object.create(null);
	const types: Record<string, { label: string }> = {};
	// Read once per build: every path then comes from the listed rows (no query per entry).
	const rules = content.urlRules?.();
	const defaultLocale = indexLocale(content.defaultLocale(), rules);
	let skipped = 0;
	for (const c of collections) {
		types[c.slug] = { label: c.label || c.slug };
		let cursor: string | undefined;
		do {
			const page = await content.list(c.slug, cursor);
			for (const e of page.items) {
				if (!isIndexable(e)) continue;
				const url = rules ? entryPath(c, e, rules) : await content.publicPath(c.slug, e.id);
				if (!url) {
					skipped++;
					continue;
				}
				// Stored under the code the page's <html lang> gives; the URL above keeps the custom path.
				const r = entryRecord(e.locale ? { ...e, locale: indexLocale(e.locale, rules) } : e, url, defaultLocale);
				(byLocale[r.locale] ??= []).push(r);
			}
			cursor = page.nextCursor;
		} while (cursor);
	}
	const sortedTypes = Object.fromEntries(Object.keys(types).sort().map((t) => [t, types[t]]));
	return { byLocale: { ...byLocale }, types: sortedTypes, skipped, warnings };
}
