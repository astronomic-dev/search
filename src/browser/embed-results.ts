/**
 * The embed's results chunk, loaded by the embed boot at once on a page with a `[data-search-results]` mount:
 * `mountResultsPage` with the settings the page's config tag gave (see config.ts), and the boot's early loads for the
 * index the page searches (made for the same language the page computes), so the page fetches the manifest and the
 * index file once.
 */
import type { EmbedConfig } from "./config.ts";
import type { Prefetch } from "../controller/prefetch.ts";
import { mountResultsPage } from "../results/mount.ts";

export function mountEmbedResults(root: HTMLElement, config: EmbedConfig, prefetch?: Prefetch): () => void {
	// The results page's shadow root styles its host: a theme attribute there wins over the device's color scheme. A
	// theme the server printed on the mount stays.
	if (config.theme && !root.hasAttribute("theme")) root.setAttribute("theme", config.theme);
	return mountResultsPage(root, {
		manifest: config.manifest,
		index: config.index,
		lang: config.lang,
		queryParam: config.queryParam,
		paramPrefix: config.paramPrefix,
		results: config.results,
		strings: config.strings,
		prefetch,
	});
}
