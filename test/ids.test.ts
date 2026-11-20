import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdFor, idFor } from "../src/dom/ids.ts";

const valid = /^[A-Za-z][A-Za-z0-9_-]*$/;

test("idFor is stable and a valid HTML id", () => {
	for (const id of ["docs/intro", "docs/intro#install", "learn/Ünïcode héadings", "a b\tc", "", "#", "123"]) {
		const a = idFor("s", id);
		assert.equal(a, idFor("s", id));
		assert.match(a, valid, a);
	}
	assert.match(idFor("", "x"), valid);
	assert.match(idFor("9bad prefix", "x"), valid);
});

test("idFor keeps a readable part and the prefix", () => {
	const a = idFor("search-opt", "docs/intro#install");
	assert.ok(a.startsWith("search-opt-docs-intro-install-"), a);
});

test("different record ids rarely collide, even when they sanitize the same", () => {
	const ids = ["a/b", "a-b", "a b", "a_b", "a#b", "a.b", "A/B", "a//b", "docs/x#h", "docs/x#h2", "docs/x"];
	const out = new Set(ids.map((id) => idFor("s", id)));
	assert.equal(out.size, ids.length);
	const many = new Set<string>();
	for (let i = 0; i < 5000; i++) many.add(idFor("s", `docs/page-${i}#heading-${i % 7}`));
	assert.equal(many.size, 5000);
});

test("long ids stay short", () => {
	const a = idFor("s", "x".repeat(500));
	assert.ok(a.length < 70, String(a.length));
});

// Two record ids with the same readable part and the same 32-bit hash (found by search).
const clashA = "docs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/28387";
const clashB = "docs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/540070";

test("a hash collision is possible: idFor alone gives two records one id", () => {
	assert.equal(idFor("s", clashA), idFor("s", clashB));
});

test("createIdFor: a colliding record id gets a suffix; ids stay stable", () => {
	const ids = createIdFor("s");
	const a = ids(clashA);
	const b = ids(clashB);
	assert.equal(a, idFor("s", clashA));
	assert.notEqual(a, b);
	assert.match(b, valid);
	assert.equal(ids(clashB), b);
	assert.equal(ids(clashA), a);
	assert.equal(ids("docs/intro"), idFor("s", "docs/intro"));
});
