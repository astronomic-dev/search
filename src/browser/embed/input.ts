/**
 * The embed's one set of input listeners, capture-phase on the document, so an opener added later works. Every event
 * asks one `resolve(target)` what its target is, and acts only on the kind it opens from:
 *
 * - a text field the embed owns: keyboard focus, a mouse press or a stationary tap opens the dialog with the field's
 *   text and caret, and the field is the opener. A printable key, a paste, an IME or dead key, Enter or a click in it
 *   opens too (the key's text lands in the dialog's box, never in the field), so a field that got focus back when search
 *   closed is the trigger again, and the theme's own key handlers (LiveSearch's dropdown) never run; Tab, Escape and the
 *   arrows do not open, and neither does a script's key, paste, value change or input event;
 * - a link that opens the dialog: a plain click or a tap (a modified click keeps its native behavior);
 * - a form whose submit the embed takes: the submit opens, through the request `submit` builds.
 *
 * Whether an open comes from a touch is read from one place (tap.ts), for every kind, focus included: a field that a
 * tapped control focuses from its click is a touch open, so it goes through the proxy.
 */
import type { Open, OpenRequest } from "./session.ts";
import { onTap } from "./tap.ts";

/** What a target is to the embed: a field it owns, a link that opens it, a form it takes; null: none of them. */
export type Hit = HTMLInputElement | HTMLAnchorElement | HTMLFormElement | null;

/** The open request for a submit of `form` by `by` (its submitter), or null to leave the submit native. */
export type SubmitRequest = (form: HTMLFormElement, by: HTMLElement | null) => Omit<OpenRequest, "touch"> | null;

export function bindInput(doc: Document, resolve: (t: EventTarget | null) => Hit, open: Open, submit?: SubmitRequest): void {
	/**
	 * Where focus may go back to when search closes: an open's opener, and what had focus when it started (a closing
	 * modal dialog gives focus back there first). A focusin on one of them is that return, not a new open.
	 */
	const returning = new Set<Element | null>();
	/** The field a mouse press opened: that press's mousedown must not focus it behind the dialog. */
	let pressed: HTMLInputElement | null = null;

	const go = (r: OpenRequest) => {
		returning.add(doc.activeElement).add(r.opener);
		open(r);
	};
	// A field open always replaces the open before it: the page behind an open dialog is inert, so a field can only
	// supersede a proxy, never join a dialog. A link or submit open can join one (a page script's click while it is
	// open), and that dialog keeps its first opener, so it keeps the earlier markers.
	const fromField = (field: HTMLInputElement, touch: boolean, fallback?: OpenRequest["fallback"]) => {
		returning.clear();
		go({ source: field, opener: field, field, touch, fallback });
	};
	const fieldOf = (t: EventTarget | null) => {
		const hit = resolve(t);
		return hit instanceof HTMLInputElement ? hit : null;
	};
	/** The field of a person's event in one, which no other listener then gets. */
	const mine = (e: Event) => {
		const field = e.isTrusted && fieldOf(e.target);
		if (field) e.stopImmediatePropagation();
		return field;
	};
	const touched = onTap(doc, fieldOf, (field) => fromField(field as HTMLInputElement, true));
	const on = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => doc.addEventListener(type, fn, true);

	on("focusin", (e) => {
		// A field in a host's shadow root has the host as the target.
		const field = fieldOf(e.target);
		if (returning.delete(field || (e.target as Element))) return;
		// Focus moving into a shadow root (the dialog's or the proxy's; from here the target is the host) keeps the
		// return pending.
		if (!(e.target as Element).shadowRoot) returning.clear();
		if (field) fromField(field, touched(e));
	});
	// A person's key in a field that has focus (it got focus back when search closed, or a script focused it) opens,
	// and the theme's own key handlers never run. The open moves focus to the dialog's box (or the proxy's) inside the
	// keydown, so the browser puts the key's text or an IME composition there, at the field's caret; the field keeps its
	// own text. A taken theme field is read-only besides (takeover.ts), so no edit ever reaches it or the theme's own
	// search (LiveSearch's dropdown). A printable key opens (with Shift, AltGr or Option; not with Ctrl or Cmd alone), and
	// so do a dead key, an IME's key (229, whatever its name: "Process", "Unidentified") and Enter. Tab, Escape and the
	// arrows do not, and neither does a script's key.
	on("keydown", (e) => {
		const k = e.key;
		const enter = k == "Enter";
		const field = (k.length < 2 ? !e.metaKey && (!e.ctrlKey || e.altKey) : enter || k == "Dead" || e.keyCode == 229) && mine(e);
		if (!field) return;
		// Enter types nothing, and a form's Enter would submit it: the dialog is the field's. In a form takeover takes it is
		// that submit, so a failed open submits as the browser's own Enter does: by the form's first submit button, not at all
		// when that one is disabled, and with no button only when the form has no second input that takes text. (Nor when that
		// button's submit stays native.) Focus still comes back to the field.
		if (enter) e.preventDefault();
		const form = enter && (resolve(field.form) as HTMLFormElement | null);
		// The form's submit buttons and the inputs that take text: every other type, and only those, starts with one of these letters.
		const all = [...doc.querySelectorAll<HTMLInputElement>("button,input")].filter((b) => b.form == form && /^[^bcfhr]/.test(b.type));
		const by = all.find((b) => /submit|image/.test(b.type));
		const sends = form && (by ? !by.matches(":disabled") : !all[1]);
		fromField(field, false, (sends && submit!(form, by!)?.fallback) as OpenRequest["fallback"]);
	});
	// A paste (a shortcut's, the menu's, any other) opens with the clipboard's text in the box that takes focus. The field
	// gets the event even while it is read-only, and focus is still in it, so a paste runs here or in the box, never both.
	on("paste", (e) => {
		const field = mine(e);
		if (!field) return;
		e.preventDefault();
		fromField(field, touched(e));
		doc.execCommand("insertText", false, e.clipboardData!.getData("text"));
	});
	on("pointerdown", (e) => {
		// Every mousedown follows a pointerdown, so a press whose mousedown never came cannot reach the next one.
		pressed = null;
		const field = fieldOf(e.target);
		if (!field || e.pointerType !== "mouse" || e.button) return;
		pressed = field;
		fromField(field, false);
	});
	on("mousedown", (e) => {
		if (e.target === pressed) e.preventDefault();
		pressed = null;
	});
	on("click", (e) => {
		const link = resolve(e.target);
		// A click that comes alone, as an assistive technology's does: a press or a tap opened by now, and moved focus; a
		// label's click comes before its focus, which opens.
		if (link == doc.activeElement && link instanceof HTMLInputElement) fromField(link, touched(e));
		if (!(link instanceof HTMLAnchorElement) || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		go({ source: link, opener: link, field: null, touch: touched(e) });
	});
	on("submit", (e) => {
		const form = resolve(e.target);
		const r = form instanceof HTMLFormElement && !e.defaultPrevented && submit?.(form, e.submitter);
		if (!r) return;
		e.preventDefault();
		go({ ...r, touch: touched(e) });
	});
}
