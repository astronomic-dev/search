/**
 * The default dialog's touch open (boot.ts): its stand-in is the embed's proxy box (embed/proxy.ts), which looks like
 * the dialog's header, and its handoff is a click on the bound trigger, then the stand-in's text and caret into the
 * dialog, with no entrance animation. A recipe's own boot, whose dialog the proxy does not look like, passes its own view
 * to touchOpens (touch.ts).
 */
import type { SearchElement } from "../ui/element.ts";
import type { BootApp } from "./start.ts";
import { touchOpens, type TouchDraft, type TouchOpen } from "./touch.ts";
import { showProxy } from "./embed/proxy.ts";

/** The dialog that answers `trigger`, once the app made it. */
const dialogOf = (trigger: HTMLElement) => [...document.querySelectorAll<SearchElement>("astronomic-search")].find((d) => d.triggers?.includes(trigger));

/** `placeholder`, `theme` and `searchPage` are the integration's settings. */
export const defaultTouch = (placeholder: string, searchPage?: string, theme?: string): TouchOpen =>
	touchOpens({
		show(trigger) {
			const known = dialogOf(trigger);
			const field = showProxy(document, placeholder, trigger, known ? known.getAttribute("theme") : theme);
			// What the dialog will open on: the trigger's own search, else the last one.
			field.input.value = (trigger.matches("[data-search-query],[data-search-type],[data-search-filters]") ? trigger.dataset.searchQuery : known?.controller.getState().query) ?? "";
			return { ...field, searchPage };
		},
	});

/** The app's openTouch: the bound trigger's own click opens the dialog, then the text and the caret go over. */
export function openTouch(trigger: HTMLElement, draft: TouchDraft): boolean {
	trigger.click();
	const el = dialogOf(trigger);
	// The click was made either way; the helper makes no second one.
	if (!el?.controller.getState().open) return false;
	const root = el.shadowRoot!;
	const box = root.querySelector("dialog")!;
	// The dialog's first input is its search box ([part=input]), in the header before the filters.
	const input = root.querySelector("input")!;
	// Inline, so it wins over the element's sheet; dropped on close, so the next open animates again.
	box.style.animation = "none";
	box.addEventListener("close", () => box.style.removeProperty("animation"), { once: true });
	if (draft.changed) el.controller.input(draft.value);
	input.setSelectionRange(draft.start, draft.end, draft.direction ?? undefined);
	// Whether the real input has the focus.
	return root.activeElement === input;
}

/** The app with openTouch, for startBoot's load. */
export const withTouch = (app: BootApp): BootApp => ({ prepare: app.prepare, openTouch });
