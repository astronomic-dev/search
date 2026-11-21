/**
 * The search's shared shapes. Frozen after Task 1: every chunk imports these, so a change here is a change to all.
 * No DOM, no Astro, no engine imports.
 */
import type { PackedRecords } from "./pack.ts";

/** 2: `records` is the packed form of core/pack.ts. */
export const SCHEMA = 2;

export type RecordKind = "page" | "heading" | "action";
export type RecordSource = "collection" | "html" | "hook" | "emdash";

/** The fields every record has. */
interface RecordBase {
	/** `<locale>:<canonical url>`; a heading's URL carries its rendered anchor. */
	id: string;
	locale: string;
	/** The content type, for tabs and grouping ("docs", "learn", ...). */
	type: string;
	/** Canonical, cleaned URL (core/url.ts). An action may have none. */
	url?: string;
	/** The page's title. A heading carries its page's title too. */
	title: string;
	/** Plain text: a page's text before its first heading, or only this heading's section. */
	text: string;
	/** Facet values are always arrays. */
	facets: Record<string, string[]>;
	source: RecordSource;
}

/** A page. */
export interface PageRecord extends RecordBase {
	kind: "page";
	url: string;
	/** The owner's extra search words ("start", "guide"). Indexed with the facet values. */
	keywords?: string[];
	pageId?: never;
	heading?: never;
	command?: never;
}

/** One heading's section of a page. */
export interface HeadingRecord extends RecordBase {
	kind: "heading";
	/** The URL with the heading's rendered anchor. */
	url: string;
	/** The page's id. */
	pageId: string;
	heading: string;
	keywords?: never;
	command?: never;
}

/** An action: a URL, or a command the site handles. */
export interface ActionRecord extends RecordBase {
	kind: "action";
	/** An action's name, which the site handles (an action with no URL). */
	command?: string;
	pageId?: never;
	heading?: never;
	keywords?: never;
}

/** One searchable record: a page, one heading's section of a page, or an action. */
export type SearchRecord = PageRecord | HeadingRecord | ActionRecord;

/** What an adapter returns: a record plus where it came from, for build errors. Origin never reaches the index. */
export interface SourcedRecord {
	record: SearchRecord;
	origin: string;
}

export interface Capabilities {
	fuzzy: boolean;
	prefix: boolean;
	facets: boolean;
	highlights: boolean;
	/** Reads the index setting `synonyms`. An engine without it ignores the setting (the controller warns in dev). */
	synonyms?: boolean;
}

export interface Weights {
	title: number;
	heading: number;
	text: number;
	/** A page's own keywords and its facet values, indexed as words so "lodestar dark mode" finds Lodestar's page. */
	keywords: number;
}

/** "type", a facet name, or false (mixed by score). A facet may not be named "type". */
export type GroupBy = "type" | false | (string & {});

/** A link the dialog shows in an empty box, before any query. */
export interface SuggestedLink {
	label: string;
	/** A canonical URL on this site, as a record's. */
	href: string;
	/** A content type of the index, for the link's type label and analytics. */
	type?: string;
}

export interface IndexSettings {
	weights: Weights;
	group: { dialog: GroupBy; page: GroupBy };
	/** "best": the group with the best match first. An array fixes the order; groups not named follow by best. */
	groupOrder: "best" | string[];
	/** `weight` multiplies the score of every record of that type (default 1), so "vesper" ranks the theme page over its docs. */
	types: Record<string, { label: string; weight?: number }>;
	facets: Record<string, { label: string; values?: Record<string, string> }>;
	/** This file's locale's suggested links (at most 8). */
	suggested?: SuggestedLink[];
	/** Groups of folded words that match each other: a query word in a group is searched as any word of its group. */
	synonyms?: string[][];
	/** A folded, squashed query -> canonical page URLs shown first, in that order, when they pass the filters. */
	pinned?: Record<string, string[]>;
	/** Characters of each record's text the file keeps. Leave out to keep it whole. Cut words stay searchable. */
	clip?: number;
}

