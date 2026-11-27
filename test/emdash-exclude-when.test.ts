import assert from "node:assert/strict";
import { test } from "node:test";
import { minisearchEngine } from "../src/core/minisearch.ts";
import type { IndexFile } from "../src/core/types.ts";
import { runIfDue } from "../src/emdash/core/build.ts";
import { checkExcludeWhen, excludeWhenPaths } from "../src/emdash/core/exclude-when.ts";
import type { CollectionInfo, ExcludeWhen, PluginOptions, SearchPorts } from "../src/emdash/core/ports.ts";
import { collectRecords } from "../src/emdash/core/records.ts";
import { QUIET_MS, countsAsChange, markDirty, onContentEvent } from "../src/emdash/core/refresh.ts";
import { readIndex, readState } from "../src/emdash/core/store.ts";
import { search } from "../src/emdash/index.ts";
import { collection, createFakeContent, entry, type FakeContentInput } from "./emdash/fake-content.ts";
import { createFakeKv } from "./emdash/fake-kv.ts";

const details = (fields = ["switch_areas"]): CollectionInfo => collection("details", { supports: [], routable: false, urlPattern: null, fields });
const RULE: ExcludeWhen = { collection: "details", field: "switch_areas", values: ["off"], paths: ["/areas", "/areas/*"] };
const site = (switchValue: unknown, over: FakeContentInput = {}): FakeContentInput => ({
	collections: [collection("areas"), collection("posts"), details()],
	entries: [
		entry("areas", "dayton"),
		entry("posts", "hello"),
		...(switchValue === "none" ? [] : [entry("details", "details", { data: switchValue === "absent" ? {} : { switch_areas: switchValue } })]),
	],
	pageSize: 50,
	...over,
});

async function urls(input: FakeContentInput, options: PluginOptions = { excludeWhen: [RULE] }) {
	const fake = createFakeContent(input);
	const out = await collectRecords({ content: fake.content, schema: fake.schema }, options);
	return { urls: Object.values(out.byLocale).flat().map((r) => r.url).sort(), warnings: out.warnings, calls: fake.calls };
}

// ---------------------------------------------------------------------------
// The option check
// ---------------------------------------------------------------------------

test("search() takes excludeWhen as JSON", () => {
	assert.deepEqual(JSON.parse(JSON.stringify(search({ excludeWhen: [RULE] }).options)), { excludeWhen: [RULE] });
	assert.doesNotThrow(() => checkExcludeWhen([{ ...RULE, values: ["off", "preset", null, 0, false] }]));
	assert.doesNotThrow(() => checkExcludeWhen([]));
});

test("search() throws on a bad excludeWhen", () => {
	const bad: Array<[unknown, RegExp]> = [
		[RULE, /excludeWhen must be a list of rules/],
		[[null], /excludeWhen\[0\] must be an object/],
		[[{ ...RULE, when: "off" }], /unknown key "when"/],
		[[{ ...RULE, collection: "" }], /excludeWhen\[0\]\.collection must be a collection slug/],
		[[{ ...RULE, field: 3 }], /excludeWhen\[0\]\.field must be a field slug/],
		[[{ ...RULE, values: [] }], /excludeWhen\[0\]\.values must be a list/],
		[[{ ...RULE, values: "off" }], /excludeWhen\[0\]\.values must be a list/],
		[[{ ...RULE, values: [["off"]] }], /excludeWhen\[0\]\.values must be a list/],
		[[{ ...RULE, paths: [] }], /excludeWhen\[0\]\.paths must be a list of site paths/],
		[[{ ...RULE, paths: ["areas"] }], /excludeWhen\[0\]\.paths must be a list of site paths/],
		[[RULE, { ...RULE, paths: ["/x?y"] }], /excludeWhen\[1\]\.paths/],
	];
	for (const [value, error] of bad) assert.throws(() => search({ excludeWhen: value } as never), error, JSON.stringify(value));
	assert.throws(() => search({ excludeWhen: [{ ...RULE, values: [undefined] }] } as never), /plain JSON/);
});

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

test("a switch set to a listed value leaves the paths out; another value leaves them in", async () => {
	const off = await urls(site("off"));
	assert.deepEqual(off.urls, ["/posts/hello"]);
	assert.deepEqual(off.warnings, []);
	const on = await urls(site("on"));
	assert.deepEqual(on.urls, ["/areas/dayton", "/posts/hello"]);
	assert.deepEqual(on.warnings, []);
});

