/**
 * The Astro integration: `search({ sources, ... })` or `search({ indexes: { ... } })` in `astro.config`.
 *
 * Setup normalizes the settings, builds the browser scripts as hashed files, injects the records route and serves
 * two virtual modules. After the build it reads the records route's output, scans the built HTML, runs the hooks,
 * merges, checks that every collection and html() record URL is a built page, and writes the index files, the
 * manifest and the scripts to `_search/`.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";
import { scanHtml } from "../adapters/html.ts";
import { minisearchEngine } from "../core/minisearch.ts";
import type { UrlOptions } from "../core/url.ts";
import { builtPageProblems, checkBrowseLinks, collectRecords, hasCollections, normalizeSettings, routeSpecs, safePath, searchPageUrl, searchPageWarning, statLine, writeIndexes, type RouteData, type SearchOptions } from "./build.ts";
import { bundleScripts, MANIFEST, OWN_EXT, type Bundle } from "./bundle.ts";
import { devMiddleware } from "./dev.ts";

export { collections, type CollectionSpec, type FilterEntry } from "../adapters/collections.ts";
export { html, type HtmlOptions } from "../adapters/html.ts";
export { records, type RecordInput, type RecordsOptions } from "../adapters/records.ts";
export type { IndexInput, SearchOptions } from "./build.ts";

const SPECS = "virtual:astronomic-search/specs";
const ASSETS = "virtual:astronomic-search/assets";
const RECORDS_PATH = "_search/__records.json";

declare global {
	namespace Astro {
		interface IntegrationHooks {
			/** The index names, for an integration that needs one (a kit integration checks for `kit`). */
			"@astronomic-dev/search:indexes": () => string[];
		}
	}
}

export default function search(options: SearchOptions): AstroIntegration {
	const settings = normalizeSettings(options);
	const engine = minisearchEngine;
	let urlOptions: UrlOptions;
	let defaultLocale = "en";
	let locales: string[] = [];
	let onDemand = false;
	let bundle: Bundle;
	let searchPage = "/search";

	return {
		name: "@astronomic-dev/search",
		hooks: {
			// Not an Astro hook: another integration reads the index names from the config's integrations.
			"@astronomic-dev/search:indexes": () => Object.keys(settings.indexes),
			"astro:config:setup": async ({ config, injectRoute, updateConfig }) => {
				urlOptions = { base: config.base, trailingSlash: config.trailingSlash, format: config.build.format, ...(config.site ? { site: config.site } : {}) };
				checkBrowseLinks(settings.browse, urlOptions);
				searchPage = searchPageUrl(urlOptions);
				defaultLocale = config.i18n?.defaultLocale ?? "en";
				onDemand = config.output === "server";
				// Astro's locales are tags or { path, codes }; a record's locale is the tag, or the first code.
				locales = (config.i18n?.locales ?? []).map((l) => (typeof l === "string" ? l : (l.codes[0] ?? l.path)));
				bundle = await bundleScripts({ base: config.base, index: settings.default, shortcut: settings.shortcut, strings: settings.strings, browse: settings.browse, theme: settings.theme });

				if (hasCollections(settings)) injectRoute({ pattern: `/${RECORDS_PATH}`, entrypoint: new URL(`./records-route${OWN_EXT}`, import.meta.url), prerender: true });
				const modules: Record<string, string> = {
					[SPECS]: `export default ${JSON.stringify({ sources: routeSpecs(settings), urlOptions, defaultLocale, locales })};`,
					[ASSETS]: `export default ${JSON.stringify({ boot: bundle.boot.url, app: bundle.app.url, manifest: bundle.manifest, searchPage, index: settings.default, shortcut: settings.shortcut, browse: settings.browse, strings: settings.strings })};`,
				};
				updateConfig({
					vite: {
						plugins: [
							{
								name: "astronomic-search",
								resolveId: (id: string) => (id in modules ? `\0${id}` : undefined),
								load: (id: string) => (id.startsWith("\0") ? modules[id.slice(1)] : undefined),
							},
						],
					},
				});
			},
			"astro:server:setup": ({ server, logger }) => {
				devMiddleware(server, { settings, bundle, engine, urlOptions, defaultLocale, logger });
			},
			"astro:build:done": async ({ dir, logger }) => {
				const out = fileURLToPath(dir);
				const recordsFile = join(out, RECORDS_PATH);
				let route: RouteData | null = null;
				if (hasCollections(settings)) {
					try {
						route = JSON.parse(await readFile(recordsFile, "utf8")) as RouteData;
					} catch {
						throw new Error(`Search: ${RECORDS_PATH} is missing from the build output; the records route did not run`);
					}
					await rm(recordsFile);
				}
				const byIndex = await collectRecords(settings, {
					route,
					scan: async (source) => (await scanHtml(out, source, { urlOptions, defaultLocale, locales })).records,
					urlOptions,
					defaultLocale,
					warn: (m) => logger.warn(m),
				});
				// Every result leads to a page: a collection's url pattern that misses its route, or a heading id the page
				// does not render, fails the build. With output "server" a page may be rendered on demand, so it warns.
				// (Dev has no build output, so the dev server does not check.)
				const notBuilt = await builtPageProblems(byIndex, out, urlOptions);
				if (notBuilt.length > 0 && onDemand) for (const p of notBuilt) logger.warn(`${p} (it may be rendered on demand)`);
				else if (notBuilt.length > 0) {
					const shown = notBuilt.slice(0, 20).map((p) => `  - ${p.replace(/^Search: /, "")}`).join("\n");
					throw new Error(`Search: ${notBuilt.length} record URL(s) are not built pages:\n${shown}${notBuilt.length > 20 ? `\n  ... and ${notBuilt.length - 20} more` : ""}`);
				}
				const written = writeIndexes(byIndex, settings, engine, { base: urlOptions.base, defaultLocale, urlOptions });
				for (const w of written.warnings) logger.warn(w);
				const folder = join(out, "_search");
				await mkdir(folder, { recursive: true });
				for (const f of written.files) await writeFile(safePath(folder, f.name), f.body);
				await writeFile(safePath(folder, MANIFEST), JSON.stringify(written.manifest));
				for (const s of [bundle.boot, bundle.app]) await writeFile(safePath(folder, s.name), s.code);
				for (const s of written.stats) {
					const { line, over } = statLine(s);
					if (over) logger.warn(line);
					else logger.info(line);
				}
				// A warning, not an error: the dialog works, only the no-JavaScript link and "See all results" lead nowhere.
				const missing = await searchPageWarning(out, searchPage);
				if (missing) logger.warn(missing);
			},
		},
	};
}
