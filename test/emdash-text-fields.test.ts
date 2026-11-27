/** `textFields`: more fields of an entry searched, per collection. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PageRecord, SearchRecord } from "../src/core/types.ts";
import { search } from "../src/emdash/index.ts";
import { fieldWords } from "../src/emdash/core/entry-text.ts";
import type { PluginOptions } from "../src/emdash/core/ports.ts";
import { collectRecords } from "../src/emdash/core/records.ts";
import { checkTextFields, TEXT_FIELDS_MAX } from "../src/emdash/core/text-fields.ts";
import { collection, createFakeContent, entry, portableText, type FakeContentInput } from "./emdash/fake-content.ts";

const collect = (input: FakeContentInput, options: PluginOptions = {}) => {
	const fake = createFakeContent(input);
	return collectRecords({ content: fake.content, schema: fake.schema }, options);
};
const records = (byLocale: Record<string, SearchRecord[]>) => Object.values(byLocale).flat() as PageRecord[];

const PROJECT_FIELDS = ["title", "summary", "problem", "approach", "result", "facts", "case_title", "case_lede", "case_blocks", "content"];
const projects = collection("projects", { fields: PROJECT_FIELDS });
const areas = collection("areas", { fields: ["title", "intro", "content"] });

/** A Groundcrew project with a case study (blocks of the theme's own types). */
const project = () =>
	entry("projects", "kitchen", {
		data: {
			title: "Kitchen and mudroom",
			summary: "A bearing wall out.",
			problem: "The wall carried the second floor.",
			approach: portableText("We set an LVL beam.", "Shored both sides."),
			result: "A flat ceiling.",
			facts: [{ label: "Time", value: "11 weeks" }],
			case_title: "Holly Springs kitchen",
			case_lede: "On a fixed price.",
			case_blocks: [
				{ _type: "text_image", _key: "k0", heading: "The wall", text: "An engineer sized the beam.", image: { provider: "local", id: "01ABC", mimeType: "image/webp", alt: "A beam" } },
				{ _type: "timeline", _key: "k1", heading: "Week by week", steps: [{ when: "Week 3", what: "Beam day" }] },
				{ _type: "list", _key: "k2", heading: "Tips", items: [{ label: "Pick appliances first." }] },
				{ _type: "link", _key: "k3", href: "https://example.com/x", url: "https://example.com/y", style: "big" },
			],
			content: portableText("Body text."),
		},
	});

test("textFields: named fields and a prefix follow the lead, in field order, before content", async () => {
	const out = await collect(
		{ collections: [projects, areas], entries: [project(), entry("areas", "dublin", { data: { title: "Dublin", intro: "We cover Dublin and Hilliard.", content: portableText("Area body.") } })] },
		{ textFields: { projects: ["problem", "approach", "result", "case_*"], areas: ["intro"] } },
	);
	const [p, a] = records(out.byLocale);
	assert.equal(
		p!.text,
		"A bearing wall out. The wall carried the second floor. · We set an LVL beam. Shored both sides. · A flat ceiling. · Holly Springs kitchen · On a fixed price. · The wall An engineer sized the beam. Week by week Week 3 Beam day Tips Pick appliances first. Body text.",
	);
	assert.equal(a!.text, "We cover Dublin and Hilliard. Area body.");
	assert.deepEqual(out.warnings, []);
});

test("textFields: without the option, nothing changes", async () => {
	const out = await collect({ collections: [projects], entries: [project()] });
	assert.equal(records(out.byLocale)[0]!.text, "A bearing wall out. Body text.");
});

test("textFields: a missing field, an empty prefix, a field read already and a collection not searched are warnings", async () => {
	const out = await collect(
		{ collections: [projects, collection("team", { supports: [] })], entries: [project()] },
		{ textFields: { projects: ["problem", "outcome", "zz_*", "content"], team: ["bio"], nope: ["x"] } },
	);
	assert.equal(records(out.byLocale)[0]!.text, "A bearing wall out. The wall carried the second floor. Body text.");
	assert.deepEqual(out.warnings, [
		'Search: textFields: the collection "projects" has no field "outcome"; it is left out',
		'Search: textFields: the collection "projects" has no field that starts with "zz_"; "zz_*" adds nothing',
		'Search: textFields: "projects" field "content" is searched already; it is left out of textFields',
		'Search: textFields: the collection "team" is not searched; its fields are left out',
		'Search: textFields: there is no collection "nope"; its fields are left out',
	]);
});

test("textFields: the lead field is not added twice; a prefix skips the fields the record reads", async () => {
	const out = await collect(
		{ collections: [collection("posts", { fields: ["title", "summary", "content", "search_keywords", "s_note"] })], entries: [entry("posts", "a", { data: { title: "A", summary: "Lead.", search_keywords: "kw", s_note: "Note.", content: portableText("Body.") } })] },
		{ textFields: { posts: ["summary", "s*"] } },
	);
	assert.equal(records(out.byLocale)[0]!.text, "Lead. Note. Body.");
});

test("textFields: with no field list, a prefix reads the entry's own fields", async () => {
	const out = await collect({ collections: [collection("projects")], entries: [project()] }, { textFields: { projects: ["case_t*", "nothing_here"] } });
	assert.equal(records(out.byLocale)[0]!.text, "A bearing wall out. Holly Springs kitchen Body text.");
	assert.deepEqual(out.warnings, []);
});

