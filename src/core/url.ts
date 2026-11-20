/**
 * One canonical URL form for every adapter: the site's base applied, no `.html`, no `index`, no query, and a trailing
 * slash per the site's `trailingSlash` setting. A hash (a heading's anchor) is kept.
 */
export interface UrlOptions {
	/** Astro's `base`, with slashes ("/" or "/docs-site/"). */
	base: string;
	trailingSlash: "always" | "never" | "ignore";
	/** Astro's build.format: decides "ignore". */
	format: "file" | "directory" | "preserve";
	/** The site's origin, for absolute URLs. */
	site?: string;
}

/** One form for every URL: base applied, no .html, no index, no query, slash per the site. Null for another site. */
export function cleanUrl(input: string, o: UrlOptions): string | null {
	const origin = o.site ? new URL(o.site).origin : "http://local.invalid";
	let url: URL;
	try {
		url = new URL(input, origin + "/");
	} catch {
		return null;
	}
	if (url.origin !== origin) return null;
	let path = url.pathname.replace(/\/{2,}/g, "/").replace(/\.html$/i, "").replace(/\/index$/i, "/");
	const base = o.base.endsWith("/") ? o.base : `${o.base}/`;
	if (base !== "/" && !path.startsWith(base) && `${path}/` !== base) {
		// A full URL (a canonical link) outside the base is not one of this site's pages; a root-relative path gets the base.
		if (/^([a-z][a-z\d+.-]*:|\/\/)/i.test(input.trim())) return null;
		path = base + path.replace(/^\//, "");
	}
	const slash = o.trailingSlash === "ignore" ? (o.format === "directory" ? "always" : "never") : o.trailingSlash;
	if (path !== "/") path = slash === "always" ? path.replace(/\/?$/, "/") : path.replace(/\/$/, "");
	return path + (url.hash || "");
}
