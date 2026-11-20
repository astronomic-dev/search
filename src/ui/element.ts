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
import { renderFacets, renderMessage, renderResults, renderShell, renderTabs, seeAllHref, type BrowseLink, type RenderContext, type Shell } from "./render.ts";
import { styleSheet } from "./styles.ts";

export interface ElementConfig {
	/** The index a dialog with no `index` attribute searches. */
	index: string;
	/** Loads one index for this page's language. */
	load: (index: string) => Promise<Searcher>;
	strings?: StringsInput;
	browse?: BrowseLink[];
}

export const TAG = "astronomic-search";
const TRIGGER = "[data-search-trigger]:not([data-search-ui])";

let config: ElementConfig | null = null;

/** The key that pairs a trigger with its dialog: index, types and group. */
export function triggerKey(el: Element, defaultIndex: string): string {
	return [el.getAttribute("data-search-index") || defaultIndex, el.getAttribute("data-search-types") ?? "", el.getAttribute("data-search-group") ?? ""].join("|");
}

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
	#controller: Controller | null = null;
	#shell: Shell | null = null;
	#settings: IndexSettings | null = null;
	#unbind: (() => void) | null = null;
	#unbindTabs: (() => void) | null = null;
	#triggers: HTMLElement[] = [];
	#last: Partial<State> = {};
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

	#render(s: State): void {
		const shell = this.#shell;
		if (!shell) return;
		const last = this.#last;
		const changed = (k: keyof State) => last[k] !== s[k];
		if (!["result", "options", "status", "query", "type", "picks", "recent", "capabilities"].some((k) => changed(k as keyof State))) return;
		this.#last = { ...s };
		const ctx = this.#context();

		if (changed("result") || changed("options") || changed("status")) {
			replace(shell.listbox, renderResults(document, s, ctx));
			shell.listbox.hidden = s.options.length === 0;
		}
		replace(shell.message, [renderMessage(document, s, ctx)].filter((n): n is HTMLElement => n !== null));

		const types = this.#tabTypes();
		const tabs = s.status === "ready" && types.length > 1;
		if (tabs) {
			replace(shell.tablist, renderTabs(document, s, ctx, types));
			if (!this.#unbindTabs) this.#unbindTabs = bindTabs(shell.tablist, this.#controller!, { panel: shell.body });
		}
		shell.tablist.hidden = !tabs;

		const facets = renderFacets(document, s, ctx);
		replace(shell.facets, facets);
		shell.facets.hidden = facets.length === 0;

		const base = this.#triggers[0]?.getAttribute("href") || "/search";
		shell.seeAll.href = seeAllHref(base, s.query.trim(), document.baseURI);
	}
}

/** Registers <astronomic-search> with the site's settings. Safe to call more than once. */
export function defineSearchElement(cfg: ElementConfig): void {
	config = cfg;
	if (!customElements.get(TAG)) customElements.define(TAG, SearchElement);
}
