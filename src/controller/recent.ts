/**
 * Recent searches, kept in a storage the site passes (localStorage in the browser). Every storage call is wrapped:
 * a private window or blocked site data throws, and search must keep working without them.
 */
export type RecentStorage = Pick<Storage, "getItem" | "setItem">;

export function recentKey(index: string): string {
	return `astronomic-search:recent:${index}`;
}

export function readRecent(storage: RecentStorage | null | undefined, index: string, max: number): string[] {
	if (!storage) return [];
	try {
		const raw = storage.getItem(recentKey(index));
		if (!raw) return [];
		const list: unknown = JSON.parse(raw);
		if (!Array.isArray(list)) return [];
		return list.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, max);
	} catch {
		return [];
	}
}

/** The query first, no duplicates, at most `max`. Returns the new list; a failed write keeps it in memory. */
export function addRecent(list: string[], query: string, max: number): string[] {
	const q = query.trim();
	if (!q || max <= 0) return list;
	return [q, ...list.filter((x) => x !== q)].slice(0, max);
}

export function writeRecent(storage: RecentStorage | null | undefined, index: string, list: string[]): void {
	if (!storage) return;
	try {
		storage.setItem(recentKey(index), JSON.stringify(list));
	} catch {
		// Storage is full or blocked: keep the list in memory only.
	}
}
