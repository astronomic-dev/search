/**
 * The results page's history rules, with no DOM: the page tells the model what happened (a change, a submit, Back or
 * Forward) and gets back the history writes to make, in order. Each change replaces the entry and a submit adds one,
 * so Back returns to the last submitted search.
 *
 * Pretty URLs: a server may print its query in the path (`/search/foo/`) and pass it as `serverQuery`. It fills the box
 * only on the page's original entry (marked `pretty` in history.state), and only while that entry's URL has no query
 * parameter; the URL leaves the query out while the box still holds the server's query. Once the visitor clears the
 * box, or on any later entry, a URL with no query parameter is an empty query.
 */
import { readUrl, writeUrl, type Picks, type UrlNames } from "./url.ts";

/** The part of the search state that goes in the URL. */
export interface HistoryState {
	query: string;
	type: string | null;
	picks: Picks;
}

/** One history write: `replace` the current entry or `push` a new one, with its search part and its pretty marker. */
export interface HistoryStep {
	op: "replace" | "push";
	search: string;
	pretty: boolean;
}

export interface HistoryOptions {
	/** The URL's search part when the page mounts. */
	search: string;
	/** The entry's marker in history.state: undefined when no mount has marked it yet. */
	mark: unknown;
	/** The server's query for a pretty URL. */
	serverQuery?: string | null;
	names?: UrlNames;
	/** The index named in the URL, kept in every URL the page writes. */
	index?: string | null;
	/** The loaded index's facet names (none until it loads). */
	facets?: () => readonly string[];
}

export interface History {
	/** True while the current entry takes the server's query. */
	readonly pretty: boolean;
	/** The box's query for the current entry. */
	query(): string;
	/** The URL's picks, read with the loaded facet names, once: later loads (a Retry) keep the visitor's picks. */
	firstPicks(facets: readonly string[]): Picks | null;
	/** Marks the original entry on the first mount. */
	start(): HistoryStep[];
	/**
	 * The search changed: replace the entry when its URL or marker differs. `live` is the URL's search part now (a host
	 * script may have changed its own parameters since); the page's writes keep what is not ours from it.
	 */
	changed(s: HistoryState, live?: string): HistoryStep[];
	/** The visitor submitted: put the last committed URL back on the entry, then push the new one. */
	submitted(s: HistoryState, live?: string): HistoryStep[];
	/** Back or Forward landed on `search` with this marker. */
	popped(search: string, mark: unknown): void;
	/** The page wrote `search` in its own spelling (`%20` becomes `+`): that is what a submit compares with. */
	rebase(search: string): void;
}

/**
 * The history decision. A change replaces the entry when the URL differs from the current one. A submit adds an entry
 * when the URL differs from the last committed one.
 */
export function historyStep(kind: "change" | "submit", next: string, current: string, committed: string): "replace" | "push" | null {
	if (kind === "change") return next === current ? null : "replace";
	return next === committed ? null : "push";
}

const hasParam = (search: string, name: string) => new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).has(name);

/** The box's query for a URL: its query parameter if it has one, else the server's query on the original entry, else "". */
export function pageQuery(search: string, serverQuery: string | null | undefined, original: boolean, names?: UrlNames): string {
	if (hasParam(search, names?.query || "q")) return readUrl(search, [], names).query;
	return original ? (serverQuery ?? "").trim() : "";
}

/** The page's original entry takes the server's query only when the server gave one and the URL has no query parameter. */
export function isPrettyEntry(search: string, serverQuery: string | null | undefined, names?: UrlNames): boolean {
	return !!serverQuery?.trim() && !hasParam(search, names?.query || "q");
}

/** The first picks, read with the loaded index's facet names: a declared facet is a pick whatever its name; any other is not. */
export function startPicks(search: string, facets: readonly string[], names?: UrlNames): Picks {
	return readUrl(search, facets, names).picks;
}

export function createHistory(o: HistoryOptions): History {
	const server = (o.serverQuery ?? "").trim();
	const facets = o.facets ?? (() => []);
	const startSearch = o.search;
	const marked = o.mark !== undefined;
	/** The current entry, and the last one a submit, the load or Back committed. */
	let current = { search: o.search, pretty: marked ? o.mark === true : isPrettyEntry(o.search, o.serverQuery, o.names) };
	let committed = { ...current };
	let picksRead = false;

	/** The URL for a state; on a pretty entry the server's query stays out of it (the path says it). */
	const urlFor = (s: HistoryState, pretty: boolean, base: string) => {
		const query = pretty && s.query.trim() === server ? "" : s.query;
		return writeUrl({ query, type: s.type, index: o.index ?? null, picks: s.picks }, base, facets(), o.names);
	};
	/** A URL's own parameters only (the query, the type, the index and the picks): a host's parameters are no search. */
	const own = (search: string) => writeUrl(readUrl(search, facets(), o.names), "", facets(), o.names);
	/** A URL's own parameters with the host's parameters from `live`. */
	const withHost = (search: string, live: string) => writeUrl(readUrl(search, facets(), o.names), live, facets(), o.names);

	return {
		get pretty() {
			return current.pretty;
		},
		query: () => pageQuery(current.search, o.serverQuery, current.pretty, o.names),
		firstPicks(names) {
			if (picksRead) return null;
			picksRead = true;
			return startPicks(startSearch, names, o.names);
		},
		start: () => (marked ? [] : [{ op: "replace", ...current }]),
		changed(s, live = current.search) {
			current = { ...current, search: live };
			// Clearing the box ends the server's query on this entry.
			const ended = current.pretty && !s.query.trim();
			if (ended) committed.pretty = false;
			const next = { search: urlFor(s, current.pretty && !ended, live), pretty: current.pretty && !ended };
			if (!ended && historyStep("change", next.search, current.search, committed.search) === null) return [];
			current = next;
			return [{ op: "replace", ...next }];
		},
		submitted(s, live = current.search) {
			current = { ...current, search: live };
			const before = own(committed.search);
			if (urlFor(s, committed.pretty, "") === before) return [];
			const next = urlFor(s, false, live);
			if (historyStep("submit", own(next), live, before) !== "push") return [];
			const back = { ...committed, search: withHost(committed.search, live) };
			current = { search: next, pretty: false };
			committed = { ...current };
			return [
				{ op: "replace", ...back },
				{ op: "push", ...current },
			];
		},
		popped(search, mark) {
			current = { search, pretty: mark === true };
			committed = { ...current };
		},
		rebase(search) {
			current = { ...current, search };
			committed = { ...current };
		},
	};
}
