/**
 * Theme takeover: the theme's own search form (for example a CMS theme's `s` form in the header) opens the dialog instead of
 * going to the results page. Only a plain search form qualifies (`qualifies()`); any other form stays fully native,
 * and so does every form when takeover is off or `standDown` is set. Forms inside a placement or the results mount never
 * qualify.
 *
 * Its field opens like any field the embed owns (input.ts). A submit of the form opens it too, unless its submitter
 * has formaction, formmethod or formtarget, or is an image button (then it submits natively). The form's target
 * counts with an inherited <base target>. Fail open: when a submit-started open fails (the app chunk, a 4 s wait for
 * it, or the dialog's index while it is open), the latest text goes back into the theme field and the form submits
 * natively through the same submitter, so its name=value still joins the query. That form stays native from then on
 * (its field too: the dialog's focus return there must not open it again).
 */
import type { EmbedConfig } from "../config.ts";
import type { Hit, SubmitRequest } from "./input.ts";
import { PLACEMENT } from "./placements.ts";

/** The results page's mount: the server prints its own results, form included, inside it. */
export const RESULTS = "[data-search-results]";

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

/** Parses `u` against `base`; null when it cannot. */
const parse = (u: string, base?: string): URL | null => {
	try {
		return new URL(u, base);
	} catch {
		return null;
	}
};

/** True when `form` is a plain theme search form takeover may take. Pure over the shape. */
export function qualifies(form: FormShape, rule: TakeoverRule): boolean {
	// (f) takeover is on.
	if (!rule.enabled || rule.standDown) return false;
	// (a) and (b): exactly one control named inputName (disabled ones count), a search or text input; every other
	// named, enabled control is an allowed hidden input or a submit button with no action, method or target override
	// (its name=value only joins the query). Walked from form.elements, never a built selector.
	let field = 0;
	for (const el of Array.from(form.elements)) {
		const input = el.localName === "input";
		if (el.name === rule.inputName) {
			if (!input || (el.type !== "search" && el.type !== "text") || ++field > 1) return false;
		} else if (
			el.name &&
			!el.disabled &&
			!(input && el.type === "hidden" && rule.allowFields.includes(el.name)) &&
			!(el.type === "submit" && !["formaction", "formmethod", "formtarget"].some((a) => el.hasAttribute(a)))
		)
			return false;
	}
	if (field !== 1) return false;
	// (c) and (d): not skipped, not in a placement or the results mount (the server form there is the page's own).
	if (form.in(rule.skip) || form.in(PLACEMENT) || form.in(RESULTS)) return false;
	// (e) a plain GET to the results page, in this window. A malformed action does not qualify.
	if (form.method !== "get" || !/^(_self)?$/i.test(form.target)) return false;
	const a = parse(form.action, rule.results);
	const r = parse(rule.results);
	return !!a && !!r && a.origin === r.origin && a.pathname === r.pathname;
}

/** The form's own elements, method, effective target, action and closest(), never a control that shadows them. */
function shapeOf(form: HTMLFormElement, doc: Document): FormShape {
	const get = (k: string) => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, k)!.get!.call(form);
	// The effective target: the form's own, else the first <base target> (a base target="_blank" opens a new tab).
	const target = Element.prototype.hasAttribute.call(form, "target") ? get("target") : (doc.querySelector("base[target]")?.getAttribute("target") ?? "");
	return { elements: get("elements"), method: get("method"), target, action: get("action"), in: (sel) => !!Element.prototype.closest.call(form, sel) };
}

export interface Takeover {
	/** True when takeover takes `form` (the boot's warm-up uses it). */
	takes(form: HTMLFormElement): boolean;
	/** What `t` is to takeover: the field of a form it takes, or that form. */
	hit(t: Element): Hit;
	submit: SubmitRequest;
}

/** Starts takeover. Returns null when takeover is off: then every form stays native. */
export function startTakeover(doc: Document, config: EmbedConfig): Takeover | null {
	const t = config.takeover;
	if (!t.enabled || config.standDown) return null;
	// A malformed results URL: takeover is off.
	const results = parse(config.results, doc.baseURI);
	if (!results) return null;
	const rule: TakeoverRule = { ...t, results: results.href };
	/** The forms a fallback submitted natively: each stays native for the rest of the page's life. */
	const left = new WeakSet<HTMLFormElement>();
	const takes = (form: HTMLFormElement) => !left.has(form) && qualifies(shapeOf(form, doc), rule);
	return {
		takes,
		hit: (el) => (el instanceof HTMLFormElement ? (takes(el) ? el : null) : el instanceof HTMLInputElement && el.name === t.inputName && el.form && takes(el.form) ? el : null),
		submit: (form, by) => {
			// An override, or an image button (requestSubmit cannot replay its click's x and y): native.
			if (by && (["formaction", "formmethod", "formtarget"].some((a) => by.hasAttribute(a)) || (by as HTMLInputElement).type === "image")) return null;
			const field = Array.from(shapeOf(form, doc).elements).find((el) => el.name === t.inputName)!;
			return {
				source: field,
				// Focus returns to the button that submitted, else to the field.
				opener: by ?? field,
				field,
				fallback: (text) => {
					field.value = text;
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
