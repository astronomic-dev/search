/**
 * `excludeWhen`: site paths left out of a build while a switch in the site's content is set (a theme part turned off in
 * the admin).
 *
 * - One read per rule collection and build: the first page of `content.list`, before any indexed collection is read.
 *   The entry is the first published one in EmDash's default list order (newest created first, then the higher id),
 *   the one a theme's `getEmDashCollection(...)[0]` takes. More than one published entry: a warning, and that one is read.
 * - The value is the entry's field. An empty field (absent or null) and no published entry both read as `null`, so a
 *   rule with `null` in `values` leaves its paths out then too.
 * - Settled problems are warnings, and the rule leaves nothing out: a collection the site does not have, a field the
 *   collection does not have, a value that is not a single string, number or boolean (an object or a list).
 * - A failed read throws: the build fails (`error`), the live index stays as it was and the next tick tries again. So a
 *   read error never brings back the pages of a part that is off, and never drops the rest of the index.
 * - The paths join `exclude` before the build reads anything else, so a left-out path gets no record and no list page.
 *
 * Platform-free: no `emdash`, `node:*`, `react` or `astro` imports.
 */
import { isSitePath } from "./paths.ts";
import type { CollectionInfo, ContentPort, EmDashEntry, ExcludeWhen } from "./ports.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isName = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isValue = (v: unknown): v is string | number | boolean | null => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const KEYS = ["collection", "field", "values", "paths"];
const EXAMPLE = `[{ collection: "details", field: "switch_areas", values: ["off"], paths: ["/areas", "/areas/*"] }]`;

/** Throws unless `input` is a list of switch rules. */
export function checkExcludeWhen(input: unknown): asserts input is ExcludeWhen[] {
	const fail = (message: string): never => {
		throw new Error(`Search: search(): ${message}`);
	};
	if (!Array.isArray(input)) return fail(`excludeWhen must be a list of rules (${EXAMPLE}), not ${JSON.stringify(input)}`);
	input.forEach((rule: unknown, i) => {
		const at = `excludeWhen[${i}]`;
		if (!isObject(rule)) return fail(`${at} must be an object, not ${JSON.stringify(rule)}`);
		const unknown = Object.keys(rule).find((k) => !KEYS.includes(k));
		if (unknown !== undefined) return fail(`${at} has an unknown key "${unknown}" (it takes collection, field, values and paths)`);
		if (!isName(rule.collection)) return fail(`${at}.collection must be a collection slug ("details"), not ${JSON.stringify(rule.collection)}`);
		if (!isName(rule.field)) return fail(`${at}.field must be a field slug ("switch_areas"), not ${JSON.stringify(rule.field)}`);
		if (!Array.isArray(rule.values) || rule.values.length === 0 || !rule.values.every(isValue)) {
			return fail(`${at}.values must be a list of strings, numbers, booleans or null (["off"]), not ${JSON.stringify(rule.values)}`);
		}
		if (!Array.isArray(rule.paths) || rule.paths.length === 0 || !rule.paths.every(isSitePath)) {
			return fail(`${at}.paths must be a list of site paths that start with one "/" and have no "?" or "#" (["/areas", "/areas/*"]), not ${JSON.stringify(rule.paths)}`);
		}
	});
}

/** The entry one rule collection holds for this build: the first published one, or null; `more` when it has others. */
async function readEntry(content: Pick<ContentPort, "list">, collection: string): Promise<{ entry: EmDashEntry | null; more: boolean }> {
	let page: Awaited<ReturnType<ContentPort["list"]>>;
	try {
		page = await content.list(collection);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Search: excludeWhen: the "${collection}" entry could not be read (${message}); the live index stays as it was, and the next tick tries again`);
	}
	const published = page.items.filter((e) => e.status === "published");
	return { entry: published[0] ?? null, more: published.length > 1 };
}

/**
 * The paths `excludeWhen` leaves out of this build, from the collections the site has (`all`). Warnings go to
 * `warnings`; a failed read throws (see the module note).
 */
export async function excludeWhenPaths(content: Pick<ContentPort, "list">, all: readonly CollectionInfo[], rules: readonly ExcludeWhen[] | undefined, warnings: string[]): Promise<string[]> {
	if (!rules || rules.length === 0) return [];
	const read = new Map<string, Promise<{ entry: EmDashEntry | null; more: boolean }>>();
	const out: string[] = [];
	for (const rule of rules) {
		const info = all.find((c) => c.slug === rule.collection);
		if (!info) {
			warnings.push(`Search: excludeWhen: there is no collection "${rule.collection}"; this rule leaves nothing out`);
			continue;
		}
		if (info.fields && !info.fields.includes(rule.field)) {
			warnings.push(`Search: excludeWhen: collection "${rule.collection}" has no field "${rule.field}"; this rule leaves nothing out`);
			continue;
		}
		let pending = read.get(rule.collection);
		if (!pending) {
			pending = readEntry(content, rule.collection);
			read.set(rule.collection, pending);
			if ((await pending).more) warnings.push(`Search: excludeWhen: collection "${rule.collection}" has more than one published entry; the newest is read`);
		}
		const { entry } = await pending;
		const raw = entry ? entry.data?.[rule.field] : null;
		const value = raw === undefined ? null : raw;
		if (!isValue(value)) {
			warnings.push(`Search: excludeWhen: the "${rule.field}" field of "${rule.collection}" holds ${JSON.stringify(value)}, not one string, number or boolean; this rule leaves nothing out`);
			continue;
		}
		if (rule.values.includes(value)) out.push(...rule.paths);
	}
	return out;
}
