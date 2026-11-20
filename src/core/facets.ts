/**
 * Facet and type counts over unique matched pages, taken before `limit`.
 * Picks are OR inside a facet and AND across facets; each facet's counts ignore its own picks (disjunctive).
 */
import { own } from "./own.ts";
import type { FacetCount, IndexSettings, Query, SearchRecord } from "./types.ts";

/** Pages that pass every pick except those of `skip` ("type" for the tabs). */
export function passes(page: SearchRecord, q: Query, skip: string | null): boolean {
	if (skip !== "type" && q.type && page.type !== q.type) return false;
	for (const [facet, picked] of Object.entries(q.picks ?? {})) {
		if (facet === skip || picked.length === 0) continue;
		const values = own(page.facets, facet) ?? [];
		if (!picked.some((v) => values.includes(v))) return false;
	}
	return true;
}

/** Settings order first, then by count, then by value. Picked values show even at zero. */
function list(tally: Map<string, number>, picked: readonly string[], order: readonly string[], label: (v: string) => string): FacetCount[] {
	for (const v of picked) if (!tally.has(v)) tally.set(v, 0);
	const rank = (v: string) => {
		const i = order.indexOf(v);
		return i < 0 ? order.length : i;
	};
	return [...tally]
		.sort(([a, x], [b, y]) => rank(a) - rank(b) || y - x || (a < b ? -1 : a > b ? 1 : 0))
		.map(([value, count]) => ({ value, label: label(value), count, picked: picked.includes(value) }));
}

/** Per type, for the tabs: ignores the type tab, keeps the facet picks. */
export function countTypes(pages: ReadonlyMap<string, SearchRecord>, q: Query, settings: IndexSettings): FacetCount[] {
	const tally = new Map<string, number>();
	for (const page of pages.values()) if (passes(page, q, "type")) tally.set(page.type, (tally.get(page.type) ?? 0) + 1);
	const types = settings.types ?? {};
	return list(tally, q.type ? [q.type] : [], Object.keys(types), (v) => own(types, v)?.label ?? v);
}

/** Per facet in the settings (and any facet picked): each ignores its own picks. */
export function countFacets(pages: ReadonlyMap<string, SearchRecord>, q: Query, settings: IndexSettings): Record<string, FacetCount[]> {
	const out: [string, FacetCount[]][] = [];
	const names = new Set([...Object.keys(settings.facets ?? {}), ...Object.keys(q.picks ?? {})]);
	for (const facet of names) {
		const tally = new Map<string, number>();
		for (const page of pages.values()) {
			if (!passes(page, q, facet)) continue;
			for (const v of new Set(own(page.facets, facet) ?? [])) tally.set(v, (tally.get(v) ?? 0) + 1);
		}
		const values = own(settings.facets, facet)?.values ?? {};
		out.push([facet, list(tally, own(q.picks, facet) ?? [], Object.keys(values), (v) => own(values, v) ?? v)]);
	}
	// fromEntries: a facet named "__proto__" is an own key.
	return Object.fromEntries(out);
}
