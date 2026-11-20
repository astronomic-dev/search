/**
 * Which result URLs may become links: a relative URL, or one with http: or https:. Anything else (javascript:,
 * data:, vbscript:, a custom scheme) is never rendered as a link and never followed. The browser's own URL parser
 * decides, so tricks like leading spaces or tabs inside the scheme are caught too.
 */
export function isSafeUrl(url: string): boolean {
	try {
		const { protocol } = new URL(url, "http://relative.invalid/");
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}
