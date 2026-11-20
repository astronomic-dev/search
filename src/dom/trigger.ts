/**
 * The trigger: a plain link to /search that works with no JavaScript. Bound, it acts as the button that opens the
 * dialog; a click with a modifier key or the middle button still follows the link. A trigger may carry a starting
 * search (triggerStart): it opens the dialog with those words typed, and its href (/search?q=…) is the fallback.
 */
import type { Controller, Start } from "../controller/index.ts";
import { BOUND } from "./bound.ts";
import { ariaKeyshortcuts, isApple } from "./shortcut.ts";

export interface TriggerOptions {
	/** The shortcut keys, for aria-keyshortcuts. Omit or [] for none. */
	keys?: string[];
	/** Default: read from navigator. */
	apple?: boolean;
	/** Called just before this trigger opens the dialog. */
	onOpen?: (trigger: HTMLElement) => void;
}

type Attrs = { getAttribute(name: string): string | null; hasAttribute(name: string): boolean };

/**
 * A trigger's starting search, from its attributes, or undefined when it has none: `data-search-query` (the words
 * typed in the box), `data-search-type` (the type tab) and `data-search-filters` (facet picks in the search page's
 * URL form, `theme=lodestar`, a name repeated for several values). Any of the three makes the trigger open on that
 * search, replacing what the box held; with none, the dialog keeps its last search.
 */
export function triggerStart(el: Attrs): Start | undefined {
	const has = ["data-search-query", "data-search-type", "data-search-filters"].some((n) => el.hasAttribute(n));
	if (!has) return undefined;
	const picks: Record<string, string[]> = {};
	for (const [facet, value] of new URLSearchParams(el.getAttribute("data-search-filters") ?? "")) {
		if (value === "") continue;
		const list = Object.hasOwn(picks, facet) ? picks[facet]! : [];
		if (!list.includes(value)) list.push(value);
		// defineProperty, so a facet named "__proto__" stays an own key.
		Object.defineProperty(picks, facet, { value: list, enumerable: true, writable: true, configurable: true });
	}
	return { query: el.getAttribute("data-search-query") ?? "", type: el.getAttribute("data-search-type") || null, picks };
}

/** Whether a click follows a link in this tab: the main button, no modifier key. */
function plain(e: MouseEvent): boolean {
	return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function bindTrigger(link: HTMLElement, controller: Controller, options: TriggerOptions = {}): () => void {
	const win = link.ownerDocument.defaultView;
	const apple = options.apple ?? isApple(win?.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined);
	const before = ["role", "aria-haspopup", "aria-expanded", "aria-keyshortcuts"].map((n) => [n, link.getAttribute(n)] as const);

	link.setAttribute(BOUND, "");
	link.setAttribute("role", "button");
	link.setAttribute("aria-haspopup", "dialog");
	const shortcuts = ariaKeyshortcuts(options.keys ?? [], apple);
	if (shortcuts) link.setAttribute("aria-keyshortcuts", shortcuts);

	const sync = () => link.setAttribute("aria-expanded", String(controller.getState().open));
	sync();
	const unsubscribe = controller.subscribe(sync);

	const open = () => {
		options.onOpen?.(link);
		controller.open(triggerStart(link));
	};
	const onClick = (e: MouseEvent) => {
		if (e.defaultPrevented || !plain(e)) return;
		e.preventDefault();
		open();
	};
	// A link fires click on Enter by itself; a button also answers Space.
	const onKey = (e: KeyboardEvent) => {
		if (e.key !== " " || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
		e.preventDefault();
		open();
	};
	const preload = () => void controller.preload().catch(() => {});

	link.addEventListener("click", onClick);
	link.addEventListener("keydown", onKey);
	link.addEventListener("pointerenter", preload);
	link.addEventListener("focus", preload);
	return () => {
		unsubscribe();
		link.removeAttribute(BOUND);
		link.removeEventListener("click", onClick);
		link.removeEventListener("keydown", onKey);
		link.removeEventListener("pointerenter", preload);
		link.removeEventListener("focus", preload);
		for (const [name, value] of before) {
			if (value === null) link.removeAttribute(name);
			else link.setAttribute(name, value);
		}
	};
}
