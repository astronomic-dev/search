import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeKv } from "./emdash/fake-kv.ts";
import { parseEmbedConfig } from "../src/browser/config.ts";
import { DEFAULT_SETTINGS, SETTINGS_KEY, checkSettings, configJson, readSettings, saveSettings } from "../src/emdash/core/settings.ts";
import { MANIFEST_PATH } from "../src/emdash/core/routes.ts";

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

test("settings: nothing saved gives the defaults", async () => {
	assert.deepEqual(await readSettings(createFakeKv()), DEFAULT_SETTINGS);
	assert.deepEqual(DEFAULT_SETTINGS, {
		keys: ["mod+k", "/"],
		takeover: { enabled: false, inputName: "q" },
		placeholder: "Search the site",
		theme: "auto",
		results: "/search",
	});
});

test("settings: good values are kept", () => {
	const good = { keys: ["ctrl+shift+f"], takeover: { enabled: true, inputName: "s[]" }, placeholder: "Find a part", theme: "dark", results: "https://example.com/find?x=1" };
	assert.deepEqual(checkSettings(good), good);
	assert.deepEqual(checkSettings({ keys: [] }).keys, [], "no shortcut keys is a choice");
});

test("settings: each bad value takes its default", () => {
	const bad = checkSettings({
		keys: ["mod+k", "not a key"],
		takeover: { enabled: "yes", inputName: "my query" },
		placeholder: "   ",
		theme: "blue",
		results: "javascript:alert(1)",
	});
	assert.deepEqual(bad, DEFAULT_SETTINGS);
	assert.deepEqual(checkSettings({ keys: "mod+k" }).keys, DEFAULT_SETTINGS.keys);
	assert.deepEqual(checkSettings({ keys: [1] }).keys, DEFAULT_SETTINGS.keys);
	assert.equal(checkSettings({ results: "//example.org/search" }).results, "/search");
	assert.equal(checkSettings({ results: "/se arch" }).results, "/search");
	assert.equal(checkSettings({ results: " JaVa\tscript:x" }).results, "/search");
	assert.equal(checkSettings({ placeholder: "x".repeat(200) }).placeholder, "Search the site");
	assert.deepEqual(checkSettings(null), DEFAULT_SETTINGS);
	assert.deepEqual(checkSettings("nope"), DEFAULT_SETTINGS);
});

test("settings: keys are cut to 2 and repeats dropped", () => {
	assert.deepEqual(checkSettings({ keys: ["mod+k", "mod+k", "/", "ctrl+j"] }).keys, ["mod+k", "/"]);
	assert.deepEqual(checkSettings({ keys: ["Mod+K", "/"] }).keys, ["mod+k", "/"]);
});

test("settings: save merges over what is saved, checks, and stores under `settings`", async () => {
	const kv = createFakeKv();
	const a = await saveSettings(kv, { placeholder: "Search parts", takeover: { enabled: true } });
	assert.equal(a.placeholder, "Search parts");
	assert.deepEqual(a.takeover, { enabled: true, inputName: "q" });
	const b = await saveSettings(kv, { theme: "light", placeholder: 7 });
	assert.equal(b.theme, "light");
	assert.equal(b.placeholder, "Search the site", "a bad value takes the default, not the old value");
	assert.equal(b.takeover.enabled, true);
	assert.deepEqual(await kv.get(SETTINGS_KEY), b);
	assert.deepEqual(await readSettings(kv), b);
});

test("settings: two concurrent saves of different fields both stick", async () => {
	const kv = createFakeKv();
	await Promise.all([saveSettings(kv, { theme: "dark" }), saveSettings(kv, { placeholder: "Find parts" })]);
	const s = await readSettings(kv);
	assert.equal(s.theme, "dark");
	assert.equal(s.placeholder, "Find parts");
});

test("settings: a save that loses the race merges onto the newer value and retries", async () => {
	const kv = createFakeKv({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, results: "/find" } });
	// Just before the theme save writes, another save changes the placeholder and the takeover input.
	kv.beforeCompareAndSet(async () => {
		await saveSettings(kv, { placeholder: "Find parts", takeover: { inputName: "s" } });
	});
	const out = await saveSettings(kv, { theme: "light", takeover: { enabled: true } });
	assert.equal(out.theme, "light");
	assert.equal(out.placeholder, "Find parts", "the other save's field is kept");
	assert.deepEqual(out.takeover, { enabled: true, inputName: "s" }, "takeover merges by field onto the newer value");
	assert.equal(out.results, "/find");
	assert.deepEqual(await readSettings(kv), out);
	assert.equal(kv.calls.filter((c) => c.op === "set").length, 0, "saves go through compareAndSet only");
});

test("settings: a save gives up after repeated conflicts", async () => {
	const kv = createFakeKv();
	const realCas = kv.compareAndSet.bind(kv);
	kv.compareAndSet = async (key) => {
		await realCas(key, (await kv.getVersioned(key))?.revision ?? null, { ...DEFAULT_SETTINGS, placeholder: "other" });
		return { applied: false };
	};
	await assert.rejects(saveSettings(kv, { theme: "dark" }), /changed too often/);
});

test("settings: a stored bad value is checked on read", async () => {
	const kv = createFakeKv({ [SETTINGS_KEY]: { theme: "blue", keys: ["/"] } });
	const s = await readSettings(kv);
	assert.equal(s.theme, "auto");
	assert.deepEqual(s.keys, ["/"]);
});

test("config tag: the defaults, under 400 bytes, pass the embed's parser", () => {
	const text = configJson(DEFAULT_SETTINGS);
	assert.ok(bytes(text) < 400, `${bytes(text)} bytes`);
	const parsed = parseEmbedConfig(text);
	assert.ok(parsed);
	assert.equal(parsed.manifest, MANIFEST_PATH);
	assert.equal(parsed.index, "default");
	assert.equal(parsed.results, "/search");
	assert.equal(parsed.queryParam, "q");
	assert.equal(parsed.paramPrefix, "");
	assert.deepEqual(parsed.keys, ["mod+k", "/"]);
	assert.equal(parsed.strings.placeholder, "Search the site");
	assert.equal(parsed.takeover.enabled, false);
	assert.equal(parsed.takeover.inputName, "q");
	assert.equal(parsed.theme, undefined, "auto leaves theme out");
	assert.equal("theme" in JSON.parse(text), false);
});

test("config tag: every setting reaches the embed", () => {
	const s = checkSettings({ keys: ["/"], takeover: { enabled: true, inputName: "s" }, placeholder: "Find", theme: "dark", results: "/find" });
	const parsed = parseEmbedConfig(configJson(s));
	assert.ok(parsed);
	assert.deepEqual(parsed.keys, ["/"]);
	assert.deepEqual([parsed.takeover.enabled, parsed.takeover.inputName], [true, "s"]);
	assert.equal(parsed.strings.placeholder, "Find");
	assert.equal(parsed.theme, "dark");
	assert.equal(parsed.results, "/find");
});

test("config tag: <, > and & are escaped, so a placeholder cannot close the tag", () => {
	const s = checkSettings({ placeholder: "</script><b>&amp;" });
	assert.equal(s.placeholder, "</script><b>&amp;");
	const text = configJson(s);
	assert.doesNotMatch(text, /[<>&]/);
	assert.equal(parseEmbedConfig(text)?.strings.placeholder, "</script><b>&amp;");
	assert.equal(JSON.parse(text).strings.placeholder, "</script><b>&amp;");
});
