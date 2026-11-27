# @astronomic-dev/search

[![The Astronomic Search page on astronomic.dev: the headline “Lightning-fast, typo-tolerant search for Astro” over a live search for “prodution”, a typo, with type filters and results that match “production”, beside a panel that sets the mode, accent, corners and font](https://raw.githubusercontent.com/astronomic-dev/search/main/.github/hero.webp)](https://astronomic.dev/plugins/search)

See it live: [search for Astro](https://astronomic.dev/plugins/search) and [search for EmDash](https://astronomic.dev/plugins/emdash-search).

Full docs, for Astro and EmDash: [astronomic.dev/docs/search](https://astronomic.dev/docs/search).

Fuzzy search in a dialog for any Astro site. It indexes your pages and their headings at build time, ships the index as a hashed file, and loads it only when a visitor reaches for search: on hover, focus, a click or the shortcut. Typos still find the page ("nortwind" finds "Northwind rebrand"), and a match inside a section links straight to its heading. Only real matches are marked: a word that a query word equals or starts ("lodes" marks "Lodestar"). A word found only by a typo match shows its result with no mark, so "code" never marks "come" and "button" never marks "bottom" (nor "lodestr" "Lodestar").

- **Records first.** Everything becomes the same small record (a page, a heading's section, or an action), whatever it came from: content collections, built HTML, or your own code.
- **Three layers.** A headless controller, accessible browser behavior, and a default dialog. Use the dialog as is, or build your own on the lower layers.
- **No JavaScript needed to get somewhere.** The search button is a real link to `/search` (or a page you pick), and a `<noscript>` part shows your browse links.
- **Strict CSP friendly.** Scripts ship as files and styles as a constructable stylesheet, so `script-src 'self'; style-src 'self'` works.

## Install

```sh
pnpm add @astronomic-dev/search
```

npm and yarn work too. Search adds no dependency with an install script (its browser scripts come bundled), so it brings no `pnpm approve-builds` step of its own. Needs Astro 7 for the integration and components; the core, controller and dom layers work anywhere.

Add the integration to `astro.config.mjs`, then put the search button where your header has room:

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import search, { collections, html } from "@astronomic-dev/search/astro";

export default defineConfig({
	site: "https://example.com",
	integrations: [
		search({
			sources: [collections({ docs: { label: "Docs" } }), html({ include: ["/", "/pricing"] })],
			browse: [{ label: "Docs", href: "/docs" }],
		}),
	],
});
```

```astro
---
import SearchLink from "@astronomic-dev/search/astro/SearchLink.astro";
import SearchNoscript from "@astronomic-dev/search/astro/SearchNoscript.astro";
---

<header>
	<SearchLink class="search-button">Search</SearchLink>
	<SearchNoscript />
</header>
```

The build writes the index, the manifest and two scripts to `/_search/`, and the button opens the dialog. Last, add the search page.

### The search page

The button is a link to `/search` (with your `base`, and a trailing slash when `trailingSlash` is `"always"`, or `"ignore"` with the default `build.format`). Visitors land there with JavaScript off, and from "See all results" in the dialog, which adds the query as `?q=`. Add the page with the `SearchPage` component, inside your own layout. It reads `?q=`, lists the matching pages, and shows your browse links with JavaScript off. It takes `heading` (default "Search", `""` for none), `label` (the search box's label, default "Search this site"), `button` (default "Search") and `class`. It reads `<html lang>` to pick the index's language:

```astro
---
// src/pages/search.astro: where "See all results" and the no-JavaScript link go. Use your own layout in place of
// this html shell, and keep the noindex tag.
import SearchPage from "@astronomic-dev/search/astro/SearchPage.astro";
---

<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="robots" content="noindex" />
		<title>Search</title>
	</head>
	<body>
		<main>
			<SearchPage />
		</main>
	</body>
</html>
```

It searches the default index and ignores the `type` and filter parameters a trigger may add. It shows one list by score (so `group.page` has no effect here), lists the first 50 matches while its status line counts them all, and fires no analytics events (on plain Astro only the dialog does). For another index or other markup, write the page yourself: start from `dist/astro/SearchPage.astro` in the package, change its relative imports to the package's own (`@astronomic-dev/search/astro/SearchNoscript.astro`, `@astronomic-dev/search/controller` and `@astronomic-dev/search/core`; keep `virtual:astronomic-search/assets`), and put another index name in place of `assets.index`. If your search page lives somewhere else, set `href` on `SearchLink` (see The dialog element).

## Settings

The settings come in two forms.

**One index.** Put the index settings at the top level. The index is named `default`.

```js
search({
	sources: [collections({ docs: { label: "Docs", facets: ["theme"] } }), html({ include: ["/", "/pricing"] })],
	weights: { title: 3, heading: 2, text: 1, keywords: 1 },
	group: { dialog: "type" },
	types: { docs: { weight: 1.5 } },
	shortcut: { keys: ["mod+k", "/"] },
	browse: [{ label: "Docs", href: "/docs" }],
});
```

**Named indexes.** Each index gets its own files, so a big part of the site (a component catalog, for example) does not slow down the main search.

```js
search({
	indexes: {
		site: { sources: [collections({ docs: {} }), html()] },
		kit: { sources: [records(loadParts, { types: { kit: { label: "Kit parts" } } })], group: { dialog: false } },
	},
	default: "site",
});
```

| Setting | Where | What it does |
| --- | --- | --- |
| `sources` | index | Where the records come from (see Adapters). Required. |
| `weights` | index | Field boosts: `title`, `heading`, `text`, `keywords` (a page's keywords and its facet values). Default 3, 2, 1, 1. |
| `group` | index | `{ dialog, page }`: `"type"`, a facet name, or `false` (one list by score). Default: by type in the dialog, mixed on a page. The plain Astro `SearchPage` ignores `page`. |
| `groupOrder` | index | `"best"` (the group with the best match first) or a fixed list of group keys. |
| `types` | index | Per type: a `label` and a score `weight` (default 1). |
| `facets` | index | Per facet: a `label` and labels for its `values`. No source or index may name a facet `type` (the content type) or `q` (the search page reads `?q=` as the query); the build fails on one. |
| `budget` | index | `{ gzipKB }`: a build warning when the index file grows past it. Default 300 KB. |
| `clip` | index | Characters of each section's text the index file keeps, at least 200: for a smaller file on a large site. Leave out to keep the text whole (the default). Words past the cut are still found, and a result still links to their section, but its preview shows the start of the section. The first 1,000 characters of a section rank higher than the rest, with or without `clip`. |
| `suggested` | index | Links the dialog shows in an empty box, under "Suggested" and before recent searches: `[{ label, href, type? }]`, at most 8. One list for every locale, or one per locale (`{ en: [...], fr: [...] }`; a locale the map leaves out shows none). Each `href` must be a canonical URL on this site, as a record's, and `type` one of the index's types; the build fails otherwise. |
| `synonyms` | index | Groups of words that match each other, one word each: `[["docs", "documentation"], ["price", "cost"]]`. A query word in a group is searched as any word of its group, and a page that matches the other word counts as matching it. Case and accents do not matter. |
| `pinned` | index | A whole query to pages shown first, in that order: `{ "get started": ["/docs/install", "/docs/first-steps"] }`. The query is matched whole, ignoring case, accents and extra spaces, not word by word. A pinned page shows even if the words do not match it, but only when it passes the type tab, the dialog's `types` and the filters, and it counts once in the counts like any page. Each URL must be a canonical page URL in the index; the build fails otherwise (the dev server warns, since it does not scan built HTML). |
| `indexes` | site | Named indexes: `{ name: { sources, ... } }`, each with the index settings above. A name is letters, digits, `-` and `_`, starts with a letter or digit, and is unique ignoring case (it becomes part of the index's file names). Built-in object keys (`__proto__`, `constructor`, `prototype`, `toString` and the other `Object.prototype` names) are reserved; the build fails on one. |
| `default` | site | The index a button uses when it names none. |
| `shortcut` | site | `{ keys: [...] }` or `false`. Default `["mod+k", "/"]`. |
| `strings` | site | Labels that replace the US English defaults (see Strings). |
| `browse` | site | Links for the error state and the no-JavaScript part: `[{ label, href }]`. Each `href` must be a canonical URL on this site (with `trailingSlash: "ignore"`, either slash); the build fails otherwise. |
| `theme` | site | `"light"` or `"dark"`: the dialog's colors, whatever the visitor's device is set to. Left out, it follows the device. See [Light, dark and toggles](#light-dark-and-toggles). |

## Adapters

- **`collections({ name: spec })`** reads Astro content collections. Each entry is a page record, and each heading (levels 2 and 3 by default) starts a section record with its rendered anchor. A spec takes `type` (the records' type, so two collections can share one: `hubs: { type: "learn" }` makes hubs Learn results; default the collection's name), `label` (the type's label; collections of one type may not set different labels, and one without a label takes the other's), `url` (the page's URL pattern: `{id}` is the entry's id, `{slug}` its `slug` field or else its id; default `/<collection>/{id}`, so `docs: {}` gives `/docs/getting-started`; set it to match your route, such as `blog: { url: "/posts/{slug}" }`; your `base` and `trailingSlash` are applied for you), `facets`, `fields` (extra data fields to index, for data-only collections), `title`, `depths`, `keywords` (see Keywords) and `filter`. Drafts and `noindex` entries are always left out. An entry whose `url` gives a URL on another site (a slug of `/other.example/x` with the pattern `/{slug}`) fails the build, naming the collection and entry.

  `filter: (entry) => boolean` keeps the entries it returns `true` for, as a page route's `getStaticPaths` does: `docs: { url: "/docs/{id}", filter: (e) => !unlisted.has(e.id.split("/")[0]) }`. It sees `{ id, collection, data }`. It runs in the integration after the records route, so `data` is the entry's data as JSON (a date is an ISO string), and it must not need `astro:content`.
- **`html({ include, exclude, type, label, selector })`** scans the built HTML. It reads `[data-search-body]`, else `main`, else the body, and splits the page at its headings. Dialogs (`<dialog>`, `[data-search-dialog]`, `<astronomic-search>`) are never page text, nor is anything `hidden`, `aria-hidden="true"` or `[data-search-ignore]`. Pages with `noindex` are left out. The text gets a space between block elements, at `<br>`, and between the items of a flex or grid container (a `flex` or `grid` class, with any variant prefix, or an inline `display` style), so cards and badges side by side do not run together; inline tags (`span`, `b`, `em` and the like) join with no space. A path segment `*` matches any one segment.
- **`records(hook, { types, facets })`** takes records your own code returns: a CMS this package does not know, a component catalog, or actions with no URL (an action has a `command` and the dialog fires a `search:command` event).

When two sources give the same URL, the collection record wins over the scanned page.

After the build, every collection and `html()` record URL must be a built page (`<path>.html` or `<path>/index.html`), and every section's anchor an `id` that page renders; the build fails with a list otherwise, so a `url` pattern that misses its route, or a page left out of `getStaticPaths` but not by `filter`, never makes a dead result. With `output: "server"` a page may be rendered on demand, so these are warnings. A `records()` hook's URLs are its own and are not checked. The dev server has no built pages and does not check.

### Result title

A scanned page's result title is its `<h1>`, else its `<title>`. A page can set another one in its head, so a home page whose headline is a slogan shows as "Home":

```html
<meta name="search:title" content="Home">
```

### Keywords

A page can carry extra words that people search for but the page does not use, so "start" finds a page titled "Lodestar". Keywords are indexed in the `keywords` field, with the page's facet values. Each source has its own way to set them:

```md
---
title: Lodestar
searchKeywords: [start, guide, north]   # or "start, guide, north"
---
```

```html
<meta name="search:keywords" content="start, guide, north">
```

```js
collections({ docs: { keywords: "tags" } });  // read another field
collections({ docs: { keywords: false } });   // no keywords
records(() => [{ id: "en:/ui/button", kind: "page", url: "/ui/button", type: "kit", title: "Button", text: "", keywords: ["cta"] }]);
```

Only page records take keywords, not headings. Each keyword is trimmed and empty ones are left out. A page keeps its first 20 keywords, and the build warns about any page with more. When a collection page replaces a scanned page, it keeps its own keywords and none of the scanned ones.

## The three layers

| Layer | Import | Use it when |
| --- | --- | --- |
| Default dialog | `@astronomic-dev/search/ui` (loaded for you by `SearchLink`) | You want search working today and will theme it with custom properties and parts. |
| Browser behavior | `@astronomic-dev/search/dom` | You render your own markup and want the dialog, combobox, tabs, shortcut and live region done right. `mountSearch({ trigger, dialog, input, listbox, live, controller, idFor, keys })` returns an `unbind()`. With `newTab: true`, every result opens in a new tab and the dialog stays open; put `target="_blank" rel="noopener"` on your own result links, and the browser follows a click on one itself, so a pop-up blocker never stops it. |
| Controller | `@astronomic-dev/search/controller` | You want only the state: query, loading, results, the active option, type tabs, facet picks and recent searches. No DOM, so it runs anywhere. In an empty dialog box, `state.options` holds the index's suggested links (`kind: "suggested"`, with `url`, `label` and `type`), so a recipe renders them as options. |

The core (`@astronomic-dev/search/core`) holds the record types, the engine and `createSearch`, for code that searches an index without any UI. The dom layer also exports `marked(document, text, ranges, attrs?)`, the one way to render result text: text nodes with a `<mark>` (with `attrs`, default `part="mark"`) around each matched range, never markup.

### Build your own dialog

A dialog of your own still gets the lazy load: call `startBoot({ selector, keys, load })` from `@astronomic-dev/search/boot` in your button's script. It listens for hover, focus, a click and the shortcut, calls `load()` on first use (your app, through `import()`), calls the app's `prepare(trigger, keys)`, then replays the held click or key; if the load fails, a held click follows the link. To fetch the index while your app loads, pass `preload(trigger)` as well: call `prefetch({ index, lang, manifestUrl, fetch })` from `@astronomic-dev/search/controller` there, and hand what it returns to your app's `loadSearcher` as `prefetch`. `loadSearcher` uses it once, and only for the same index and manifest URL. Give your buttons `data-search-ui="yours"` and pass `selector: '[data-search-trigger][data-search-ui="yours"]'`: the default dialog's boot and app skip any trigger with a `data-search-ui`, so the two never take each other's buttons. Use one kind of dialog per page. The integration's settings reach your code through `virtual:astronomic-search/assets`, which exports `{ boot, app, manifest, index, shortcut, browse, strings }` (`strings` holds the `strings` setting's overrides only); for its types, add `/// <reference types="@astronomic-dev/search/astro/virtual" />` to the file that imports it.

On a phone, a dialog that opens after the tap gets no keyboard: iOS opens it only for a focus made inside the tap. For that, pass `touch: touchOpens(view)`, also from `@astronomic-dev/search/boot`. On a tap, `view.show(trigger)` makes and mounts a stand-in box that looks like your dialog's search field, and returns `{ host, input }` (not focused yet, with the text your dialog opens on), or `null` for an ordinary open. The helper focuses it inside the tap, and once your app is in and the box has held focus 150 ms, it calls your app's `openTouch(trigger, draft)`. That opens the dialog, focuses its input, puts in `draft.value` (`draft.changed` says if it differs from the start text) and the caret (`draft.start`, `draft.end`, `draft.direction`), and returns `true` when the input took the focus (on `false` the helper does nothing more, since your dialog may be open already). An app with no `openTouch` gets a click on the trigger instead, and the text typed in the box is lost. The helper also handles Escape and focus leaving the box (the open is dropped), a client router's page swap, an unfinished input method composition (it waits for it to end), and a failed load: the link is followed, and if `show` also returned `searchPage` (your search page's URL) and the link goes there (the same origin and path), the typed text goes along as `q`; a trigger with its own `data-search-href` keeps its link as it is. It adds about 0.7 KB gzip to your boot script, and none of the default dialog's stand-in. A boot without `touch` does not grow.

```ts
import { startBoot, touchOpens } from "@astronomic-dev/search/boot";

startBoot({
	selector: '[data-search-trigger][data-search-ui="yours"]',
	keys: ["mod+k"],
	touch: touchOpens({
		show(trigger) {
			const host = document.createElement("div");
			host.className = "my-search-stand-in";
			const input = host.appendChild(document.createElement("input"));
			input.setAttribute("aria-label", "Search");
			document.body.append(host);
			return { host, input, searchPage: "/search" };
		},
	}),
	load: () => import("./my-search-app.ts"), // exports prepare(trigger, keys) and openTouch(trigger, draft)
});
```

For a worked example, see the Search family in [`@astronomic-dev/ui`](https://astronomic.dev/ui): the shell [`Search.astro`](https://github.com/astronomic-dev/astronomic-ui/blob/main/src/components/Search.astro) (its markup, templates and boot script), the glue [`lib/search-app.ts`](https://github.com/astronomic-dev/astronomic-ui/blob/main/src/lib/search-app.ts) on `controller` and `dom`, and the [`SearchClassic`](https://github.com/astronomic-dev/astronomic-ui/blob/main/src/components/SearchClassic.astro) recipe, which sets only class hooks.

## The dialog element

`SearchLink` loads a small boot script. On first use it loads the app, which defines `<astronomic-search>` and adds one to the page per kind of button. At the same time it fetches the manifest, then the index file the manifest names, so the index is often in by the time the app is. You can also place it yourself.

| Attribute | What it does |
| --- | --- |
| `index` | The index to search. Default: the `default` setting. |
| `types` | A comma list of the types this dialog shows. Default: all of the index's types. |
| `group` | `type`, a facet name, or `false`: overrides the index's `group.dialog` for this dialog. |
| `theme` | `light` or `dark`. Default: the `theme` setting, else the visitor's system setting. On an element you place yourself, only this attribute counts. |

`SearchLink` takes the same choices as props (`index`, `types`, `group`), plus `main` (the button the shortcut belongs to; default the first on the page) and `class`. Its slot is the label.

`href` sets where the link goes with no JavaScript, and where "See all results" goes (with `?q=` and the query added). Default: `/search` under your `base`, with a trailing slash when your `trailingSlash` setting calls for one. Set it when your search page lives elsewhere, or when you have none and want the link to go to a docs index instead:

```astro
<SearchLink href="/docs">Search the docs</SearchLink>
```

The build checks the default. When a page has a `SearchLink` with no `href` and the build wrote no search page (`search/index.html` or `search.html`), it logs one warning: add a `/search` page, or set `href`. It is a warning, not an error, because the dialog still works. A `/search` page rendered on demand writes no file, so it warns too; set `href="/search"` to quiet it.

With `build.format: "file"`, Astro writes `search.html`, and result links have no `.html`. Most hosts (Cloudflare Pages, Netlify, Vercel) serve `/search` from `search.html` for you. On a host that does not, turn on its clean-URL or rewrite setting.

An action record (a `command`, no URL) fires a `search:command` event when it is picked. The event bubbles out of the dialog's shadow root, so listen on the element or on the document: `document.addEventListener("search:command", (e) => run(e.detail.command))`.

### Open on a search

A trigger can open the dialog with a search already typed. Give it any of these attributes; they replace what the box held, and a trigger with none of them opens on the last search. Point its `href` at the same search on your `/search` page, so the link still works with no JavaScript.

| Attribute | What it does |
| --- | --- |
| `data-search-query` | The words in the box. |
| `data-search-type` | The type tab to select. Default: all types. |
| `data-search-filters` | Facet picks in the search page's URL form: `theme=lodestar`, a name repeated for several values (`theme=lodestar&theme=vega`). Ignored by an engine with no facets. |

```astro
<SearchLink href="/search?q=dark+mode&type=docs&theme=lodestar" data-search-query="dark mode" data-search-type="docs" data-search-filters="theme=lodestar">
	Dark mode in the Lodestar docs
</SearchLink>
```

Any trigger works, the kit's too: the dom layer's `bindTrigger` reads them (`triggerStart()` from `@astronomic-dev/search/dom`) and calls `controller.open(start)`, which takes `{ query, type, picks }`. The dialog a trigger opens is still the one its `index`, `types` and `group` name, so these links share the page's one dialog and its shortcut.

### Light, dark and toggles

The dialog follows the visitor's device. To keep it light or dark for everyone, set `theme`:

```js
search({
	sources: [collections({ docs: {} })],
	theme: "light", // or "dark"
});
```

It applies to every dialog `SearchLink` adds, on every page. A change to the `theme` attribute afterwards stays, through view transitions too. An `<astronomic-search>` you place yourself takes its own `theme` attribute, not this setting. The plain Astro `SearchPage` takes your page's colors, so `theme` does not change it.

**A site with its own light and dark toggle.** Search cannot know what your toggle changes, so leave `theme` out and set the dialog's `theme` attribute with a small script. This one reads `<html data-theme="dark">` or `<html class="dark">`. Change the `dark` line if yours differs:

```js
// src/scripts/search-theme.js
// Keeps the search dialog's theme the same as the site's toggle.
const root = document.documentElement;

function sync() {
	const dark = root.dataset.theme === "dark" || root.classList.contains("dark");
	for (const el of document.querySelectorAll("astronomic-search, [data-search-proxy]")) el.setAttribute("theme", dark ? "dark" : "light");
}

const observer = new MutationObserver(sync);
// The toggle.
observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] });
// The dialog, which joins the page on first use, and its stand-in on a phone.
observer.observe(document, { childList: true, subtree: true });
// A dialog already on the page.
sync();
```

Load it from your layout, so every page has it:

```astro
<script>
	import "../scripts/search-theme.js";
</script>
```

It also sets a dialog that is made later, and it keeps working with Astro's `<ClientRouter />`.

If your colors are already custom properties that your toggle changes, you can point the dialog's [custom properties](#custom-properties) at them instead, with no script. Use your own names for the ones on the right:

```css
astronomic-search,
[data-search-proxy] {
	--search-bg: var(--page);
	--search-fg: var(--ink);
	--search-muted: var(--ink-soft);
	--search-border: var(--line);
	--search-accent: var(--brand);
	--search-accent-fg: var(--on-brand);
	--search-focus: var(--brand);
	--search-mark-bg: color-mix(in srgb, var(--brand) 25%, transparent);
	--search-mark-fg: var(--ink);
	color-scheme: inherit;
}
```

`color-scheme: inherit` takes the page's own `color-scheme`, so the scrollbar matches. Any color you leave out still follows `theme`, or the device.

### Custom properties

Set these on `astronomic-search` or any ancestor. Each has a light default and a dark one. If you set them on `astronomic-search` itself, name `[data-search-proxy]` in the same rule: it is the box that stands in for the dialog on a phone (see [Keyboard](#keyboard)).

| Property | Default (light) | Use |
| --- | --- | --- |
| `--search-font` | system UI font | Every text in the dialog |
| `--search-bg` | `#ffffff` | Dialog background |
| `--search-fg` | `#16181d` | Text |
| `--search-muted` | `#5c6370` | Snippets, labels, hints |
| `--search-border` | `#dfe2e7` | Lines and outlines |
| `--search-line` | the border, 60% toward the background | The rail beside heading results |
| `--search-accent` | `#2c5fd6` | Links, picked filters, the active option's tint |
| `--search-accent-fg` | `#ffffff` | Text on the accent |
| `--search-mark-bg` | `#fdeaa6` | Matched words |
| `--search-mark-fg` | `inherit` | Matched words' text |
| `--search-radius` | `0.75rem` | Dialog corners (inner corners follow) |
| `--search-shadow` | soft drop shadow | Dialog shadow |
| `--search-width` | `40rem` | Dialog width on wide screens |
| `--search-backdrop` | dark, 45% | The backdrop behind the dialog |
| `--search-focus` | `#2c5fd6` | Focus rings |

On screens up to `40rem` wide the dialog fills the screen and respects the safe areas. With reduced motion it opens without animation.

### Parts

Style any piece with `astronomic-search::part(name)`. These names are stable.

| Part | Element |
| --- | --- |
| `dialog` | The `<dialog>` |
| `panel` | The box inside it |
| `header` | The row with the search box and the close button |
| `input` | The search box |
| `close` | The close button |
| `tabs` | The type tabs row |
| `tab` | One type tab |
| `facets` | The filter row |
| `facet` | One filter button |
| `filters-toggle` | On narrow screens, the button beside the type tabs that shows or hides the filter row, with the picked count |
| `results` | The results list |
| `group` | One group of results |
| `group-label` | A group's heading: its name, then the group's count (`group-count`) on the right |
| `group-count` | A group's count, in its `group-label`: grouped by type, the type's match count (as on its tab); else the pages listed |
| `option` | One result (a page or a heading; `data-kind` says which), or a suggested link (`data-kind="suggested"`) |
| `option-title` | A page result's title |
| `option-heading` | A heading result's heading |
| `snippet` | The text under a result |
| `mark` | A matched word |
| `type-label` | A result's type, when results are not grouped |
| `empty` | The no-results message |
| `error` | The "not available" message |
| `recent` | Recent searches |
| `suggested` | The suggested links in an empty box: also a `group`, with a `group-label` and `option` links |
| `footer` | The bottom row |
| `see-all` | The "See all results" link |
| `new-tab` | The notice that links open in a new tab, in a dialog whose links do |
| `kbd` | A key in the footer hints |
| `status` | The live region (visually hidden) |

## Strings

Every label has a US English default. Replace any of them with the `strings` setting.

| Key | Default |
| --- | --- |
| `dialogLabel` | Search |
| `placeholder` | Search |
| `close` | Close |
| `allTypes` | All |
| `seeAll` | See all results |
| `newTab` | Links open in a new tab (the dialog's notice, when its links do) |
| `loading` | Loading… |
| `unavailable` | Search is not available right now. |
| `retry` | Try again |
| `noResults` | No results for “{query}” |
| `searchAllTypes` | Search all types |
| `recent` | Recent searches |
| `suggested` | Suggested |
| `browse` | Browse |
| `facetsLabel` | Filters |
| `typesLabel` | Content types |
| `other` | Other |
| `results` | `{ zero: "No results", one: "1 result", other: "{count} results" }` |
| `keys` | `{ move: "to move", open: "to open", close: "to close" }` |

The results page (the embed's [results mount](#the-results-mount) and EmDash's `<SearchResults>`) takes the same `strings`, plus its own words:

| Key | Default |
| --- | --- |
| `label` | Search (the box's label, visually hidden) |
| `submit` | Search (the form's button) |
| `showMore` | Show more results |
| `moreShown` | Result {position} of {total}: {title} (read after "Show more results") |
| `headingMark` | # (before a section result's heading, hidden from screen readers) |
| `crumbMark` | › (between the parts of a breadcrumb, hidden from screen readers) |
| `typeText` | Type (the visible label before the type tabs) |

On EmDash, the admin page sets only `placeholder` (Search box text); every other string keeps its default.

## Keyboard

- `mod+k` (Cmd+K on Apple devices, Ctrl+K elsewhere) opens or closes the search. In a text field (including an element with the role `textbox`, `searchbox`, `combobox` or `spinbutton`, such as a custom component or an editor) or another open dialog it only closes an open search, so it never opens a second search from another search box.
- `/` opens it, except while typing in a text field, a textarea, an editable area or an element with one of those roles.
- Up and Down move through the results; focus stays in the box. Enter opens the result; Cmd or Ctrl+Enter opens it in a new tab.
- Escape clears the box, then closes the dialog. Focus returns to the button that opened it.
- Tab moves to the type tabs (Left and Right switch them), the filters, and "See all results".
- Nothing runs while an input method is still composing text.

On a touch screen, a tap on a `SearchLink` button first shows a small box that looks like the dialog's (`[data-search-proxy]`, with the same `--search-*` custom properties and `theme`), as iOS opens its keyboard only for a field focused inside the tap. When the dialog is ready, and at least 150 ms later, the text and caret move to it.

Set `shortcut: false` to turn the shortcut off, or `shortcut: { keys: ["mod+k"] }` to keep only one.

## Analytics

The search sends nothing anywhere. It dispatches three DOM events, which bubble out of the dialog (and out of its shadow root) to `document`, so you can pass them on to your own analytics. They fire from the browser layer, so every dialog built on it sends them too.

| Event | When | `detail` |
| --- | --- | --- |
| `search:query` | Once typing stops (the same quiet time as the live result count, 600 ms), for each new query or type tab. A query still waiting fires at once when a result is opened or the dialog closes. | `{ query, index, locale, total, type }`: `total` counts the matching pages, `type` is the active type tab (`null` for all). |
| `search:noresults` | Right after `search:query`, when that query found nothing. | `{ query, index }` |
| `search:select` | When a result or a suggested link is opened: Enter, a click, or a new tab. | `{ query, index, id, url, type, position }`: `position` starts at 1, in screen order. A suggested link has `id: null` and `query: ""`. |

Nothing fires for an empty box or while an input method is still composing text. `mountSearch({ events: false })` turns them off. The embed's results page (and EmDash's `<SearchResults>`) fires the same three events from its mount, so one set of listeners covers the dialog and the page. The plain Astro `SearchPage` fires none. More examples: [astronomic.dev/docs/search/analytics](https://astronomic.dev/docs/search/analytics).

Plausible:

```js
document.addEventListener("search:query", (e) => {
	const { query, total } = e.detail;
	window.plausible?.("Search", { props: { query, results: String(total) } });
});
document.addEventListener("search:noresults", (e) => {
	window.plausible?.("Search: no results", { props: { query: e.detail.query } });
});
document.addEventListener("search:select", (e) => {
	window.plausible?.("Search: open", { props: { query: e.detail.query, url: e.detail.url ?? "", position: String(e.detail.position) } });
});
```

Google Analytics 4 (its recommended `search` event, plus two of your own):

```js
document.addEventListener("search:query", (e) => {
	window.gtag?.("event", "search", { search_term: e.detail.query, results: e.detail.total });
});
document.addEventListener("search:noresults", (e) => {
	window.gtag?.("event", "search_no_results", { search_term: e.detail.query });
});
document.addEventListener("search:select", (e) => {
	const { query, url, position } = e.detail;
	window.gtag?.("event", "select_search_result", { search_term: query, link_url: url, position });
});
```

## Embed on any server

The embed is a second browser build for a page not built with Astro, such as a CMS theme. It reads its settings at run time from one JSON tag the server prints, so it needs no build step on that site. It uses the same index files, manifest, dialog and `--search-*` custom properties as the integration.

Never load the embed on an Astro page that uses the integration or the kit's search page. Each has its own boot.

### Build output

```sh
pnpm --dir packages/search build:embed   # or: node scripts/build-embed.mjs <outDir>
```

`pnpm build` writes the same folder, and the npm package ships it as `dist/embed/`:

- `search-embed.js`: the boot. It has a fixed name and no imports, so load it as a plain module: `<script type="module" src="/search/search-embed.js?ver=1">`. Change `?ver=` on each release.
- `chunks/embed-app-<hash>.js` and `chunks/embed-results-<hash>.js`: the dialog and the results page. They load only when needed, relative to the boot, so copy the whole folder. Each chunk holds all its own code (there is no shared chunk). Cache them for a year.
- `engine.json`: the engine the chunks carry (`schema`, `engine`, `engineVersion`). Check that your index files were built for it.
- `files.json`: `{ "boot": "search-embed.js", "files": [...] }`, every file written. When you deploy a new build, keep the files the previous `files.json` lists for one more release: a cached page or an open tab may still load old chunk names.

The build writes to a staging folder and swaps it in only when it is complete, so a failed build leaves the old output as it was.

### The config tag

Print one tag per page, before or after the boot:

```html
<script type="application/json" data-search-config>
{
  "manifest": "/search-data/manifest.json",
  "index": "default",
  "results": "/search",
  "queryParam": "q",
  "paramPrefix": "",
  "keys": ["mod+k", "/"],
  "strings": { "placeholder": "Search the site" },
  "browse": [{ "label": "All guides", "href": "/guides" }],
  "takeover": { "enabled": true, "inputName": "q", "skip": ".no-search-takeover", "allowFields": ["lang"] }
}
</script>
```

Escape `<`, `>` and `&` in the JSON so it cannot close the tag. Only `manifest` is required (an absolute `http(s)` URL or a root-relative path). Every other value has a default, and a wrong value falls back to it:

| Key | Default | What it does |
| --- | --- | --- |
| `manifest` | (required) | The manifest URL. With no usable manifest, or a tag that is not JSON, the embed does nothing. |
| `index` | `"default"` | The index for the shortcut, takeover, the results page, and placements with no `data-search-index`. |
| `lang` | `<html lang>` | Picks the index locale. |
| `results` | `"/search"` | The results page URL, for "See all results" and the takeover check. Relative or http(s); any other scheme takes the default. |
| `queryParam` | `"q"` | The query parameter on the results URL. |
| `paramPrefix` | `""` | Goes before the type, index and facet parameters. Letters, digits, `_` and `-` only. |
| `keys` | `[]` | Shortcut keys, such as `["mod+k", "/"]`. They open the default index's dialog. |
| `strings` | `{}` | Dialog and results page text (see [Strings](#strings)). |
| `browse` | `[]` | Links shown when the index cannot load, under the retry button. A link whose `href` is not relative or http(s) is dropped. With a working index, an empty dialog shows suggested links and recent searches instead; set those links with the index's `suggested` setting where the index is built. |
| `takeover.enabled` | `false` | Take over the theme's own search form. |
| `takeover.inputName` | `"q"` | The name of the theme form's search input. Letters, digits, `_`, `-` and `[]` only. |
| `takeover.skip` | `".no-search-takeover"` | Forms that match this selector, or are inside it, are left alone. |
| `takeover.allowFields` | `["lang"]` | Hidden input names a form may carry and still be taken over. |
| `standDown` | `null` | The name of another live search on the page. When set, takeover is off. Placements still work. |
| `theme` | none | `"light"` or `"dark"`. The dialogs and the takeover's stand-in box use it whatever the device's color scheme. Left out (or any other value), they follow the device. The results page has no colors of its own, so it always follows the page. |
| `links` | none | `"new-tab"`: every link in the dialog opens in a new tab, and the dialog stays open. Left out (or any other value), a result opens in the same tab. See [Links in a new tab](#links-in-a-new-tab). |

The embed does nothing in a browser without constructable stylesheets (Safari before 16.4). Every form and link stays native there.

### Placements

A placement is a container the server prints and styles. The package draws no field. It adds behavior only, and both kinds work with no JavaScript.

```html
<!-- Inline: a real search field. Typing opens the dialog with the text. -->
<div data-search-placement data-search-open="inline" data-search-index="main" data-search-placeholder="Search products">
	<form role="search" method="get" action="/search">
		<label for="product-q">Search</label>
		<input id="product-q" type="search" name="q">
		<button>Search</button>
	</form>
</div>

<!-- Modal: a plain link. A click or tap opens the dialog. -->
<div data-search-placement data-search-open="modal">
	<a href="/search">Search</a>
</div>
```

- The inline field's `name` must equal `takeover.inputName`. An inline placement has no results list of its own.
- Do not put `data-search-trigger` on the modal link.
- `data-search-index` and `data-search-placeholder` are optional, and are read at each open. Two placements on one index each show their own placeholder.
- A modified click on the modal link (Cmd, Ctrl, Shift, Alt or the middle button) opens the results page as usual.
- Escape returns focus to the field or link that opened the dialog.
- Placements added after the page loads work too.

### Links in a new tab

For a page people should not leave, such as an admin screen with a "try a search" box, set `"links": "new-tab"`. Leave it out on pages for visitors. Results, suggested links, "See all results" and the error state's links then open in a new tab, and the dialog stays open with its query. The dialog's footer says so (the `newTab` string). Theme takeover's form submit and the results page are not affected. Keep the config tag on the page until search first loads: the key is read then, and with no tag left the links open in the same tab.

### Theme takeover

With `takeover.enabled`, the theme's own search form opens the dialog. A form is taken over only when all of these hold:

- It is a GET form to the `results` URL (same origin and path), with no target other than `_self`.
- It has exactly one control named `inputName`, a text or search input.
- Its only other named controls are hidden inputs in `allowFields` and submit buttons with no `formaction`, `formmethod` or `formtarget`.
- It is not inside `skip` and not inside a placement.

A taken field is read-only, with `aria-haspopup="dialog"`, while the embed owns it. Both go back to what they were when it is given back (search cannot load, its index is not there, or its form no longer qualifies); a field that was read-only of its own is read-only again. It still takes focus: a printable key, a paste, a click, Enter or an IME's key opens the dialog, and the text goes into the dialog's box. Closing the dialog puts focus back on the field. Tab, Escape and the arrow keys do not open it. Known limit: Firefox does not start an input method (Chinese, Japanese, Korean) in a read-only field, so after the dialog closes, click the field or press Enter, and compose in the dialog.

Any other form is left alone, so product filters, POST forms and forms that go elsewhere keep working. A submit from a button with `formaction`, `formmethod` or `formtarget` submits natively.

On submit, if the app or the index fails to load, or both are not ready within 4 seconds, the form submits natively with the text typed so far. If the index fails to load after the theme's field (or the `LiveSearch` box) opened the dialog, for example before the first build, the dialog closes and the text typed so far goes back into the field, which stays the theme's for the rest of the page.

EmDash's `LiveSearch` box (`emdash/ui/search`, in EmDash's blog template) has no form. With takeover on, its field opens the dialog too, unless it is inside `skip`, and its own results dropdown stays shut. Other inputs with no form stay native.

When `strings.placeholder` is set, the embed also writes it onto the field of each form it takes over, and onto a taken `LiveSearch` box, so the theme's box shows the same text as the dialog. With takeover off, the theme's fields are never touched.

With takeover on, the shortcut keys win over the theme's own (a theme script that binds Cmd+K to its header box, as EmDash's blog template does): a press that opens or closes search never reaches the theme's listeners. Other keys, and every key with takeover off, stay the theme's. The embed listens in the window's capture phase and stops the press there, so a theme listener in that same phase added after it never sees the press. One added earlier still runs first: before the embed's script ran, or before search first loads (the first open, hover or focus), when the embed adds its listener again.

### First tap on phones

iOS opens the keyboard only for a field focused inside the tap itself. So every touch open shows a small field (the proxy) that looks like the dialog's box and focuses it at once. When the dialog is ready, and at least 150 ms later, the text and caret move to the real input. Style the proxy with the same `--search-*` custom properties as the dialog.

### The results mount

On the results page, print a mount with your own plain result list inside it:

```html
<div data-search-results data-search-index="main" data-search-query="lighthouse">
	<ol>
		<li><a href="/guides/lighthouse">Lighthouse guide</a></li>
	</ol>
</div>
```

- The boot loads the results chunk at once on a page with a mount. Once the index is loaded and the first render is built, the page draws in a shadow root and your list stops showing. If anything fails, your list stays.
- `data-search-query` is the server's query, for pretty URLs such as `/search/lighthouse/`. It applies only to the page's first history entry.
- `data-search-index` is optional. The URL's `${paramPrefix}index` comes first, then this attribute, then the config's `index`.
- `data-search-types` is optional: a comma-separated list of the types the page shows.
- The theme's global CSS for `ol`, `li`, `a` or `button` does not reach the results. Style them with `--search-*` and `::part()`. Font and color inherit from the page.
- The results page has no colors of its own, so it matches the theme. Lines, fills, matched words and the Search button come from the page's text color, and the button is an outline. To fill the button with your brand color, set `--search-accent` on the mount or an ancestor. Its text is white or black to contrast with the accent; set `--search-accent-fg` to choose it.
- It reads the dialog's `--search-font`, `--search-fg`, `--search-muted`, `--search-border`, `--search-line`, `--search-mark-bg`, `--search-mark-fg`, `--search-radius` and `--search-focus`, each defaulting to the page's text color mixed lighter, plus three of its own: `--search-rule` (the lines between results, text color at 9%), `--search-band` (the band behind each group's heading, 4%) and `--search-selected` (a picked tab or filter, 12%). See [astronomic.dev/docs/search/customize](https://astronomic.dev/docs/search/customize).
- The results page draws its own search field. Replace the body of the theme's search page with the mount, and keep the mount inside the theme's container. If you keep the theme's own field outside the mount, the page shows two search fields. Put the theme's form and list inside the mount instead: they show when the script does not run.
- Each change replaces the history entry, and a submit adds one, so Back returns to the last submitted search.

The same page is a module: `mountResultsPage(root, config)` from `@astronomic-dev/search/results` returns an unmount function. After an unmount, your list shows again.

### URL names

The results URL uses `queryParam` for the query, `${paramPrefix}type` for the type tab, `${paramPrefix}index` for the index and `${paramPrefix}<facet>` for each facet pick. "See all results" from a dialog always writes the index, so the results page searches the same one.

These three names are reserved. A facet whose URL name equals the query, type or index name is not read from or written to the URL. A `queryParam` equal to the type or index name falls back to `"q"`. Use `paramPrefix` when the host already uses short names (such as `tag` or `paged`) for its own parameters.

## EmDash

A free EmDash plugin ships in the same package. It builds the index from your EmDash content, keeps it fresh when you publish, serves it as JSON and prints the [embed](#embed-on-any-server) on every public page. It adds one admin page, **Search**, with the index status, a Rebuild now button and the settings. Tested on EmDash 1.4.0 and 1.6.0, including EmDash's default blog template (`create-emdash`).

See it first: [astronomic.dev/plugins/emdash-search](https://astronomic.dev/plugins/emdash-search) has a live demo: search a sample site, and change the dialog's mode, color, corners and font.

It is a native (trusted) plugin, installed from npm. It is not in EmDash's plugin registry, which lists sandboxed plugins only.

### Install

```sh
pnpm add @astronomic-dev/search
```

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { search } from "@astronomic-dev/search/emdash";
import { searchFiles } from "@astronomic-dev/search/emdash/astro";

export default defineConfig({
	integrations: [
		emdash({
			// your existing EmDash options (database, storage, ...)
			plugins: [search()],
		}),
		searchFiles(),
	],
});
```

In an existing config, keep your EmDash options, add `search()` to its `plugins` list, and add `searchFiles()` to `integrations`.

`searchFiles()` goes after `emdash()`. It copies the embed's files into your build at `/_search/embed/` and serves them in `astro dev`. Your site serves every file itself; nothing loads from us.

Options (in code only, and plain JSON only, because EmDash passes them to the plugin as JSON; a function, RegExp or Date throws):

| Option | Default | What it does |
| --- | --- | --- |
| `collections` | every collection with search support that is routable and not hidden | The collection slugs to index. A listed collection that is not routable is skipped with a build warning. |
| `budget` | `{ gzipKB: 300 }` | The size warning for each locale's index, gzipped. |
| `clip` | whole text | Characters of each entry's text the index keeps. |
| `exclude` | none | Site paths to leave out of search, such as a page the theme has turned off: `["/speaking", "/projects/*", "/sitemap-*.xml"]`. Case makes no difference. A `*` segment is any one segment; a `*` inside a segment is any run of characters there. See [Leave pages out](#leave-pages-out). |
| `excludeWhen` | none | Site paths to leave out while a switch in a settings entry is set, such as a part the site owner has turned off in the admin: `[{ collection: "details", field: "switch_areas", values: ["off"], paths: ["/areas", "/areas/*"] }]`. See [Leave pages out](#leave-pages-out). |
| `listPages` | none | Pages that list whole collections, such as a talks page or a FAQ, so a search for an item finds the page. See [List pages](#list-pages). |
| `taxonomyKeywords` | none | Taxonomies whose term labels are keywords of their entries: `["category", "tag"]`. See [Categories and tags](#categories-and-tags). |
| `textFields` | none | More fields to search, per collection: `{ projects: ["problem", "case_*"], areas: ["intro"] }`. See [More fields](#more-fields). |
| `filesPath` | `/_search/embed/` | Where the site serves the embed. Must match `searchFiles({ path })`. |

**Check the layout.** The plugin's two tags print only where your layout renders `<EmDashHead>` and `<EmDashBodyEnd page={page} />`. Most EmDash themes do, but a hand-made layout may not. To check: open a public page, view its source, and look for `data-search-config` near the end of `<body>`. If it is not there, add `<EmDashBodyEnd page={page} />` before `</body>`.

### Site URL

The build needs no site URL. The index holds paths only (`/posts/hello`), so search links work on any address the site is served at. EmDash does not read Astro's `site`. Only when you set one in EmDash (`siteUrl` in `emdash({ siteUrl })`, the `SITE_URL` environment variable, Settings > General or the setup wizard) does the admin page show a "Built for" line with it under the index; with none, that line is not shown.

The first build runs by itself within a minute of install. If no collection has search turned on yet, the build waits and runs once one does.

### Cloudflare

On Cloudflare, the plugin needs the Workers Paid plan. Node hosting has no such limit.

A rebuild runs inside the Worker, and the Free plan allows 50 D1 queries and 10 ms of CPU per run. A build makes about 8.5 D1 queries per 100 pages (39 for a 42-page site, 89 for 1,042 pages), so the Paid plan's 1,000 queries per run fit about 11,000 pages. With `taxonomyKeywords` it is about 2 more per 100 entries. When a build hits a plan limit, the old index stays and the admin page says so.

The rebuild runs on EmDash's cron, so the Worker needs EmDash's Worker entry and a Cron Trigger every minute. Without both, no first build runs and no change is picked up.

```ts
// src/worker.ts
export { default, PluginBridge } from "@emdash-cms/cloudflare/worker";
```

```jsonc
// wrangler.jsonc
{
	"main": "./src/worker.ts",
	"compatibility_flags": ["nodejs_compat"],
	"triggers": { "crons": ["* * * * *"] }
}
```

Then run `npx emdash doctor`: it checks the Worker entry. Astro 7.3 needs `@astrojs/cloudflare` 14.3.x. To test the cron locally, build the site, run `wrangler dev --test-scheduled`, then call `/cdn-cgi/handler/scheduled?cron=*+*+*+*+*` (for example `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`).

If the Worker fails at start with a `require` error from `postcss` (EmDash's HTML sanitizer pulls it in, and Vite 8 leaves its `require` calls to a shim that Workers lack), add a small Vite plugin that gives server chunks a `require` from `node:module`, with `nodejs_compat` on:

```js
// astro.config.mjs, in vite.plugins
{
	name: "workers-require",
	applyToEnvironment: (environment) => environment.config.consumer === "server",
	renderChunk(code) {
		if (!code.includes("typeof require")) return null;
		return { code: `import { createRequire as __cr } from "node:module";\nconst require = __cr("/");\n${code}`, map: null };
	},
}
```

### Settings

The admin page's settings take effect on the next page view, with no rebuild.

| Setting | Default |
| --- | --- |
| First and second shortcut | `mod+k` and `/` |
| Take over the theme's search form | off |
| Search input name | `q` |
| Search box text | `Search the site` |
| Theme | auto |
| Results page URL | `/search` |

With takeover on, the theme's search form and EmDash's `LiveSearch` header box open the dialog, and the shortcut keys win over the theme's own (see [Theme takeover](#theme-takeover)). The results page URL must match your search form's `action` exactly, trailing slash included.

The rest of the [config tag](#the-config-tag) is fixed on EmDash: `queryParam` is `q` and `paramPrefix` is empty (no prefix), so the results URL is `/search?q=...` with `type`, `index` and facet names as they are. Of the [strings](#strings), only `placeholder` comes from the admin page (Search box text). The index is always `default`, and `takeover.skip` and `takeover.allowFields` keep their defaults.

Known limits: Space cannot be a shortcut key. On a Mac, Ctrl records as `ctrl`, not `mod` (`mod` is Cmd on a Mac and Ctrl elsewhere).

### When a build fails

The admin page shows why the last build failed, and the old index stays live. One exception: `no-collections`, when no collection is left to index, takes the old index down too, so the manifest answers 503 and the theme's own search works again. The codes (`plan-limit` for a Cloudflare plan too small, `no-collections` when no collection has search turned on, `too-large` over the size cap, `deadline` and `interrupted` for a build cut short, and the rest) and what to do about each are in [astronomic.dev/docs/search/troubleshooting](https://astronomic.dev/docs/search/troubleshooting).

### What is indexed

- One record per published entry in the indexed collections, one index per locale. The URL comes from EmDash itself, so URL patterns, locale paths and trailing slashes match the site.
- The text is the first of the excerpt, summary, description and SEO description, then the fields in [`textFields`](#more-fields), then the plain text of the content. A `search_keywords` field (a list or a comma list) adds keywords, and so do the terms in [`taxonomyKeywords`](#categories-and-tags). EmDash field slugs are lowercase, so name it that way.
- Pages in `listPages` also have the words of the entries they list. See [List pages](#list-pages).
- Skipped: drafts, scheduled entries until they publish, entries with `seo.noIndex` on, entries with no public URL, and paths in `exclude`.
- No heading records yet: EmDash's renderer prints no heading ids, so a result links to the page, not a section. Heading text is still searched.

### Leave pages out

Use `exclude` for an entry that is published but has no page: a theme can turn a page off in its code, while the entry that words it stays published, and a result for it would be a 404.

```js
search({ exclude: ["/speaking", "/projects/*"] });
```

- A path is exact, in any case: `/Speaking` and `/speaking` are the same. A `*` segment is any one segment: `/projects/*` leaves out every project, but not `/projects` itself. A `*` inside a segment is any run of characters in that segment, none too: `/sitemap-*.xml` leaves out `/sitemap-0.xml` and `/sitemap-index.xml`, but not `/sitemap.xml`. An encoded `%2A` is a plain asterisk.
- Write site paths, starting with `/`, with no base (a value that is not a list of these throws). A trailing slash makes no difference. Letters can be plain or encoded (`/café` or `/caf%C3%A9`).
- A path with no locale prefix is left out in every locale: `/speaking` also leaves out `/fr/speaking`. To leave a page out in one locale only, write its prefix: `/fr/speaking`. A first segment that is a locale's prefix always means the locale, even if a page has the same slug. A `*` never stands for the prefix.
- A change to an option (`exclude`, `excludeWhen`, `collections`, `clip`, `listPages`, `taxonomyKeywords`, `textFields`) is in your code, so EmDash sends no content event for it. It shows after the next build: click Rebuild now after you deploy, or wait for the next content change or the nightly build.
- `exclude` and `excludeWhen` cover this index only. EmDash's own search, which the theme's server list uses, still finds the entry.

**While a switch is off.** Use `excludeWhen` when the site owner turns a part of the site on and off in the admin, with a field of a settings entry (a select of `on` and `off`, say). At each build the plugin reads that entry, and while the field holds one of `values`, the `paths` are left out as `exclude` leaves them out.

```js
search({
	excludeWhen: [{ collection: "details", field: "switch_areas", values: ["off"], paths: ["/areas", "/areas/*"] }],
});
```

- `collection` is a collection with one entry. It needs no search support and no URL. The plugin reads its newest published entry, the one a theme that lists the collection gets first (EmDash lists the newest first). A second published entry is a build warning, and the newest one is read.
- `paths` work as in `exclude`, and the two lists join: a path left out gets no page from `listPages` either.
- An empty field and no published entry both read as `null`. Put `null` in `values` when the part is off by default.
- A collection or field the site does not have, or a field that holds a list or an object, is a build warning, and the rule leaves nothing out.
- If the entry cannot be read, the build fails, the live index stays as it was, and the next tick tries again. A read error never brings back the pages of a part that is off.
- Only published content counts. Publishing the entry is a content change, so the index is rebuilt within about a minute. With `collections` listed, the rule's collection counts too.
- When it shows: a part turned off leaves search on page loads after the next build that succeeds. A tab that loaded the index earlier keeps the old results until it reloads, and while builds fail, the old index stays live.

### List pages

Use `listPages` for a page whose route shows a whole collection with no page per entry, such as talks, a FAQ or price plans. The words of the entries go to the end of the page's text, so a search for an item finds the page that lists it.

```js
search({
	listPages: [
		{
			path: "/speaking",
			from: [{ collection: "talks", fields: ["title", "event", "summary"] }],
			fallback: { title: "Speaking", text: "Talks and workshops." },
		},
	],
});
```

| Key | What it does |
| --- | --- |
| `path` | The page's site path, literal, with no base and no locale prefix. Each path once. |
| `from` | The collections the page lists, and the fields to take the words from. A field holds a string or Portable Text; anything else adds nothing. The collections need no search support and no public URL. |
| `fallback` | `{ title, text? }`: makes the page when no entry has the path, for a route whose words are in the theme's code. Leave it out, and only an entry's own page gets the words. |
| `type` | The type of the page `fallback` makes. Default `pages`. |

- `from` takes the whole collection: every published entry without `seo.noIndex`, in the page's locale. List only collections and fields the page really shows, because the index is public. There are no filters.
- The page keeps its entry's title, type and URL, in every locale that has one. `fallback` makes a page in the default locale only.
- A published entry at the path with `seo.noIndex` on keeps the page out, with or without `fallback`. An unpublished one leaves the fallback, if any. An entry in a collection that is not indexed is not seen. If two entries have the path, nothing is added and the build warns.
- `exclude` wins: an excluded path gets no page. An excluded entry still adds its words to the page that lists it.
- A page gets up to 20,000 characters from its items; the build warns when it cuts the rest. An unknown collection or field is a build warning too.
- `listPages` adds to a searchable site. With no search collection at all, the build stays `no-collections`.
- A change to an item shows like any other change. A change to `listPages` itself is in your code, so click Rebuild now after you deploy.

### Categories and tags

`taxonomyKeywords` makes the labels of an entry's terms its keywords, so a search for a tag finds the posts that have it. It is off by default.

```js
search({ taxonomyKeywords: ["category", "tag"] });
```

- The names are the taxonomies' names in EmDash. A name no entry has terms in adds nothing, with no warning.
- The entry's own keywords come first, then the labels in the order of the list, with no duplicates. An entry keeps its first 20 keywords, as everywhere.
- A label is the one in the entry's locale, else the one in the default locale. The terms of an entry in `listPages` do not go to the page that lists it.
- **When a change shows.** Saving or publishing the entry rebuilds the index as usual. But setting a term in the admin on its own, and renaming or deleting a term, send no content event in EmDash 1.4. They show after the next build: the next content change, Rebuild now or the nightly build.
- Cost: about 2 more D1 queries per 100 entries (more on a site whose entries are in several locales). If EmDash cannot read the terms, the build warns and goes on without them.

### More fields

By default an entry's text is its lead (the first of `excerpt`, `summary`, `description` and the SEO description) and its Portable Text `content`. `textFields` names more fields to search, per collection, such as a project's case study or an area's intro. Their words follow the lead, before the content.

```js
search({
	textFields: {
		projects: ["problem", "approach", "result", "case_*"],
		areas: ["intro"],
	},
});
```

- A field holds a string, Portable Text, or a list of blocks of your theme's own types: each block's text, such as its heading, text and list items. Images, links and anything else add nothing.
- A name that ends in `*` is every field whose slug starts with the rest, in the collection's field order: `case_*` takes `case_title`, `case_lede` and `case_blocks`.
- For a list of blocks, `{ field: "case_blocks", keys: ["heading", "text", "steps"] }` reads only the words under those keys of each block, at any depth (a `steps` list gives each step's words), so a layout value such as `side: "end"` stays out of search. Without `keys`, every string of a block counts. The entry sets the keys of that field when a `*` name takes it too.
- `title`, `content` and `search_keywords` are read already, so they are left out. The lead field is not added twice.
- A field the collection does not have, a `*` no field matches, and a collection that is not indexed are build warnings. A name that is not a field slug throws.
- Each entry gets up to 20,000 characters from these fields; the rest is cut, with a build warning. `clip` and the size budget still apply, and the index is public, so list only fields the page shows.
- A change to the option shows after the next build: click Rebuild now after you deploy.

### How fast a change shows

About a minute. Publish, unpublish, delete, restore, save of a published entry, schedule and unschedule each mark the index as stale. The build runs once edits stop for 10 seconds, or at most a minute after the first one. A full rebuild also runs every night, and Rebuild now runs one at once. A build never replaces the live index until it has finished, so search keeps working while it runs.

### Size limits

Each locale's index is capped at 8,000,000 bytes of JSON, the most EmDash lets a plugin route send. Over the cap, the build fails, the old index stays, and the admin page says how far over it is. To get under it, index fewer collections or set a smaller `clip`. The 300 KB gzip budget is a warning only: the admin page shows green up to 80% of it, amber up to 100% and red above. At 5,000 records the admin page says the site is past the size this engine is made for.

Measured: a 10,000-entry site stores its index in 4 chunks, 376 KB gzip, and builds in about 2 seconds. The admin page's own code is about 5 KB gzip and loads only in the admin.

### The search page

Replace the body of the theme's search page with `<SearchResults>`, inside the theme's container. Put the theme's own form and result list in its slot. They show when the script does not run, and stop showing when the search page draws, so the page never shows two search fields.

```astro
---
import { getContentSeo, getEmDashEntry, search } from "emdash";
import SearchResults from "@astronomic-dev/search/emdash/astro/SearchResults.astro";
import Base from "../layouts/Base.astro";
// Your theme's own link helper: the one its list pages use for each entry's URL.
import { entryUrl } from "../utils/urls";

export const prerender = false;
const query = Astro.url.searchParams.get("q")?.trim() || "";
const found = query ? (await search(query, { limit: 30 })).items : [];
// EmDash's search skips drafts only. Drop entries with "noindex" on, as the search index does.
const shown = await Promise.all(
	found.map(async (item) => {
		const { entry } = await getEmDashEntry(item.collection, item.slug ?? item.id, { locale: item.locale });
		return !!entry && getContentSeo(entry)?.noIndex !== true;
	}),
);
const items = found.filter((_, i) => shown[i]);
---

<Base title="Search">
	<div class="frame">
		<SearchResults query={query}>
			<form method="get" action="/search" role="search">
				<input type="search" name="q" value={query} aria-label="Search" />
				<button>Search</button>
			</form>
			<ol>
				{items.map((item) => <li><a href={entryUrl(item)}>{item.title ?? item.slug}</a></li>)}
			</ol>
		</SearchResults>
	</div>
</Base>
```

`frame` stands for the theme's own container, and `entryUrl` for its own link helper. Use your theme's links: a collection's URL pattern, locale prefix or trailing slash can differ from `/collection/slug`, so a link built by hand may 404. The `noIndex` check drops the entries the index leaves out, since EmDash's `search()` filters by status only. The page takes the theme's font and text color. Its Search button is an outline in the text color; set `--search-accent` (and `--search-accent-fg`) to fill it with your brand color.

### Caching

The manifest and index routes (`/_emdash/api/plugins/astronomic-search/manifest` and `.../index`) send `public, max-age=0, must-revalidate` with an ETag, so a browser revalidates each time and a new build shows at once. With no build yet, the manifest answers 503 and the theme's own search keeps working. On the Cloudflare adapter, `searchFiles()` also writes cache rules for `/_search/embed/` to `_headers`: hashed chunks for a year, the boot and its lists for 5 minutes (the boot's `?ver=` changes each release).

### Later

Not built yet: a sandboxed listing in EmDash's registry, ranking weights in the admin page, several indexes, heading links, and the Cloudflare Free plan (by building the index at deploy time).

## Content Security Policy

The boot and app scripts are files in `/_search/`, never inline, and the dialog's styles are a constructable stylesheet in its shadow root. A policy of `script-src 'self'; style-src 'self'` works with no changes. The search's own checks run under exactly that policy. The `SearchPage` script is a small module that Vite may inline in the page when it is under `vite.build.assetsInlineLimit`; a strict policy needs it as a file, so do not raise that limit very high.

## Caching

Every file in `/_search/` has a hash in its name except `manifest.json`, which names the current index files. Cache the hashed files for a year and the manifest only briefly, so a new deploy is seen. The browser asks for the manifest with `cache: "no-cache"` (it revalidates each time), and if an index file it names is gone (a 404 after a deploy), it fetches the manifest once more and loads the new file.

On Cloudflare (Pages, or Workers static assets), a `public/_headers` file:

```
/_search/*
  Cache-Control: public, max-age=31536000, immutable

/_search/manifest.json
  ! Cache-Control
  Cache-Control: public, max-age=0, must-revalidate
```

## Size

Measured on astronomic.dev (Docs, Learn, Themes, the changelog and the main pages; 86 pages, 442 heading sections), before the index file stored its records packed. The packed file (schema 2) is about 17% smaller gzipped than the sizes below. The CPU column is Chromium slowed down 4x, like a mid-range phone.

| Records | Index file (gzip) | Load at 4x CPU | Query p95 at 4x CPU (engine only) |
| --- | --- | --- | --- |
| 528 | 79 KB | 88 ms | 1.8 ms |
| 1,200 | 121 KB | 136 ms | 2.6 ms |

The engine-only columns time MiniSearch alone. A full dialog query (the engine, then grouping, filter counts and highlights) took about 10 ms at p95 at 4x CPU on the 528 records.

The boot script on every page is about 4 KB gzip (4.07 KB measured, budget 4.07 KB); about 2 KB of it is the phone stand-in box (see [Keyboard](#keyboard)). The app (engine, controller, browser behavior and dialog) is about 25 KB gzip (25.25 KB measured, budget 25.26 KB) and loads only on first use. MiniSearch, the engine, is about 6 KB of that.

The embed's boot is 6.27 KB gzip (budget 6.28 KB); it holds the takeover, placements and the phone proxy, so it is larger than the integration's. Its dialog chunk is 26.26 KB (budget 26.48 KB), its results page chunk 22.64 KB (budget 24.62 KB), and the boot plus the dialog, the cold transfer on first use, 32.53 KB (budget 32.54 KB). The budgets are in `test/budgets.json`, and the tests fail past them. More: [astronomic.dev/docs/search/performance](https://astronomic.dev/docs/search/performance).

**When to move on (later).** Every record loads into the visitor's browser. At about 5,000 page and heading records, the load on a slowed-down phone passes half a second, and a site that big should move to a Pagefind-based engine, which loads only the parts of the index a query needs. That engine is planned, not built yet.

## License

MIT

## More from Astronomic

- [Astronomic UI](https://astronomic.dev/ui): free Astro components and sections on one set of tokens.
- [Vesper](https://astronomic.dev/themes/vesper): a free Astro theme for a personal blog and portfolio.
- [Astronomic Starter](https://astronomic.dev/themes/starter): a free Astro starter for a small product site, with a blog and guides.
- [wp-esc](https://astronomic.dev/learn/wordpress): plan a move from WordPress to Astro or EmDash.
- [All Astronomic themes](https://astronomic.dev/themes)
