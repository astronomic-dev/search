/**
 * Builds dist/, what npm users get: JavaScript and type files from src/ (tsc), the two Astro components and the
 * virtual module types. tsc rewrites relative ".ts" imports in JavaScript only; this script points the type files
 * and the components at the ".js" files too, then checks that no ".ts" specifier is left.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const dist = join(pkg, "dist");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

/** A relative ".ts" specifier after `from`, `import` or `import(` (not ".d.ts"). */
const TS_SPEC = /((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+?)(?<!\.d)\.ts(["'])/g;
const toJs = (text) => text.replace(TS_SPEC, "$1$2.js$3");

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: pkg, stdio: "inherit" });
for (const name of readdirSync(join(pkg, "src/astro")).filter((f) => f.endsWith(".astro"))) {
	writeFileSync(join(dist, "astro", name), toJs(readFileSync(join(pkg, "src/astro", name), "utf8")));
}
copyFileSync(join(pkg, "src/astro/virtual.d.ts"), join(dist, "astro/virtual.d.ts"));

const left = [];
for (const rel of readdirSync(dist, { recursive: true })) {
	const file = join(dist, rel);
	if (!/\.(js|d\.ts|astro)$/.test(file)) continue;
	let text = readFileSync(file, "utf8");
	if (file.endsWith(".d.ts")) writeFileSync(file, (text = toJs(text)));
	TS_SPEC.lastIndex = 0;
	if (TS_SPEC.test(text)) left.push(rel);
}
if (left.length) throw new Error(`build: relative .ts imports left in dist/:\n  ${left.join("\n  ")}`);
