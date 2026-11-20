/**
 * The live region: a polite status that reads the result count once typing stops, so a screen reader is not
 * interrupted on every key. Nothing is read while the index loads.
 */
import type { Controller } from "../controller/index.ts";

export interface LiveOptions {
	/** Milliseconds after the last change. Default 600. */
	delay?: number;
}

export function bindLive(region: HTMLElement, controller: Controller, options: LiveOptions = {}): () => void {
	const win = region.ownerDocument.defaultView!;
	const delay = options.delay ?? 600;
	region.setAttribute("role", "status");
	region.setAttribute("aria-live", "polite");
	region.setAttribute("aria-atomic", "true");

	let timer: number | undefined;
	let frame = 0;
	let last = { announce: controller.getState().announce, query: controller.getState().query };

	// Empty first, then the text on the next frame: a screen reader reads a count again even when it is the same.
	const write = () => {
		timer = undefined;
		const s = controller.getState();
		if (s.status === "loading") return;
		region.textContent = "";
		if (!s.announce) return;
		win.cancelAnimationFrame(frame);
		frame = win.requestAnimationFrame(() => {
			frame = 0;
			if (controller.getState().status !== "loading") region.textContent = controller.getState().announce;
		});
	};

	// Typing (or a new count) restarts the wait; moving through the options does not.
	const sync = () => {
		const s = controller.getState();
		if (s.status === "loading") {
			win.cancelAnimationFrame(frame);
			win.clearTimeout(timer);
			timer = undefined;
			return;
		}
		if (s.announce === last.announce && s.query === last.query) return;
		last = { announce: s.announce, query: s.query };
		win.clearTimeout(timer);
		timer = win.setTimeout(write, delay);
	};

	const unsubscribe = controller.subscribe(sync);
	return () => {
		unsubscribe();
		win.clearTimeout(timer);
		win.cancelAnimationFrame(frame);
	};
}
