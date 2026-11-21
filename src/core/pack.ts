/**
 * The records of one index file, packed for the wire. A page's fields are stored once; each heading's section is a
 * short array that points at its page. Ids are not stored where `${locale}:${url}` gives them, and `source` is not
 * stored at all (only the build's merge reads it). `unpack` gives back the same `SearchRecord`s, sorted by id.
 */
import type { ActionRecord, HeadingRecord, PageRecord, RecordSource, SearchRecord } from "./types.ts";

/** A page or an action. Fields left out: empty facets, empty keywords, empty text, kind "page", a derived id. */
export interface PackedPage {
	url?: string;
	title: string;
	type: string;
	text?: string;
	facets?: Record<string, string[]>;
	keywords?: string[];
	kind?: "action";
	command?: string;
	/** Only when it is not `${locale}:${url}` (an action with no URL). */
	id?: string;
}

/** A section's fields that differ from its page's (should not happen; kept so a pack never loses data). */
export interface SectionOverrides {
	id?: string;
	url?: string;
	type?: string;
	title?: string;
	facets?: Record<string, string[]>;
}

/** One heading's section: [page index, anchor, heading, text], and overrides only when needed. */
export type PackedSection = [number, string, string, string] | [number, string, string, string, SectionOverrides];

export interface PackedRecords {
	pages: PackedPage[];
	sections: PackedSection[];
	/** Headings whose page is not in the file, whole but for `source`. Left out when there are none. */
	orphans?: Omit<HeadingRecord, "source">[];
}

/** What `unpack` puts in `source`: the file does not keep it, and nothing that reads the file uses it. */
export const UNPACKED_SOURCE: RecordSource = "html";

export const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const isEmpty = (o: Record<string, unknown>) => Object.keys(o).length === 0;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function pack(records: readonly SearchRecord[], locale: string): PackedRecords {
	const sorted = [...records].sort(byId);
	const pages: PackedPage[] = [];
	const at = new Map<string, number>();
	const byKey = new Map<string, SearchRecord>();
	const headings: HeadingRecord[] = [];
	for (const r of sorted) {
		if (r.locale !== locale) throw new Error(`Search: record ${r.id} has locale ${r.locale}, but this file is ${locale}`);
		if (r.kind === "heading") {
			headings.push(r);
			continue;
		}
		const p: PackedPage = { title: r.title, type: r.type };
		if (r.url !== undefined) p.url = r.url;
		if (r.text) p.text = r.text;
		if (!isEmpty(r.facets)) p.facets = r.facets;
		if (r.kind === "page" && r.keywords?.length) p.keywords = r.keywords;
		if (r.kind === "action") {
			p.kind = "action";
			if (r.command !== undefined) p.command = r.command;
		}
		if (r.url === undefined || r.id !== `${locale}:${r.url}`) p.id = r.id;
		at.set(r.id, pages.length);
		byKey.set(r.id, r);
		pages.push(p);
	}
	const sections: PackedSection[] = [];
	const orphans: Omit<HeadingRecord, "source">[] = [];
	for (const h of headings) {
		const index = at.get(h.pageId);
		if (index === undefined) {
			const { source: _, ...rest } = h;
			orphans.push(rest);
			continue;
		}
		const page = byKey.get(h.pageId)!;
		const over: SectionOverrides = {};
		const base = `${page.url ?? ""}#`;
		let anchor = "";
		if (h.url.startsWith(base)) anchor = h.url.slice(base.length);
		else over.url = h.url;
		if (h.id !== `${locale}:${h.url}`) over.id = h.id;
		if (h.type !== page.type) over.type = h.type;
		if (h.title !== page.title) over.title = h.title;
		if (!same(h.facets, page.facets)) over.facets = h.facets;
		sections.push(isEmpty(over as Record<string, unknown>) ? [index, anchor, h.heading, h.text] : [index, anchor, h.heading, h.text, over]);
	}
	return orphans.length ? { pages, sections, orphans } : { pages, sections };
}

export function unpack(packed: PackedRecords, locale: string): SearchRecord[] {
	const out: SearchRecord[] = [];
	const pages = packed.pages.map((p): PageRecord | ActionRecord => {
		const id = p.id ?? `${locale}:${p.url}`;
		const common = { id, locale, type: p.type, title: p.title, text: p.text ?? "", facets: p.facets ?? {}, source: UNPACKED_SOURCE };
		const r: PageRecord | ActionRecord =
			p.kind === "action"
				? { ...common, kind: "action", ...(p.url !== undefined ? { url: p.url } : {}), ...(p.command !== undefined ? { command: p.command } : {}) }
				: { ...common, kind: "page", url: p.url!, ...(p.keywords?.length ? { keywords: p.keywords } : {}) };
		out.push(r);
		return r;
	});
	for (const [index, anchor, heading, text, over = {}] of packed.sections) {
		const page = pages[index];
		if (!page) throw new Error(`Search: the ${locale} file has a section of page ${index}, which it does not have`);
		const url = over.url ?? `${page.url ?? ""}#${anchor}`;
		out.push({
			id: over.id ?? `${locale}:${url}`,
			kind: "heading",
			pageId: page.id,
			locale,
			type: over.type ?? page.type,
			url,
			title: over.title ?? page.title,
			heading,
			text,
			facets: over.facets ?? page.facets,
			source: UNPACKED_SOURCE,
		});
	}
	for (const h of packed.orphans ?? []) out.push({ ...h, source: UNPACKED_SOURCE });
	return out.sort(byId);
}
