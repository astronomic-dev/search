/**
 * `entryPath` (the core's copy of EmDash's URL resolver) against EmDash 1.4's own code.
 *
 * EmDash's `getPublicUrl` is: published, a slug and a routable collection, then
 * `resolveLocalizedContentRoutePath(...)` with the row's pattern, slug, id, publish date, locale (or the site
 * locale) and the site's `trailingSlash`. `emdashPath` below repeats those checks and calls EmDash's own
 * `resolveLocalizedContentRoutePath` from its built package. That function reads Astro's i18n config from
 * `astro:config/server`; a loader hook gives it the config of each case, so custom locale paths
 * (`{ path, codes }`) run through EmDash's real code too. Our side gets the same config the way the wrapper
 * does: EmDash's `normalizeAstroI18n`, then `urlRulesFrom`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CollectionInfo, EmDashEntry } from "../src/emdash/core/ports.ts";
import { collectRecords, entryPath } from "../src/emdash/core/records.ts";
import { urlRulesFrom } from "../src/emdash/plugin.ts";
import { collection, createFakeContent, entry } from "./emdash/fake-content.ts";

// `astro:config/server` resolves to a module that exports the current case's config. The data URL carries
// the importer's URL, so each fresh import of EmDash's resolver (which caches the config) gets a fresh one.
const hook = `
export async function resolve(specifier, context, next) {
	if (specifier !== "astro:config/server") return next(specifier, context);
	const src = "const c = globalThis.__TEST_ASTRO_I18N__; export const i18n = c ?? undefined; // " + context.parentURL;
	return { url: "data:text/javascript," + encodeURIComponent(src), shortCircuit: true };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`);

/** The EmDash dist chunk that exports `name`, and that export. */
async function fromDist(name: string, fresh?: string): Promise<(...args: any[]) => any> {
	const dist = dirname(fileURLToPath(import.meta.resolve("emdash")));
	for (const file of readdirSync(dist).filter((f) => f.endsWith(".mjs"))) {
		const exports = /^export \{([^}]*)\};?$/m.exec(readFileSync(join(dist, file), "utf8"))?.[1];
		const alias = exports
			?.split(",")
			.map((x) => x.trim().split(/\s+as\s+/))
			.find(([local]) => local === name);
		if (!alias) continue;
		const url = pathToFileURL(join(dist, file)).href + (fresh ? `?case=${fresh}` : "");
		const mod = (await import(url)) as Record<string, (...args: any[]) => any>;
		return mod[alias[1] ?? alias[0]];
	}
	throw new Error(`EmDash dist has no ${name}`);
}

type AstroI18n = { defaultLocale: string; locales: Array<string | { path: string; codes: string[] }>; routing?: { prefixDefaultLocale?: boolean } };
type Site = { url: string; locale: string; trailingSlash?: "always" | "never" | "ignore" };

const normalizeAstroI18n = await fromDist("normalizeAstroI18n");
let caseNo = 0;

/** What EmDash's `getPublicUrl` gives (without the site URL), from EmDash's own resolver. */
async function emdashPath(c: CollectionInfo, e: EmDashEntry, site: Site, astro: AstroI18n | null): Promise<string | null> {
	(globalThis as Record<string, unknown>).__TEST_ASTRO_I18N__ = astro ?? undefined;
	const resolveLocalized = await fromDist("resolveLocalizedContentRoutePath", String(++caseNo));
	if (e.status !== "published" || !e.slug || !c.routable) return null;
	return resolveLocalized({
		pattern: c.urlPattern ?? null,
		collection: c.slug,
		slug: e.slug,
		id: e.id,
		date: e.publishedAt,
		locale: e.locale || site.locale,
		trailingSlash: site.trailingSlash,
	});
}

const ours = (c: CollectionInfo, e: EmDashEntry, site: Site, astro: AstroI18n | null) => entryPath(c, e, urlRulesFrom(site, normalizeAstroI18n(astro)));

async function same(label: string, c: CollectionInfo, e: EmDashEntry, site: Site, astro: AstroI18n | null, expected?: string | null) {
	const theirs = await emdashPath(c, e, site, astro);
	assert.equal(ours(c, e, site, astro), theirs, label);
	if (expected !== undefined) assert.equal(theirs, expected, `${label} (EmDash)`);
}

const SITE: Site = { url: "https://example.com", locale: "en", trailingSlash: "ignore" };
const posts = collection("posts");

