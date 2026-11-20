/**
 * Loads one index in the browser: the manifest, then the one file for the page's locale. The engine and createSearch
 * are passed in, so this file imports no core runtime (only types and the small locale lookup).
 */
import { matchLocale } from "../core/locale.ts";
import { own } from "../core/own.ts";
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

/** The manifest, revalidated each time (it is the one file whose name does not change on a deploy). */
async function getManifest(options: LoadOptions): Promise<{ manifest: Manifest; url: string; locale: string }> {
	const { index, manifestUrl, fetch } = options;
	const manifest = (await getJson(fetch, manifestUrl, { cache: "no-cache" })) as Manifest;
	if (manifest?.schema !== SCHEMA) throw new Error(`Search: ${manifestUrl} has schema ${manifest?.schema}, expected ${SCHEMA}`);
	const entry = own(manifest.indexes, index);
	if (!entry) throw new Error(`Search: no index named "${index}" in ${manifestUrl}`);
	const picked = pickLocale(options.lang, manifest, index);
	const locale = Object.hasOwn(entry.locales, picked) ? picked : Object.keys(entry.locales)[0];
	const path = locale === undefined ? undefined : own(entry.locales, locale);
	if (!path || locale === undefined) throw new Error(`Search: index "${index}" has no files`);
	return { manifest, url: resolve(path, manifestUrl), locale };
}

/**
 * The manifest, then the index file it names. A 404 on that file means a deploy replaced it after an older manifest
 * was read (a cache in between): the manifest is fetched once more, and the file it names now is loaded.
 */
export async function loadSearcher(options: LoadOptions): Promise<Searcher> {
	const { fetch, engine } = options;
	let { url, locale } = await getManifest(options);
	let file: IndexFile;
	try {
		file = (await getJson(fetch, url)) as IndexFile;
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
