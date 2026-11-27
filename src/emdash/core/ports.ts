/**
 * The small context the EmDash core needs, and the types its parts share.
 *
 * Types only. The core (`src/emdash/core/**`) imports nothing from `emdash`, `node:*`, `react` or `astro`:
 * the native wrapper (`src/emdash/plugin.ts`) builds these ports from EmDash's plugin context, and the
 * tests build them from fakes (`test/emdash/fake-kv.ts`, `test/emdash/fake-content.ts`).
 *
 * Written once (Task A0). A later task that needs a new shared type asks first instead of editing this file.
 */

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Everything the core touches outside itself. */
export interface SearchPorts {
	kv: KvPort;
	content: ContentPort;
	schema: SchemaPort;
	/** Taxonomy terms; read only with `taxonomyKeywords`. Left out: none can be read. */
	terms?: TermsPort;
	log: LogPort;
	/** Queues the one-shot cron task `rebuild-soon` at `at` (EmDash `cron.schedule`). */
	queue(at: Date): Promise<void>;
	/** Runs `task` after the response is sent (EmDash `after()`); errors are the wrapper's to log. */
	defer(task: () => Promise<void>): void;
	/** Milliseconds since the epoch. A fake clock in tests. */
	now(): number;
}

/** A value read with its revision (EmDash `VersionedValue`). */
export interface Versioned<T> {
	value: T;
	/** Opaque host revision, valid only for the key it was read from. */
	revision: string;
}

/** EmDash `ConditionalWriteResult`: a conflict is `applied: false`; an error rejects. */
export type CompareAndSetResult = { applied: true; revision: string } | { applied: false };

/**
 * Plugin KV (EmDash `ctx.kv`), only the calls the core uses.
 *
 * - Every value is stored as `JSON.stringify(value)`. On D1 a row holds at most 2,000,000 bytes.
 * - `compareAndSet` takes `null` to create only when absent, and rejects a value over 1 MiB of JSON.
 * - `set` gives the key a new revision too.
 * - Never use a key that starts with `settings:`: EmDash sends those to its plugin settings store.
 */
export interface KvPort {
	get<T>(key: string): Promise<T | null>;
	getVersioned<T>(key: string): Promise<Versioned<T> | null>;
	compareAndSet(key: string, expectedRevision: string | null, value: unknown): Promise<CompareAndSetResult>;
	set(key: string, value: unknown): Promise<void>;
	/** True when the key existed. */
	delete(key: string): Promise<boolean>;
}

/** EmDash `ContentItemSeo`, the fields the core reads. */
export interface EmDashSeo {
	title?: string | null;
	description?: string | null;
	noIndex?: boolean;
}

/** One content entry as EmDash's `ctx.content.list()` returns it (`ContentItem`), the fields the core reads. */
export interface EmDashEntry {
	id: string;
	/** The collection slug. */
	type: string;
	slug: string | null;
	/** `"published"`, `"draft"`, `"scheduled"`, ... Only `"published"` is indexed. */
	status: string;
	/** Null on a site with no i18n: the default locale. */
	locale: string | null;
	/** The collection's own fields (`title`, `content` as Portable Text, `excerpt`, `searchKeywords`, ...). */
	data: Record<string, unknown>;
	/** Present only on collections with SEO turned on. */
	seo?: EmDashSeo;
	publishedAt?: string | null;
	scheduledAt?: string | null;
	updatedAt?: string;
}

