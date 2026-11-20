/**
 * The type tabs (WAI-ARIA APG tabs, automatic activation). The recipe renders the tabs: each is role="tab" with
 * data-type set to the type key ("" for all types). One tab stop, on the selected tab; Left, Right, Home and End move
 * and select. Each tab controls the results panel (role="tabpanel", wrapping the listbox), labelled by the selected
 * tab. While the tablist is hidden (no tabs to show, or the error state) the panel is no tabpanel: its role and label
 * go, and come back when the tabs show.
 */
import type { Controller } from "../controller/index.ts";

export interface TabsOptions {
	/** The results panel. Default: none (no aria-controls). */
	panel?: HTMLElement | null;
}

let counter = 0;
function ensureId(el: HTMLElement, base: string): string {
	if (!el.id) el.id = `${base}-${++counter}`;
	return el.id;
}

const typeOf = (tab: Element): string | null => tab.getAttribute("data-type") || null;

export function bindTabs(tablist: HTMLElement, controller: Controller, options: TabsOptions = {}): () => void {
	const win = tablist.ownerDocument.defaultView!;
	const panel = options.panel ?? null;
	tablist.setAttribute("role", "tablist");
	if (!tablist.hasAttribute("aria-label") && !tablist.hasAttribute("aria-labelledby")) {
		tablist.setAttribute("aria-label", controller.strings.typesLabel);
	}
	if (panel) ensureId(panel, "search-panel");

	const tabs = () => [...tablist.querySelectorAll<HTMLElement>('[role="tab"]')];

	const sync = () => {
		const type = controller.getState().type;
		const all = tabs();
		// If no tab matches the type (the tab is not rendered), the first tab keeps the tab stop.
		const selected = all.find((t) => typeOf(t) === type) ?? null;
		for (const tab of all) {
			const on = tab === selected;
			const set = (name: string, value: string) => tab.getAttribute(name) !== value && tab.setAttribute(name, value);
			set("aria-selected", String(on));
			set("tabindex", on || (!selected && tab === all[0]) ? "0" : "-1");
			if (panel) set("aria-controls", panel.id);
		}
		if (!panel) return;
		const shown = !tablist.hidden && all.length > 0;
		if (shown) panel.setAttribute("role", "tabpanel");
		else panel.removeAttribute("role");
		if (shown && selected) panel.setAttribute("aria-labelledby", ensureId(selected, "search-tab"));
		else panel.removeAttribute("aria-labelledby");
	};

	const select = (tab: HTMLElement, focus: boolean) => {
		const type = typeOf(tab);
		controller.setType(type);
		if (!focus) return;
		// The recipe may re-render the tabs on the change: focus the tab for the type once it has.
		const target = () => tabs().find((t) => typeOf(t) === type) ?? null;
		target()?.focus();
		queueMicrotask(() => {
			const t = target();
			if (t && t !== tablist.ownerDocument.activeElement) t.focus();
		});
	};

	const onKey = (e: KeyboardEvent) => {
		const all = tabs();
		const i = all.indexOf((e.target as Element).closest('[role="tab"]') as HTMLElement);
		if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
		const n = all.length;
		let next = -1;
		if (e.key === "ArrowRight") next = (i + 1) % n;
		else if (e.key === "ArrowLeft") next = (i - 1 + n) % n;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = n - 1;
		else return;
		e.preventDefault();
		select(all[next]!, true);
	};
	const onClick = (e: MouseEvent) => {
		const tab = (e.target as Element).closest<HTMLElement>('[role="tab"]');
		if (!tab || !tablist.contains(tab)) return;
		e.preventDefault();
		select(tab, false);
	};

	sync();
	const unsubscribe = controller.subscribe(sync);
	const observer = new win.MutationObserver(() => sync());
	observer.observe(tablist, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
	tablist.addEventListener("keydown", onKey);
	tablist.addEventListener("click", onClick);
	return () => {
		unsubscribe();
		observer.disconnect();
		tablist.removeEventListener("keydown", onKey);
		tablist.removeEventListener("click", onClick);
	};
}
