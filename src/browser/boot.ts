/**
 * The small script a page with a search button loads (a hashed file in `/_search/`): the shared boot logic
 * (start.ts) for the default dialog's triggers, loading the app by its hashed URL on first use. At the same time it
 * starts the manifest load, and the index file's once the manifest is in, and hands both to the app, so the three
 * loads take about two waits in parallel (app, and manifest then file) instead of three in a row.
 *
 * When the integration starts, `__ASTRONOMIC_SEARCH__` is replaced with `{ app, manifest, index, shortcut, placeholder, search?, theme? }`.
 */
import { startBoot } from "./start.ts";
import { defaultTouch, withTouch } from "./touch-default.ts";
import { prefetch, type Prefetch } from "../controller/prefetch.ts";

type App = typeof import("./app.ts");
declare const __ASTRONOMIC_SEARCH__: { app: string; manifest: string; index: string; shortcut: { keys: string[] } | false; placeholder: string; search?: string; theme?: string };

const { app: url, manifest, index, shortcut, placeholder, search, theme } = __ASTRONOMIC_SEARCH__;
let early: Prefetch;
startBoot({
	keys: shortcut ? shortcut.keys : [],
	touch: defaultTouch(placeholder, search, theme),
	// The trigger's own index, as the app's dialogs read it (triggerKey).
	preload: (t) => (early = prefetch({ index: t.getAttribute("data-search-index") || index, lang: document.documentElement.lang, manifestUrl: manifest, fetch })),
	load: () =>
		(import(/* @vite-ignore */ url) as Promise<App>).then((app) => {
			app.usePrefetch(early);
			return withTouch(app);
		}),
});
