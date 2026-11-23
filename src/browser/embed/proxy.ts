/**
 * The proxy: a stand-in search box that the embed boot shows and focuses inside the tap or click that opens search,
 * while the app loads. iOS opens the keyboard only for a focus() made during a user gesture, and keeps it open when
 * focus then moves from one input to another, so the real dialog's input can take over when the app is ready.
 *
 * It is a fixed-position element in its own shadow root, not a modal <dialog>: closing a modal dialog runs the
 * dialog focus-restore steps, which could pull focus off the real input mid-handoff. It looks like the dialog's header
 * (the same --search-* tokens and frame), so the handover does not flash.
 */
const CSS = /* css */ `
:host {
	--_font: var(--search-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
	--_width: var(--search-width, 40rem);
	--_bg: var(--search-bg, #ffffff);
	--_fg: var(--search-fg, #16181d);
	--_muted: var(--search-muted, #5c6370);
	--_border: var(--search-border, #dfe2e7);
	--_radius: var(--search-radius, 0.75rem);
	--_shadow: var(--search-shadow, 0 1.5rem 4rem -1rem rgb(15 20 30 / 0.35), 0 0 0 1px rgb(15 20 30 / 0.06));
	--_backdrop: var(--search-backdrop, rgb(15 20 30 / 0.45));
	position: fixed;
	inset: 0;
	z-index: 2147483647;
	background: var(--_backdrop);
	color-scheme: light;
}
@media (prefers-color-scheme: dark) {
	:host {
		--_bg: var(--search-bg, #17191e);
		--_fg: var(--search-fg, #eceef2);
		--_muted: var(--search-muted, #a3a9b5);
		--_border: var(--search-border, #31353d);
		--_shadow: var(--search-shadow, 0 1.5rem 4rem -1rem rgb(0 0 0 / 0.7), 0 0 0 1px rgb(255 255 255 / 0.08));
		--_backdrop: var(--search-backdrop, rgb(0 0 0 / 0.6));
		color-scheme: dark;
	}
}
* { box-sizing: border-box; }
[part="panel"] {
	font: 0.9375rem/1.45 var(--_font);
	color: var(--_fg);
	background: var(--_bg);
	border-radius: var(--_radius);
	box-shadow: var(--_shadow);
	margin: 10vh auto auto;
	width: min(var(--_width), calc(100vw - 2rem));
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
	[part="panel"] { margin: 0; width: 100%; border-radius: 0; box-shadow: none; }
	:host { background: var(--_bg); }
}
`;

let sheet: CSSStyleSheet | null = null;

export interface ProxyField {
	input: HTMLInputElement;
	/** The proxy's element: the caller moves it (see session.ts) and removes it. */
	host: HTMLElement;
}

/**
 * Shows the proxy over the page (not yet focused: the caller focuses `input` in its event), with `text` as its
 * placeholder and label. The caller owns it and removes it. `parent` is where it mounts (default: body); the opener's
 * open modal dialog, when there is one, as the rest of the page is inert then and focus() there would fail.
 */
export function showProxy(doc: Document, text: string, parent?: Element | null): ProxyField {
	const host = doc.createElement("div");
	host.setAttribute("data-search-proxy", "");
	const root = host.attachShadow({ mode: "open" });
	if (!sheet) {
		sheet = new CSSStyleSheet();
		sheet.replaceSync(CSS);
	}
	root.adoptedStyleSheets = [sheet];
	const panel = doc.createElement("div");
	panel.setAttribute("part", "panel");
	const input = doc.createElement("input");
	for (const [k, v] of Object.entries({
		type: "text",
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
	(parent ?? doc.body).append(host);
	return { input, host };
}
