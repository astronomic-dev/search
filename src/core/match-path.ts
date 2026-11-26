/**
 * Site path patterns, shared by `html()` (include, exclude) and the EmDash plugin's `exclude`. Platform-free.
 */
const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Whether a site path (no base) matches one of the patterns: an exact path, where a "*" segment is any one segment. */
export function matchPath(path: string, patterns: readonly string[]): boolean {
	const p = trim(path).split("/");
	return patterns.some((pattern) => {
		const q = trim(pattern).split("/");
		return q.length === p.length && q.every((s, i) => (s === "*" ? p[i] !== "" : s === p[i]));
	});
}
