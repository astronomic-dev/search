/**
 * The search app as a function: `startApp(config)` defines <astronomic-search> and returns the calls that make one
 * dialog per trigger key. It has no top-level side effects and reads no build-time name, so both the Astro app
 * (`app.ts`, settings filled in at build time) and the embed app (settings read at run time) can call it.
 */
import { loadSearcher, type Prefetch, type StringsInput } from "../controller/index.ts";
import { createSearch } from "../core/search.ts";
import { minisearchEngine } from "../core/minisearch.ts";
import { defaultKey, defineSearchElement, SearchElement, TAG, triggerKey } from "../ui/element.ts";
import type { BrowseLink, SeeAll } from "../ui/render.ts";

export interface AppConfig {
	manifest: string;
	index: string;
	strings: StringsInput;
	browse: BrowseLink[];
	/** The language for the index's stemmer; default: the page's `<html lang>`. */
	lang?: string;
	/** The results page URL. */
	results?: string;
	seeAll?: SeeAll;
}

export interface SearchApp {
	/**
	 * Hands over the manifest and index file loads boot started alongside this app's own load, so the first load of
	 * the main index uses them in place of fetching again.
	 */
	usePrefetch(p: Prefetch): void;
	/**
	 * Makes the dialog for `trigger` (and the main trigger's, so the shortcut is bound) and starts loading its index.
	 * `keys` are the shortcut keys; they go to the main trigger's dialog only (with no trigger on the page, to the
	 * default index's dialog).
	 */
	prepare(trigger: HTMLElement, keys?: string[]): SearchElement;
	/** Opens the dialog for `trigger` (default: the main trigger). */
	open(trigger?: HTMLElement | null, keys?: string[]): void;
	/**
	 * The dialog for a trigger (its data-search-index/types/group), made on first use, and bound again when `trigger`
	 * is one it does not answer yet. `keys` go to it only when it is the main trigger's dialog (with no trigger on the
	 * page, the default index's).
	 */
	dialogFor(trigger: Element, keys?: string[]): SearchElement;
	/**
	 * The dialog for `key` (see triggerKey), made on first use and appended again after a view transition removed it.
	 * It never binds again, so an open dialog keeps its listeners. A dialog made here owns `keys` as its shortcut,
	 * whatever triggers the page has: the caller decides the shortcut's owner.
	 */
	dialog(key: string, keys?: string[]): SearchElement;
}

const TRIGGER = "[data-search-trigger]:not([data-search-ui])";

export function startApp(config: AppConfig): SearchApp {
	/** The loads boot started (see `usePrefetch`); taken by the first load of their index. */
	let early: Prefetch | undefined;

	function take(index: string): Prefetch | undefined {
		const p = early?.index === index ? early : undefined;
		if (p) early = undefined;
		return p;
	}

	defineSearchElement({
		index: config.index,
		strings: config.strings,
		browse: config.browse,
		results: config.results,
		seeAll: config.seeAll,
		load: (index) =>
			loadSearcher({
				index,
				lang: config.lang || document.documentElement.lang,
				manifestUrl: config.manifest,
				// The init carries the manifest's cache mode ({ cache: "no-cache" }).
				fetch: (url: string, init?: RequestInit) => fetch(url, init),
				engine: minisearchEngine,
				createSearch,
				prefetch: take(index),
			}),
	});

	const dialogs = new Map<string, SearchElement>();
	/** The shortcut keys boot passed in, kept for the main dialog after a view transition. */
	let shortcutKeys: string[] = [];

	function mainTrigger(): HTMLElement | null {
		return document.querySelector<HTMLElement>(`${TRIGGER}[data-search-main]`) ?? document.querySelector<HTMLElement>(TRIGGER);
	}

	/**
	 * The dialog for a key, made (and appended to the body) on first use. A view transition swaps the body and so
	 * removes the dialog: it is appended again, and connecting binds it to the new page's triggers.
	 */
	function dialog(key: string, keys: string[] = []): SearchElement {
		let el = dialogs.get(key);
		if (!el) {
			el = document.createElement(TAG) as SearchElement;
			const [index, types, group] = key.split("|");
			el.setAttribute("index", index!);
			if (types) el.setAttribute("types", types);
			if (group) el.setAttribute("group", group);
			el.keys = keys;
			dialogs.set(key, el);
		}
		if (!el.isConnected) document.body.append(el);
		return el;
	}

	function dialogFor(trigger: Element, keys: string[] = []): SearchElement {
		if (keys.length) shortcutKeys = keys;
		const key = triggerKey(trigger, config.index);
		const known = dialogs.get(key);
		if (known?.isConnected) {
			if (!known.triggers.includes(trigger as HTMLElement)) known.bind();
			return known;
		}
		// The main trigger's dialog owns the shortcut; on a page with no trigger, the default index's does.
		const main = mainTrigger();
		return dialog(key, (main ? triggerKey(main, config.index) : defaultKey(config.index)) === key ? keys : []);
	}

	function prepare(trigger: HTMLElement, keys: string[] = []): SearchElement {
		const main = mainTrigger();
		if (main && main !== trigger) dialogFor(main, keys);
		const el = dialogFor(trigger, keys);
		el.controller.preload().catch(() => {});
		return el;
	}

	function open(trigger: HTMLElement | null = mainTrigger(), keys: string[] = []): void {
		if (!trigger) return;
		prepare(trigger, keys).controller.open();
	}

	// Astro's ClientRouter swapped the body: boot no longer listens for the shortcut (this app took over), so bind the
	// main dialog to the new page now, before any trigger is used.
	document.addEventListener("astro:after-swap", () => {
		const main = mainTrigger();
		if (main && dialogs.size) dialogFor(main, shortcutKeys);
	});

	return {
		usePrefetch: (p) => {
			early = p;
		},
		prepare,
		open,
		dialogFor,
		dialog,
	};
}
