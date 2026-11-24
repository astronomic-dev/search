import assert from "node:assert/strict";
import { test } from "node:test";
import { LIVE, qualifies, startTakeover, type FormShape, type TakeoverRule } from "../src/browser/embed/takeover.ts";
import type { EmbedConfig } from "../src/browser/config.ts";

/** A fake control: what qualifies() reads from a form control. */
interface Control {
	localName: string;
	type?: string;
	name: string;
	disabled?: boolean;
	attrs?: string[];
}

const input = (name: string, type = "search"): Control => ({ localName: "input", type, name });
const button = (name: string, attrs: string[] = [], type = "submit"): Control => ({ localName: "button", type, name, attrs });
const hidden = (name: string): Control => input(name, "hidden");

/** A fake form shape. `inside` lists the selectors the form matches or is inside. */
function form(o: { elements?: Control[]; method?: string; target?: string; action?: string; inside?: string[] } = {}): FormShape {
	return {
		elements: (o.elements ?? [input("s"), button("")]).map((c) => ({ ...c, type: c.type ?? "text", disabled: !!c.disabled, hasAttribute: (a: string) => (c.attrs ?? []).includes(a) })) as unknown as HTMLInputElement[],
		method: o.method ?? "get",
		target: o.target ?? "",
		action: o.action ?? "https://example.com/",
		in: (sel: string) => (o.inside ?? []).includes(sel),
	};
}

const rule: TakeoverRule = { enabled: true, inputName: "s", skip: ".no-zing", allowFields: ["lang"], results: "https://example.com/" };

test("qualifies: a plain theme search form (one search input and an unnamed button)", () => {
	assert.equal(!!qualifies(form(), rule), true);
	assert.equal(!!qualifies(form({ elements: [input("s", "text")] }), rule), true);
});

test("qualifies returns the form's field (the one control named inputName)", () => {
	const f = form({ elements: [hidden("lang"), input("s"), button("")] });
	assert.equal((qualifies(f, rule) as unknown as Control).name, "s");
	assert.equal(qualifies(f, rule), f.elements[1]);
});

test("qualifies (a): exactly one control named inputName, and it is a search or text input", () => {
	assert.equal(!!qualifies(form({ elements: [] }), rule), false);
	assert.equal(!!qualifies(form({ elements: [input("q")] }), rule), false);
	assert.equal(!!qualifies(form({ elements: [input("s"), input("s")] }), rule), false);
	// A disabled second control with that name still counts.
	assert.equal(!!qualifies(form({ elements: [input("s"), { ...input("s"), disabled: true }] }), rule), false);
	assert.equal(!!qualifies(form({ elements: [input("s"), { ...input("s", "hidden"), disabled: true }] }), rule), false);
	assert.equal(!!qualifies(form({ elements: [input("s", "email")] }), rule), false);
	assert.equal(!!qualifies(form({ elements: [{ localName: "textarea", type: "textarea", name: "s" }] }), rule), false);
	assert.equal(!!qualifies(form({ elements: [{ localName: "select", type: "select-one", name: "s" }] }), rule), false);
});

test("qualifies (b): every other named, enabled control is a hidden input in allowFields", () => {
	assert.equal(!!qualifies(form({ elements: [input("s"), { localName: "select", type: "select-one", name: "cat" }] }), rule), false);
	assert.equal(!!qualifies(form({ elements: [input("s"), input("cat", "text")] }), rule), false);
	// Unnamed or disabled controls do not count.
	assert.equal(!!qualifies(form({ elements: [input("s"), { localName: "select", type: "select-one", name: "" }] }), rule), true);
	assert.equal(!!qualifies(form({ elements: [input("s"), { localName: "select", type: "select-one", name: "cat", disabled: true }] }), rule), true);
});

test("qualifies allowFields: a hidden lang qualifies, a hidden post_type does not", () => {
	assert.equal(!!qualifies(form({ elements: [input("s"), hidden("lang")] }), rule), true);
	assert.equal(!!qualifies(form({ elements: [input("s"), hidden("post_type")] }), rule), false);
	assert.equal(!!qualifies(form({ elements: [input("s"), hidden("post_type")] }), { ...rule, allowFields: ["post_type"] }), true);
});

test("qualifies: a named submit button with no overrides is allowed (it only adds name=value to the query)", () => {
	assert.equal(!!qualifies(form({ elements: [input("s"), button("submit")] }), rule), true);
	assert.equal(!!qualifies(form({ elements: [input("s"), { localName: "input", type: "submit", name: "submit" }] }), rule), true);
});

