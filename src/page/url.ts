/**
 * The results page's URL: the query, the type, the index and the filter picks (`?q=dark+mode&type=docs&theme=vega`).
 * A host can rename them: `query` names the query parameter (default "q"), and `prefix` goes before the type, the
 * index and each facet (`z_type`, `z_index`, `z_tag`), so a host page keeps its own query vars (`tag`, `paged`). With
 * the defaults, the URLs are the Astro kit's. No listeners and no globals, so it runs under node --test.
 */

export type Picks = Record<string, string[]>;

/** The URL names; the defaults give the Astro kit's URLs. */
export interface UrlNames {
	/** The query parameter. Default "q". */
	query?: string;
	/** Goes before the type, the index and each facet. Default "". */
	prefix?: string;
	/** Warns (once per name) about a facet left out of the URL because its URL name is reserved. */
	dev?: boolean;
}

export interface UrlState {
	query: string;
	/** The type tab; null for all types. */
	type: string | null;
	/** The index searched; null for the page's default. Read and written only when set. */
	index: string | null;
	/** Facet name (unprefixed) -> the picked values. */
	picks: Picks;
}

const params = (search: string) => new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);

/**
 * A name a set of picks can take from a URL without the index's facet names: not one Object.prototype has
 * (`constructor`, `__proto__`, `toString`), which stays a parameter that is not ours. With the facet names, any name
 * the index declares is a pick, whatever it is called.
 */
const pickable = (name: string) => !(name in Object.prototype);
const own = (picks: Picks, name: string): string[] | undefined => (Object.hasOwn(picks, name) ? picks[name] : undefined);

interface Names {
	query: string;
	prefix: string;
	type: string;
	index: string;
	/**
	 * A facet named "type", "index" or the query's name, or whose URL name is the query's: never a pick in the URL,
	 * with or without a prefix.
	 */
	reserved: (facet: string) => boolean;
}

const warned = new Set<string>();
/** The resolved names; throws when the query's is the type's or the index's. With dev, warns about declared reserved facets. */
function resolve(names: UrlNames = {}, facets?: readonly string[]): Names {
	const query = names.query || "q";
	const prefix = names.prefix ?? "";
	const type = `${prefix}type`;
	const index = `${prefix}index`;
	if (query === type || query === index) throw new Error(`Search: the URL names (query "${query}", type "${type}", index "${index}") must be distinct.`);
	const reserved = (facet: string) => {
		if (facet !== "type" && facet !== "index" && facet !== query && prefix + facet !== query) return false;
		if (names.dev && !warned.has(prefix + facet)) {
			warned.add(prefix + facet);
			console.warn(`Search: the facet "${facet}" has a name the query, the type or the index uses; it is left out of the URL.`);
		}
		return true;
	};
	if (names.dev && facets) for (const f of facets) reserved(f);
	return { query, prefix, type, index, reserved };
}

/**
 * The query, the type, the index and the picks from a URL's search part. A pick is any other parameter that starts
 * with the prefix and whose rest Object.prototype does not have, or, with `facets` (the index's facet names), each one
 * the index declares, even `constructor`. A reserved facet is no pick. A value picked twice counts
 * once; empty values are left out. The picks are a null-prototype object, keyed by the facet name without the prefix.
 */
export function readUrl(search: string, facets?: readonly string[], names?: UrlNames): UrlState {
	const n = resolve(names, facets);
	const p = params(search);
	const picks: Picks = Object.create(null);
	for (const [name, value] of p) {
		if (name === n.query || name === n.type || name === n.index || value === "" || !name.startsWith(n.prefix)) continue;
		const facet = name.slice(n.prefix.length);
		if ((facets ? !facets.includes(facet) : !pickable(facet)) || n.reserved(facet)) continue;
		const list = own(picks, facet) ?? (picks[facet] = []);
		if (!list.includes(value)) list.push(value);
	}
	return { query: p.get(n.query)?.trim() ?? "", type: p.get(n.type) || null, index: p.get(n.index) || null, picks };
}

/**
 * The search part for `state`, "" when it is empty: the query (trimmed), the type, the index, then each pick (a facet
 * with several values repeats its name), then every other parameter of `current` that is not ours, in its order. Ours
 * are the query, the type, the index, `facets` and the facets `state` picks, each by its URL name.
 */
export function writeUrl(state: UrlState, current = "", facets: readonly string[] = [], names?: UrlNames): string {
	const n = resolve(names, facets);
	const out = new URLSearchParams();
	const query = state.query.trim();
	if (query) out.set(n.query, query);
	if (state.type) out.set(n.type, state.type);
	if (state.index) out.set(n.index, state.index);
	for (const [facet, values] of Object.entries(state.picks)) {
		if (n.reserved(facet)) continue;
		for (const v of values) if (v !== "") out.append(n.prefix + facet, v);
	}
	const ours = new Set([n.query, n.type, n.index, ...[...facets, ...Object.keys(state.picks)].map((f) => n.prefix + f)]);
	for (const [name, value] of params(current)) if (!ours.has(name)) out.append(name, value);
	const text = out.toString();
	return text ? `?${text}` : "";
}

/** The [facet, value] toggles that take the picks `from` to `to`: the values to drop, then the values to add. */
export function pickToggles(from: Picks, to: Picks): [string, string][] {
	const out: [string, string][] = [];
	for (const [facet, values] of Object.entries(from)) for (const v of values) if (!own(to, facet)?.includes(v)) out.push([facet, v]);
	for (const [facet, values] of Object.entries(to)) for (const v of values) if (!own(from, facet)?.includes(v)) out.push([facet, v]);
	return out;
}
