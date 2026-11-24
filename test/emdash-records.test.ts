import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRecords } from "../src/core/schema.ts";
import type { PageRecord, SearchRecord } from "../src/core/types.ts";
import { pickLocale } from "../src/controller/load.ts";
import { SCHEMA, type Manifest } from "../src/core/types.ts";
import type { PluginOptions, UrlRules } from "../src/emdash/core/ports.ts";
import { collectRecords, indexLocale, keywordList, portableTextToPlain, searchCollections } from "../src/emdash/core/records.ts";
import { collection, createFakeContent, entry, portableText, type FakeContentInput } from "./emdash/fake-content.ts";

const collect = (input: FakeContentInput, options: PluginOptions = {}) => {
	const fake = createFakeContent(input);
	return collectRecords({ content: fake.content, schema: fake.schema }, options);
};
const all = (byLocale: Record<string, SearchRecord[]>) => Object.values(byLocale).flat();
const only = (byLocale: Record<string, SearchRecord[]>): PageRecord => {
	const records = all(byLocale);
	assert.equal(records.length, 1, `one record, got ${records.length}`);
	return records[0] as PageRecord;
};

test("a published post gives one page record that passes checkRecords", async () => {
	const hello = entry("posts", "hello", { data: { title: "Hello world", content: portableText("First paragraph.", "Second one.") } });
	const out = await collect({ collections: [collection("posts")], entries: [hello] });
	const r = only(out.byLocale);
	assert.deepEqual(r, { id: "en:/posts/hello", kind: "page", locale: "en", type: "posts", url: "/posts/hello", title: "Hello world", text: "First paragraph. Second one.", facets: {}, source: "emdash" });
	assert.deepEqual(Object.keys(out.byLocale), ["en"]);
	assert.deepEqual(out.types, { posts: { label: "Posts" } });
	assert.equal(out.skipped, 0);
	checkRecords([{ record: r, origin: "test" }], { base: "/", trailingSlash: "never", format: "directory" });
});

test("drafts, scheduled entries and seo.noIndex give no record, and are not counted as skipped", async () => {
	const fake = createFakeContent({
		collections: [collection("posts")],
		entries: [
			entry("posts", "draft", { status: "draft" }),
			entry("posts", "later", { status: "scheduled", scheduledAt: "2099-01-01T00:00:00Z" }),
			entry("posts", "hidden", { seo: { noIndex: true } }),
			entry("posts", "shown", { seo: { noIndex: false } }),
		],
	});
	const out = await collectRecords({ content: fake.content, schema: fake.schema }, {});
	assert.deepEqual(all(out.byLocale).map((r) => r.url), ["/posts/shown"]);
	assert.equal(out.skipped, 0);
	// No URL lookup for an entry that is skipped anyway (each one costs queries on D1).
	assert.equal(fake.calls.filter((c) => c.op === "publicPath").length, 1);
});

test("the URL is publicPath's, kept as given; null skips the entry and counts it", async () => {
	const a = entry("posts", "café");
	const b = entry("posts", "slashed");
	const c = entry("posts", "nowhere");
	const d = entry("posts", null);
	const out = await collect({ collections: [collection("posts")], entries: [a, b, c, d], paths: { [a.id]: "/fr/posts/caf%C3%A9", [b.id]: "/posts/slashed/", [c.id]: null } });
	const records = all(out.byLocale);
	assert.deepEqual(records.map((r) => r.url), ["/fr/posts/caf%C3%A9", "/posts/slashed/"]);
	assert.deepEqual(records.map((r) => r.id), ["en:/fr/posts/caf%C3%A9", "en:/posts/slashed/"]);
	assert.equal(out.skipped, 2);
});

test("a listed collection that is not routable gives no records and a warning", async () => {
	const fake = createFakeContent({
		collections: [collection("posts"), collection("authors", { routable: false, urlPattern: null })],
		entries: [entry("posts", "hello"), entry("authors", "ann")],
	});
	const out = await collectRecords({ content: fake.content, schema: fake.schema }, { collections: ["posts", "authors"] });
	assert.deepEqual(all(out.byLocale).map((r) => r.type), ["posts"]);
	assert.equal(out.warnings.length, 1);
	assert.match(out.warnings[0], /authors/);
	assert.match(out.warnings[0], /not routable/);
	assert.ok(!fake.calls.some((c) => c.op === "list" && c.collection === "authors"));
});

test("a listed collection that does not exist gives a warning", async () => {
	const out = await collect({ collections: [collection("posts")], entries: [entry("posts", "hello")] }, { collections: ["posts", "nope"] });
	assert.equal(all(out.byLocale).length, 1);
	assert.equal(out.warnings.length, 1);
	assert.match(out.warnings[0], /"nope"/);
});

test("the default collections: search in supports, routable and not hidden", async () => {
	const { collections } = await searchCollections(
		createFakeContent({
			collections: [collection("posts"), collection("pages", { supports: [] }), collection("authors", { routable: false }), collection("secret", { hidden: true })],
		}).schema,
		{},
	);
	assert.deepEqual(collections.map((c) => c.slug), ["posts"]);
});

