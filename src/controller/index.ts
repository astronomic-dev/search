/**
 * The search controller: a framework-free, DOM-free state machine for one search surface (a dialog or a page).
 * It holds the query, loading, results, the flat option list, the active option, type tab, facet picks and recent
 * searches, and runs a `Searcher` it loads once. Commands change state; each command notifies subscribers once.
 *
 * It imports only types from core, so it runs under node --test with a stub Searcher, and the dom layer and every
 * kit recipe share it.
 */
import type { Capabilities, RecordKind, SearchResult, Searcher, SuggestedLink } from "../core/types.ts";
import { addRecent, readRecent, writeRecent, type RecentStorage } from "./recent.ts";
import { countText, mergeStrings, type Strings, type StringsInput } from "./strings.ts";

export { defaultStrings, mergeStrings, countText, fill, type Strings, type StringsInput } from "./strings.ts";
export { loadSearcher, pickLocale, type LoadOptions } from "./load.ts";
export { recentKey, type RecentStorage } from "./recent.ts";

export interface ControllerOptions {
	index: string;
	/** The types this surface shows. */
	types?: string[];
	surface: "dialog" | "page";
	/** Loads the Searcher once; the browser default is load.ts's loadSearcher. */
	load: () => Promise<Searcher>;
	/** For recent searches; null turns them off. Every call is wrapped in try/catch. */
	storage?: RecentStorage | null;
	/** Default 5. */
	recentMax?: number;
	/** Pages per search. Default 20 in a dialog, none on a page. */
	limit?: number;
	strings?: StringsInput;
	/** Dev mode: warn in the console when a command needs a capability the engine lacks. */
	dev?: boolean;
}

export interface Option {
	/** The record id; "suggested:<n>" for a suggested link. */
	id: string;
	url?: string;
	command?: string;
	/** "suggested": a suggested link from the index settings, shown in an empty box. */
	kind: RecordKind | "suggested";
	/** The record's content type (a suggested link's, if it names one). */
	type?: string;
	/** A suggested link's label. */
	label?: string;
}

export interface State {
	open: boolean;
	status: "idle" | "loading" | "ready" | "error";
	query: string;
	composing: boolean;
	type: string | null;
	picks: Record<string, string[]>;
	result: SearchResult | null;
	/** The flat list of options in screen order: each page, then its headings. In an empty dialog box: the suggested links. */
	options: Option[];
	/** -1: none. */
	active: number;
	recent: string[];
	/** The count sentence for the live region (the dom layer delays it). */
	announce: string;
	capabilities: Capabilities | null;
	/** The loaded index file's locale; null until it is loaded. */
	locale: string | null;
}

/**
 * A starting search for open(): the query, the type tab (null or left out: all types) and the facet picks (left out:
 * none). It replaces the box's query, type and picks, so the surface opens as if the visitor had typed it.
 */
export interface Start {
	query?: string;
	type?: string | null;
	picks?: Record<string, string[]>;
}

export interface Controller {
	/** The index this surface searches. */
	readonly index: string;
	readonly strings: Strings;
	getState(): State;
	subscribe(fn: (s: State) => void): () => void;
	/** Starts the load if needed. Resolves when ready; rejects when the load fails (status is then "error"). */
	preload(): Promise<void>;
	/** Opens; with `start`, opens on that search (see Start). */
	open(start?: Start): void;
	close(): void;
	toggle(): void;
	input(q: string): void;
	compositionStart(): void;
	compositionEnd(q: string): void;
	setType(type: string | null): void;
	togglePick(facet: string, value: string): void;
	move(step: 1 | -1): void;
	moveTo(where: "first" | "last" | number): void;
	/** Saves the query to recent searches; returns the active option or null. */
	activate(): Option | null;
	/** "cleared" when the box had text, else "closed". */
	escape(): "cleared" | "closed";
	searchAllTypes(): void;
	retry(): void;
}

