/**
 * The default dialog's styles: one constructable stylesheet adopted by the shadow root (no <style> tag, so a strict
 * `style-src 'self'` works). A site themes it with the --search-* custom properties on the element or any ancestor,
 * and restyles any piece through its `part`.
 */
export const css = /* css */ `
:host {
	--_font: var(--search-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
	--_bg: var(--search-bg, #ffffff);
	--_fg: var(--search-fg, #16181d);
	--_muted: var(--search-muted, #5c6370);
	--_border: var(--search-border, #dfe2e7);
	--_accent: var(--search-accent, #2c5fd6);
	--_accent-fg: var(--search-accent-fg, #ffffff);
	--_mark-bg: var(--search-mark-bg, #fdeaa6);
	--_mark-fg: var(--search-mark-fg, inherit);
	--_radius: var(--search-radius, 0.75rem);
	--_shadow: var(--search-shadow, 0 1.5rem 4rem -1rem rgb(15 20 30 / 0.35), 0 0 0 1px rgb(15 20 30 / 0.06));
	--_width: var(--search-width, 40rem);
	--_backdrop: var(--search-backdrop, rgb(15 20 30 / 0.45));
	--_focus: var(--search-focus, #2c5fd6);
	--_active: color-mix(in srgb, var(--_accent) 10%, var(--_bg));
	--_soft: color-mix(in srgb, var(--_fg) 5%, var(--_bg));
	/* Quieter than the border: the rail by heading results. */
	--_line: var(--search-line, color-mix(in oklab, var(--_border) 60%, var(--_bg)));
	--_target: 2.25rem;
	color-scheme: light;
}
@media (prefers-color-scheme: dark) {
	:host(:not([theme="light"])) {
		--_bg: var(--search-bg, #17191e);
		--_fg: var(--search-fg, #eceef2);
		--_muted: var(--search-muted, #a3a9b5);
		--_border: var(--search-border, #31353d);
		--_accent: var(--search-accent, #8fb0ff);
		--_accent-fg: var(--search-accent-fg, #0d1117);
		--_mark-bg: var(--search-mark-bg, #5b4a12);
		--_mark-fg: var(--search-mark-fg, #fff6d6);
		--_shadow: var(--search-shadow, 0 1.5rem 4rem -1rem rgb(0 0 0 / 0.7), 0 0 0 1px rgb(255 255 255 / 0.08));
		--_backdrop: var(--search-backdrop, rgb(0 0 0 / 0.6));
		--_focus: var(--search-focus, #8fb0ff);
		color-scheme: dark;
	}
}
:host([theme="dark"]) {
	--_bg: var(--search-bg, #17191e);
	--_fg: var(--search-fg, #eceef2);
	--_muted: var(--search-muted, #a3a9b5);
	--_border: var(--search-border, #31353d);
	--_accent: var(--search-accent, #8fb0ff);
	--_accent-fg: var(--search-accent-fg, #0d1117);
	--_mark-bg: var(--search-mark-bg, #5b4a12);
	--_mark-fg: var(--search-mark-fg, #fff6d6);
	--_shadow: var(--search-shadow, 0 1.5rem 4rem -1rem rgb(0 0 0 / 0.7), 0 0 0 1px rgb(255 255 255 / 0.08));
	--_backdrop: var(--search-backdrop, rgb(0 0 0 / 0.6));
	--_focus: var(--search-focus, #8fb0ff);
	color-scheme: dark;
}
@media (pointer: coarse) {
	:host { --_target: 2.75rem; }
}

[hidden] { display: none !important; }
* { box-sizing: border-box; }

dialog {
	font: 400 0.9375rem/1.45 var(--_font);
	color: var(--_fg);
	background: var(--_bg);
	border: 0;
	border-radius: var(--_radius);
	box-shadow: var(--_shadow);
	padding: 0;
	margin: 10vh auto auto;
	width: min(var(--_width), calc(100vw - 2rem));
	max-width: none;
	max-height: min(40rem, 80vh);
	overflow: hidden;
}
dialog[open] { display: flex; }
dialog::backdrop { background: var(--_backdrop); }
@media (prefers-reduced-motion: no-preference) {
	dialog[open] { animation: search-in 140ms cubic-bezier(0.2, 0.8, 0.2, 1); }
}
@keyframes search-in {
	from { opacity: 0; transform: translateY(-0.5rem) scale(0.98); }
}

[part="panel"] {
	position: relative;
	display: flex;
	flex-direction: column;
	width: 100%;
	min-height: 0;
}

[part="header"] {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	padding: 0.75rem;
	/* Room for the close button, which follows the facets in the markup (for Tab order) but shows here. */
	padding-right: calc(0.75rem + 2.75rem + 0.5rem);
	border-bottom: 1px solid var(--_border);
}
.field {
	position: relative;
	flex: 1;
	min-width: 0;
	display: flex;
	align-items: center;
}
.field .icon {
	position: absolute;
	left: 0.75rem;
	color: var(--_muted);
	pointer-events: none;
}
[part="input"] {
	flex: 1;
	min-width: 0;
	height: 2.75rem;
	padding: 0 0.75rem 0 2.5rem;
	font: inherit;
	font-size: 1.0625rem;
	color: inherit;
	background: var(--_soft);
	border: 1px solid var(--_border);
	border-radius: calc(var(--_radius) - 0.25rem);
	outline: none;
}
[part="input"]::placeholder { color: var(--_muted); opacity: 1; }
[part="input"]:focus-visible {
	border-color: var(--_focus);
	box-shadow: 0 0 0 2px var(--_focus);
}

button, a { font: inherit; color: inherit; }
button {
	cursor: pointer;
	background: none;
	border: 0;
	padding: 0;
	margin: 0;
}
button:focus-visible, a:focus-visible {
	outline: 2px solid var(--_focus);
	outline-offset: 2px;
	border-radius: 0.375rem;
}

[part="close"] {
	position: absolute;
	top: 0.75rem;
	right: 0.75rem;
	flex: none;
	display: grid;
	place-items: center;
	width: 2.75rem;
	height: 2.75rem;
	border-radius: calc(var(--_radius) - 0.25rem);
	color: var(--_muted);
}
[part="close"]:hover { color: var(--_fg); background: var(--_soft); }

[part="tabs"], [part="facets"] {
	display: flex;
	flex-wrap: wrap;
	gap: 0.375rem;
	padding: 0.625rem 0.75rem 0;
}
[part="tab"], [part="facet"], [part="filters-toggle"], .action, .recent-item {
	display: inline-flex;
	align-items: center;
	gap: 0.375rem;
	min-height: var(--_target);
	padding: 0 0.75rem;
	border-radius: 999px;
	border: 1px solid var(--_border);
	font-size: 0.875rem;
	line-height: 1.2;
	text-wrap: balance;
	text-align: start;
}
[part="tab"]:hover, [part="facet"]:hover, .action:hover, .recent-item:hover { background: var(--_soft); }
[part="tab"][aria-selected="true"] {
	background: var(--_fg);
	border-color: var(--_fg);
	color: var(--_bg);
}
[part="facet"][aria-pressed="true"], [part="filters-toggle"][data-active] {
	background: var(--_accent);
	border-color: var(--_accent);
	color: var(--_accent-fg);
}
.count {
	font-variant-numeric: tabular-nums;
	font-size: 0.8125rem;
	opacity: 0.72;
}
/* On the accent fill the count takes the full foreground: dimmed, it falls under 4.5:1. */
[aria-pressed="true"] .count, [data-active] .count { opacity: 1; }
.filters { display: contents; }
[part="filters-toggle"] { display: none; }
.facet-group {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.375rem;
}
.facet-group .label { margin-inline-end: 0.125rem; }
.label {
	font-size: 0.75rem;
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--_muted);
	margin: 0;
}

.body {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 0.5rem 0.75rem 0.75rem;
}
.body:focus-visible { outline: 2px solid var(--_focus); outline-offset: -2px; }
[part="results"] { display: flex; flex-direction: column; gap: 0.25rem; }
[part="group"] + [part="group"] { margin-top: 0.5rem; }
[part="group-label"] {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 0.75rem;
	position: sticky;
	top: -0.5rem;
	z-index: 1;
	padding: 0.5rem 0.5rem 0.25rem;
	background: var(--_bg);
	font-size: 0.75rem;
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--_muted);
}
[part="group-count"] {
	font-weight: 400;
	letter-spacing: 0;
	font-variant-numeric: tabular-nums;
}
[part="option"] {
	display: flex;
	flex-direction: column;
	gap: 0.125rem;
	min-height: var(--_target);
	justify-content: center;
	padding: 0.5rem 0.75rem;
	border-radius: calc(var(--_radius) - 0.25rem);
	text-decoration: none;
	cursor: pointer;
	scroll-margin: 2rem 0 0.5rem;
}
[part="option"][data-kind="heading"] {
	margin-inline-start: 1.5rem;
	padding-inline-start: 0.875rem;
	border-inline-start: 1px solid var(--_line);
	border-start-start-radius: 0;
	border-end-start-radius: 0;
}
[part="option"][aria-selected="true"] { background: var(--_active); }
[part="option"][aria-selected="true"][data-kind="heading"] { border-inline-start-color: var(--_accent); }
.line { display: flex; align-items: baseline; gap: 0.5rem; justify-content: space-between; }
[part="option-title"], [part="option-heading"] {
	font-weight: 600;
	text-wrap: balance;
	overflow-wrap: anywhere;
}
[part="option-heading"] { font-weight: 500; }
[part="snippet"] {
	color: var(--_muted);
	font-size: 0.875rem;
	text-wrap: pretty;
	overflow-wrap: anywhere;
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
	line-clamp: 2;
	overflow: hidden;
}
[part="type-label"] {
	flex: none;
	font-size: 0.75rem;
	color: var(--_muted);
	border: 1px solid var(--_border);
	border-radius: 999px;
	padding: 0.0625rem 0.5rem;
}
[part="mark"] {
	background: var(--_mark-bg);
	color: var(--_mark-fg);
	border-radius: 0.1875rem;
	padding: 0 0.0625rem;
}

.message:empty { display: none; }
.message { padding: 0.5rem; }
.message p { margin: 0; }
.lead {
	font-weight: 500;
	text-wrap: pretty;
	overflow-wrap: anywhere;
}
.loading { color: var(--_muted); }
[part="empty"], [part="error"], [part="recent"] {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 0.75rem;
}
[part="empty"] [part="recent"] { margin-top: 0.5rem; }
.message ul {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-wrap: wrap;
	gap: 0.375rem;
}
.browse a {
	display: inline-flex;
	align-items: center;
	min-height: var(--_target);
	padding: 0 0.25rem;
	color: var(--_accent);
	text-underline-offset: 0.2em;
}

[part="footer"] {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 1rem;
	padding: 0.5rem 0.75rem;
	border-top: 1px solid var(--_border);
	font-size: 0.8125rem;
	color: var(--_muted);
}
.hints { display: flex; flex-wrap: wrap; gap: 0.25rem 0.875rem; margin: 0; }
[part="kbd"] {
	display: inline-grid;
	place-items: center;
	min-width: 1.375rem;
	height: 1.375rem;
	padding: 0 0.3125rem;
	margin-inline-end: 0.125rem;
	font: 500 0.75rem/1 var(--_font);
	color: var(--_fg);
	background: var(--_soft);
	border: 1px solid var(--_border);
	border-bottom-width: 2px;
	border-radius: 0.3125rem;
}
[part="see-all"] {
	flex: none;
	display: inline-flex;
	align-items: center;
	min-height: var(--_target);
	padding: 0 0.25rem;
	margin-inline-start: auto;
	font-weight: 500;
	color: var(--_accent);
	text-decoration: none;
}
[part="see-all"]:hover { text-decoration: underline; text-underline-offset: 0.2em; }
@media (pointer: coarse) {
	.hints { display: none; }
}

.visually-hidden {
	position: absolute;
	width: 1px;
	height: 1px;
	margin: -1px;
	padding: 0;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
	border: 0;
}

@media (max-width: 40rem) {
	dialog {
		margin: 0;
		width: 100%;
		max-width: 100%;
		height: 100dvh;
		max-height: 100dvh;
		border-radius: 0;
		padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
	}
	.hints { display: none; }
	/* The type tabs: one row that scrolls sideways, no wrap. The bottom padding keeps the focus ring in view. */
	[part="tabs"] {
		flex-wrap: nowrap;
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
		padding-bottom: 0.25rem;
		scroll-padding-inline: 1.5rem;
	}
	/* Fade the edge where more of a row hides (data-start, data-end: set on the tabs and facet groups as they scroll). */
	[data-start], [data-end] { mask-image: linear-gradient(var(--_d, to right), #0000, #000 var(--_s, 0px), #000 calc(100% - var(--_e, 0px)), #0000); }
	dialog:dir(rtl) { --_d: to left; }
	[data-start] { --_s: 1.5rem; }
	[data-end] { --_e: 1.5rem; }
	[part="tabs"]::-webkit-scrollbar, .facet-group::-webkit-scrollbar { display: none; }
	/* Pills a little shorter than the touch target, still 40px or more. */
	[part="tab"], [part="facet"], [part="filters-toggle"] { min-height: min(var(--_target), 2.5rem); }
	/* On touch the hit area stays 44px: 2px more above and below the 40px pill (3px from the padding box, past the 1px border;
	   the rows' padding keeps it unclipped). */
	@media (pointer: coarse) {
		[part="tab"], [part="facet"], [part="filters-toggle"] { position: relative; }
		[part="tab"]::after, [part="facet"]::after, [part="filters-toggle"]::after { content: ""; position: absolute; inset: -3px 0; }
	}
	/* One line each in a sideways row; chips in the open panel wrap a long value instead. */
	[part="tab"], :not([data-fold]) + * [part="facet"], .facet-group:not(:only-child) > [part="facet"] { flex: none; white-space: nowrap; }
	/* One row: the tabs, then a toggle for the facets, or one facet group alone. */
	.filters { display: flex; align-items: flex-start; }
	[part="tabs"] { flex: 1; min-width: 0; }
	[data-fold] [part="tabs"] { padding-inline-end: 0.25rem; }
	/* The toggle takes half the row at most: a long name ends in an ellipsis (the full name stays its text), the count shows. */
	[data-fold] [part="filters-toggle"] { display: inline-flex; flex: 0 1 auto; min-width: 0; max-width: 50%; margin: 0.625rem 0.75rem 0; }
	[part="filters-toggle"] > :first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	:not([hidden]) + [part="filters-toggle"] { margin-inline-start: 0.25rem; }
	[part="filters-toggle"] .icon { width: 1rem; }
	[aria-expanded="true"] .icon { rotate: 180deg; }
	[data-fold]:not([data-open]) + * { display: none; }
	:not([data-fold]) + [part="facets"] { padding: 0.375rem 0 0; }
	/* One row each that scrolls sideways: a lone facet group beside no tabs, or each of two or more groups in the panel
	   (edge to edge, like the tabs). One group in the panel wraps instead. */
	:not([data-fold]) + * .facet-group, .facet-group:not(:only-child) {
		flex: 1 1 100%;
		min-width: 0;
		flex-wrap: nowrap;
		overflow-x: auto;
		scrollbar-width: none;
		padding: 0.25rem 0.75rem;
		scroll-padding-inline: 1.5rem;
	}
	.facet-group:not(:only-child) { margin-inline: -0.75rem; }
	.label { flex: none; }
}
@media (forced-colors: active) {
	[part="option"][aria-selected="true"] { outline: 2px solid Highlight; outline-offset: -2px; }
	[part="tab"][aria-selected="true"], [part="facet"][aria-pressed="true"], [part="filters-toggle"][data-active] { border-width: 3px; }
	/* No edge fades on the tabs or the facet rows: their edges cut plainly. */
	[data-start], [data-end] { mask-image: none; }
}
`;

let sheet: CSSStyleSheet | null = null;

/** The one shared stylesheet (built on first use, then reused by every dialog on the page). */
export function styleSheet(): CSSStyleSheet {
	if (!sheet) {
		sheet = new CSSStyleSheet();
		sheet.replaceSync(css);
	}
	return sheet;
}
