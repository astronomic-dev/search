import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { collections, entryRecords } from "../src/adapters/collections.ts";
import { html, pageRecords, scanHtml } from "../src/adapters/html.ts";
import { matchPath } from "../src/core/match-path.ts";
import { mergeRecords } from "../src/core/merge.ts";
import { records, runRecords } from "../src/adapters/records.ts";
import { capKeywords, checkRecords } from "../src/core/schema.ts";
import { normalizeSettings } from "../src/astro/build.ts";
import type { UrlOptions } from "../src/core/url.ts";

const never: UrlOptions = { base: "/", trailingSlash: "never", format: "directory", site: "https://example.com" };
const ctx = { urlOptions: never, defaultLocale: "en" };
const dist = fileURLToPath(new URL("./fixtures/dist/", import.meta.url));

// ---------------------------------------------------------------------------------------------------------------------
// collections

const body = "Intro words.\n\n## Install\n\nRun the **installer**.\n\n## Setup\n\nOpen [the file](/x).\n";
const headings = [
	{ depth: 1, slug: "doc", text: "Doc" },
	{ depth: 2, slug: "install", text: "Install" },
	{ depth: 2, slug: "setup", text: "Setup" },
];

test("a Markdown entry gives a page record and its heading records", () => {
	const out = entryRecords({ id: "vega/search", collection: "docs", data: { title: "Vega search", theme: "vega" }, body }, headings, { label: "Docs", url: "/docs/{id}", facets: { theme: "id:0", tag: "theme" } }, ctx);
	assert.ok(out);
	assert.deepEqual(out.warnings, []);
	const [page, install, setup] = out.records.map((s) => s.record);
	assert.deepEqual(page, { id: "en:/docs/vega/search", kind: "page", locale: "en", type: "docs", url: "/docs/vega/search", title: "Vega search", text: "Intro words.", facets: { theme: ["vega"], tag: ["vega"] }, source: "collection" });
	assert.equal(install?.id, "en:/docs/vega/search#install");
	assert.equal(install?.pageId, "en:/docs/vega/search");
	assert.equal(install?.heading, "Install");
	assert.equal(install?.text, "Run the installer.");
	assert.equal(setup?.text, "Open the file.");
	assert.match(out.records[0]?.origin ?? "", /docs.*vega\/search/);
	checkRecords(out.records, never);
});

test("draft and noindex entries are skipped", () => {
	const spec = { label: "Docs" };
	assert.equal(entryRecords({ id: "a", collection: "docs", data: { title: "A", draft: true }, body }, headings, spec, ctx), null);
	assert.equal(entryRecords({ id: "a", collection: "docs", data: { title: "A", noindex: true }, body }, headings, spec, ctx), null);
	assert.ok(entryRecords({ id: "a", collection: "docs", data: { title: "A", draft: false }, body }, headings, spec, ctx));
});

test("headings that do not match the rendered ones give the page alone, with a warning naming the entry", () => {
	const out = entryRecords({ id: "odd", collection: "docs", data: { title: "Odd" }, body }, [{ depth: 2, slug: "other", text: "Other" }], {}, ctx);
	assert.ok(out);
	assert.equal(out.records.length, 1);
	assert.match(out.records[0]?.record.text ?? "", /Intro words\. Install Run the installer\. Setup Open the file\./);
	assert.equal(out.warnings.length, 1);
	assert.match(out.warnings[0] ?? "", /docs.*odd/);
});

test("a data-only entry gives one page record with its fields as text", () => {
	const out = entryRecords({ id: "lodestar", collection: "themes", data: { name: "Lodestar", excerpt: "A docs theme.", tags: ["docs", "dark"], price: 79 } }, undefined, { label: "Themes", url: "/themes/{slug}", title: "name", fields: ["excerpt", "tags", "missing"], facets: ["tags"] }, ctx);
	assert.ok(out);
	assert.equal(out.records.length, 1);
	const r = out.records[0]?.record;
	assert.equal(r?.title, "Lodestar");
	assert.equal(r?.url, "/themes/lodestar");
	assert.equal(r?.text, "A docs theme. docs dark");
	assert.deepEqual(r?.facets, { tags: ["docs", "dark"] });
});

