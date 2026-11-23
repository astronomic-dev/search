/**
 * The framework-free results page: `mountResultsPage(root, config)` searches one index on a page a server printed,
 * in a shadow root on `root` (the markup is render.ts, the styles styles.ts). The server prints the mount with its own
 * plain result list as light-DOM children, and that list shows until the page works: the shadow root is attached only
 * once the index is loaded and the first render is built, so a failed chunk, manifest, index or render leaves the
 * server's list on screen (fail open). `unmount()` puts a lone <slot> in the shadow root, so the list shows again, and
 * a second mount reuses that shadow root.
 *
 * It follows the kit's SearchPage glue (packages/ui/src/lib/search-page-app.ts): the controller with surface "page",
 * the URL (readUrl/writeUrl with the host's names), "Show more results" (slicePages), bindTabs, bindLive and
 * bindEvents. The history rules are page/history.ts: each change replaces the entry and a submit adds one, so Back
 * returns to the last submitted search; Back and Forward put the URL's state back. This file only makes the writes the
 * rules return.
 *
 * Intended differences from the kit page:
 * - No Astro ClientRouter handling (no null entries, no OWN marker, no astro:* listeners): an embed page has no router.
 *   The page keeps its own marker in history.state instead (KEY below), for the pretty-URL rule.
 * - Pretty URLs: the root's `data-search-query` is the server's query (a path such as `/search/foo/`), with the rule
 *   in page/history.ts. The kit has no server query.
 * - URL names come from the config (`queryParam`, `paramPrefix`); the index in the URL (`${prefix}index`) picks the
 *   index and is kept in every URL the page writes. The kit reads the index from the part only.
 * - The markup is built in code into a shadow root (render.ts), not cloned from the part's templates; group and title
 *   levels are fixed (h2, h3 under a group label).
 * - The error state never shows on first load: a failed load keeps the server's list (fail open). A search that
 *   fails later shows the error state with retry, and no browse links (the config has none).
 * - No `data-search-submit` handoff (the kit's part script submits a query typed before the glue loaded): the server
 *   form is a plain GET form and works on its own until the page mounts. A draft typed in it before or after the mount
 *   starts (a live value other than its printed one) moves to the page's box at the handoff with its caret and focus,
 *   if it had them, and is searched as a change; the URL's query stays the committed entry.
 * - No dev warnings (no `import.meta.env` in the embed build).
 */
import { countText, createController, fill, loadSearcher, type Controller, type State, type StringsInput } from "../controller/index.ts";
import type { Prefetch } from "../controller/prefetch.ts";
import { createSearch } from "../core/search.ts";
import { minisearchEngine } from "../core/minisearch.ts";
import { own } from "../core/own.ts";
import { createIdFor } from "../dom/ids.ts";
import type { GroupBy, IndexSettings, SearchResult, Searcher } from "../core/types.ts";
import { bindEvents } from "../dom/events.ts";
import { bindLive } from "../dom/live.ts";
import { bindTabs } from "../dom/tabs.ts";
import { PAGE_SIZE, slicePages, type Slice } from "../page/slice.ts";
import { createHistory, type HistoryStep } from "../page/history.ts";
import { pickToggles, readUrl, type UrlNames } from "../page/url.ts";
import { pageStrings, type PageWords } from "../page/words.ts";
import { crumbOf, renderFacets, renderList, renderMessage, renderPage, renderTabs, type PageContext, type PageShell } from "./render.ts";
import { styleSheet } from "./styles.ts";

export interface ResultsConfig {
	/** The manifest's URL. */
	manifest: string;
	/** The default index; the URL's `${paramPrefix}index` and the root's `data-search-index` come first. */
	index: string;
	/** The language for the index's locale; default: the page's `<html lang>`. */
	lang?: string;
	/** The query parameter. Default "q". */
	queryParam?: string;
	/** Goes before the type, the index and each facet in the URL. Default "". */
	paramPrefix?: string;
	/** The results URL: the form's action. Default: this page's path. */
	results?: string;
	/** The types the page shows; the root's `data-search-types` overrides it. Default: all. */
	types?: string[];
	strings?: StringsInput & Partial<PageWords>;
	/** The boot's early loads; used only when its index, manifest and lang match this page's. */
	prefetch?: Prefetch & { lang?: string };
	/** Loads the Searcher; default: loadSearcher with the manifest, the prefetch and the MiniSearch engine. */
	load?: (index: string) => Promise<Searcher>;
}

