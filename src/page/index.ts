/**
 * The results page's pure helpers: the URL (with names a host can change), the first pages of a result and the
 * page's words. No listeners and no globals; the modules import only types from the rest of the package.
 */
export { pickToggles, readUrl, writeUrl, type Picks, type UrlNames, type UrlState } from "./url.ts";
export { PAGE_SIZE, slicePages, type Slice } from "./slice.ts";
export { defaultPageWords, pageStrings, type PageWords, type SearchPageStrings } from "./words.ts";