test("textFields: an entry's words past the ceiling are cut, with one warning", async () => {
	const long = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(" ");
	const out = await collect({ collections: [areas], entries: [entry("areas", "a", { data: { title: "A", intro: long } }), entry("areas", "b", { data: { title: "B", intro: long } })] }, { textFields: { areas: ["intro"] } });
	for (const r of records(out.byLocale)) assert.ok(r.text.length <= TEXT_FIELDS_MAX && r.text.length > TEXT_FIELDS_MAX * 0.9, String(r.text.length));
	assert.equal(out.warnings.length, 1);
	assert.match(out.warnings[0]!, /textFields: an entry of "areas" has more than 20,000 characters/);
});

test("fieldWords reads strings, Portable Text and custom blocks; media, links and keys with _ give nothing", () => {
	assert.equal(fieldWords("  a  b "), "a b");
	assert.equal(fieldWords(portableText("One.", ["h2", "Two"])), "One. Two");
	assert.equal(fieldWords([{ _type: "image", asset: { src: "/x.webp" } }, { _type: "x", _key: "k", heading: "H" }]), "H");
	assert.equal(fieldWords(3), "");
	assert.equal(fieldWords(null), "");
	assert.equal(fieldWords({ text: "an object is not a field of blocks" }), "");
});

test("checkTextFields takes collections with field names or prefixes; search() checks it", () => {
	checkTextFields({});
	checkTextFields({ projects: ["problem", "case_*"], areas: ["intro"] });
	for (const bad of [null, [], "x", { projects: [] }, { projects: "intro" }, { projects: [""] }, { projects: ["*"] }, { projects: ["a*b"] }, { projects: ["a b"] }, { projects: [3] }, { "": ["a"] }]) {
		assert.throws(() => checkTextFields(bad), /search\(\): textFields/, JSON.stringify(bad));
	}
	assert.throws(() => search({ textFields: { projects: ["*"] } }), /textFields\.projects has "\*"/);
	assert.equal(search({ textFields: { areas: ["intro"] } }).options?.textFields?.areas?.[0], "intro");
});

test("textFields: { field, keys } reads only those block keys, so a layout value stays out", async () => {
	const withSide = project();
	(withSide.data.case_blocks as Record<string, unknown>[])[0]!.side = "end";
	const keys = ["heading", "text", "steps", "items"];
	const out = await collect({ collections: [projects], entries: [withSide] }, { textFields: { projects: ["case_lede", { field: "case_blocks", keys }] } });
	assert.equal(records(out.byLocale)[0]!.text, "A bearing wall out. On a fixed price. · The wall An engineer sized the beam. Week by week Week 3 Beam day Tips Pick appliances first. Body text.");
	assert.deepEqual(out.warnings, []);
	// Without keys the same blocks give "end" too.
	const loose = await collect({ collections: [projects], entries: [withSide] }, { textFields: { projects: ["case_blocks"] } });
	assert.match(records(loose.byLocale)[0]!.text, /beam\. end Week/);
	// A prefix that takes the field uses its keys, and it is read once.
	const both = await collect({ collections: [projects], entries: [withSide] }, { textFields: { projects: ["case_*", { field: "case_blocks", keys }] } });
	assert.equal(records(both.byLocale)[0]!.text, "A bearing wall out. Holly Springs kitchen · On a fixed price. · The wall An engineer sized the beam. Week by week Week 3 Beam day Tips Pick appliances first. Body text.");
	// A field the collection does not have is a warning, as a name.
	const missing = await collect({ collections: [projects], entries: [withSide] }, { textFields: { projects: [{ field: "nope", keys }] } });
	assert.deepEqual(missing.warnings, ['Search: textFields: the collection "projects" has no field "nope"; it is left out']);
});

test("fieldWords with keys: only words under a listed key, at any depth; a string or Portable Text field is whole", () => {
	const blocks = [{ _type: "a", heading: "H", side: "end", rows: [{ label: "L", tone: "dark" }], body: portableText("P.") }];
	assert.equal(fieldWords(blocks, ["heading", "label"]), "H L");
	assert.equal(fieldWords(blocks, ["rows"]), "L dark");
	assert.equal(fieldWords(blocks, ["body"]), "P.");
	assert.equal(fieldWords("plain", ["heading"]), "plain");
	assert.equal(fieldWords(portableText("One.", "Two."), ["heading"]), "One. Two.");
});

test("checkTextFields takes { field, keys } and rejects a bad one", () => {
	checkTextFields({ projects: ["problem", { field: "case_blocks", keys: ["heading", "text"] }] });
	for (const bad of [{}, { field: "a" }, { field: "a", keys: [] }, { field: "a*", keys: ["x"] }, { field: "a", keys: ["x y"] }, { field: "a", keys: [3] }, { field: "a", keys: ["x"], extra: 1 }, { keys: ["x"] }]) {
		assert.throws(() => checkTextFields({ projects: [bad] }), /search\(\): textFields\.projects has/, JSON.stringify(bad));
	}
});
