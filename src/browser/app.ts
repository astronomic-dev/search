/**
 * The search app the boot script loads on first use (a hashed file in `/_search/`): core, the MiniSearch engine, the
 * controller, the dom layer and the default dialog. It defines <astronomic-search> and makes one per trigger key.
 *
 * When the integration starts, `__ASTRONOMIC_SEARCH__` is replaced with `{ manifest, index, strings, browse }`.
 */
import { loadSearcher, type StringsInput } from "../controller/index.ts";
import { createSearch } from "../core/search.ts";
import { minisearchEngine } from "../core/minisearch.ts";
import { defineSearchElement, SearchElement, TAG, triggerKey } from "../ui/element.ts";
import type { BrowseLink } from "../ui/render.ts";

declare const __ASTRONOMIC_SEARCH__: { manifest: string; index: string; strings: StringsInput; browse: BrowseLink[] };
const config = __ASTRONOMIC_SEARCH__;
const TRIGGER = "[data-search-trigger]:not([data-search-ui])";

defineSearchElement({
	index: config.index,
	strings: config.strings,
	browse: config.browse,
	load: (index) =>
		loadSearcher({
			index,
			lang: document.documentElement.lang,
			manifestUrl: config.manifest,
			// The init carries the manifest's cache mode ({ cache: "no-cache" }).
			fetch: (url: string, init?: RequestInit) => fetch(url, init),
			engine: minisearchEngine,
			createSearch,
		}),
});

const dialogs = new Map<string, SearchElement>();
/** The shortcut keys boot passed in, kept for the main dialog after a view transition. */
let shortcutKeys: string[] = [];

function mainTrigger(): HTMLElement | null {
	return document.querySelector<HTMLElement>(`${TRIGGER}[data-search-main]`) ?? document.querySelector<HTMLElement>(TRIGGER);
}

/**
 * The dialog for a trigger, made (and appended to the body) on first use. A view transition swaps the body and so
 * removes the dialog: it is appended again, and connecting binds it to the new page's triggers.
 */
function dialogFor(trigger: Element, keys: string[]): SearchElement {
	if (keys.length) shortcutKeys = keys;
	const key = triggerKey(trigger, config.index);
	let el = dialogs.get(key);
	if (!el) {
		el = document.createElement(TAG) as SearchElement;
		const [index, types, group] = key.split("|");
		el.setAttribute("index", index!);
		if (types) el.setAttribute("types", types);
		if (group) el.setAttribute("group", group);
		const main = mainTrigger();
		el.keys = main && triggerKey(main, config.index) === key ? keys : [];
		dialogs.set(key, el);
		document.body.append(el);
	} else if (!el.isConnected) {
		document.body.append(el);
	} else if (!el.triggers.includes(trigger as HTMLElement)) {
		el.bind();
	}
	return el;
}

/**
 * Makes the dialog for `trigger` (and the main trigger's, so the shortcut is bound) and starts loading its index.
 * `keys` are the shortcut keys; they go to the main trigger's dialog only.
 */
export function prepare(trigger: HTMLElement, keys: string[] = []): SearchElement {
	const main = mainTrigger();
	if (main && main !== trigger) dialogFor(main, keys);
	const el = dialogFor(trigger, keys);
	el.controller.preload().catch(() => {});
	return el;
}

/** Opens the dialog for `trigger` (default: the main trigger). */
export function open(trigger: HTMLElement | null = mainTrigger(), keys: string[] = []): void {
	if (!trigger) return;
	prepare(trigger, keys).controller.open();
}

// Astro's ClientRouter swapped the body: boot no longer listens for the shortcut (this app took over), so bind the
// main dialog to the new page now, before any trigger is used.
document.addEventListener("astro:after-swap", () => {
	const main = mainTrigger();
	if (main && dialogs.size) dialogFor(main, shortcutKeys);
});