test("one read of the switch collection per build, before the indexed collections, also for two rules", async () => {
	const rules = [RULE, { ...RULE, values: ["preset"], paths: ["/posts/*"] }];
	const out = await urls(site("off"), { excludeWhen: rules });
	const lists = out.calls.filter((c) => c.op === "list").map((c) => c.collection);
	assert.deepEqual(lists, ["details", "areas", "posts"]);
	assert.deepEqual(out.urls, ["/posts/hello"]);
});

test("no published entry and an empty field read as null", async () => {
	const nullable = { excludeWhen: [{ ...RULE, values: ["off", null] }] };
	for (const state of ["none", "absent", null]) {
		assert.deepEqual((await urls(site(state))).urls, ["/areas/dayton", "/posts/hello"], `${state}: null is not listed`);
		const out = await urls(site(state), nullable);
		assert.deepEqual(out.urls, ["/posts/hello"], `${state}: null is listed`);
		assert.deepEqual(out.warnings, []);
	}
	// A draft switch entry is not read: only published entries count.
	const draft = site("none");
	draft.entries!.push(entry("details", "details", { status: "draft", data: { switch_areas: "off" } }));
	assert.deepEqual((await urls(draft)).urls, ["/areas/dayton", "/posts/hello"]);
});

test("the first published entry in EmDash's list order is read; a second is a warning", async () => {
	const input = site("on");
	// The port lists newest first (EmDash's default order); the theme takes the same first entry.
	input.entries!.splice(2, 0, entry("details", "newer", { data: { switch_areas: "off" } }));
	const out = await urls(input);
	assert.deepEqual(out.urls, ["/posts/hello"]);
	assert.equal(out.warnings.length, 1);
	assert.match(out.warnings[0]!, /"details" has more than one published entry; the newest is read/);
});

test("a missing collection, a missing field or a value that is not one value: a warning, nothing left out", async () => {
	const noCollection = await urls(site("off"), { excludeWhen: [{ ...RULE, collection: "settings" }] });
	assert.deepEqual(noCollection.urls, ["/areas/dayton", "/posts/hello"]);
	assert.match(noCollection.warnings.join("\n"), /there is no collection "settings"; this rule leaves nothing out/);

	const noField = await urls(site("off"), { excludeWhen: [{ ...RULE, field: "switch_blog" }] });
	assert.deepEqual(noField.urls, ["/areas/dayton", "/posts/hello"]);
	assert.match(noField.warnings.join("\n"), /"details" has no field "switch_blog"/);
	assert.ok(!noField.calls.some((c) => c.op === "list" && c.collection === "details"), "no read for a rule that cannot match");

	for (const value of [["off"], { value: "off" }]) {
		const invalid = await urls(site(value));
		assert.deepEqual(invalid.urls, ["/areas/dayton", "/posts/hello"]);
		assert.match(invalid.warnings.join("\n"), /holds .*, not one string, number or boolean; this rule leaves nothing out/);
	}
});

test("excludeWhen joins exclude, and a left-out path gets no list page either", async () => {
	const input = (value: string) => {
		const out = site(value, { collections: [collection("areas"), collection("posts"), collection("pages", { urlPattern: "/{slug}" }), details()] });
		out.entries!.push(entry("pages", "about"));
		return out;
	};
	const options: PluginOptions = { exclude: ["/about"], excludeWhen: [RULE], listPages: [{ path: "/areas", from: [{ collection: "areas", fields: ["title"] }], fallback: { title: "Areas" } }] };
	assert.deepEqual((await urls(input("off"), options)).urls, ["/posts/hello"]);
	assert.deepEqual((await urls(input("on"), options)).urls, ["/areas", "/areas/dayton", "/posts/hello"]);
});

test("a path with no locale prefix is left out in every locale", async () => {
	const input = site("off", { urlRules: { siteLocale: "en", i18n: { defaultLocale: "en", locales: ["en", "es"] } } });
	input.entries!.push(entry("areas", "dayton", { id: "es-dayton", locale: "es" }));
	assert.deepEqual((await urls(input)).urls, ["/posts/hello"]);
});

