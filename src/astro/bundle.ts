/**
 * The browser scripts as hashed files, made once when the integration starts, so their names are known before any
 * page renders. Shipped as files, never inline, so a strict CSP works. The boot script imports the app by its URL.
 *
 * The scripts are bundled when the package is built (scripts/build.mjs writes dist/browser/*.bundle.js), so a site
 * installs no bundler: the integration only puts the site's settings in. Each bundle reads them from the free name
 * `__ASTRONOMIC_SEARCH__`, which `fill` replaces with a JSON literal. From src/ (this repo and its tests) the
 * scripts are bundled on the fly by scripts/compile.mjs (esbuild, a dev dependency), which dist/ never imports.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mergeStrings, type StringsInput } from "../controller/strings.ts";
import { hash10, searchDir, type BrowseLink } from "./build.ts";

/** The extension of this package's own files: ".ts" from src/ (the repo and its tests), ".js" from dist/ (an install). */
export const OWN_EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

/** The name each bundle reads its settings from; `fill` replaces it. */
export const CONFIG_NAME = "__ASTRONOMIC_SEARCH__";

/** The browser entries in src/browser/ that become scripts. */
export const ENTRIES = ["app", "boot"] as const;
export type Entry = (typeof ENTRIES)[number];

export interface Script {
	/** File name in the `_search` folder. */
	name: string;
	/** The URL, base applied. */
	url: string;
	code: string;
}

export interface Bundle {
	boot: Script;
	app: Script;
	manifest: string;
}

export interface BundleOptions {
	base: string;
	index: string;
	shortcut: { keys: string[] } | false;
	strings: StringsInput;
	browse: BrowseLink[];
	theme?: "light" | "dark";
	/** The site's search page (searchPageUrl): a touch open that fails takes the typed text there as `q`. */
	searchPage?: string;
}

/** The manifest's name never changes (it is what names the hashed files); every other file is hashed. */
export const MANIFEST = "manifest.json";

/**
 * The build-only bundler (scripts/compile.mjs), for src/ only. Its path is a variable, so no bundler that reads the
 * installed dist/ tries to resolve it (or esbuild): an install has no scripts/ folder and never takes this path.
 */
const DEV_COMPILER = "../../scripts/compile.mjs";

/** The bundle of one entry, before its settings go in: prebuilt in dist/, bundled on the fly from src/. */
async function raw(entry: Entry): Promise<string> {
	if (OWN_EXT === ".js") return readFile(new URL(`../browser/${entry}.bundle.js`, import.meta.url), "utf8");
	const { compileEntry } = (await import(new URL(DEV_COMPILER, import.meta.url).href)) as { compileEntry: (file: string) => Promise<string> };
	return compileEntry(fileURLToPath(new URL(`../browser/${entry}.ts`, import.meta.url)));
}

/** Puts the settings into a bundle: every use of `__ASTRONOMIC_SEARCH__` becomes the settings as a JSON literal. */
export function fill(code: string, config: object): string {
	const literal = `(${JSON.stringify(config)})`;
	const pattern = new RegExp(`\\b${CONFIG_NAME}\\b`, "g");
	if (!pattern.test(code)) throw new Error(`Search: a browser script does not read ${CONFIG_NAME}; rebuild the package`);
	// A function, so a "$" in the settings is never read as a replacement pattern.
	return code.replace(pattern, () => literal);
}

export async function bundleScripts(options: BundleOptions): Promise<Bundle> {
	const dir = searchDir(options.base);
	const manifest = dir + MANIFEST;
	const script = (kind: string, code: string): Script => {
		const name = `${kind}.${hash10(code)}.js`;
		return { name, url: dir + name, code };
	};
	const [appRaw, bootRaw] = await Promise.all([raw("app"), raw("boot")]);
	const app = script("app", fill(appRaw, { manifest, index: options.index, strings: options.strings, browse: options.browse, theme: options.theme }));
	const boot = script("boot", fill(bootRaw, { app: app.url, manifest, index: options.index, shortcut: options.shortcut, placeholder: mergeStrings(options.strings).placeholder, search: options.searchPage, theme: options.theme }));
	return { boot, app, manifest };
}
