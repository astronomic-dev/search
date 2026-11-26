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
