/**
 * `listPages`: pages whose theme route lists whole collections (a talks page, a FAQ). The words of the listed entries
 * go to the end of the page's text, so a search for an item finds the page. One hit per page.
 *
 * - The page is the record of the published entry at the path, per locale; it keeps its id, type and title. Only with
 *   `fallback` is a page made where no entry has the path, in the default locale.
 * - A published `noIndex` entry at the path keeps the page out, fallback or not. An entry of a collection that is not
 *   indexed is not seen. Two entries at the path: a warning, and nothing is added to either.
 * - `exclude` is about result addresses: it leaves the page out, but not an item's words.
 * - Items are indexable entries (published, not `noIndex`) in the page's locale, null as the default, in the order of
 *   `from` and then as the content port lists them (EmDash: newest first). Text past `LIST_PAGE_MAX` is cut.
 *
 * Platform-free: no `emdash`, `node:*`, `react` or `astro` imports.
 */
import { cutAt, squash } from "../../core/text.ts";
import type { PageRecord } from "../../core/types.ts";
import { fieldText } from "./entry-text.ts";
import { canonicalSitePath, indexLocale, isSitePath, localizedPath, neutralPath, startsWithLocale } from "./paths.ts";
import type { CollectionInfo, EmDashEntry, ListPage, UrlRules } from "./ports.ts";

/** The most characters of listed words one page gets. */
export const LIST_PAGE_MAX = 20_000;
/** Between the fields, so a snippet does not run them together. It is no word, so it changes no match. */
const BETWEEN = " · ";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isName = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
const isSource = (v: unknown): boolean =>
	isObject(v) && onlyKeys(v, ["collection", "fields"]) && isName(v.collection) && Array.isArray(v.fields) && v.fields.length > 0 && v.fields.every(isName);
const isFallback = (v: unknown): boolean => isObject(v) && onlyKeys(v, ["title", "text"]) && isName(v.title) && (v.text === undefined || typeof v.text === "string");
/** A site path with no wildcard and no "." or ".." segment, written out or percent-encoded (a browser resolves both). */
const isLiteralPath = (v: unknown): v is string => isSitePath(v) && !(v as string).includes("*") && !/\/(?:\.|%2e){1,2}(?:\/|$)/i.test(v as string);

/** Throws unless `input` is a list of list pages, each path once. */
export function checkListPages(input: unknown): asserts input is ListPage[] {
	const fail = (message: string): never => {
		throw new Error(`Search: search(): ${message}`);
	};
	if (!Array.isArray(input)) return fail(`listPages must be a list of pages ([{ path: "/speaking", from: [{ collection: "talks", fields: ["title"] }] }]), not ${JSON.stringify(input)}`);
	const seen = new Set<string>();
	input.forEach((page: unknown, i) => {
		const at = `listPages[${i}]`;
		if (!isObject(page)) return fail(`${at} must be an object, not ${JSON.stringify(page)}`);
		const unknown = Object.keys(page).find((k) => !["path", "from", "fallback", "type"].includes(k));
		if (unknown !== undefined) return fail(`${at} has an unknown key "${unknown}" (it takes path, from, fallback and type)`);
		if (!isLiteralPath(page.path)) return fail(`${at}.path must be a site path that starts with one "/" and has no "*", "?" or "#" ("/speaking"), not ${JSON.stringify(page.path)}`);
		if (!Array.isArray(page.from) || page.from.length === 0 || !page.from.every(isSource)) {
			return fail(`${at}.from must be a list of { collection, fields } ([{ collection: "talks", fields: ["title"] }]), not ${JSON.stringify(page.from)}`);
		}
		if (page.fallback !== undefined && !isFallback(page.fallback)) return fail(`${at}.fallback must be { title, text? } with a title, not ${JSON.stringify(page.fallback)}`);
		if (page.type !== undefined && !isName(page.type)) return fail(`${at}.type must be a name ("pages"), not ${JSON.stringify(page.type)}`);
		const path = canonicalSitePath(page.path);
		if (seen.has(path)) return fail(`listPages has the path "${page.path}" twice; put all its collections in one from`);
		seen.add(path);
	});
}

export interface ListPagesInput {
	rules: UrlRules | undefined;
	/** EmDash's default locale, as on its entries (an Astro custom path, not its code). */
	defaultLocale: string;
	/** Every collection of the site. */
	all: CollectionInfo[];
	excluded(url: string, locale: string | null): boolean;
	/** Warnings are added here. */
	warnings: string[];
}

export interface ListPages {
	/** The collections to read for words. */
	collections: CollectionInfo[];
	/** One indexable entry of any read collection. */
	item(collection: string, e: EmDashEntry): void;
	/** One published entry of an indexed collection, at its public path. `record` null: `noIndex`. */
	owner(e: EmDashEntry, url: string, record: PageRecord | null): void;
	/** Adds the words to the owners' records. Returns the pages made from a fallback, and the label of their type. */
	finish(): Array<{ record: PageRecord; label: string }>;
}

