/**
 * The dialog lifecycle (WAI-ARIA APG modal dialog) on a native <dialog>: it follows the controller's `open`.
 * Open: showModal(), focus to the search box. Close: focus back to the element that opened it. Escape clears the box,
 * then closes. A click on the backdrop closes. The page behind does not scroll while it is open.
 */
import type { Controller } from "../controller/index.ts";
import { activeElementOf } from "./shortcut.ts";

export interface DialogOptions {
	/** Where focus goes on close. Default: the element that had focus when the dialog opened. */
	returnFocus?: () => HTMLElement | null;
	/** Sets overflow: hidden on <html> while open, keeping the scrollbar's space. A kit recipe passes false and opens with the kit's openModal(). */
	scrollLock?: boolean;
	/** How to open the dialog. Default: dialog.showModal(). */
	show?: (dialog: HTMLDialogElement) => void;
	/** The visible panel inside the dialog. A click outside it closes. Default: the dialog box itself. */
	panel?: HTMLElement;
}

function composing(e: KeyboardEvent): boolean {
	return e.isComposing || e.keyCode === 229;
}

function outside(el: Element, x: number, y: number): boolean {
	const r = el.getBoundingClientRect();
	return x < r.left || x > r.right || y < r.top || y > r.bottom;
}

export function bindDialog(dialog: HTMLDialogElement, input: HTMLInputElement, controller: Controller, options: DialogOptions = {}): () => void {
	const doc = dialog.ownerDocument;
	const root = doc.documentElement;
	const scrollLock = options.scrollLock ?? true;
	const show = options.show ?? ((d: HTMLDialogElement) => d.showModal());
	const panel = options.panel ?? dialog;

	const labelled = dialog.hasAttribute("aria-labelledby") || dialog.hasAttribute("aria-label");
	if (!labelled) dialog.setAttribute("aria-label", controller.strings.dialogLabel);

	let wasOpen = false;
	let opener: HTMLElement | null = null;
	/** The inline overflow and scrollbar-gutter on <html> before the lock, put back on unlock; null while unlocked. */
	let saved: { overflow: string; gutter: string } | null = null;
	/** Set while an Escape keydown is handled, so the native cancel that may follow it is not handled twice. */
	let escaped = false;

	// overflow: hidden drops a classic scrollbar (Windows, Linux), which would shift the page sideways. A stable gutter
	// keeps its space, but only when a scrollbar takes space now and the page has not set a gutter of its own.
	const lock = () => {
		if (!scrollLock || saved) return;
		saved = { overflow: root.style.overflow, gutter: root.style.scrollbarGutter };
		const view = doc.defaultView;
		const bar = view ? view.innerWidth - root.clientWidth : 0;
		if (bar > 0 && view?.getComputedStyle(root).scrollbarGutter === "auto") root.style.scrollbarGutter = "stable";
		root.style.overflow = "hidden";
	};
	const unlock = () => {
		if (!saved) return;
		root.style.overflow = saved.overflow;
		root.style.scrollbarGutter = saved.gutter;
		saved = null;
	};

	const sync = () => {
		const open = controller.getState().open;
		if (open === wasOpen) return;
		wasOpen = open;
		if (open) {
			opener = options.returnFocus?.() ?? (activeElementOf(doc) as HTMLElement | null);
			lock();
			if (!dialog.open) show(dialog);
			input.focus();
		} else {
			if (dialog.open) dialog.close();
			unlock();
			const to = opener;
			opener = null;
			if (to && to.isConnected && to !== doc.body) to.focus({ preventScroll: true });
		}
	};

	const onKey = (e: KeyboardEvent) => {
		if (e.key !== "Escape" || composing(e) || e.defaultPrevented) return;
		// The controller decides: clear the box, or close (sync closes the dialog).
		e.preventDefault();
		escaped = true;
		controller.escape();
		setTimeout(() => (escaped = false));
	};
	// A close request with no Escape keydown (a back gesture, or an engine that skips keydown): let it close, unless
	// text is being composed: then the Escape belongs to the input method.
	const onCancel = (e: Event) => {
		if (escaped || controller.getState().composing) e.preventDefault();
	};
	// The dialog closed some other way (a form with method="dialog", dialog.close()): tell the controller. The close
	// event is queued, so it can arrive after the dialog opened again: then it is stale.
	const onClose = () => {
		if (!dialog.open && controller.getState().open) controller.close();
	};
	// A backdrop click: the press started and ended on the dialog itself, outside the panel. A text selection dragged
	// from the box to the backdrop is not a click on the backdrop.
	let downOnBackdrop = false;
	const isBackdrop = (e: MouseEvent) => e.target === dialog && outside(panel, e.clientX, e.clientY);
	const onDown = (e: PointerEvent) => (downOnBackdrop = isBackdrop(e));
	const onClick = (e: MouseEvent) => {
		const hit = downOnBackdrop && isBackdrop(e);
		downOnBackdrop = false;
		if (hit) controller.close();
	};

	sync();
	const unsubscribe = controller.subscribe(sync);
	dialog.addEventListener("keydown", onKey);
	dialog.addEventListener("cancel", onCancel);
	dialog.addEventListener("close", onClose);
	dialog.addEventListener("pointerdown", onDown);
	dialog.addEventListener("click", onClick);
	return () => {
		unsubscribe();
		dialog.removeEventListener("keydown", onKey);
		dialog.removeEventListener("cancel", onCancel);
		dialog.removeEventListener("close", onClose);
		dialog.removeEventListener("pointerdown", onDown);
		dialog.removeEventListener("click", onClick);
		unlock();
		if (!labelled) dialog.removeAttribute("aria-label");
	};
}
