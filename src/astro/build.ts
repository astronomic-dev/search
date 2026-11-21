/**
 * The pure part of the Astro integration: settings in one shape, and the index files and manifest from merged
 * records. No Astro imports, no file system.
 */
import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { capitalize, checkFacetName, collectionType, facetFields, typeLabels, type CollectionSpec, type CollectionsSource, type FilterEntry } from "../adapters/collections.ts";
import type { HtmlSource } from "../adapters/html.ts";
import { runRecords, type RecordsSource } from "../adapters/records.ts";
import type { StringsInput } from "../controller/strings.ts";
import { mergeRecords } from "../core/merge.ts";
import { DEFAULT_WEIGHTS } from "../core/minisearch.ts";
import { own } from "../core/own.ts";
import { capKeywords, checkRecords } from "../core/schema.ts";
import { foldText, squash } from "../core/text.ts";
import { SCHEMA, type EngineFactory, type GroupBy, type IndexSettings, type Manifest, type SearchRecord, type SourcedRecord, type SuggestedLink, type Weights } from "../core/types.ts";
import { cleanUrl, type UrlOptions } from "../core/url.ts";

export type Source = CollectionsSource | HtmlSource | RecordsSource;

export interface IndexInput {
	sources: Source[];
	weights?: Partial<Weights>;
	group?: { dialog?: GroupBy; page?: GroupBy };
	groupOrder?: "best" | string[];
	/** A warning at build time when the index's largest file is over this size, gzipped. Default 300 KB. */
	budget?: { gzipKB: number };
	/** Characters of each section's text the index file keeps, for a smaller file. Leave out to keep it whole. */
	clip?: number;
	/** Per type: a label in place of the source's, and a score `weight` (default 1). */
	types?: Record<string, { label?: string; weight?: number }>;
	/** Per facet: its label, and labels for its values. */
	facets?: Record<string, { label?: string; values?: Record<string, string> }>;
	/** Links shown in an empty box (at most 8): one list for every locale, or one per locale (`{ en: [...], fr: [...] }`). */
	suggested?: SuggestedLink[] | Record<string, SuggestedLink[]>;
	/** Groups of words that match each other, one word each: `[["docs", "documentation"]]`. */
	synonyms?: string[][];
	/** A whole query -> page URLs shown first, in that order: `{ "get started": ["/docs/install"] }`. */
	pinned?: Record<string, string[]>;
}

export interface BrowseLink {
	label: string;
	href: string;
}

export interface SearchOptions extends Partial<IndexInput> {
	/** Named indexes, each with its own files. Leave out for one index (named "default"). */
	indexes?: Record<string, IndexInput>;
	/** The index a search button uses when it names none. */
	default?: string;
	shortcut?: { keys: string[] } | false;
	/** UI labels that replace the US English defaults. */
	strings?: StringsInput;
	/** Links for the error state and the no-JavaScript part. */
	browse?: BrowseLink[];
}

export interface NormalIndex {
	name: string;
	sources: Source[];
	weights: Weights;
	group: { dialog: GroupBy; page: GroupBy };
	groupOrder: "best" | string[];
	budget?: { gzipKB: number };
	clip?: number;
	/** The types the sources declare, with the label and weight overrides applied. */
	types: Record<string, { label: string; weight?: number }>;
	typeOverrides: Record<string, { label?: string; weight?: number }>;
	/** The facets the sources declare, with their labels. */
	facets: Record<string, { label: string; values?: Record<string, string> }>;
	suggested?: SuggestedLink[] | Record<string, SuggestedLink[]>;
	/** Folded, each group deduped. */
	synonyms?: string[][];
	/** Folded and squashed queries, deduped URLs. */
	pinned?: Record<string, string[]>;
}

export interface Settings {
	indexes: Record<string, NormalIndex>;
	default: string;
	shortcut: { keys: string[] } | false;
	strings: StringsInput;
	browse: BrowseLink[];
}

