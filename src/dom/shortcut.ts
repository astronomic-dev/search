/**
 * The keyboard shortcut. The pure rules (which key matches, which targets are text fields, what a press does) run
 * under node --test; bindShortcut wires them to one keydown listener on the window.
 *
 * A key spec is "mod+k" (Cmd+K on Apple platforms, Ctrl+K elsewhere), "/" (a bare slash), or any key with the
 * modifiers ctrl, meta, alt, shift and mod joined by "+". Every modifier a spec does not name must be up.
 */
import type { Controller } from "../controller/index.ts";

export interface KeyEventLike {
	key: string;
	code: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	isComposing?: boolean;
	keyCode?: number;
	target: unknown;
	/** A window listener sees a shadow host as the target; the path's first entry is the element itself. */
	composedPath?: () => unknown[];
}

interface Spec {
	key: string;
	meta: boolean;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
}

function parse(spec: string, apple: boolean): Spec {
	const parts = spec.toLowerCase().split("+");
	// "mod++" or "+" names the plus key itself.
	let key = parts.pop() ?? "";
	if (key === "" && spec.endsWith("+")) {
		key = "+";
		parts.pop();
	}
	const has = (m: string) => parts.includes(m);
	return {
		key,
		meta: has("meta") || (has("mod") && apple),
		ctrl: has("ctrl") || (has("mod") && !apple),
		alt: has("alt"),
		shift: has("shift"),
	};
}

/** The physical key code for a spec key, for layouts whose keys print other letters. */
function codeOf(key: string): string | null {
	if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
	if (/^[0-9]$/.test(key)) return `Digit${key}`;
	if (key === "/") return "Slash";
	return null;
}

/**
 * Whether the press matches the spec. Matches by key, then by code (KeyK) when the key is not a Latin character, so a
 * Cyrillic layout still works and a Latin layout that moves letters (Dvorak) keeps its own letters.
 */
export function matchKey(e: KeyEventLike, spec: string, apple: boolean): boolean {
	const s = parse(spec, apple);
	if (e.metaKey !== s.meta || e.ctrlKey !== s.ctrl || e.altKey !== s.alt || e.shiftKey !== s.shift) return false;
	const key = e.key.toLowerCase();
	if (key === s.key) return true;
	const latin = e.key.length === 1 && e.key.charCodeAt(0) < 128;
	const code = codeOf(s.key);
	return !latin && code !== null && e.code === code;
}

const NOT_TEXT = new Set(["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image", "hidden"]);

/** A text input, a textarea, a select, or anything inside contenteditable. Buttons, checkboxes and ranges are not. */
export function isEditable(target: unknown): boolean {
	if (!target || typeof target !== "object") return false;
	const el = target as { tagName?: string; type?: string; isContentEditable?: boolean };
	if (el.isContentEditable) return true;
	const tag = (el.tagName ?? "").toUpperCase();
	if (tag === "TEXTAREA" || tag === "SELECT") return true;
	if (tag === "INPUT") return !NOT_TEXT.has((el.type ?? "text").toLowerCase());
	return false;
}

/** Where the press really happened: inside a shadow root, the element there, not its host. */
function originOf(e: KeyEventLike): unknown {
	return e.composedPath?.()[0] ?? e.target;
}

/** The focused element, through open shadow roots, so focus returns to a field inside a custom element. */
export function activeElementOf(doc: Document): Element | null {
	let a = doc.activeElement;
	while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
	return a;
}

/** Whether the press happened inside an open <dialog>, such as a second search dialog. */
function inOpenDialog(e: KeyEventLike): boolean {
	const path = e.composedPath?.() ?? [];
	return path.some((n) => !!n && typeof n === "object" && (n as { tagName?: string }).tagName?.toUpperCase() === "DIALOG" && !!(n as { open?: boolean }).open);
}

function composing(e: KeyEventLike): boolean {
	return !!e.isComposing || e.keyCode === 229;
}

/**
 * What a key press does: "open", "toggle" or null. mod+k toggles from anywhere, editable fields too; every other key
 * opens only outside editable fields and other open dialogs, never during IME composition, never with a modifier it
 * does not name.
 */
export function shortcutAction(e: KeyEventLike, keys: string[], apple: boolean, open: boolean): "open" | "toggle" | null {
	if (composing(e)) return null;
	for (const spec of keys) {
		if (!matchKey(e, spec, apple)) continue;
		if (spec.toLowerCase() === "mod+k") return "toggle";
		if (isEditable(originOf(e)) || inOpenDialog(e)) return null;
		// Already open: the press belongs to whatever has focus inside the dialog.
		return open ? null : "open";
	}
	return null;
}

/** Whether the platform is Apple's (Cmd is the main modifier). Pass `navigator`. */
export function isApple(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined): boolean {
	const p = nav?.userAgentData?.platform || nav?.platform || "";
	return /mac|iphone|ipad|ipod/i.test(p);
}

/** The aria-keyshortcuts value for the specs, for example "Meta+K /" on Apple. */
export function ariaKeyshortcuts(keys: string[], apple: boolean): string {
	return keys
		.map((spec) => {
			const s = parse(spec, apple);
			const mods = [s.ctrl && "Control", s.alt && "Alt", s.shift && "Shift", s.meta && "Meta"].filter(Boolean);
			const key = s.key.length === 1 ? s.key.toUpperCase() : s.key[0]!.toUpperCase() + s.key.slice(1);
			return [...mods, key].join("+");
		})
		.join(" ");
}

export interface ShortcutOptions {
	/** The main trigger: where focus returns when the shortcut opened the dialog from the page body. */
	main?: HTMLElement | null;
	/** Default: read from navigator. */
	apple?: boolean;
	/** Called just before the shortcut opens the dialog, with the element focus should return to on close. */
	onOpen?: (returnTo: HTMLElement | null) => void;
}

/** One keydown listener on `win` that opens or toggles the search. `keys: []` binds nothing. */
export function bindShortcut(win: Window, keys: string[], controller: Controller, options: ShortcutOptions = {}): () => void {
	if (!keys.length) return () => {};
	const apple = options.apple ?? isApple(win.navigator as Navigator & { userAgentData?: { platform?: string } });
	const onKey = (e: KeyboardEvent) => {
		if (e.defaultPrevented) return;
		const open = controller.getState().open;
		const action = shortcutAction(e, keys, apple, open);
		if (!action) return;
		e.preventDefault();
		if (!open) {
			const active = activeElementOf(win.document) as HTMLElement | null;
			const onPage = active && active !== win.document.body && active !== win.document.documentElement;
			options.onOpen?.(onPage ? active : (options.main ?? null));
		}
		if (action === "toggle") controller.toggle();
		else controller.open();
	};
	win.addEventListener("keydown", onKey);
	return () => win.removeEventListener("keydown", onKey);
}
