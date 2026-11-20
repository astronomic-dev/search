import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRecord, checkRecords } from "../src/core/schema.ts";
import type { SearchRecord } from "../src/core/types.ts";
import type { UrlOptions } from "../src/core/url.ts";

const opts: UrlOptions = { base: "/", trailingSlash: "always", format: "directory", site: "https://example.com" };

// The design doc's example record.
const example: SearchRecord = {
	id: "en:/docs/lodestar/theming/#dark-mode",
	kind: "heading",
	pageId: "en:/docs/lodestar/theming/",
	locale: "en",
	type: "docs",
	url: "/docs/lodestar/theming/#dark-mode",
	title: "Theming",
	heading: "Dark mode",
	text: "…only this section's text…",
	facets: { theme: ["Lodestar"] },
	source: "collection",
};
const page: SearchRecord = { id: "en:/docs/lodestar/theming/", kind: "page", locale: "en", type: "docs", url: "/docs/lodestar/theming/", title: "Theming", text: "", facets: {}, source: "collection" };
const ORIGIN = "src/content/docs/lodestar/theming.md";

const faults = (r: unknown) => checkRecord(r, ORIGIN, opts);

test("accepts the design doc's example record and a page", () => {
	assert.deepEqual(faults(example), []);
	assert.deepEqual(faults(page), []);
});

test("accepts a page with owner keywords", () => {
	assert.deepEqual(faults({ ...page, keywords: ["start", "guide"] }), []);
});

test("accepts an action with a command and no url", () => {
	assert.deepEqual(faults({ id: "en:toggle-theme", kind: "action", locale: "en", type: "actions", title: "Dark mode", text: "", facets: {}, source: "hook", command: "toggle-theme" }), []);
});

const bad: [string, Record<string, unknown>, string][] = [
	["missing id", { ...example, id: undefined }, "id"],
	['kind "section"', { ...example, kind: "section" }, "kind"],
	["a heading with no pageId", { ...example, pageId: undefined }, "pageId"],
	["a page with a pageId", { ...page, pageId: "en:/x/" }, "pageId"],
	["a facet value that is a string", { ...example, facets: { theme: "Lodestar" } }, "facets.theme"],
	["an id that is not locale:url", { ...example, id: "en:/docs/lodestar/theming/#light" }, "id"],
	["an action with neither url nor command", { id: "en:x", kind: "action", locale: "en", type: "actions", title: "X", text: "", facets: {}, source: "hook" }, "command"],
	["a heading whose pageId is not its page's id", { ...example, pageId: "en:/docs/lodestar/other/" }, "pageId"],
	["a heading url with no anchor", { ...example, id: "en:/docs/lodestar/theming/", url: "/docs/lodestar/theming/", pageId: "en:/docs/lodestar/theming/" }, "url"],
	["an empty facet value", { ...example, facets: { theme: [""] } }, "facets.theme"],
	["keywords on a heading", { ...example, keywords: ["start"] }, "keywords"],
	["an empty keyword", { ...page, keywords: ["start", ""] }, "keywords"],
	["keywords that are a string", { ...page, keywords: "start" }, "keywords"],
	["a heading with no heading", { ...example, heading: undefined }, "heading"],
	["a heading with an empty heading", { ...example, heading: "" }, "heading"],
	["a heading on a page", { ...page, heading: "Intro" }, "heading"],
	["a heading on an action", { id: "en:x", kind: "action", locale: "en", type: "actions", title: "X", text: "", facets: {}, source: "hook", command: "x", heading: "X" }, "heading"],
	["a command on a page", { ...page, command: "toggle-theme" }, "command"],
	["a command on a heading", { ...example, command: "toggle-theme" }, "command"],
	["a url that cleanUrl would change", { ...page, id: "en:/docs/lodestar/theming", url: "/docs/lodestar/theming" }, "url"],
];

for (const [name, record, field] of bad) {
	test(`rejects ${name}`, () => {
		const got = faults(record);
		assert.ok(got.length > 0, "expected a fault");
		assert.ok(got.some((f) => f.includes(field)), `a fault names ${field}: ${got.join("; ")}`);
		assert.ok(got.every((f) => f.includes(ORIGIN)), "every fault names the origin");
	});
}

test("checkRecords throws one error listing every fault, at most 20", () => {
	assert.doesNotThrow(() => checkRecords([{ record: example, origin: "a" }, { record: page, origin: "b" }], opts));
	const many = Array.from({ length: 30 }, (_, i) => ({ record: { ...page, kind: "section" } as unknown as SearchRecord, origin: `file-${i}.md` }));
	assert.throws(
		() => checkRecords(many, opts),
		(e: Error) => {
			assert.ok(e.message.includes("file-0.md") && e.message.includes("file-19.md"));
			assert.ok(!e.message.includes("file-20.md"));
			assert.match(e.message, /30/);
			return true;
		},
	);
});

test("a locale must be a BCP 47 tag, so it is safe in a file name", async () => {
	const { checkRecord } = await import("../src/core/schema.ts");
	const o = { base: "/", trailingSlash: "never", format: "directory" } as const;
	const r = (locale: string) => ({ id: `${locale}:/a`, kind: "page", locale, type: "docs", url: "/a", title: "A", text: "", facets: {}, source: "hook" });
	for (const ok of ["en", "de", "pt-BR", "zh-Hant-TW"]) assert.deepEqual(checkRecord(r(ok), "x", o), [], ok);
	for (const bad of ["../../x", "en/../x", "e", "en_US", "en-", "a b"]) assert.ok(checkRecord(r(bad), "x", o).some((f) => /locale/.test(f)), bad);
});