const SITE_KEYS = ["indexes", "default", "shortcut", "strings", "browse"];
const INDEX_KEYS = ["sources", "weights", "group", "groupOrder", "budget", "clip", "types", "facets", "suggested", "synonyms", "pinned"];
/** One word as the engine's tokenizer sees it: no spaces, no punctuation. */
const WORD = /^[^\n\r\p{Z}\p{P}]+$/u;
export const MAX_SUGGESTED = 8;
const LINK_KEYS = ["label", "href", "type"];
const BROWSE_KEYS = ["label", "href"];
const DEFAULT_SHORTCUT = { keys: ["mod+k", "/"] };
const NAME = /^[a-z0-9][a-z0-9_-]*$/i;
/** Names an index may not take: every Object.prototype key, and "prototype". They would be lost or clash on a plain object. */
const RESERVED = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);

function unknownKeys(obj: object, known: string[], where: string): void {
	for (const key of Object.keys(obj)) {
		if (!known.includes(key)) throw new Error(`Search: ${where} has no setting "${key}" (known: ${known.join(", ")})`);
	}
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** The shape of the suggested setting: a list, or a list per locale; each at most 8 links with a label and an href. */
function checkSuggestedShape(where: string, input: unknown): SuggestedLink[] | Record<string, SuggestedLink[]> {
	const list = (at: string, links: unknown): SuggestedLink[] => {
		if (!Array.isArray(links)) throw new Error(`Search: ${where}: ${at} must be a list of links ({ label, href, type? })`);
		if (links.length > MAX_SUGGESTED) throw new Error(`Search: ${where}: ${at} has ${links.length} links; at most ${MAX_SUGGESTED}`);
		return links.map((link: unknown, i) => {
			const field = `${at}[${i}]`;
			if (!link || typeof link !== "object" || Array.isArray(link)) throw new Error(`Search: ${where}: ${field} must be an object ({ label, href, type? })`);
			for (const key of Object.keys(link)) if (!LINK_KEYS.includes(key)) throw new Error(`Search: ${where}: ${field} has no field "${key}" (known: ${LINK_KEYS.join(", ")})`);
			const l = link as Record<string, unknown>;
			for (const key of ["label", "href"]) if (!nonEmpty(l[key])) throw new Error(`Search: ${where}: ${field}.${key} must be a non-empty string`);
			if (l.type !== undefined && !nonEmpty(l.type)) throw new Error(`Search: ${where}: ${field}.type must be a non-empty string`);
			return { label: (l.label as string).trim(), href: l.href as string, ...(l.type !== undefined ? { type: l.type as string } : {}) };
		});
	};
	if (Array.isArray(input)) return list("suggested", input);
	if (!input || typeof input !== "object") throw new Error(`Search: ${where}: suggested must be a list of links, or a list per locale`);
	return Object.fromEntries(Object.entries(input).map(([locale, links]) => [locale, list(`suggested.${locale}`, links)]));
}

/** The shape of the browse setting: a list of links, each with a non-empty label and href. */
function checkBrowseShape(input: unknown): BrowseLink[] {
	if (input === undefined) return [];
	if (!Array.isArray(input)) throw new Error("Search: search(): browse must be a list of links ({ label, href })");
	return input.map((link: unknown, i) => {
		const field = `browse[${i}]`;
		if (!link || typeof link !== "object" || Array.isArray(link)) throw new Error(`Search: search(): ${field} must be an object ({ label, href })`);
		for (const key of Object.keys(link)) if (!BROWSE_KEYS.includes(key)) throw new Error(`Search: search(): ${field} has no field "${key}" (known: ${BROWSE_KEYS.join(", ")})`);
		const l = link as Record<string, unknown>;
		for (const key of BROWSE_KEYS) if (!nonEmpty(l[key])) throw new Error(`Search: search(): ${field}.${key} must be a non-empty string`);
		return { label: (l.label as string).trim(), href: l.href as string };
	});
}

/**
 * Every browse link's href is a canonical URL on this site, as a suggested link's is: the error state and the
 * no-JavaScript part render them as links, so a javascript: URL or another site never gets there.
 */
export function checkBrowseLinks(browse: readonly BrowseLink[], urlOptions: UrlOptions): void {
	browse.forEach((link, i) => {
		const at = `Search: search(): browse[${i}].href ${link.href}`;
		const clean = cleanUrl(link.href, urlOptions);
		if (clean === null) throw new Error(`${at} is not on this site`);
		// With trailingSlash "ignore" the site answers both forms, so either slash is fine.
		const bare = (u: string) => u.replace(/\/(?=#|$)/, "");
		const same = clean === link.href || (urlOptions.trailingSlash === "ignore" && bare(clean) === bare(link.href));
		if (!same) throw new Error(`${at} is not canonical; use ${clean}`);
	});
}

/** Synonym groups, folded as the engine folds query words; each group has two or more different words. */
function checkSynonyms(where: string, input: unknown): string[][] {
	if (!Array.isArray(input)) throw new Error(`Search: ${where}: synonyms must be a list of groups of words ([["docs", "documentation"]])`);
	return input.map((group: unknown, i) => {
		if (!Array.isArray(group)) throw new Error(`Search: ${where}: synonyms[${i}] must be a list of words`);
		const words = group.map((w: unknown, j) => {
			const word = typeof w === "string" ? w.trim() : "";
			if (!WORD.test(word)) throw new Error(`Search: ${where}: synonyms[${i}][${j}] must be one word (no spaces or punctuation), not ${JSON.stringify(w)}`);
			return foldText(word);
		});
		const unique = [...new Set(words)];
		if (unique.length < 2) throw new Error(`Search: ${where}: synonyms[${i}] needs at least two different words`);
		return unique;
	});
}

/** Pinned results: each query folded and squashed as it is matched, each with a list of URLs. */
/** The smallest `clip`: shorter text gives snippets with little to show. */
export const MIN_CLIP = 200;

/** The size warning of an index with no `budget`: past it, set `clip` or a budget of your own. */
export const DEFAULT_BUDGET_KB = 300;

function checkClip(where: string, input: unknown): number {
	if (!Number.isInteger(input) || (input as number) < MIN_CLIP) throw new Error(`Search: ${where}: clip must be a whole number of characters, at least ${MIN_CLIP}, not ${JSON.stringify(input)}`);
	return input as number;
}

function checkPinned(where: string, input: unknown): Record<string, string[]> {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`Search: ${where}: pinned must map a query to a list of URLs ({ "get started": ["/docs/install"] })`);
	// No prototype: a query "__proto__" or "constructor" is an own key like any other.
	const out: Record<string, string[]> = Object.create(null);
	const from = new Map<string, string>();
	for (const [query, urls] of Object.entries(input)) {
		const key = squash(foldText(query));
		if (!key) throw new Error(`Search: ${where}: pinned has an empty query`);
		const clash = from.get(key);
		if (clash !== undefined) throw new Error(`Search: ${where}: pinned has ${JSON.stringify(clash)} and ${JSON.stringify(query)}, the same query once folded`);
		from.set(key, query);
		if (!Array.isArray(urls) || urls.length === 0 || !urls.every(nonEmpty)) throw new Error(`Search: ${where}: pinned[${JSON.stringify(query)}] must be a non-empty list of URLs`);
		out[key] = [...new Set(urls as string[])];
	}
	return out;
}

/**
 * Pinned URLs: each canonical, and a page of the index (in any locale). Returns the pinned setting with the missing
 * ones left out; in dev they are warnings (html() pages are not scanned there), else an error.
 */
function checkPinnedUrls(index: NormalIndex, records: readonly SearchRecord[], o: WriteOptions, warnings: string[]): Record<string, string[]> | undefined {
	if (!index.pinned) return undefined;
	const where = index.name === "default" ? "search()" : `index "${index.name}"`;
	const pages = new Set(records.filter((r) => r.kind === "page").map((r) => r.url));
	const out: Record<string, string[]> = Object.create(null);
	for (const [query, urls] of Object.entries(index.pinned)) {
		const kept: string[] = [];
		for (const url of urls) {
			const at = `Search: ${where}: pinned[${JSON.stringify(query)}] has ${url}`;
			const clean = o.urlOptions ? cleanUrl(url, o.urlOptions) : url;
			if (clean === null) throw new Error(`${at}, which is not on this site`);
			if (clean !== url) throw new Error(`${at}, which is not canonical; use ${clean}`);
			if (pages.has(url)) kept.push(url);
			else if (o.dev) warnings.push(`${at}, which is not a page in the index (in dev, pages from html() are not scanned); it is left out`);
			else throw new Error(`${at}, which is not a page in the index`);
		}
		if (kept.length) out[query] = kept;
	}
	return out;
}

/** Every suggested link of an index: an href that is a canonical URL on this site (as a record's), a type of the index. */
function checkSuggestedLinks(index: NormalIndex, types: Record<string, unknown>, urlOptions: UrlOptions | undefined): void {
	const s = index.suggested;
	if (!s) return;
	const where = index.name === "default" ? "search()" : `index "${index.name}"`;
	const lists: [string, SuggestedLink[]][] = Array.isArray(s) ? [["suggested", s]] : Object.entries(s).map(([locale, l]) => [`suggested.${locale}`, l]);
	for (const [at, links] of lists) {
		links.forEach((link, i) => {
			const field = `${at}[${i}]`;
			if (urlOptions) {
				const clean = cleanUrl(link.href, urlOptions);
				if (clean === null) throw new Error(`Search: ${where}: ${field}.href ${link.href} is not on this site`);
				if (clean !== link.href) throw new Error(`Search: ${where}: ${field}.href ${link.href} is not canonical; use ${clean}`);
			}
			if (link.type !== undefined && !Object.hasOwn(types, link.type)) throw new Error(`Search: ${where}: ${field}.type "${link.type}" is not a type of this index (types: ${Object.keys(types).join(", ")})`);
		});
	}
}

function normalizeIndex(name: string, input: IndexInput): NormalIndex {
	const where = name === "default" ? "search()" : `index "${name}"`;
	if (!input || typeof input !== "object") throw new Error(`Search: ${where} must be an object`);
	unknownKeys(input, INDEX_KEYS, where);
	if (!Array.isArray(input.sources) || input.sources.length === 0) throw new Error(`Search: ${where} needs at least one source in "sources"`);

	// No prototype: a type named "constructor" is declared like any other.
	const declaredTypes: Record<string, { label: string; weight?: number }> = Object.create(null);
	const declaredFacets = new Set<string>();
	const collectionLabels = typeLabels(input.sources.filter((s): s is CollectionsSource => s?.kind === "collections"));
	for (const source of input.sources) {
		if (source?.kind === "collections") {
			for (const [collection, spec] of Object.entries(source.specs)) {
				const type = collectionType(collection, spec);
				declaredTypes[type] = { label: collectionLabels.get(type) ?? capitalize(type) };
				for (const facet of Object.keys(facetFields(collection, spec ?? {}))) declaredFacets.add(facet);
			}
		} else if (source?.kind === "html") {
			const type = source.type ?? "pages";
			declaredTypes[type] ??= { label: source.label ?? capitalize(type) };
		} else if (source?.kind === "records") {
			for (const [type, t] of Object.entries(source.types ?? {})) declaredTypes[type] = { ...t };
			for (const facet of source.facets ?? []) declaredFacets.add(facet);
		} else throw new Error(`Search: ${where}: every source must come from collections(), html() or records()`);
	}

	const facetInput = input.facets ?? {};
	for (const facet of [...declaredFacets, ...Object.keys(facetInput)]) {
		checkFacetName(where, facet);
	}
	const group = { dialog: input.group?.dialog ?? "type", page: input.group?.page ?? false };
	for (const [surface, by] of Object.entries(group)) {
		if (by !== false && by !== "type" && !declaredFacets.has(by)) throw new Error(`Search: ${where}: group.${surface} is "${by}", but no source declares a facet named "${by}"`);
	}
	const typeOverrides = input.types ?? {};
	const types = Object.fromEntries(Object.entries(declaredTypes).map(([type, t]) => [type, applyType(t, own(typeOverrides, type))]));
	const facets = Object.fromEntries([...declaredFacets].sort().map((f) => [f, facetEntry(f, own(facetInput, f))]));

	return {
		name,
		sources: input.sources,
		weights: { ...DEFAULT_WEIGHTS, ...input.weights },
		group,
		groupOrder: input.groupOrder ?? "best",
		...(input.budget ? { budget: input.budget } : {}),
		...(input.clip !== undefined ? { clip: checkClip(where, input.clip) } : {}),
		types,
		typeOverrides,
		facets,
		...(input.suggested !== undefined ? { suggested: checkSuggestedShape(where, input.suggested) } : {}),
		...(input.synonyms !== undefined ? { synonyms: checkSynonyms(where, input.synonyms) } : {}),
		...(input.pinned !== undefined ? { pinned: checkPinned(where, input.pinned) } : {}),
	};
}

function facetEntry(name: string, f: { label?: string; values?: Record<string, string> } | undefined) {
	return { label: f?.label ?? capitalize(name), ...(f?.values ? { values: f.values } : {}) };
}

function applyType(t: { label: string; weight?: number }, o: { label?: string; weight?: number } | undefined) {
	const weight = o?.weight ?? t.weight;
	return { label: o?.label ?? t.label, ...(weight !== undefined ? { weight } : {}) };
}

function checkIndexName(name: string) {
	if (RESERVED.has(name)) throw new Error(`Search: index name "${name}" is reserved (it is a built-in object key); pick another name`);
	if (!NAME.test(name)) throw new Error(`Search: index name "${name}" must be letters, digits, "-" and "_"`);
}

/** Both forms (one index, or named indexes) in one shape. Fails with a clear message on a bad setting. */
export function normalizeSettings(input: SearchOptions): Settings {
	if (!input || typeof input !== "object") throw new Error("Search: search() takes an object of settings");
	unknownKeys(input, [...SITE_KEYS, ...INDEX_KEYS], "search()");
	const indexInput: Record<string, IndexInput> = {};
	const short = INDEX_KEYS.filter((k) => k in input);
	if (input.indexes) {
		if (short.length > 0) throw new Error(`Search: search() has "indexes", so "${short[0]}" belongs inside an index`);
		// Check before copying: Object.assign would run the __proto__ setter and lose that index.
		for (const name of Object.keys(input.indexes)) checkIndexName(name);
		Object.assign(indexInput, input.indexes);
	} else indexInput.default = Object.fromEntries(short.map((k) => [k, input[k as keyof SearchOptions]])) as unknown as IndexInput;

	const indexes: Record<string, NormalIndex> = {};
	const lower = new Map<string, string>();
	for (const [name, index] of Object.entries(indexInput)) {
		checkIndexName(name);
		const clash = lower.get(name.toLowerCase());
		if (clash !== undefined) throw new Error(`Search: two indexes have the same name ("${clash}" and "${name}"); their files would clash`);
		lower.set(name.toLowerCase(), name);
		indexes[name] = normalizeIndex(name, index);
	}
	if (Object.keys(indexes).length === 0) throw new Error("Search: search() needs at least one index");
	const def = input.default ?? (indexes.default ? "default" : Object.keys(indexes)[0]) ?? "default";
	if (!Object.hasOwn(indexes, def)) throw new Error(`Search: default is "${def}", but there is no index with that name (indexes: ${Object.keys(indexes).join(", ")})`);
	const shortcut = input.shortcut === false ? false : (input.shortcut ?? DEFAULT_SHORTCUT);
	if (shortcut && !Array.isArray(shortcut.keys)) throw new Error('Search: shortcut must be false or { keys: [...] }');
	return { indexes, default: def, shortcut, strings: input.strings ?? {}, browse: checkBrowseShape(input.browse) };
}

/** The engine settings of one index. Types: the declared ones, plus any type a records() hook gave. */
export function indexSettings(index: NormalIndex, records: readonly SearchRecord[]): IndexSettings {
	// A Map: a record type named "constructor" or "__proto__" is a type like any other.
	const types = new Map(Object.entries(index.types));
	for (const r of records) if (!types.has(r.type)) types.set(r.type, applyType({ label: capitalize(r.type) }, own(index.typeOverrides, r.type)));
	const sorted = Object.fromEntries([...types.keys()].sort().map((t) => [t, types.get(t) as { label: string; weight?: number }]));
	return { weights: index.weights, group: index.group, groupOrder: index.groupOrder, types: sorted, facets: index.facets, ...(index.clip !== undefined ? { clip: index.clip } : {}) };
}

export const hash10 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex").slice(0, 10);

export interface OutputFile {
	/** File name in the `_search` folder. */
	name: string;
	body: string;
}

export interface IndexStats {
	index: string;
	records: number;
	files: number;
	/** The largest file of the index, gzipped. */
	gzipKB: number;
	budgetKB?: number;
}

export interface WriteOptions {
	/** Astro's base, with slashes. */
	base: string;
	defaultLocale: string;
	/** The site's URL settings: with them, suggested links and pinned URLs must be canonical URLs on this site. */
	urlOptions?: UrlOptions;
	/** The dev server: a pinned URL that is not in the index is a warning, not an error (html() gives no pages in dev). */
	dev?: boolean;
}

/** The path of a file directly in `folder`; fails when the name would land anywhere else. */
export function safePath(folder: string, name: string): string {
	const path = resolve(folder, name);
	const rel = relative(resolve(folder), path);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) throw new Error(`Search: the file name ${JSON.stringify(name)} is outside ${folder}`);
	return path;
}

/** The `_search` folder's URL for a base: "/" gives "/_search/". */
/**
 * The default search page's URL: /search with the site's base and its trailingSlash setting ("ignore" follows
 * build.format, as every record URL does), so "/search", "/search/" or "/docs-site/search/".
 */
export function searchPageUrl(o: UrlOptions): string {
	// The base joined on explicitly: a bare "/search" under base "/search/" reads as the base itself (the site root).
	const base = o.base.endsWith("/") ? o.base : `${o.base}/`;
	return cleanUrl(`${base}search`, o) ?? `${base}search`;
}

/**
 * The build warning for a SearchLink with no page behind it: a link to the default search page (`href`, from
 * `searchPageUrl`) when the build wrote no search page there. Null when there is a search page, or when every search
 * link has its own href (SearchLink marks those with data-search-href), so `href="/search"` quiets it for a page
 * rendered on demand.
 */
export async function searchPageWarning(out: string, href: string): Promise<string | null> {
	for (const file of ["search/index.html", "search.html"]) {
		try {
			await access(join(out, file));
			return null;
		} catch {
			// not this one
		}
	}
	const entries = await readdir(out, { recursive: true, withFileTypes: true });
	for (const e of entries) {
		if (!e.isFile() || !e.name.endsWith(".html")) continue;
		const path = join(e.parentPath, e.name);
		if (relative(out, path).split(sep)[0] === "_search") continue;
		const html = await readFile(path, "utf8");
		for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
			// data-search-href: the owner set the href, even if it is the default path.
			if (!/\sdata-search-trigger[\s=>]/i.test(tag) || /\sdata-search-href[\s=>]/i.test(tag)) continue;
			if (/\shref=(["'])(.*?)\1/i.exec(tag)?.[2] === href) {
				const page = `/${relative(out, path).split(sep).join("/")}`;
				return `Search: there is no ${href} page, but a search link points there (first on ${page}). With no JavaScript, and from "See all results", it leads to a missing page. Add a ${href} page, or set \`href\` on SearchLink (\`href="${href}"\` if the page is rendered on demand).`;
			}
		}
	}
	return null;
}

export const searchDir = (base: string) => `${base.endsWith("/") ? base : `${base}/`}_search/`;

/**
 * One file per index per locale, named `<index>.<locale>.<hash10>.json` (the hash of the file's bytes), and the
 * manifest. The default locale always has a file, so a page in any language loads something. Same input, same names.
 */
export function writeIndexes(
	byIndex: Record<string, SearchRecord[]>,
	settings: Settings,
	engine: EngineFactory,
	options: WriteOptions,
): { manifest: Manifest; files: OutputFile[]; stats: IndexStats[]; warnings: string[] } {
	const dir = searchDir(options.base);
	const manifest: Manifest = { schema: SCHEMA, defaultLocale: options.defaultLocale, indexes: {} };
	const files: OutputFile[] = [];
	const stats: IndexStats[] = [];
	const warnings: string[] = [];
	for (const name of Object.keys(settings.indexes).sort()) {
		const index = settings.indexes[name] as NormalIndex;
		const records = byIndex[name] ?? [];
		const settingsOut = indexSettings(index, records);
		checkSuggestedLinks(index, settingsOut.types, options.urlOptions);
		const pinned = checkPinnedUrls(index, records, options, warnings);
		if (index.synonyms?.length) settingsOut.synonyms = index.synonyms;
		if (pinned && Object.keys(pinned).length) settingsOut.pinned = pinned;
		const byLocale = new Map<string, SearchRecord[]>([[options.defaultLocale, []]]);
		for (const r of records) {
			const list = byLocale.get(r.locale);
			if (list) list.push(r);
			else byLocale.set(r.locale, [r]);
		}

		const locales: Record<string, string> = {};
		const hashes: string[] = [];
		let gzipKB = 0;
		for (const locale of [...byLocale.keys()].sort()) {
			const suggested = Array.isArray(index.suggested) ? index.suggested : own(index.suggested, locale);
			const localeSettings = suggested?.length ? { ...settingsOut, suggested } : settingsOut;
			const body = JSON.stringify(engine.build(name, locale, byLocale.get(locale) ?? [], localeSettings));
			const hash = hash10(body);
			const file = `${name}.${locale}.${hash}.json`;
			files.push({ name: file, body });
			locales[locale] = dir + file;
			hashes.push(hash);
			gzipKB = Math.max(gzipKB, gzipSync(body).length / 1024);
		}
		manifest.indexes[name] = { version: hash10(hashes.sort().join(",")), locales };
		stats.push({ index: name, records: records.length, files: byLocale.size, gzipKB: Math.round(gzipKB * 10) / 10, budgetKB: index.budget?.gzipKB ?? DEFAULT_BUDGET_KB });
	}
	return { manifest, files, stats, warnings };
}

/** One log line per index, and whether it is over its budget. */
export function statLine(s: IndexStats): { line: string; over: boolean } {
	const over = s.budgetKB !== undefined && s.gzipKB > s.budgetKB;
	const budget = s.budgetKB !== undefined ? ` (budget ${s.budgetKB} KB${over ? ", OVER: set the index's clip for a smaller file" : ""})` : "";
	return { line: `index "${s.index}": ${s.records} records, ${s.files} file${s.files === 1 ? "" : "s"}, ${s.gzipKB} KB gzipped${budget}`, over };
}

// ---------------------------------------------------------------------------------------------------------------------
// Collecting the records of every index

/** One collection spec as the records route reads it. Same collection and spec, same key, so it runs once. */
export interface RouteSpec {
	key: string;
	collection: string;
	/** The spec as JSON: a `filter` is left out (it runs in the integration, not the route). */
	spec: CollectionSpec;
	/** The spec has a `filter`: the route sends each entry's data along, for the filter to read. */
	data: boolean;
}

/** One entry as the records route gives it: its records and warnings, and its data when the spec has a filter. */
export interface RouteEntry {
	id: string;
	data?: Record<string, unknown>;
	records: SourcedRecord[];
	warnings: string[];
}

/** What the records route returns. */
export interface RouteData {
	sources: Record<string, { entries: RouteEntry[] }>;
}

/** The spec as the route sees it: JSON, with a `filter` as `true` (two specs that differ only in their filter share it). */
export const collectionKey = (collection: string, spec: CollectionSpec) => `${collection}|${JSON.stringify({ ...spec, ...(spec?.filter ? { filter: true } : {}) })}`;

/** Every collection spec of every index, once each. */
export function routeSpecs(settings: Settings): RouteSpec[] {
	const out = new Map<string, RouteSpec>();
	for (const index of Object.values(settings.indexes)) {
		for (const source of index.sources) {
			if (source.kind !== "collections") continue;
			for (const [collection, spec] of Object.entries(source.specs)) {
				const key = collectionKey(collection, spec);
				const { filter, ...rest } = spec ?? {};
				out.set(key, { key, collection, spec: rest, data: typeof filter === "function" });
			}
		}
	}
	return [...out.values()];
}

export const hasCollections = (settings: Settings) => routeSpecs(settings).length > 0;

export interface CollectOptions {
	/** The records route's output, or null when no index reads a collection. */
	route: RouteData | null;
	/** The HTML scan for one html() source. */
	scan: (source: HtmlSource) => Promise<SourcedRecord[]>;
	urlOptions: UrlOptions;
	defaultLocale: string;
	warn: (message: string) => void;
}

/** A collection's filter on one entry; an error in it names the collection and entry. */
function keeps(filter: NonNullable<CollectionSpec["filter"]>, entry: FilterEntry): boolean {
	try {
		return filter(entry) === true;
	} catch (e) {
		throw new Error(`Search: collection "${entry.collection}": its filter failed on entry "${entry.id}": ${e instanceof Error ? e.message : String(e)}`, { cause: e });
	}
}

/** The records of every index: every source run (each hook once), checked and merged per index. */
export async function collectRecords(settings: Settings, o: CollectOptions): Promise<Record<string, SearchRecord[]>> {
	const hooks = new Map<RecordsSource, Promise<SourcedRecord[]>>();
	const scans = new Map<HtmlSource, Promise<SourcedRecord[]>>();
	const warned = new Set<string>();
	const out: Record<string, SearchRecord[]> = {};
	for (const index of Object.values(settings.indexes)) {
		const sourced: SourcedRecord[] = [];
		for (const source of index.sources) {
			if (source.kind === "collections") {
				for (const [collection, spec] of Object.entries(source.specs)) {
					const got = o.route?.sources[collectionKey(collection, spec)];
					if (!got) throw new Error(`Search: the records route gave nothing for collection "${collection}"`);
					for (const entry of got.entries) {
						if (spec?.filter && !keeps(spec.filter, { id: entry.id, collection, data: entry.data ?? {} })) continue;
						for (const w of entry.warnings) {
							if (warned.has(w)) continue;
							warned.add(w);
							o.warn(w);
						}
						sourced.push(...entry.records);
					}
				}
			} else if (source.kind === "html") {
				if (!scans.has(source)) scans.set(source, o.scan(source));
				sourced.push(...(await scans.get(source)!));
			} else {
				if (!hooks.has(source)) hooks.set(source, runRecords(source, o.defaultLocale));
				sourced.push(...(await hooks.get(source)!));
			}
		}
		checkRecords(sourced, o.urlOptions);
		for (const w of capKeywords(sourced)) {
			if (warned.has(w)) continue;
			warned.add(w);
			o.warn(w);
		}
		out[index.name] = mergeRecords(sourced);
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Built pages

/** The ids a page renders, as the HTML has them (entities for &, quotes, < and > decoded). */
function pageIds(html: string): Set<string> {
	const ids = new Set<string>();
	const decode = (v: string) => v.replace(/&(amp|quot|#39|apos|lt|gt);/g, (_, e: string) => ({ amp: "&", quot: '"', "#39": "'", apos: "'", lt: "<", gt: ">" })[e] ?? _);
	for (const m of html.matchAll(/<[a-z][^>]*?\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) ids.add(decode(m[1] ?? m[2] ?? m[3] ?? ""));
	return ids;
}

/**
 * Every collection and html() record's URL is a page in the build output (`out`), and its anchor an id that page
 * renders, as problem lines. A records() hook's URLs are its own (it may point at pages rendered on demand) and are
 * not checked. The page's file is `<path>.html` or `<path>/index.html` under the base, so every build.format works.
 */
export async function builtPageProblems(byIndex: Record<string, readonly SearchRecord[]>, out: string, urlOptions: UrlOptions): Promise<string[]> {
	const base = urlOptions.base.endsWith("/") ? urlOptions.base : `${urlOptions.base}/`;
	const pages = new Map<string, Promise<Set<string> | null>>();
	const load = (path: string): Promise<Set<string> | null> => {
		let got = pages.get(path);
		if (!got) {
			const rel = path.replace(/^\/+|\/+$/g, "");
			const files = rel === "" ? ["index.html"] : /\.html$/i.test(rel) ? [rel] : [`${rel}.html`, `${rel}/index.html`];
			got = (async () => {
				for (const f of files) {
					try {
						return pageIds(await readFile(join(out, ...f.split("/")), "utf8"));
					} catch {
						// not this one
					}
				}
				return null;
			})();
			pages.set(path, got);
		}
		return got;
	};
	// A Set: a missing page is one line, not one per heading record.
	const problems = new Set<string>();
	for (const name of Object.keys(byIndex).sort()) {
		for (const r of byIndex[name] ?? []) {
			if (r.url === undefined || (r.source !== "collection" && r.source !== "html")) continue;
			const hash = r.url.indexOf("#");
			const path = hash < 0 ? r.url : r.url.slice(0, hash);
			const anchor = hash < 0 ? "" : r.url.slice(hash + 1);
			let rel = path.startsWith(base) ? path.slice(base.length) : `${path}/` === base ? "" : path;
			try {
				rel = decodeURIComponent(rel);
			} catch {
				// keep it as it is
			}
			const ids = await load(rel);
			if (ids === null) problems.add(`Search: index "${name}": ${path} is not a built page`);
			else if (anchor) {
				let id = anchor;
				try {
					id = decodeURIComponent(anchor);
				} catch {
					// keep it as it is
				}
				if (!ids.has(id) && !ids.has(anchor)) problems.add(`Search: index "${name}": ${path} renders no #${anchor}`);
			}
		}
	}
	return [...problems];
}
