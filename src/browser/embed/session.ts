/**
 * The embed's one open path, for every opener the boot owns (a placement, the theme field with takeover). It lives in
 * the boot, so it runs before the app chunk is in.
 *
 * Each open is a session: it owns its proxy, its deadline and its dialog watch, and it ends once, through `end`. A new
 * open ends the current session first, so no proxy is left behind, and only the current session may turn the embed
 * off or run a fallback.
 *
 * A touch open always goes through the proxy, warm or cold: the proxy input takes focus inside the tap, so iOS opens
 * the keyboard, and the real dialog takes over when the app is in and at least HANDOFF ms have passed, with no
 * entrance animation (iOS leaves the keyboard up but types nothing into a dialog that opens inside the tap). A mouse
 * or keyboard open with the app loaded opens the real dialog at once. A cold one shows the proxy too, so typing is
 * never lost.
 */
import type { EmbedApp } from "../embed-app.ts";
import type { SearchElement } from "../../ui/element.ts";
import { placementText } from "./open-from.ts";
import { showProxy, type ProxyField } from "./proxy.ts";

export interface OpenRequest {
	/** The element the dialog is for: its placement's data-search-index picks the index (see EmbedApp.openFrom). */
	source: Element;
	/** Where focus returns on close: the theme field, the placement field or the modal link. */
	opener: HTMLElement;
	/** The text field the query and caret come from (and go back to if the app fails), if any. */
	field: HTMLInputElement | null;
	/** The open comes from a touch (a tap, or a click within 1 s of a touchend). */
	touch: boolean;
	/**
	 * A submit-started open (takeover's submit): called with the latest text when the open fails, in place of the
	 * field path, so the form can submit natively. It fails when the app chunk fails to load, when the app and the
	 * index are not both ready within 4 s of the submit, or when the dialog's index fails to load.
	 */
	fallback?: (text: string) => void;
}

export type Open = (r: OpenRequest) => void;

export interface AppHandle {
	/** Loads the app chunk (once; again after a failure). */
	load(): Promise<EmbedApp>;
	/** The app, once it is in. */
	ready(): EmbedApp | null;
}

const caretOf = (input: HTMLInputElement): [number, number] => {
	const end = input.value.length;
	return [input.selectionStart ?? end, input.selectionEnd ?? end];
};

/** When takeover has taken `field` (a theme form's field or LiveSearch), it gives it back, for good; truthy then. */
export type Release = (field: HTMLInputElement) => unknown;

/**
 * The open function. `defaultPlaceholder` is the proxy's text when the source's placement has none. `onFail` runs
 * when the app fails to load during the current open: the proxy's text goes back to the field (focused) or a link
 * follows its href, so the page works as it does with no JavaScript. `theme` (the config's) goes on the proxy. A theme
 * field's open (`release`) also fails when the dialog's index fails to load (a 503 before the first build): the field is
 * released, the dialog closes, and the text and focus go back to the field.
 */
