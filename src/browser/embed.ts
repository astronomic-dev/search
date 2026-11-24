/**
 * The embed boot (search-embed.js): the small first-paint script a server page loads as a plain ES module, with its
 * settings at run time from the page's one config tag (config.ts). It is built by scripts/build-embed.mjs, which
 * replaces `__SEARCH_EMBED_APP__` and `__SEARCH_EMBED_RESULTS__` with the app and results chunks' paths
 * ("./chunks/embed-app-<hash>.js", "./chunks/embed-results-<hash>.js"), relative to this file.
 *
 * Until search is needed it only listens. Hover or focus on a placement ([data-search-placement]) or on a theme search
 * form that takeover takes (embed/takeover.ts) warms it: it starts the manifest and default index loads
 * (controller/prefetch.ts) and the app chunk's load together, and hands the early loads to the app. While the app is
 * cold, this script owns the shortcut keys: a press is held, the app loads, and the press is replayed for the default
 * dialog's own shortcut binder, which owns the keys from then on.
 *
 * Placements (embed/placements.ts) and, with takeover on, the theme's plain search form (embed/takeover.ts: its field
 * and its submit, which fails open to a native submit) share one set of input listeners (embed/input.ts), placements
 * first, and open through the one open path (embed/session.ts): the proxy when cold or on touch, the real dialog at
 * once otherwise. Placements work whether or not takeover is on.
 *
 * A page with a results mount ([data-search-results]) loads the results chunk at once, with early loads for the index it
 * searches (the URL's, the mount's or the default), shared with the app when that is the default index (each takes its
 * own one-use handle on the same loads). If the chunk fails, the server's list stays.
 *
 * No tag, a tag that cannot be used, or no constructable stylesheets: nothing happens, and the page works as it does
 * with no JavaScript.
 */
import { readConfigTag, type EmbedConfig } from "./config.ts";
import type { EmbedApp } from "./embed-app.ts";
import { createOpen } from "./embed/session.ts";
import { bindInput, type Hit } from "./embed/input.ts";
import { placementHit, PLACEMENT } from "./embed/placements.ts";
import { RESULTS, startTakeover } from "./embed/takeover.ts";
import { prefetch, type Prefetch } from "../controller/prefetch.ts";
import { activeElementOf, isApple, isEditable, shortcutAction } from "../dom/shortcut.ts";

declare const __SEARCH_EMBED_APP__: string;
declare const __SEARCH_EMBED_RESULTS__: string;

type AppModule = typeof import("./embed-app.ts");
type ResultsModule = typeof import("./embed-results.ts");

const config = readConfigTag(document);
// The proxy, the dialog and the results page style their shadow roots with constructable stylesheets (Safari 16.4+).
// Without them the embed binds nothing, so every form and link stays native.
if (config && "adoptedStyleSheets" in Document.prototype) startEmbed(config);

