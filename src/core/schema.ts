/**
 * Record checks, run on every record an adapter returns, before merging. A fault names the field and the record's
 * origin, so a build error points at the file that made it.
 */
import type { SourcedRecord } from "./types.ts";
import { cleanUrl, type UrlOptions } from "./url.ts";

const KINDS = new Set(["page", "heading", "action"]);
const SOURCES = new Set(["collection", "html", "hook", "emdash"]);
const MAX_LISTED = 20;
/** Keywords kept per page. More is a sign of a list pasted in by mistake, and it crowds the page's real words. */
export const MAX_KEYWORDS = 20;
/** A BCP 47 tag ("en", "pt-BR", "zh-Hant-TW"). Strict, because the locale is part of an index file's name. */
const LOCALE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

const isString = (v: unknown): v is string => typeof v === "string";

/** Every fault of one record, as "<origin>: <field>: <what is wrong>". Empty when the record is good. */
export function checkRecord(record: unknown, origin: string, urlOptions: UrlOptions): string[] {
	const faults: string[] = [];
	const fault = (field: string, message: string) => faults.push(`${origin}: ${field}: ${message}`);
	if (!record || typeof record !== "object") {
		fault("record", "is not an object");
		return faults;
	}
	const r = record as Record<string, unknown>;

	for (const field of ["id", "locale", "type", "title"] as const) {
		if (!isString(r[field]) || r[field] === "") fault(field, "must be a non-empty string");
	}
	if (isString(r.locale) && r.locale !== "" && !LOCALE.test(r.locale)) fault("locale", `${JSON.stringify(r.locale)} is not a language tag such as "en" or "pt-BR"`);
	if (!isString(r.text)) fault("text", "must be a string");
	if (!KINDS.has(r.kind as string)) fault("kind", `must be "page", "heading" or "action", not ${JSON.stringify(r.kind)}`);
	if (!SOURCES.has(r.source as string)) fault("source", `must be "collection", "html", "hook" or "emdash", not ${JSON.stringify(r.source)}`);
	for (const field of ["heading", "command"] as const) {
		if (r[field] !== undefined && !isString(r[field])) fault(field, "must be a string");
	}

	if (r.kind === "heading" && (!isString(r.pageId) || r.pageId === "")) fault("pageId", "a heading needs its page's id");
	if (r.kind !== "heading" && r.pageId !== undefined) fault("pageId", `only a heading has a pageId (this is a ${String(r.kind)})`);
	if (r.kind === "heading") {
		if (!isString(r.url) || !/#./.test(r.url)) fault("url", "a heading needs a url with its anchor");
		else if (isString(r.locale) && isString(r.pageId)) {
			const want = `${r.locale}:${r.url.replace(/#.*$/, "")}`;
			if (r.pageId !== want) fault("pageId", `${r.pageId} must be the page's id (${want})`);
		}
	}
	if (r.kind === "heading" && (!isString(r.heading) || r.heading === "")) fault("heading", "a heading needs its heading text");
	if (r.kind !== "heading" && r.heading !== undefined) fault("heading", `only a heading has a heading (this is a ${String(r.kind)})`);
	if (r.kind !== "action" && r.command !== undefined) fault("command", `only an action has a command (this is a ${String(r.kind)})`);
	if (r.kind === "page" && !isString(r.url)) fault("url", "a page needs a url");
	if (r.kind === "action" && !isString(r.url) && !isString(r.command)) fault("command", "an action needs a url or a command");

	if (r.url !== undefined) {
		if (!isString(r.url)) fault("url", "must be a string");
		else {
			const clean = cleanUrl(r.url, urlOptions);
			if (clean === null) fault("url", `${r.url} is not on this site`);
			else if (clean !== r.url) fault("url", `${r.url} is not canonical; use ${clean}`);
		}
	}
	if (isString(r.id) && isString(r.locale)) {
		if (isString(r.url)) {
			const want = `${r.locale}:${r.url}`;
			if (r.id !== want) fault("id", `${r.id} must be locale + ":" + url (${want})`);
		} else if (!r.id.startsWith(`${r.locale}:`)) fault("id", `${r.id} must start with the locale and ":"`);
	}

	if (r.keywords !== undefined) {
		if (r.kind !== "page") fault("keywords", `only a page has keywords (this is a ${String(r.kind)})`);
		if (!Array.isArray(r.keywords) || !r.keywords.every(isString)) fault("keywords", "must be an array of strings");
		else if (r.keywords.some((k) => k.trim() === "")) fault("keywords", "a keyword may not be empty");
	}

	if (!r.facets || typeof r.facets !== "object" || Array.isArray(r.facets)) fault("facets", "must be an object of arrays");
	else {
		for (const [name, values] of Object.entries(r.facets)) {
			if (name === "type") fault("facets.type", 'a facet may not be named "type"');
			if (!Array.isArray(values) || !values.every(isString)) fault(`facets.${name}`, "must be an array of strings");
			else if (values.includes("")) fault(`facets.${name}`, 'a value may not be "" (it is the "no value" group)');
		}
	}
	return faults;
}

/** Checks every record and throws one error that lists every fault (the first 20, and how many there are). */
export function checkRecords(sourced: SourcedRecord[], urlOptions: UrlOptions): void {
	const faults = sourced.flatMap((s) => checkRecord(s.record, s.origin, urlOptions));
	if (faults.length === 0) return;
	const listed = faults.slice(0, MAX_LISTED).map((f) => `  - ${f}`);
	const more = faults.length > MAX_LISTED ? [`  …and ${faults.length - MAX_LISTED} more`] : [];
	throw new Error([`Search: ${faults.length} bad record field${faults.length === 1 ? "" : "s"}:`, ...listed, ...more].join("\n"));
}

/** Keeps the first 20 keywords of each page, in place. One warning per page that had more, naming the page and its origin. */
export function capKeywords(sourced: SourcedRecord[]): string[] {
	const warnings: string[] = [];
	for (const s of sourced) {
		const keywords = s.record.keywords;
		if (!keywords || keywords.length <= MAX_KEYWORDS) continue;
		warnings.push(`Search: ${s.origin}: page ${s.record.id} has ${keywords.length} keywords; only the first ${MAX_KEYWORDS} are indexed`);
		s.record = { ...s.record, keywords: keywords.slice(0, MAX_KEYWORDS) };
	}
	return warnings;
}
