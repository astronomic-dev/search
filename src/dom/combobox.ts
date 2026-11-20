/**
 * The search box as an editable combobox with list autocomplete (WAI-ARIA APG). Focus stays in the box;
 * aria-activedescendant marks the active option. The recipe renders the options: each element has
 * role="option" and id = idFor(option.id). The binder re-syncs when the list re-renders, whichever runs first.
 */
import type { Controller, Option } from "../controller/index.ts";
import { isSafeUrl } from "./safe-url.ts";

export interface ComboboxOptions {
	/** Opens a result. Default: location.assign(url), or window.open in a new tab. */
	navigate?: (url: string, newTab: boolean) => void;
	/** Called when an option is opened (Enter, a click, a new tab), with its 1-based position. mountSearch fires search:select from it. */
	onSelect?: (option: Option, position: number) => void;
}

function composing(e: KeyboardEvent): boolean {
	return e.isComposing || e.keyCode === 229;
}

let counter = 0;
function ensureId(el: HTMLElement, base: string): string {
	if (!el.id) el.id = `${base}-${++counter}`;
	return el.id;
}

export function bindCombobox(
	input: HTMLInputElement,
	listbox: HTMLElement,
	controller: Controller,
	idFor: (recordId: string) => string,
	options: ComboboxOptions = {},
): () => void {
	const win = input.ownerDocument.defaultView!;
	const navigate = options.navigate ?? ((url: string, newTab: boolean) => (newTab ? win.open(url, "_blank", "noopener") : win.location.assign(url)));

	input.setAttribute("role", "combobox");
	input.setAttribute("aria-controls", ensureId(listbox, "search-listbox"));
	input.setAttribute("aria-autocomplete", "list");
	input.setAttribute("autocomplete", "off");
	if (!listbox.hasAttribute("role")) listbox.setAttribute("role", "listbox");
	// Focus stays in the box: a scrolling list is otherwise a tab stop in some engines.
	if (!listbox.hasAttribute("tabindex")) listbox.setAttribute("tabindex", "-1");

	let lastActive = "";
	/** The option id the pointer made active: it is under the pointer, so it is not scrolled. */
	let pointed = "";

	const sync = () => {
		const s = controller.getState();
		if (!s.composing && input.value !== s.query) input.value = s.query;
		input.setAttribute("aria-expanded", String(s.options.length > 0));
		const option = s.active >= 0 ? s.options[s.active] : undefined;
		const activeId = option ? idFor(option.id) : "";
		if (activeId) input.setAttribute("aria-activedescendant", activeId);
		else input.removeAttribute("aria-activedescendant");
		let activeEl: HTMLElement | null = null;
		for (const el of listbox.querySelectorAll<HTMLElement>('[role="option"]')) {
			const on = el.id === activeId && activeId !== "";
			if (el.getAttribute("aria-selected") !== String(on)) el.setAttribute("aria-selected", String(on));
			if (on) activeEl = el;
		}
		if (activeEl && activeId !== lastActive && activeId !== pointed) activeEl.scrollIntoView({ block: "nearest" });
		if (activeEl || !activeId) lastActive = activeId;
	};

	/** The option the user opened: tells onSelect, unless it is a link that is never followed. */
	const picked = (): Option | null => {
		const i = controller.getState().active;
		const option = controller.activate();
		if (option && (!option.url || isSafeUrl(option.url))) options.onSelect?.(option, i + 1);
		return option;
	};

	const go = (option: Option | null, newTab: boolean) => {
		if (!option) return;
		if (option.url) {
			// Only a relative or http(s) URL is followed.
			if (!isSafeUrl(option.url)) return;
			if (!newTab) controller.close();
			navigate(option.url, newTab);
		} else if (option.command) {
			// composed: the event leaves a shadow root (the default dialog's), so the page can listen on the document.
			input.dispatchEvent(new CustomEvent("search:command", { bubbles: true, composed: true, detail: { command: option.command, option } }));
		}
	};

	const onInput = (e: Event) => {
		// During composition the controller waits for compositionend.
		if ((e as InputEvent).isComposing) return;
		controller.input(input.value);
	};
	const onCompositionStart = () => controller.compositionStart();
	const onCompositionEnd = () => controller.compositionEnd(input.value);

	const onKey = (e: KeyboardEvent) => {
		if (composing(e) || e.altKey) return;
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				pointed = "";
				controller.move(1);
				break;
			case "ArrowUp":
				e.preventDefault();
				pointed = "";
				controller.move(-1);
				break;
			case "Home":
			case "End":
				// Without Ctrl, Home and End move the caret (APG editable combobox).
				if (!e.ctrlKey) return;
				e.preventDefault();
				pointed = "";
				controller.moveTo(e.key === "Home" ? "first" : "last");
				break;
			case "Enter": {
				e.preventDefault();
				go(picked(), e.metaKey || e.ctrlKey);
				break;
			}
		}
	};

	const point = (i: number) => {
		const option = controller.getState().options[i];
		if (!option) return;
		pointed = idFor(option.id);
		controller.moveTo(i);
	};
	const indexOf = (target: EventTarget | null): number => {
		const el = (target as Element | null)?.closest?.('[role="option"]');
		if (!el || !listbox.contains(el)) return -1;
		return controller.getState().options.findIndex((o) => idFor(o.id) === el.id);
	};
	const onMove = (e: PointerEvent) => {
		const i = indexOf(e.target);
		if (i < 0 || i === controller.getState().active) return;
		point(i);
	};
	// Keep focus in the box when an option is pressed.
	const onDown = (e: MouseEvent) => {
		if (indexOf(e.target) >= 0) e.preventDefault();
	};
	const onClick = (e: MouseEvent) => {
		const i = indexOf(e.target);
		if (i < 0) return;
		point(i);
		const option = picked();
		const plain = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
		const link = (e.target as Element).closest("a[href]");
		// A link opened with a modifier: the browser does what the user asked.
		if (link && !plain) return;
		e.preventDefault();
		go(option, !plain);
	};
	// A middle click fires auxclick, not click: the browser opens the link as it would, and the select is still sent.
	const onAux = (e: MouseEvent) => {
		if (e.button !== 1) return;
		const i = indexOf(e.target);
		if (i < 0 || !(e.target as Element).closest("a[href]")) return;
		point(i);
		picked();
	};

	sync();
	const unsubscribe = controller.subscribe(sync);
	const observer = new win.MutationObserver(() => sync());
	observer.observe(listbox, { childList: true, subtree: true });
	input.addEventListener("input", onInput);
	input.addEventListener("compositionstart", onCompositionStart);
	input.addEventListener("compositionend", onCompositionEnd);
	input.addEventListener("keydown", onKey);
	listbox.addEventListener("pointermove", onMove);
	listbox.addEventListener("mousedown", onDown);
	listbox.addEventListener("click", onClick);
	listbox.addEventListener("auxclick", onAux);
	return () => {
		unsubscribe();
		observer.disconnect();
		input.removeEventListener("input", onInput);
		input.removeEventListener("compositionstart", onCompositionStart);
		input.removeEventListener("compositionend", onCompositionEnd);
		input.removeEventListener("keydown", onKey);
		listbox.removeEventListener("pointermove", onMove);
		listbox.removeEventListener("mousedown", onDown);
		listbox.removeEventListener("click", onClick);
		listbox.removeEventListener("auxclick", onAux);
	};
}
