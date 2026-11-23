/**
 * Opens a dialog for an explicit opener: the theme field, a placement field or a modal link.
 * It lives in the embed, not in <astronomic-search>, so the Astro app does not carry it; the element only keeps the
 * `opener` it is handed, for where focus returns on close. It reads the element through public parts only (its
 * controller and its open shadow root), and imports no runtime code.
 */
import type { Start } from "../../controller/index.ts";
import type { SearchElement } from "../../ui/element.ts";

export interface OpenFrom extends Start {
	/** The selection to set in the box after it opens. */
	caret?: [number, number];
	/** A handoff from the proxy box: the dialog shows at once, with no entrance animation (it would flash the box). */
	handoff?: boolean;
	/** The box's placeholder and label for this open (see placementText); default: the strings' placeholder. */
	placeholder?: string;
}

/**
 * The text of the placement `source` is in (its data-search-placeholder), or "" with none. The proxy and the dialog
 * both read it from the open's source, here.
 */
export const placementText = (source: Element): string => source.closest("[data-search-placement]")?.getAttribute("data-search-placeholder") || "";

/**
 * Opens `el` on `start`. On a closed dialog it sets the opener (focus returns there on close) and the box's
 * placeholder and label (`start.placeholder`, else the default). On an open dialog it only applies the search: the
 * first opener and its placeholder stay. On close the box takes the default text back.
 */
export function openFrom(el: SearchElement, start: OpenFrom, opener: HTMLElement | null): void {
	const c = el.controller;
	const root = el.shadowRoot!;
	const input = root.querySelector<HTMLInputElement>('[part="input"]')!;
	if (!c.getState().open) {
		el.opener = opener;
		const text = start.placeholder || c.strings.placeholder;
		const dialog = root.querySelector("dialog");
		const label = (t: string) => {
			input.placeholder = t;
			input.setAttribute("aria-label", t);
		};
		label(text);
		// The placement's text is for this open only: the next open (the shortcut, a trigger) shows the default.
		if (text !== c.strings.placeholder) dialog?.addEventListener("close", () => label(c.strings.placeholder), { once: true });
		if (start.handoff && dialog) {
			// Inline, so it wins over the element's sheet; dropped on close, so the next open animates again.
			dialog.style.animation = "none";
			dialog.addEventListener("close", () => dialog.style.removeProperty("animation"), { once: true });
		}
	}
	c.open(start);
	if (start.caret) input.setSelectionRange(...start.caret);
}