function startEmbed(config: EmbedConfig): void {
	const doc = document;
	const win = window;
	let early: Prefetch | undefined;
	let loading: Promise<EmbedApp> | null = null;
	let ready: EmbedApp | null = null;
	/**
	 * The app failed to load while an open or a held shortcut press waited on it: the embed is off for the page. Every
	 * opener stays a plain form or link, the shortcut is the browser's, and nothing loads again.
	 */
	let failed = false;
	/** Failed loads so far; a load after one asks for a fresh URL (see load). */
	let tries = 0;
	/** A press is held, so a second one while loading does not toggle twice. Its load makes `ready` or `failed` true. */
	let held = false;
	const takeover = startTakeover(doc, config);
	/**
	 * With takeover on, the shortcut wins over the theme's own (a theme script that takes Cmd+K for its header box): it
	 * listens in the window's capture phase and stops a press it acts on, here and in the app (its `capture`): every
	 * listener after it never sees the press, even another capture listener on the window (one registered there before
	 * it, or before the app's own listener, still runs first).
	 */
	const capture = !!takeover;
	const lang = config.lang ?? doc.documentElement.lang;
	const earlyFor = (index: string) => prefetch({ index, lang, manifestUrl: config.manifest, fetch });

	/**
	 * Loads the app chunk (once), with the default index's early loads alongside. A failure nothing waited on (a
	 * warm-up, or an open that was dropped first) is tried again at the next use, from the chunk's URL with a query that
	 * changes on every try: a browser may keep a failed module import under its URL for the page's life (Chromium
	 * does), so every browser fetches again only on a fresh URL.
	 */
	function load(): Promise<EmbedApp> {
		if (loading) return loading;
		early ??= earlyFor(config.index);
		const url = new URL(__SEARCH_EMBED_APP__ + (tries ? "?r=" + tries : ""), import.meta.url).href;
		loading = (import(/* @vite-ignore */ url) as Promise<AppModule>).then(
			(m) => {
				const app = m.createEmbedApp(config);
				app.usePrefetch(early!);
				// The default dialog's own shortcut binder takes over (see onShortcut).
				return (ready = app);
			},
			(e: unknown) => {
				// The next use tries again, the early loads too.
				loading = null;
				early = undefined;
				tries++;
				throw e;
			},
		);
		return loading;
	}

	/** Turns the embed off for the page (see `failed`); every taken field in it goes back to the theme. */
	function off(): void {
		failed = true;
		takeover?.off();
	}

	/**
	 * What `t` is to the embed. Placements win: a target inside one is never takeover's. `warms`: what warms it instead,
	 * the whole placement, or anywhere in a theme search form takeover takes.
	 */
	function resolve(t: EventTarget | null, warms?: boolean): Hit | true {
		// Off, a field that was out of the page then (a cached header) may still be taken: it goes back at its first use.
		if (failed) takeover?.release(t as HTMLInputElement);
		if (failed || !(t instanceof Element)) return null;
		// Through the prototype: a form's control named "closest" shadows the method on the form itself.
		const up = (sel: string) => Element.prototype.closest.call(t, sel);
		const p = up(PLACEMENT);
		return p ? warms || placementHit(t, p, config.takeover.inputName) : (takeover?.hit((warms && up("form")) || t) ?? null);
	}

	/** A cold press (once the app is in, its own binder has the keys; once the embed is off, the browser has). */
	function onShortcut(e: KeyboardEvent): void {
		if (ready || failed || e.defaultPrevented || !shortcutAction(e, config.keys, isApple(navigator), false)) return;
		e.preventDefault();
		if (capture) e.stopImmediatePropagation();
		if (held) return;
		held = true;
		// Replay where the press happened: inside a shadow root, the element there, not its host.
		const origin = e.composedPath()[0] ?? e.target;
		load().then(
			() => {
				// Focus moved into a text field while the app loaded: the press is dropped, as the shortcut would not open there.
				if (isEditable(activeElementOf(doc))) return;
				(origin instanceof Node && origin.isConnected ? origin : win).dispatchEvent(new KeyboardEvent("keydown", e));
			},
			off,
		);
	}

	const warm = (e: Event) => {
		if (resolve(e.target, true)) load().catch(() => {});
	};
	doc.addEventListener("pointerover", warm);
	doc.addEventListener("focusin", warm);
	if (config.keys.length) win.addEventListener("keydown", onShortcut, capture);

	const open = createOpen(doc, { load, ready: () => ready }, config.strings.placeholder || "Search", off, config.theme, takeover?.release);
	bindInput(doc, resolve as (t: EventTarget | null) => Hit, open, takeover?.submit);

	const results = doc.querySelector<HTMLElement>(RESULTS);
	if (results) {
		// The index the results page searches, by its rule (results/mount.ts effectiveIndex), so the early loads match it.
		const index = new URLSearchParams(location.search).get(config.paramPrefix + "index") || results.getAttribute("data-search-index") || config.index;
		// The dialog's loads, when they are for the same index, through a handle of its own: a load uses a handle once.
		const pre = index === config.index ? { ...(early ??= earlyFor(index)) } : earlyFor(index);
		(import(/* @vite-ignore */ new URL(__SEARCH_EMBED_RESULTS__, import.meta.url).href) as Promise<ResultsModule>).then(
			(m) => m.mountEmbedResults(results, config, pre),
			() => {},
		);
	}
}