/** One engine hit: a record id, its score, and the query terms it matched, by field. */
export interface EngineHit {
	id: string;
	score: number;
	/** Indexed terms that matched exactly or by prefix (not fuzzy near-misses), for highlights. */
	terms: string[];
	/** Matched term -> the fields it matched in. */
	match: Record<string, string[]>;
	/** The query terms (from `terms(q)`) this hit matched, for the page-level AND in core/search.ts. */
	queryTerms: string[];
}

/** A loaded index, ready to search. */
export interface SearchEngine {
	readonly name: string;
	readonly capabilities: Capabilities;
	/** Every record that matches any query term (OR). core/search.ts applies the AND per page, after the filters. */
	search(q: string): EngineHit[];
	/** The query as the engine tokenizes and folds it, deduped. */
	terms(q: string): string[];
	record(id: string): SearchRecord | undefined;
	records(): readonly SearchRecord[];
}

/** One index file: one index, one locale, one engine. */
export interface IndexFile {
	schema: typeof SCHEMA;
	engine: string;
	engineVersion: string;
	index: string;
	locale: string;
	settings: IndexSettings;
	/** The records, packed (core/pack.ts): each page's fields once, its sections as short arrays. */
	records: PackedRecords;
	data?: unknown;
}

export interface EngineFactory {
	readonly name: string;
	readonly version: string;
	readonly capabilities: Capabilities;
	build(index: string, locale: string, records: SearchRecord[], settings: IndexSettings): IndexFile;
	load(file: IndexFile): SearchEngine;
}

export interface Manifest {
	schema: typeof SCHEMA;
	defaultLocale: string;
	indexes: Record<string, { version: string; locales: Record<string, string> }>;
}

export interface Query {
	q: string;
	/** The types this surface may show (a dialog's `types`). Empty or missing: all of the index's types. */
	types?: string[];
	/** The active type tab. Null: all. */
	type?: string | null;
	/** Facet picks: OR inside a facet, AND across facets. */
	picks?: Record<string, string[]>;
	group?: GroupBy;
	/** Pages to return (the counts are over all matches). */
	limit?: number;
	/** Headings listed under one page. */
	headingsPerPage?: number;
	/**
	 * Only records with a URL (the search page, which lists links): an action with no URL is left out before the
	 * page-level AND, so it never decides that only it matches every word. Default false (the dialog runs actions).
	 */
	linked?: boolean;
}

/** [start, end) ranges in a string, for <mark>. */
export type Ranges = [number, number][];

export interface Highlight {
	title: Ranges;
	heading?: Ranges;
	snippet: { text: string; ranges: Ranges };
}

export interface ResultHeading {
	record: SearchRecord;
	score: number;
	highlight: Highlight;
}

/** One page in the results, with its matched headings under it. */
export interface ResultItem {
	page: SearchRecord;
	score: number;
	highlight: Highlight;
	headings: ResultHeading[];
}

export interface ResultGroup {
	/** The type or facet value; "" when mixed. */
	key: string;
	label: string;
	items: ResultItem[];
}

export interface FacetCount {
	value: string;
	label: string;
	count: number;
	picked: boolean;
}

export interface SearchResult {
	query: Query;
	/** Unique matching pages, over all matches, before `limit`. */
	total: number;
	groups: ResultGroup[];
	/** Per type, for the tabs. Ignores the type tab, keeps the facet picks. */
	types: FacetCount[];
	/** Per facet. Each ignores its own picks (disjunctive). */
	facets: Record<string, FacetCount[]>;
}

/** What the controller calls to search a loaded index. core/search.ts makes one. */
export interface Searcher {
	readonly capabilities: Capabilities;
	readonly settings: IndexSettings;
	/** The locale of the loaded index file (loadSearcher sets it), for analytics events. */
	readonly locale?: string;
	run(query: Query): SearchResult;
}
