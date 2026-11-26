/**
 * Touch opens, for any boot (`@astronomic-dev/search/boot`). iOS opens the keyboard only for a focus() made inside the
 * tap, and leaves it up but types nothing into a dialog that opens right inside it. So a tap on a trigger, with the app
 * loaded or not, focuses a stand-in box in its click; once the app is in, the stand-in has held focus 150 ms and no
 * input method composition is under way, the app's dialog takes over the focus, the text and the caret.
 *
 * The view makes the stand-in (`show`); everything else is here, shared by every dialog: which click comes from a
 * touch, one open at a time, Escape, focus that leaves, a client router's swap, the hold, composition and the failed load.
 * The default dialog's view is touch-default.ts; a recipe passes its own, so its stand-in looks like its own dialog.
 */
import type { BootApp } from "./start.ts";

/** The stand-in box a view shows: mounted and unfocused, with its start text in `input`. The helper removes `host`. */
export interface TouchField {
	host: HTMLElement;
	input: HTMLInputElement;
	/**
	 * The site's search page. If the app fails to load and the trigger's link goes to this page (the same origin and
	 * path), the text typed in the stand-in goes along as `q` (the link's other parameters and its hash stay). Left out,
	 * for a trigger with another link or its own (`data-search-href`), the link is followed as it is.
	 */
	searchPage?: string;
}

export interface TouchView {
	/** Makes and mounts the stand-in for `trigger`, not focused yet, or returns null for an ordinary open. */
	show(trigger: HTMLElement): TouchField | null;
}

/** What was typed in the stand-in, for `BootApp.openTouch`. */
export interface TouchDraft {
	value: string;
	/** The text is not the stand-in's start text. */
	changed: boolean;
	start: number | null;
	end: number | null;
	direction: "forward" | "backward" | "none" | null;
}

/**
 * Made by `touchOpens`, for `BootOptions.touch`. Takes a plain click on a trigger, bound or not, when it comes from a
 * touch, and returns true then. `load` loads the app and binds its dialog; `press` clicks the trigger for that binder.
 */
export type TouchOpen = (e: MouseEvent, trigger: HTMLElement, load: () => Promise<BootApp>, press: () => void) => boolean;

/**
 * Touch opens through `view`'s stand-in: `startBoot({ ..., touch: touchOpens(view) })`. When the app is in, its
 * `openTouch(trigger, draft)` opens the dialog; an app without one gets a click on the trigger, as a mouse does.
 */
export function touchOpens(view: TouchView): TouchOpen {
	const doc = document;
	/**
	 * The last touchend, and the touchend the last trusted click came after: a touch counts for the one click that
	 * follows it, and for no later one. A key, or a press with no touchend after it (a mouse's), clears it. (A touchend
	 * listener does not hold up scrolling, so it need not be passive.)
	 */
	let last: TouchEvent | null = null;
	let click: [Event, TouchEvent | null] | null = null;
	doc.addEventListener("touchend", (e) => (last = e), true);
	doc.addEventListener("keydown", (e) => e.isTrusted && (last = null), true);
	doc.addEventListener("pointerdown", (e) => e.isTrusted && (last = null), true);
	doc.addEventListener(
		"click",
		(e) => {
			if (e.isTrusted) (click = [e, last]), (last = null);
		},
		true,
	);
	/** Ends the current open: each owns its stand-in, and ends once. True then. */
	let cur: (() => boolean) | null = null;
	// A client router leaves the page: a trigger it keeps must not open search on the next one.
	doc.addEventListener("astro:before-swap", () => cur?.());

	return (e, trigger, load, press) => {
		const touch = click?.[0] === e && click[1];
		// The first click within 1 s of a touch on the trigger, unless the touch was canceled. Never a click's pointerType:
		// WebKit's is not the touch's. A script's click on a trigger (from a field that has focus) opens the dialog at once,
		// as a mouse does.
		if (!touch || touch.defaultPrevented || e.timeStamp - touch.timeStamp > 1000 || !trigger.contains(touch.target as Node)) return false;
		cur?.();
		const field = view.show(trigger);
		if (!field) return false;
		const { input, host, searchPage } = field;
		const start = input.value;
		let composing = false;
		const end = () => {
			if (cur !== end) return false;
			cur = null;
			host.remove();
			return true;
		};
		cur = end;
		const focused = () => (input.getRootNode() as Document | ShadowRoot).activeElement === input;
		/** Still in the stand-in: it has focus, or the window itself lost it. False once it is out of the page or hidden. */
		const inside = () => input.isConnected && (!doc.hasFocus() || focused());
		input.focus();
		// No focus: a modal dialog the view's stand-in is not in (a closed shadow root's, whose slots are hidden) keeps
		// the page inert. The trigger's own subtree is rendered in that dialog, so the stand-in moves next to it, in the
		// trigger's named slot when the trigger is the host's own child. Still none: an ordinary open.
		if (cur === end && !focused()) {
			host.slot = trigger.slot;
			trigger.after(host);
			input.focus();
			if (!focused() && end()) return false;
		}
		input.addEventListener("keydown", (k) => {
			// Escape while composing belongs to the input method.
			if (k.key !== "Escape" || composing || k.isComposing || k.keyCode === 229) return;
			// Only the stand-in closes: inside a modal drawer the same Escape would cancel the drawer too.
			k.preventDefault();
			k.stopPropagation();
			if (end()) trigger.focus({ preventScroll: true });
		});
		// Focus left before the handoff (Tab, a click elsewhere, a menu around the stand-in closed): the open is
		// dropped, so a late load does not take focus back. Checked a task later, and again when the app is in.
		input.addEventListener("focusout", () => setTimeout(() => inside() || end()));
		input.addEventListener("compositionstart", () => (composing = true));
		input.addEventListener("compositionend", () => (composing = false));
		/** Runs `f` once no composition is under way (its text is not final, and a focus move would cut it). */
		const settled = (f: () => void): unknown => (cur === end && composing ? setTimeout(settled, 20, f) : f());
		// On an iPhone a handoff a few ms after the stand-in took focus left the keyboard up but typed nothing, most often
		// when the keyboard was already up from a focus return; 100 ms and more worked every time.
		Promise.all([load(), new Promise((r) => setTimeout(r, 150))]).then(
			([app]) => app,
			() => null,
		).then((app) =>
			settled(() => {
				if (cur !== end || (!inside() && end())) return;
				const value = input.value;
				if (app)
					try {
						// The order matters: the real input takes focus from the stand-in, then the stand-in goes. An app with no
						// openTouch gets the press; one whose openTouch returns false none (it may have opened its dialog). A route
						// swap meanwhile removed the trigger: the open is dropped (press does nothing then).
						trigger.isConnected && app.openTouch
							? app.openTouch(trigger, { value, changed: value !== start, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection })
							: press();
					} finally {
						end();
					}
				else {
					// The load failed: the link is followed, as with no JavaScript, with the text typed meanwhile when it goes to
					// the search page. A trigger with no link stays; a malformed searchPage leaves the link as it is.
					end();
					const key = (u: URL) => u.origin + u.pathname.replace(/\/$/, "");
					let to: URL | undefined;
					try {
						// No link (a button) throws here, a malformed searchPage below, with `to` made.
						to = new URL((trigger as HTMLAnchorElement).href);
						if (searchPage && value !== start && !trigger.hasAttribute("data-search-href") && key(to) === key(new URL(searchPage, doc.baseURI))) to.searchParams.set("q", value);
					} catch {}
					if (to && trigger.isConnected) location.assign(to.href);
				}
			}),
		);
		return true;
	};
}
