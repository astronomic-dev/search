import { test } from "node:test";
import assert from "node:assert/strict";
import { marked } from "../src/dom/index.ts";

/** A stand-in document: createElement, createTextNode, attributes and append are all marked() uses. */
class Text {
	readonly nodeType = 3;
	readonly data: string;
	constructor(data: string) {
		this.data = data;
	}
	get textContent(): string {
		return this.data;
	}
}
class El {
	readonly nodeType = 1;
	readonly attributes = new Map<string, string>();
	readonly childNodes: (El | Text)[] = [];
	readonly tagName: string;
	constructor(tagName: string) {
		this.tagName = tagName;
	}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, String(value));
	}
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	append(...nodes: (El | Text | string)[]) {
		for (const n of nodes) this.childNodes.push(typeof n === "string" ? new Text(n) : n);
	}
	get textContent(): string {
		return this.childNodes.map((n) => n.textContent).join("");
	}
}
const doc = {
	createElement: (tag: string) => new El(tag),
	createTextNode: (text: string) => new Text(text),
} as unknown as Document;

/** Each node as ["text", data] or ["mark", text]. */
const shape = (nodes: Node[]) => (nodes as unknown as (El | Text)[]).map((n) => (n instanceof El ? [n.tagName, n.textContent] : ["text", n.data]));

test("marked: each range becomes a <mark>, the rest stays text nodes", () => {
	assert.deepEqual(shape(marked(doc, "Install the theme", [[0, 7], [12, 17]])), [
		["mark", "Install"],
		["text", " the "],
		["mark", "theme"],
	]);
	assert.deepEqual(shape(marked(doc, "plain")), [["text", "plain"]]);
	assert.deepEqual(shape(marked(doc, "", [[0, 3]])), []);
});

test("marked: markup in the text stays text, never elements", () => {
	const nodes = marked(doc, "<b>bold</b> & more", [[3, 7]]);
	assert.deepEqual(shape(nodes), [
		["text", "<b>"],
		["mark", "bold"],
		["text", "</b> & more"],
	]);
	const mark = nodes[1] as unknown as El;
	assert.equal(mark.childNodes.length, 1);
	assert.ok(mark.childNodes[0] instanceof Text);
});

test("marked: overlapping, touching, unsorted, empty and out-of-range ranges are safe", () => {
	assert.deepEqual(shape(marked(doc, "abcdefghij", [[6, 9], [2, 5], [4, 7], [-4, 1], [9, 50], [3, 3], [8, 2]])), [
		["mark", "a"],
		["text", "b"],
		["mark", "cdefghij"],
	]);
	assert.deepEqual(shape(marked(doc, "abc", [[10, 20]])), [["text", "abc"]]);
	assert.deepEqual(shape(marked(doc, "abc", [[0, 1], [1, 2]])), [["mark", "ab"], ["text", "c"]]);
});

test("marked: a mark carries part=mark by default, or the attributes given", () => {
	const [def] = marked(doc, "word", [[0, 4]]) as unknown as El[];
	assert.equal(def!.getAttribute("part"), "mark");
	const [own] = marked(doc, "word", [[0, 4]], { class: "search-mark" }) as unknown as El[];
	assert.equal(own!.getAttribute("class"), "search-mark");
	assert.equal(own!.getAttribute("part"), null);
});
