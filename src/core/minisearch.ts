/**
 * The MiniSearch engine. Form A-clip (Checkpoint M): the file holds the records, with long text clipped,
 * and `load` builds the index in the browser. Form B (a serialized MiniSearch index in `data`) loads too.
 */
import MiniSearch, { type Options, type SearchResult as MiniHit } from "minisearch";
import { checkSettings } from "./group.ts";
import { own } from "./own.ts";
import { clip, foldText } from "./text.ts";
import { SCHEMA } from "./types.ts";
import type { Capabilities, EngineFactory, EngineHit, IndexFile, IndexSettings, SearchEngine, SearchRecord, Weights } from "./types.ts";

export type Form = "A-full" | "A-clip" | "B";

export const DEFAULT_WEIGHTS: Weights = { title: 3, heading: 2, text: 1, keywords: 1 };

/** Characters kept of each record's text in the A-clip form. */
export const CLIP = 1000;

const FIELDS = ["title", "heading", "text", "keywords"];
const CAPABILITIES: Capabilities = { fuzzy: true, prefix: true, facets: true, highlights: true, synonyms: true };
const VERSION = "7.2.0";

/** Short terms are exact; 4 letters allow one edit, 5 and up two. */
const fuzzy = (term: string) => (term.length < 4 ? 0 : term.length < 5 ? 1 : 2);

function options(settings: IndexSettings, typeOf: (id: string) => string | undefined): Options<SearchRecord> {
	const weights = { ...DEFAULT_WEIGHTS, ...settings.weights };
	const types = settings.types ?? {};
	return {
		idField: "id",
		fields: FIELDS,
		extractField: (doc, field) => (field === "keywords" ? [...(doc.keywords ?? []), ...Object.values(doc.facets ?? {}).flat()].join(" ") : (doc as unknown as Record<string, string>)[field]),
		processTerm: (term) => foldText(term),
		searchOptions: {
			boost: { title: weights.title, heading: weights.heading, text: weights.text, keywords: weights.keywords },
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
const tokenize = MiniSearch.getDefault("tokenize") as (text: string) => string[];
const termsOf = (q: string) => [...new Set(tokenize(q).map(foldText).filter(Boolean))];

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

export function createMinisearchEngine(form: Form = "A-clip"): EngineFactory {
	return {
		name: "minisearch",
		version: VERSION,
		capabilities: CAPABILITIES,
		build(index: string, locale: string, input: SearchRecord[], settings: IndexSettings): IndexFile {
			checkSettings(settings);
			const sorted = [...input].sort(byId);
			const records = form === "A-full" ? sorted : sorted.map((r) => (r.text.length > CLIP ? { ...r, text: clip(r.text, CLIP) } : r));
			const file: IndexFile = { schema: SCHEMA, engine: "minisearch", engineVersion: VERSION, index, locale, settings, records };
			if (form === "B") {
				const types = new Map(sorted.map((r) => [r.id, r.type]));
				const ms = new MiniSearch(options(settings, (id) => types.get(id)));
				ms.addAll(sorted);
				file.data = JSON.stringify(ms);
			}
			return file;
		},
		load(file: IndexFile): SearchEngine {
			const records = new Map(file.records.map((r) => [r.id, r]));
			const opts = options(file.settings, (id) => records.get(id)?.type);
			let ms: MiniSearch<SearchRecord>;
			if (typeof file.data === "string") ms = MiniSearch.loadJSON(file.data, opts);
			else {
				ms = new MiniSearch(opts);
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

export const minisearchEngine: EngineFactory = createMinisearchEngine("A-clip");