export function createOpen(doc: Document, app: AppHandle, defaultPlaceholder: string, onFail: () => void, theme?: string, release?: Release): Open {
	// Constants first in this function, not the module, so the build inlines them.
	/**
	 * Why a session ends: quietly (handed off and settled, closed, dismissed or replaced), Escape in the proxy, a submit
	 * open's deadline or index failure, or the app chunk failing to load.
	 */
	const QUIET = 0;
	const ESCAPE = 1;
	const FAIL = 2;
	const NO_APP = 3;
	/**
	 * The least time a touch open keeps focus in the proxy before the handoff. On an iPhone a handoff a few ms after the
	 * proxy took focus left the keyboard up but typed nothing, most often when the keyboard was already up from a focus
	 * return; 100 ms and more worked every time.
	 */
	const HANDOFF = 150;
	/** How long a submit-started open waits for the app and the index, together, before the form submits natively. */
	const DEADLINE = 4000;
	/** Ends the current session. */
	let cur: ((why: number) => void) | null = null;

	return ({ source, opener, field, touch, fallback }) => {
		cur?.(QUIET);
		/** The proxy until the handoff, then the dialog; and the deadline and the dialog watch to undo. */
		let proxy: ProxyField | undefined;
		let el: SearchElement | undefined;
		let off: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		/** Ends this session once; after it ended, or once a newer one started, it does nothing. */
		const end = (why: number) => {
			if (cur !== end) return;
			cur = null;
			clearTimeout(timer);
			off?.();
			proxy?.host.remove();
			if (why === ESCAPE) opener.focus({ preventScroll: true });
			if (why === NO_APP) onFail();
			if (why < FAIL) return;
			const text = el ? el.controller.getState().query : (proxy?.input.value ?? "");
			if (fallback) {
				fallback(text);
				el?.controller.close();
			} else if (field && (release?.(field) || !el)) {
				// The app failed, or the dialog's index did for a theme field: that field goes back to the theme (released
				// first, so the focus return does not open it again; onFail does not reach one that is out of the page). A placement's dialog stays, with its error. The input
				// event lets the field's own search (LiveSearch, which listens on the input itself) run on the text.
				el?.controller.close();
				field.value = text;
				field.focus({ preventScroll: true });
				field.dispatchEvent(new Event("input"));
			} else if (opener instanceof HTMLAnchorElement) location.assign(opener.href);
		};
		cur = end;
		if (fallback) timer = setTimeout(end, DEADLINE, FAIL);

		/**
		 * Opens the real dialog. A submit-started open, or a field's, stays current until its index is in, the dialog
		 * closes, or (a submit's) the deadline.
		 */
		const toDialog = (a: EmbedApp, query: string, caret?: [number, number], handoff?: boolean) => {
			// The order matters: the real input takes focus from the proxy input, then the proxy goes.
			el = a.openFrom(source, { query, caret, handoff }, opener);
			proxy?.host.remove();
			proxy = undefined;
			// The open's own focus move can start a newer open (a page's focusin listener): that one is current now.
			if (cur !== end) return;
			if (!fallback && !field) return end(QUIET);
			const c = el.controller;
			off = c.subscribe((st) => !st.open && end(QUIET));
			c.preload().then(
				() => end(QUIET),
				() => end(FAIL),
			);
		};

		const ready = app.ready();
		const value = field?.value ?? "";
		if (ready && !touch) return toDialog(ready, value, field ? caretOf(field) : undefined);
		const text = placementText(source) || defaultPlaceholder;
		// Inside the opener's open modal dialog (a nav drawer), if any: the page around it is inert. The walk goes up
		// the composed tree (into a slot, out of a shadow root), so a drawer component's own shadow <dialog> counts.
		let modal: Element | null | undefined = opener;
		while (modal && !modal.matches("dialog[open]")) modal = modal.assignedSlot ?? modal.parentElement ?? (modal.parentNode as ShadowRoot | null)?.host;
		proxy = showProxy(doc, text, modal, theme);
		const input = proxy.input;
		const focused = () => (input.getRootNode() as ShadowRoot).activeElement === input;
		input.value = value;
		input.focus();
		// No focus: a modal dialog the walk could not find (a closed shadow root's, whose slots are hidden) keeps the
		// page inert. The opener's own subtree is rendered in that dialog, so the proxy mounts next to it instead, in
		// the opener's named slot when the opener is the host's own child.
		if (!focused()) {
			proxy.host.slot = opener.slot;
			opener.after(proxy.host);
			input.focus();
		}
		if (field) input.setSelectionRange(...caretOf(field));
		input.addEventListener("keydown", (e) => {
			if (e.key !== "Escape" || e.isComposing) return;
			// Only the proxy closes: inside a modal drawer the same Escape would cancel the drawer too.
			e.preventDefault();
			e.stopPropagation();
			end(ESCAPE);
		});
		// Focus left the proxy before the handoff (Tab, Shift+Tab, a click elsewhere): the open is dropped, so a late
		// load does not take focus back. Checked a task later, and not while the window itself lost focus.
		input.addEventListener("focusout", () =>
			setTimeout(() => {
				if (proxy && doc.hasFocus() && !focused()) end(QUIET);
			}),
		);
		// Here the app is in only for a touch open (see above), which holds the proxy at least HANDOFF ms: iOS needs that
		// long to tie the keyboard to the proxy.
		Promise.all([ready ?? app.load(), touch && new Promise((r) => setTimeout(r, HANDOFF))]).then(
			([a]) => cur === end && toDialog(a, input.value, caretOf(input), true),
			() => end(NO_APP),
		);
	};
}