test("the url defaults to /<collection>/{id}; {slug} reads data.slug; an index id is the folder", () => {
	const url = (id: string, data: Record<string, unknown>, spec = {}, o = never) => entryRecords({ id, collection: "learn", data: { title: "T", ...data } }, undefined, spec, { ...ctx, urlOptions: o })?.records[0]?.record.url;
	assert.equal(url("guides/start", {}), "/learn/guides/start");
	assert.equal(url("x", { slug: "nice" }, { url: "/l/{slug}" }), "/l/nice");
	assert.equal(url("guides/index", {}), "/learn/guides");
	assert.equal(url("x", {}, {}, { base: "/sub/", trailingSlash: "always", format: "directory" }), "/sub/learn/x/");
});

test("facet values are strings; empty ones are left out; numbers and booleans become strings", () => {
	const out = entryRecords({ id: "a", collection: "docs", data: { title: "T", n: 3, b: true, e: "", list: ["x", "", 2], none: null } }, undefined, { facets: ["n", "b", "e", "list", "none"] }, ctx);
	assert.deepEqual(out?.records[0]?.record.facets, { n: ["3"], b: ["true"], list: ["x", "2"] });
});

test("searchKeywords in the front matter: an array or a comma list; a spec can rename or turn it off; headings get none", () => {
	const entry = (data: Record<string, unknown>) => ({ id: "a", collection: "docs", data: { title: "A", ...data }, body });
	const kw = (data: Record<string, unknown>, spec = {}) => entryRecords(entry(data), headings, spec, ctx)?.records.map((s) => s.record.keywords);
	assert.deepEqual(kw({ searchKeywords: ["start", " guide ", ""] }), [["start", "guide"], undefined, undefined]);
	assert.deepEqual(kw({ searchKeywords: "start, guide ,north," }), [["start", "guide", "north"], undefined, undefined]);
	assert.deepEqual(kw({}), [undefined, undefined, undefined]);
	assert.deepEqual(kw({ searchKeywords: [] }), [undefined, undefined, undefined]);
	assert.deepEqual(kw({ tags: "a, b", searchKeywords: "x" }, { keywords: "tags" })?.[0], ["a", "b"]);
	assert.deepEqual(kw({ searchKeywords: "x" }, { keywords: false })?.[0], undefined);
	const out = entryRecords(entry({ searchKeywords: "start" }), headings, {}, ctx);
	assert.deepEqual(Object.keys(out?.records[0]?.record ?? {}), ["id", "kind", "locale", "type", "url", "title", "text", "facets", "keywords", "source"]);
	checkRecords(out?.records ?? [], never);
	assert.throws(() => collections({ docs: { keywords: true as never } }), /collection "docs": keywords must be a field name or false/);
});

test("a collection can name its records' type: the hubs spec with type learn gives learn records", () => {
	const hub = { id: "photo-sites", collection: "hubs", data: { title: "Photo sites" }, body };
	const out = entryRecords(hub, headings, { type: "learn", url: "/learn/{id}" }, ctx);
	assert.deepEqual(
		out?.records.map((s) => [s.record.type, s.record.url]),
		[
			["learn", "/learn/photo-sites"],
			["learn", "/learn/photo-sites#install"],
			["learn", "/learn/photo-sites#setup"],
		],
	);
	// Without it the type is the collection's name.
	assert.equal(entryRecords(hub, headings, {}, ctx)?.records[0]?.record.type, "hubs");
	checkRecords(out?.records ?? [], never);
});

test("a shared type takes its label from the spec that sets one, else the type's own label", () => {
	const types = (sources: Parameters<typeof normalizeSettings>[0]) => normalizeSettings(sources).indexes.default?.types;
	assert.deepEqual(types({ sources: [collections({ hubs: { type: "learn" }, learn: { label: "Guides" } })] }), { learn: { label: "Guides" } });
	assert.deepEqual(types({ sources: [collections({ learn: {}, hubs: { type: "learn" } })] }), { learn: { label: "Learn" } });
	// The index's types setting still wins.
	assert.deepEqual(types({ sources: [collections({ hubs: { type: "learn", label: "Hubs" } })], types: { learn: { label: "Learn", weight: 2 } } }), { learn: { label: "Learn", weight: 2 } });
});

