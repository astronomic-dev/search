/**
 * Site path patterns, shared by `html()` (include, exclude) and the EmDash plugin's `exclude`. Platform-free.
 *
 * A pattern is an exact path, where a "*" segment is any one segment. With `loose` (the EmDash plugin's
 * `exclude` and `excludeWhen`), case makes no difference and a "*" inside a segment ("sitemap-*.xml") is any
 * run of characters within that segment, none too. `html()` keeps the strict form.
 */
const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

const SPECIAL = /[.+?^${}()|[\]\\]/g;
const segmentCache = new Map<string, (s: string) => boolean>();

/** The loose test for one pattern segment (lowercase), against one path segment (lowercase). */
function segmentTest(q: string): (s: string) => boolean {
	let test = segmentCache.get(q);
	if (test) return test;
	if (q === "*") test = (s) => s !== "";
	else if (!q.includes("*")) test = (s) => s === q;
	else {
		const re = new RegExp(`^${q.split("*").map((part) => part.replace(SPECIAL, "\\$&")).join("[^/]*")}$`);
		test = (s) => re.test(s);
	}
	if (segmentCache.size < 1000) segmentCache.set(q, test);
	return test;
}

/** Whether a site path (no base) matches one of the patterns; `loose` ignores case and takes "*" inside a segment. */
export function matchPath(path: string, patterns: readonly string[], options: { loose?: boolean } = {}): boolean {
	if (!options.loose) {
		const p = trim(path).split("/");
		return patterns.some((pattern) => {
			const q = trim(pattern).split("/");
			return q.length === p.length && q.every((s, i) => (s === "*" ? p[i] !== "" : s === p[i]));
		});
	}
	const p = trim(path).toLowerCase().split("/");
	return patterns.some((pattern) => {
		const q = trim(pattern).toLowerCase().split("/");
		return q.length === p.length && q.every((s, i) => segmentTest(s)(p[i]));
	});
}
