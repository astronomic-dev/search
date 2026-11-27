/**
 * The embed's one open path, for every opener the boot owns (a placement, the theme field with takeover). It lives in
 * the boot, so it runs before the app chunk is in.
 *
 * Each open is a session: it owns its proxy, its deadline and its dialog watch, and it ends once, through `end`. A new
 * open ends the current session first, so no proxy is left behind, and only the current session may turn the embed
 * off or run a fallback.
 *
 * A touch open always goes through the proxy, warm or cold: the proxy input takes focus inside the tap, so iOS opens
 * the keyboard, and the real dialog takes over when the app is in and at least 150 ms have passed (see enterProxy), with no
 * entrance animation (iOS leaves the keyboard up but types nothing into a dialog that opens inside the tap). A mouse
 * or keyboard open with the app loaded opens the real dialog at once. A cold one shows the proxy too, so typing is
 * never lost.
 */
import type { EmbedConfig } from "../config.ts";
import type { EmbedApp } from "../embed-app.ts";
import type { SearchElement } from "../../ui/element.ts";
import { placementText } from "./open-from.ts";
import { enterProxy, inProxy, showProxy, type ProxyField } from "./proxy.ts";

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
 * The open function. The config's placeholder is the proxy's text when the source's placement has none. `onFail` runs
 * when the app fails to load during the current open: the proxy's text goes back to the field (focused) or a link
 * follows its href, so the page works as it does with no JavaScript. The config's `theme` goes on the proxy. A theme
 * field's open (`release`) also fails when the dialog's index fails to load (a 503 before the first build): the field is
 * released, the dialog closes, and the text and focus go back to the field. A link that goes to the results page
 * (the config's `results`, with no query) gets the text typed meanwhile as its `queryParam`, so the draft is not lost.
 */
export function createOpen(doc: Document, app: AppHandle, config: EmbedConfig, onFail: () => void, release?: Release): Open {
	// Constants first in this function, not the module, so the build inlines them.
	/**
	 * Why a session ends: quietly (handed off and settled, closed, dismissed or replaced), Escape in the proxy, a submit
	 * open's deadline or index failure, or the app chunk failing to load.
	 */
	const QUIET = 0;
	const ESCAPE = 1;
	const FAIL = 2;
	const NO_APP = 3;
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
			} else if (opener instanceof HTMLAnchorElement) {
				// A link to the results page itself (no query) gets the text typed meanwhile; any other link is followed as it
				// is. The config's results URL parses against the page (config.ts checks it so).
				const to = new URL(config.results, doc.baseURI);
				location.assign(text && to.href == opener.href ? (to.searchParams.set(config.queryParam, text), to) : opener.href);
			}
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
		const text = placementText(source) || config.strings.placeholder || "Search";
		proxy = showProxy(doc, text, opener, config.theme);
		const input = proxy.input;
		input.value = value;
		// Its reasons to leave are QUIET and ESCAPE.
		const held = enterProxy(proxy, opener, (why) => proxy && end(why));
		if (field) input.setSelectionRange(...caretOf(field));
		// Here the app is in only for a touch open (see above), which holds the proxy at least 150 ms: iOS needs that
		// long to tie the keyboard to the proxy.
		Promise.all([ready ?? app.load(), touch && held]).then(
			([a]) => cur === end && (inProxy(input) ? toDialog(a, input.value, caretOf(input), true) : end(QUIET)),
			() => end(inProxy(input) ? NO_APP : QUIET),
		);
	};
}
