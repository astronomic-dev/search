/**
 * <astronomic-search>: the default Classic dialog as one custom element with an open shadow root. It builds its
 * controller, renders the shell and results with render.ts, and hands its elements to the dom layer's mountSearch.
 *
 * Attributes: `index` (default: the site's default index), `types` (a comma list of the types it shows), `group`
 * ("type", a facet name or "false"; overrides the index setting for this dialog), `theme` ("light" or "dark";
 * default: the system's).
 *
 * The triggers are the page's [data-search-trigger] links with the same index, types and group, except those with a
 * data-search-ui of their own (another kind of dialog's buttons, the kit's for one).
 */
import { createController, type Controller, type State, type StringsInput } from "../controller/index.ts";
import { own } from "../core/own.ts";
import type { GroupBy, IndexSettings, Searcher } from "../core/types.ts";
import { bindTabs, createIdFor, mountSearch } from "../dom/index.ts";
import { foldLabel, renderFacets, renderMessage, renderResults, renderShell, renderTabs, seeAllLink, type BrowseLink, type RenderContext, type SeeAll, type Shell } from "./render.ts";
import { styleSheet } from "./styles.ts";

export interface ElementConfig {
	/** The index a dialog with no `index` attribute searches. */
	index: string;
	/** Loads one index for this page's language. */
	load: (index: string) => Promise<Searcher>;
	strings?: StringsInput;
	browse?: BrowseLink[];
	/** The results page, for "See all results" when no trigger gives an href. Default "/search". */
	results?: string;
	/** Builds the "See all results" href from the base, the box's query, type and picks, and the index. */
	seeAll?: SeeAll;
}

export const TAG = "astronomic-search";
const TRIGGER = "[data-search-trigger]:not([data-search-ui])";

let config: ElementConfig | null = null;

/** The key that pairs a trigger with its dialog: index, types and group. */
export function triggerKey(el: Element, defaultIndex: string): string {
	return [el.getAttribute("data-search-index") || defaultIndex, el.getAttribute("data-search-types") ?? "", el.getAttribute("data-search-group") ?? ""].join("|");
}

/** The key of the default dialog for `index`: all types, no group (what a trigger with no other attributes gets). */
export const defaultKey = (index: string): string => `${index}||`;

function elementKey(el: Element, defaultIndex: string): string {
	return [el.getAttribute("index") || defaultIndex, el.getAttribute("types") ?? "", el.getAttribute("group") ?? ""].join("|");
}

function parseGroup(value: string | null): GroupBy | null {
	if (value === null || value === "") return null;
	return value === "false" ? false : value;
}