/** Words of one source in one locale, read up to just past the ceiling. */
interface Words {
	parts: string[];
	length: number;
}

interface Plan {
	page: ListPage;
	path: string;
	/** Per source of `from`, per index locale. */
	words: Array<Map<string, Words>>;
	/** Per index locale: the published entries at the path (null: `noIndex`). */
	owners: Map<string, Array<PageRecord | null>>;
}

/** The list pages of one build. Null: none. */
export function createListPages(pages: ListPage[] | undefined, input: ListPagesInput): ListPages | null {
	if (!pages || pages.length === 0) return null;
	const { rules, all, warnings } = input;
	const defaultKey = indexLocale(input.defaultLocale, rules);
	const keyOf = (locale: string | null) => (locale ? indexLocale(locale, rules) : defaultKey);
	const bySlug = new Map(all.map((c) => [c.slug, c]));
	const warn = (message: string) => {
		const text = `Search: listPages: ${message}`;
		if (!warnings.includes(text)) warnings.push(text);
	};

	const plans = new Map<string, Plan>();
	const readers = new Map<string, Array<{ words: Map<string, Words>; fields: string[] }>>();
	for (const page of pages) {
		const path = canonicalSitePath(page.path);
		if (startsWithLocale(path, rules)) {
			warn(`"${page.path}" starts with a locale's prefix; write the path without it. The page is left out`);
			continue;
		}
		const words = page.from.map(() => new Map<string, Words>());
		plans.set(path, { page, path, words, owners: new Map() });
		page.from.forEach(({ collection, fields }, i) => {
			const info = bySlug.get(collection);
			if (!info) return warn(`there is no collection "${collection}"; its words are left out`);
			for (const f of fields) if (info.fields && !info.fields.includes(f)) warn(`the collection "${collection}" has no field "${f}"; it is left out`);
			readers.set(collection, [...(readers.get(collection) ?? []), { words: words[i], fields }]);
		});
	}

	/** The record's text with the words after it, cut at the ceiling. */
	const withWords = (plan: Plan, text: string, locale: string, url: string): string => {
		const added = plan.words.flatMap((w) => w.get(locale)?.parts ?? []).join(BETWEEN);
		const { end } = cutAt(added, LIST_PAGE_MAX);
		if (end < added.length) warn(`"${url}" lists more than ${LIST_PAGE_MAX.toLocaleString("en-US")} characters; only the first ${LIST_PAGE_MAX.toLocaleString("en-US")} are searched`);
		return squash(`${text} ${added.slice(0, end).replace(/[\s·]+$/, "")}`);
	};

	/** The page its fallback makes in the default locale, if any. */
	const fallbackRecord = (plan: Plan): PageRecord | null => {
		const { fallback, type = "pages" } = plan.page;
		const url = rules ? localizedPath(plan.path, input.defaultLocale, rules) : plan.path;
		if (!fallback || url === null || input.excluded(url, input.defaultLocale)) return null;
		const text = withWords(plan, fallback.text ?? "", defaultKey, url);
		return { id: `${defaultKey}:${url}`, kind: "page", locale: defaultKey, type, url, title: squash(fallback.title), text, facets: {}, source: "emdash" };
	};

	return {
		collections: [...readers.keys()].map((slug) => bySlug.get(slug)!),
		item(collection, e) {
			const locale = keyOf(e.locale);
			for (const { words, fields } of readers.get(collection) ?? []) {
				let w = words.get(locale);
				if (!w) words.set(locale, (w = { parts: [], length: 0 }));
				for (const field of fields) {
					if (w.length > LIST_PAGE_MAX) break;
					const text = fieldText(e.data?.[field]);
					if (text === "") continue;
					w.length += text.length + (w.parts.length > 0 ? BETWEEN.length : 0);
					w.parts.push(text);
				}
			}
		},
		owner(e, url, record) {
			const plan = plans.get(neutralPath(url, e.locale, rules));
			if (!plan) return;
			const locale = keyOf(e.locale);
			plan.owners.set(locale, [...(plan.owners.get(locale) ?? []), record]);
		},
		finish() {
			const made: Array<{ record: PageRecord; label: string }> = [];
			for (const plan of plans.values()) {
				for (const [locale, owners] of plan.owners) {
					if (owners.length > 1) warn(`${owners.length} entries have the path "${owners.find((r) => r)?.url ?? plan.path}"; nothing is added to them`);
					else if (owners[0]) owners[0].text = withWords(plan, owners[0].text, locale, owners[0].url);
				}
				const record = plan.owners.has(defaultKey) ? null : fallbackRecord(plan);
				if (record) made.push({ record, label: bySlug.get(record.type)?.label || record.type.charAt(0).toUpperCase() + record.type.slice(1) });
			}
			return made;
		},
	};
}