test("no i18n: patterns, slug and id encoding, date tokens, slashes", async () => {
	await same("plain", posts, entry("posts", "hello"), SITE, null, "/posts/hello");
	await same("no pattern", collection("blog posts", { urlPattern: null }), entry("blog posts", "a b"), SITE, null, "/blog%20posts/a%20b");
	await same("encoded slug", posts, entry("posts", "über/café ?#"), SITE, null);
	await same("id token", collection("docs", { urlPattern: "/d/{id}/{slug}" }), entry("docs", "x", { id: "id/1 2" }), SITE, null);
	const dated = collection("news", { urlPattern: "/{year}/{month}/{day}/{hour}{minute}{second}/{slug}.html" });
	await same("offsetless date", dated, entry("news", "n", { publishedAt: "2023-05-08 01:02:03" }), SITE, null, "/2023/05/08/010203/n.html");
	await same("iso date", dated, entry("news", "n", { publishedAt: "2024-12-31T23:59:59.000Z" }), SITE, null);
	await same("offset date", dated, entry("news", "n", { publishedAt: "2024-01-01T01:00:00+02:00" }), SITE, null);
	await same("no date", dated, entry("news", "n", { publishedAt: null }), SITE, null);
	await same("bad date", dated, entry("news", "n", { publishedAt: "soon" }), SITE, null);
	await same("double and trailing slashes", collection("p", { urlPattern: "p//{slug}//" }), entry("p", "x"), SITE, null, "/p/x");
	await same("root pattern", collection("home", { urlPattern: "/" }), entry("home", "x"), { ...SITE, trailingSlash: "always" }, null, "/");
	await same("empty pattern", collection("home", { urlPattern: "" }), entry("home", "x"), SITE, null);
	for (const trailingSlash of ["always", "never", "ignore", undefined] as const) {
		await same(`trailingSlash ${trailingSlash}`, posts, entry("posts", "a"), { ...SITE, trailingSlash }, null);
		await same(`trailingSlash ${trailingSlash}, pattern ending in /`, collection("q", { urlPattern: "/q/{slug}/" }), entry("q", "a"), { ...SITE, trailingSlash }, null);
	}
});

test("no i18n: what getPublicUrl turns down", async () => {
	await same("draft", posts, entry("posts", "a", { status: "draft" }), SITE, null, null);
	await same("scheduled", posts, entry("posts", "a", { status: "scheduled" }), SITE, null, null);
	await same("no slug", posts, entry("posts", null), SITE, null, null);
	await same("empty slug", posts, entry("posts", ""), SITE, null, null);
	await same("not routable", collection("authors", { routable: false }), entry("authors", "a"), SITE, null, null);
});

const STRINGS: AstroI18n = { defaultLocale: "en", locales: ["en", "fr", "pt-br"] };
const CUSTOM: AstroI18n = { defaultLocale: "en", locales: [{ path: "english", codes: ["en", "en-US"] }, "fr", { path: "portugues", codes: ["pt-BR"] }] };

test("i18n: locale prefixes, default locale, unknown locales", async () => {
	for (const [name, astro] of [
		["strings", STRINGS],
		["strings, prefixed default", { ...STRINGS, routing: { prefixDefaultLocale: true } }],
		["custom paths", CUSTOM],
		["custom paths, prefixed default", { ...CUSTOM, routing: { prefixDefaultLocale: true } }],
		["one locale", { defaultLocale: "en", locales: ["en"] }],
	] as Array<[string, AstroI18n]>) {
		for (const locale of [null, "en", "fr", "pt-br", "english", "portugues", "de"]) {
			for (const trailingSlash of ["always", "never"] as const) {
				const label = `${name}, locale ${locale}, ${trailingSlash}`;
				await same(label, posts, entry("posts", "hola", { locale }), { ...SITE, trailingSlash }, astro);
				await same(`${label}, root`, collection("home", { urlPattern: "/" }), entry("home", "x", { locale }), { ...SITE, trailingSlash }, astro);
			}
		}
	}
	await same("fr prefix", posts, entry("posts", "a", { locale: "fr" }), SITE, STRINGS, "/fr/posts/a");
	await same("default not prefixed", posts, entry("posts", "a", { locale: "en" }), SITE, STRINGS, "/posts/a");
	await same("unknown locale dropped", posts, entry("posts", "a", { locale: "de" }), SITE, STRINGS, null);
	await same("custom path", posts, entry("posts", "a", { locale: "portugues" }), SITE, CUSTOM, "/portugues/posts/a");
	await same("site locale fills a null locale", posts, entry("posts", "a", { locale: null }), { ...SITE, locale: "fr" }, STRINGS, "/fr/posts/a");
});

test("with urlRules, a build lists pages and makes no query per entry", async () => {
	const entries = Array.from({ length: 250 }, (_, i) => entry("posts", `p${i}`, { locale: i % 2 ? "fr" : null }));
	const fake = createFakeContent({ collections: [posts], entries, pageSize: 100, urlRules: urlRulesFrom(SITE, normalizeAstroI18n(STRINGS)) });
	const out = await collectRecords({ content: fake.content, schema: fake.schema }, {});
	assert.equal(out.byLocale.en.length, 125);
	assert.equal(out.byLocale.fr.length, 125);
	assert.equal(out.byLocale.fr[0].url, "/fr/posts/p1");
	const ops = (op: string) => fake.calls.filter((c) => c.op === op).length;
	assert.equal(ops("publicPath"), 0, "no per-entry lookups");
	assert.equal(ops("list"), 3, "one list call per 100 entries");
	assert.equal(ops("urlRules"), 1, "rules read once per build");
});
