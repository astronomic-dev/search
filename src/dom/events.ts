/**
 * Analytics events. The search sends nothing anywhere: it dispatches DOM events a site can forward to its own
 * analytics. Each is a CustomEvent with bubbles and composed, so it leaves a shadow root and reaches `document`.
 *
 * - `search:query` once typing stops (the live region's quiet time), for each new query or type tab.
 * - `search:noresults` right after it, when that query found nothing.
 * - `search:select` when a result or a suggested link is opened (Enter, a click, a new tab). A query still waiting
 *   for the quiet time fires first, and so does one when the dialog closes.
 *
 * Nothing fires for an empty box or while an input method is composing.
 */
import type { Controller, Option, State } from "../controller/index.ts";

export interface SearchQueryDetail {
	/** The query as typed, trimmed. */
	query: string;
	index: string;
	/** The loaded index file's locale. */
	locale: string | null;
	/** Matching pages, over all matches (not only those shown). */
	total: number;
	/** The active type tab; null for all. */
	type: string | null;
}

export interface SearchSelectDetail {
	/** The query; "" for a suggested link picked from an empty box. */
	query: string;
	index: string;
	/** The record id; null for a suggested link. */
	id: string | null;
	url: string | null;
	/** The record's (or the suggested link's) content type, if it has one. */
	type: string | null;
	/** 1-based, in screen order: the first option is 1. */
	position: number;
}

export interface SearchNoResultsDetail {
	query: string;
	index: string;
}

declare global {
	interface HTMLElementEventMap {
		"search:query": CustomEvent<SearchQueryDetail>;
		"search:select": CustomEvent<SearchSelectDetail>;
		"search:noresults": CustomEvent<SearchNoResultsDetail>;
	}
	interface DocumentEventMap {
		"search:query": CustomEvent<SearchQueryDetail>;
		"search:select": CustomEvent<SearchSelectDetail>;
		"search:noresults": CustomEvent<SearchNoResultsDetail>;
	}
}

export interface EventsOptions {
	/** Milliseconds after the last change. Default 600, as the live region. */
	delay?: number;
}

export interface Events {
	/** Fires search:select for an opened option (and a pending search:query first). */
	select(option: Option, position: number): void;
	unbind(): void;
}

/** The settled query's key, or null when no search:query may fire now. */
function settled(s: State): string | null {
	const q = s.query.trim();
	if (!q || s.composing || s.status !== "ready" || !s.result) return null;
	return `${q}\u0000${s.type ?? ""}`;
}

export function bindEvents(target: EventTarget, controller: Controller, options: EventsOptions = {}): Events {
	const delay = options.delay ?? 600;
	const index = controller.index;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** The key of the last query that fired; "" once the box is emptied, so the same words typed again fire again. */
	let fired = "";
	let last: Partial<State> = {};
	let bound = true;

	const emit = (name: string, detail: object) => target.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));

	const fire = () => {
		clearTimeout(timer);
		timer = undefined;
		const s = controller.getState();
		const key = settled(s);
		if (!bound || key === null || key === fired) return;
		fired = key;
		const query = s.query.trim();
		const total = s.result!.total;
		emit("search:query", { query, index, locale: s.locale, total, type: s.type } satisfies SearchQueryDetail);
		if (total === 0) emit("search:noresults", { query, index } satisfies SearchNoResultsDetail);
	};

	const sync = (s: State) => {
		const was = last;
		last = s;
		if (was.open && !s.open && timer !== undefined) return fire();
		if (s.query === was.query && s.type === was.type && s.result === was.result && s.composing === was.composing && s.status === was.status) return;
		if (!s.query.trim()) fired = "";
		clearTimeout(timer);
		timer = settled(s) === null ? undefined : setTimeout(fire, delay);
	};

	last = controller.getState();
	const unsubscribe = controller.subscribe(sync);
	return {
		select(option, position) {
			if (!bound) return;
			if (timer !== undefined) fire();
			const s = controller.getState();
			emit("search:select", {
				query: s.query.trim(),
				index,
				id: option.kind === "suggested" ? null : option.id,
				url: option.url ?? null,
				type: option.type ?? null,
				position,
			} satisfies SearchSelectDetail);
		},
		unbind() {
			bound = false;
			unsubscribe();
			clearTimeout(timer);
			timer = undefined;
		},
	};
}
