/**
 * A page split into its sections: the text before the first heading, then one section per heading, each with only its
 * own text. Two forms: Markdown (a collection entry's body plus the headings Astro rendered) and HTML (an ultrahtml
 * tree). Anchors always come from what the page renders, never from a slugger of our own.
 */
import { ELEMENT_NODE, TEXT_NODE, type Node } from "ultrahtml";
import { own } from "../core/own.ts";
import { foldText, squash } from "../core/text.ts";

export interface Section {
	anchor: string;
	heading: string;
	text: string;
}

export interface Sections {
	intro: string;
	sections: Section[];
}

export interface RenderedHeading {
	depth: number;
	slug: string;
	text: string;
}

/** Letters and digits only, folded: "The map's requests" and "The map’s requests" compare equal. */
const key = (s: string) => foldText(s).replace(/[^\p{L}\p{N}]+/gu, "");

/** Spaces before closing punctuation and after opening punctuation, left by dropped marks and tags. */
const tidy = (s: string) =>
	squash(s)
		.replace(/ ([.,;:!?)\]’”])/g, "$1")
		.replace(/([(\[‘“]) /g, "$1");

// ---------------------------------------------------------------------------------------------------------------------
// Markdown

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const CODE_SPAN = /(`+)([\s\S]*?[^`])\1(?!`)/g;

/** Inline Markdown to plain text: links to their text, images and tags out, emphasis marks out, code keeps its words. */
function inline(md: string): string {
	let out = "";
	let last = 0;
	const prose = (s: string) =>
		s
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
			.replace(/!\[[^\]]*\]\[[^\]]*\]/g, " ")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
			.replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
			.replace(/<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>/g, " ")
			.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
			.replace(/(^|[^\p{L}\p{N}\\])[*_](?=\S)([^\n]*?\S)[*_](?![\p{L}\p{N}])/gu, "$1$2")
			.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
			.replace(/\|/g, " ")
			.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1");
	for (const m of md.matchAll(CODE_SPAN)) {
		out += prose(md.slice(last, m.index)) + (m[2] ?? "").trim();
		last = (m.index ?? 0) + m[0].length;
	}
	return out + prose(md.slice(last));
}

/** A line's block marks out: list markers, quote marks. Lines that carry no words (rules, table separators) are dropped. */
function blockLine(line: string): string | null {
	if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) return null; // thematic break
	if (/^[\s|:-]+$/.test(line) && line.includes("|") && line.includes("-")) return null; // table separator
	if (/^ {0,3}\[[^\]]+\]:\s/.test(line)) return null; // link reference definition
	return line.replace(/^(\s*>)+/, " ").replace(/^\s*(?:[-*+]|\d+[.)])(?:\s+\[[ xX]\])?\s+/, " ");
}

/**
 * Sections from a Markdown or MDX body (no frontmatter) and the headings Astro rendered for it. Headings outside fenced
 * code are paired in order with the rendered ones of the same depths; if the count or the texts differ, the result is
 * null and the caller indexes the page alone (with a warning).
 */
export function markdownSections(body: string, headings: RenderedHeading[], depths: number[] = [2, 3]): Sections | null {
	const rendered = headings.filter((h) => depths.includes(h.depth));
	const chunks: string[][] = [[]];
	const found: string[] = [];
	let fence: string | null = null;
	let inImport = false;

	for (const line of body.split(/\r?\n/)) {
		if (fence) {
			const close = line.match(FENCE);
			if (close?.[1] && close[1][0] === fence[0] && close[1].length >= fence.length && line.trim() === close[1]) fence = null;
			continue;
		}
		const open = line.match(FENCE);
		if (open?.[1]) {
			fence = open[1];
			continue;
		}
		if (inImport) {
			if (/\bfrom\s+["'][^"']*["'];?\s*$|^\s*\}/.test(line)) inImport = false;
			continue;
		}
		if (/^(import|export)\s/.test(line)) {
			// An import or export that opens a brace and does not close it on this line runs on.
			if (line.includes("{") && !line.includes("}")) inImport = true;
			continue;
		}
		const atx = line.match(ATX);
		if (atx?.[1]) {
			const text = squash(inline(atx[2] ?? ""));
			if (depths.includes(atx[1].length)) {
				found.push(text);
				chunks.push([]);
			} else chunks.at(-1)?.push(text);
			continue;
		}
		const kept = blockLine(line);
		if (kept !== null) chunks.at(-1)?.push(kept);
	}

	if (found.length !== rendered.length) return null;
	if (found.some((text, i) => key(text) !== key(rendered[i]?.text ?? ""))) return null;
	const plain = (lines: string[]) => tidy(inline(lines.join("\n")));
	return {
		intro: plain(chunks[0] ?? []),
		sections: rendered.map((h, i) => ({ anchor: h.slug, heading: squash(h.text), text: plain(chunks[i + 1] ?? []) })),
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// HTML

// A dialog (a search dialog above all: its markup can carry a data-search-body of its own) is never page text.
const DROP_TAGS = new Set(["nav", "script", "style", "noscript", "template", "svg", "dialog", "astronomic-search"]);
const IGNORE = ["data-search-ignore", "data-pagefind-ignore", "data-search-dialog"];
const BODY = ["data-search-body", "data-pagefind-body"];
// Inline tags join their text with no space; every other element boundary (links too: card links sit side by side)
// is a word break, and so is <br>. A flex or grid container's children are separate boxes, even spans side by side.
const INLINE = new Set(["abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "i", "kbd", "mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", times: "×", middot: "·", rarr: "→", larr: "←", bull: "•" };
const decode = (s: string) =>
	s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return cp > 0x10ffff ? "\uFFFD" : String.fromCodePoint(cp);
		}
		return own(ENTITIES, e.toLowerCase()) ?? m;
	});

const attrs = (n: Node): Record<string, string> => (n.attributes ?? {}) as Record<string, string>;

/** A class token (with any variant prefix: "md:flex") or an inline style that makes a flex or grid container. */
const BOX_CLASS = /(?:^|\s)(?:[\w-]+:)*(?:inline-)?(?:flex|grid)(?=\s|$)/;
const BOX_STYLE = /(?:^|;)\s*display\s*:\s*(?:inline-)?(?:flex|grid)\b/i;
/** Whether `n` lays its children out as flex or grid items. */
const boxes = (n: Node): boolean => {
	const a = attrs(n);
	return BOX_CLASS.test(a.class ?? "") || BOX_STYLE.test(a.style ?? "");
};
/** Whether an element's edges are a word break: not an inline tag, or an item of a flex or grid container. */
const breaks = (n: Node, inBox: boolean) => inBox || !INLINE.has(n.name);

function dropped(n: Node): boolean {
	const a = attrs(n);
	return DROP_TAGS.has(n.name) || IGNORE.some((k) => k in a) || "hidden" in a || a["aria-hidden"] === "true";
}

/** The outermost elements that pass the test, skipping dropped parts and all they hold. */
export function find(node: Node, test: (n: Node) => boolean, out: Node[] = []): Node[] {
	for (const child of (node.children ?? []) as Node[]) {
		if (child.type !== ELEMENT_NODE || dropped(child)) continue;
		if (test(child)) out.push(child);
		else find(child, test, out);
	}
	return out;
}

/** The plain text of a subtree, with the dropped parts left out. */
export function textOf(node: Node): string {
	let s = "";
	const walk = (n: Node, inBox: boolean) => {
		if (n.type === TEXT_NODE) s += decode(n.value);
		else if (n.type === ELEMENT_NODE && !dropped(n)) {
			const block = breaks(n, inBox);
			if (block) s += " ";
			const box = boxes(n);
			for (const c of (n.children ?? []) as Node[]) walk(c, box);
			if (block) s += " ";
		}
	};
	walk(node, false);
	return tidy(s);
}

/**
 * Sections from an ultrahtml tree (a page or a part of one). The text comes from `[data-search-body]` (or
 * `[data-pagefind-body]`), else `main`, else the whole tree. An h2 or h3 with an `id` starts a section; one with no
 * `id` folds into the section above. The h1 is left out (it is the title). Dropped: nav, script, style, noscript,
 * template, svg, dialog, astronomic-search, `[data-search-dialog]`, `[hidden]`, `[aria-hidden="true"]`,
 * `[data-search-ignore]` and `[data-pagefind-ignore]`.
 */
export function htmlSections(root: Node): Sections {
	if (root.type === ELEMENT_NODE && dropped(root)) return { intro: "", sections: [] };
	const isBody = (n: Node) => BODY.some((k) => k in attrs(n));
	let roots = isBody(root) ? [root] : find(root, isBody);
	if (roots.length === 0) roots = root.name === "main" ? [root] : find(root, (n) => n.name === "main");
	if (roots.length === 0) roots = [root];

	const out: { anchor: string; heading: string; chunks: string[] }[] = [{ anchor: "", heading: "", chunks: [] }];
	const push = (s: string) => out.at(-1)?.chunks.push(s);
	const walk = (n: Node, inBox: boolean) => {
		if (n.type === TEXT_NODE) return push(decode(n.value));
		if (n.type !== ELEMENT_NODE || dropped(n) || n.name === "h1") return;
		const id = attrs(n).id;
		if ((n.name === "h2" || n.name === "h3") && id) {
			out.push({ anchor: id, heading: textOf(n), chunks: [] });
			return;
		}
		const block = breaks(n, inBox);
		if (block) push(" ");
		const box = boxes(n);
		for (const c of (n.children ?? []) as Node[]) walk(c, box);
		if (block) push(" ");
	};
	for (const r of roots) for (const c of (r.children ?? []) as Node[]) walk(c, r.type === ELEMENT_NODE && boxes(r));

	const [own, ...rest] = out;
	return {
		intro: tidy(own?.chunks.join("") ?? ""),
		sections: rest.map((s) => ({ anchor: s.anchor, heading: s.heading, text: tidy(s.chunks.join("")) })),
	};
}