test("two collections of one type with different labels fail with a clear error", () => {
	assert.throws(() => collections({ learn: { label: "Learn" }, hubs: { type: "learn", label: "Hubs" } }), /collections "learn" and "hubs" share the type "learn" but have different labels \("Learn" and "Hubs"\)/);
	// Across two collections() sources of one index too.
	assert.throws(
		() => normalizeSettings({ sources: [collections({ learn: { label: "Learn" } }), collections({ hubs: { type: "learn", label: "Hubs" } })] }),
		/collections "learn" and "hubs" share the type "learn" but have different labels/,
	);
	// The same label, or one label and none, is fine.
	assert.doesNotThrow(() => collections({ learn: { label: "Learn" }, hubs: { type: "learn", label: "Learn" }, more: { type: "learn" } }));
	assert.throws(() => collections({ hubs: { type: "" } }), /collection "hubs": type must be a non-empty string/);
});

test("a facet named type fails", () => {
	assert.throws(() => entryRecords({ id: "a", collection: "docs", data: { title: "T" } }, undefined, { facets: ["type"] }, ctx), /type/);
});

test("a heading's anchor keeps the trailing slash form", () => {
	const o: UrlOptions = { base: "/", trailingSlash: "always", format: "directory" };
	const out = entryRecords({ id: "a", collection: "docs", data: { title: "T" }, body }, headings, {}, { ...ctx, urlOptions: o });
	assert.equal(out?.records[1]?.record.url, "/docs/a/#install");
	checkRecords(out?.records ?? [], o);
});

// ---------------------------------------------------------------------------------------------------------------------
// html

test("include and exclude match exact paths or one segment for a trailing *", () => {
	assert.equal(matchPath("/pricing", ["/pricing"]), true);
	assert.equal(matchPath("/pricing/", ["/pricing"]), true);
	assert.equal(matchPath("/ui/components/button", ["/ui/components/*"]), true);
	assert.equal(matchPath("/ui/components", ["/ui/components/*"]), false);
	assert.equal(matchPath("/ui/components/a/b", ["/ui/components/*"]), false);
	assert.equal(matchPath("/", ["/"]), true);
	assert.equal(matchPath("/x", ["/"]), false);
});

test("a * matches one segment in any place, so a list's paged forms can be left out", () => {
	assert.equal(matchPath("/learn/tag/astro/2", ["/learn/tag/*/*"]), true);
	assert.equal(matchPath("/learn/tag/astro", ["/learn/tag/*/*"]), false);
	assert.equal(matchPath("/ui/docs/theming", ["/ui/*/*"]), true);
	assert.equal(matchPath("/ui/docs", ["/ui/*/*"]), false);
	assert.equal(matchPath("/uix/docs/theming", ["/ui/*/*"]), false);
});

test("the HTML scan reads every built page but noindex and 404", async () => {
	const out = await scanHtml(dist, html({}), ctx);
	const pages = out.records.filter((s) => s.record.kind === "page").map((s) => s.record);
	assert.deepEqual(pages.map((p) => p.url).sort(), ["/", "/about", "/de", "/guides", "/plans"]);
	checkRecords(out.records, never);
	for (const p of pages) assert.equal(p.type, "pages");
	assert.match(out.records[0]?.origin ?? "", /\.html$/);
});

test("a same-site canonical wins; another site's is ignored", async () => {
	const out = await scanHtml(dist, html({ include: ["/pricing", "/about"] }), ctx);
	const urls = out.records.map((s) => s.record.url);
	assert.ok(urls.includes("/plans"));
	assert.ok(urls.includes("/plans#pass"));
	assert.ok(urls.includes("/about"));
	assert.ok(!urls.includes("/pricing"));
});

test("title from the h1, else the title tag; a heading with no id folds into the section above", async () => {
	const out = await scanHtml(dist, html({ include: ["/", "/pricing"] }), ctx);
	const byId = new Map(out.records.map((s) => [s.record.id, s.record]));
	assert.equal(byId.get("en:/")?.title, "Welcome home");
	assert.equal(byId.get("en:/")?.text, "Intro text for the home page.", "a > in a quoted attribute does not break the tree");
	assert.equal(byId.get("en:/#features")?.heading, "Features");
	assert.equal(byId.get("en:/plans")?.title, "Pricing plans | Fixture");
	assert.match(byId.get("en:/plans#pass")?.text ?? "", /One price for every theme\. Refunds Folded into the pass section\./);
	assert.equal(byId.get("en:/plans#refunds"), undefined);
});

