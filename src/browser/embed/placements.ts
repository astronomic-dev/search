/**
 * Placements: `[data-search-placement]` containers the server prints and styles (the package draws no placement
 * field; it adds behavior only). Inline holds a plain GET search form: its field opens the dialog with its text and
 * caret. Modal holds a plain link: a click or a tap opens it. With no JavaScript both work as they are.
 *
 * The index and placeholder are read from the placement at the moment of the event (EmbedApp.openFrom and the proxy
 * read them).
 */
import type { Hit } from "./input.ts";

export const PLACEMENT = "[data-search-placement]";

/**
 * What `t`, inside `placement`, opens: an inline placement's search field (its text or search input named `name`), or
 * a modal placement's opener link (its first link; others in it, such as a help link, are left alone).
 */
export function placementHit(t: Element, placement: Element, name: string): Hit {
	const open = placement.getAttribute("data-search-open");
	if (open === "inline") return t instanceof HTMLInputElement && (t.type === "search" || t.type === "text") && t.name === name ? t : null;
	// Not t.closest: a form's control named "closest" shadows it.
	const a = open === "modal" && Element.prototype.closest.call(t, "a[href]");
	return a && placement.querySelector("a[href]") === a ? (a as HTMLAnchorElement) : null;
}
