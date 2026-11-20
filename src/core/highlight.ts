/**
 * Highlights as ranges, never HTML: a word is marked where its folded form starts with a matched term.
 * Terms are the engine's indexed terms (already folded), so "cafe" marks "Café".
 */
import { foldText } from "./text.ts";
import type { Highlight, Ranges, SearchRecord } from "./types.ts";

/** Words as MiniSearch's default tokenizer sees them: runs between spaces and punctuation. */
const WORD = /[^\n\r\p{Z}\p{P}]+/gu;

const ASCII = /^[\x00-\x7f]*$/;

/** The terms, and their first letters for a quick miss on an ASCII word. */
interface Terms {
	list: string[];
	firsts: Set<string>;
}
const prepare = (terms: string[]): Terms => ({ list: terms, firsts: new Set(terms.filter((t) => t.length > 0).map((t) => t[0]!)) });

/**
 * The end (in `word`) of the longest term the folded word starts with, or -1. The whole word is folded
 * (folding is contextual: a final sigma), and the end is the shortest prefix whose fold covers the term.
 * An ASCII word folds to its lowercase, letter for letter, so its first letter rules out most terms and the end is
 * the term's length. Any other word can fold to a different first letter ("É" is "e"), so it takes the full path.
 */
function matchEnd(word: string, terms: Terms): number {
	const ascii = ASCII.test(word);
	if (ascii && !terms.firsts.has(word[0]!.toLowerCase())) return -1;
	const folded = ascii ? word.toLowerCase() : foldText(word);
	let best = 0;
	for (const t of terms.list) if (t.length > best && folded.startsWith(t)) best = t.length;
	if (best === 0) return -1;
	if (ascii) return best;
	let end = 0;
	for (const ch of word) {
		end += ch.length;
		if (foldText(word.slice(0, end)).length >= best) {
			while (end < word.length && /\p{M}/u.test(word[end]!)) end++;
			return end;
		}
	}
	return word.length;
}

function rangesOf(s: string, terms: Terms): Ranges {
	const out: Ranges = [];
	if (!s || terms.list.length === 0) return out;
	for (const m of s.matchAll(WORD)) {
		const end = matchEnd(m[0], terms);
		if (end > 0) out.push([m.index, m.index + end]);
	}
	return out;
}

/** Sorted, non-overlapping ranges in `s` (one per matched word). */
export function ranges(s: string, terms: string[]): Ranges {
	return rangesOf(s, prepare(terms));
}

/** The first matched word's range, or undefined: stops at the first hit. */
function firstRange(s: string, terms: Terms): [number, number] | undefined {
	if (!s || terms.list.length === 0) return undefined;
	for (const m of s.matchAll(WORD)) {
		const end = matchEnd(m[0], terms);
		if (end > 0) return [m.index, m.index + end];
	}
	return undefined;
}

/** A window of about `n` characters of `text` around the first matched word, cut on spaces. */
function snippet(text: string, terms: Terms, n: number): { text: string; ranges: Ranges } {
	if (text.length <= n) return { text, ranges: rangesOf(text, terms) };
	const first = firstRange(text, terms);
	let start = 0;
	if (first) {
		start = Math.max(0, Math.min(first[0] - Math.floor(n / 3), text.length - n));
		if (start > 0) {
			const space = text.indexOf(" ", start - 1);
			start = space >= 0 && space < first[0] ? space + 1 : first[0];
		}
	}
	let end = Math.min(text.length, start + n);
	if (end < text.length) {
		const space = text.lastIndexOf(" ", end);
		if (space > start && (!first || space >= first[1] || first[0] < start)) end = space;
	}
	const body = text.slice(start, end).trim();
	const lead = start > 0 ? "…" : "";
	const out = lead + body + (end < text.length ? "…" : "");
	return { text: out, ranges: rangesOf(body, terms).map(([a, b]) => [a + lead.length, b + lead.length]) };
}

export function highlight(record: SearchRecord, terms: string[], opts: { snippet?: number } = {}): Highlight {
	const t = prepare(terms);
	const h: Highlight = { title: rangesOf(record.title, t), snippet: snippet(record.text ?? "", t, opts.snippet ?? 160) };
	if (record.heading !== undefined) h.heading = rangesOf(record.heading, t);
	return h;
}
