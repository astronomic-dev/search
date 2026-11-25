/**
 * The search app the boot script loads on first use (a hashed file in `/_search/`): core, the MiniSearch engine, the
 * controller, the dom layer and the default dialog. It defines <astronomic-search> and makes one per trigger key
 * (see `startApp` in start-app.ts).
 *
 * When the integration starts, `__ASTRONOMIC_SEARCH__` is replaced with `{ manifest, index, strings, browse, theme? }`.
 */
import { startApp, type AppConfig } from "./start-app.ts";

declare const __ASTRONOMIC_SEARCH__: AppConfig;
const app = startApp(__ASTRONOMIC_SEARCH__);
export const { usePrefetch, prepare, open } = app;