test("a failed read throws, naming the collection", async () => {
	const fake = createFakeContent(site("off"));
	const list = fake.content.list;
	fake.content.list = async (name, cursor) => {
		if (name === "details") throw new Error("D1_ERROR: no such table");
		return list(name, cursor);
	};
	await assert.rejects(excludeWhenPaths(fake.content, await fake.schema.listCollections(), [RULE], []), /excludeWhen: the "details" entry could not be read \(D1_ERROR: no such table\); the live index stays/);
});

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

function rig(input: FakeContentInput) {
	const fc = createFakeContent(input);
	const kv = createFakeKv();
	const clock = { now: Date.UTC(2026, 10, 27, 12) };
	const logs: string[] = [];
	const log = (message: string) => void logs.push(message);
	const p: SearchPorts = { kv, content: fc.content, schema: fc.schema, log: { info: log, warn: log, error: log }, queue: async () => {}, defer: () => {}, now: () => clock.now };
	return { p, fc, kv, clock, logs };
}

async function builtUrls(p: SearchPorts): Promise<string[]> {
	const { state } = await readState(p.kv);
	const json = await readIndex(p.kv, state, state.active!.version, "en");
	return minisearchEngine
		.load(JSON.parse(json!) as IndexFile)
		.records()
		.map((r) => r.url ?? "")
		.sort();
}

test("a build reads the switch: off drops the paths, on brings them back", async () => {
	const r = rig(site("on"));
	const options = { excludeWhen: [RULE] };
	assert.equal((await runIfDue(r.p, options, "tick")).ok, true);
	assert.deepEqual(await builtUrls(r.p), ["/areas/dayton", "/posts/hello"]);
	const sw = (await r.fc.content.list("details")).items[0]!;
	r.fc.put({ ...sw, data: { switch_areas: "off" } });
	await markDirty(r.p);
	r.clock.now += QUIET_MS;
	assert.equal((await runIfDue(r.p, options, "tick")).ok, true);
	assert.deepEqual(await builtUrls(r.p), ["/posts/hello"]);
});

test("a read error fails the build and keeps the last good index; the next build tries again", async () => {
	const r = rig(site("off"));
	const options = { excludeWhen: [RULE] };
	assert.equal((await runIfDue(r.p, options, "tick")).ok, true);
	const good = (await readState(r.kv)).state.active!.version;
	const list = r.fc.content.list;
	let broken = true;
	r.fc.content.list = async (name, cursor) => {
		if (broken && name === "details") throw new Error("database is locked");
		return list(name, cursor);
	};
	const sw = (await list("details")).items[0]!;
	r.fc.put({ ...sw, data: { switch_areas: "on" } });
	await markDirty(r.p);
	r.clock.now += QUIET_MS;
	const failed = await runIfDue(r.p, options, "tick");
	assert.equal(failed.ok, false);
	assert.equal(!failed.ok && failed.code, "error");
	const s = (await readState(r.kv)).state;
	assert.equal(s.active?.version, good, "the live index stays");
	assert.deepEqual(await builtUrls(r.p), ["/posts/hello"], "the off part stays out");
	assert.ok(s.dirty > s.builtGen, "still due, so the next tick retries");
	broken = false;
	r.clock.now += 60_000;
	assert.equal((await runIfDue(r.p, options, "tick")).ok, true);
	assert.deepEqual(await builtUrls(r.p), ["/areas/dayton", "/posts/hello"]);
});

// ---------------------------------------------------------------------------
// The change count
// ---------------------------------------------------------------------------

test("a change to a switch collection counts, also when collections are listed", async () => {
	const options: PluginOptions = { collections: ["areas", "posts"], excludeWhen: [RULE] };
	assert.equal(countsAsChange("afterSave", { collection: "details", content: { status: "published" } }, options), true);
	assert.equal(countsAsChange("afterSave", { collection: "details", content: { status: "draft" }, isNew: false }, options), true);
	assert.equal(countsAsChange("afterPublish", { collection: "details", content: {} }, options), true);
	assert.equal(countsAsChange("afterPublish", { collection: "details", content: {} }, { collections: ["areas", "posts"] }), false);
	assert.equal(countsAsChange("afterPublish", { collection: "menus", content: {} }, options), false);
	const r = rig(site("on"));
	assert.equal(await onContentEvent(r.p, "afterSave", { collection: "details", content: { status: "published" } }, options), true);
	assert.equal((await readState(r.kv)).state.dirty, 1);
});
