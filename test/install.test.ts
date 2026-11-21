/**
 * A site installs this package with no approve step: pnpm 11 stops an install (ERR_PNPM_IGNORED_BUILDS) on a
 * dependency with an install script, such as esbuild. So no runtime dependency may have one, and the browser scripts
 * ship bundled in dist/ with their settings put in by `fill`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fill } from "../src/astro/bundle.ts";

const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };

/** A dependency's package.json, from this package's node_modules (some do not export "./package.json"). */
const manifestOf = (name: string) => JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")) as { scripts?: Record<string, string> };

test("no runtime dependency has an install script (pnpm 11 would stop the install)", () => {
	assert.equal(own.dependencies.esbuild, undefined, "esbuild is a dev dependency only");
	for (const name of Object.keys(own.dependencies)) {
		const scripts = manifestOf(name).scripts ?? {};
		for (const hook of ["preinstall", "install", "postinstall"]) assert.equal(scripts[hook], undefined, `${name} has a ${hook} script`);
	}
});

test("fill puts the settings in every use of __ASTRONOMIC_SEARCH__, as a JSON literal", () => {
	const code = "const a=__ASTRONOMIC_SEARCH__;const{b}=__ASTRONOMIC_SEARCH__;";
	const out = fill(code, { b: "/docs", strings: { noResults: "None for $& or $1" } });
	assert.equal(out, 'const a=({"b":"/docs","strings":{"noResults":"None for $& or $1"}});const{b}=({"b":"/docs","strings":{"noResults":"None for $& or $1"}});');
	assert.equal(new Function(`${out.replace("const{b}=", "const{b:c}=")} return [a.b, c];`)().join(), "/docs,/docs");
});

test("fill fails on a script that does not read the settings", () => {
	assert.throws(() => fill("console.log(1)", {}), /does not read __ASTRONOMIC_SEARCH__/);
});
