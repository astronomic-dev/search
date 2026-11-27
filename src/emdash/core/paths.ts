/**
 * Public paths, and the checks on them (`exclude`, `listPages`).
 *
 * Platform-free: no `emdash`, `node:*`, `react` or `astro` imports.
 */
import { matchPath } from "../../core/match-path.ts";
import type { CollectionInfo, ContentPort, EmDashEntry, UrlRules } from "./ports.ts";

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
	return localizedPath(interpolate(c.urlPattern ?? null, c.slug, e.slug, e.id, e.publishedAt), e.locale || rules.siteLocale, rules);
}

/** `path` (no locale prefix) in `locale`, with its prefix and the site's trailing slash. Null: a locale the site does not serve. */
export function localizedPath(path: string, locale: string, rules: UrlRules): string | null {
	const segment = localeSegment(rules.i18n, locale);
	if (segment === undefined) return null;
	const localized = segment === null || segment === "" ? normalizePath(path) : normalizePath(`/${segment}${path}`);
	if (localized === "/") return localized;
	if (rules.trailingSlash === "always") return `${localized}/`;
	if (rules.trailingSlash === "never") return localized.replace(TRAILING_SLASH, "");
	return localized;
}

/** A site path: starts with one "/", with no query, hash or lone surrogate (`encodeURIComponent` throws on one). */
export const isSitePath = (p: unknown): boolean => typeof p === "string" && /^\/(?!\/)[^?#]*$/.test(p) && !/\p{Cs}/u.test(p);

/** Throws unless `input` is a list of site paths. */
export function checkExclude(input: unknown): asserts input is string[] {
	if (Array.isArray(input) && input.every(isSitePath)) return;
	throw new Error(`Search: search(): exclude must be a list of site paths that start with one "/" and have no "?" or "#" (["/speaking", "/projects/*"]), not ${JSON.stringify(input)}`);
}

/**
 * Each segment of a path in one spelling, so "/café", "/caf%C3%A9" and "/caf%c3%a9" are the same. An encoded slash
 * stays encoded, and so does an asterisk ("%2A"), so it is never read as a wildcard.
 */
export const canonicalPath = (path: string, fold = false): string =>
	path
		.split("/")
		.map((s) => {
			let plain = s;
			try {
				plain = decodeURIComponent(s);
			} catch {
				// Not valid percent-encoding: the text as typed.
			}
			// `fold`: in lowercase too, for checks that ignore case ("/Café" and "/caf%C3%A9").
			return encodeURIComponent(fold ? plain.toLowerCase() : plain).replaceAll("*", "%2A");
		})
		.join("/");

/** A site path in one spelling, with no repeated or trailing slash. */
export const canonicalSitePath = (path: string): string => canonicalPath(normalizePath(path));

/** A pattern in the same spelling, in lowercase; each "*" stays a wildcard, a whole segment or part of one. */
const canonicalPattern = (pattern: string): string =>
	pattern
		.split("/")
		.map((s) =>
			s
				.split("*")
				.map((part) => canonicalPath(part, true))
				.join("*"),
		)
		.join("/");

/** The URL prefix of a locale ("/fr") in one spelling; "" for none. With no URL rules: "". */
function localePrefix(locale: string | null, rules: UrlRules | undefined): string {
	const segment = rules ? localeSegment(rules.i18n, locale || rules.siteLocale) : null;
	return segment ? canonicalPath(`/${segment}`) : "";
}

/** The URL prefixes of the site's locales. */
const localePrefixes = (rules: UrlRules | undefined): string[] =>
	(rules?.i18n?.locales ?? []).map((l) => localePrefix(typeof l === "string" ? l : l.path, rules)).filter((p) => p !== "");

/** Whether a canonical path starts with the URL prefix of one of the site's locales. */
export const startsWithLocale = (path: string, rules: UrlRules | undefined): boolean => localePrefixes(rules).some((p) => path === p || path.startsWith(`${p}/`));

/** An entry's public path with no locale prefix, as `canonicalSitePath`. */
export const neutralPath = (url: string, locale: string | null, rules: UrlRules | undefined): string =>
	canonicalSitePath(canonicalPath(url).slice(localePrefix(locale, rules).length) || "/");

const LOOSE = { loose: true } as const;

/**
 * The `exclude` check for one build (`matchPath`, so a trailing slash makes no difference).
 * - A pattern that starts with the URL prefix of one of the site's locales ("/fr/speaking") is compared with that
 *   locale's whole paths only. The locale wins over a page slug that equals its prefix.
 * - Any other pattern is compared with the path without its locale prefix: "/speaking" leaves out "/speaking" and
 *   "/fr/speaking". A "*" never stands for the prefix, so a pattern means the same pages in every locale.
 * With no URL rules the whole path is compared. Case makes no difference, and a "*" inside a segment is any run of
 * characters there ("/sitemap-*.xml").
 */
export function excluder(exclude: string[] | undefined, rules: UrlRules | undefined): (url: string, locale: string | null) => boolean {
	if (!exclude || exclude.length === 0) return () => false;
	// In lowercase, as the patterns: the check ignores case.
	const prefixes = localePrefixes(rules).map((p) => canonicalPath(p, true));
	// Patterns by the locale prefix they spell out; "" for none.
	const byPrefix = new Map<string, string[]>();
	for (const pattern of exclude.map(canonicalPattern)) {
		const prefix = prefixes.find((x) => pattern === x || pattern.startsWith(`${x}/`)) ?? "";
		byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), pattern]);
	}
	const plain = byPrefix.get("") ?? [];
	return (url, locale) => {
		const path = canonicalPath(url, true);
		const prefix = canonicalPath(localePrefix(locale, rules), true);
		if (prefix === "") return matchPath(path, plain, LOOSE);
		return matchPath(path.slice(prefix.length) || "/", plain, LOOSE) || matchPath(path, byPrefix.get(prefix) ?? [], LOOSE);
	};
}
