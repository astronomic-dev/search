/**
 * The embed's settings, read at run time from the one config tag a server prints:
 * `<script type="application/json" data-search-config>{...}</script>`. Every bad value falls back to its default, and
 * a tag that cannot be used (not JSON, no manifest) gives null, so the page keeps working as it does with no
 * JavaScript (fail open). No listeners and no globals, so it runs under node --test.
 */
import type { StringsInput } from "../controller/index.ts";
import { writeUrl, type UrlNames } from "../page/url.ts";
import type { PageWords } from "../page/words.ts";
import type { SeeAll } from "../ui/render.ts";

export interface EmbedConfig {
	/** Absolute or root-relative URL of manifest.json. Required; without it the embed does nothing. */
	manifest: string;
	/** Default index for takeover, the results page and placements without data-search-index. Default "default". */
	index: string;
	/** Page language, BCP 47 (picks the index locale). Default: <html lang>. */
	lang?: string;
	/** The search results page URL ("See all results", the takeover action check). Default "/search". */
	results: string;
	/** Query parameter on the results URL. Default "q". */
	queryParam: string;
	/** Prefix for the type, index and facet parameters on the results URL. Default "". */
	paramPrefix: string;
	/** Shortcut keys, e.g. ["mod+k", "/"]; [] for none. They open the default index's dialog. */
	keys: string[];
	/** Dialog and page strings (see controller StringsInput and PageWords). */
	strings: StringsInput & Partial<PageWords>;
	/** Links shown in an empty dialog. */
	browse: { label: string; href: string }[];
	takeover: {
		/** Default false. Off whenever standDown is set. */
		enabled: boolean;
		/** Name of the theme form's search input. Default "q". Letters, digits, "_", "-" and "[]" only, else the default. */
		inputName: string;
		/** Forms matching (or inside) this selector are left alone. Default ".no-search-takeover". An invalid selector falls back to the default. */
		skip: string;
		/** Hidden input names a form may carry and still be taken over. Default ["lang"]. */
		allowFields: string[];
	};
	/** Name of another live search found on the page; when set, takeover is off (placements still work). */
	standDown?: string | null;
}

export const CONFIG_TAG = 'script[type="application/json"][data-search-config]';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, fallback: string): string => (typeof v === "string" && v ? v : fallback);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** Only the string values of `v` (an object), or undefined when it is not an object. */
function stringValues(v: unknown): Record<string, string> | undefined {
	if (!isObj(v)) return undefined;
	const out: Record<string, string> = {};
	for (const [k, s] of Object.entries(v)) if (typeof s === "string") out[k] = s;
	return out;
}

/** The dialog and page strings: string values only, and in `results` and `keys` too; a bad value takes its default. */
function parseStrings(v: unknown): EmbedConfig["strings"] {
	const top = stringValues(v);
	if (!top) return {};
	const out: Record<string, unknown> = top;
	for (const name of ["results", "keys"] as const) {
		delete out[name];
		const nested = stringValues((v as Obj)[name]);
		if (nested && Object.keys(nested).length) out[name] = nested;
	}
	return out as EmbedConfig["strings"];
}

/** An absolute http(s) URL, or a root-relative path ("/..." but not "//..."), with no whitespace. */
function usableUrl(v: unknown): v is string {
	if (typeof v !== "string" || !v || /\s/.test(v)) return false;
	if (v.startsWith("/")) return !v.startsWith("//") && !v.startsWith("/\\");
	// An http(s) URL that parses has a host.
	return /^https?:\/\//i.test(v) && webUrl(v);
}

/**
 * A non-empty string that is an http(s) URL once resolved against `base` (the document's base URL: the one the link
 * and form resolve against, so "https:?s=" on an https page is kept and "x" under an ftp: <base href> is not): the
 * results URL becomes the "See all" link and the page's form action, and a browse href a link, so a javascript: or
 * data: one never does. The URL parser strips what a browser strips (spaces around it, tabs and newlines inside), so
 * "java\tscript:" is caught too.
 */
function webUrl(v: unknown, base?: string): v is string {
	try {
		return typeof v === "string" && !!v && /^https?:/.test(new URL(v, base).protocol);
	} catch {
		return false;
	}
}

/** A form control name that is safe in an attribute selector: letters, digits, "_", "-" and "[]". */
const NAME = /^(?:[\w-]|\[\])+$/;
const PREFIX = /^[\w-]*$/;

