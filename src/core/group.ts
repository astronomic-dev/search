/** Grouping of result pages: by type, by a facet's first value, or one mixed group. */
import { own } from "./own.ts";
import type { GroupBy, IndexSettings, ResultGroup, ResultItem } from "./types.ts";

/** The key of the last group when grouping by a facet: pages with no value. Facet values are never empty, and the UI labels it from `strings.other`. */
export const OTHER = "";

export function checkSettings(settings: IndexSettings): void {
	if (Object.hasOwn(settings.facets ?? {}, "type")) throw new Error('search: a facet may not be named "type" (it is the content type)');
}

/** `items` come in score order, so each group's first item is its best. */
export function groupItems(items: readonly ResultItem[], by: GroupBy, settings: IndexSettings): ResultGroup[] {
	if (items.length === 0) return [];
	if (by === false) return [{ key: "", label: "", items: [...items] }];
	const keyOf = by === "type" ? (i: ResultItem) => i.page.type : (i: ResultItem) => own(i.page.facets, by)?.[0] ?? OTHER;
	const labelOf =
		by === "type"
			? (k: string) => own(settings.types, k)?.label ?? k
			: (k: string) => (k === OTHER ? "" : (own(own(settings.facets, by)?.values, k) ?? k));
	const groups = new Map<string, ResultGroup>();
	for (const item of items) {
		const key = keyOf(item);
		let g = groups.get(key);
		if (!g) groups.set(key, (g = { key, label: labelOf(key), items: [] }));
		g.items.push(item);
	}
	// Map order is best first already; an array order pulls its groups to the front.
	const order = Array.isArray(settings.groupOrder) ? settings.groupOrder : [];
	const fixed = order.filter((k) => groups.has(k)).map((k) => groups.get(k)!);
	const rest = [...groups.values()].filter((g) => !order.includes(g.key));
	const out = [...fixed, ...rest];
	if (by !== "type" && groups.has(OTHER) && !order.includes(OTHER)) {
		const other = groups.get(OTHER)!;
		return [...out.filter((g) => g !== other), other];
	}
	return out;
}
