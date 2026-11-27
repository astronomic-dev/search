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
 * - `textFields` adds the words of more fields per collection after the lead text (text-fields.ts). No query.
 * - Keywords: the `search_keywords` field (an array or a comma list), or `searchKeywords`. With `taxonomyKeywords`, the
 *   labels of the entry's terms follow. One read per list page and locale of its entries; EmDash 1.4 makes it one query
 *   per 50 entries: 2 more per 100 entries in one locale, rounded up per locale (so 5 to 7 instead of 3 to 5), plus one
 *   for the taxonomy definitions (cached per Worker; one per read for an isolated database). 10,000 entries in one
 *   locale: about 200 more. Workers Paid then fits about 13,000 entries with SEO, 19,000 without. A failed read is a
 *   warning, and the build goes on without terms.
 *
 * - `listPages` adds the words of other entries to the record of the page that lists them (list-pages.ts). It reads
 *   each `from` collection once, also when that collection is indexed or read by two pages: nothing more for an
 *   indexed one, 3 to 5 queries per 100 published entries for any other. No query per item.
 * - `exclude` (site path patterns) leaves entries out by their public path. Like drafts, they are not counted as
 *   skipped. See `excluder`. `excludeWhen` adds paths to it at each build, from a switch entry (exclude-when.ts): one
 *   more list read (2 to 3 queries) per rule collection.
 *
 * Platform-free: no `emdash`, `node:*`, `react` or `astro` imports.
 */
import { foldText, squash } from "../../core/text.ts";
import type { PageRecord, SearchRecord } from "../../core/types.ts";
import { firstText, isText, portableTextToPlain } from "./entry-text.ts";
import { excludeWhenPaths } from "./exclude-when.ts";
import { createListPages } from "./list-pages.ts";
import { textFieldsReader, type TextFieldsReader } from "./text-fields.ts";
import { entryPath, excluder, indexLocale } from "./paths.ts";
import type { CollectionInfo, ContentPort, EmDashEntry, PluginOptions, SchemaPort, TermsPort } from "./ports.ts";

export interface CollectResult {
	/** Records per locale, in collection then list order. */
	byLocale: Record<string, SearchRecord[]>;
	/** Per type (the collection slug): its label, from the collection's label. */
	types: Record<string, { label: string }>;
	/** Entries skipped because they have no public path. */
	skipped: number;
	warnings: string[];
}

/** Keywords from an array of strings or a comma list, each squashed, empty ones dropped (as `collections()`). */
export function keywordList(v: unknown): string[] {
	const list = typeof v === "string" ? v.split(",") : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	return list.map(squash).filter((x) => x !== "");
}

/** Published and not `seo.noIndex`. Scheduled entries wait until they are published. */
export const isIndexable = (e: EmDashEntry): boolean => e.status === "published" && e.seo?.noIndex !== true;

/** The page record of one entry at its public path. */
export function entryRecord(e: EmDashEntry, url: string, defaultLocale: string, fields?: TextFieldsReader | null): PageRecord {
	const d = e.data ?? {};
	const locale = isText(e.locale) ? e.locale : defaultLocale;
	const title = squash(firstText(d.title, d.name, e.seo?.title, e.slug) ?? e.id);
	const lead = firstText(d.excerpt, d.summary, d.description, e.seo?.description) ?? "";
	const extra = fields?.(e.type, e, lead) ?? "";
	const text = squash(`${lead} ${extra} ${portableTextToPlain(d.content)}`);
	// EmDash field slugs are lowercase (`search_keywords`); `searchKeywords` is kept as an alias.
	const keywords = keywordList(d.search_keywords ?? d.searchKeywords);
	return { id: `${locale}:${url}`, kind: "page", locale, type: e.type, url, title, text, facets: {}, source: "emdash", ...(keywords.length > 0 ? { keywords } : {}) };
}

/**
 * The collections to index (and `all` the site has). Default: every one with `search` in `supports`, `routable` and not `hidden`.
 * Listed ones are taken as listed; one that is missing or not routable is left out with a warning.
 */
export async function searchCollections(schema: SchemaPort, options: PluginOptions): Promise<{ collections: CollectionInfo[]; all: CollectionInfo[]; warnings: string[] }> {
	const all = await schema.listCollections();
	if (!options.collections) return { all, collections: all.filter((c) => c.supports.includes("search") && c.routable && !c.hidden), warnings: [] };
	const warnings: string[] = [];
	const collections: CollectionInfo[] = [];
	for (const slug of new Set(options.collections)) {
		const c = all.find((x) => x.slug === slug);
		if (!c) warnings.push(`Search: collection "${slug}" is listed, but there is no such collection; it is left out`);
		else if (!c.routable) warnings.push(`Search: collection "${slug}" is not routable (its entries have no public URL); it is left out`);
		else collections.push(c);
	}
	return { all, collections, warnings };
}

/** Throws unless `input` is a list of taxonomy names. */
export function checkTaxonomyKeywords(input: unknown): asserts input is string[] {
	if (Array.isArray(input) && input.every(isText)) return;
	throw new Error(`Search: search(): taxonomyKeywords must be a list of taxonomy names (["category", "tag"]), not ${JSON.stringify(input)}`);
}

