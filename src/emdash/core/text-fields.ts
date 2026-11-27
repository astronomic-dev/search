/**
 * `textFields`: more fields of an entry to search, per collection (a project's case study, an area's intro). Their
 * words follow the entry's lead text, before `content`, each field set off by " · ".
 *
 * - A name is a field slug, or a prefix with a "*" at the end ("case_*"): every field whose slug starts with it, in
 *   the collection's field order. With no field list (a content port that gives none), the entry's own fields, in
 *   their stored order.
 * - An entry can be `{ field, keys }` for a field of structured blocks: only the words under those block keys count
 *   (`{ field: "case_blocks", keys: ["heading", "text"] }`), so layout values stay out. It also sets the keys of that
 *   field when a prefix takes it.
 * - Fields the record reads already are left out of a prefix: `title`, `content` and `search_keywords`. Named on
 *   their own, they are left out with a warning. The lead field (`excerpt`, `summary`, ...) is left out when it gave
 *   the lead.
 * - A field the collection does not have, a prefix no field has, and a collection that is not indexed are warnings.
 * - Text past `TEXT_FIELDS_MAX` per entry is cut, with a warning. `clip` and the index budget still apply.
 * - No query: the fields are on the listed rows.
 *
 * Platform-free: no `emdash`, `node:*`, `react` or `astro` imports.
 */
import { cutAt } from "../../core/text.ts";
import { fieldWords } from "./entry-text.ts";
import type { CollectionInfo, EmDashEntry, TextField } from "./ports.ts";

/** The most characters of `textFields` words one entry gets. */
export const TEXT_FIELDS_MAX = 20_000;
/** Between the fields, so a snippet does not run them together. It is no word, so it changes no match. */
const BETWEEN = " · ";
/** Fields the record reads on its own. */
const READ_ALREADY = new Set(["title", "content", "search_keywords", "searchKeywords"]);
const FIELD = /^[A-Za-z0-9_-]+\*?$/;
const SLUG = /^[A-Za-z0-9_-]+$/;
const KEY = /^[A-Za-z0-9_-]+$/;
const EXAMPLE = '{ projects: ["problem", "case_*"], areas: ["intro"] }';

/** Throws unless `input` is an object of collection slugs, each with a list of field names, prefixes or `{ field, keys }`. */
export function checkTextFields(input: unknown): asserts input is Record<string, TextField[]> {
	const fail = (message: string): never => {
		throw new Error(`Search: search(): ${message}`);
	};
	if (typeof input !== "object" || input === null || Array.isArray(input)) return fail(`textFields must be an object of collections and their fields (${EXAMPLE}), not ${JSON.stringify(input)}`);
	for (const [collection, fields] of Object.entries(input)) {
		if (collection.trim() === "") return fail(`textFields has an empty collection name`);
		if (!Array.isArray(fields) || fields.length === 0) return fail(`textFields.${collection} must be a list of field names (["intro"]), not ${JSON.stringify(fields)}`);
		for (const f of fields) {
			if (typeof f === "string" && FIELD.test(f)) continue;
			if (f && typeof f === "object" && !Array.isArray(f)) {
				const { field, keys, ...rest } = f as { field?: unknown; keys?: unknown };
				if (
					Object.keys(rest).length === 0 &&
					typeof field === "string" &&
					SLUG.test(field) &&
					Array.isArray(keys) &&
					keys.length > 0 &&
					keys.every((k) => typeof k === "string" && KEY.test(k))
				)
					continue;
			}
			return fail(
				`textFields.${collection} has ${JSON.stringify(f)}; a field is a slug ("intro"), a prefix with a "*" at the end ("case_*") or { field, keys } for blocks ({ field: "case_blocks", keys: ["heading", "text"] })`,
			);
		}
	}
}

/** Per entry, the words of its `textFields` (""). */
export type TextFieldsReader = (collection: string, e: EmDashEntry, lead: unknown) => string;

/**
 * The `textFields` step of one build, for the indexed `collections`. Null: the option is not used. Warnings are added
 * to `warnings`, each once.
 */
export function textFieldsReader(option: Record<string, TextField[]> | undefined, collections: readonly CollectionInfo[], all: readonly CollectionInfo[], warnings: string[]): TextFieldsReader | null {
	if (!option || Object.keys(option).length === 0) return null;
	const warn = (message: string) => {
		const text = `Search: textFields: ${message}`;
		if (!warnings.includes(text)) warnings.push(text);
	};
	const indexed = new Set(collections.map((c) => c.slug));
	/** Per collection: its field names, or a function of the entry's data where the fields are not known. */
	const plans = new Map<string, (data: Record<string, unknown>) => string[]>();
	/** Per collection: the block keys of a field named with `{ field, keys }`. */
	const keysOf = new Map<string, Map<string, string[]>>();
	for (const [slug, entries] of Object.entries(option)) {
		const info = all.find((c) => c.slug === slug);
		if (!info) {
			warn(`there is no collection "${slug}"; its fields are left out`);
			continue;
		}
		if (!indexed.has(slug)) {
			warn(`the collection "${slug}" is not searched; its fields are left out`);
			continue;
		}
		const fixed: string[] = [];
		const prefixes: string[] = [];
		const keyed = new Map<string, string[]>();
		const names: string[] = [];
		for (const e of entries) {
			if (typeof e === "string") names.push(e);
			else {
				keyed.set(e.field, [...e.keys]);
				names.push(e.field);
			}
		}
		keysOf.set(slug, keyed);
		for (const name of new Set(names)) {
			if (name.endsWith("*")) {
				const prefix = name.slice(0, -1);
				if (!info.fields) prefixes.push(prefix);
				else {
					const found = info.fields.filter((f) => f.startsWith(prefix) && !READ_ALREADY.has(f));
					if (found.length === 0) warn(`the collection "${slug}" has no field that starts with "${prefix}"; "${name}" adds nothing`);
					fixed.push(...found);
				}
			} else if (READ_ALREADY.has(name)) warn(`"${slug}" field "${name}" is searched already; it is left out of textFields`);
			else if (info.fields && !info.fields.includes(name)) warn(`the collection "${slug}" has no field "${name}"; it is left out`);
			else fixed.push(name);
		}
		const unique = [...new Set(fixed)];
		plans.set(
			slug,
			prefixes.length === 0
				? () => unique
				: (data) => [...new Set([...unique, ...Object.keys(data).filter((k) => prefixes.some((p) => k.startsWith(p)) && !READ_ALREADY.has(k))])],
		);
	}
	if (plans.size === 0) return null;
	return (collection, e, lead) => {
		const plan = plans.get(collection);
		if (!plan) return "";
		const keyed = keysOf.get(collection);
		const data = e.data ?? {};
		const parts: string[] = [];
		for (const field of plan(data)) {
			const value = data[field];
			if (value === lead) continue;
			const text = fieldWords(value, keyed?.get(field));
			if (text) parts.push(text);
		}
		const words = parts.join(BETWEEN);
		const { end } = cutAt(words, TEXT_FIELDS_MAX);
		if (end >= words.length) return words;
		warn(`an entry of "${collection}" has more than ${TEXT_FIELDS_MAX.toLocaleString("en-US")} characters in its fields; only the first ${TEXT_FIELDS_MAX.toLocaleString("en-US")} are searched`);
		return words.slice(0, end);
	};
}