/** The marker in history.state: true on the page's original entry while the server's query applies to it. */
const KEY = "astronomicSearchResults";

/** The index searched: the URL's `${prefix}index`, else the root's data-search-index, else the config's. */
export function effectiveIndex(search: string, rootIndex: string | null | undefined, configIndex: string, names?: UrlNames): string {
	return readUrl(search, [], names).index || rootIndex || configIndex;
}

/**
 * The label ids of mount `n` (a group or facet name in, an id out): one id per distinct name, never shared by two
 * names, and the same for a name on every render.
 */
export const labelIds = (n: number): ((name: string) => string) => createIdFor(`search-results-${n}`);

/** A type from the URL is a tab only when the index has it and the mount shows it (no `types` means all of them). */
export function allowedType(type: string, indexTypes: Record<string, unknown> | null | undefined, types: readonly string[]): boolean {
	return !!indexTypes && Object.hasOwn(indexTypes, type) && (types.length === 0 || types.includes(type));
}

const primary = (lang: string | null | undefined) => (lang ?? "").trim().toLowerCase().split("-")[0] ?? "";

/**
 * The prefetch, if it is for this index, manifest and language (by primary subtag: loadSearcher checks that the file
 * it prefetched is the one it picks); else undefined, and the page loads on its own.
 */
export function prefetchFor<P extends Pick<Prefetch, "index" | "manifestUrl"> & { lang?: string }>(
	prefetch: P | undefined,
	index: string,
	manifestUrl: string,
	lang: string | null | undefined,
): P | undefined {
	if (!prefetch || prefetch.index !== index || prefetch.manifestUrl !== manifestUrl) return undefined;
	if (prefetch.lang !== undefined && primary(prefetch.lang) !== primary(lang)) return undefined;
	return prefetch;
}

/** A group's count beside its label: its type's or value's match count, else the pages shown (the kit's groupCount). */
function groupCount(result: SearchResult | null, group: GroupBy, key: string, shown: number): number {
	const counts = group === "type" ? result?.types : typeof group === "string" ? own(result?.facets, group) : undefined;
	return counts?.find((c) => c.value === key)?.count ?? shown;
}

