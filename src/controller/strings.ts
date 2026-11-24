/** Every label the search shows. US English defaults; a site replaces any of them. */
export interface Strings {
	dialogLabel: string;
	placeholder: string;
	close: string;
	allTypes: string;
	seeAll: string;
	/** The notice in a dialog whose links open in a new tab. */
	newTab: string;
	loading: string;
	unavailable: string;
	retry: string;
	/** `{query}` is replaced by the query. */
	noResults: string;
	searchAllTypes: string;
	recent: string;
	/** The heading over the suggested links in an empty box. */
	suggested: string;
	browse: string;
	facetsLabel: string;
	typesLabel: string;
	other: string;
	/** The live-region count. `{count}` is replaced by the number. */
	results: { zero: string; one: string; other: string };
	keys: { move: string; open: string; close: string };
}

export const defaultStrings: Strings = {
	dialogLabel: "Search",
	placeholder: "Search",
	close: "Close",
	allTypes: "All",
	seeAll: "See all results",
	newTab: "Links open in a new tab",
	loading: "Loading…",
	unavailable: "Search is not available right now.",
	retry: "Try again",
	noResults: "No results for “{query}”",
	searchAllTypes: "Search all types",
	recent: "Recent searches",
	suggested: "Suggested",
	browse: "Browse",
	facetsLabel: "Filters",
	typesLabel: "Content types",
	other: "Other",
	results: { zero: "No results", one: "1 result", other: "{count} results" },
	keys: { move: "to move", open: "to open", close: "to close" },
};

export type StringsInput = Partial<Omit<Strings, "results" | "keys">> & {
	results?: Partial<Strings["results"]>;
	keys?: Partial<Strings["keys"]>;
};

/** The defaults with a site's replacements; `results` and `keys` merge by key. */
export function mergeStrings(input: StringsInput = {}): Strings {
	return {
		...defaultStrings,
		...input,
		results: { ...defaultStrings.results, ...input.results },
		keys: { ...defaultStrings.keys, ...input.keys },
	};
}

/** Replaces `{name}` with `values[name]`. */
export function fill(template: string, values: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(values, k) ? String(values[k]) : m));
}

/** The count sentence: zero, then the plural rule for `locale` ("one" or "other"). */
export function countText(strings: Strings, count: number, locale = "en-US"): string {
	if (count === 0) return fill(strings.results.zero, { count });
	const rule = new Intl.PluralRules(locale).select(count);
	return fill(rule === "one" ? strings.results.one : strings.results.other, { count });
}
