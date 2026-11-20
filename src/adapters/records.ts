/**
 * Records a site makes itself (kit parts, actions, a CMS this package does not know). The hook runs in Node once per
 * build, and once per content change in dev.
 */
import type { SearchRecord, SourcedRecord } from "../core/types.ts";
import { checkFacetName } from "./collections.ts";

/** A record as a hook returns it: no `source` (the adapter sets "hook"), and `locale` may be left out. */
export type RecordInput = Omit<SearchRecord, "source" | "locale" | "facets"> & { locale?: string; facets?: Record<string, string[]> };

export interface RecordsOptions {
	/** The types this hook's records use, with their labels. A type not listed here gets its name as its label. */
	types?: Record<string, { label: string; weight?: number }>;
	/** The facets this hook's records use, so an index can group by them. */
	facets?: string[];
}

export interface RecordsSource extends RecordsOptions {
	kind: "records";
	hook: () => RecordInput[] | Promise<RecordInput[]>;
}

export const ORIGIN = "records() hook";

export function records(hook: RecordsSource["hook"], options: RecordsOptions = {}): RecordsSource {
	if (typeof hook !== "function") throw new Error("Search: records() takes a function that returns records");
	for (const facet of options.facets ?? []) checkFacetName("records()", facet);
	return { kind: "records", hook, ...options };
}

/** Calls the hook once and fills `source`, `locale` (the default locale) and empty `facets`. */
export async function runRecords(source: RecordsSource, defaultLocale: string): Promise<SourcedRecord[]> {
	const out = await source.hook();
	if (!Array.isArray(out)) throw new Error(`Search: the ${ORIGIN} must return an array of records, not ${out === null ? "null" : typeof out}`);
	return out.map((r) => ({
		record: { ...r, locale: r?.locale ?? defaultLocale, facets: r?.facets ?? {}, source: "hook" } as SearchRecord,
		origin: ORIGIN,
	}));
}