export interface ContentPort {
	/**
	 * One page of a collection (every status and locale; the core applies the skip rules), in EmDash's default list
	 * order: newest created first, then the higher id (`ContentRepository.findMany`), the same order the theme's
	 * `getEmDashCollection` reads (the loader's default), so the first published entry is the one a theme takes.
	 */
	list(collection: string, cursor?: string): Promise<{ items: EmDashEntry[]; nextCursor?: string }>;
	/**
	 * The entry's public pathname from EmDash's own resolver (`getPublicUrl`), kept as given (locale
	 * prefix, encoded slug, trailing slash). Null: not routable or no slug, so the entry is skipped.
	 */
	publicPath(collection: string, id: string): Promise<string | null>;
	/**
	 * The rules EmDash's resolver uses to build an entry's public path (optional). When given, the core
	 * builds every path itself from the listed rows (`entryPath` in `paths.ts`), with no query per entry;
	 * `publicPath` is then not called. Left out: one `publicPath` call per entry.
	 */
	urlRules?(): UrlRules;
	/**
	 * EmDash's site URL (`ctx.site.url`). Null or empty: not set. The index holds paths only, so a build needs none;
	 * when set, it is kept on the index for the admin's "Built for" line.
	 */
	siteUrl(): string | null;
	/** EmDash's default locale, or `"en"` on a site with no i18n. */
	defaultLocale(): string;
}

/** One Astro i18n locale: a code, or a custom path with the codes it serves (Astro `i18n.locales`). */
export type UrlLocale = string | { path: string; codes: readonly string[] };

/** What EmDash's `getPublicUrl` reads besides the row and its collection (`i18n/resolve.ts`, `SiteInfo`). */
export interface UrlRules {
	/** EmDash's site locale (`ctx.site.locale`), used for a row with no locale. */
	siteLocale: string;
	/** Astro's `trailingSlash` (`ctx.site.trailingSlash`). Left out: `"ignore"`. */
	trailingSlash?: "always" | "never" | "ignore";
	/** Astro's i18n routing. Null: not configured (no locale prefix). */
	i18n: { defaultLocale: string; locales: readonly UrlLocale[]; prefixDefaultLocale?: boolean } | null;
}

/** EmDash `CollectionSchemaInfo`, the fields the core reads. */
export interface CollectionInfo {
	slug: string;
	label: string;
	/** Has `"search"` when the collection opts into search. */
	supports: string[];
	routable: boolean;
	hidden: boolean;
	urlPattern?: string | null;
	/** The collection's field slugs. Left out: not known, so no check on them. */
	fields?: string[];
}

export interface SchemaPort {
	listCollections(): Promise<CollectionInfo[]>;
}

export interface TermsPort {
	/**
	 * The term labels of entries of one collection in one locale, per entry id and taxonomy name. An entry with no terms
	 * may be left out. Batched: the caller gives the entries of one list page.
	 */
	labels(collection: string, ids: readonly string[], locale: string): Promise<ReadonlyMap<string, Readonly<Record<string, readonly string[]>>>>;
}

