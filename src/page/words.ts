/** The results page's own words, beside the search's strings. Imports types only. */
import type { StringsInput } from "../controller/index.ts";

/** The page's own words; the marks and the Type label default as the dialog's. */
export interface PageWords {
	/** The search box's label (visually hidden; the box shows the placeholder). */
	label: string;
	/** The form's button. */
	submit: string;
	/** The button under the results. */
	showMore: string;
	/** Read after "Show more results": `{position}`, `{total}` and `{title}` of the new first result. */
	moreShown: string;
	/** The mark before a section result's heading (hidden from screen readers). */
	headingMark: string;
	/** The mark between the parts of a result's breadcrumb (hidden from screen readers). */
	crumbMark: string;
	/** The visible label before the type tabs (the tablist keeps its name, the search's `typesLabel`). */
	typeText: string;
}

/** A results page's `strings`: the search's strings and the page's own words. */
export type SearchPageStrings = StringsInput & Partial<PageWords>;

export const defaultPageWords: PageWords = {
	label: "Search",
	submit: "Search",
	showMore: "Show more results",
	moreShown: "Result {position} of {total}: {title}",
	headingMark: "#",
	crumbMark: "›",
	typeText: "Type",
};

/** The page's words: the defaults with `input`'s on top. */
export function pageStrings(input: Partial<PageWords> = {}): PageWords {
	const out = { ...defaultPageWords };
	for (const k of Object.keys(out) as (keyof PageWords)[]) if (typeof input[k] === "string") out[k] = input[k];
	return out;
}
