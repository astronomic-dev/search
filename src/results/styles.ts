/**
 * The results page's styles: one constructable stylesheet adopted by its shadow root, as the dialog's (no <style> tag,
 * so a strict `style-src 'self'` works). The same --search-* tokens theme it, set on the mount or any ancestor, and any
 * piece restyles through its `part`. Unlike the dialog, the page sits on the theme's own background: font and color
 * inherit by default, and every line, fill and mark is the text color or the accent mixed toward transparent, so it
 * reads on a light or a dark theme. The page cannot know the theme's background, so a selected pill is not the
 * dialog's inverted fill: it is the text color as its edge over a soft fill of it, the same on any background.
 * There is no fixed color at all: the accent is the text color unless a site sets --search-accent, so the button is
 * an outline in the text color (a fill only with --search-accent, its text --search-accent-fg or white or black to
 * contrast), and it matches any theme.
 */
export const css = /* css */ `
:host {
	--_font: var(--search-font, inherit);
	--_fg: var(--search-fg, currentColor);
	--_muted: var(--search-muted, color-mix(in srgb, var(--_fg) 68%, transparent));
	--_border: var(--search-border, color-mix(in srgb, var(--_fg) 20%, transparent));
	--_line: var(--search-line, color-mix(in srgb, var(--_fg) 13%, transparent));
	--_rule: var(--search-rule, color-mix(in srgb, var(--_fg) 9%, transparent));
	--_band: var(--search-band, color-mix(in srgb, var(--_fg) 4%, transparent));
	--_soft: color-mix(in srgb, var(--_fg) 5%, transparent);
	--_selected: var(--search-selected, color-mix(in srgb, var(--_fg) 12%, transparent));
	--_accent: var(--search-accent, var(--_fg));
	--_mark-bg: var(--search-mark-bg, color-mix(in oklab, var(--_accent) 18%, transparent));
	--_mark-fg: var(--search-mark-fg, inherit);
	--_radius: var(--search-radius, 0.5rem);
	/* The text color, so the ring reads on whatever background the host page has. */
	--_focus: var(--search-focus, currentColor);
	--_target: 2rem;
	display: block;
	/* Room under a heading right above it; it collapses into the heading's own margin, and any page style wins. */
	margin-block-start: 1.5em;
	font: inherit;
	font-family: var(--_font);
	color: var(--_fg);
}
@media (pointer: coarse) {
	:host { --_target: 2.75rem; }
}

[hidden] { display: none !important; }
* { box-sizing: border-box; }
p, ol, ul, h2, h3, h4, h5, h6 { margin: 0; }
ol, ul { list-style: none; padding: 0; }
h2, h3, h4, h5, h6 { font: inherit; }
button, input, a { font: inherit; color: inherit; }
button {
	cursor: pointer;
	background: none;
	border: 0;
	padding: 0;
	margin: 0;
	text-transform: none;
	letter-spacing: normal;
}
button:focus-visible, a:focus-visible, [part~="area"]:focus-visible {
	outline: 2px solid var(--_focus);
	outline-offset: 2px;
	border-radius: 0.375rem;
}

[part~="page"] {
	container: search-page / inline-size;
	display: grid;
	gap: 2rem;
	min-width: 0;
	line-height: 1.5;
}
[part~="area"] { min-width: 0; }
[part~="head"], [part~="panel"] { display: grid; gap: 1rem; min-width: 0; }

/* The form: the box and the page's one primary button. */
[part~="form"] {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem;
	min-width: 0;
	margin: 0;
}
[part~="field"] {
	position: relative;
	/* Below about 12rem beside the button, the button wraps under the box. */
	flex: 1 1 12rem;
	min-width: 0;
	display: flex;
	align-items: center;
}
[part~="icon"] {
	position: absolute;
	inset-inline-start: 0.75rem;
	color: var(--_muted);
	pointer-events: none;
}
[part~="input"] {
	flex: 1;
	min-width: 0;
	width: 100%;
	height: 2.75rem;
	margin: 0;
	padding: 0 0.875rem 0 2.5rem;
	padding-inline: 2.5rem 0.875rem;
	font-size: 1rem;
	color: inherit;
	background: var(--_soft);
	border: 1px solid var(--_border);
	border-radius: var(--_radius);
	box-shadow: none;
	outline: none;
	appearance: none;
	-webkit-appearance: none;
}
[part~="input"]::placeholder { color: var(--_muted); opacity: 1; }
[part~="input"]:focus-visible {
	border-color: var(--_focus);
	/* An outline, not only a shadow: forced colors drop box-shadow. */
	outline: 2px solid var(--_focus);
	outline-offset: 1px;
}
[part~="submit"] {
	flex: none;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	height: 2.75rem;
	padding: 0 1.125rem;
	font-weight: 500;
	/*
	 * An outline in the text color; a fill only when the site sets --search-accent. Its text: --search-accent-fg, else
	 * white or black from the accent's lightness. With no accent the color is invalid, so it inherits the text color.
	 */
	color: var(--search-accent-fg, oklch(from var(--search-accent) clamp(0, (0.65 - l) * 999, 1) 0 0));
	background: var(--search-accent, transparent);
	border: 1px solid var(--search-accent, var(--_border));
	border-radius: var(--_radius);
}
[part~="submit"]:hover { background: color-mix(in srgb, var(--search-accent, transparent) 88%, var(--_fg)); }

/* Filter rows: a quiet label in a fixed start column, then the pills. */
[part~="filter-row"] {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	min-width: 0;
}
[part~="facets"] { display: grid; gap: 0.5rem; }
[part~="filter-label"], [part~="label"], [part~="group-label"] {
	font-size: 0.75rem;
	line-height: 1;
	letter-spacing: 0.05em;
	text-transform: uppercase;
	color: var(--_muted);
}
[part~="filter-label"] { flex: none; min-width: 3rem; }
[part~="pills"] {
	display: flex;
	flex: 1;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.375rem;
	min-width: 0;
}
[part~="pill"] {
	display: inline-flex;
	flex: none;
	align-items: center;
	gap: 0.5rem;
	max-width: 100%;
	min-height: var(--_target);
	padding: 0 0.75rem;
	font-size: 0.875rem;
	line-height: 1.25;
	text-align: start;
	overflow-wrap: anywhere;
	border: 1px solid var(--_line);
	border-radius: 999px;
}
[part~="pill"]:hover { border-color: var(--_muted); }
[part~="pill"][aria-selected="true"], [part~="pill"][aria-pressed="true"] {
	background: var(--_selected);
	border-color: var(--_fg);
	box-shadow: inset 0 0 0 1px var(--_fg);
	font-weight: 500;
}
[part~="pill"] .name { min-width: 0; }
.count { font-variant-numeric: tabular-nums; color: var(--_muted); font-weight: 400; }
/* On a narrow page the pills keep one line and scroll sideways; the padding keeps the focus ring in view. */
@container search-page (max-width: 40rem) {
	[part~="pills"] {
		flex-wrap: nowrap;
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
		margin: -0.25rem;
		padding: 0.25rem;
	}
	[part~="pills"]::-webkit-scrollbar { display: none; }
	[part~="pill"] { white-space: nowrap; max-width: none; }
}

[part~="count"] {
	font-size: 0.875rem;
	color: var(--_muted);
	font-variant-numeric: tabular-nums;
}
[part~="list"] { display: grid; gap: 2rem; min-width: 0; }
[part~="group"] { display: grid; min-width: 0; }
[part~="group-label"] {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.75rem;
	padding: 0.625rem 0.75rem;
	background: var(--_band);
	border-radius: var(--_radius);
}
[part~="group-name"] { text-wrap: balance; }
[part~="group-count"] { font-variant-numeric: tabular-nums; }
[part~="results"] { display: grid; min-width: 0; }

/* One result: breadcrumb, title, two-line snippet, a light rule under it. */
[part~="result"] {
	display: grid;
	gap: 0.25rem;
	min-width: 0;
	padding: 1rem 0;
	border-bottom: 1px solid var(--_rule);
}
[part~="crumb"] {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 0 0.25rem;
	font-size: 0.75rem;
	line-height: 1rem;
	color: var(--_muted);
	overflow-wrap: anywhere;
}
[part~="title"] {
	font-size: 1.125rem;
	line-height: 1.35;
	font-weight: 500;
	text-wrap: balance;
	overflow-wrap: anywhere;
}
[part~="link"], [part~="heading-link"] {
	color: var(--_fg);
	text-decoration: none;
	border-radius: 0.25rem;
}
[part~="link"]:hover, [part~="heading-link"]:hover {
	text-decoration: underline;
	text-decoration-color: var(--_accent);
	text-decoration-thickness: 2px;
	text-underline-offset: 0.25em;
}
[part~="snippet"] {
	max-width: 65ch;
	color: var(--_muted);
	text-wrap: pretty;
	overflow-wrap: anywhere;
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
	line-clamp: 2;
	overflow: hidden;
}

/* Matched sections: a step below the page, indented, their # hung in the gutter so title and snippet line up. */
[part~="headings"] {
	display: grid;
	gap: 0.5rem;
	margin-top: 0.375rem;
	padding-inline-start: 2rem;
}
[part~="heading"] { display: grid; min-width: 0; }
[part~="heading-link"] {
	display: inline-flex;
	align-items: baseline;
	align-self: start;
	justify-self: start;
	min-height: 1.75rem;
	padding: 0.125rem 0;
	font-size: 0.875rem;
}
@media (pointer: coarse) {
	[part~="heading-link"] { min-height: 2.75rem; align-items: center; }
}
[part~="heading-mark"] {
	display: inline-block;
	flex: none;
	width: 1rem;
	margin-inline-start: -1rem;
	font-size: 0.75rem;
	color: var(--_muted);
	opacity: 0.6;
}
[part~="heading-title"] {
	color: var(--_muted);
	text-wrap: balance;
	overflow-wrap: anywhere;
}
[part~="heading-link"]:hover [part~="heading-title"], [part~="heading-link"]:focus-visible [part~="heading-title"] { color: var(--_fg); }
[part~="heading-snippet"] {
	max-width: 65ch;
	font-size: 0.8125rem;
	line-height: 1.4;
	color: var(--_muted);
	text-wrap: pretty;
	overflow-wrap: anywhere;
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
	line-clamp: 2;
	overflow: hidden;
}
[part~="mark"] {
	background: var(--_mark-bg);
	color: var(--_mark-fg);
	border-radius: 0.1875rem;
	padding: 0 0.125rem;
	margin: 0 -0.125rem;
	-webkit-box-decoration-break: clone;
	box-decoration-break: clone;
}

[part~="message"]:empty { display: none; }
[part~="empty"], [part~="error"] {
	display: grid;
	justify-items: start;
	gap: 1.25rem;
}
.stack { display: grid; justify-items: start; gap: 0.75rem; }
.lead { font-weight: 500; text-wrap: pretty; overflow-wrap: anywhere; }
[part~="loading"] { color: var(--_muted); }
.links { display: grid; gap: 0.625rem; }
.links ul { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; }
[part~="text-link"] {
	display: inline-flex;
	align-items: center;
	min-height: var(--_target);
	color: var(--_fg);
	text-decoration: underline;
	text-decoration-color: var(--_line);
	text-underline-offset: 0.25em;
}
[part~="text-link"]:hover { text-decoration-color: var(--_accent); }

.more-row:has([part~="more"][hidden]) { display: none; }
[part~="more"] {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-height: 2.75rem;
	padding: 0 1.125rem;
	font-weight: 500;
	border: 1px solid var(--_border);
	border-radius: var(--_radius);
}
[part~="more"]:hover { background: var(--_soft); }

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

@container search-page (max-width: 24rem) {
	[part~="submit"] { padding: 0 0.875rem; }
	[part~="headings"] { padding-inline-start: 1.25rem; }
}
@media (forced-colors: active) {
	[part~="pill"][aria-selected="true"], [part~="pill"][aria-pressed="true"] { border-width: 3px; }
	[part~="mark"] { outline: 1px solid Highlight; }
}
`;

let sheet: CSSStyleSheet | null = null;

/** The one shared stylesheet (built on first use, then reused by every results page on the page). */
export function styleSheet(): CSSStyleSheet {
	if (!sheet) {
		sheet = new CSSStyleSheet();
		sheet.replaceSync(css);
	}
	return sheet;
}
