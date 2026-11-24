/**
 * The config tag's `links` key, read in the app chunk only (not by parseEmbedConfig in the boot), so it costs the boot
 * nothing: the page must keep its tag until search first loads.
 */
import { CONFIG_TAG } from "../config.ts";

/**
 * "new-tab" when the page's config tag (the one readConfigTag reads: the first not inside a [data-search-page]) says
 * so; anything else gives undefined (the same tab). Never throws.
 */
export function readLinks(doc: Pick<Document, "querySelectorAll">): "new-tab" | undefined {
	const tag = [...doc.querySelectorAll(CONFIG_TAG)].find((el) => !el.closest("[data-search-page]"));
	try {
		return JSON.parse(tag?.textContent ?? "null")?.links === "new-tab" ? "new-tab" : undefined;
	} catch {
		return undefined;
	}
}