/** Adds the labels of `taxonomies`, in that order, to a record's keywords. One that is there already (in any case or accents) is left out. */
function addTerms(record: PageRecord, labels: Readonly<Record<string, readonly string[]>>, taxonomies: readonly string[]): void {
	const keywords = [...(record.keywords ?? [])];
	const seen = new Set(keywords.map(foldText));
	for (const label of taxonomies.flatMap((name) => (Object.hasOwn(labels, name) ? keywordList([...labels[name]]) : []))) {
		if (seen.has(foldText(label))) continue;
		seen.add(foldText(label));
		keywords.push(label);
	}
	if (keywords.length > 0) record.keywords = keywords;
}

/**
 * The `taxonomyKeywords` step of one build: given the entries of a list page and their records, adds the term labels.
 * EmDash resolves labels in one locale per read, so the entries are grouped by locale. The first failed read is a
 * warning and the last read. Null: the option is not used.
 */
function termReader(terms: TermsPort | undefined, options: PluginOptions, defaultLocale: string, warnings: string[]): ((collection: string, rows: Array<{ e: EmDashEntry; record: PageRecord }>) => Promise<void>) | null {
	const taxonomies = options.taxonomyKeywords ?? [];
	if (taxonomies.length === 0) return null;
	let failed = false;
	return async (collection, rows) => {
		const byLocale = new Map<string, Array<{ id: string; record: PageRecord }>>();
		for (const { e, record } of rows) {
			const locale = e.locale || defaultLocale;
			byLocale.set(locale, [...(byLocale.get(locale) ?? []), { id: e.id, record }]);
		}
		for (const [locale, group] of byLocale) {
			if (failed) return;
			try {
				if (!terms) throw new Error("no access to taxonomies");
				const labels = await terms.labels(collection, group.map((g) => g.id), locale);
				for (const { id, record } of group) addTerms(record, labels.get(id) ?? {}, taxonomies);
			} catch (error) {
				failed = true;
				warnings.push(`Search: taxonomyKeywords: the terms could not be read (${error instanceof Error ? error.message : String(error)}); the rest of this build goes on without them, and the next build tries again`);
			}
		}
	};
}

/** Every indexable entry of the search collections as page records, per locale. `found`: the collections already read this run. */
export async function collectRecords(ports: { content: ContentPort; schema: SchemaPort; terms?: TermsPort }, options: PluginOptions, found?: Awaited<ReturnType<typeof searchCollections>>): Promise<CollectResult> {
	const { content, schema } = ports;
	const { collections, all, warnings: seen } = found ?? (await searchCollections(schema, options));
	const warnings = [...seen];
	const byLocale: Record<string, SearchRecord[]> = Object.create(null);
	const types: Record<string, { label: string }> = {};
	// Read once per build: every path then comes from the listed rows (no query per entry).
	const rules = content.urlRules?.();
	const defaultLocale = indexLocale(content.defaultLocale(), rules);
	// The switch entries are read first: a failed read stops the build before anything else is read (exclude-when.ts).
	const switched = collections.length > 0 ? await excludeWhenPaths(content, all, options.excludeWhen, warnings) : [];
	const excluded = excluder([...(options.exclude ?? []), ...switched], rules);
	// With no search collection the build stops (`no-collections`), so list pages read nothing.
	const lists = collections.length > 0 ? createListPages(options.listPages, { rules, defaultLocale: content.defaultLocale(), all, excluded, warnings }) : null;
	const readTerms = termReader(ports.terms, options, content.defaultLocale(), warnings);
	const readFields = textFieldsReader(options.textFields, collections, all, warnings);
	let skipped = 0;
	// One scan per collection, also when it is indexed and read by a list page.
	const indexed = new Set(collections.map((c) => c.slug));
	for (const c of [...collections, ...(lists?.collections ?? []).filter((x) => !indexed.has(x.slug))]) {
		const searched = indexed.has(c.slug);
		if (searched) types[c.slug] = { label: c.label || c.slug };
		let cursor: string | undefined;
		do {
			const page = await content.list(c.slug, cursor);
			const rows: Array<{ e: EmDashEntry; record: PageRecord }> = [];
			for (const e of page.items) {
				const indexable = isIndexable(e);
				if (indexable) lists?.item(c.slug, e);
				// A published noIndex entry gives no record, but it keeps its list page out.
				if (!searched || !(indexable || (lists && e.status === "published"))) continue;
				const url = rules ? entryPath(c, e, rules) : await content.publicPath(c.slug, e.id);
				if (!url) {
					if (indexable) skipped++;
					continue;
				}
				if (excluded(url, e.locale)) continue;
				if (!indexable) {
					lists?.owner(e, url, null);
					continue;
				}
				// Stored under the code the page's <html lang> gives; the URL above keeps the custom path.
				const r = entryRecord(e.locale ? { ...e, locale: indexLocale(e.locale, rules) } : e, url, defaultLocale, readFields);
				(byLocale[r.locale] ??= []).push(r);
				lists?.owner(e, url, r);
				rows.push({ e, record: r });
			}
			if (rows.length > 0) await readTerms?.(c.slug, rows);
			cursor = page.nextCursor;
		} while (cursor);
	}
	for (const { record, label } of lists?.finish() ?? []) {
		(byLocale[record.locale] ??= []).push(record);
		types[record.type] ??= { label };
	}
	const sortedTypes = Object.fromEntries(Object.keys(types).sort().map((t) => [t, types[t]]));
	return { byLocale: { ...byLocale }, types: sortedTypes, skipped, warnings };
}
