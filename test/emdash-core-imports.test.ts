import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const core = fileURLToPath(new URL("../src/emdash/core/", import.meta.url));
/** Every module specifier: static and type imports, re-exports, dynamic import() and require(). */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
const BANNED = /^(?:emdash(?:\/|$)|@emdash-cms\/|node:|react(?:\/|$)|react-dom(?:\/|$)|astro(?:\/|$)|@astrojs\/)/;

test("src/emdash/core imports nothing from emdash, node, react or astro", () => {
	const files = readdirSync(core, { recursive: true }).map(String).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f));
	assert.ok(files.length >= 7, `found ${files.length} core files`);
	const bad: string[] = [];
	for (const f of files) {
		for (const m of readFileSync(join(core, f), "utf8").matchAll(SPECIFIER)) if (BANNED.test(m[1]!)) bad.push(`${f}: ${m[1]}`);
	}
	assert.deepEqual(bad, []);
});

test("the import check catches each banned kind", () => {
	const sample = `import { a } from "emdash";\nimport type { B } from "astro";\nconst x = await import("node:fs");\nexport * from "react";`;
	const found = [...sample.matchAll(SPECIFIER)].map((m) => m[1]!).filter((s) => BANNED.test(s));
	assert.deepEqual(found, ["emdash", "astro", "node:fs", "react"]);
});
