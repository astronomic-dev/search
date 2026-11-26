/**
 * Search for EmDash: a native (trusted) plugin that builds the search index from EmDash content, keeps it fresh,
 * serves it as JSON and prints the search embed on every public page.
 *
 * @example
 * ```js
 * // astro.config.mjs
 * import emdash from "emdash/astro";
 * import { search } from "@astronomic-dev/search/emdash";
 * import { searchFiles } from "@astronomic-dev/search/emdash/astro";
 *
 * export default defineConfig({ integrations: [emdash({ plugins: [search()] }), searchFiles()] });
 * ```
 */
import type { PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";
import { checkListPages } from "./core/list-pages.ts";
import { checkExclude } from "./core/paths.ts";
import type { PluginOptions } from "./core/ports.ts";
import { checkTaxonomyKeywords } from "./core/records.ts";
import { ADMIN_ENTRY, ADMIN_PAGES, CAPABILITIES, PLUGIN_ID, pluginDefinition, VERSION } from "./plugin.ts";

export type { ListPage as SearchListPage, PluginOptions as SearchPluginOptions } from "./core/ports.ts";

const ENTRYPOINT = "@astronomic-dev/search/emdash";

/** Whether `value` comes back from JSON unchanged (EmDash writes the options into generated code as JSON). */
function sameAsJson(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(sameAsJson);
	if (typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.values(value).every((v) => v !== undefined && sameAsJson(v));
}

/** The plugin for `emdash({ plugins: [search()] })`. Options are JSON only: a function, RegExp or Date throws. */
export function search(options: PluginOptions = {}): PluginDescriptor<PluginOptions> {
	if (!sameAsJson(options)) {
		throw new Error("search(): options must be plain JSON (no functions, RegExps, Dates or undefined values); EmDash passes them to the plugin as JSON");
	}
	if (options.exclude !== undefined) checkExclude(options.exclude);
	if (options.listPages !== undefined) checkListPages(options.listPages);
	if (options.taxonomyKeywords !== undefined) checkTaxonomyKeywords(options.taxonomyKeywords);
	return {
		id: PLUGIN_ID,
		version: VERSION,
		entrypoint: ENTRYPOINT,
		format: "native",
		options,
		capabilities: [...CAPABILITIES],
		adminEntry: ADMIN_ENTRY,
		adminPages: ADMIN_PAGES,
	};
}

/** EmDash calls this with the descriptor's options (`format: "native"`). */
export function createPlugin(options: PluginOptions = {}): ResolvedPlugin {
	return definePlugin(pluginDefinition(options));
}
