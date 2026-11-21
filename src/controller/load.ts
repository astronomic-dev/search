/**
 * Loads one index in the browser: the manifest, then the one file for the page's locale. The engine and createSearch
 * are passed in, so this file imports no core runtime (only types and the small locale lookup). `prefetch` (the
 * early loads a boot script starts) is in prefetch.ts.
 */
import { matchLocale } from "../core/locale.ts";
import { own } from "../core/own.ts";
import type { Prefetch } from "./prefetch.ts";
import { SCHEMA, type EngineFactory, type IndexFile, type IndexSettings, type Manifest, type SearchEngine, type Searcher } from "../core/types.ts";

/**
 * The locale of `index` for a page in `lang`: the closest of the index's locales by BCP 47 lookup (see `matchLocale`),
 * else the default.
 */
export function pickLocale(lang: string | null | undefined, manifest: Manifest, index: string): string {
	return matchLocale(lang, Object.keys(own(manifest.indexes, index)?.locales ?? {})) ?? manifest.defaultLocale;
}

export interface LoadOptions {
	index: string;
	/** The page's `<html lang>`. */
	lang: string | null | undefined;
	manifestUrl: string;
	/** Called with `{ cache: "no-cache" }` for the manifest, so a new deploy is seen; pass the init on to `fetch`. */
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	engine: EngineFactory;
	createSearch: (engine: SearchEngine, settings: IndexSettings) => Searcher;
	/**
	 * Loads already started (see `prefetch`), used once. Used only for the same index and manifest URL, and its file
	 * only when it is the one this load picks now (`<html lang>` can change after a route swap). When a prefetch
	 * failed, the plain fetch is made; a prefetched 404 on the file takes the retry path below.
	 */
	prefetch?: Prefetch;
}

/** `url` against the manifest's URL; a relative manifest URL gives a path back. */
function resolve(url: string, manifestUrl: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(manifestUrl)) return new URL(url, manifestUrl).href;
	const u = new URL(url, new URL(manifestUrl, "http://h/"));
	return u.pathname + u.search;
}

class HttpError extends Error {
	status: number;
	constructor(url: string, status: number) {
		super(`Search: ${url} returned ${status}`);
		this.status = status;
	}
}

async function getJson(fetch: LoadOptions["fetch"], url: string, init?: RequestInit): Promise<unknown> {
	let res: Response;
	try {
		res = await (init ? fetch(url, init) : fetch(url));
	} catch {
		throw new Error(`Search: could not fetch ${url}`);
	}
	if (!res.ok) throw new HttpError(url, res.status);
	try {
		return await res.json();
	} catch {
		throw new Error(`Search: ${url} is not valid JSON`);
	}
}

/** The locale and file URL of `index` for a page in `lang`; undefined when the index or its files are missing. */
function fileFor(manifest: Manifest, index: string, lang: string | null | undefined, manifestUrl: string): { url: string; locale: string } | undefined {
	const entry = own(manifest.indexes, index);
	if (!entry) return undefined;
	const picked = pickLocale(lang, manifest, index);
	const locale = Object.hasOwn(entry.locales, picked) ? picked : Object.keys(entry.locales)[0];
	const path = locale === undefined ? undefined : own(entry.locales, locale);
	return path && locale !== undefined ? { url: resolve(path, manifestUrl), locale } : undefined;
}

/**
 * The manifest, revalidated each time (it is the one file whose name does not change on a deploy). `given` is a
 * prefetched one; if it failed, the manifest is fetched here.
 */
async function getManifest(options: LoadOptions, given?: Promise<unknown>): Promise<{ manifest: Manifest; url: string; locale: string }> {
	const { index, manifestUrl, fetch } = options;
	const early = given && (await given.then((m) => ({ m }), () => undefined));
	const manifest = (early ? early.m : await getJson(fetch, manifestUrl, { cache: "no-cache" })) as Manifest;
	if (manifest?.schema !== SCHEMA) throw new Error(`Search: ${manifestUrl} has schema ${manifest?.schema}, expected ${SCHEMA}`);
	if (!own(manifest.indexes, index)) throw new Error(`Search: no index named "${index}" in ${manifestUrl}`);
	const file = fileFor(manifest, index, options.lang, manifestUrl);
	if (!file) throw new Error(`Search: index "${index}" has no files`);
	return { manifest, ...file };
}

/** Prefetches already used by a load. */
const used = new WeakSet<Prefetch>();

/**
 * The manifest, then the index file it names. A 404 on that file means a deploy replaced it after an older manifest
 * was read (a cache in between): the manifest is fetched once more, and the file it names now is loaded.
 */
export async function loadSearcher(options: LoadOptions): Promise<Searcher> {
	const { fetch, engine } = options;
	const p = options.prefetch;
	// Used once: the same object passed again (a later load, after a deploy) loads fresh.
	const given = p && !used.has(p) && p.index === options.index && p.manifestUrl === options.manifestUrl ? p : undefined;
	if (given) used.add(given);
	let { url, locale } = await getManifest(options, given?.manifest);
	let file: IndexFile;
	try {
		// The prefetched file, if it is the one picked now: its JSON, or its 404 (then the retry below). Else a fetch.
		// Its URL is checked first, so a stalled load of another file (the lang changed) is not waited on.
		const same = given && (await given.fileUrl.then((u) => u === url, () => false));
		const early = same ? await given.file.then((f) => f, () => undefined) : undefined;
		if (early?.status === 404) throw new HttpError(url, 404);
		file = (early && "data" in early ? early.data : await getJson(fetch, url)) as IndexFile;
	} catch (e) {
		if (!(e instanceof HttpError) || e.status !== 404) throw e;
		const again = await getManifest(options);
		if (again.url === url) throw e;
		url = again.url;
		locale = again.locale;
		file = (await getJson(fetch, url)) as IndexFile;
	}
	if (file?.schema !== SCHEMA) throw new Error(`Search: ${url} has schema ${file?.schema}, expected ${SCHEMA}`);
	if (file.engine !== engine.name) throw new Error(`Search: ${url} needs engine "${file.engine}", not "${engine.name}"`);
	if (file.engineVersion !== engine.version) throw new Error(`Search: ${url} was built by ${engine.name} version "${file.engineVersion}", not "${engine.version}"`);
	// A manifest entry that points at the wrong file (swapped by hand, or a bad deploy) must not load silently.
	if (file.index !== options.index) throw new Error(`Search: ${url} holds index "${file.index}", not "${options.index}"`);
	if (file.locale !== locale) throw new Error(`Search: ${url} holds locale "${file.locale}", not "${locale}"`);
	const searcher = options.createSearch(engine.load(file), file.settings);
	return { capabilities: searcher.capabilities, settings: searcher.settings, locale: file.locale, run: (q) => searcher.run(q) };
}
