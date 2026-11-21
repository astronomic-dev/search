/** Plain-text helpers shared by the adapters and the engine. No DOM, no engine imports. */

const ASCII = /^[\x00-\x7f]*$/;

/** NFD, marks stripped, lowercase: the same fold as the engine's `processTerm`. Pure ASCII only lowercases. */
export function foldText(s: string): string {
	if (ASCII.test(s)) return s.toLowerCase();
	return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Collapse every run of whitespace to one space and trim. */
export function squash(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/**
 * Where to cut squashed text to about `max` characters: `end` on a word boundary (or at `max` when the last word is
 * very long), and `rest`, the start of the first word not wholly before `end`. Short text: both are its length.
 */
export function cutAt(clean: string, max: number): { end: number; rest: number } {
	if (clean.length <= max) return { end: clean.length, rest: clean.length };
	const space = clean.lastIndexOf(" ", max);
	const end = space > max * 0.6 ? space : max;
	return { end, rest: clean.lastIndexOf(" ", end) + 1 };
}

/** Squash, then cut to `max` characters on a word boundary, with an ellipsis. */
export function clip(s: string, max: number): string {
	const clean = squash(s);
	const { end } = cutAt(clean, max);
	return end < clean.length ? `${clean.slice(0, end)}…` : clean;
}
