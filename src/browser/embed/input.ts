/**
 * The embed's one set of input listeners, capture-phase on the document, so an opener added later works. Every event
 * asks one `resolve(target)` what its target is, and acts only on the kind it opens from:
 *
 * - a text field the embed owns: keyboard focus, a mouse press or a stationary tap opens the dialog with the field's
 *   text and caret, and the field is the opener;
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
	const fromField = (field: HTMLInputElement, touch: boolean) => {
		returning.clear();
		go({ source: field, opener: field, field, touch });
	};
	const fieldOf = (t: EventTarget | null) => {
		const hit = resolve(t);
		return hit instanceof HTMLInputElement ? hit : null;
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
	on("pointerdown", (e) => {
		// Every mousedown follows a pointerdown, so a press whose mousedown never came cannot reach the next one.
		pressed = null;
		const field = fieldOf(e.target);
		if (!field || e.pointerType !== "mouse" || e.button) return;
		pressed = field;
		fromField(field, false);
	});
	on("mousedown", (e) => {
		if (pressed && e.target === pressed) e.preventDefault();
		pressed = null;
	});
	on("click", (e) => {
		const link = resolve(e.target);
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
