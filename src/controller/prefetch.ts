/**
 * The early loads a boot script starts on first use: the manifest, then the index file it names, alongside the app's
 * own load. `loadSearcher` (load.ts) takes them as `prefetch`. This file imports nothing at runtime, not even core's
 * small helpers, so a bundler that splits code (Vite in an Astro site) keeps it inside the boot script, with no chunk
 * shared with the app. That is why `resolve` and the own-key lookup are repeated here.
 */
import type { Manifest } from "../core/types.ts";
import type { LoadOptions } from "./load.ts";

/** The manifest and index file loads that boot starts on first use, alongside the app's own load. */
export interface Prefetch {
	index: string;
	manifestUrl: string;
	/** The manifest's JSON. */
	manifest: Promise<unknown>;
	/**
	 * The URL of the file the manifest names for the page's lang, known as soon as the manifest is in (undefined when
	 * nothing is prefetched). Apart from `file`, so a load for another file never waits on this one's response.
	 */
	fileUrl: Promise<string | undefined>;
	/** The file the manifest names for the page's lang: its URL, and its JSON or the HTTP status it failed with. */
	file: Promise<{ url: string; data?: unknown; status?: unknown }>;
}

/** `url` against the manifest's URL; a relative manifest URL gives a path back (as load.ts does). */
function resolve(url: string, manifestUrl: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(manifestUrl)) return new URL(url, manifestUrl).href;
	const u = new URL(url, new URL(manifestUrl, "http://h/"));
	return u.pathname + u.search;
}

const own = <T>(obj: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);

/**
 * The file URL `fileFor` gives, for the common cases only, with no `Intl` maximizing: the plain BCP 47 lookup of
 * `matchLocale`, the one locale of a single-locale index, and the default for no lang. Undefined otherwise (then
 * nothing is prefetched). Kept apart from load.ts's `fileFor` so the boot script stays small.
 */
function quickFile(manifest: Manifest, index: string, lang: string | null | undefined, manifestUrl: string): string | undefined {
	const locales = own(manifest.indexes, index)?.locales;
	if (!locales) return undefined;
	const keys = Object.keys(locales);
	const parts = (lang ?? "").trim().toLowerCase().split("-").filter(Boolean);
	let hit: string | undefined;
	for (let n = parts.length; n > 0 && !hit; n--) hit = keys.find((k) => k.toLowerCase() === parts.slice(0, n).join("-"));
	if (!hit && (keys.length === 1 || !parts.length)) hit = Object.hasOwn(locales, manifest.defaultLocale) ? manifest.defaultLocale : keys[0];
	const path = hit && own(locales, hit);
	return path ? resolve(path, manifestUrl) : undefined;
}

/**
 * Starts the manifest load now, and the index file's as soon as the manifest is in, for `loadSearcher` to take as
 * `prefetch` later. Small and free of the core runtime, so a boot script can call it alongside `import(app)`. Neither
 * promise is left as an unhandled rejection; `loadSearcher` falls back to its own fetch when one fails.
 */
export function prefetch(options: Pick<LoadOptions, "index" | "lang" | "manifestUrl" | "fetch">): Prefetch {
	const { index, lang, manifestUrl, fetch } = options;
	// No error messages here: a failed prefetch is never shown, loadSearcher fetches again and reports.
	const get = (url: string, init?: RequestInit) => fetch(url, init).then((r) => (r.ok ? r.json() : Promise.reject(r.status))) as Promise<unknown>;
	const manifest = get(manifestUrl, { cache: "no-cache" });
	// A bad manifest (null, not an object) throws here, and so rejects `fileUrl` and `file`.
	const fileUrl = manifest.then((m) => quickFile(m as Manifest, index, lang, manifestUrl));
	const file = fileUrl.then((url) => (url ? get(url).then((data) => ({ url, data }), (status) => ({ url, status })) : Promise.reject()));
	// `file` hangs off `fileUrl`, which hangs off `manifest`, so this one handler leaves none as an unhandled rejection.
	file.catch(() => {});
	return { index, manifestUrl, manifest, fileUrl, file };
}
