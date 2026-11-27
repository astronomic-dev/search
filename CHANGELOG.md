# Changelog

## 0.2.3

- Added, for `html()`: `<meta name="search:title" content="Home">` in a page's head sets its result title, in place of its `<h1>` or `<title>`. A page without it is unchanged.
- Added, for the EmDash plugin: `search({ excludeWhen: [{ collection: "details", field: "switch_areas", values: ["off"], paths: ["/areas", "/areas/*"] }] })` leaves site paths out while a switch in a settings entry is set, such as a part the site owner turns off in the admin. At each build the plugin reads the newest published entry of the collection (the one a theme that lists it gets first); while the field holds one of `values`, the paths are left out as `exclude` leaves them out, and a left-out path gets no list page. An empty field and no published entry both read as `null`. Publishing the entry rebuilds the index within about a minute, also with `collections` listed. A missing collection or field, a value that is a list or an object, or a second published entry is a build warning; a failed read fails the build, and the live index stays. A part turned off leaves search on page loads after the next build that succeeds: a tab that loaded the index earlier keeps the old results until it reloads. Each rule collection costs one list read per build. Nothing changes for a site that does not use it.
- Added, for the EmDash plugin: `search({ textFields: { projects: ["problem", "approach", "result", "case_*"], areas: ["intro"] } })` searches more fields of each entry, per collection, such as a case study or an area's intro. Their words follow the lead text, before `content`. A field holds a string, Portable Text or a list of blocks of the theme's own types (each block's text). A name that ends in `*` is every field that starts with the rest. `{ field: "case_blocks", keys: ["heading", "text", "steps"] }` reads only the words under those keys of each block, so a layout value such as `side: "end"` stays out. A field or collection that is not there is a build warning, and each entry gets up to 20,000 characters from these fields. Nothing changes for a site that does not use it.
- Changed, for the EmDash plugin: the paths in `exclude` and `excludeWhen` ignore case, and a `*` inside a segment is any run of characters in that segment: `/sitemap-*.xml` leaves out `/sitemap-0.xml`. A `*` segment is still any one segment, and an encoded `%2A` is still a plain asterisk. `html({ include, exclude })` is unchanged: its paths keep case, and a `*` is a whole segment.
- Fixed, for the embed and the EmDash plugin: when the dialog fails to load after a reader opened a placement's link and typed, a link to the results page now goes there with the typed text as the query, not to an empty search page. The boot grows by about 30 bytes gzip (budget 6.28 KB).

## 0.2.2

- Added: `touchOpens(view)` from `@astronomic-dev/search/boot`, for `startBoot({ touch })`, so a dialog of your own opens with the keyboard on an iPhone too. Your view shows a stand-in box like your dialog's field (`show(trigger)` returns `{ host, input, searchPage? }`, or `null` for an ordinary open), and your app's new optional `openTouch(trigger, draft)` takes over its focus, text and caret. The `touch` option is public now. See "Build your own dialog" in the README. A boot that does not use it does not grow.
- Fixed, for a tap on a `SearchLink` button and for `touchOpens`: the handoff from the stand-in box waits for an unfinished input method composition to end, and Escape during one is left to the input method. If the app fails to load, the text typed in the box goes along to the search page as `q` when the link goes to it on the same site (the link's other parameters and its hash stay; a button with its own `href` keeps it as it is). A touch now counts only for the one click it gave, so a mouse click soon after a tap, or after a canceled touch, makes no stand-in. The boot script grows from 3.73 KB to 4.07 KB gzip.
- Fixed: on an iPhone, a tap on a `SearchLink` button opened the dialog without the keyboard. A touch open now shows and focuses a stand-in box inside the tap, whether the app is loaded or not, and the dialog takes over its text and caret, as the embed already does. It also works for a button inside an open modal `<dialog>`. A mouse or a key opens as before. The boot script grows from 2.08 KB to 3.73 KB gzip. If you set the `--search-*` custom properties (or a toggle script sets `theme`) on `astronomic-search` itself, add `[data-search-proxy]` there too.

### Added: the EmDash plugin

- `search({ exclude: ["/speaking", "/projects/*"] })` leaves site paths out of the index, such as a page the theme has turned off while its entry stays published. Patterns are as in `html()`: exact, and a `*` is any one segment. A trailing slash makes no difference, letters can be plain or encoded, and a path with no locale prefix is left out in every locale. An excluded entry does not count as skipped. After you deploy a change to it, click **Rebuild now**, or it shows after the next content change or the nightly build (as with `collections` and `clip`).
- `search({ listPages: [{ path: "/speaking", from: [{ collection: "talks", fields: ["title"] }], fallback: { title: "Speaking" } }] })` adds the words of whole collections to the page that lists them, so a search for a talk finds the talks page. The entry at the path gets the words; `fallback` makes the page when no entry has the path. Nothing changes for a site that does not use it.
- `search({ taxonomyKeywords: ["category", "tag"] })` makes the labels of an entry's terms its keywords, so a search for a tag finds its posts. Off by default. Setting a term on its own or renaming one sends no content event in EmDash 1.4, so it shows after the next build.

### Fixed: focus on the results page

- **Try again** and **Search all types** no longer lose keyboard focus when a theme hides the results page's own field (`::part(form) { display: none }`). Focus goes to the results, a named group with a focus ring (`::part(area)`). Focus on another control, such as the theme's own search form, stays there. With the field shown, nothing changes.

### Fixed: results while a short word is typed

- The last word of a query now matches the words it starts from its first letter. It took 3 letters, so "te" said there were no results for a page about tests, and "search t" found only pages with the word "t". An exact short word ("go", "C") still ranks first. A short word before the last one still matches exactly. A last word of 3 letters or more finds what it found before. The index files do not change. The app budget for Astro is now 25.26 KB gzip, the embed's boot 6.25 KB, and the embed's first open (boot and app) 32.51 KB.

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
