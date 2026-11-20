import { test } from "node:test";
import assert from "node:assert/strict";
import { activeElementOf, ariaKeyshortcuts, isApple, isEditable, matchKey, shortcutAction, type KeyEventLike } from "../src/dom/shortcut.ts";

const body = { tagName: "BODY" };
const textInput = { tagName: "INPUT", type: "text" };
const searchInput = { tagName: "INPUT", type: "search" };
const checkbox = { tagName: "INPUT", type: "checkbox" };
const range = { tagName: "INPUT", type: "range" };
const textarea = { tagName: "TEXTAREA" };
const select = { tagName: "SELECT" };
const button = { tagName: "BUTTON" };
const editableChild = { tagName: "SPAN", isContentEditable: true };

function key(k: string, extra: Partial<KeyEventLike> = {}): KeyEventLike {
	const code = /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k === "/" ? "Slash" : "";
	return { key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: body, ...extra };
}

const keys = ["mod+k", "/"];

test("Cmd+K toggles on Apple, Ctrl+K elsewhere", () => {
	assert.equal(shortcutAction(key("k", { metaKey: true }), keys, true, false), "toggle");
	assert.equal(shortcutAction(key("k", { ctrlKey: true }), keys, false, false), "toggle");
	assert.equal(shortcutAction(key("k", { metaKey: true }), keys, true, true), "toggle");
});

test("Ctrl+K does nothing on Apple, Cmd+K does nothing elsewhere, bare k does nothing", () => {
	assert.equal(shortcutAction(key("k", { ctrlKey: true }), keys, true, false), null);
	assert.equal(shortcutAction(key("k", { metaKey: true }), keys, false, false), null);
	assert.equal(shortcutAction(key("k"), keys, true, false), null);
	assert.equal(shortcutAction(key("K", { metaKey: true, shiftKey: true }), keys, true, false), null);
});

test("/ opens from the body and from a button or checkbox", () => {
	assert.equal(shortcutAction(key("/"), keys, true, false), "open");
	assert.equal(shortcutAction(key("/", { target: button }), keys, false, false), "open");
	assert.equal(shortcutAction(key("/", { target: checkbox }), keys, false, false), "open");
});

test("/ does nothing in text fields; mod+k still toggles there", () => {
	for (const target of [textInput, searchInput, textarea, editableChild, select]) {
		assert.equal(shortcutAction(key("/", { target }), keys, true, false), null, target.tagName);
		assert.equal(shortcutAction(key("k", { metaKey: true, target }), keys, true, false), "toggle", target.tagName);
	}
});

test("/ does nothing in a text field inside a shadow root (the window sees the host as the target)", () => {
	const host = { tagName: "MY-FIELD" };
	for (const inner of [textInput, textarea, editableChild]) {
		const e = key("/", { target: host, composedPath: () => [inner, { tagName: "DIV" }, host, body] });
		assert.equal(shortcutAction(e, keys, true, false), null, inner.tagName);
		assert.equal(shortcutAction(key("k", { metaKey: true, target: host, composedPath: () => [inner, host] }), keys, true, false), "toggle");
	}
	// A shadow button is not a text field.
	assert.equal(shortcutAction(key("/", { target: host, composedPath: () => [button, host] }), keys, true, false), "open");
	// A press inside another open dialog (a second search dialog, say) belongs to that dialog.
	const other = { tagName: "DIALOG", open: true };
	assert.equal(shortcutAction(key("/", { target: host, composedPath: () => [button, other, host, body] }), keys, true, false), null);
	assert.equal(shortcutAction(key("/", { target: host, composedPath: () => [button, { tagName: "DIALOG", open: false }, host] }), keys, true, false), "open");
	// An empty path (the event has finished dispatching) falls back to the target.
	assert.equal(shortcutAction(key("/", { target: textInput, composedPath: () => [] }), keys, true, false), null);
});

test("activeElementOf walks open shadow roots to the focused element", () => {
	const inner = { tagName: "INPUT", shadowRoot: null };
	const mid = { tagName: "MY-INNER", shadowRoot: { activeElement: inner } };
	const host = { tagName: "MY-FIELD", shadowRoot: { activeElement: mid } };
	assert.equal(activeElementOf({ activeElement: host } as unknown as Document), inner);
	const closed = { tagName: "MY-CLOSED", shadowRoot: null };
	assert.equal(activeElementOf({ activeElement: closed } as unknown as Document), closed);
	assert.equal(activeElementOf({ activeElement: null } as unknown as Document), null);
});

test("/ with a modifier does nothing", () => {
	assert.equal(shortcutAction(key("/", { shiftKey: true }), keys, true, false), null);
	assert.equal(shortcutAction(key("/", { ctrlKey: true }), keys, false, false), null);
	assert.equal(shortcutAction(key("/", { metaKey: true }), keys, true, false), null);
	assert.equal(shortcutAction(key("/", { altKey: true }), keys, true, false), null);
});

test("nothing happens during IME composition", () => {
	assert.equal(shortcutAction(key("k", { metaKey: true, isComposing: true }), keys, true, false), null);
	assert.equal(shortcutAction(key("/", { keyCode: 229 }), keys, true, false), null);
	assert.equal(shortcutAction(key("Process", { keyCode: 229, metaKey: true, code: "KeyK" }), keys, true, false), null);
});

test("no keys (shortcut: false) does nothing", () => {
	assert.equal(shortcutAction(key("k", { metaKey: true }), [], true, false), null);
	assert.equal(shortcutAction(key("/"), [], true, false), null);
});

test("a non-Latin layout matches mod+k by code", () => {
	assert.equal(shortcutAction(key("л", { code: "KeyK", metaKey: true }), keys, true, false), "toggle");
	assert.equal(shortcutAction(key("л", { code: "KeyK", ctrlKey: true }), keys, false, false), "toggle");
	// A Latin layout that puts another letter on the K key (Dvorak "t") does not match.
	assert.equal(matchKey(key("t", { code: "KeyK", metaKey: true }), "mod+k", true), false);
});

test("isEditable", () => {
	assert.equal(isEditable(textInput), true);
	assert.equal(isEditable({ tagName: "INPUT" }), true);
	assert.equal(isEditable({ tagName: "INPUT", type: "email" }), true);
	assert.equal(isEditable(textarea), true);
	assert.equal(isEditable(select), true);
	assert.equal(isEditable(editableChild), true);
	assert.equal(isEditable(checkbox), false);
	assert.equal(isEditable(range), false);
	assert.equal(isEditable({ tagName: "INPUT", type: "button" }), false);
	assert.equal(isEditable(button), false);
	assert.equal(isEditable(body), false);
	assert.equal(isEditable(null), false);
	assert.equal(isEditable(undefined), false);
});

test("aria-keyshortcuts text and platform", () => {
	assert.equal(ariaKeyshortcuts(keys, true), "Meta+K /");
	assert.equal(ariaKeyshortcuts(keys, false), "Control+K /");
	assert.equal(ariaKeyshortcuts([], true), "");
	assert.equal(isApple({ platform: "MacIntel" }), true);
	assert.equal(isApple({ platform: "iPhone" }), true);
	assert.equal(isApple({ userAgentData: { platform: "macOS" } }), true);
	assert.equal(isApple({ platform: "Win32" }), false);
	assert.equal(isApple({ platform: "Linux x86_64" }), false);
});
