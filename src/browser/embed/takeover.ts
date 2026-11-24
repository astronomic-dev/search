/**
 * Theme takeover: the theme's own search form (for example a CMS theme's `s` form in the header) opens the dialog instead of
 * going to the results page. Only a plain search form qualifies (`qualifies()`); any other form stays fully native,
 * and so does every form when takeover is off or `standDown` is set. Forms inside a placement or the results mount never
 * qualify.
 *
 * Its field opens like any field the embed owns (input.ts). If the dialog's index then fails to load (a 503 before the
 * first build), the field is released: the dialog closes, the text goes back into the field, and the form stays native. A submit of the form opens it too, unless its submitter
 * has formaction, formmethod or formtarget, or is an image button (then it submits natively). The form's target
 * counts with an inherited <base target>. Fail open: when a submit-started open fails (the app chunk, a 4 s wait for
 * it, or the dialog's index while it is open), the latest text goes back into the theme field and the form submits
 * natively through the same submitter, so its name=value still joins the query. That form stays native from then on
 * (its field too: the dialog's focus return there must not open it again).
 *
 * The placeholder setting (`strings.placeholder`), when set, also goes onto the field of every form takeover takes, so
 * the theme's box shows the same text as the dialog's. The field is read-only while taken, with aria-haspopup="dialog";
 * both are its own again once it is released, once its form stops qualifying (at the field's next use), and on every
 * taken field when the embed turns off (one out of the page then: at its next use). Forms on the page at boot get it at once; a form added later gets
 * it at its first hover, focus or input. With takeover off, no theme field is touched.
 *
 * EmDash's LiveSearch box (LIVE) has no form: its field opens the dialog like a taken form's field and gets the
 * placeholder the same way. It has no submit, so it has no fallback; if the app or the dialog's index fails, the text
 * goes back into it with an input event (session.ts), and it is released, so EmDash's own search works natively. Its own dropdown never opens: the dialog takes focus and the typing.
 */
import type { EmbedConfig } from "../config.ts";
import type { Hit, SubmitRequest } from "./input.ts";
import type { Release } from "./session.ts";
import { PLACEMENT } from "./placements.ts";

/** The results page's mount: the server prints its own results, form included, inside it. */
export const RESULTS = "[data-search-results]";

/**
 * A theme search box with no form: EmDash's LiveSearch (`emdash/ui/search`, the <emdash-live-search> element), whose
 * input has no form and no name. Only that component's input, so a page's other formless inputs (a table filter, a
 * chat box) stay native.
 */
export const LIVE = "emdash-live-search input";

export interface TakeoverRule {
	enabled: boolean;
	inputName: string;
	skip: string;
	allowFields: string[];
	/** The results page URL, absolute. */
	results: string;
	standDown?: string | null;
}

/**
 * What qualifies() reads from a form, read without shadowing (a control named or id'd "action", "method",
 * "elements" or "closest" would otherwise replace the form's own property; see shapeOf).
 */
export interface FormShape {
	elements: ArrayLike<HTMLInputElement>;
	/** "get", "post" or "dialog". */
	method: string;
	target: string;
	/** Resolved (an empty action is the page's own URL). */
	action: string;
	/** The form matches `sel`, or is inside it. */
	in(sel: string): boolean;
}

/** `el` has a formaction, formmethod or formtarget override. */
const overrides = (el: Element) => ["formaction", "formmethod", "formtarget"].some((a) => el.hasAttribute(a));

/** Parses `u` against `base`; null when it cannot. */
const parse = (u: string, base?: string): URL | null => {
	try {
		return new URL(u, base);
	} catch {
		return null;
	}
};

/** The field of `form` when it is a plain theme search form takeover may take, else false. Pure over the shape. */
export function qualifies(form: FormShape, rule: TakeoverRule): HTMLInputElement | false {
	// (f) takeover is on.
	if (!rule.enabled || rule.standDown) return false;
	// (a) and (b): exactly one control named inputName (disabled ones count), a search or text input; every other
	// named, enabled control is an allowed hidden input or a submit button with no action, method or target override
	// (its name=value only joins the query). Walked from form.elements, never a built selector.
	let field: HTMLInputElement | undefined;
	for (const el of Array.from(form.elements)) {
		const input = el.localName === "input";
		if (el.name === rule.inputName) {
			if (!input || (el.type !== "search" && el.type !== "text") || field) return false;
			field = el;
		} else if (
			el.name &&
			!el.disabled &&
			!(input && el.type === "hidden" && rule.allowFields.includes(el.name)) &&
			!(el.type === "submit" && !overrides(el))
		)
			return false;
	}
	if (!field) return false;
	// (c) and (d): not skipped, not in a placement or the results mount (the server form there is the page's own).
	if (form.in(rule.skip) || form.in(PLACEMENT) || form.in(RESULTS)) return false;
	// (e) a plain GET to the results page, in this window. A malformed action does not qualify.
	if (form.method !== "get" || !/^(_self)?$/i.test(form.target)) return false;
	const a = parse(form.action, rule.results);
	const r = parse(rule.results);
	return !!a && !!r && a.origin === r.origin && a.pathname === r.pathname && field;
}

