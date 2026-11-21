/**
 * The MiniSearch engine. Form A: the file holds the records, and `load` builds the index in the browser. Form B: a
 * serialized MiniSearch index in `data` too. A record's text is kept whole unless the index setting `clip` cuts it.
 */
import MiniSearch, { type Options, type SearchResult as MiniHit } from "minisearch";
import { checkSettings } from "./group.ts";
import { own } from "./own.ts";
import { cutAt, foldText, squash } from "./text.ts";
import { SCHEMA } from "./types.ts";
import type { Capabilities, EngineFactory, EngineHit, IndexFile, IndexSettings, SearchEngine, SearchRecord, Weights } from "./types.ts";

export type Form = "A" | "B";

export const DEFAULT_WEIGHTS: Weights = { title: 3, heading: 2, text: 1, keywords: 1 };

/**
 * Characters of a section's text that rank at the text weight. The words after them are found too (field `more`),
 * at a tenth of it: a long page's tail must not outrank a section that is about those words.
 */
export const HEAD = 1000;

/** With `clip`: for each cut record, the words past the cut that the kept text does not have, once each. */
interface ClipData {
	more: Record<string, string>;
}

/** What `text` and `more` index for one record. */
interface Indexed {
	text: string;
	more: string;
}

const FIELDS = ["title", "heading", "text", "keywords", "more"];
const CAPABILITIES: Capabilities = { fuzzy: true, prefix: true, facets: true, highlights: true, synonyms: true };
const VERSION = "7.2.0";

/** Short terms are exact; 4 letters allow one edit, 5 and up two. */
const fuzzy = (term: string) => (term.length < 4 ? 0 : term.length < 5 ? 1 : 2);

const tokenize = MiniSearch.getDefault("tokenize") as (text: string) => string[];
const termsOf = (q: string) => [...new Set(tokenize(q).map(foldText).filter(Boolean))];