test("locale from <html lang>; data-search-ignore and the parts outside the body are left out", async () => {
	const out = await scanHtml(dist, html({ include: ["/de", "/about"] }), ctx);
	const de = out.records.find((s) => s.record.url === "/de")?.record;
	assert.equal(de?.locale, "de");
	assert.equal(de?.id, "de:/de");
	const about = out.records.find((s) => s.record.url === "/about")?.record;
	assert.equal(about?.text, "We build themes.");
	assert.doesNotMatch(JSON.stringify(out.records), /Secret sidebar|Footer words/);
});

test("<html lang> is mapped onto the known locales, so a scanned page and a collection entry share one id", () => {
	const page = (lang: string) => `<!doctype html><html lang="${lang}"><head><title>T</title></head><body><main><h1>Doc</h1><p>Words.</p></main></body></html>`;
	const scanned = pageRecords(page("en-US"), "/docs/a", {}, ctx, "docs/a.html");
	assert.equal(scanned?.[0]?.record.id, "en:/docs/a");
	assert.equal(scanned?.[0]?.record.locale, "en");
	const entry = entryRecords({ id: "a", collection: "docs", data: { title: "A" }, body: "Words." }, [], { url: "/docs/{id}" }, ctx);
	const merged = mergeRecords([...(scanned ?? []), ...(entry?.records ?? [])]);
	assert.deepEqual(merged.map((r) => [r.id, r.source]), [["en:/docs/a", "collection"]]);
	// Configured locales: the lookup picks the closest one; a language with no match keeps its own tag.
	const i18n = { ...ctx, locales: ["en", "pt-BR", "zh-Hant"] };
	assert.equal(pageRecords(page("PT"), "/x", {}, i18n, "x")?.[0]?.record.locale, "pt-BR");
	assert.equal(pageRecords(page("zh-TW"), "/x", {}, i18n, "x")?.[0]?.record.locale, "zh-Hant");
	assert.equal(pageRecords(page("de"), "/x", {}, i18n, "x")?.[0]?.record.locale, "de");
	assert.equal(entryRecords({ id: "a", collection: "docs", data: { title: "A", locale: "en-GB" } }, undefined, {}, i18n)?.records[0]?.record.id, "en:/docs/a");
});

