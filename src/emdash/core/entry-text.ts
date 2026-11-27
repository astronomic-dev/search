/** Words from an entry's fields. Platform-free: no `emdash`, `node:*`, `react` or `astro` imports. */
import { squash } from "../../core/text.ts";

export const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** The first value that is a non-empty string. */
export function firstText(...values: unknown[]): string | undefined {
	for (const v of values) if (isText(v)) return v;
	return undefined;
}

/** Plain text of Portable Text: the spans of every block, blocks joined by a space. Anything else gives "". */
export function portableTextToPlain(value: unknown): string {
	if (!Array.isArray(value)) return "";
	const blocks: string[] = [];
	for (const block of value) {
		if (!block || typeof block !== "object") continue;
		const children = (block as { children?: unknown }).children;
		if (!Array.isArray(children)) continue;
		const text = children.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("");
		if (text.trim()) blocks.push(text);
	}
	return squash(blocks.join(" "));
}

/** The words of one field: a string, or Portable Text. Anything else gives "". */
export const fieldText = (value: unknown): string => (typeof value === "string" ? squash(value) : portableTextToPlain(value));

/** Keys of a custom block that hold no words for a reader: links, styles, Portable Text mark data. */
const NO_WORDS = new Set(["markDefs", "marks", "href", "url", "style", "listItem", "level"]);

/**
 * The strings of one value, in order, into `parts`. Media (an image or file object) and `_` keys give nothing. With
 * `keys`, only the words under one of those keys count, at any depth (everything under such a key); other keys are
 * walked for nested listed keys but add no words themselves.
 */
function collectWords(v: unknown, parts: string[], depth: number, keys: ReadonlySet<string> | null, on: boolean): void {
	if (depth > 8) return;
	if (typeof v === "string") {
		if (on && v.trim()) parts.push(v);
		return;
	}
	if (Array.isArray(v)) {
		for (const x of v) collectWords(x, parts, depth + 1, keys, on);
		return;
	}
	if (!v || typeof v !== "object") return;
	const o = v as Record<string, unknown>;
	if (Array.isArray(o.children)) {
		// A Portable Text block: its spans, as `portableTextToPlain`. One of the field's own blocks (depth 1) always counts.
		const text = on || depth === 1 ? portableTextToPlain([o]) : "";
		if (text) parts.push(text);
		return;
	}
	if ("mimeType" in o || "provider" in o || "src" in o) return;
	for (const [k, x] of Object.entries(o)) if (!k.startsWith("_") && !NO_WORDS.has(k)) collectWords(x, parts, depth + 1, keys, on || !!keys?.has(k));
}

/**
 * The words of one `textFields` field: a string, Portable Text, or a list of blocks of a theme's own types (each
 * block's strings, such as a heading and its text, or a list's items). With `keys`, a block gives only the words under
 * those keys (`["heading", "text"]`), so a layout value such as `side: "end"` stays out. Anything else gives "".
 */
export function fieldWords(value: unknown, keys?: readonly string[]): string {
	if (typeof value === "string") return squash(value);
	if (!Array.isArray(value)) return "";
	const parts: string[] = [];
	const only = keys ? new Set(keys) : null;
	collectWords(value, parts, 0, only, !only);
	return squash(parts.join(" "));
}
