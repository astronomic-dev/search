/**
 * The proxy: a stand-in search box that a boot script (the embed's, and the Astro build's: ../touch.ts) shows and focuses
 * inside the tap or click that opens search, while the app loads. iOS opens the keyboard only for a focus() made during a user gesture, and keeps it open when
 * focus then moves from one input to another, so the real dialog's input can take over when the app is ready.
 *
 * It is a fixed-position element in its own shadow root, not a modal <dialog>: closing a modal dialog runs the
 * dialog focus-restore steps, which could pull focus off the real input mid-handoff. It looks like the dialog's header
 * (the same --search-* tokens and frame), so the handover does not flash.
 */
const CSS = /* css */ `
:host {
	--_bg:var(--search-bg,#fff);
	--_fg:var(--search-fg,#16181d);
	--_muted:var(--search-muted,#5c6370);
	--_border:var(--search-border,#dfe2e7);
	--_radius:var(--search-radius,0.75rem);
	--_shadow:var(--search-shadow,0 1.5rem 4rem -1rem rgb(15 20 30/0.35),0 0 0 1px rgb(15 20 30/0.06));
	--_backdrop:var(--search-backdrop,rgb(15 20 30/0.45));
	position: fixed;
	inset: 0;
	z-index: 2147483647;
	background: var(--_backdrop);
	color-scheme: light;
}
@media (prefers-color-scheme: dark) {
	:host(:not([theme=light])) {
		--_bg:var(--search-bg,#17191e);
		--_fg:var(--search-fg,#eceef2);
		--_muted:var(--search-muted,#a3a9b5);
		--_border:var(--search-border,#31353d);
		--_shadow:var(--search-shadow,0 1.5rem 4rem -1rem rgb(0 0 0/0.7),0 0 0 1px rgb(255 255 255/0.08));
		--_backdrop:var(--search-backdrop,rgb(0 0 0/0.6));
		color-scheme: dark;
	}
}
:host([theme=dark]) {
	--_bg:var(--search-bg,#17191e);
	--_fg:var(--search-fg,#eceef2);
	--_muted:var(--search-muted,#a3a9b5);
	--_border:var(--search-border,#31353d);
	--_shadow:var(--search-shadow,0 1.5rem 4rem -1rem rgb(0 0 0/0.7),0 0 0 1px rgb(255 255 255/0.08));
	--_backdrop:var(--search-backdrop,rgb(0 0 0/0.6));
	color-scheme: dark;
}
* { box-sizing: border-box; }
div {
	font: 0.9375rem/1.45 var(--search-font,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif);
	color: var(--_fg);
	background: var(--_bg);
	border-radius: var(--_radius);
	box-shadow: var(--_shadow);
	margin: 10vh auto auto;
	width: min(var(--search-width,40rem), calc(100vw - 2rem));
	/* Room for the dialog's close button, so the box has the dialog box's width. */
	padding: 0.75rem calc(0.75rem + 2.75rem + 0.5rem) 0.75rem 0.75rem;
	border-bottom: 1px solid var(--_border);
}
input {
	display: block;
	width: 100%;
	height: 2.75rem;
	padding: 0 0.75rem 0 2.5rem;
	font: inherit;
	font-size: 1.0625rem;
	color: inherit;
	background: color-mix(in srgb, var(--_fg) 5%, var(--_bg));
	border: 1px solid var(--_border);
	border-radius: calc(var(--_radius) - 0.25rem);
	outline: none;
}
input::placeholder { color: var(--_muted); opacity: 1; }
@media (max-width: 40rem) {
	div { margin: 0; width: 100%; border-radius: 0; box-shadow: none; }
	:host { background: var(--_bg); }
}
`;

export interface ProxyField {
	input: HTMLInputElement;
	/** The proxy's element: the caller removes it. */
	host: HTMLElement;
}

/**
 * Shows the proxy over the page, with `text` as its placeholder and label. It does not take focus yet (see enterProxy),
 * so the caller has it in hand before any focus listener of the page runs. The caller owns it and removes it. It mounts
 * in the body, or inside the opener's open modal dialog (a nav drawer): the page around that one is inert, and focus()
 * there would fail. `theme` (the config's) wins over the device's color scheme, as on the dialog.
 */
export function showProxy(doc: Document, text: string, opener: HTMLElement, theme?: string | null): ProxyField {
	const host = doc.createElement("div");
	host.toggleAttribute("data-search-proxy");
	if (theme) host.setAttribute("theme", theme);
	const root = host.attachShadow({ mode: "open" });
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(CSS);
	root.adoptedStyleSheets = [sheet];
	const panel = doc.createElement("div");
	panel.setAttribute("part", "panel");
	const input = doc.createElement("input");
	for (const [k, v] of Object.entries({
		placeholder: text,
		"aria-label": text,
		spellcheck: "false",
		autocapitalize: "off",
		autocorrect: "off",
		autocomplete: "off",
		enterkeyhint: "go",
	}))
		input.setAttribute(k, v);
	panel.append(input);
	root.append(panel);
	// The walk goes up the composed tree (into a slot, out of a shadow root), so a drawer component's own shadow
	// <dialog> counts.
	let modal: Element | null | undefined = opener;
	while (modal && !modal.matches("dialog[open]")) modal = modal.assignedSlot ?? modal.parentElement ?? (modal.parentNode as ShadowRoot | null)?.host;
	(modal ?? doc.body).append(host);
	return { input, host };
}

/** The person is still in the proxy: it has focus, or the window itself lost it. False once it is out of the page or hidden (a closed drawer). */
export const inProxy = (input: HTMLInputElement) => input.isConnected && (!document.hasFocus() || (input.getRootNode() as ShadowRoot).activeElement === input);

/**
 * Moves focus into the proxy, which iOS opens the keyboard for in a user gesture. `leave` is called when the person
 * leaves it: with 1 for Escape, with 0 when focus goes elsewhere. The promise resolves when a touch open may hand over to
 * the dialog: on an iPhone a handoff a few ms after the proxy took focus left the keyboard up but typed nothing, most
 * often when the keyboard was already up from a focus return; 100 ms and more worked every time.
 */
export function enterProxy({ input, host }: ProxyField, opener: HTMLElement, leave: (why: number) => void): Promise<unknown> {
	input.focus();
	// No focus: a modal dialog the walk could not find (a closed shadow root's, whose slots are hidden) keeps the
	// page inert. The opener's own subtree is rendered in that dialog, so the proxy mounts next to it instead, in
	// the opener's named slot when the opener is the host's own child.
	if (host.shadowRoot!.activeElement !== input) {
		host.slot = opener.slot;
		opener.after(host);
		input.focus();
	}
	input.addEventListener("keydown", (e) => {
		if (e.key !== "Escape" || e.isComposing) return;
		// Only the proxy closes: inside a modal drawer the same Escape would cancel the drawer too.
		e.preventDefault();
		e.stopPropagation();
		leave(1);
	});
	// Focus left the proxy before the handoff (Tab, Shift+Tab, a click elsewhere): the open is dropped, so a late
	// load does not take focus back. Checked a task later; the callers check again (inProxy) when the app is in.
	input.addEventListener("focusout", () => setTimeout(() => inProxy(input) || leave(0)));
	return new Promise((r) => setTimeout(r, 150));
}
