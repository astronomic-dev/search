/**
 * The browser scripts as hashed files, built once when the integration starts, so their names are known before any
 * page renders. Shipped as files, never inline, so a strict CSP works. The boot script imports the app by its URL.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { StringsInput } from "../controller/strings.ts";
import { hash10, searchDir, type BrowseLink } from "./build.ts";

/** The extension of this package's own files: ".ts" from src/ (the repo and its tests), ".js" from dist/ (an install). */
export const OWN_EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

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
}

/** The manifest's name never changes (it is what names the hashed files); every other file is hashed. */
export const MANIFEST = "manifest.json";

async function one(entry: string, define: object): Promise<string> {
	const out = await build({
		entryPoints: [fileURLToPath(new URL(`../browser/${entry}${OWN_EXT}`, import.meta.url))],
		bundle: true,
		format: "esm",
		minify: true,
		target: "es2022",
		write: false,
		logLevel: "error",
		define: { __ASTRONOMIC_SEARCH__: JSON.stringify(define) },
	});
	return out.outputFiles[0]?.text ?? "";
}

export async function bundleScripts(options: BundleOptions): Promise<Bundle> {
	const dir = searchDir(options.base);
	const manifest = dir + MANIFEST;
	const script = (kind: string, code: string): Script => {
		const name = `${kind}.${hash10(code)}.js`;
		return { name, url: dir + name, code };
	};
	const app = script("app", await one("app", { manifest, index: options.index, strings: options.strings, browse: options.browse }));
	const boot = script("boot", await one("boot", { app: app.url, manifest, index: options.index, shortcut: options.shortcut }));
	return { boot, app, manifest };
}
