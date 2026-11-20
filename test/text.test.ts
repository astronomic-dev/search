import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, foldText, squash } from "../src/core/text.ts";

test("foldText strips marks and lowercases, like the engine's processTerm", () => {
	assert.equal(foldText("Café Déjà Vu"), "cafe deja vu");
	assert.equal(foldText("ÅNGSTRÖM"), "angstrom");
});

test("squash collapses whitespace and trims", () => {
	assert.equal(squash("  a \n\t b   c "), "a b c");
});

test("clip keeps short text and cuts long text on a word boundary with an ellipsis", () => {
	assert.equal(clip("short text", 20), "short text");
	assert.equal(clip("one two three four five six", 15), "one two three…");
	assert.equal(clip("  spaced   out  ", 20), "spaced out");
	// No space late enough: a hard cut.
	assert.equal(clip("abcdefghijklmnopqrstuvwxyz", 10), "abcdefghij…");
});