/** The index's suggested links as options. */
function suggestedOf(links: readonly SuggestedLink[] | undefined): Option[] {
	return (links ?? []).map((l, i) => {
		const o: Option = { id: `suggested:${i}`, kind: "suggested", url: l.href, label: l.label };
		if (l.type !== undefined) o.type = l.type;
		return o;
	});
}

/** A start's picks: each value once, no empty values or empty lists. Built from entries, so "__proto__" stays an own key. */
function picksOf(input: Record<string, string[]> | undefined): Record<string, string[]> {
	const entries: [string, string[]][] = [];
	for (const [facet, values] of Object.entries(input ?? {})) {
		if (!Array.isArray(values)) continue;
		const list = [...new Set(values.filter((v) => typeof v === "string" && v !== ""))];
		if (list.length) entries.push([facet, list]);
	}
	return Object.fromEntries(entries);
}

function optionsOf(result: SearchResult | null): Option[] {
	const out: Option[] = [];
	if (!result) return out;
	const add = (r: { id: string; url?: string; command?: string; kind: RecordKind; type: string }) => {
		const o: Option = { id: r.id, kind: r.kind, type: r.type };
		if (r.url !== undefined) o.url = r.url;
		if (r.command !== undefined) o.command = r.command;
		out.push(o);
	};
	for (const group of result.groups) {
		for (const item of group.items) {
			add(item.page);
			for (const h of item.headings) add(h.record);
		}
	}
	return out;
}