test("a listed collection is indexed even without search in supports", async () => {
	const out = await collect({ collections: [collection("pages", { supports: [] })], entries: [entry("pages", "about")] }, { collections: ["pages"] });
	assert.deepEqual(all(out.byLocale).map((r) => r.url), ["/pages/about"]);
});

test("every page of a collection is read", async () => {
	const entries = Array.from({ length: 7 }, (_, i) => entry("posts", `p${i}`));
	const out = await collect({ collections: [collection("posts")], entries, pageSize: 3 });
	assert.equal(all(out.byLocale).length, 7);
});

test("excerpt order: excerpt, summary, description, seo.description, then Portable Text", async () => {
	const fields = { excerpt: "The excerpt.", summary: "The summary.", description: "The description." };
	const content = portableText("Body text.");
	const textOf = async (data: Record<string, unknown>, seoDescription?: string) => {
		const e = entry("posts", "x", { data: { title: "X", content, ...data }, ...(seoDescription ? { seo: { description: seoDescription } } : {}) });
		return only((await collect({ collections: [collection("posts")], entries: [e] })).byLocale).text;
	};
	assert.equal(await textOf(fields, "The seo."), "The excerpt. Body text.");
	assert.equal(await textOf({ summary: fields.summary, description: fields.description }, "The seo."), "The summary. Body text.");
	assert.equal(await textOf({ description: fields.description }, "The seo."), "The description. Body text.");
	assert.equal(await textOf({}, "The seo."), "The seo. Body text.");
	assert.equal(await textOf({ excerpt: "  " }), "Body text.");
});

test("searchKeywords as an array and as a comma list", async () => {
	const a = entry("posts", "a", { data: { title: "A", searchKeywords: ["start", " guide ", ""] } });
	const b = entry("posts", "b", { data: { title: "B", searchKeywords: "setup, install ,," } });
	const c = entry("posts", "c", { data: { title: "C" } });
	const records = all((await collect({ collections: [collection("posts")], entries: [a, b, c] })).byLocale) as PageRecord[];
	assert.deepEqual(records.map((r) => r.keywords), [["start", "guide"], ["setup", "install"], undefined]);
	assert.ok(!("keywords" in records[2]));
	assert.deepEqual(keywordList(42), []);
});

test("search_keywords (EmDash's lowercase field slug) is read, before the searchKeywords alias", async () => {
	const real = entry("docs", "boot-sizing", { data: { title: "Boot sizing", search_keywords: "fit, half sizes" } });
	const both = entry("docs", "both", { data: { title: "Both", search_keywords: ["lowercase"], searchKeywords: ["alias"] } });
	const records = all((await collect({ collections: [collection("docs")], entries: [real, both] })).byLocale) as PageRecord[];
	assert.deepEqual(records.map((r) => r.keywords), [["fit", "half sizes"], ["lowercase"]]);
});

test("the public path follows the collection's URL pattern, with the slug encoded", async () => {
	const e = entry("docs", "guía-de-tallas", { data: { title: "Guía de tallas" } });
	const r = only((await collect({ collections: [collection("docs", { urlPattern: "/guides/{slug}" })], entries: [e] })).byLocale);
	assert.equal(r.url, "/guides/gu%C3%ADa-de-tallas");
});

test("an h2 block gives no heading record, and its text is in the page text", async () => {
	const e = entry("posts", "guide", { data: { title: "Guide", content: portableText("Intro.", ["h2", "Setup steps"], "Run it.") } });
	const r = only((await collect({ collections: [collection("posts")], entries: [e] })).byLocale);
	assert.equal(r.kind, "page");
	assert.equal(r.text, "Intro. Setup steps Run it.");
});

test("Portable Text to plain text: every block, spans joined, other values ignored", () => {
	const blocks = [
		{ _type: "block", children: [{ _type: "span", text: "Hello " }, { _type: "span", text: "there." }] },
		{ _type: "image", asset: { _ref: "x" } },
		null,
		{ _type: "block", style: "h3", children: [{ _type: "span", text: "Next" }, { _type: "inline", value: 1 }] },
	];
	assert.equal(portableTextToPlain(blocks), "Hello there. Next");
	assert.equal(portableTextToPlain("plain string"), "");
	assert.equal(portableTextToPlain(undefined), "");
	// No length cap: the index keeps the whole text unless the clip option says otherwise.
	const long = "word ".repeat(400).trim();
	assert.equal(portableTextToPlain(portableText(long)), long);
});

test("the title: title, then name, then seo.title, then the slug", async () => {
	const titleOf = async (data: Record<string, unknown>, seoTitle?: string) => {
		const e = entry("posts", "the-slug", { data, ...(seoTitle ? { seo: { title: seoTitle } } : {}) });
		return only((await collect({ collections: [collection("posts")], entries: [e] })).byLocale).title;
	};
	assert.equal(await titleOf({ title: "  Real   title ", name: "Name" }), "Real title");
	assert.equal(await titleOf({ name: "Name" }, "Seo"), "Name");
	assert.equal(await titleOf({}, "Seo"), "Seo");
	assert.equal(await titleOf({}), "the-slug");
});

