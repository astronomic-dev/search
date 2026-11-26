/**
 * The boot logic every search dialog shares: the package's own boot script calls it, and so can any recipe's
 * script (`@astronomic-dev/search/boot`). Until the app is needed it only listens: hover or focus on a trigger, a plain
 * click or Space on one, and the shortcut. On first use it calls `load()`; a click or shortcut pressed meanwhile is
 * held and replayed once the app has bound the dialog. If the load fails, a held click follows the link.
 *
 * Triggers are scoped by `selector`, so two kinds of dialog on one site never take each other's buttons: the
 * default dialog's triggers have no `data-search-ui`, and a recipe's carry its own (the kit's is "kit"). Use one
 * kind of dialog per page.
 *
 * A client router (Astro's ClientRouter) takes link clicks on the document in the bubbling phase, and is registered
 * first, so it would see a trigger's first click before a bubbling listener here and go to /search. This script holds
 * that click in the capture phase instead, before any bubbling listener. A click with a modifier key or another button
 * is left alone, so it stays a normal link (a new tab or window). A bound trigger (BOUND) is left to its binder, whose
 * listener on the link runs before the router's on the document; a tap on one goes to `touch` first, when there is one.
 */
import { isApple, shortcutAction } from "../dom/shortcut.ts";
import { BOUND } from "../dom/bound.ts";
import type { TouchDraft, TouchOpen } from "./touch.ts";

export { touchOpens, type TouchDraft, type TouchField, type TouchOpen, type TouchView } from "./touch.ts";

/** The default dialog's triggers: every search link without a `data-search-ui` of its own. */
export const DEFAULT_SELECTOR = "[data-search-trigger]:not([data-search-ui])";

export interface BootApp {
	/** Makes and binds the dialog for a trigger, so a replayed click or key opens it. */
	prepare(trigger: HTMLElement, keys: string[]): unknown;
	/**
	 * For a touch open (`touch: touchOpens(view)`): opens the dialog for `trigger`, gives its input the focus, then the
	 * stand-in's text and caret (`draft`), all in this call, and returns whether the input took the focus. False gets no
	 * click after it (the dialog may be open already). Left out: the trigger is clicked instead, as for a mouse (a bound
	 * trigger's click opens the dialog, and the text typed in the stand-in is lost).
	 */
	openTouch?(trigger: HTMLElement, draft: TouchDraft): boolean;
}

export interface BootOptions {
	/** Default '[data-search-trigger]:not([data-search-ui])'. The kit passes '[data-search-trigger][data-search-ui="kit"]'. */
	selector?: string;
	/** The shortcut keys, for example ["mod+k", "/"]; [] for none. */
	keys: string[];
	/** Loads the app on first use; prepare() makes and binds the dialog for a trigger. */
	load: () => Promise<BootApp>;
	/**
	 * Called with the trigger just before each `load()`, to start the index loads alongside the app's (for example
	 * `prefetch` from the controller, for the trigger's `data-search-index`, handed to the app once it is in).
	 */
	preload?: (trigger: HTMLElement) => void;
	/**
	 * How a touch opens: `touchOpens(view)`, with a view that shows a stand-in box like your dialog's field (README, "Build your own dialog").
	 * Left out, a tap opens as a click does, which on an iPhone gives the dialog no keyboard.
	 */
	touch?: TouchOpen;
}

export function startBoot(options: BootOptions): void {
	const { keys, load } = options;
	const selector = options.selector ?? DEFAULT_SELECTOR;
	const doc = document;
	const win = window;
	let loading: Promise<BootApp> | null = null;
	/** Set while a held click is replayed, so this script lets it through. */
	let replaying = false;
	/** A held shortcut press, so a second press while loading does not toggle twice. */
	let held = false;

	const triggerOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>(selector) : null);
	const main = () => doc.querySelector<HTMLElement>(`${selector}[data-search-main]`) ?? doc.querySelector<HTMLElement>(selector);

	function start(trigger: HTMLElement): Promise<BootApp> {
		if (!loading) options.preload?.(trigger);
		loading ??= load().then(
			(app) => {
				// The app's own shortcut listener takes over.
				win.removeEventListener("keydown", onShortcut);
				return app;
			},
			(e: unknown) => {
				loading = null;
				throw e;
			},
		);
		return loading.then((app) => {
			// A route swap while loading removed the trigger: bind the new page's dialog instead.
			const now = trigger.isConnected ? trigger : main();
			if (now) app.prepare(now, keys);
			return app;
		});
	}

	const plain = (e: MouseEvent | KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

	/**
	 * Replays a held press as a click (the app's trigger binder opens the dialog). If a route swap removed the trigger
	 * meanwhile, the press is dropped: a click on the old link would leave the page just reached.
	 */
	function press(trigger: HTMLElement): void {
		if (!trigger.isConnected) return;
		replaying = true;
		try {
			trigger.click();
		} finally {
			replaying = false;
		}
	}

	/** The load failed: a held press follows the link. */
	function follow(trigger: HTMLElement): void {
		if (trigger.isConnected) win.location.assign((trigger as HTMLAnchorElement).href || (trigger.getAttribute("href") ?? ""));
	}

	/** Holds the press, loads the app, then replays it. */
	function hold(e: Event, trigger: HTMLElement): void {
		e.preventDefault();
		start(trigger).then(
			() => press(trigger),
			() => follow(trigger),
		);
	}

	function onShortcut(e: KeyboardEvent): void {
		const m = main();
		if (!m || e.defaultPrevented || !shortcutAction(e, keys, isApple(navigator), false)) return;
		e.preventDefault();
		if (held) return;
		held = true;
		// Replay where the press happened: inside a shadow root, the element there, not its host. If a route swap removed
		// it while loading, replay on the current page's body.
		const origin = e.composedPath()[0] ?? e.target;
		const init: KeyboardEventInit = { key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, bubbles: true, cancelable: true, composed: true };
		start(m).then(
			() => (origin instanceof Node && origin.isConnected ? origin : doc.body).dispatchEvent(new KeyboardEvent("keydown", init)),
			() => {},
		);
		loading?.finally(() => (held = false)).catch(() => {});
	}

	// Capture phase: before a client router's click listener on the document (see above).
	doc.addEventListener(
		"click",
		(e) => {
			const t = triggerOf(e.target);
			// A replayed click is for the app's binder.
			if (!t || replaying || e.defaultPrevented || e.button !== 0 || !plain(e)) return;
			if (
				options.touch?.(
					e,
					t,
					() => start(t),
					() => press(t),
				)
			)
				e.preventDefault();
			// Once bound, the app's trigger binder handles the click and prevents it.
			else if (!t.hasAttribute(BOUND)) hold(e, t);
		},
		true,
	);
	doc.addEventListener("keydown", (e) => {
		const t = triggerOf(e.target);
		if (!t || e.key !== " " || e.defaultPrevented || e.repeat || !plain(e)) return;
		hold(e, t);
	});
	const warm = (e: Event) => {
		const t = triggerOf(e.target);
		if (t) start(t).catch(() => {});
	};
	doc.addEventListener("pointerover", warm);
	doc.addEventListener("focusin", warm);
	win.addEventListener("keydown", onShortcut);
}
