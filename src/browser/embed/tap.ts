/**
 * Touch input. WebKit opens the iOS keyboard for focus() only during a user gesture event, and touchend is one (a
 * touch pointerdown is not). So a field opens on the touchend of a stationary tap: one touch point, moved 10 px or
 * less, held 500 ms or less. A scroll that ends on the field is not a tap.
 *
 * The touchend listener is capture-phase and not passive, and it calls preventDefault() on a tap it handles, so the
 * field never takes focus (no page jump, no theme focus styles) and no mouse events or click follow.
 */
const SLOP = 10;
const HOLD = 500;
/** An event this soon after a touchend (its click, a focus its click makes, a submit) comes from that touch. */
const AFTER = 1000;

/**
 * Calls `handler` in the touchend of a stationary tap on an element `matches` returns (it gets the touch's target and
 * returns the element the tap is for, or null). Returns the test for whether an event comes from a touch: it came
 * within 1 s of the last touchend, with no key pressed since.
 */
export function onTap(doc: Document, matches: (target: EventTarget | null) => HTMLElement | null, handler: (el: HTMLElement) => void): (e: Event) => boolean {
	let start: { x: number; y: number; t: number; id: number } | null = null;
	let ended = -Infinity;

	const passive = { capture: true, passive: true };
	doc.addEventListener(
		"touchstart",
		(e) => {
			const t = e.touches[0];
			start = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, t: e.timeStamp, id: t.identifier } : null;
		},
		passive,
	);
	doc.addEventListener(
		"touchmove",
		(e) => {
			const t = start && [...e.touches].find((x) => x.identifier === start!.id);
			if (start && (e.touches.length > 1 || !t || Math.hypot(t.clientX - start.x, t.clientY - start.y) > SLOP)) start = null;
		},
		passive,
	);
	doc.addEventListener(
		"touchend",
		(e) => {
			ended = e.timeStamp;
			const s = start;
			start = null;
			const t = e.changedTouches[0];
			if (!s || !t || e.touches.length || t.identifier !== s.id) return;
			if (Math.hypot(t.clientX - s.x, t.clientY - s.y) > SLOP || e.timeStamp - s.t > HOLD) return;
			const el = matches(e.target);
			if (!el) return;
			e.preventDefault();
			handler(el);
		},
		{ capture: true, passive: false },
	);
	doc.addEventListener("touchcancel", () => (start = null), passive);
	// Keyboard input after a tap (Tab into a field) is not from that touch.
	doc.addEventListener("keydown", () => (ended = -Infinity), passive);
	return (e) => e.timeStamp - ended < AFTER;
}
