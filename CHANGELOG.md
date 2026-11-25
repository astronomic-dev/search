# Changelog

## 0.2.1

- The Astro integration takes a `theme` (`"light"` or `"dark"`): every dialog `SearchLink` adds uses it, whatever the visitor's device is set to. Left out, nothing changes: the dialog follows the device. Any other value fails the build.
- The embed puts its config's `theme` on a dialog once, when it makes it. A host script that removes the `theme` attribute afterwards now keeps it removed.

## 0.2.0

### Added: the EmDash plugin

- `search()` from `@astronomic-dev/search/emdash`: a native EmDash plugin (EmDash 1.4 and up). Add it to `emdash({ plugins: [search()] })`. The plugin builds the index from the published entries of each collection with search turned on (drafts and `noIndex` entries are skipped) and serves it from its own routes. It refreshes after content changes, and once a night.
- The first build runs by itself within a minute of install. It needs no site URL: the index holds paths only.
- `searchFiles()` from `@astronomic-dev/search/emdash/astro`: the Astro integration that puts the search embed's files into the site at `/_search/embed/`. Add it after `emdash()`.
- An admin page under Plugins > Search. It shows the index (size, content, when it was last built and, when EmDash has one, the site URL) with **Rebuild now**, and holds the settings: the two shortcut keys, theme takeover, the search box text, the theme and the results page URL. Takeover is off by default.
- `SearchResults.astro` from `@astronomic-dev/search/emdash/astro/SearchResults.astro`: the mount for your site's own search page. Put your form and server-side result list in its slot. They show when the script does not run.
- On Cloudflare, the plugin needs the Workers Paid plan (the Free plan's D1 query and CPU limits are too small for a build). The Worker must export EmDash's scheduled handler and run a cron trigger every minute. When a build hits a plan limit, the admin page says so and the old index stays live. Node hosting has no such limit.
- The index has an 8 MB cap. A build over it fails with a clear error, and the old index stays live.

### Added: links in a new tab

- The embed config takes `"links": "new-tab"`, for a page people should not leave (an admin screen). Results, suggested links, "See all results" and the error state's links open in a new tab with no opener, and the dialog stays open. The dialog's footer says so: a new string, `newTab`, in a new part, `new-tab`. Left out, nothing changes.
- `mountSearch` and `bindCombobox` take `newTab` (default false). Put `target="_blank" rel="noopener"` on your own result links, and the browser follows a click on one itself, so a pop-up blocker never stops it.

### Changed: the embed

- **The results page no longer has a blue Search button.** The results page now has no colors of its own. The button is an outline in the page's text color, and matched words are marked with the text color. To keep a filled button, set `--search-accent` on the mount or an ancestor. Its text is white or black to contrast with the accent, or `--search-accent-fg`. If you use the 0.1.x results page, check it after you update.
- With takeover on, the embed writes `strings.placeholder` onto the field of each theme form it takes over, so the theme's box shows the same text as the dialog. With takeover off, the theme's fields are never touched.
- With takeover on, the shortcut keys win over the theme's own. A press that opens or closes search never reaches the theme's listeners (for example a theme that binds Cmd+K to its header box). Other keys, and every key with takeover off, stay the theme's.
- With takeover on, EmDash's `LiveSearch` box (`emdash/ui/search`, in EmDash's blog template) opens the dialog, and its own results dropdown stays shut. If the index is not there yet (before the first build), the box goes back to EmDash's own search with the text typed so far. A taken form's field does the same, and the form then submits natively.
- The shortcut stops a press it acts on with `stopImmediatePropagation`, so another window capture listener added after the embed's never sees it. A theme's window capture listener added earlier (before the embed's script ran, or before search first loads) still runs first.
- With takeover on, a taken theme field (a form's or `LiveSearch`'s) is read-only while taken, with `aria-haspopup="dialog"`. Both go back to what they were when the field is released: search cannot load, its index is not there, or its form no longer qualifies. It stays focusable: focus comes back to it when search closes, and from there a printable key, a paste, a click, an IME key or Enter opens the dialog again, with the text in the dialog's box only. The theme's box keeps its own text (before, it kept the first letter typed). Known limit: Firefox does not start an input method in a read-only field; click the field or press Enter, and compose in the dialog.
- The embed boot budget is now 6.22 KB gzip. The app budget for Astro is now 25.17 KB, and the embed's first open (boot and app) 32.42 KB.

## 0.1.1

- The embed config takes a `theme` (`"light"` or `"dark"`).

## 0.1.0

- First release: the Astro integration with a build-time index, the headless controller, the default dialog, the search page and the embed for any server.
