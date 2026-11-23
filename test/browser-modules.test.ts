import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (name: string) => readFileSync(new URL(`../src/browser/${name}`, import.meta.url), "utf8");

/** The source with every `{ … }` block's contents removed, so only top-level statements are left. */
function topLevel(code: string): string {
	let depth = 0;
	let out = "";
	for (const ch of code) {
		if (ch === "}") depth--;
		if (depth === 0) out += ch;
		if (ch === "{") depth++;
	}
	return out;
}

test("start-app.ts has no top-level side effects and never names __ASTRONOMIC_SEARCH__", () => {
	const code = source("start-app.ts");
	assert.doesNotMatch(code, /__ASTRONOMIC_SEARCH__/);
	assert.doesNotMatch(topLevel(code), /defineSearchElement\(/);
	assert.doesNotMatch(topLevel(code), /addEventListener\(/);
});

test("app.ts still exports usePrefetch, prepare and open", () => {
	assert.match(source("app.ts"), /export const \{ usePrefetch, prepare, open \}/);
});