/** The folded words of `rest` that are not in `seen`, once each, in first-seen order. */
function newWords(seen: Set<string>, rest: string): string[] {
	const out: string[] = [];
	for (const t of termsOf(rest)) {
		if (seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}
	return out;
}

/** The first HEAD characters rank as text; the other words of the text, and `extra` (cut words), as `more`. */
function indexed(text: string, extra = ""): Indexed {
	const clean = squash(text);
	const { end, rest } = cutAt(clean, HEAD);
	if (rest >= clean.length && !extra) return { text: clean, more: "" };
	const head = clean.slice(0, end);
	const seen = new Set(termsOf(head));
	return { text: head, more: [...newWords(seen, clean.slice(rest)), ...newWords(seen, extra)].join(" ") };
}

function options(settings: IndexSettings, typeOf: (id: string) => string | undefined, fields: (id: string) => Indexed | undefined): Options<SearchRecord> {
	const weights = { ...DEFAULT_WEIGHTS, ...settings.weights };
	const types = settings.types ?? {};
	return {
		idField: "id",
		fields: FIELDS,
		extractField: (doc, field) => {
			if (field === "keywords") return [...(doc.keywords ?? []), ...Object.values(doc.facets ?? {}).flat()].join(" ");
			if (field === "text" || field === "more") return fields(doc.id)?.[field] ?? "";
			return (doc as unknown as Record<string, string>)[field];
		},
		processTerm: (term) => foldText(term),
		searchOptions: {
			boost: { title: weights.title, heading: weights.heading, text: weights.text, keywords: weights.keywords, more: weights.text * 0.1 },
			prefix: (term) => term.length > 2,
			fuzzy,
			weights: { fuzzy: 0.3, prefix: 0.6 },
			combineWith: "AND",
			boostDocument: (id) => {
				const type = typeOf(id);
				return (type === undefined ? undefined : own(types, type)?.weight) ?? 1;
			},
		},
	};
}

const byId = (a: SearchRecord, b: SearchRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const toHit = (h: MiniHit, back?: Map<string, string[]>): EngineHit => ({
	id: h.id,
	score: h.score,
	// Marks only for real matches: an indexed term the searched word equals or starts, not a fuzzy near-miss
	// ("code" finds "come", but does not mark it). The searched words include synonyms, so a synonym's word is marked.
	terms: h.terms.filter((t) => h.queryTerms.some((q) => t.startsWith(q))),
	match: h.match,
	// A synonym's match counts for the query word that brought it in.
	queryTerms: [...new Set(back ? h.queryTerms.flatMap((t) => back.get(t) ?? [t]) : h.queryTerms)],
});
/** Word -> the other words of its groups. */
function synonymMap(groups: readonly (readonly string[])[] | undefined): Map<string, string[]> {
	const map = new Map<string, Set<string>>();
	for (const group of groups ?? []) {
		for (const word of group) {
			const set = map.get(word) ?? new Set<string>();
			for (const other of group) if (other !== word) set.add(other);
			map.set(word, set);
		}
	}
	return new Map([...map].map(([w, set]) => [w, [...set]]));
}

export function createMinisearchEngine(form: Form = "A"): EngineFactory {
	return {
		name: "minisearch",
		version: VERSION,
		capabilities: CAPABILITIES,
		build(index: string, locale: string, input: SearchRecord[], settings: IndexSettings): IndexFile {
			checkSettings(settings);
			const sorted = [...input].sort(byId);
			const max = settings.clip;
			const more: Record<string, string> = {};
			const records = sorted.map((r) => {
				if (max === undefined) return r;
				const clean = squash(r.text);
				const { end, rest } = cutAt(clean, max);
				if (end >= clean.length) return r;
				const text = `${clean.slice(0, end)}…`;
				const words = newWords(new Set(termsOf(text)), clean.slice(rest)).join(" ");
				if (words) more[r.id] = words;
				return { ...r, text };
			});
			const file: IndexFile = { schema: SCHEMA, engine: "minisearch", engineVersion: VERSION, index, locale, settings, records };
			if (form === "B") {
				// Built from the whole text: the same index as form A builds in the browser.
				const types = new Map(sorted.map((r) => [r.id, r.type]));
				const full = new Map(sorted.map((r) => [r.id, indexed(r.text)]));
				const ms = new MiniSearch(options(settings, (id) => types.get(id), (id) => full.get(id)));
				ms.addAll(sorted);
				file.data = JSON.stringify(ms);
			} else if (Object.keys(more).length) file.data = { more } satisfies ClipData;
			return file;
		},
		load(file: IndexFile): SearchEngine {
			const records = new Map(file.records.map((r) => [r.id, r]));
			let ms: MiniSearch<SearchRecord>;
			if (typeof file.data === "string") ms = MiniSearch.loadJSON(file.data, options(file.settings, (id) => records.get(id)?.type, () => undefined));
			else {
				const cut = file.data && typeof file.data === "object" ? ((file.data as Partial<ClipData>).more ?? {}) : {};
				const fields = new Map(file.records.map((r) => [r.id, indexed(r.text, own(cut, r.id))]));
				ms = new MiniSearch(options(file.settings, (id) => records.get(id)?.type, (id) => fields.get(id)));
				ms.addAll(file.records);
			}
			const list = Object.freeze([...file.records]);
			const synonyms = synonymMap(file.settings.synonyms);
			return {
				name: "minisearch",
				capabilities: CAPABILITIES,
				search(q: string): EngineHit[] {
					if (!q.trim()) return [];
					if (!synonyms.size) return ms.search(q, { combineWith: "OR" }).map((h) => toHit(h));
					// Each query word, plus the rest of its synonym groups; `back` maps every searched word to the query words it stands for.
					const back = new Map<string, string[]>();
					const add = (word: string, from: string) => back.set(word, [...(back.get(word) ?? []), from]);
					for (const t of termsOf(q)) {
						add(t, t);
						for (const other of synonyms.get(t) ?? []) add(other, t);
					}
					return ms.search([...back.keys()].join(" "), { combineWith: "OR" }).map((h) => toHit(h, back));
				},
				terms: termsOf,
				record: (id) => records.get(id),
				records: () => list,
			};
		},
	};
}

export const minisearchEngine: EngineFactory = createMinisearchEngine("A");
