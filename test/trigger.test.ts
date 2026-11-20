import { test } from "node:test";
import assert from "node:assert/strict";
import { triggerStart } from "../src/dom/trigger.ts";

/** An element stand-in with just the attributes. */
const el = (attrs: Record<string, string>) => ({
	getAttribute: (n: string) => (Object.hasOwn(attrs, n) ? attrs[n]! : null),
	hasAttribute: (n: string) => Object.hasOwn(attrs, n),
});

test("triggerStart: no starting attributes, no start (the dialog keeps its last search)", () => {
	assert.equal(triggerStart(el({ href: "/search", "data-search-index": "site" })), undefined);
});

test("triggerStart: the query alone, all types, no picks", () => {
	assert.deepEqual(triggerStart(el({ "data-search-query": "lodestr" })), { query: "lodestr", type: null, picks: {} });
});

test("triggerStart: type and filters in the search page's URL form, a name repeated for several values", () => {
	const start = triggerStart(el({ "data-search-query": "dark mode", "data-search-type": "docs", "data-search-filters": "theme=lodestar&theme=vega&theme=vega&mode=&size=a+b" }));
	assert.deepEqual(start, { query: "dark mode", type: "docs", picks: { theme: ["lodestar", "vega"], size: ["a b"] } });
});

test("triggerStart: an empty type is all types; a filter named like an Object.prototype key is an own key", () => {
	const start = triggerStart(el({ "data-search-type": "", "data-search-filters": "__proto__=x&constructor=y" }))!;
	assert.equal(start.query, "");
	assert.equal(start.type, null);
	assert.ok(Object.hasOwn(start.picks!, "__proto__"));
	assert.deepEqual(start.picks!["constructor"], ["y"]);
	assert.equal(Object.getPrototypeOf(start.picks), Object.prototype);
});
