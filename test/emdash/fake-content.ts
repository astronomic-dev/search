/**
 * In-memory EmDash content and schema ports for the core's tests.
 *
 * - `list(collection, cursor)` pages through a collection's entries (every status and locale, as EmDash's
 *   `ctx.content.list()` with no `where`), `pageSize` at a time.
 * - `publicPath(collection, id)` returns the path set for that id in `paths` (a `null` there means "not
 *   routable"), else `/<collection>/<slug>` for a routable collection with a slug, else `null`.
 * - With `urlRules`, the port also offers `urlRules()` (as the wrapper does), and the core builds paths
 *   itself; `publicPath` should then never be called.
 * - Every call is logged in `calls`, so a test can count the queries a build makes.
 */
import type { CollectionInfo, ContentPort, EmDashEntry, SchemaPort, UrlRules } from "../../src/emdash/core/ports.ts";

export interface FakeContentInput {
	collections?: CollectionInfo[];
	entries?: EmDashEntry[];
	/** Per entry id: the public path, kept as given, or `null`. */
	paths?: Record<string, string | null>;
	/** Default `https://example.com`. `null`: not set. */
	siteUrl?: string | null;
	/** Default `"en"`. */
	defaultLocale?: string;
	/** Offered as `content.urlRules()`. Left out: no `urlRules`, so the core calls `publicPath`. */
	urlRules?: UrlRules;
	/** Entries per `list()` page. Default 2, so tests cross a page boundary. */
	pageSize?: number;
}

export interface FakeContent {
	content: ContentPort;
	schema: SchemaPort;
	calls: Array<{ op: "list" | "publicPath" | "listCollections" | "urlRules"; collection?: string; id?: string }>;
	/** Adds or replaces an entry (by id). */
	put(entry: EmDashEntry): void;
	/** Removes an entry (by id). */
	remove(id: string): void;
}

/** A collection that opts into search, routable and shown. */
export function collection(slug: string, over: Partial<CollectionInfo> = {}): CollectionInfo {
	return { slug, label: slug.charAt(0).toUpperCase() + slug.slice(1), supports: ["search"], routable: true, hidden: false, urlPattern: `/${slug}/{slug}`, ...over };
}

let nextId = 1;

/** A published entry with a title, in the default locale. */
export function entry(type: string, slug: string | null, over: Partial<EmDashEntry> = {}): EmDashEntry {
	return { id: `e${nextId++}`, type, slug, status: "published", locale: null, data: { title: slug ?? "Untitled" }, ...over };
}

/** Portable Text blocks, one per paragraph; `[style, text]` for a styled block (`["h2", "Setup"]`). */
export function portableText(...blocks: Array<string | [string, string]>): unknown[] {
	return blocks.map((b, i) => {
		const [style, text] = typeof b === "string" ? ["normal", b] : b;
		return { _type: "block", _key: `b${i}`, style, markDefs: [], children: [{ _type: "span", _key: `s${i}`, text, marks: [] }] };
	});
}

export function createFakeContent(input: FakeContentInput = {}): FakeContent {
	const collections = input.collections ?? [];
	const entries = new Map<string, EmDashEntry>((input.entries ?? []).map((e) => [e.id, e]));
	const paths = input.paths ?? {};
	const pageSize = input.pageSize ?? 2;
	const siteUrl = input.siteUrl === undefined ? "https://example.com" : input.siteUrl;
	const calls: FakeContent["calls"] = [];

	const content: ContentPort = {
		async list(name, cursor) {
			calls.push({ op: "list", collection: name });
			const all = [...entries.values()].filter((e) => e.type === name);
			const start = cursor ? Number(cursor) : 0;
			const items = all.slice(start, start + pageSize).map((e) => structuredClone(e));
			const next = start + pageSize;
			return next < all.length ? { items, nextCursor: String(next) } : { items };
		},
		async publicPath(name, id) {
			calls.push({ op: "publicPath", collection: name, id });
			if (Object.hasOwn(paths, id)) return paths[id];
			const c = collections.find((x) => x.slug === name);
			const e = entries.get(id);
			if (!c?.routable || !e?.slug) return null;
			// As EmDash: the collection's URL pattern (or /<collection>/{slug}), the slug percent-encoded.
			return (c.urlPattern ?? `/${name}/{slug}`).replaceAll("{slug}", encodeURIComponent(e.slug));
		},
		...(input.urlRules
			? {
					urlRules: () => {
						calls.push({ op: "urlRules" });
						return structuredClone(input.urlRules as UrlRules);
					},
				}
			: {}),
		siteUrl: () => siteUrl,
		defaultLocale: () => input.defaultLocale ?? "en",
	};
	const schema: SchemaPort = {
		async listCollections() {
			calls.push({ op: "listCollections" });
			return structuredClone(collections);
		},
	};
	return {
		content,
		schema,
		calls,
		put: (e) => void entries.set(e.id, e),
		remove: (id) => void entries.delete(id),
	};
}
