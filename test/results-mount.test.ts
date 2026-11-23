import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prefetch } from "../src/controller/prefetch.ts";
import { historyStep, isPrettyEntry, pageQuery, startPicks } from "../src/page/history.ts";
import { allowedType, effectiveIndex, labelIds, prefetchFor } from "../src/results/mount.ts";

const wp = { query: "s", prefix: "z_" };

test("the history decision: a change replaces when the URL differs, a submit pushes when it differs from the last committed URL", () => {
	assert.equal(historyStep("change", "?s=a", "?s=a", ""), null);
	assert.equal(historyStep("change", "?s=ab", "?s=a", ""), "replace");
	// A submit of what was last committed adds nothing, even when a change replaced the entry since.
	assert.equal(historyStep("submit", "?s=a", "?s=a", "?s=a"), null);
	assert.equal(historyStep("submit", "?s=ab", "?s=ab", "?s=a"), "push");
	assert.equal(historyStep("submit", "?s=ab", "?s=a", ""), "push");
});

test("the pretty-URL rule: the server's query fills an entry with no query parameter only on the page's original entry", () => {
	// The URL's query wins, even an empty one.
	assert.equal(pageQuery("?s=docs", "foo", true, wp), "docs");
	assert.equal(pageQuery("?s=", "foo", true, wp), "");
	// No parameter: the server's query on the original entry, else empty.
	assert.equal(pageQuery("", "foo", true, wp), "foo");
	assert.equal(pageQuery("?z_type=docs", "foo", true, wp), "foo");
	assert.equal(pageQuery("", "foo", false, wp), "");
	assert.equal(pageQuery("", null, true, wp), "");
	// Another site's own vars are not the query.
	assert.equal(pageQuery("?q=docs", "foo", false, wp), "");
	assert.equal(pageQuery("?q=docs", null, false), "docs");
});

test("the effective index: the URL's, else the root's data-search-index, else the config's", () => {
	assert.equal(effectiveIndex("?z_index=main", "docs", "site", wp), "main");
	assert.equal(effectiveIndex("?index=main", "docs", "site", wp), "docs");
	assert.equal(effectiveIndex("", "docs", "site", wp), "docs");
	assert.equal(effectiveIndex("", "", "site", wp), "site");
	assert.equal(effectiveIndex("", null, "site"), "site");
	assert.equal(effectiveIndex("?index=main", null, "site"), "main");
});

test("the prefetch is used only for the effective index, manifest and locale", () => {
	const p = { index: "site", manifestUrl: "/_search/manifest.json" } as Prefetch;
	assert.equal(prefetchFor(p, "site", "/_search/manifest.json", "en"), p);
	assert.equal(prefetchFor(p, "main", "/_search/manifest.json", "en"), undefined);
	assert.equal(prefetchFor(p, "site", "/other/manifest.json", "en"), undefined);
	assert.equal(prefetchFor(undefined, "site", "/_search/manifest.json", "en"), undefined);
	// A prefetch that says its lang must match the page's (case and region aside: the file pick is checked again on load).
	const fr = { ...p, lang: "fr" };
	assert.equal(prefetchFor(fr, "site", "/_search/manifest.json", "en-US"), undefined);
	assert.equal(prefetchFor(fr, "site", "/_search/manifest.json", "FR"), fr);
});

test("an entry is pretty only when the server gave a query and the URL has no query parameter", () => {
	assert.equal(isPrettyEntry("", "vega", wp), true);
	assert.equal(isPrettyEntry("?z_type=docs", "vega", wp), true);
	// An explicit query parameter is never pretty, even the server's own query.
	assert.equal(isPrettyEntry("?s=vega", "vega", wp), false);
	assert.equal(isPrettyEntry("?s=", "vega", wp), false);
	assert.equal(isPrettyEntry("", null, wp), false);
	assert.equal(isPrettyEntry("", "  ", wp), false);
});

test("the first picks are read with the loaded facet names: a declared facet named like constructor stays, an unknown one goes", () => {
	const picks = startPicks("?z_constructor=a&z_theme=vega&z_campaign=x&tag=t", ["constructor", "theme"], wp);
	assert.deepEqual({ ...picks }, { constructor: ["a"], theme: ["vega"] });
});

test("a restored type must be one the index has and one the mount allows", () => {
	const index = { docs: {}, posts: {} };
	assert.equal(allowedType("docs", index, ["docs"]), true);
	assert.equal(allowedType("posts", index, ["docs"]), false);
	assert.equal(allowedType("posts", index, []), true);
	assert.equal(allowedType("nope", index, []), false);
	assert.equal(allowedType("toString", { docs: {} }, []), false);
	assert.equal(allowedType("docs", null, []), false);
});

test("the page's label ids: names that differ get different ids, even when one looks like the other's escape", () => {
	const idFor = labelIds(1);
	assert.notEqual(idFor("facet:a b"), idFor("facet:a_20b"));
	assert.notEqual(idFor("facet:a b"), idFor("facet:a-b"));
	assert.equal(idFor("facet:a b"), idFor("facet:a b"));
	assert.notEqual(labelIds(2)("facet:a b"), idFor("facet:a b"));
});
