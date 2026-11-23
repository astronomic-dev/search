/**
 * The embed's app chunk, loaded on first use by the embed boot: `startApp` with the settings the page's config tag
 * gave (see config.ts), plus `openFrom` for the embed's own openers (the theme field, a placement field or a modal
 * link). It never imports app.ts, which carries the Astro build's filled-in settings.
 *
 * At once it makes the default dialog for `config.index`, and that dialog owns the shortcut keys whatever triggers the
 * host page has: the boot hands the shortcut over to it, so exactly one dialog answers it.
 */
import { openFrom, placementText, type OpenFrom } from "./embed/open-from.ts";
import { embedSeeAll, type EmbedConfig } from "./config.ts";
import { startApp, type SearchApp } from "./start-app.ts";
import { defaultKey, TAG, triggerKey, type SearchElement } from "../ui/element.ts";

export interface EmbedApp extends SearchApp {
	/** The default index's dialog, made at start; it owns the shortcut keys. */
	readonly main: SearchElement;
	/**
	 * Opens the dialog for `source`'s index (its placement's data-search-index, else config.index) with `start` and its
	 * placement's placeholder; focus returns to `opener` on close. One dialog is open at a time: any other open dialog
	 * closes first.
	 */
	openFrom(source: Element, start: OpenFrom, opener: HTMLElement | null): SearchElement;
}

export function createEmbedApp(config: EmbedConfig): EmbedApp {
	const app = startApp({
		manifest: config.manifest,
		index: config.index,
		strings: config.strings,
		browse: config.browse,
		lang: config.lang,
		results: config.results,
		seeAll: embedSeeAll(config),
	});
	const main = app.dialog(defaultKey(config.index), config.keys);
	/** Counts opens, so an open that a reentrant one overtook stops (see openFrom). */
	let opens = 0;

	/**
	 * Closes every open dialog other than `el` (one the shortcut opened too), before `el` opens: one dialog is open at a
	 * time, and the scroll lock is undone before the next one takes it. The page is inert while they close, so no focus
	 * return lands on a page control: a page's focusin listener there could start another open.
	 */
	const closeOthers = (el: SearchElement) => {
		const others = [...document.querySelectorAll<SearchElement>(TAG)].filter((d) => d !== el && d.controller.getState().open);
		if (!others.length) return;
		const body = document.body;
		const was = body.inert;
		body.inert = true;
		for (const d of others) d.controller.close();
		body.inert = was;
	};

	return {
		...app,
		main,
		openFrom(source, start, opener) {
			const n = ++opens;
			const owner = source.closest("[data-search-placement]") ?? source;
			const el = app.dialog(triggerKey(owner, config.index));
			closeOthers(el);
			// A newer open started while the others closed: that one stays.
			if (n !== opens) return el;
			el.controller.preload().catch(() => {});
			openFrom(el, { ...start, placeholder: placementText(source) }, opener);
			return el;
		},
	};
}
