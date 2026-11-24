/**
 * Bundles one browser entry (a file path) to minified ES2022, its stylesheets minified too (minifyCss), leaving
 * `__ASTRONOMIC_SEARCH__` free for `fill`.
 * Build-only tooling, never in dist/: scripts/build.mjs calls it to write dist/browser/*.bundle.js, and the
 * integration calls it from src/ (this repo and its tests). esbuild is a dev dependency, loaded only here.
 */
import { readFileSync } from "node:fs";
import { build, transform } from "esbuild";

/**
 * Minifies each stylesheet a source marks with a `/* css *\/` template literal (one with no `${`, backtick or
 * backslash), which esbuild leaves as written. The Astro entries and the embed build both use it.
 * @type {import("esbuild").Plugin}
 */
export const minifyCss = {
	name: "minify-css",
	setup(b) {
		b.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
			const source = readFileSync(path, "utf8");
			if (!source.includes("/* css */")) return undefined;
			let contents = source;
			for (const [whole, css] of source.matchAll(/\/\* css \*\/ `([^`$\\]*)`/g)) {
				const min = (await transform(css, { loader: "css", minify: true })).code.trim();
				if (/[`$\\]/.test(min)) throw new Error(`compile: a minified stylesheet in ${path} needs escaping`);
				contents = contents.replace(whole, `\`${min}\``);
			}
			return { contents, loader: "ts" };
		});
	},
};

/** @param {string} file @returns {Promise<string>} */
export async function compileEntry(file) {
	const out = await build({ entryPoints: [file], bundle: true, format: "esm", minify: true, target: "es2022", write: false, logLevel: "error", plugins: [minifyCss] });
	return out.outputFiles[0]?.text ?? "";
}

/** What EmDash's admin provides: the admin bundle leaves these to the site's own copies. */
export const ADMIN_EXTERNAL = ["react", "react/jsx-runtime", "react-dom", "@cloudflare/kumo", "@phosphor-icons/react", "emdash", "emdash/*"];

/**
 * Bundles the plugin's admin page (src/emdash/admin/index.tsx) to dist/emdash/admin/index.js: our own code only,
 * minified, with React, kumo, phosphor and emdash external (plan decision 14).
 * @param {string} file @returns {Promise<string>}
 */
export async function compileAdmin(file) {
	const out = await build({ entryPoints: [file], bundle: true, format: "esm", minify: true, target: "es2022", jsx: "automatic", external: ADMIN_EXTERNAL, write: false, logLevel: "error" });
	return out.outputFiles[0]?.text ?? "";
}