test("qualifies: a named submit button with formaction, formmethod or formtarget, or a named non-submit button, disqualifies", () => {
	for (const a of ["formaction", "formmethod", "formtarget"]) assert.equal(!!qualifies(form({ elements: [input("s"), button("go", [a])] }), rule), false, a);
	assert.equal(!!qualifies(form({ elements: [input("s"), button("go", [], "button")] }), rule), false);
	assert.equal(!!qualifies(form({ elements: [input("s"), button("go", [], "reset")] }), rule), false);
	assert.equal(!!qualifies(form({ elements: [input("s"), { localName: "input", type: "button", name: "go" }] }), rule), false);
});

test("qualifies (c): the form matches skip, or is inside it", () => {
	assert.equal(!!qualifies(form({ inside: [".no-zing"] }), rule), false);
});

test("qualifies (d): the form is inside a placement", () => {
	assert.equal(!!qualifies(form({ inside: ["[data-search-placement]"] }), rule), false);
});

test("qualifies (e): GET, no other target, and the action is the results URL's origin and path", () => {
	assert.equal(!!qualifies(form({ method: "post" }), rule), false);
	assert.equal(!!qualifies(form({ method: "dialog" }), rule), false);
	assert.equal(!!qualifies(form({ target: "_blank" }), rule), false);
	assert.equal(!!qualifies(form({ target: "results" }), rule), false);
	assert.equal(!!qualifies(form({ target: "_self" }), rule), true);
	assert.equal(!!qualifies(form({ action: "https://example.com/shop/" }), rule), false);
	assert.equal(!!qualifies(form({ action: "https://other.example/" }), rule), false);
	assert.equal(!!qualifies(form({ action: "http://example.com/" }), rule), false);
	// The action's query and hash do not count (a GET submit replaces the query).
	assert.equal(!!qualifies(form({ action: "https://example.com/?lang=fr" }), rule), true);
	// An empty action is the page's own URL, which the form's action property already gives.
	assert.equal(!!qualifies(form({ action: "https://example.com/" }), { ...rule, results: "https://example.com/" }), true);
	// A malformed action does not qualify, and does not throw.
	assert.equal(!!qualifies(form({ action: "http://[" }), rule), false);
});

test("qualifies (f): takeover off, or standDown set", () => {
	assert.equal(!!qualifies(form(), { ...rule, enabled: false }), false);
	assert.equal(!!qualifies(form(), { ...rule, standDown: "Astra Pro" }), false);
});

/**
 * EmDash's LiveSearch box: an input with no form and no name. Fake DOM classes, as node has none; `inside` lists the
 * selectors the field is inside.
 */
function liveDoc() {
	class FakeInput {
		form = null;
		name = "";
		placeholder = "Search";
		readOnly = false;
		ariaHasPopup: string | null = null;
		dataset: Record<string, string> = {};
		live: boolean;
		inside: string[];
		constructor(live: boolean, inside: string[] = []) {
			this.live = live;
			this.inside = inside;
		}
		matches = (sel: string) => this.live && sel === LIVE;
		closest = (sel: string) => (this.inside.includes(sel) ? {} : null);
	}
	const g = globalThis as Record<string, unknown>;
	g.HTMLInputElement = FakeInput;
	g.HTMLFormElement ??= class {};
	const header = new FakeInput(true);
	const skipped = new FakeInput(true, [".no-zing"]);
	const filter = new FakeInput(false);
	const doc = { baseURI: "https://example.com/", querySelectorAll: (sel: string) => (sel.includes(LIVE) ? [header, skipped] : []) } as unknown as Document;
	return { doc, header, skipped, filter };
}

const liveConfig = (enabled: boolean) => ({ takeover: { ...rule, enabled }, results: "https://example.com/", standDown: null, strings: { placeholder: "Search the docs" } }) as unknown as EmbedConfig;

test("takeover on: the LiveSearch field (no form, no name) is taken and shows the placeholder; skip and other formless inputs stay native", () => {
	const { doc, header, skipped, filter } = liveDoc();
	const t = startTakeover(doc, liveConfig(true))!;
	assert.equal(header.placeholder, "Search the docs");
	assert.equal(skipped.placeholder, "Search");
	assert.equal(t.hit(header as unknown as Element), header);
	assert.equal(t.hit(skipped as unknown as Element), null);
	assert.equal(t.hit(filter as unknown as Element), null);
	assert.equal(filter.placeholder, "Search");
});

test("takeover off: the LiveSearch field is never touched", () => {
	const { doc, header } = liveDoc();
	assert.equal(startTakeover(doc, liveConfig(false)), null);
	assert.equal(header.placeholder, "Search");
});
