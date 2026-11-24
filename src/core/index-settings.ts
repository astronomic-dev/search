/**
 * The engine settings of one index, and the index-level checks that need no file system or Astro. Shared by the Astro
 * build (`src/astro/build.ts` re-exports these) and the EmDash core, so both give the engine the same settings.
 */
import { own } from "./own.ts";
import type { GroupBy, IndexSettings, SearchRecord, Weights } from "./types.ts";

/** The smallest `clip`: shorter text gives snippets with little to show. */
export const MIN_CLIP = 200;

/** The size warning of an index with no `budget`: past it, set `clip` or a budget of your own. */
export const DEFAULT_BUDGET_KB = 300;

/** The parts of a checked index that its engine settings come from. */
export interface IndexShape {
	weights: Weights;
	group: { dialog: GroupBy; page: GroupBy };
	groupOrder: "best" | string[];
	clip?: number;
	/** The declared types, with the label and weight overrides applied. */
	types: Record<string, { label: string; weight?: number }>;
	typeOverrides: Record<string, { label?: string; weight?: number }>;
	facets: Record<string, { label: string; values?: Record<string, string> }>;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function checkClip(where: string, input: unknown): number {
	if (!Number.isInteger(input) || (input as number) < MIN_CLIP) throw new Error(`Search: ${where}: clip must be a whole number of characters, at least ${MIN_CLIP}, not ${JSON.stringify(input)}`);
	return input as number;
}

/** A type's label and weight, with the owner's override applied. */
export function applyType(t: { label: string; weight?: number }, o: { label?: string; weight?: number } | undefined) {
	const weight = o?.weight ?? t.weight;
	return { label: o?.label ?? t.label, ...(weight !== undefined ? { weight } : {}) };
}

/** The engine settings of one index. Types: the declared ones, plus any type a record has (its name, capitalized). */
export function indexSettings(index: IndexShape, records: readonly SearchRecord[]): IndexSettings {
	// A Map: a record type named "constructor" or "__proto__" is a type like any other.
	const types = new Map(Object.entries(index.types));
	for (const r of records) if (!types.has(r.type)) types.set(r.type, applyType({ label: capitalize(r.type) }, own(index.typeOverrides, r.type)));
	const sorted = Object.fromEntries([...types.keys()].sort().map((t) => [t, types.get(t) as { label: string; weight?: number }]));
	return { weights: index.weights, group: index.group, groupOrder: index.groupOrder, types: sorted, facets: index.facets, ...(index.clip !== undefined ? { clip: index.clip } : {}) };
}
