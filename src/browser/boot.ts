/**
 * The small script a page with a search button loads (a hashed file in `/_search/`): the shared boot logic
 * (start.ts) for the default dialog's triggers, loading the app by its hashed URL on first use.
 *
 * At build time `__ASTRONOMIC_SEARCH__` is defined as `{ app, manifest, index, shortcut }`.
 */
import { startBoot } from "./start.ts";

type App = typeof import("./app.ts");
declare const __ASTRONOMIC_SEARCH__: { app: string; manifest: string; index: string; shortcut: { keys: string[] } | false };

const { app: url, shortcut } = __ASTRONOMIC_SEARCH__;
startBoot({ keys: shortcut ? shortcut.keys : [], load: () => import(/* @vite-ignore */ url) as Promise<App> });
