import assert from "node:assert/strict";
import { test } from "node:test";
import { collections } from "../src/adapters/collections.ts";
import { html } from "../src/adapters/html.ts";
import { records } from "../src/adapters/records.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtPageProblems, checkBrowseLinks, collectionKey, collectRecords, hash10, normalizeSettings, routeSpecs, statLine, writeIndexes, type RouteData } from "../src/astro/build.ts";
import { minisearchEngine } from "../src/core/minisearch.ts";
import type { IndexFile, SearchRecord, SourcedRecord } from "../src/core/types.ts";

const docs = () => collections({ docs: { label: "Docs", facets: ["theme"] }, themes: { fields: ["excerpt"] } });
const pages = () => html({ include: ["/"] });

test("the one-index form is short for indexes: { default }", () => {
	const sources = [docs(), pages()];
	const short = normalizeSettings({ sources, weights: { title: 4 } });
	const long = normalizeSettings({ indexes: { default: { sources, weights: { title: 4 } } }, default: "default" });
	assert.deepEqual(short, long);
	assert.equal(short.default, "default");
	const idx = short.indexes.default;
	assert.deepEqual(idx?.weights, { title: 4, heading: 2, text: 1, keywords: 1 });
	assert.deepEqual(idx?.group, { dialog: "type", page: false });
	assert.equal(idx?.groupOrder, "best");
	assert.deepEqual(idx?.types, { docs: { label: "Docs" }, themes: { label: "Themes" }, pages: { label: "Pages" } });
	assert.deepEqual(idx?.facets, { theme: { label: "Theme" } });
	assert.deepEqual(short.shortcut, { keys: ["mod+k", "/"] });
	assert.deepEqual(short.browse, []);
});

test("type weights and labels apply to declared types", () => {
	const s = normalizeSettings({ sources: [docs()], types: { themes: { weight: 1.5 }, docs: { label: "Guides" } } });
	assert.deepEqual(s.indexes.default?.types, { docs: { label: "Guides" }, themes: { label: "Themes", weight: 1.5 } });
});

test("bad settings fail with a clear message", () => {
	assert.throws(() => normalizeSettings({ sources: [docs()], wieghts: {} } as never), /no setting "wieghts"/);
	assert.throws(() => normalizeSettings({ indexes: { site: { sources: [docs()], colour: 1 } as never } }), /index "site" has no setting "colour"/);
	assert.throws(() => normalizeSettings({ sources: [collections({ docs: { facets: ["type"] } })] }), /facet may not be named "type"/);
	assert.throws(() => normalizeSettings({ sources: [docs()], facets: { type: { label: "T" } } }), /facet may not be named "type"/);
	assert.throws(() => normalizeSettings({ sources: [docs()], group: { dialog: "tag" } }), /group\.dialog is "tag", but no source declares/);
	assert.doesNotThrow(() => normalizeSettings({ sources: [docs()], group: { dialog: "theme" } }));
	assert.doesNotThrow(() => normalizeSettings({ sources: [records(() => [], { facets: ["part"] })], group: { page: "part" } }));
	assert.throws(() => normalizeSettings({ indexes: { site: { sources: [docs()] }, Site: { sources: [docs()] } } }), /same name/);
	assert.throws(() => normalizeSettings({ indexes: { site: { sources: [docs()] } }, default: "docs" }), /no index with that name/);
	assert.throws(() => normalizeSettings({ indexes: { site: { sources: [docs()] } }, sources: [docs()] }), /belongs inside an index/);
	assert.throws(() => normalizeSettings({ sources: [] }), /at least one source/);
	assert.throws(() => normalizeSettings({ sources: [{ kind: "nope" } as never] }), /collections\(\), html\(\) or records\(\)/);
	assert.throws(() => normalizeSettings({ indexes: { "a b": { sources: [docs()] } } }), /index name/);
});

test("an index may not take a reserved name (an Object.prototype key)", () => {
	const indexes = Object.defineProperty({ site: { sources: [docs()] } }, "__proto__", { value: { sources: [docs()] }, enumerable: true });
	assert.throws(() => normalizeSettings({ indexes } as never), /index name "__proto__" is reserved/);
	for (const name of ["constructor", "prototype", "toString", "hasOwnProperty"]) {
		assert.throws(() => normalizeSettings({ indexes: { [name]: { sources: [docs()] } } }), new RegExp(`index name "${name}" is reserved`));
	}
	assert.doesNotThrow(() => normalizeSettings({ indexes: { proto: { sources: [docs()] } } }));
});