export interface LogPort {
	info(message: string, data?: Record<string, unknown>): void;
	warn(message: string, data?: Record<string, unknown>): void;
	error(message: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Options (code only, JSON only: EmDash writes them into generated code)
// ---------------------------------------------------------------------------

/** One page that lists collections (`listPages`). */
export interface ListPage {
	/** The page's site path, literal, with no base and no locale prefix ("/speaking"). */
	path: string;
	/** Where its words come from: whole collections (published, not `noIndex`, in the page's locale), in this order. `fields` hold a string or Portable Text. */
	from: Array<{ collection: string; fields: string[] }>;
	/** Makes the page in the default locale when no published entry of the indexed collections has the path. Left out: none is made. */
	fallback?: { title: string; text?: string };
	/** The type of the page `fallback` makes. Default "pages". */
	type?: string;
}

/**
 * One `textFields` entry: a field slug, a prefix ending in "*", or a field of blocks with the keys whose words count
 * (`{ field: "case_blocks", keys: ["heading", "text", "steps"] }`; everything under a listed key counts).
 */
export type TextField = string | { field: string; keys: string[] };

/** One switch rule (`excludeWhen`). */
export interface ExcludeWhen {
	/** A collection with one entry that holds the switch (a settings collection). It needs no search, route or URL. */
	collection: string;
	/** The field of that entry that holds the switch. */
	field: string;
	/** The field values that turn the paths off. `null` also stands for an empty field and for no published entry. */
	values: Array<string | number | boolean | null>;
	/** Site paths, as in `exclude`: exact, or with a `*` for any one segment. */
	paths: string[];
}

export interface PluginOptions {
	/** Collection slugs. Default: every collection with `search` in `supports`, `routable` and not `hidden`. */
	collections?: string[];
	/**
	 * Site paths to leave out, as in `html()`: exact ("/speaking"), where each "*" segment is any one segment
	 * ("/projects/*"). No base. A path with no locale prefix is left out in every locale.
	 */
	exclude?: string[];
	/**
	 * Pages whose theme route lists whole collections: the words of those entries go to the end of the page's text, so a
	 * search for an item finds the page. See `ListPage`.
	 */
	listPages?: ListPage[];
	/**
	 * Site paths to leave out while a switch is set: at each build the plugin reads the one published entry of
	 * `collection`, and when its `field` holds one of `values`, the `paths` are left out as `exclude` leaves them out. See
	 * `ExcludeWhen`.
	 */
	excludeWhen?: ExcludeWhen[];
	/**
	 * Taxonomies whose term labels are keywords of their entries (["category", "tag"]), after the entry's own keywords.
	 * Default: none. A term set or renamed on its own fires no content hook (EmDash 1.4): it shows after the next build.
	 */
	taxonomyKeywords?: string[];
	/**
	 * More fields to search, per collection slug: their words follow the entry's lead text, before `content`
	 * (`{ projects: ["problem", "result", "case_*"], areas: ["intro"] }`). A field holds a string, Portable Text or a list
	 * of blocks. A name that ends in "*" is every field whose slug starts with the rest, in the collection's field order.
	 * `{ field: "case_blocks", keys: ["heading", "text"] }` reads only those keys of each block. Default: none.
	 */
	textFields?: Record<string, TextField[]>;
	/** The size warning for each locale's index file, gzipped. Default 300 KB. */
	budget?: { gzipKB: number };
	/** Characters of each record's text the index keeps. Leave out to keep it whole. */
	clip?: number;
	/** Where the site serves the embed files. Default `/_search/embed/`; must match `searchFiles()`. */
	filesPath?: string;
}

// ---------------------------------------------------------------------------
// State (the one versioned `state` key; plan decision 5)
// ---------------------------------------------------------------------------

/** One locale's stored index file. */
export interface LocaleIndex {
	chunks: number;
	etag: string;
	gzBytes: number;
	rawBytes: number;
}

/** The index the routes serve. */
export interface ActiveIndex {
	runId: string;
	version: string;
	builtAt: number;
	locales: Record<string, LocaleIndex>;
	pages: number;
	sections: number;
	records: number;
	skipped: number;
	/** EmDash's site URL when the build ran, if one was set. */
	siteUrl?: string;
}

export interface Lease {
	runId: string;
	/** ms; past this the lease is dead and may be taken over. */
	until: number;
	/** The chunk count of each locale this run writes, recorded before its first chunk write. */
	locales?: Record<string, number>;
	/** The `dirty` value this run covers (an interrupted run settles at it). */
	gen?: number;
	/** The run recorded its own result (a `deadline` failure) and left the lease to expire; a takeover does not count it as interrupted. */
	recorded?: boolean;
}

/** A run whose chunks are to be deleted. `locales: null`: chunk counts unknown, probe until a miss. */
export interface RetiredRun {
	runId: string;
	locales: Record<string, number> | null;
}

/** Why a build did not publish. */
export type BuildErrorCode = "running" | "lost-lease" | "too-large" | "no-collections" | "deadline" | "plan-limit" | "interrupted" | "error";

export interface LastBuild {
	ok: boolean;
	at: number;
	error?: string;
	errorCode?: BuildErrorCode;
}

export interface HistoryEntry {
	builtAt: number;
	/** The largest locale file, as in the `indexes` route's `active` (the budget is per locale file). */
	gzBytes: number;
	rawBytes: number;
	pages: number;
	sections: number;
}

export interface SearchState {
	/** Bumped by every content change and by Rebuild now. */
	dirty: number;
	/** The `dirty` value the active index was built from. */
	builtGen: number;
	/** ms; the last bump. */
	lastChangeAt: number | null;
	/** ms; the first bump since the last build. */
	dirtySince: number | null;
	/** Nightly or Rebuild now: build even if `dirty === builtGen`. */
	force: boolean;
	lease: Lease | null;
	active: ActiveIndex | null;
	retired: RetiredRun[];
	last: LastBuild | null;
	/** The last 10 builds, newest last. */
	history: HistoryEntry[];
	/**
	 * Runs in a row whose lease expired before they recorded any result (a Worker killed at a CPU or D1
	 * query limit). Reset by any run that records a result; at `INTERRUPTED_LIMIT` the build settles with
	 * `interrupted`.
	 */
	interrupted: number;
}

export type BuildResult = { ok: true; active: ActiveIndex } | { ok: false; code: BuildErrorCode; error?: string };

/** Why `runIfDue` was called. */
export type RunReason = "tick" | "soon" | "nightly" | "admin";

/** What `createRoutes` gets to start a build from the admin (the wrapper runs it through `after()`). */
export type RequestRebuild = () => Promise<{ started: boolean; code?: "running" | "no-collections" }>;

// ---------------------------------------------------------------------------
// Settings (the `settings` key; plan decision 9; no rebuild)
// ---------------------------------------------------------------------------

export interface SearchSettings {
	/** Up to 2 shortcut keys. Default `["mod+k", "/"]`. */
	keys: string[];
	takeover: { enabled: boolean; inputName: string };
	placeholder: string;
	/** `"auto"` leaves `theme` out of the config tag. */
	theme: "auto" | "light" | "dark";
	/** The results page URL. Default `/search`. */
	results: string;
}

// ---------------------------------------------------------------------------
// Routes (platform-free; the wrapper maps them to EmDash routes)
// ---------------------------------------------------------------------------

export type RouteMethod = "GET" | "HEAD" | "POST";

export interface RouteRequest {
	method: RouteMethod;
	/** The request's query string. */
	query: URLSearchParams;
	headers: { get(name: string): string | null };
	/** The parsed JSON body of a POST. */
	body?: unknown;
}

export interface RouteResponse {
	status: number;
	headers: Record<string, string>;
	/** Left out for HEAD and 304. */
	body?: string;
}

export interface RouteHandler {
	/** Public routes skip EmDash's auth; every other route needs `plugins:manage`. */
	public: boolean;
	methods: readonly RouteMethod[];
	handle(request: RouteRequest): Promise<RouteResponse>;
}

/** Route names: `manifest` and `index` are public; the rest are private. */
export type RouteName = "manifest" | "index" | "indexes" | "status" | "rebuild" | "settings";

// Private route bodies (plan decision 8), shared by `routes.ts` and the admin's `api.ts`.

export interface IndexesItem {
	name: "default";
	active: { gzBytes: number; rawBytes: number; pages: number; sections: number; builtAt: number; siteUrl?: string } | null;
	budgetKB: number;
	history: HistoryEntry[];
}

export type IndexesResponse = IndexesItem[];

export interface StatusResponse {
	state: "idle" | "queued" | "running" | "failed";
	pages?: number;
	sections?: number;
	/** ms; when the active index was built, so a rebuild with the same counts still reads as new. */
	builtAt?: number;
	error?: string;
	errorCode?: BuildErrorCode;
	pending: boolean;
}

export interface RebuildResponse {
	started: boolean;
	code?: "running" | "no-collections";
	status: StatusResponse;
}