test("two locales give records with their own locale", async () => {
	const en = entry("posts", "hello", { locale: "en", data: { title: "Hello" } });
	const fr = entry("posts", "bonjour", { locale: "fr", data: { title: "Bonjour" } });
	const none = entry("posts", "plain", { locale: null, data: { title: "Plain" } });
	const out = await collect({ collections: [collection("posts")], entries: [en, fr, none], paths: { [fr.id]: "/fr/posts/bonjour" } });
	assert.deepEqual(Object.keys(out.byLocale).sort(), ["en", "fr"]);
	assert.deepEqual(out.byLocale.en.map((r) => r.id), ["en:/posts/hello", "en:/posts/plain"]);
	assert.deepEqual(out.byLocale.fr.map((r) => [r.id, r.locale]), [["fr:/fr/posts/bonjour", "fr"]]);
});

test("a site with another default locale puts null-locale entries there", async () => {
	const out = await collect({ collections: [collection("posts")], entries: [entry("posts", "hola")], defaultLocale: "es" });
	assert.deepEqual(all(out.byLocale).map((r) => r.id), ["es:/posts/hola"]);
});

test("the type label is the collection's label", async () => {
	const out = await collect({ collections: [collection("posts", { label: "Blog posts" }), collection("docs")], entries: [entry("posts", "a"), entry("docs", "b")] });
	assert.deepEqual(out.types, { docs: { label: "Docs" }, posts: { label: "Blog posts" } });
});

test("the collected types and records give the engine settings (shared indexSettings)", async () => {
	const { indexSettings } = await import("../src/core/index-settings.ts");
	const { DEFAULT_WEIGHTS } = await import("../src/core/minisearch.ts");
	const out = await collect({ collections: [collection("posts", { label: "Blog posts" })], entries: [entry("posts", "a")] });
	const settings = indexSettings({ weights: DEFAULT_WEIGHTS, group: { dialog: "type", page: false }, groupOrder: "best", types: out.types, typeOverrides: {}, facets: {} }, all(out.byLocale));
	assert.deepEqual(settings.types, { posts: { label: "Blog posts" } });
	const astro = await import("../src/astro/build.ts");
	assert.equal(astro.indexSettings, indexSettings);
});

test("a custom-path locale is stored under its code, so the loader's <html lang> lookup finds it; its URL keeps the path", async () => {
	const urlRules: UrlRules = { siteLocale: "en", i18n: { defaultLocale: "english", locales: [{ path: "english", codes: ["en", "en-US"] }, "fr", { path: "portugues", codes: ["pt-BR"] }] } };
	const out = await collect({
		collections: [collection("posts")],
		urlRules,
		defaultLocale: "english",
		entries: [entry("posts", "ola", { locale: "portugues" }), entry("posts", "salut", { locale: "fr" }), entry("posts", "hi", { locale: "english" }), entry("posts", "plain", { locale: null })],
	});
	assert.deepEqual(Object.keys(out.byLocale).sort(), ["en", "fr", "pt-BR"]);
	const pt = out.byLocale["pt-BR"][0] as PageRecord;
	assert.deepEqual([pt.id, pt.locale, pt.url], ["pt-BR:/portugues/posts/ola", "pt-BR", "/portugues/posts/ola"]);
	assert.deepEqual(out.byLocale.fr.map((r) => r.url), ["/fr/posts/salut"]);
	assert.deepEqual(out.byLocale.en.map((r) => r.url).sort(), ["/posts/hi", "/posts/plain"]);
	assert.equal(indexLocale("english", urlRules), "en");
	// The browser loader (read only) picks by <html lang> against the stored keys.
	const manifest: Manifest = { schema: SCHEMA, defaultLocale: indexLocale("english", urlRules), indexes: { default: { version: "v", locales: Object.fromEntries(Object.keys(out.byLocale).map((l) => [l, `/${l}.json`])) } } };
	assert.equal(pickLocale("pt-BR", manifest, "default"), "pt-BR");
	assert.equal(pickLocale("fr", manifest, "default"), "fr");
	assert.equal(pickLocale("en-US", manifest, "default"), "en");
});

test("plain locales keep their own keys", () => {
	const urlRules: UrlRules = { siteLocale: "en", i18n: { defaultLocale: "en", locales: ["en", "fr"] } };
	assert.equal(indexLocale("fr", urlRules), "fr");
	assert.equal(indexLocale("en", urlRules), "en");
	assert.equal(indexLocale("de", urlRules), "de");
	assert.equal(indexLocale("fr", undefined), "fr");
	assert.equal(indexLocale("fr", { siteLocale: "en", i18n: null }), "fr");
});
