import { test } from "node:test";
import assert from "node:assert/strict";
import { specOf } from "../src/emdash/admin/keys.ts";
import { matchKey, shortcutAction, type KeyEventLike } from "../src/dom/shortcut.ts";
import { checkSettings, DEFAULT_SETTINGS } from "../src/emdash/core/settings.ts";

function press(key: string, extra: Partial<KeyEventLike> = {}): KeyEventLike {
	const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key === "/" || key === "?" ? "Slash" : key === " " ? "Space" : "";
	return { key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: { tagName: "BODY" }, ...extra };
}

/** Records the press, saves it through the settings check, and runs the same press through the real shortcut. */
function roundTrip(e: KeyEventLike, apple: boolean): string | null {
	const spec = specOf(e, apple);
	if (spec === null) return null;
	const saved = checkSettings({ ...DEFAULT_SETTINGS, keys: [spec] }).keys;
	assert.deepEqual(saved, [spec], `the save keeps ${spec}`);
	assert.ok(matchKey(e, spec, apple), `${spec} matches its own press`);
	assert.ok(shortcutAction(e, saved, apple, false), `${spec} opens the search`);
	return spec;
}

test("Shift+K records shift+k, and the runtime matches it", () => {
	for (const apple of [true, false]) assert.equal(roundTrip(press("K", { shiftKey: true }), apple), "shift+k");
	assert.equal(matchKey(press("k"), "shift+k", true), false);
});

test("mod+/ is Cmd on Apple and Ctrl elsewhere; the other modifier is named", () => {
	assert.equal(roundTrip(press("/", { metaKey: true }), true), "mod+/");
	assert.equal(roundTrip(press("/", { ctrlKey: true }), false), "mod+/");
	assert.equal(roundTrip(press("k", { ctrlKey: true }), true), "ctrl+k");
	assert.equal(roundTrip(press("k", { metaKey: true }), false), "meta+k");
	assert.equal(roundTrip(press("k", { metaKey: true }), true), "mod+k");
});

test("Shift+/ records shift+?, a bare / and named keys record as is", () => {
	assert.equal(roundTrip(press("?", { shiftKey: true }), true), "shift+?");
	assert.equal(roundTrip(press("/"), true), "/");
	assert.equal(roundTrip(press("F1", { shiftKey: true }), false), "shift+f1");
	assert.equal(roundTrip(press("+", { shiftKey: true }), false), "shift++");
});

test("Space and a lone modifier record nothing (no saved spec can match Space)", () => {
	for (const apple of [true, false]) {
		assert.equal(specOf(press(" "), apple), null);
		assert.equal(specOf(press(" ", { ctrlKey: true }), apple), null);
		assert.equal(specOf(press("Shift", { shiftKey: true }), apple), null);
		assert.equal(specOf(press("Meta", { metaKey: true }), apple), null);
	}
});
