/** `listPages`: the words of list pages (a theme route that shows a whole collection) in the EmDash index. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchRecord } from "../src/core/types.ts";
import { LIST_PAGE_MAX, checkListPages } from "../src/emdash/core/list-pages.ts";
import type { EmDashEntry, ListPage, PluginOptions, UrlRules } from "../src/emdash/core/ports.ts";
import { collectRecords } from "../src/emdash/core/records.ts";
import { countsAsChange } from "../src/emdash/core/refresh.ts";
import { collection, createFakeContent, entry, portableText, type FakeContentInput } from "./emdash/fake-content.ts";

const NO_I18N: UrlRules = { siteLocale: "en", i18n: null };
const I18N: UrlRules = { siteLocale: "en", i18n: { defaultLocale: "en", locales: ["en", "fr", { path: "portugues", codes: ["pt-BR"] }] } };
const PAGES = collection("pages", { urlPattern: "/{slug}" });
const TALKS = collection("talks", { supports: [], routable: false, urlPattern: null });
const USES = collection("uses", { supports: [], routable: false, urlPattern: null, hidden: true });
const SPEAKING: ListPage = { path: "/speaking", from: [{ collection: "talks", fields: ["title", "place", "notes"] }] };
const FALLBACK = { ...SPEAKING, fallback: { title: "Speaking", text: "Where I talk." } };

const talk = (title: string, over: Partial<EmDashEntry> = {}) => entry("talks", null, { ...over, data: { title, ...over.data } });

async function run(input: FakeContentInput, options: PluginOptions = {}) {
	const fake = createFakeContent({ collections: [PAGES, TALKS, USES], urlRules: NO_I18N, ...input });
	const out = await collectRecords({ content: fake.content, schema: fake.schema }, options);
	const records = Object.values(out.byLocale).flat();
	return { ...out, records, fake, lists: fake.calls.filter((c) => c.op === "list").map((c) => c.collection) };
}
const at = (records: SearchRecord[], id: string) => records.find((r) => r.id === id);

test("listPages adds the items' words to the end of the entry's record, and the record stays its own", async () => {
	const entries = [
		entry("pages", "speaking", { data: { title: "Talks", excerpt: "Hello.", content: portableText("My talks.") } }),
		entry("pages", "about"),
		talk("The Web Is 900 Megabytes", { data: { place: "Lisbon", notes: portableText("Slow  pages.", "Fast ones.") } }),
		talk("Second", { data: { notes: 3, place: null, secret: "hidden" } }),
	];
	const { records, types, warnings, skipped } = await run({ entries }, { listPages: [FALLBACK] });
	assert.deepEqual(at(records, "en:/speaking"), {
		id: "en:/speaking", kind: "page", locale: "en", type: "pages", url: "/speaking", title: "Talks", facets: {}, source: "emdash",
		text: "Hello. My talks. The Web Is 900 Megabytes · Lisbon · Slow pages. Fast ones. · Second",
	});
	assert.equal(at(records, "en:/about")!.text, "");
	assert.deepEqual([records.length, types, warnings, skipped], [2, { pages: { label: "Pages" } }, [], 0]);
});

test("listPages: with no entry at the path, only a fallback makes a page", async () => {
	const entries = [talk("Megabytes")];
	assert.deepEqual((await run({ entries }, { listPages: [SPEAKING] })).records, []);
	const { records, types, warnings } = await run({ entries }, { listPages: [FALLBACK] });
	assert.deepEqual(records, [
		{ id: "en:/speaking", kind: "page", locale: "en", type: "pages", url: "/speaking", title: "Speaking", text: "Where I talk. Megabytes", facets: {}, source: "emdash" },
	]);
	assert.deepEqual([types, warnings], [{ pages: { label: "Pages" } }, []]);
	// No items: the page is still there (the fallback says so), and its text can be left out.
	const bare = await run({}, { listPages: [{ ...SPEAKING, fallback: { title: " A  title " } }] });
	assert.deepEqual(bare.records.map((r) => [r.title, r.text]), [["A title", ""]]);
});

test("listPages: the fallback's type, and the label of a type that is not an indexed collection", async () => {
	const { records, types } = await run({ entries: [] }, { listPages: [{ ...FALLBACK, type: "talks" }, { path: "/uses", from: [{ collection: "uses", fields: ["name"] }], fallback: { title: "Uses" }, type: "extra" }] });
	assert.deepEqual(records.map((r) => r.type), ["talks", "extra"]);
	assert.deepEqual(types, { extra: { label: "Extra" }, pages: { label: "Pages" }, talks: { label: "Talks" } });
	// The type of a page that is not made gives no type.
	assert.deepEqual((await run({ entries: [entry("pages", "speaking")] }, { listPages: [{ ...FALLBACK, type: "talks" }] })).types, { pages: { label: "Pages" } });
});

test("listPages: a published noIndex owner keeps the page out, fallback or not; an unpublished one gives the fallback", async () => {
	const t = talk("Megabytes");
	assert.deepEqual((await run({ entries: [entry("pages", "speaking", { seo: { noIndex: true } }), t] }, { listPages: [FALLBACK] })).records, []);
	for (const status of ["draft", "scheduled"]) {
		const { records } = await run({ entries: [entry("pages", "speaking", { status, data: { title: "Draft words" } }), t] }, { listPages: [FALLBACK] });
		assert.deepEqual(records.map((r) => [r.title, r.text]), [["Speaking", "Where I talk. Megabytes"]], status);
		// A draft noIndex owner says nothing about the page the theme shows.
		const hidden = await run({ entries: [entry("pages", "speaking", { status, seo: { noIndex: true } }), t] }, { listPages: [FALLBACK] });
		assert.equal(hidden.records.length, 1, status);
	}
});

test("listPages: an owner outside the indexed collections is not seen", async () => {
	const posts = collection("posts");
	const { records } = await run({ collections: [PAGES, posts, TALKS], entries: [entry("pages", "speaking", { seo: { noIndex: true } }), talk("Megabytes")] }, { collections: ["posts"], listPages: [FALLBACK] });
	assert.deepEqual(records.map((r) => r.title), ["Speaking"]);
});

test("listPages: two entries at the path get a warning, and nothing is added to either", async () => {
	const posts = collection("posts", { urlPattern: "/{slug}" });
	for (const seo of [undefined, { noIndex: true }]) {
		const { records, warnings } = await run({ collections: [PAGES, posts, TALKS], entries: [entry("pages", "speaking"), entry("posts", "speaking", seo ? { seo } : {}), talk("Megabytes")] }, { listPages: [FALLBACK] });
		assert.deepEqual(records.map((r) => r.text), seo ? [""] : ["", ""]);
		assert.deepEqual(warnings, ['Search: listPages: 2 entries have the path "/speaking"; nothing is added to them']);
	}
});

test("listPages: exclude wins over the page, for its entry and its fallback; it does not stop an item's words", async () => {
	const t = talk("Megabytes");
	for (const entries of [[t], [entry("pages", "speaking"), t], [entry("pages", "speaking"), entry("pages", "speaking"), t]]) {
		const { records, warnings } = await run({ entries }, { listPages: [FALLBACK], exclude: ["/speaking/"] });
		assert.deepEqual([records, warnings], [[], []]);
	}
	const routable = { ...TALKS, routable: true, urlPattern: "/talks/{slug}", supports: ["search"] };
	const { records } = await run({ collections: [PAGES, routable], entries: [entry("talks", "mb", { data: { title: "Megabytes" } })] }, { listPages: [FALLBACK], exclude: ["/talks/*"] });
	assert.deepEqual(records.map((r) => [r.url, r.text]), [["/speaking", "Where I talk. Megabytes"]]);
});

test("listPages: items are published and not noIndex, in the page's locale, null as the default", async () => {
	const entries = [
		entry("pages", "speaking", { locale: "en" }),
		entry("pages", "speaking", { locale: "fr" }),
		entry("pages", "speaking", { locale: "portugues" }),
		talk("null", {}), talk("english", { locale: "en" }), talk("french", { locale: "fr" }),
		talk("path", { locale: "portugues" }), talk("code", { locale: "pt-BR" }), talk("other", { locale: "de" }),
		talk("draft", { status: "draft" }), talk("scheduled", { status: "scheduled" }), talk("private", { seo: { noIndex: true } }),
	];
	const { records } = await run({ entries, urlRules: I18N }, { listPages: [FALLBACK] });
	assert.deepEqual(records.map((r) => [r.id, r.text]), [["en:/speaking", "null · english"], ["fr:/fr/speaking", "french"], ["pt-BR:/portugues/speaking", "path · code"]]);
});

test("listPages: the fallback is made in the default locale only, next to another locale's own entry", async () => {
	const entries = [entry("pages", "speaking", { locale: "fr", data: { title: "Conférences" } }), talk("english", { locale: "en" }), talk("french", { locale: "fr" }), talk("path", { locale: "portugues" })];
	const { records } = await run({ entries, urlRules: I18N }, { listPages: [FALLBACK] });
	assert.deepEqual(records.map((r) => [r.id, r.title, r.text]), [["fr:/fr/speaking", "Conférences", "french"], ["en:/speaking", "Speaking", "Where I talk. english"]]);
	// A noIndex owner in another locale says nothing about the default one.
	const other = await run({ entries: [entry("pages", "speaking", { locale: "fr", seo: { noIndex: true } }), ...entries.slice(1)], urlRules: I18N }, { listPages: [FALLBACK] });
	assert.deepEqual(other.records.map((r) => r.id), ["en:/speaking"]);
});

test("listPages: the fallback's URL has the entries' prefix, encoding and trailing slash, and its owner is found in any spelling", async () => {
	const url = async (path: string, urlRules?: UrlRules) => (await run({ urlRules }, { listPages: [{ ...FALLBACK, path }] })).records.map((r) => `${r.locale} ${r.url}`);
	assert.deepEqual(await url("/café/", NO_I18N), ["en /caf%C3%A9"]);
	assert.deepEqual(await url("/caf%c3%a9", { ...NO_I18N, trailingSlash: "always" }), ["en /caf%C3%A9/"]);
	assert.deepEqual(await url("/speaking/", { ...NO_I18N, trailingSlash: "never" }), ["en /speaking"]);
	assert.deepEqual(await url("/speaking", { ...I18N, trailingSlash: "always", i18n: { ...I18N.i18n!, prefixDefaultLocale: true } }), ["en /en/speaking/"]);
	assert.deepEqual(await url("/", { ...I18N, trailingSlash: "always" }), ["en /"]);
	assert.deepEqual(await url("/speaking/", undefined), ["en /speaking"]);
	const ptDefault: UrlRules = { siteLocale: "en", i18n: { ...I18N.i18n!, defaultLocale: "portugues", prefixDefaultLocale: true } };
	assert.deepEqual((await run({ urlRules: ptDefault, defaultLocale: "portugues" }, { listPages: [FALLBACK] })).records.map((r) => r.id), ["pt-BR:/portugues/speaking"]);
	for (const path of ["/café", "/café/", "/caf%C3%A9", "/caf%c3%a9/"]) {
		for (const trailingSlash of ["always", "never", "ignore"] as const) {
			const { records } = await run({ urlRules: { ...NO_I18N, trailingSlash }, entries: [entry("pages", "café"), talk("Megabytes")] }, { listPages: [{ ...FALLBACK, path }] });
			assert.deepEqual(records.map((r) => [r.title, r.text]), [["café", "Megabytes"]], `${path} ${trailingSlash}`);
		}
	}
});

test("listPages: a path that starts with a locale's prefix is left out with a warning", async () => {
	for (const path of ["/fr/speaking", "/fr", "/portugues/speaking"]) {
		const { records, warnings } = await run({ urlRules: I18N, entries: [talk("x")] }, { listPages: [{ ...FALLBACK, path }] });
		assert.deepEqual(records, []);
		assert.deepEqual(warnings, [`Search: listPages: "${path}" starts with a locale's prefix; write the path without it. The page is left out`]);
	}
	assert.equal((await run({ urlRules: I18N }, { listPages: [{ ...FALLBACK, path: "/french" }] })).records.length, 1);
});

test("listPages: with no URL rules, owners are found by publicPath, noIndex ones too", async () => {
	const entries = (seo?: { noIndex: boolean }) => [entry("pages", "speaking", seo ? { seo } : {}), talk("Megabytes")];
	const shown = await run({ urlRules: undefined, entries: entries() }, { listPages: [FALLBACK] });
	assert.deepEqual(shown.records.map((r) => r.text), ["Megabytes"]);
	assert.deepEqual((await run({ urlRules: undefined, entries: entries({ noIndex: true }) }, { listPages: [FALLBACK] })).records, []);
	// An entry with no public path still counts as skipped once, and only when it could be indexed.
	const noPath = await run({ urlRules: undefined, entries: [entry("pages", null, { seo: { noIndex: true } }), entry("pages", null)] }, { listPages: [FALLBACK] });
	assert.equal(noPath.skipped, 1);
});

test("listPages: an unknown collection or field is one warning, not a failure; a missing value is normal", async () => {
	const talks = { ...TALKS, fields: ["title", "place", "notes"] };
	const { records, warnings } = await run(
		{ collections: [PAGES, talks], entries: [talk("Megabytes")] },
		{ listPages: [{ ...FALLBACK, from: [{ collection: "nope", fields: ["a"] }, { collection: "talks", fields: ["titel", "title", "place"] }] }, { path: "/uses", from: [{ collection: "nope", fields: ["b"] }, { collection: "talks", fields: ["titel"] }] }] },
	);
	assert.deepEqual(records.map((r) => r.text), ["Where I talk. Megabytes"]);
	assert.deepEqual(warnings, [
		'Search: listPages: there is no collection "nope"; its words are left out',
		'Search: listPages: the collection "talks" has no field "titel"; it is left out',
	]);
});

test("listPages: each collection is listed once, whether indexed, read by two pages or both", async () => {
	const options: PluginOptions = {
		listPages: [
			{ path: "/speaking", from: [{ collection: "uses", fields: ["name"] }, { collection: "talks", fields: ["title"] }], fallback: { title: "Speaking" } },
			{ path: "/uses", from: [{ collection: "uses", fields: ["name"] }, { collection: "pages", fields: ["title"] }], fallback: { title: "Uses" } },
		],
	};
	const { records, lists } = await run({ entries: [entry("pages", "about", { data: { title: "About" } }), talk("First talk"), talk("Second talk"), entry("uses", null, { data: { name: "Tripod" } })] }, options);
	assert.deepEqual(lists.sort(), ["pages", "talks", "uses"]);
	// The words come in the order of `from`, then in list order.
	assert.equal(at(records, "en:/speaking")!.text, "Tripod · First talk · Second talk");
	assert.equal(at(records, "en:/uses")!.text, "Tripod · About");
	assert.equal(at(records, "en:/about")!.text, "");
});

test("listPages: the added words stop at the ceiling, at a word's end, with a warning; the entry's own text is not cut", async () => {
	const long = entry("pages", "speaking", { data: { title: "Talks", excerpt: "o".repeat(30_000) } });
	const big = (n: number) => Array.from({ length: n }, (_, i) => talk(`word${String(i).padStart(4, "0")}`)); // 8 characters, 11 with the separator
	const exact = await run({ entries: [long, ...big(1818)], pageSize: 100 }, { listPages: [SPEAKING] });
	assert.equal(exact.records[0].text.length, 30_000 + 1 + 19_995);
	assert.deepEqual(exact.warnings, []);
	const { records, warnings } = await run({ entries: [long, ...big(2500)], pageSize: 100 }, { listPages: [SPEAKING] });
	const added = records[0].text.slice(30_001);
	assert.ok(added.length <= LIST_PAGE_MAX && added.length > LIST_PAGE_MAX - 12, String(added.length));
	assert.match(added, /^word0000 · .* · word1817$/);
	assert.deepEqual(warnings, ['Search: listPages: "/speaking" lists more than 20,000 characters; only the first 20,000 are searched']);
	assert.equal(LIST_PAGE_MAX, 20_000);
	// A first field of exactly the ceiling: what comes after it is cut, and said so.
	const full = await run({ entries: [entry("pages", "speaking", { data: { title: "Talks" } }), talk("o".repeat(20_000)), talk("Megabytes")] }, { listPages: [SPEAKING] });
	assert.equal(full.warnings.length, 1);
	assert.equal(full.records[0].text, "o".repeat(20_000));
});

test("without listPages nothing changes: the same records and the same calls", async () => {
	const entries = [entry("pages", "speaking"), entry("pages", "hidden", { seo: { noIndex: true } }), talk("Megabytes")];
	const fresh = () => entries.map((e) => structuredClone(e));
	const off = await run({ entries: fresh() });
	const empty = await run({ entries: fresh() }, { listPages: [] });
	assert.deepEqual([empty.byLocale, empty.types, empty.fake.calls], [off.byLocale, off.types, off.fake.calls]);
	assert.deepEqual(off.lists, ["pages"]);
});

test("listPages on a site with no search collection: nothing is read and there are no types (no-collections)", async () => {
	const { records, types, lists } = await run({ collections: [TALKS], entries: [talk("x")] }, { listPages: [FALLBACK] });
	assert.deepEqual([records, types, lists], [[], {}, []]);
});

test("countsAsChange counts the listPages collections when collections is listed", () => {
	const options: PluginOptions = { collections: ["posts"], listPages: [SPEAKING] };
	const counts = (c: string, o = options) => countsAsChange("afterPublish", { collection: c, content: {} }, o);
	assert.deepEqual([counts("posts"), counts("talks"), counts("uses")], [true, true, false]);
	assert.equal(counts("uses", { listPages: [SPEAKING] }), true);
	assert.equal(countsAsChange("afterSave", { collection: "talks", content: { status: "draft" }, isNew: true }, options), false);
});

test("checkListPages takes the documented shape and throws a clear message on anything else", () => {
	checkListPages([]);
	checkListPages([FALLBACK, { path: "/uses", from: SPEAKING.from, fallback: { title: "Uses" }, type: "pages" }, { path: "/", from: SPEAKING.from }]);
	const bad: Array<[unknown, RegExp]> = [
		["/speaking", /listPages must be a list of pages/],
		[null, /listPages must be a list of pages/],
		[["/speaking"], /listPages\[0\] must be an object/],
		[[FALLBACK, { ...SPEAKING, path: "speaking" }], /listPages\[1\]\.path must be a site path .*not "speaking"/],
		[[{ ...SPEAKING, path: "/a?b" }], /path must be a site path/],
		[[{ ...SPEAKING, path: "//a" }], /path must be a site path/],
		[[{ ...SPEAKING, path: "/a/../b" }], /path must be a site path/],
		[[{ ...SPEAKING, path: "/a/%2e%2E/b" }], /path must be a site path/],
		[[{ ...SPEAKING, path: "/a/.%2e" }], /path must be a site path/],
		[[{ ...SPEAKING, path: "/talks/*" }], /path must be a site path .*no "\*"/],
		[[{ from: SPEAKING.from }], /path must be a site path/],
		[[{ ...SPEAKING, url: "/x" }], /listPages\[0\] has an unknown key "url"/],
		[[{ path: "/x" }], /listPages\[0\]\.from must be a list of \{ collection, fields \}/],
		[[{ path: "/x", from: [] }], /from must be a list/],
		[[{ path: "/x", from: ["talks"] }], /from must be a list/],
		[[{ path: "/x", from: [{ collection: "", fields: ["title"] }] }], /from must be a list/],
		[[{ path: "/x", from: [{ collection: "talks", fields: [] }] }], /from must be a list/],
		[[{ path: "/x", from: [{ collection: "talks", fields: ["title", 3] }] }], /from must be a list/],
		[[{ path: "/x", from: [{ collection: "talks", fields: ["title"], where: {} }] }], /from must be a list/],
		[[{ ...SPEAKING, fallback: "Speaking" }], /fallback must be \{ title, text\? \}/],
		[[{ ...SPEAKING, fallback: { title: " " } }], /fallback must be/],
		[[{ ...SPEAKING, fallback: { title: "x", text: 3 } }], /fallback must be/],
		[[{ ...SPEAKING, fallback: { title: "x", lead: "y" } }], /fallback must be/],
		[[{ ...SPEAKING, type: "" }], /type must be a name/],
		[[SPEAKING, { ...FALLBACK, path: "/speaking/" }], /listPages has the path "\/speaking\/" twice/],
		[[{ ...SPEAKING, path: "/café" }, { ...SPEAKING, path: "/caf%c3%a9/" }], /twice/],
	];
	for (const [value, message] of bad) assert.throws(() => checkListPages(value), (e: Error) => e.message.startsWith("Search: search(): ") && message.test(e.message), JSON.stringify(value));
});
