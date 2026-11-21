/**
 * Bundles one browser entry (a file path) to minified ES2022, leaving `__ASTRONOMIC_SEARCH__` free for `fill`.
 * Build-only tooling, never in dist/: scripts/build.mjs calls it to write dist/browser/*.bundle.js, and the
 * integration calls it from src/ (this repo and its tests). esbuild is a dev dependency, loaded only here.
 */
import { build } from "esbuild";

/** @param {string} file @returns {Promise<string>} */
export async function compileEntry(file) {
	const out = await build({ entryPoints: [file], bundle: true, format: "esm", minify: true, target: "es2022", write: false, logLevel: "error" });
	return out.outputFiles[0]?.text ?? "";
}
