/**
 * The admin's key recorder: a key press as the shortcut spec the runtime matcher (`matchKey` in dom/shortcut.ts)
 * accepts for that same press. The matcher wants every held modifier named, so Shift+K is "shift+k" and Shift+/ is
 * "shift+?". "mod" is the platform's main modifier (Cmd on Apple, Ctrl elsewhere); the other one is named as itself.
 * A press the matcher could never match (Space: its key is " ", which no saved spec can hold) records nothing.
 *
 * The admin bundle uses the real matcher to check, so the two never drift; the embed is not touched.
 */
import { matchKey, type KeyEventLike } from "../../dom/shortcut.ts";

type Press = Pick<KeyEventLike, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & { code?: string };

/** The settings' own spec rule (`KEY_SPEC` in core/settings.ts): a spec the save would reject records nothing. */
const SAVABLE = /^(?:(?:ctrl|meta|alt|shift|mod)\+)*(?:[a-z][a-z0-9]{1,19}|[^\s+]|\+)$/;

/** The spec for a press, or null for a lone modifier or a press no saved spec can match. */
export function specOf(e: Press, apple: boolean): string | null {
	if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return null;
	const mods = [
		(apple ? e.metaKey : e.ctrlKey) && "mod",
		(apple ? e.ctrlKey : e.metaKey) && (apple ? "ctrl" : "meta"),
		e.altKey && "alt",
		e.shiftKey && "shift",
	].filter(Boolean);
	const spec = [...mods, e.key.toLowerCase()].join("+");
	if (!SAVABLE.test(spec)) return null;
	return matchKey({ code: "", ...e, target: null }, spec, apple) ? spec : null;
}
