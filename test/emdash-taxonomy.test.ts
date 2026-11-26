/** `taxonomyKeywords`: the labels of an entry's terms as keywords of its record. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchRecord } from "../src/core/types.ts";
import type { PluginOptions, TermsPort, UrlRules } from "../src/emdash/core/ports.ts";
import { checkTaxonomyKeywords, collectRecords } from "../src/emdash/core/records.ts";
import { collection, createFakeContent, entry, type FakeContentInput } from "./emdash/fake-content.ts";

const OPTIONS: PluginOptions = { taxonomyKeywords: ["category", "tag"] };
const I18N: UrlRules = { siteLocale: "en", i18n: { defaultLocale: "en", locales: ["en", "fr", { path: "portugues", codes: ["pt-BR"] }] } };

interface Call {
	collection: string;
	ids: string[];
	locale: string;
}

/** Terms by entry id; every call is logged. `fail`: the error the nth call (from 0) throws. */
function fakeTerms(byId: Record<string, Record<string, string[]>>, fail?: (n: number) => Error | null) {
	const calls: Call[] = [];
	const terms: TermsPort = {
		async labels(c, ids, locale) {
			calls.push({ collection: c, ids: [...ids], locale });
			const error = fail?.(calls.length - 1);
			if (error) throw error;
			return new Map(ids.filter((id) => byId[id]).map((id) => [id, byId[id]]));
		},
	};
	return { terms, calls };
}

async function run(input: FakeContentInput, options: PluginOptions, terms?: TermsPort) {
	const fake = createFakeContent({ collections: [collection("posts")], urlRules: { siteLocale: "en", i18n: null }, ...input });
	const out = await collectRecords({ content: fake.content, schema: fake.schema, ...(terms ? { terms } : {}) }, options);
	return { ...out, fake, records: Object.values(out.byLocale).flat() };
}
const keywords = (records: SearchRecord[]) => Object.fromEntries(records.map((r) => [r.url, r.keywords]));

test("taxonomyKeywords: the labels come after the entry's own keywords, in the option's order, with no duplicates", async () => {
	const { terms } = fakeTerms({
		a: { tag: ["Photography", "Field  notes", "Essay"], category: ["Café", "Notes"], series: ["Not asked for"] },
		b: { category: ["", " "] },
	});
	const entries = [
		entry("posts", "a", { id: "a", data: { title: "A", search_keywords: ["photography", "Own"] } }),
		entry("posts", "b", { id: "b" }),
		entry("posts", "c", { id: "c" }),
	];
	const { records, warnings } = await run({ entries }, OPTIONS, terms);
	assert.deepEqual(keywords(records), { "/posts/a": ["photography", "Own", "Café", "Notes", "Field notes", "Essay"], "/posts/b": undefined, "/posts/c": undefined });
	assert.equal(records.some((r) => "keywords" in r && r.keywords === undefined), false);
	assert.deepEqual(warnings, []);
	const one = await run({ entries: entries.map((e) => structuredClone(e)) }, { taxonomyKeywords: ["category"] }, terms);
	assert.deepEqual(keywords(one.records)["/posts/a"], ["photography", "Own", "Café", "Notes"]);
});

test("taxonomyKeywords: one read per list page, collection and locale, of the entries that get a record", async () => {
	const { terms, calls } = fakeTerms({});
	const posts = [
		entry("posts", "1", { id: "p1", locale: "en" }), entry("posts", "2", { id: "p2", locale: "fr" }), entry("posts", "3", { id: "p3" }), entry("posts", "4", { id: "p4", locale: "portugues" }),
		entry("posts", "5", { id: "p5", locale: "en" }), entry("posts", "draft", { id: "p6", status: "draft" }), entry("posts", "out", { id: "p7" }), entry("posts", "no", { id: "p8", seo: { noIndex: true } }),
		entry("posts", "draft2", { id: "p9", status: "draft" }),
	];
	const talks = { ...collection("talks"), supports: [], routable: false };
	await run(
		{ collections: [collection("posts"), collection("docs"), talks], entries: [...posts, entry("docs", "d", { id: "d1", locale: "en" }), entry("talks", "t", { id: "t1" })], urlRules: I18N, pageSize: 4 },
		{ ...OPTIONS, exclude: ["/posts/out"], listPages: [{ path: "/talks", from: [{ collection: "talks", fields: ["title"] }] }] },
		terms,
	);
	assert.deepEqual(calls, [
		{ collection: "posts", ids: ["p1", "p3"], locale: "en" },
		{ collection: "posts", ids: ["p2"], locale: "fr" },
		{ collection: "posts", ids: ["p4"], locale: "portugues" },
		{ collection: "posts", ids: ["p5"], locale: "en" },
		{ collection: "docs", ids: ["d1"], locale: "en" },
	]);
});

test("taxonomyKeywords: a failed read is one warning; the build goes on without more terms", async () => {
	const { terms, calls } = fakeTerms({ a: { tag: ["One"] }, b: { tag: ["Two"] }, c: { tag: ["Three"] } }, (n) => (n === 1 ? new Error("no such table") : null));
	const { records, warnings } = await run({ entries: ["a", "b", "c"].map((id) => entry("posts", id, { id })), pageSize: 1 }, OPTIONS, terms);
	assert.deepEqual(keywords(records), { "/posts/a": ["One"], "/posts/b": undefined, "/posts/c": undefined });
	assert.equal(calls.length, 2);
	assert.deepEqual(warnings, ["Search: taxonomyKeywords: the terms could not be read (no such table); the rest of this build goes on without them, and the next build tries again"]);
});

test("taxonomyKeywords: no port to read terms is a warning, not a failure", async () => {
	const { records, warnings } = await run({ entries: [entry("posts", "a")] }, OPTIONS);
	assert.equal(records.length, 1);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /taxonomyKeywords: the terms could not be read/);
});

test("without taxonomyKeywords no terms are read and the records are the same", async () => {
	const { terms, calls } = fakeTerms({ a: { tag: ["One"] } });
	for (const options of [{}, { taxonomyKeywords: [] }]) {
		const { records, warnings } = await run({ entries: [entry("posts", "a", { id: "a" })] }, options, terms);
		assert.deepEqual(records.map((r) => r.keywords), [undefined]);
		assert.deepEqual([calls, warnings], [[], []]);
	}
});

test("taxonomyKeywords: a list page's own entry gets its terms; the items' terms are not read", async () => {
	const pages = collection("pages", { urlPattern: "/{slug}" });
	const { terms } = fakeTerms({ p: { tag: ["Own"] }, t: { tag: ["Item"] } });
	const { records } = await run(
		{ collections: [pages, collection("talks", { supports: [] })], entries: [entry("pages", "speaking", { id: "p" }), entry("talks", "t", { id: "t", data: { title: "Megabytes" } })] },
		{ ...OPTIONS, listPages: [{ path: "/speaking", from: [{ collection: "talks", fields: ["title"] }] }] },
		terms,
	);
	assert.deepEqual(records.map((r) => [r.text, r.keywords]), [["Megabytes", ["Own"]]]);
});

test("checkTaxonomyKeywords takes a list of taxonomy names", () => {
	checkTaxonomyKeywords([]);
	checkTaxonomyKeywords(["category", "tag"]);
	for (const bad of [true, "tag", null, {}, ["tag", 3], [""], ["tag", " "]]) {
		assert.throws(() => checkTaxonomyKeywords(bad), /^Error: Search: search\(\): taxonomyKeywords must be a list of taxonomy names \(\["category", "tag"\]\), not /, JSON.stringify(bad));
	}
});