/** Whether `sel` parses as a selector, by a try of matches() on a throwaway element; true with no document to try. */
function validSelector(sel: string, doc: Pick<Document, "createElement"> | undefined): boolean {
	if (!sel.trim()) return false;
	if (!doc) return true;
	try {
		doc.createElement("a").matches(sel);
		return true;
	} catch {
		return false;
	}
}

/**
 * The config from the tag's text, or null when it cannot be used: not JSON, not an object, or no manifest URL.
 * Unknown keys are ignored and each wrong-typed or unsafe value takes its default. The manifest must be an absolute
 * http(s) or a root-relative URL. Never throws. `doc` checks the skip selector (with none, any non-blank selector is
 * kept) and gives the base URL the results and browse URLs resolve against (with none, an http one).
 */
export function parseEmbedConfig(text: string | null | undefined, doc?: Pick<Document, "createElement" | "baseURI" | "URL">): EmbedConfig | null {
	let data: unknown;
	try {
		data = JSON.parse(text ?? "null");
	} catch {
		return null;
	}
	if (!isObj(data) || !usableUrl(data.manifest)) return null;
	const paramPrefix = typeof data.paramPrefix === "string" && PREFIX.test(data.paramPrefix) ? data.paramPrefix : "";
	let queryParam = str(data.queryParam, "q");
	if (queryParam === `${paramPrefix}type` || queryParam === `${paramPrefix}index`) queryParam = "q";
	const t = isObj(data.takeover) ? data.takeover : {};
	const inputName = typeof t.inputName === "string" && NAME.test(t.inputName) ? t.inputName : "q";
	const skip = typeof t.skip === "string" && validSelector(t.skip, doc) ? t.skip : ".no-search-takeover";
	const base = doc?.baseURI ?? "http://h/";
	const standDown = typeof data.standDown === "string" && data.standDown ? data.standDown : null;
	const config: EmbedConfig = {
		manifest: data.manifest,
		index: str(data.index, "default"),
		// The default under a non-http(s) <base href> is the page's own site's /search (when the page is http(s)).
		results: webUrl(data.results, base) ? data.results : webUrl(base) || !webUrl(doc!.URL) ? "/search" : new URL("/search", doc!.URL).href,
		queryParam,
		paramPrefix,
		keys: strings(data.keys),
		strings: parseStrings(data.strings),
		browse: Array.isArray(data.browse)
			? data.browse.filter((b): b is EmbedConfig["browse"][number] => isObj(b) && typeof b.label === "string" && webUrl(b.href, base))
			: [],
		takeover: {
			enabled: t.enabled === true && !standDown,
			inputName,
			skip,
			allowFields: Array.isArray(t.allowFields) ? strings(t.allowFields) : ["lang"],
		},
		standDown,
	};
	if (typeof data.lang === "string" && data.lang) config.lang = data.lang;
	return config;
}

/** The page's config: the first config tag that is not inside a [data-search-page] (a results page's own). */
export function readConfigTag(doc: Document): EmbedConfig | null {
	for (const el of doc.querySelectorAll(CONFIG_TAG)) {
		if (!el.closest("[data-search-page]")) return parseEmbedConfig(el.textContent, doc);
	}
	return null;
}

/** The embed's URL names (the query parameter and the prefix). */
export const urlNames = (config: EmbedConfig): UrlNames => ({ query: config.queryParam, prefix: config.paramPrefix });

/**
 * The embed's "See all results" href: the base (the results URL) with the query, the picked type, the dialog's index
 * (always: the results page's mount may name another index for direct visits) and the picks, in the config's URL
 * names. The base's other parameters and its fragment stay.
 */
export function embedSeeAll(config: EmbedConfig): SeeAll {
	const names = urlNames(config);
	return (base, s, index) => {
		const hashAt = base.indexOf("#");
		const hash = hashAt < 0 ? "" : base.slice(hashAt);
		const rest = hashAt < 0 ? base : base.slice(0, hashAt);
		const searchAt = rest.indexOf("?");
		const path = searchAt < 0 ? rest : rest.slice(0, searchAt);
		const search = writeUrl({ query: s.query, type: s.type, index, picks: s.picks }, searchAt < 0 ? "" : rest.slice(searchAt), [], names);
		return path + search + hash;
	};
}
