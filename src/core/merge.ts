/**
 * Merging records from every adapter. When a written source (a collection, a hook or EmDash) and the HTML scan give
 * the same page, the written page and its headings replace the scanned page and its headings as a whole: no field is
 * taken from the scanned ones. Two records with the same id that are left after that fail, with both origins named.
 */
import type { SearchRecord, SourcedRecord } from "./types.ts";

/** A page's own id, a heading's page id, or an action's own id. */
const pageKey = (r: SearchRecord) => (r.kind === "heading" && r.pageId ? r.pageId : r.id);

export function mergeRecords(sourced: SourcedRecord[]): SearchRecord[] {
	const written = new Set<string>();
	for (const { record } of sourced) if (record.source !== "html") written.add(pageKey(record));
	const kept = sourced.filter(({ record }) => record.source !== "html" || !written.has(pageKey(record)));

	const seen = new Map<string, string>();
	const clashes: string[] = [];
	for (const { record, origin } of kept) {
		const first = seen.get(record.id);
		if (first !== undefined) clashes.push(`  - ${record.id}: ${first} and ${origin}`);
		else seen.set(record.id, origin);
	}
	if (clashes.length > 0) throw new Error([`Search: ${clashes.length} record id${clashes.length === 1 ? " is" : "s are"} used twice:`, ...clashes.slice(0, 20)].join("\n"));

	return kept.map((s) => s.record).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
