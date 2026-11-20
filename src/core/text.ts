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

/** Squash, then cut to `max` characters on a word boundary, with an ellipsis. */
export function clip(s: string, max: number): string {
	const clean = squash(s);
	if (clean.length <= max) return clean;
	const cut = clean.lastIndexOf(" ", max);
	return `${clean.slice(0, cut > max * 0.6 ? cut : max)}…`;
}
