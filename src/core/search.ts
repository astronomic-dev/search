/** One search call: engine hits to pages with their headings, picks, counts, a limit and groups. */
import { countFacets, countTypes, passes } from "./facets.ts";
import { checkSettings, groupItems } from "./group.ts";
import { highlight } from "./highlight.ts";
import { own } from "./own.ts";
import { foldText, squash } from "./text.ts";
import type { EngineHit, IndexSettings, Query, ResultHeading, ResultItem, SearchEngine, SearchRecord, SearchResult, Searcher } from "./types.ts";

const HEADINGS_PER_PAGE = 3;
const SNIPPET = 160;

interface PageHits {
	page: SearchRecord;
	/** Query terms matched by any of the page's records. */
	covered: Set<string>;
	own?: EngineHit;
	headings: { record: SearchRecord; hit: EngineHit }[];
	score: number;
}

/** Matched in the heading or the section's text, not only by the page title it carries. */
const ownMatch = (hit: EngineHit) => Object.values(hit.match).some((fields) => fields.includes("heading") || fields.includes("text"));
/** Matched in the heading text itself. */
const headingMatch = (hit: EngineHit) => Object.values(hit.match).some((fields) => fields.includes("heading"));
const inTitle = (hit: EngineHit) => Object.values(hit.match).some((fields) => fields.includes("title"));

export function createSearch(engine: SearchEngine, settings: IndexSettings): Searcher {
	checkSettings(settings);
	const group = settings.group?.dialog ?? "type";
	/** Page URL -> page record, for pinned results; made on the first pinned query. */
	let pages: Map<string, SearchRecord> | null = null;
	const pageAt = (url: string) => (pages ??= new Map(engine.records().filter((r) => r.kind === "page").map((r) => [r.url, r]))).get(url);
	return {
		capabilities: engine.capabilities,
		settings,
		run(query: Query): SearchResult {
			const surface = query.types?.length ? new Set(query.types) : null;
			const required = engine.terms(query.q);
			const all = new Map<string, PageHits>();
			for (const hit of engine.search(query.q)) {
				const record = engine.record(hit.id);
				if (!record || (surface && !surface.has(record.type))) continue;
				const pageId = record.kind === "heading" ? record.pageId : record.id;
				const page = pageId === undefined ? undefined : record.kind === "heading" ? engine.record(pageId) : record;
				if (!page || !pageId) continue;
				let p = all.get(pageId);
				if (!p) all.set(pageId, (p = { page, covered: new Set(), headings: [], score: 0 }));
				for (const t of hit.queryTerms) p.covered.add(t);
				p.score = Math.max(p.score, hit.score);
				if (record.kind === "heading") p.headings.push({ record, hit });
				else p.own = hit;
			}

			// Page-level AND (records are sections), over the pages this surface shows after the picks; OR when none has every
			// term. Decided once for every type tab, so the tab counts and each tab's results agree.
			const every = (p: PageHits) => required.every((t) => p.covered.has(t));
			const strict = [...all.values()].some((p) => every(p) && passes(p.page, query, "type"));
			const byPage = strict ? new Map([...all].filter(([, p]) => every(p))) : all;

			// Pinned pages for the whole query: matched or not, they count once and show first, if they pass the filters.
			const pinned = new Map<string, number>();
			for (const url of own(settings.pinned, squash(foldText(query.q))) ?? []) {
				const page = pageAt(url);
				if (!page || pinned.has(page.id) || (surface && !surface.has(page.type))) continue;
				pinned.set(page.id, pinned.size);
				if (!byPage.has(page.id)) byPage.set(page.id, all.get(page.id) ?? { page, covered: new Set(), headings: [], score: 0 });
			}
			const rank = (p: PageHits) => pinned.get(p.page.id) ?? pinned.size;

			const matched = new Map([...byPage].map(([id, p]) => [id, p.page]));
			const types = countTypes(matched, query, settings);
			const facets = countFacets(matched, query, settings);

			const passing = [...byPage.values()].filter((p) => passes(p.page, query, null));
			passing.sort((x, y) => rank(x) - rank(y) || y.score - x.score || (x.page.id < y.page.id ? -1 : 1));
			const shown = query.limit === undefined ? passing : passing.slice(0, Math.max(0, query.limit));
			const perPage = query.headingsPerPage ?? HEADINGS_PER_PAGE;

			const items: ResultItem[] = shown.map((p) => {
				// The page answers on its own when its own record matches every term and its title: then a heading
				// shows only if its heading text matches, not a weak match somewhere in its section's text.
				const answers = p.own !== undefined && inTitle(p.own) && required.every((t) => p.own!.queryTerms.includes(t));
				const headings: ResultHeading[] = p.headings
					.filter((h) => (answers ? headingMatch(h.hit) : ownMatch(h.hit)))
					.sort((x, y) => y.hit.score - x.hit.score)
					.slice(0, Math.max(0, perPage))
					.map((h) => ({ record: h.record, score: h.hit.score, highlight: highlight(h.record, h.hit.terms, { snippet: SNIPPET }) }));
				// A pinned page the words did not match: mark the query's words where they appear.
				const terms = p.own ? p.own.terms : p.headings.length ? [...new Set(p.headings.flatMap((h) => h.hit.terms))] : required;
				return { page: p.page, score: p.score, highlight: highlight(p.page, terms, { snippet: SNIPPET }), headings };
			});

			return { query, total: passing.length, groups: groupItems(items, query.group ?? group, settings), types, facets };
		},
	};
}
