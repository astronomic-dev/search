import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "ultrahtml";
import { htmlSections, markdownSections } from "../src/adapters/sections.ts";

const body = (name: string) => readFileSync(new URL(`./fixtures/md/${name}`, import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
type H = { depth: number; slug: string; text: string };

test("the Vega search page gives its headings with the rendered anchors", () => {
	const headings: H[] = [
		{ depth: 2, slug: "the-home-search", text: "The home search" },
		{ depth: 2, slug: "how-many-listings-it-holds", text: "How many listings it holds" },
		{ depth: 2, slug: "saved-homes-and-searches", text: "Saved homes and searches" },
		{ depth: 2, slug: "the-map", text: "The map" },
		{ depth: 3, slug: "keep-the-attribution", text: "Keep the attribution" },
		{ depth: 3, slug: "the-maps-requests", text: "The map’s requests" },
		{ depth: 2, slug: "site-search", text: "Site search" },
	];
	const out = markdownSections(body("vega-search.md"), headings);
	assert.ok(out);
	assert.deepEqual(
		out.sections.map((s) => s.anchor),
		headings.map((h) => h.slug),
	);
	assert.equal(out.sections[5]?.heading, "The map’s requests");
	assert.match(out.intro, /^Vega has two searches\. The home search, at \/homes\/, finds homes\./);
	const map = out.sections[3]?.text ?? "";
	assert.match(map, /For its look, see Looks\./, "a link becomes its text");
	assert.doesNotMatch(map, /OpenFreeMap, OpenMapTiles/, "the next section's text stays out");
	const table = out.sections[1]?.text ?? "";
	assert.match(table, /Content source Recommended up to What to watch Markdown \(static build\) About 1,000 homes/);
	assert.doesNotMatch(table, /\||---/);
	assert.doesNotMatch(out.sections[0]?.text ?? "", /^- /);
});

test("the Agency content page drops code blocks and keeps inline code's words", () => {
	const headings: H[] = [
		{ depth: 2, slug: "markdown", text: "Markdown" },
		{ depth: 2, slug: "journal-posts", text: "Journal posts" },
		{ depth: 2, slug: "switch-to-emdash", text: "Switch to EmDash" },
		{ depth: 2, slug: "contact-form", text: "Contact form" },
		{ depth: 2, slug: "availability", text: "Availability" },
		{ depth: 2, slug: "privacy-page", text: "Privacy page" },
		{ depth: 2, slug: "the-system-page", text: "The /system page" },
	];
	const out = markdownSections(body("agency-content.md"), headings);
	assert.ok(out);
	assert.equal(out.intro, "");
	assert.deepEqual(
		out.sections.map((s) => s.anchor),
		headings.map((h) => h.slug),
	);
	const emdash = out.sections[2]?.text ?? "";
	assert.doesNotMatch(emdash, /contentSource|seed:emdash/, "fenced code is dropped");
	assert.match(emdash, /pnpm test:parity builds the site/, "inline code keeps its words");
	assert.match(emdash, /read Markdown or EmDash\./);
	assert.match(out.sections[0]?.text ?? "", /content\/projects\/: case studies\./);
});

test("an MDX page drops imports, exports, components and code, and keeps the rendered -1 anchor", () => {
	const headings: H[] = [
		{ depth: 1, slug: "setup-notes", text: "Setup notes" },
		{ depth: 2, slug: "setup", text: "Setup" },
		{ depth: 2, slug: "setup-1", text: "Setup" },
		{ depth: 3, slug: "astro-dev-and-you", text: "astro dev and you" },
	];
	const out = markdownSections(body("mdx.mdx"), headings);
	assert.ok(out);
	assert.deepEqual(
		out.sections.map((s) => [s.anchor, s.heading]),
		[
			["setup", "Setup"],
			["setup-1", "Setup"],
			["astro-dev-and-you", "astro dev and you"],
		],
	);
	assert.equal(out.intro, "Start here. This page sets up the starter with one command. Install Node first.");
	assert.equal(out.sections[0]?.text, "Run the installer and open astro.config.mjs.");
	assert.equal(out.sections[1]?.text, "Run it again on a second machine. Step What One Install");
	assert.equal(out.sections[2]?.text, "Open the dev server. Edit a page.");
});

test("headings that do not match the rendered list give null", () => {
	const fewer: H[] = [{ depth: 2, slug: "setup", text: "Setup" }];
	assert.equal(markdownSections(body("mdx.mdx"), fewer), null);
	const renamed: H[] = [
		{ depth: 2, slug: "setup", text: "Setup" },
		{ depth: 2, slug: "install", text: "Install" },
		{ depth: 3, slug: "astro-dev-and-you", text: "astro dev and you" },
	];
	assert.equal(markdownSections(body("mdx.mdx"), renamed), null);
});

test("depths pick which headings start a section", () => {
	const headings: H[] = [
		{ depth: 2, slug: "setup", text: "Setup" },
		{ depth: 2, slug: "setup-1", text: "Setup" },
		{ depth: 3, slug: "astro-dev-and-you", text: "astro dev and you" },
	];
	const out = markdownSections(body("mdx.mdx"), headings, [2]);
	assert.ok(out);
	assert.deepEqual(
		out.sections.map((s) => s.anchor),
		["setup", "setup-1"],
	);
	assert.match(out.sections[1]?.text ?? "", /One Install astro dev and you Open the dev server\./);
});

const html = `<!doctype html><html lang="en"><body>
<header><nav><a href="/">Home</a></nav></header>
<main>
	<h1>Theming</h1>
	<p>Intro &amp; overview.</p>
	<nav aria-label="On this page"><a href="#dark-mode">Dark mode</a></nav>
	<h2 id="dark-mode">Dark <code>mode</code></h2>
	<p>Set the <strong>class</strong>.</p>
	<div data-search-ignore><p>Ignored aside.</p></div>
	<div data-pagefind-ignore><p>Pagefind aside.</p></div>
	<p hidden>Hidden text.</p>
	<span aria-hidden="true">Icon</span>
	<h3>No id here</h3>
	<p>Still dark mode.</p>
	<h3 id="tokens">Tokens</h3>
	<p>Colors live in tokens.</p>
	<script>var x = 1;</script>
</main>
<footer>Footer</footer>
</body></html>`;

test("the HTML form splits on h2 and h3 with an id and drops nav, ignored and hidden parts", () => {
	const out = htmlSections(parse(html));
	assert.deepEqual(out, {
		intro: "Intro & overview.",
		sections: [
			{ anchor: "dark-mode", heading: "Dark mode", text: "Set the class. No id here Still dark mode." },
			{ anchor: "tokens", heading: "Tokens", text: "Colors live in tokens." },
		],
	});
});

test("the HTML form reads only the marked body when there is one", () => {
	const marked = `<main><p>Chrome</p><article data-search-body><p>Body text.</p><h2 id="a">A</h2><p>Section.</p></article></main>`;
	assert.deepEqual(htmlSections(parse(marked)), { intro: "Body text.", sections: [{ anchor: "a", heading: "A", text: "Section." }] });
	const pagefind = `<main><p>Chrome</p><article data-pagefind-body><p>Body text.</p></article></main>`;
	assert.deepEqual(htmlSections(parse(pagefind)), { intro: "Body text.", sections: [] });
});

test("an out-of-range character reference becomes U+FFFD instead of throwing", () => {
	assert.deepEqual(htmlSections(parse("<main><p>a&#x110000;b &#99999999; c&#65;</p></main>")), { intro: "a�b � cA", sections: [] });
});

test("a marked body inside a hidden or ignored part is never the root, and its text stays out", () => {
	for (const mark of ["hidden", 'aria-hidden="true"', "data-search-ignore", "data-pagefind-ignore"]) {
		const page = `<body><div ${mark}><main data-search-body><p>SECRET</p></main></div><main><p>Public</p></main></body>`;
		assert.deepEqual(htmlSections(parse(page)), { intro: "Public", sections: [] }, mark);
	}
	assert.deepEqual(htmlSections(parse("<body><template><main>SECRET</main></template><p>Public</p></body>")), { intro: "Public", sections: [] });
	assert.deepEqual(htmlSections(parse("<body><main hidden>SECRET</main><p>Public</p></body>")), { intro: "Public", sections: [] });
});

test("an unknown entity named like an Object.prototype key stays as written", () => {
	const out = htmlSections(parse(`<html><body><main><p>A &constructor; and &toString; &amp; more.</p></main></body></html>`));
	assert.equal(out.intro, "A &constructor; and &toString; & more.");
});

test("a search dialog on the page is never the page's text, even with a data-search-body inside", () => {
	const kit = parse(`<html><body><main><p>Real</p></main><dialog data-search-dialog><div data-search-body><p>No results</p></div></dialog></body></html>`);
	assert.deepEqual(htmlSections(kit), { intro: "Real", sections: [] });
	// Marked only by the attribute (not a dialog element), or the default element, or a plain dialog: all left out.
	const marked = parse(`<html><body><main><p>Real</p><div data-search-dialog><p>Dialog text</p></div><astronomic-search><p>Shadow text</p></astronomic-search><dialog><p>Modal</p></dialog></main></body></html>`);
	assert.deepEqual(htmlSections(marked), { intro: "Real", sections: [] });
	const bodyInside = parse(`<html><body><div data-search-dialog><section data-search-body>Dialog</section></div><main>Real</main></body></html>`);
	assert.deepEqual(htmlSections(bodyInside), { intro: "Real", sections: [] });
});

test("the HTML form puts a space between blocks, at <br>, and between flex or grid items; inline runs stay joined", () => {
	const body = (inner: string) => htmlSections(parse(`<main>${inner}</main>`)).intro;
	assert.equal(body("<div>Portfolio theme</div><div>Open source</div>"), "Portfolio theme Open source");
	assert.equal(body("<p>One<br>two<br/>three</p>"), "One two three");
	// Spans laid out as flex or grid items are separate boxes (the theme page's "Portfolio theme" / "Open source" row).
	assert.equal(body(`<div class="spec flex items-baseline"><span>Portfolio theme</span><span>Open source</span></div>`), "Portfolio theme Open source");
	assert.equal(body(`<div class="md:grid"><span>Free</span><a>Get Vesper free</a></div>`), "Free Get Vesper free");
	assert.equal(body(`<p style="display: inline-flex"><b>A</b><i>B</i></p>`), "A B");
	// Inline runs join: a word split by inline tags stays one word, and "flex-1" or "flexible" is not a flex box.
	assert.equal(body("<p>Lode<b>star</b> and <em>re</em><span>act</span></p>"), "Lodestar and react");
	assert.equal(body(`<p class="flex-1 flexible"><span>Lode</span><span>star</span></p>`), "Lodestar");
});