/** The form's own elements, method, effective target, action and closest(), never a control that shadows them. */
function shapeOf(form: HTMLFormElement, doc: Document): FormShape {
	const get = (k: string) => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, k)!.get!.call(form);
	// The effective target: the form's own, else the first <base target> (a base target="_blank" opens a new tab).
	const target = Element.prototype.hasAttribute.call(form, "target") ? get("target") : (doc.querySelector("base[target]")?.getAttribute("target") ?? "");
	return { elements: get("elements"), method: get("method"), target, action: get("action"), in: (sel) => !!Element.prototype.closest.call(form, sel) };
}

export interface Takeover {
	/** What `t` is to takeover: the field of a form it takes or a LiveSearch field it takes, or a form it takes. */
	hit(t: Element): Hit;
	submit: SubmitRequest;
	release: Release;
	/** Gives every taken field back to the theme. */
	off(): void;
}

/** Starts takeover. Returns null when takeover is off: then every form stays native. */
export function startTakeover(doc: Document, config: EmbedConfig): Takeover | null {
	const t = config.takeover;
	if (!t.enabled || config.standDown) return null;
	// A malformed results URL: takeover is off.
	const results = parse(config.results, doc.baseURI);
	if (!results) return null;
	const rule: TakeoverRule = { ...t, results: results.href };
	/** The forms a fallback submitted natively, and the forms and LiveSearch fields released: each stays native for the rest of the page's life. */
	const left = new WeakSet<Element>();
	const text = config.strings.placeholder;
	/**
	 * A field takeover takes is read-only while taken (still focusable, so it stays the trigger focus returns to): no
	 * key, paste, IME text or drop edits it, so the theme's own search never sees an edit; the keys open the dialog
	 * (input.ts). data-search-taken keeps what the field had before: "1" or "0" for read-only, then its aria-haspopup.
	 * It is an attribute, so a copy of a taken field (a theme that clones its header into a menu) is freed right too.
	 * A field that was read-only before is taken like any other (the site turned takeover on; some themes set read-only
	 * until focus, against autofill), and is read-only again once released.
	 */
	const own = (field: HTMLInputElement) => {
		if (text) field.placeholder = text;
		field.dataset.searchTaken ??= +field.readOnly + (field.ariaHasPopup || "");
		field.readOnly = true;
		field.ariaHasPopup = "dialog";
	};
	/** Gives `field` its own values back when it is taken, whether or not it still qualifies; true then. */
	const free = (field: HTMLInputElement) => {
		// Any element can come here once the embed is off, so one with no dataset too.
		const was = field.dataset?.searchTaken;
		if (!was) return;
		field.readOnly = was >= "1";
		field.ariaHasPopup = was.slice(1) || null;
		delete field.dataset.searchTaken;
		return true;
	};
	const takes = (form: HTMLFormElement) => {
		const field = !left.has(form) && qualifies(shapeOf(form, doc), rule);
		if (field) own(field);
		return field;
	};
	/** A LiveSearch field takeover takes: one with no form, not in skip (a placement's field is the placement's). */
	const live = (el: HTMLInputElement) => {
		const ok = !el.form && !left.has(el) && el.matches(LIVE) && !el.closest(t.skip);
		if (ok) own(el);
		return ok;
	};
	const hit = (el: Element): Hit => {
		if (el instanceof HTMLFormElement) return takes(el) ? el : null;
		if (!(el instanceof HTMLInputElement)) return null;
		if (el.form ? el.name === t.inputName && takes(el.form) : live(el)) return el;
		// A field taken before that no longer qualifies: a press, focus or key on it finds it editable.
		free(el);
		return null;
	};
	doc.querySelectorAll("form," + LIVE).forEach(hit);
	return {
		hit,
		release: (f) => free(f) && left.add(f.form ?? f),
		off: () => doc.querySelectorAll<HTMLInputElement>("[data-search-taken]").forEach(free),
		submit: (form, by) => {
			// An override, or an image button (requestSubmit cannot replay its click's x and y): native.
			if (by && (overrides(by) || (by as HTMLInputElement).type === "image")) return null;
			// Only a form takeover takes comes here (input.ts asks hit() first): its field.
			const field = takes(form) as HTMLInputElement;
			return {
				source: field,
				// Focus returns to the button that submitted, else to the field.
				opener: by ?? field,
				field,
				fallback: (text) => {
					field.value = text;
					free(field);
					left.add(form);
					const submit = HTMLFormElement.prototype.requestSubmit;
					try {
						submit.call(form, by);
					} catch {
						// The submitter left the form meanwhile.
						submit.call(form);
					}
				},
			};
		},
	};
}