function localStore(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

/** The deepest focused element, through open shadow roots. */
function deepActive(root: Document | ShadowRoot): Element | null {
	let a = root.activeElement;
	while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
	return a;
}

/** Replaces a container's children, keeping focus on the element with the same data-key, if it had it. */
function replace(container: HTMLElement, nodes: Node[]): void {
	const root = container.getRootNode() as ShadowRoot;
	const active = deepActive(root);
	const key = active && container.contains(active) ? active.getAttribute("data-key") : null;
	container.replaceChildren(...nodes);
	if (!key) return;
	for (const el of container.querySelectorAll<HTMLElement>("[data-key]")) {
		if (el.getAttribute("data-key") === key) return el.focus();
	}
}

export class SearchElement extends HTMLElement {
	/** Shortcut keys for this dialog: set on the dialog of the page's main trigger only. */
	keys: string[] = [];
	/**
	 * An explicit opener (an embed's field or link) that focus returns to on close; taken by the next open. Set by the
	 * embed's openFrom only, so it is left out of the published types.
	 * @internal
	 */
	opener: HTMLElement | null = null;
	#controller: Controller | null = null;
	/** The index the controller was made for; "See all results" names it. */
	#searchIndex = "";
	#shell: Shell | null = null;
	#settings: IndexSettings | null = null;
	#unbind: (() => void) | null = null;
	#unbindTabs: (() => void) | null = null;
	#triggers: HTMLElement[] = [];
	#last: Partial<State> = {};
	/** The facets' toggle's name, or null for no toggle. */
	#label: string | null = null;
	/** Whether the facets' panel is open on a narrow screen: UI state only, closed again when the dialog closes. */
	#fold = false;
	/** Option ids for this dialog; render and the combobox share it, so a hash collision gets one suffix for both. */
	#ids: ((recordId: string) => string) | null = null;

	get controller(): Controller {
		this.#setup();
		return this.#controller!;
	}

	/** The triggers this dialog answers. */
	get triggers(): readonly HTMLElement[] {
		return this.#triggers;
	}

	connectedCallback(): void {
		this.#setup();
		this.bind();
	}

	disconnectedCallback(): void {
		this.#unbind?.();
		this.#unbind = null;
	}

	/** Binds (again) to the page's matching triggers, for triggers added after the dialog was made. */
	bind(): void {
		if (!this.isConnected) return;
		this.#unbind?.();
		const cfg = config!;
		const key = elementKey(this, cfg.index);
		this.#triggers = [...document.querySelectorAll<HTMLElement>(TRIGGER)].filter((t) => triggerKey(t, cfg.index) === key);
		const s = this.#shell!;
		this.#unbind = mountSearch({
			trigger: this.#triggers,
			dialog: s.dialog,
			dialogPanel: s.panel,
			input: s.input,
			listbox: s.listbox,
			live: s.live,
			controller: this.#controller!,
			idFor: this.#idFor(),
			keys: this.keys,
			takeOpener: () => {
				const o = this.opener;
				this.opener = null;
				return o;
			},
		});
	}

	#idFor(): (recordId: string) => string {
		return (this.#ids ??= createIdFor(this.#index()));
	}

	#index(): string {
		return this.getAttribute("index") || config!.index;
	}

	#types(): string[] {
		return (this.getAttribute("types") ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	}

	#setup(): void {
		if (this.#controller) return;
		if (!config) throw new Error("Search: call defineSearchElement() before using <astronomic-search>");
		const cfg = config;
		const index = this.#index();
		this.#searchIndex = index;
		const types = this.#types();
		const group = parseGroup(this.getAttribute("group"));

		const controller = createController({
			index,
			types,
			surface: "dialog",
			storage: localStore(),
			strings: cfg.strings,
			load: async () => {
				const searcher = await cfg.load(index);
				this.#settings = searcher.settings;
				if (group === null) return searcher;
				const settings = { ...searcher.settings, group: { ...searcher.settings.group, dialog: group } };
				return { capabilities: searcher.capabilities, settings, locale: searcher.locale, run: (q) => searcher.run(q) };
			},
		});
		this.#controller = controller;

		const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
		shadow.adoptedStyleSheets = [styleSheet()];
		const shell = renderShell(document, this.#context());
		this.#shell = shell;
		shadow.replaceChildren(shell.dialog);

		shell.close.addEventListener("click", () => controller.close());
		shell.toggle.addEventListener("click", () => {
			this.#fold = !this.#fold;
			this.#syncFold();
		});
		// On a narrow screen the tabs, and each facet group when there are two or more, are rows that scroll sideways:
		// keep their edge fades current, and keep the picked tab and chips in view when the rows change size (the
		// facets' toggle shows or widens, the panel opens, a phone rotates). Scroll does not bubble: the facets listen
		// in the capture phase for their groups.
		const edges = () => this.#edges();
		shell.tablist.addEventListener("scroll", edges, { passive: true });
		shell.facets.addEventListener("scroll", edges, { passive: true, capture: true });
		const ro = new ResizeObserver(() => {
			this.#revealTab();
			this.#revealChips();
			edges();
		});
		ro.observe(shell.tablist);
		ro.observe(shell.facets);
		shadow.addEventListener("click", (e) => this.#action(e));
		controller.subscribe((s) => this.#render(s));
		this.#render(controller.getState());
	}

	#context(): RenderContext {
		const cfg = config!;
		const strings = this.#controller!.strings;
		const settings = this.#settings;
		const override = parseGroup(this.getAttribute("group"));
		return {
			strings,
			idFor: this.#idFor(),
			group: override ?? settings?.group.dialog ?? "type",
			typeLabel: (t) => own(settings?.types, t)?.label ?? t,
			facetLabel: (f) => own(settings?.facets, f)?.label ?? f,
			browse: cfg.browse ?? [],
		};
	}

	#action(e: Event): void {
		const target = (e.target as Element | null)?.closest?.("[data-action]");
		if (!target) return;
		const c = this.#controller!;
		const input = this.#shell!.input;
		switch (target.getAttribute("data-action")) {
			case "retry":
				c.retry();
				input.focus();
				break;
			case "all-types":
				c.searchAllTypes();
				input.focus();
				break;
			case "recent":
				c.input(target.getAttribute("data-query") ?? "");
				input.focus();
				break;
			case "facet":
				c.togglePick(target.getAttribute("data-facet") ?? "", target.getAttribute("data-value") ?? "");
				break;
		}
	}

	/** The types the tabs show: this dialog's `types`, else every type of the index. */
	#tabTypes(): string[] {
		const all = Object.keys(this.#settings?.types ?? {});
		const only = this.#types();
		return only.length ? all.filter((t) => only.includes(t)) : all;
	}

	/** The toggle for the facets (it shows on a narrow screen only): its name, the picks' count and open state. */
	#syncFold(): void {
		const { filters, toggle, facets } = this.#shell!;
		const [name, count] = toggle.children as unknown as HTMLElement[];
		const n = facets.querySelectorAll('[aria-pressed="true"]').length;
		name!.textContent = this.#label;
		count!.textContent = String(n);
		count!.hidden = !n;
		toggle.toggleAttribute("data-active", n > 0);
		toggle.setAttribute("aria-expanded", String(this.#fold));
		filters.toggleAttribute("data-fold", this.#label !== null);
		filters.toggleAttribute("data-open", this.#fold);
	}

	/** Scrolls a row sideways to show an item in full, and up to 24px clear of the edge fades where there is room. */
	#reveal(row: Element, item: Element | null | undefined): void {
		if (!item) return;
		// Screen rects, not offsets: scrollLeft moves the same way in either direction (it counts down from 0 right to left).
		const box = row.getBoundingClientRect();
		const at = item.getBoundingClientRect();
		const pad = Math.min(24, Math.max(0, (box.width - at.width) / 2));
		const end = Math.max(0, at.right + pad - box.right);
		row.scrollLeft += at.left - end - pad < box.left ? at.left - pad - box.left : end;
	}

	/** The picked tab into view. By the state's type, not aria-selected: on a render the new tabs are not marked yet. */
	#revealTab(): void {
		const type = this.#controller!.getState().type ?? "";
		this.#reveal(this.#shell!.tablist, [...this.#shell!.tablist.children].find((t) => t.getAttribute("data-type") === type));
	}

	/** Each facet group's focused chip into view (a keyboard pick keeps focus there), else its first picked chip. A
	 * group that wraps has nothing to scroll. */
	#revealChips(): void {
		for (const group of this.#shell!.facets.children)
			this.#reveal(group, group.querySelector(":focus") ?? group.querySelector('[aria-pressed="true"]'));
	}

	/** Marks each sideways row with the edges that hide more of it (data-start, data-end), for the fades. */
	#edges(): void {
		for (const row of [this.#shell!.tablist, ...this.#shell!.facets.children]) {
			const x = Math.abs(row.scrollLeft);
			row.toggleAttribute("data-start", x > 1);
			row.toggleAttribute("data-end", x < row.scrollWidth - row.clientWidth - 1);
		}
	}

	#render(s: State): void {
		const shell = this.#shell;
		if (!shell) return;
		const last = this.#last;
		const changed = (k: keyof State) => last[k] !== s[k];
		if (!["open", "result", "options", "status", "query", "type", "picks", "recent", "capabilities"].some((k) => changed(k as keyof State))) return;
		if (!s.open) this.#fold = false;
		this.#last = { ...s };
		const ctx = this.#context();

		if (changed("result") || changed("options") || changed("status")) {
			replace(shell.listbox, renderResults(document, s, ctx));
			shell.listbox.hidden = s.options.length === 0;
		}
		replace(shell.message, [renderMessage(document, s, ctx)].filter((n): n is HTMLElement => n !== null));

		const types = this.#tabTypes();
		const tabs = s.status === "ready" && types.length > 1;
		const list = shell.tablist;
		const shown = !list.hidden;
		if (tabs) {
			replace(list, renderTabs(document, s, ctx, types));
			if (!this.#unbindTabs) this.#unbindTabs = bindTabs(list, this.#controller!, { panel: shell.body });
		}
		list.hidden = !tabs;

		// The facet groups are rebuilt on each render (a query edit too): each group that stays keeps its sideways scroll,
		// by its label's id (one per facet), so the row does not jump back to its start.
		// A new group has no entry: undefined scrolls it to 0 (a scroll position that is not a number is 0).
		const scrolled: Record<string, number> = {};
		for (const g of shell.facets.children) scrolled[g.getAttribute("aria-labelledby")!] = g.scrollLeft;
		const facets = renderFacets(document, s, ctx);
		replace(shell.facets, facets);
		for (const g of facets) g.scrollLeft = scrolled[g.getAttribute("aria-labelledby")!]!;
		shell.facets.hidden = facets.length === 0;
		this.#label = foldLabel(tabs, facets.map((g) => g.querySelector(".label")!.textContent!), ctx.strings.facetsLabel);
		this.#syncFold();
		// After the toggle's layout: keep the picked tab in view when it changes or the row shows, and picked chips when
		// the picks change.
		if (tabs && (changed("type") || !shown)) this.#revealTab();
		if (changed("picks")) this.#revealChips();
		this.#edges();

		shell.seeAll.href = seeAllLink(config!, this.#triggers[0]?.getAttribute("href"), s, this.#searchIndex, document.baseURI);
	}
}

/** Registers <astronomic-search> with the site's settings. Safe to call more than once. */
export function defineSearchElement(cfg: ElementConfig): void {
	config = cfg;
	if (!customElements.get(TAG)) customElements.define(TAG, SearchElement);
}
