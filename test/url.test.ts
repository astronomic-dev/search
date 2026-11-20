import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanUrl } from "../src/core/url.ts";

const never = { base: "/", trailingSlash: "never", format: "file", site: "https://astronomic.dev" } as const;
const always = { base: "/docs-site/", trailingSlash: "always", format: "directory", site: "https://example.com" } as const;

const cases: [string, typeof never | typeof always, string | null][] = [
	["/docs/vega/search.html", never, "/docs/vega/search"],
	["/docs/vega/search/", never, "/docs/vega/search"],
	["/docs/vega/index.html", never, "/docs/vega"],
	["/index.html", never, "/"],
	["/", never, "/"],
	["/pricing?ref=nav", never, "/pricing"],
	["/docs/vega/search#the-map", never, "/docs/vega/search#the-map"],
	["https://astronomic.dev/faq", never, "/faq"],
	["https://other.dev/faq", never, null], // another site: not ours
	["/docs//vega", never, "/docs/vega"],
	["/guide", always, "/docs-site/guide/"],
	["/docs-site/guide/index.html", always, "/docs-site/guide/"],
	["/docs-site/", always, "/docs-site/"],
];

for (const [input, opts, want] of cases) {
	test(`cleanUrl(${input}) with trailingSlash ${opts.trailingSlash}`, () => assert.equal(cleanUrl(input, opts), want));
}

test('trailingSlash "ignore" follows build.format', () => {
	assert.equal(cleanUrl("/a", { ...never, trailingSlash: "ignore", format: "directory" }), "/a/");
	assert.equal(cleanUrl("/a/", { ...never, trailingSlash: "ignore", format: "file" }), "/a");
});

test("an absolute same-site URL outside the base is not ours", () => {
	assert.equal(cleanUrl("https://example.com/other/", always), null);
	assert.equal(cleanUrl("https://example.com/docs-site/guide", always), "/docs-site/guide/");
	assert.equal(cleanUrl("https://example.com/docs-site", always), "/docs-site/");
});

test(".html and index are stripped in any case", () => {
	assert.equal(cleanUrl("/docs/vega/search.HTML", never), "/docs/vega/search");
	assert.equal(cleanUrl("/docs/vega/Index.HTML", never), "/docs/vega");
	assert.equal(cleanUrl("/INDEX.html", never), "/");
});
