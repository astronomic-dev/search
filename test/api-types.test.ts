/**
 * Compile-time checks of the public types: the type check (tsc) fails on a wrong line here. The runtime asserts only
 * keep the values used.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { records, type SearchOptions } from "../src/astro/index.ts";
import { normalizeSettings } from "../src/astro/build.ts";
import type { BundleOptions } from "../src/astro/bundle.ts";
import type { SearchRecord } from "../src/core/types.ts";

test("search() takes nested string overrides, as the docs show", () => {
	const options: SearchOptions = { sources: [], strings: { placeholder: "Find", results: { one: "1 hit" }, keys: { close: "to shut" } } };
	// @ts-expect-error a label that does not exist
	const wrong: SearchOptions = { sources: [], strings: { nope: "x" } };
	// @ts-expect-error results takes its plural forms, not a string
	const flat: SearchOptions = { sources: [], strings: { results: "hits" } };
	// @ts-expect-error a theme is light or dark
	const auto: SearchOptions = { sources: [], theme: "auto" };
	const bundle: BundleOptions["strings"] = normalizeSettings({ sources: [records(() => [])], strings: options.strings }).strings;
	assert.equal(bundle.results?.one, "1 hit");
	assert.ok(wrong && flat && auto);
});

test("a record's fields follow its kind", () => {
	const base = { locale: "en", type: "docs", title: "Theming", text: "", facets: {}, source: "collection" } as const;
	const page: SearchRecord = { ...base, id: "en:/t/", kind: "page", url: "/t/", keywords: ["start"] };
	const heading: SearchRecord = { ...base, id: "en:/t/#a", kind: "heading", pageId: "en:/t/", url: "/t/#a", heading: "A" };
	const action: SearchRecord = { ...base, id: "en:dark", kind: "action", command: "dark" };
	// @ts-expect-error a heading needs its heading
	const noHeading: SearchRecord = { ...base, id: "en:/t/#a", kind: "heading", pageId: "en:/t/", url: "/t/#a" };
	// @ts-expect-error only a heading has a heading
	const pageHeading: SearchRecord = { ...base, id: "en:/t/", kind: "page", url: "/t/", heading: "A" };
	// @ts-expect-error only an action has a command
	const pageCommand: SearchRecord = { ...base, id: "en:/t/", kind: "page", url: "/t/", command: "dark" };
	if (heading.kind === "heading") assert.equal(heading.heading.length, 1);
	assert.ok(page && action && noHeading && pageHeading && pageCommand);
});

test("the boot's touch helper: a view's show returns a field or null, and openTouch is optional", async () => {
	const { touchOpens } = await import("../src/browser/start.ts");
	type Boot = import("../src/browser/start.ts").BootApp;
	type View = import("../src/browser/start.ts").TouchView;
	const view: View = { show: () => null };
	// @ts-expect-error show returns the field, or null
	const wrong: View = { show: () => undefined };
	const plain: Boot = { prepare: () => {} };
	const app: Boot = { prepare: () => {}, openTouch: (_t, d) => d.changed && d.value.length > 0 && d.start === d.end };
	// @ts-expect-error openTouch says if the input took the focus
	const silent: Boot = { prepare: () => {}, openTouch: () => {} };
	assert.equal(typeof touchOpens, "function");
	assert.ok(view && wrong && plain && app && silent);
});
