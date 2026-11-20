/**
 * The one way to render result text: text nodes with a <mark> around each highlight range. Record text only ever
 * becomes text nodes, never markup. Only createElement, createTextNode, setAttribute and append are used, so a
 * stand-in document runs it under node.
 */
import type { Ranges } from "../core/types.ts";

/**
 * `text` as text nodes with a <mark> around each range. Ranges are clamped, sorted and merged. Each mark gets
 * `attrs` (default `{ part: "mark" }`, the default dialog's part; a recipe in the light DOM passes its own class).
 */
export function marked(doc: Document, text: string, ranges: Ranges = [], attrs: Record<string, string> = { part: "mark" }): Node[] {
	const sorted = ranges
		.map(([a, b]) => [Math.max(0, Math.min(a, text.length)), Math.max(0, Math.min(b, text.length))] as [number, number])
		.filter(([a, b]) => b > a)
		.sort((x, y) => x[0] - y[0]);
	const merged: [number, number][] = [];
	for (const r of sorted) {
		const last = merged[merged.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else merged.push([r[0], r[1]]);
	}
	const out: Node[] = [];
	let at = 0;
	for (const [a, b] of merged) {
		if (a > at) out.push(doc.createTextNode(text.slice(at, a)));
		const mark = doc.createElement("mark");
		for (const [name, value] of Object.entries(attrs)) mark.setAttribute(name, value);
		mark.append(text.slice(a, b));
		out.push(mark);
		at = b;
	}
	if (at < text.length) out.push(doc.createTextNode(text.slice(at)));
	return out;
}
