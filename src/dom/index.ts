/**
 * The dom layer: accessible browser behavior for a search surface, with no markup of its own. A recipe renders its
 * elements, hands them in, and renders results from the controller; these binders add the roles, states, keys and
 * focus rules (WAI-ARIA APG dialog, combobox with aria-activedescendant, tabs) and each returns an unbind().
 */
import type { Controller } from "../controller/index.ts";
import { bindCombobox } from "./combobox.ts";
import { bindDialog } from "./dialog.ts";
import { bindEvents } from "./events.ts";
import { bindLive } from "./live.ts";
import { bindShortcut, isApple } from "./shortcut.ts";
import { bindTabs } from "./tabs.ts";
import { bindTrigger } from "./trigger.ts";

export { createIdFor, idFor, hash } from "./ids.ts";
export { isSafeUrl } from "./safe-url.ts";
export { marked } from "./marked.ts";
export { ariaKeyshortcuts, bindShortcut, isApple, isEditable, matchKey, shortcutAction, type KeyEventLike, type ShortcutOptions } from "./shortcut.ts";
export { bindTrigger, triggerStart, type TriggerOptions } from "./trigger.ts";
export { bindDialog, type DialogOptions } from "./dialog.ts";
export { bindCombobox, type ComboboxOptions } from "./combobox.ts";
export { bindTabs, type TabsOptions } from "./tabs.ts";
export { bindLive, type LiveOptions } from "./live.ts";
export { bindEvents, type Events, type EventsOptions, type SearchNoResultsDetail, type SearchQueryDetail, type SearchSelectDetail } from "./events.ts";

export interface MountOptions {
	/** One trigger link or several; the shortcut's main one has data-search-main, else it is the first. */
	trigger: HTMLElement | HTMLElement[] | null;
	dialog: HTMLDialogElement;
	input: HTMLInputElement;
	listbox: HTMLElement;
	/** The type tabs, if the surface shows them. */
	tablist?: HTMLElement | null;
	/** The results panel the tabs control. Default: the listbox's closest [role="tabpanel"]. */
	panel?: HTMLElement | null;
	/** The visible box inside the dialog; a click outside it closes. Default: the dialog. */
	dialogPanel?: HTMLElement;
	live: HTMLElement;
	controller: Controller;
	/** The option element id for a record id; the recipe renders options with the same ids. */
	idFor: (recordId: string) => string;
	/** Shortcut keys, for example ["mod+k", "/"]; [] for none (the setting shortcut: false). */
	keys: string[];
	/** Listen for the shortcut in the window's capture phase and stop a press it acts on, so it wins over the page's own listeners (the embed's takeover). Default false. */
	capture?: boolean;
	/** Default true. A kit recipe passes false and opens with the kit's openModal() through `show`. */
	scrollLock?: boolean;
	show?: (dialog: HTMLDialogElement) => void;
	/** Default: read from navigator. */
	apple?: boolean;
	navigate?: (url: string, newTab: boolean) => void;
	/**
	 * Open every result in a new tab; the dialog stays open. Default false. A result link of yours to the option's URL
	 * with target="_blank" rel="noopener" is followed by the browser itself, so a pop-up blocker never stops a click on
	 * it (with no `navigate`); any other click goes through `navigate` or window.open.
	 */
	newTab?: boolean;
	/** Live region delay in ms, and the quiet time before search:query. Default 600. */
	liveDelay?: number;
	/** Called just before the dialog opens: with the trigger that opened it, or null for the shortcut. */
	onOpen?: (trigger: HTMLElement | null) => void;
	/**
	 * The explicit opener (an embed's theme field, placement field or link) that focus returns to on close. Called on
	 * an open that no trigger or shortcut set an opener for.
	 */
	takeOpener?: () => HTMLElement | null;
	/** Dispatch the analytics events (search:query, search:select, search:noresults) on the dialog. Default true. */
	events?: boolean;
}

export function mountSearch(options: MountOptions): () => void {
	const { controller, keys } = options;
	const doc = options.dialog.ownerDocument;
	const win = doc.defaultView!;
	const apple = options.apple ?? isApple(win.navigator as Navigator & { userAgentData?: { platform?: string } });
	const triggers = options.trigger ? (Array.isArray(options.trigger) ? options.trigger : [options.trigger]) : [];
	const main = triggers.find((t) => t.hasAttribute("data-search-main")) ?? triggers[0] ?? null;

	/** Where focus returns on close: set by the trigger or the shortcut that opened the dialog. */
	let opener: HTMLElement | null = null;
	const remember = (el: HTMLElement | null) => (opener = el);
	const fromTrigger = (t: HTMLElement) => {
		remember(t);
		options.onOpen?.(t);
	};
	const fromShortcut = (returnTo: HTMLElement | null) => {
		remember(returnTo);
		options.onOpen?.(null);
	};

	const events = options.events === false ? null : bindEvents(options.dialog, controller, { delay: options.liveDelay });
	const unbinds = [
		...triggers.map((t) => bindTrigger(t, controller, { keys: t === main ? keys : [], apple, onOpen: fromTrigger })),
		bindShortcut(win, keys, controller, { main, apple, capture: options.capture, onOpen: fromShortcut }),
		bindDialog(options.dialog, options.input, controller, {
			scrollLock: options.scrollLock,
			show: options.show,
			panel: options.dialogPanel,
			returnFocus: () => {
				const el = opener ?? options.takeOpener?.() ?? null;
				opener = null;
				return el;
			},
		}),
		bindCombobox(options.input, options.listbox, controller, options.idFor, { navigate: options.navigate, newTab: options.newTab, onSelect: events?.select }),
		bindLive(options.live, controller, { delay: options.liveDelay }),
	];
	if (events) unbinds.push(events.unbind);
	if (options.tablist) {
		const panel = options.panel ?? options.listbox.closest<HTMLElement>('[role="tabpanel"]');
		unbinds.push(bindTabs(options.tablist, controller, { panel }));
	}
	return () => {
		for (const unbind of unbinds.reverse()) unbind();
	};
}
