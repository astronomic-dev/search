/** The first pages of a result, for "Show more results". Imports types only. */
import type { Option } from "../controller/index.ts";
import type { ResultGroup, SearchResult } from "../core/index.ts";

/** Results shown at first, and added by each "Show more results". */
export const PAGE_SIZE = 20;

export interface Slice {
	/** The groups with their first pages, in order; a group with none shown is left out. */
	groups: ResultGroup[];
	/** Pages shown. */
	shown: number;
	/** More pages to show. */
	more: boolean;
	/** What is shown, flat in screen order: each page, then its headings. Its index + 1 is a result's position. */
	options: Option[];
}

/** The first `count` pages of a result, across its groups in order. */
export function slicePages(result: Pick<SearchResult, "groups" | "total"> | null, count: number): Slice {
	const groups: ResultGroup[] = [];
	const options: Option[] = [];
	let shown = 0;
	let all = 0;
	for (const g of result?.groups ?? []) {
		all += g.items.length;
		const items = g.items.slice(0, Math.max(0, count - shown));
		if (!items.length) continue;
		shown += items.length;
		groups.push({ ...g, items });
		for (const item of items) {
			for (const r of [item.page, ...item.headings.map((h) => h.record)]) {
				const o: Option = { id: r.id, kind: r.kind, type: r.type };
				if (r.url !== undefined) o.url = r.url;
				options.push(o);
			}
		}
	}
	return { groups, shown, more: shown < all, options };
}