test("a scanned page whose canonical is another scanned page is skipped, so a paginated list does not clash", async () => {
	const dir = await mkdtemp(join(tmpdir(), "search-canon-"));
	const page = (canonical: string, h1: string) => `<!doctype html><html lang="en"><head><link rel="canonical" href="${canonical}"></head><body><main><h1>${h1}</h1></main></body></html>`;
	await mkdir(join(dir, "blog", "page"), { recursive: true });
	await writeFile(join(dir, "blog", "page", "2.html"), page("/blog", "Blog page 2"));
	await writeFile(join(dir, "blog.html"), page("https://example.com/blog/", "Blog"));
	await writeFile(join(dir, "old.html"), page("/new", "Moved"));
	try {
		const out = await scanHtml(dir, html(), ctx);
		assert.deepEqual(out.records.map((s) => [s.record.id, s.record.title]), [["en:/blog", "Blog"], ["en:/new", "Moved"]]);
		assert.equal(mergeRecords(out.records).length, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an index.html in a folder is the folder's url; include, exclude, type and label apply", async () => {
	const out = await scanHtml(dist, html({ include: ["/*"], exclude: ["/about", "/de"], type: "guides", label: "Guides" }), ctx);
	const pages = out.records.filter((s) => s.record.kind === "page").map((s) => s.record);
	assert.deepEqual(pages.map((p) => p.url).sort(), ["/guides", "/plans"]);
	assert.equal(pages[0]?.type, "guides");
	const first = out.records.find((s) => s.record.url === "/guides#first")?.record;
	assert.equal(first?.text, "Start here.");
});

test("a selector picks the body", async () => {
	const out = await scanHtml(dist, html({ include: ["/"], selector: "h2 + p" }), ctx);
	assert.equal(out.records.length, 1);
	assert.equal(out.records[0]?.record.text, "Fast and small.");
});

test("trailing slash always gives slashed urls", async () => {
	const o: UrlOptions = { base: "/", trailingSlash: "always", format: "directory", site: "https://example.com" };
	const out = await scanHtml(dist, html({ include: ["/guides"] }), { ...ctx, urlOptions: o });
	assert.deepEqual(out.records.map((s) => s.record.url), ["/guides/", "/guides/#first"]);
	checkRecords(out.records, o);
});

test("<meta name=search:keywords> gives the page its keywords, split on commas and trimmed", () => {
	const doc = (meta: string) => `<!doctype html><html lang="en"><head><title>T</title>${meta}</head><body><main><h1>Doc</h1><p>Words.</p><h2 id="one">One</h2><p>More.</p></main></body></html>`;
	const got = pageRecords(doc('<meta name="search:keywords" content="star, guide , north,">'), "/a", {}, ctx, "a.html");
	assert.deepEqual(got?.map((s) => s.record.keywords), [["star", "guide", "north"], undefined]);
	assert.equal(pageRecords(doc(""), "/a", {}, ctx, "a.html")?.[0]?.record.keywords, undefined);
	assert.equal(pageRecords(doc('<meta name="search:keywords" content=" , ">'), "/a", {}, ctx, "a.html")?.[0]?.record.keywords, undefined);
	checkRecords(got ?? [], never);
});

test("a collection page that replaces a scanned page keeps its own keywords, with no merging", () => {
	const scanned = pageRecords('<html><head><meta name="search:keywords" content="scanned"></head><body><main><h1>A</h1></main></body></html>', "/docs/a", {}, ctx, "docs/a.html") ?? [];
	const plain = entryRecords({ id: "a", collection: "docs", data: { title: "A" } }, undefined, { url: "/docs/{id}" }, ctx)?.records ?? [];
	assert.deepEqual(mergeRecords([...scanned, ...plain]).map((r) => r.keywords), [undefined]);
	const own = entryRecords({ id: "a", collection: "docs", data: { title: "A", searchKeywords: "own" } }, undefined, { url: "/docs/{id}" }, ctx)?.records ?? [];
	assert.deepEqual(mergeRecords([...scanned, ...own]).map((r) => r.keywords), [["own"]]);
});

test("more than 20 keywords on a page: the first 20 are kept, with a warning naming the page", () => {
	const words = Array.from({ length: 25 }, (_, i) => `w${i}`);
	const sourced = [
		{ record: { id: "en:/a", kind: "page", locale: "en", type: "docs", url: "/a", title: "A", text: "", facets: {}, keywords: words, source: "hook" }, origin: "records() hook" },
		{ record: { id: "en:/b", kind: "page", locale: "en", type: "docs", url: "/b", title: "B", text: "", facets: {}, keywords: ["x"], source: "hook" }, origin: "records() hook" },
	] as const;
	const list = sourced.map((s) => ({ ...s, record: { ...s.record, keywords: [...s.record.keywords] } }));
	const warnings = capKeywords(list as never);
	assert.equal(list[0]?.record.keywords.length, 20);
	assert.equal(list[0]?.record.keywords[19], "w19");
	assert.deepEqual(list[1]?.record.keywords, ["x"]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /en:\/a/);
	assert.match(warnings[0] ?? "", /records\(\) hook/);
	assert.match(warnings[0] ?? "", /25/);
	assert.deepEqual(capKeywords(list as never), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// records

test("the records hook is called once, with source, origin and locale filled", async () => {
	let calls = 0;
	const source = records(async () => {
		calls++;
		return [
			{ id: "en:/ui/button", kind: "page", type: "kit", url: "/ui/button", title: "Button", text: "", facets: {} },
			{ id: "de:/de/ui/button", kind: "page", locale: "de", type: "kit", url: "/de/ui/button", title: "Knopf", text: "", keywords: ["start"] },
		];
	});
	const out = await runRecords(source, "en");
	assert.equal(calls, 1);
	assert.deepEqual(
		out.map((s) => [s.record.locale, s.record.source, s.origin]),
		[
			["en", "hook", "records() hook"],
			["de", "hook", "records() hook"],
		],
	);
	assert.deepEqual(out[1]?.record.facets, {});
	assert.deepEqual(out[1]?.record.keywords, ["start"]);
	checkRecords(out, never);
});

test("a hook that does not return an array fails clearly", async () => {
	await assert.rejects(runRecords(records(async () => null as never), "en"), /records\(\) hook/);
});

test("Unicode heading anchors give canonical urls and ids", () => {
	const md = "Intro.\n\n## Überblick\n\nWords.\n";
	const out = entryRecords({ id: "a", collection: "docs", data: { title: "A" }, body: md }, [{ depth: 2, slug: "überblick", text: "Überblick" }], { url: "/docs/{id}" }, ctx);
	assert.equal(out?.records[1]?.record.url, "/docs/a#%C3%BCberblick");
	assert.equal(out?.records[1]?.record.id, "en:/docs/a#%C3%BCberblick");
	checkRecords(out?.records ?? [], never);

	const page = '<html lang="en"><body><main><h1>A</h1><h2 id="überblick">Überblick</h2><p>One.</p><h2 id="%C3%BCberblick">Again</h2><p>Two.</p></main></body></html>';
	const got = pageRecords(page, "/a", {}, ctx, "a.html") ?? [];
	assert.deepEqual(got.map((s) => s.record.url), ["/a", "/a#%C3%BCberblick"]);
	assert.equal(got[1]?.record.text, "One. Again Two.");
	checkRecords(got, never);
});

test("a page is left out when any robots meta says noindex", () => {
	const page = '<html><head><meta name="robots" content="index"><meta name="robots" content="noindex"></head><body><main><h1>A</h1></main></body></html>';
	assert.equal(pageRecords(page, "/a", {}, ctx, "a.html"), null);
});

test("a search dialog on the page gives no title and no text, with or without a selector", () => {
	const source = `<!doctype html><html lang="en"><head><title>Real page</title></head><body><dialog data-search-dialog><h1>Search</h1><div data-search-body><p class="t">No results</p></div></dialog><main><p class="t">Real</p></main></body></html>`;
	const plain = pageRecords(source, "/a", {}, ctx, "a.html");
	assert.equal(plain?.[0]?.record.title, "Real page");
	assert.equal(plain?.[0]?.record.text, "Real");
	const picked = pageRecords(source, "/a", { selector: ".t" }, ctx, "a.html");
	assert.equal(picked?.[0]?.record.text, "Real");
});

test("an entry whose URL lands on another site fails the build, naming the collection and entry", () => {
	const bad = () => entryRecords({ id: "x", collection: "learn", data: { title: "T", slug: "/example.org/x" } }, undefined, { url: "/{slug}" }, ctx);
	assert.throws(bad, /collection "learn" entry "x": its URL \/\/example\.org\/x is not on this site/);
	const full = () => entryRecords({ id: "x", collection: "learn", data: { title: "T", slug: "https://example.org/x" } }, undefined, { url: "{slug}" }, ctx);
	assert.throws(full, /collection "learn" entry "x"/);
});

test("collections(): filter must be a function", () => {
	assert.throws(() => collections({ docs: { filter: true as never } }), /collection "docs": filter must be a function/);
	assert.doesNotThrow(() => collections({ docs: { filter: (e) => e.id !== "a" } }));
});

test("a facet may not be named q (the search page's query)", () => {
	assert.throws(() => collections({ docs: { facets: ["q"] } }), /facet may not be named "q"/);
	assert.throws(() => collections({ docs: { facets: { q: "id:0" } } }), /facet may not be named "q"/);
});

test("a > inside a quoted attribute value, single or double, leaks no attribute text; unquoted values still work", () => {
	const page = `<html lang="en"><body><main><h1>A</h1><div class="[&>*+*]:mt-5" x-data='a>b' title='say "hi" > there'><p data-x=1 hidden-not>One.</p><p class=plain>Two <b>three</b>.</p></div></main></body></html>`;
	const got = pageRecords(page, "/a", {}, ctx, "a.html") ?? [];
	assert.equal(got[0]?.record.title, "A");
	assert.equal(got[0]?.record.text, "One. Two three.");
});