test("named indexes; the default is the first unless named", () => {
	const s = normalizeSettings({ indexes: { site: { sources: [docs()] }, kit: { sources: [records(() => [])] } }, shortcut: false });
	assert.equal(s.default, "site");
	assert.equal(s.shortcut, false);
	assert.deepEqual(Object.keys(s.indexes), ["site", "kit"]);
});

const rec = (locale: string, url: string, type = "docs", title = "T"): SearchRecord => ({ id: `${locale}:${url}`, kind: "page", locale, type, url, title, text: "words", facets: {}, source: "collection" });

test("one file per index per locale, hashed names, and a manifest", () => {
	const settings = normalizeSettings({ indexes: { site: { sources: [docs(), pages()] }, kit: { sources: [records(() => [], { types: { kit: { label: "Kit parts" } } })] } } });
	const byIndex = { site: [rec("en", "/docs/a"), rec("de", "/de/docs/a"), rec("en", "/", "pages")], kit: [rec("en", "/ui/button", "kit")] };
	const out = writeIndexes(byIndex, settings, minisearchEngine, { base: "/sub/", defaultLocale: "en" });
	assert.deepEqual(Object.keys(out.manifest), ["schema", "defaultLocale", "indexes"]);
	assert.equal(out.manifest.schema, 1);
	assert.equal(out.manifest.defaultLocale, "en");
	assert.deepEqual(Object.keys(out.manifest.indexes.site?.locales ?? {}), ["de", "en"]);
	assert.deepEqual(Object.keys(out.manifest.indexes.kit?.locales ?? {}), ["en"]);
	for (const f of out.files) {
		const m = f.name.match(/^(site|kit)\.(en|de)\.([0-9a-f]{10})\.json$/);
		assert.ok(m, f.name);
		assert.equal(m[3], hash10(f.body));
		assert.equal(out.manifest.indexes[m[1] as string]?.locales[m[2] as string], `/sub/_search/${f.name}`);
	}
	const site = out.manifest.indexes.site;
	const localeHashes = Object.values(site?.locales ?? {}).map((u) => u.split(".")[2] as string);
	assert.equal(site?.version, hash10(localeHashes.sort().join(",")));

	const en = JSON.parse(out.files.find((f) => f.name.startsWith("site.en."))?.body ?? "{}") as IndexFile;
	assert.equal(en.index, "site");
	assert.equal(en.locale, "en");
	assert.deepEqual(en.records.map((r) => r.id), ["en:/", "en:/docs/a"]);
	assert.deepEqual(Object.keys(en.settings.types), ["docs", "pages", "themes"], "only the types the sources list");
	const kit = JSON.parse(out.files.find((f) => f.name.startsWith("kit."))?.body ?? "{}") as IndexFile;
	assert.deepEqual(kit.settings.types, { kit: { label: "Kit parts" } });

	const again = writeIndexes(byIndex, settings, minisearchEngine, { base: "/sub/", defaultLocale: "en" });
	assert.deepEqual(again.manifest, out.manifest, "same input, same names");
	const changed = writeIndexes({ ...byIndex, site: [rec("en", "/docs/a", "docs", "New")] }, settings, minisearchEngine, { base: "/sub/", defaultLocale: "en" });
	assert.notEqual(changed.manifest.indexes.site?.version, site?.version);
	assert.equal(changed.manifest.indexes.kit?.version, out.manifest.indexes.kit?.version);
});

test("a hook's own types get a label; the default locale always has a file", () => {
	const settings = normalizeSettings({ sources: [records(() => [])], types: { kit: { weight: 2 } } });
	const out = writeIndexes({ default: [rec("de", "/de/x", "kit")] }, settings, minisearchEngine, { base: "/", defaultLocale: "en" });
	assert.deepEqual(Object.keys(out.manifest.indexes.default?.locales ?? {}), ["de", "en"]);
	const de = JSON.parse(out.files.find((f) => f.name.startsWith("default.de."))?.body ?? "{}") as IndexFile;
	assert.deepEqual(de.settings.types, { kit: { label: "Kit", weight: 2 } });
});