const typesOf = (root: Element) =>
	(root.getAttribute("data-search-types") ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

type EntryState = Record<string, unknown> | null;
const withKey = (state: unknown, on: boolean): Record<string, unknown> => ({ ...(state && typeof state === "object" ? (state as object) : {}), [KEY]: on });
/**
 * The URL to write for `search`, or undefined when it is the current one (a marker-only write: no URL, so nothing is
 * resolved). Absolute from location.href: a relative URL would resolve against a <base href>, which can be another
 * origin, and the write would throw.
 */
const here = (search: string) => (search === location.search ? undefined : new URL(`${location.pathname}${search}${location.hash}`, location.href).href);

let counter = 0;
const active = new WeakMap<HTMLElement, () => void>();
/**
 * Each server box a mount already read: the value it read, and whether the box was edited (an input event) since. A
 * new draft is an edit since that read (whatever its text: a retyped earlier draft counts) or a value other than the
 * one read (a script set it with no input event).
 */
const seen = new WeakMap<HTMLInputElement, { value: string; edited: boolean }>();

/** Mounts the results page on `root`; returns unmount. A second call on a mounted root returns the same unmount. */
export function mountResultsPage(root: HTMLElement, config: ResultsConfig): () => void {
	const existing = active.get(root);
	if (existing) return existing;
	const doc = root.ownerDocument;
	const names: UrlNames = { query: config.queryParam || "q", prefix: config.paramPrefix ?? "" };
	const index = effectiveIndex(location.search, root.getAttribute("data-search-index"), config.index, names);
	const rootTypes = typesOf(root);
	const types = rootTypes.length ? rootTypes : (config.types ?? []);
	const lang = config.lang || doc.documentElement.lang;
	const serverQuery = root.getAttribute("data-search-query");
	const words = pageStrings(config.strings as Partial<PageWords>);
	/** The history rules; the page only makes the writes they return. The original entry is marked on the first mount. */
	const entries = createHistory({
		search: location.search,
		mark: (history.state as EntryState)?.[KEY],
		serverQuery,
		names,
		index: readUrl(location.search, [], names).index,
		facets: () => facetNames(),
	});
	const go = (steps: HistoryStep[]) => {
		for (const { op, search, pretty } of steps) {
			if (op === "push") history.pushState(withKey(null, pretty), "", here(search));
			else history.replaceState(withKey(history.state, pretty), "", here(search));
		}
	};
	go(entries.start());
	let settings: IndexSettings | null = null;
	let shown = PAGE_SIZE;
	let slice: Slice = slicePages(null, 0);
	let last: Partial<State> = {};
	let unbindTabs: (() => void) | null = null;
	let shadow: ShadowRoot | null = null;
	/** False once the page is unmounted or failed open: a late load then shows nothing. */
	let alive = true;
	const n = ++counter;

	const c: Controller = createController({
		index,
		types,
		surface: "page",
		storage: null,
		strings: config.strings,
		load: async () => {
			const searcher = await (config.load
				? config.load(index)
				: loadSearcher({
						index,
						lang,
						manifestUrl: config.manifest,
						fetch: (url: string, init?: RequestInit) => fetch(url, init),
						engine: minisearchEngine,
						createSearch,
						prefetch: prefetchFor(config.prefetch, index, config.manifest, lang),
					}));
			settings = searcher.settings;
			// The picks again, with the index's facet names: a parameter that is no facet of it (a campaign tag) is no
			// pick, and a declared facet is one whatever its name. A type it lacks is no tab. Only on the first load: by a
			// Retry the visitor may have changed the picks, and the first URL would undo that.
			const want = entries.firstPicks(Object.keys(searcher.settings.facets));
			if (want) for (const [facet, value] of pickToggles(c.getState().picks, want)) c.togglePick(facet, value);
			const type = c.getState().type;
			if (type !== null && !knownType(type)) c.setType(null);
			return searcher;
		},
	});

	const knownType = (type: string) => allowedType(type, settings?.types, types);
	const facetNames = () => Object.keys(settings?.facets ?? {});
	const ctx: PageContext = {
		strings: c.strings,
		words,
		queryParam: names.query!,
		action: config.results || location.pathname,
		idFor: labelIds(n),
		typeLabel: (type) => own(settings?.types, type)?.label ?? type,
		facetLabel: (facet) => own(settings?.facets, facet)?.label ?? facet,
		crumb: (record) => crumbOf(record, settings),
		browse: [],
		get suggested() {
			return settings?.suggested;
		},
	};
	const shell: PageShell = renderPage(doc, ctx);

	const unbinds: (() => void)[] = [];
	const events = bindEvents(root, c);
	unbinds.push(events.unbind, bindLive(shell.live, c));

	/** Replaces a container's children, keeping focus on the element with the same data-key, if it had it. */
	const replace = (container: HTMLElement, nodes: Node[]) => {
		const focused = shadow?.activeElement ?? null;
		const key = focused && container.contains(focused) ? focused.getAttribute("data-key") : null;
		container.replaceChildren(...nodes);
		if (!key) return;
		for (const el of container.querySelectorAll<HTMLElement>("[data-key]")) if (el.getAttribute("data-key") === key) return el.focus();
	};

	/** The results, the count and the more button. */
	const draw = (s: State) => {
		slice = slicePages(s.result, shown);
		const group: GroupBy = settings?.group.page ?? false;
		replace(shell.list, s.result ? renderList(doc, slice.groups, ctx, { count: (key, count) => groupCount(s.result, group, key, count) }) : []);
		shell.more.hidden = !slice.more;
		// No results: the message says so, so the count line hides.
		shell.count.hidden = !s.result || s.result.total === 0;
		shell.count.textContent = s.result ? countText(c.strings, s.result.total) : "";
	};

	const tabTypes = () => {
		const all = Object.keys(settings?.types ?? {});
		return types.length ? all.filter((t) => types.includes(t)) : all;
	};

	const render = (s: State) => {
		const changed = (k: keyof State) => last[k] !== s[k];
		if (!(["result", "status", "query", "type", "picks", "capabilities"] as const).some(changed)) return;
		const searchChanged = changed("query") || changed("type") || changed("picks");
		// A new search starts at the first page of results.
		if (searchChanged) shown = PAGE_SIZE;
		if (searchChanged || changed("result") || changed("status")) draw(s);
		last = { ...s };
		replace(shell.message, [renderMessage(doc, s, ctx)].filter((el): el is HTMLElement => el !== null));

		// The tabs show while there is a type to pick: "All" alone hides the row.
		const all = tabTypes();
		const row = s.status === "ready" && all.length > 1 ? renderTabs(doc, s, ctx, all) : [];
		const showTabs = row.length > 1;
		if (showTabs) {
			replace(shell.tablist, row);
			unbindTabs ??= bindTabs(shell.tablist, c, { panel: shell.panel });
		}
		shell.tablist.hidden = !showTabs;
		shell.typeRow.hidden = !showTabs;

		const rows = renderFacets(doc, s, ctx);
		replace(shell.facets, rows);
		shell.facets.hidden = rows.length === 0;
	};

	/** True while Back or Forward puts an entry's state back: no render and no URL write until all of it is in. */
	let restoring = false;
	/** Each state the controller sends: the page draws it, and the URL follows it (the entry is replaced). */
	const onState = (s: State) => {
		if (restoring) return;
		render(s);
		go(entries.changed(s, location.search));
	};

	/** Puts a URL's query, type and picks into the box and the controller. */
	const apply = (search: string) => {
		const url = readUrl(search, facetNames(), names);
		// The first load's rule: a type the index lacks is no tab.
		const type = url.type !== null && knownType(url.type) ? url.type : null;
		const query = entries.query();
		restoring = true;
		try {
			const s = c.getState();
			for (const [facet, value] of pickToggles(s.picks, url.picks)) c.togglePick(facet, value);
			if (s.type !== type) c.setType(type);
			shell.input.value = query;
			if (query !== c.getState().query) c.input(query);
		} finally {
			restoring = false;
		}
		render(c.getState());
		// The entry's URL follows what was restored (a type the index lacks goes), even when nothing on screen changed.
		go(entries.changed(c.getState(), location.search));
	};

	const submit = () => {
		c.input(shell.input.value);
		go(entries.submitted(c.getState(), location.search));
	};

	const onInput = (e: Event) => {
		if ((e as InputEvent).isComposing) return;
		c.input(shell.input.value);
	};
	const onCompositionStart = () => c.compositionStart();
	const onCompositionEnd = () => c.compositionEnd(shell.input.value);
	const onSubmit = (e: Event) => {
		e.preventDefault();
		submit();
	};
	const onPop = (e: PopStateEvent) => {
		entries.popped(location.search, (e.state as EntryState)?.[KEY]);
		apply(location.search);
		// The restore writes the URL in the page's own spelling (`%20` becomes `+`); that is the baseline a submit compares.
		entries.rebase(location.search);
	};
	const onClick = (e: Event) => action(e as MouseEvent);
	const onMore = () => more();

	const action = (e: MouseEvent) => {
		if (e.type === "auxclick" && e.button !== 1) return;
		const el = e.target as Element | null;
		const result = el?.closest?.<HTMLElement>("a[data-search-position]");
		if (result && shell.list.contains(result)) {
			const i = Number(result.getAttribute("data-search-position")) - 1;
			const option = slice.options[i];
			if (option) events.select(option, i + 1);
			return;
		}
		if (e.type !== "click") return;
		const target = el?.closest?.("[data-action]");
		if (!target || !shell.root.contains(target)) return;
		switch (target.getAttribute("data-action")) {
			case "retry":
				c.retry();
				shell.input.focus();
				break;
			case "all-types":
				c.searchAllTypes();
				shell.input.focus();
				break;
			case "facet":
				c.togglePick(target.getAttribute("data-facet") ?? "", target.getAttribute("data-value") ?? "");
				break;
		}
	};

	/** "Show more results": the next PAGE_SIZE pages. Focus stays on the button; the new first result is read with the count. */
	const more = () => {
		const s = c.getState();
		if (!s.result) return;
		const from = slice.shown;
		shown += PAGE_SIZE;
		draw(s);
		const first = shell.list.querySelectorAll<HTMLElement>('a[part~="link"][data-search-position]')[from];
		if (!first) return;
		if (shell.more.hidden) first.focus();
		const text = fill(words.moreShown, { position: from + 1, total: s.result.total, title: first.textContent ?? "" });
		shell.live.textContent = "";
		requestAnimationFrame(() => (shell.live.textContent = text));
	};

	/** The server's list shows again. */
	const restore = () => {
		if (!shadow) return;
		shadow.replaceChildren(doc.createElement("slot"));
		shadow.adoptedStyleSheets = [];
	};
	const teardown = () => {
		if (!alive) return;
		alive = false;
		for (const unbind of unbinds.reverse()) unbind();
		unbinds.length = 0;
		unbindTabs?.();
		unbindTabs = null;
		restore();
		if (active.get(root) === unmount) active.delete(root);
	};

	/**
	 * The server form's query box as the visitor left it, read just before the shadow root hides it. Its printed value
	 * (defaultValue) is never a draft. On the first read any other live value is one, typed before or after the mount
	 * started; from then on only an edit or a new value since the last read makes one (see seen), so a remount (after a
	 * form reset too, which puts the printed value back) shows the current search instead of replaying an old draft.
	 */
	const draftOf = () => {
		const box = root.querySelector<HTMLInputElement>(`input[name="${CSS.escape(names.query!)}"]`);
		if (!box) return null;
		const focused = doc.activeElement === box;
		const last = seen.get(box);
		const fresh = !last || last.edited || box.value !== last.value;
		if (!last) box.addEventListener("input", () => (seen.get(box)!.edited = true));
		seen.set(box, { value: box.value, edited: false });
		const value = fresh && box.value !== box.defaultValue ? box.value : null;
		if (value === null && !focused) return null;
		return { value, focused, start: box.selectionStart, end: box.selectionEnd, dir: box.selectionDirection };
	};

	/** The draft moves to the page's box with its caret and focus, and it is searched (a change, not a submit). */
	const handOff = (draft: NonNullable<ReturnType<typeof draftOf>>) => {
		if (draft.value !== null) {
			shell.input.value = draft.value;
			c.input(draft.value);
		}
		if (!draft.focused) return;
		shell.input.focus();
		if (draft.start !== null && draft.end !== null) shell.input.setSelectionRange(draft.start, draft.end, draft.dir ?? undefined);
	};

	/** The index is in: build the page off screen, then show it in place of the server's list. */
	const show = () => {
		if (!alive || c.getState().status !== "ready") return;
		try {
			render(c.getState());
			go(entries.changed(c.getState(), location.search));
			// The first render writes the URL in the page's own spelling (`%20` becomes `+`): a submit compares with that.
			entries.rebase(location.search);
			const draft = draftOf();
			shadow = root.shadowRoot ?? root.attachShadow({ mode: "open" });
			shadow.adoptedStyleSheets = [styleSheet()];
			shadow.replaceChildren(shell.root);
			unbinds.push(c.subscribe(onState));
			shell.input.addEventListener("input", onInput);
			shell.input.addEventListener("compositionstart", onCompositionStart);
			shell.input.addEventListener("compositionend", onCompositionEnd);
			shell.form.addEventListener("submit", onSubmit);
			shell.more.addEventListener("click", onMore);
			shell.root.addEventListener("click", onClick);
			shell.root.addEventListener("auxclick", onClick);
			window.addEventListener("popstate", onPop);
			if (draft) handOff(draft);
			unbinds.push(() => {
				shell.input.removeEventListener("input", onInput);
				shell.input.removeEventListener("compositionstart", onCompositionStart);
				shell.input.removeEventListener("compositionend", onCompositionEnd);
				shell.form.removeEventListener("submit", onSubmit);
				shell.more.removeEventListener("click", onMore);
				shell.root.removeEventListener("click", onClick);
				shell.root.removeEventListener("auxclick", onClick);
				window.removeEventListener("popstate", onPop);
			});
		} catch (e) {
			console.error(e);
			teardown();
		}
	};

	// The URL's type and picks, then its query (or the server's), into the controller; the load starts now.
	const url = readUrl(location.search, undefined, names);
	for (const [facet, value] of pickToggles({}, url.picks)) c.togglePick(facet, value);
	if (url.type) c.setType(url.type);
	const query = entries.query();
	shell.input.value = query;
	if (query.trim()) c.input(query);
	// Fail open: the server's list stays.
	c.preload().then(show, teardown);

	function unmount(): void {
		teardown();
	}
	active.set(root, unmount);
	return unmount;
}