export function createController(options: ControllerOptions): Controller {
	const strings = mergeStrings(options.strings);
	const recentMax = options.recentMax ?? 5;
	const limit = options.limit ?? (options.surface === "dialog" ? 20 : undefined);
	const subscribers = new Set<(s: State) => void>();

	let searcher: Searcher | null = null;
	/** The empty box's options: the loaded index's suggested links, in a dialog. One array, so a no-op commit stays one. */
	let resting: Option[] = [];
	let loading: Promise<void> | null = null;
	let warned = false;

	let state: State = {
		open: false,
		status: "idle",
		query: "",
		composing: false,
		type: null,
		picks: {},
		result: null,
		options: [],
		active: -1,
		recent: readRecent(options.storage, options.index, recentMax),
		announce: "",
		capabilities: null,
		locale: null,
	};

	/** Sets the next state and notifies once, if anything changed. */
	function commit(next: State): void {
		const changed = (Object.keys(next) as (keyof State)[]).some((k) => next[k] !== state[k]);
		if (!changed) return;
		state = next;
		for (const fn of [...subscribers]) fn(state);
	}

	/** The state after searching `s.query` with its type and picks. Pure apart from calling the searcher. */
	function searched(s: State): State {
		const q = s.query.trim();
		if (s.composing || s.status !== "ready" || !searcher) return s;
		if (!q) return { ...s, result: null, options: resting, active: s.options === resting ? s.active : -1, announce: "" };
		let result: SearchResult;
		try {
			result = searcher.run({
				q,
				types: options.types,
				type: s.type,
				picks: s.picks,
				group: searcher.settings.group[options.surface],
				limit,
			});
		} catch (e) {
			console.error(e);
			searcher = null;
			loading = null;
			resting = [];
			return { ...s, status: "error", result: null, options: [], active: -1, announce: "", capabilities: null };
		}
		const opts = optionsOf(result);
		return { ...s, result, options: opts, active: opts.length ? 0 : -1, announce: countText(strings, result.total) };
	}

	function warnFacets(): void {
		if (options.dev && !warned) {
			warned = true;
			console.warn(`Search: the "${options.index}" engine does not support facets; the pick is ignored.`);
		}
	}

	/** Starts the load if none is running or done (or the last one failed), without notifying; returns the state to commit. */
	function startLoad(s: State): State {
		if (loading && s.status !== "error") return s;
		const run: Promise<void> = options.load().then(
			(found) => {
				if (loading !== run) return;
				searcher = found;
				resting = options.surface === "dialog" ? suggestedOf(found.settings.suggested) : [];
				let next: State = { ...state, status: "ready", capabilities: found.capabilities, locale: found.locale ?? null };
				if (options.dev && found.settings.synonyms?.length && !found.capabilities.synonyms) {
					console.warn(`Search: the "${options.index}" engine does not support synonyms; the synonyms setting is ignored.`);
				}
				if (!found.capabilities.facets && Object.keys(next.picks).length) {
					warnFacets();
					next = { ...next, picks: {} };
				}
				commit(searched(next));
			},
			(e: unknown) => {
				if (loading === run) commit({ ...state, status: "error", announce: "" });
				throw e;
			},
		);
		// open() and input() do not await the load; this keeps a failure from being an unhandled rejection.
		run.catch(() => {});
		loading = run;
		searcher = null;
		resting = [];
		return { ...s, status: "loading", announce: "", capabilities: null };
	}

	function setQuery(q: string): void {
		// A /search page types without opening a dialog: the first input starts the load.
		const s = state.status === "idle" ? startLoad(state) : state;
		commit(searched({ ...s, query: q }));
	}

	const controller: Controller = {
		index: options.index,
		strings,
		getState: () => state,
		subscribe(fn) {
			subscribers.add(fn);
			return () => void subscribers.delete(fn);
		},
		preload() {
			commit(startLoad(state));
			return loading!;
		},
		open(start) {
			if (!start) return commit(startLoad({ ...state, open: true }));
			let picks = picksOf(start.picks);
			if (state.capabilities && !state.capabilities.facets && Object.keys(picks).length) {
				warnFacets();
				picks = {};
			}
			// One commit: the query, type and picks land together, and run once if the index is ready (else when it is).
			commit(searched(startLoad({ ...state, open: true, query: start.query ?? "", composing: false, type: start.type || null, picks })));
		},
		close() {
			commit({ ...state, open: false });
		},
		toggle() {
			if (state.open) controller.close();
			else controller.open();
		},
		input(q) {
			setQuery(q);
		},
		compositionStart() {
			commit({ ...state, composing: true });
		},
		compositionEnd(q) {
			commit(searched({ ...state, composing: false, query: q }));
		},
		setType(type) {
			commit(searched({ ...state, type }));
		},
		togglePick(facet, value) {
			if (state.capabilities && !state.capabilities.facets) {
				warnFacets();
				return;
			}
			const current = Object.hasOwn(state.picks, facet) ? (state.picks[facet] as string[]) : [];
			const values = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
			// Rebuilt from entries, so a facet named "__proto__" stays an own key.
			const entries = Object.entries(state.picks).map(([f, v]): [string, string[]] => [f, f === facet ? values : v]);
			if (!Object.hasOwn(state.picks, facet)) entries.push([facet, values]);
			const picks: Record<string, string[]> = Object.fromEntries(entries.filter(([, v]) => v.length));
			commit(searched({ ...state, picks }));
		},
		move(step) {
			const n = state.options.length;
			if (!n) return;
			const from = state.active < 0 ? (step === 1 ? -1 : 0) : state.active;
			commit({ ...state, active: (from + step + n) % n });
		},
		moveTo(where) {
			const n = state.options.length;
			if (!n) return;
			const i = where === "first" ? 0 : where === "last" ? n - 1 : Math.max(0, Math.min(n - 1, Math.trunc(where)));
			commit({ ...state, active: i });
		},
		activate() {
			const picked = state.active >= 0 ? (state.options[state.active] ?? null) : null;
			const recent = addRecent(state.recent, state.query, recentMax);
			if (recent !== state.recent) writeRecent(options.storage, options.index, recent);
			commit({ ...state, recent });
			return picked;
		},
		escape() {
			if (state.query !== "") {
				commit({ ...state, query: "", composing: false, result: null, options: resting, active: -1, announce: "" });
				return "cleared";
			}
			commit({ ...state, open: false });
			return "closed";
		},
		searchAllTypes() {
			commit(searched({ ...state, type: null, picks: {} }));
		},
		retry() {
			if (state.status !== "error") return;
			commit(startLoad(state));
		},
	};
	return controller;
}