test("stats give one line per index and flag a budget", () => {
	const settings = normalizeSettings({ sources: [docs()], budget: { gzipKB: 0.01 } });
	const out = writeIndexes({ default: [rec("en", "/docs/a")] }, settings, minisearchEngine, { base: "/", defaultLocale: "en" });
	const { line, over } = statLine(out.stats[0] as never);
	assert.equal(over, true);
	assert.match(line, /^index "default": 1 records, 1 file, [\d.]+ KB gzipped \(budget 0\.01 KB, OVER: set the index's clip for a smaller file\)$/);
});

test("an index with no budget gets the default one, 300 KB", () => {
	const settings = normalizeSettings({ sources: [docs()] });
	const out = writeIndexes({ default: [rec("en", "/docs/a")] }, settings, minisearchEngine, { base: "/", defaultLocale: "en" });
	const { line, over } = statLine(out.stats[0] as never);
	assert.equal(over, false);
	assert.match(line, /\(budget 300 KB\)$/);
});

test("clip: a whole number of at least 200, written to the file's settings", () => {
	assert.throws(() => normalizeSettings({ sources: [docs()], clip: 199 }), /clip must be a whole number of characters, at least 200/);
	assert.throws(() => normalizeSettings({ sources: [docs()], clip: 500.5 }), /clip/);
	assert.throws(() => normalizeSettings({ sources: [docs()], clip: "500" as never }), /clip/);
	const settings = normalizeSettings({ sources: [docs()], clip: 500 });
	const out = writeIndexes({ default: [rec("en", "/docs/a")] }, settings, minisearchEngine, { base: "/", defaultLocale: "en" });
	const file = JSON.parse(out.files[0]!.body) as IndexFile;
	assert.equal(file.settings.clip, 500);
	const none = writeIndexes({ default: [rec("en", "/docs/a")] }, normalizeSettings({ sources: [docs()] }), minisearchEngine, { base: "/", defaultLocale: "en" });
	assert.equal((JSON.parse(none.files[0]!.body) as IndexFile).settings.clip, undefined);
});

test("the writer refuses a file name outside the _search folder", async () => {
	const { safePath } = await import("../src/astro/build.ts");
	assert.equal(safePath("/out/_search", "site.en.abc.json"), "/out/_search/site.en.abc.json");
	assert.throws(() => safePath("/out/_search", "site.../../x.json".replace("...", "/..")), /outside/);
	assert.throws(() => safePath("/out/_search", "../x.json"), /outside/);
});

test("the dev origin comes from the server's own address, never a Host header", async () => {
	const { devOrigin } = await import("../src/astro/dev.ts");
	assert.equal(devOrigin({ resolvedUrls: { local: ["http://localhost:4512/sub/"], network: [] }, config: { server: { port: 4512 } } }), "http://localhost:4512");
	assert.equal(devOrigin({ resolvedUrls: null, config: { server: { port: 4600 } } }), "http://localhost:4600");
});

test("a default SearchLink with no built /search page gives one warning; a search page or an own href gives none", async () => {
	const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { searchPageWarning } = await import("../src/astro/build.ts");
	const out = await mkdtemp(join(tmpdir(), "search-page-"));
	try {
		const link = (href: string) => `<html><body><a href="${href}" class="b" data-search-trigger data-search-main>Search</a></body></html>`;
		await mkdir(join(out, "docs"), { recursive: true });
		await writeFile(join(out, "index.html"), link("/search"));
		await writeFile(join(out, "docs/index.html"), link("/search"));
		const warning = await searchPageWarning(out, "/");
		assert.match(warning ?? "", /no \/search page/);
		assert.match(warning ?? "", /href/);

		// Under a base, the default is /blog/search; the output folder does not hold the base.
		assert.equal(await searchPageWarning(out, "/blog/"), null);
		await writeFile(join(out, "index.html"), link("/blog/search"));
		assert.match((await searchPageWarning(out, "/blog")) ?? "", /\/blog\/search/);

		// Every link has its own href: no warning.
		await writeFile(join(out, "index.html"), link("/docs"));
		await writeFile(join(out, "docs/index.html"), link("/find"));
		assert.equal(await searchPageWarning(out, "/"), null);

		// An own href that is the default path (a page rendered on demand): no warning.
		await writeFile(join(out, "index.html"), `<a href="/search" data-search-trigger data-search-href>Search</a>`);
		assert.equal(await searchPageWarning(out, "/"), null);

		// A built search page, as search/index.html or search.html: no warning.
		await writeFile(join(out, "index.html"), link("/search"));
		await mkdir(join(out, "search"));
		await writeFile(join(out, "search/index.html"), "<html></html>");
		assert.equal(await searchPageWarning(out, "/"), null);
		await rm(join(out, "search"), { recursive: true });
		await writeFile(join(out, "search.html"), "<html></html>");
		assert.equal(await searchPageWarning(out, "/"), null);
	} finally {
		await rm(out, { recursive: true, force: true });
	}
});

const urlOptions = { base: "/", trailingSlash: "never", format: "directory" } as const;
const fileOf = (out: ReturnType<typeof writeIndexes>, prefix: string) => JSON.parse(out.files.find((f) => f.name.startsWith(prefix))?.body ?? "{}") as IndexFile;

test("suggested links go in each index file's settings; a per-locale map gives each locale its own", () => {
	const list = [{ label: "Start here", href: "/docs/a" }, { label: "Pricing", href: "/", type: "pages" }];
	const one = normalizeSettings({ sources: [docs(), pages()], suggested: list });
	const out = writeIndexes({ default: [rec("en", "/docs/a"), rec("de", "/de/docs/a")] }, one, minisearchEngine, { base: "/", defaultLocale: "en", urlOptions });
	assert.deepEqual(fileOf(out, "default.en.").settings.suggested, list);
	assert.deepEqual(fileOf(out, "default.de.").settings.suggested, list);

	const map = normalizeSettings({ sources: [docs()], suggested: { en: [{ label: "Start", href: "/docs/a" }], de: [{ label: "Los", href: "/de/docs/a" }] } });
	const out2 = writeIndexes({ default: [rec("en", "/docs/a"), rec("de", "/de/docs/a"), rec("fr", "/fr/docs/a")] }, map, minisearchEngine, { base: "/", defaultLocale: "en", urlOptions });
	assert.deepEqual(fileOf(out2, "default.de.").settings.suggested, [{ label: "Los", href: "/de/docs/a" }]);
	assert.equal(fileOf(out2, "default.fr.").settings.suggested, undefined, "a locale the map leaves out has none");

	const none = writeIndexes({ default: [rec("en", "/docs/a")] }, normalizeSettings({ sources: [docs()] }), minisearchEngine, { base: "/", defaultLocale: "en" });
	assert.equal("suggested" in fileOf(none, "default.en.").settings, false, "no setting, no key (file hashes stay the same)");
});

test("suggested links are checked: at most 8, a label and an on-site canonical href, a known type", () => {
	const link = (href: string, extra = {}) => ({ label: "L", href, ...extra });
	assert.throws(() => normalizeSettings({ sources: [docs()], suggested: Array.from({ length: 9 }, () => link("/docs/a")) }), /suggested has 9 links; at most 8/);
	assert.throws(() => normalizeSettings({ sources: [docs()], suggested: { en: Array.from({ length: 9 }, () => link("/docs/a")) } }), /suggested\.en has 9 links/);
	assert.throws(() => normalizeSettings({ sources: [docs()], suggested: [{ label: " ", href: "/docs/a" }] }), /suggested\[0\]\.label must be a non-empty string/);
	assert.throws(() => normalizeSettings({ sources: [docs()], suggested: [{ label: "L" }] as never }), /suggested\[0\]\.href must be a non-empty string/);
	assert.throws(() => normalizeSettings({ sources: [docs()], suggested: [link("/docs/a", { icon: "x" })] as never }), /suggested\[0\] has no field "icon"/);
	assert.throws(() => normalizeSettings({ sources: [docs()], suggested: "nope" as never }), /suggested must be a list of links/);

	const write = (suggested: never) =>
		writeIndexes({ default: [rec("en", "/docs/a")] }, normalizeSettings({ sources: [docs()], suggested }), minisearchEngine, { base: "/", defaultLocale: "en", urlOptions });
	assert.throws(() => write([link("/docs/a/")] as never), /suggested\[0\]\.href \/docs\/a\/ is not canonical; use \/docs\/a/);
	assert.throws(() => write([link("https://example.org/x")] as never), /suggested\[0\]\.href https:\/\/example\.org\/x is not on this site/);
	assert.throws(() => write({ en: [link("javascript:alert(1)")] } as never), /suggested\.en\[0\]\.href javascript:alert\(1\) is not on this site/);
	assert.throws(() => write([link("/docs/a", { type: "blog" })] as never), /suggested\[0\]\.type "blog" is not a type of this index/);
	assert.doesNotThrow(() => write([link("/docs/a", { type: "docs" }), link("/docs/a#install")] as never));
});

test("synonyms and pinned go in every index file, folded; pinned URLs must be pages of the index", () => {
	const s = normalizeSettings({ sources: [docs()], synonyms: [["Docs", "Documentation"], ["café", "coffee", "café"]], pinned: { " Get  Started ": ["/docs/a", "/docs/a"], Plans: ["/docs/b"] } });
	const out = writeIndexes({ default: [rec("en", "/docs/a"), rec("de", "/de/docs/b"), rec("en", "/docs/b")] }, s, minisearchEngine, { base: "/", defaultLocale: "en", urlOptions });
	for (const prefix of ["default.en.", "default.de."]) {
		const f = fileOf(out, prefix);
		assert.deepEqual(f.settings.synonyms, [["docs", "documentation"], ["cafe", "coffee"]]);
		assert.deepEqual(f.settings.pinned, { "get started": ["/docs/a"], plans: ["/docs/b"] });
	}
	const none = fileOf(writeIndexes({ default: [rec("en", "/docs/a")] }, normalizeSettings({ sources: [docs()] }), minisearchEngine, { base: "/", defaultLocale: "en" }), "default.en.");
	assert.equal("synonyms" in none.settings || "pinned" in none.settings, false);
});

test("synonyms and pinned are checked", () => {
	const bad = (o: object) => () => normalizeSettings({ sources: [docs()], ...o } as never);
	assert.throws(bad({ synonyms: "docs" }), /synonyms must be a list of groups/);
	assert.throws(bad({ synonyms: [["docs"]] }), /synonyms\[0\] needs at least two different words/);
	assert.throws(bad({ synonyms: [["docs", "Docs"]] }), /synonyms\[0\] needs at least two different words/);
	assert.throws(bad({ synonyms: [["docs", "user guide"]] }), /synonyms\[0\]\[1\] must be one word/);
	assert.throws(bad({ synonyms: [["docs", ""]] }), /synonyms\[0\]\[1\] must be one word/);
	assert.throws(bad({ pinned: ["/docs/a"] }), /pinned must map a query to a list of URLs/);
	assert.throws(bad({ pinned: { " ": ["/docs/a"] } }), /pinned has an empty query/);
	assert.throws(bad({ pinned: { docs: [] } }), /pinned\["docs"\] must be a non-empty list of URLs/);
	assert.throws(bad({ pinned: { Docs: ["/docs/a"], docs: ["/docs/b"] } }), /pinned has "Docs" and "docs", the same query once folded/);

	const write = (pinned: Record<string, string[]>, dev = false) =>
		writeIndexes({ default: [rec("en", "/docs/a")] }, normalizeSettings({ sources: [docs()], pinned }), minisearchEngine, { base: "/", defaultLocale: "en", urlOptions, dev });
	assert.throws(() => write({ docs: ["/docs/nope"] }), /pinned\["docs"\] has \/docs\/nope, which is not a page in the index/);
	assert.throws(() => write({ docs: ["/docs/a/"] }), /pinned\["docs"\] has \/docs\/a\/, which is not canonical; use \/docs\/a/);
	// In dev the HTML is not scanned, so a missing page is a warning, and it is left out.
	const dev = write({ docs: ["/docs/nope", "/docs/a"] }, true);
	assert.match(dev.warnings.join("\n"), /pinned\["docs"\] has \/docs\/nope/);
	assert.deepEqual(fileOf(dev, "default.en.").settings.pinned, { docs: ["/docs/a"] });
});

test("browse links: each a label and an href; the shape is checked with the settings", () => {
	const s = normalizeSettings({ sources: [docs()], browse: [{ label: " Docs ", href: "/docs" }] });
	assert.deepEqual(s.browse, [{ label: "Docs", href: "/docs" }]);
	const bad = (browse: unknown) => () => normalizeSettings({ sources: [docs()], browse } as never);
	assert.throws(bad({ label: "Docs", href: "/docs" }), /browse must be a list of links \(\{ label, href \}\)/);
	assert.throws(bad(["/docs"]), /browse\[0\] must be an object/);
	assert.throws(bad([{ label: " ", href: "/docs" }]), /browse\[0\]\.label must be a non-empty string/);
	assert.throws(bad([{ label: "Docs" }]), /browse\[0\]\.href must be a non-empty string/);
	assert.throws(bad([{ label: "Docs", href: "/docs", type: "docs" }]), /browse\[0\] has no field "type"/);
});

test("browse links: every href a canonical URL on this site, so no javascript: or other site ever renders", () => {
	const urlOptions = { base: "/", trailingSlash: "never", format: "directory", site: "https://example.com" } as const;
	const check = (href: string) => () => checkBrowseLinks([{ label: "Docs", href: "/docs" }, { label: "X", href }], urlOptions);
	assert.doesNotThrow(check("/pricing"));
	assert.doesNotThrow(check("/docs#start"));
	assert.throws(check("javascript:alert(1)"), /browse\[1\]\.href javascript:alert\(1\) is not on this site/);
	assert.throws(check(" javascript:alert(1)"), /is not on this site/);
	assert.throws(check("data:text/html,hi"), /is not on this site/);
	assert.throws(check("https://example.org/docs"), /is not on this site/);
	assert.throws(check("/pricing/"), /browse\[1\]\.href \/pricing\/ is not canonical; use \/pricing/);
	assert.doesNotThrow(() => checkBrowseLinks([], urlOptions));
	// trailingSlash "ignore": the site answers with and without the slash.
	const ignore = { base: "/", trailingSlash: "ignore", format: "directory" } as const;
	assert.doesNotThrow(() => checkBrowseLinks([{ label: "A", href: "/docs" }, { label: "B", href: "/docs/" }, { label: "C", href: "/" }], ignore));
	assert.throws(() => checkBrowseLinks([{ label: "A", href: "/docs.html" }], ignore), /not canonical; use \/docs\//);
	assert.throws(() => checkBrowseLinks([{ label: "A", href: "javascript:alert(1)" }], ignore), /not on this site/);
});

test("pinned: a query that is an Object.prototype name is an own key, never the prototype", () => {
	const s = normalizeSettings({ sources: [docs()], pinned: JSON.parse('{"__proto__":["/docs/a"],"constructor":["/docs/a"],"toString":["/docs/a"]}') });
	const pinned = s.indexes.default!.pinned!;
	assert.deepEqual(Object.keys(pinned).sort(), ["__proto__", "constructor", "tostring"]);
	assert.ok(Object.hasOwn(pinned, "__proto__"));
	const rec = (url: string): SearchRecord => ({ id: `en:${url}`, kind: "page", locale: "en", type: "docs", url, title: "A", text: "", facets: {}, source: "collection" }) as SearchRecord;
	const out = writeIndexes({ default: [rec("/docs/a")] }, s, minisearchEngine, { base: "/", defaultLocale: "en", urlOptions: { base: "/", trailingSlash: "never", format: "directory" } });
	const file = JSON.parse(out.files[0]!.body) as IndexFile;
	assert.deepEqual(Object.keys(file.settings.pinned!).sort(), ["__proto__", "constructor", "tostring"]);
});

test("a record type or facet value that is an Object.prototype name is labeled like any other", () => {
	const rec = (type: string): SearchRecord => ({ id: `en:/${type}`, kind: "page", locale: "en", type, url: `/${type}`, title: "A", text: "", facets: {}, source: "collection" }) as SearchRecord;
	const s = normalizeSettings({ sources: [records(() => [])] });
	const out = writeIndexes({ default: [rec("constructor"), rec("toString")] }, s, minisearchEngine, { base: "/", defaultLocale: "en" });
	const file = JSON.parse(out.files[0]!.body) as IndexFile;
	assert.deepEqual(file.settings.types, { constructor: { label: "Constructor" }, toString: { label: "ToString" } });
});

test("the default index must be one of the indexes, not an Object.prototype name", () => {
	assert.throws(() => normalizeSettings({ indexes: { site: { sources: [docs()] } }, default: "constructor" }), /default is "constructor", but there is no index/);
});

test("a facet may not be named q: the search page reads q as the query", () => {
	assert.throws(() => normalizeSettings({ sources: [docs()], facets: { q: { label: "Q" } } }), /facet may not be named "q"/);
	assert.throws(() => normalizeSettings({ sources: [records(() => [], { facets: ["q"] })] }), /facet may not be named "q"/);
	assert.throws(() => normalizeSettings({ sources: [records(() => [], { facets: ["type"] })] }), /facet may not be named "type"/);
});

// ---------------------------------------------------------------------------------------------------------------------
// collections() filter

const siteUrls = { base: "/", trailingSlash: "never" as const, format: "directory" as const, site: "https://example.com" };

test("a collections() filter keeps the entries it returns true for; it sees each entry's id, collection and data", async () => {
	const seen: unknown[] = [];
	const settings = normalizeSettings({
		sources: [collections({ docs: { url: "/docs/{id}", filter: (e) => (seen.push(e), e.id.split("/")[0] !== "agency") } })],
	});
	const [spec] = routeSpecs(settings);
	assert.equal(spec?.data, true, "a spec with a filter asks the route for each entry's data");
	const one = (id: string): { id: string; data: Record<string, unknown>; records: SourcedRecord[]; warnings: string[] } => ({
		id,
		data: { title: id },
		records: [{ record: { id: `en:/docs/${id}`, kind: "page", locale: "en", type: "docs", url: `/docs/${id}`, title: id, text: "", facets: {}, source: "collection" }, origin: id }],
		warnings: [`warn ${id}`],
	});
	const route: RouteData = { sources: { [spec!.key]: { entries: [one("vega/a"), one("agency/b")] } } };
	const warned: string[] = [];
	const out = await collectRecords(settings, { route, scan: async () => [], urlOptions: siteUrls, defaultLocale: "en", warn: (m) => warned.push(m) });
	assert.deepEqual(out.default?.map((r) => r.url), ["/docs/vega/a"]);
	assert.deepEqual(warned, ["warn vega/a"], "a left-out entry's warnings are dropped too");
	assert.deepEqual(seen[1], { id: "agency/b", collection: "docs", data: { title: "agency/b" } });
	// No filter: the route sends no data.
	const plain = routeSpecs(normalizeSettings({ sources: [collections({ docs: {} })] }));
	assert.equal(plain[0]?.data, false);
	assert.notEqual(collectionKey("docs", { filter: () => true }), collectionKey("docs", {}));
});

// ---------------------------------------------------------------------------------------------------------------------
// Built pages

test("builtPageProblems: every collection and html record URL is a built page, and its anchor an id there", async () => {
	const out = await mkdtemp(join(tmpdir(), "search-built-"));
	try {
		await mkdir(join(out, "docs/a"), { recursive: true });
		await writeFile(join(out, "index.html"), "<h1>Home</h1>");
		await writeFile(join(out, "docs/a/index.html"), `<h2 id="setup">Setup</h2><h2 id='über'>Ü</h2>`);
		await writeFile(join(out, "pricing.html"), "<p>Plans</p>");
		const r = (url: string, source: SearchRecord["source"] = "collection"): SearchRecord => ({ ...rec("en", url), source });
		const byIndex = {
			site: [r("/"), r("/docs/a"), r("/docs/a#setup"), r("/docs/a#%C3%BCber"), r("/pricing", "html"), r("/docs/gone"), r("/docs/a#nope")],
			kit: [r("/ui/button", "hook")],
		};
		assert.deepEqual(await builtPageProblems(byIndex, out, siteUrls), [
			'Search: index "site": /docs/gone is not a built page',
			'Search: index "site": /docs/a renders no #nope',
		]);
		const sub = { ...siteUrls, base: "/sub/" };
		assert.deepEqual(await builtPageProblems({ site: [r("/sub/docs/a#setup"), r("/sub")] }, out, sub), []);
	} finally {
		await rm(out, { recursive: true, force: true });
	}
});
