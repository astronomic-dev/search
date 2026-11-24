/**
 * The admin settings (plan decision 9): defaults, the checks on save and read, and the config tag JSON that
 * `page:fragments` prints on each public page. No setting needs a rebuild.
 *
 * Every value is checked, and a bad one takes its default (the embed's own rule, README "The config tag").
 *
 * Platform-free: imports nothing from emdash, node, react or astro.
 */
import type { KvPort, SearchSettings } from "./ports.ts";

/** The KV key. Not `settings:...`: that prefix goes to EmDash's plugin settings store. */
export const SETTINGS_KEY = "settings";

/** Where the embed loads the manifest from (the public `manifest` route). */
export const MANIFEST_PATH = "/_emdash/api/plugins/astronomic-search/manifest";

export const DEFAULT_SETTINGS: SearchSettings = Object.freeze({
	keys: Object.freeze(["mod+k", "/"]) as string[],
	takeover: Object.freeze({ enabled: false, inputName: "q" }),
	placeholder: "Search the site",
	theme: "auto",
	results: "/search",
}) as SearchSettings;

const MAX_KEYS = 2;
const MAX_PLACEHOLDER = 80;
const MAX_URL = 2048;

/** A key spec the embed reads (`src/dom/shortcut.ts`): modifiers joined by "+", then one key. */
const KEY_SPEC = /^(?:(?:ctrl|meta|alt|shift|mod)\+)*(?:[a-z][a-z0-9]{1,19}|[^\s+]|\+)$/;
/** A form control name that is safe in an attribute selector (the embed's own rule). */
const INPUT_NAME = /^(?:[\w-]|\[\])+$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const copy = (s: SearchSettings): SearchSettings => ({ ...s, keys: [...s.keys], takeover: { ...s.takeover } });

function checkKeys(v: unknown): string[] {
	if (!Array.isArray(v) || !v.every((k) => typeof k === "string")) return [...DEFAULT_SETTINGS.keys];
	const keys = v.map((k: string) => k.trim().toLowerCase());
	if (!keys.every((k) => KEY_SPEC.test(k))) return [...DEFAULT_SETTINGS.keys];
	return [...new Set(keys)].slice(0, MAX_KEYS);
}

function checkPlaceholder(v: unknown): string {
	if (typeof v !== "string") return DEFAULT_SETTINGS.placeholder;
	const s = v.trim();
	return s && s.length <= MAX_PLACEHOLDER ? s : DEFAULT_SETTINGS.placeholder;
}

/** A root-relative path ("/..." but not "//" or "/\") or an http(s) URL, with no whitespace or control characters. */
function checkResults(v: unknown): string {
	if (typeof v !== "string" || !v || v.length > MAX_URL || /[\s\u0000-\u001f\u007f]/.test(v)) return DEFAULT_SETTINGS.results;
	if (v.startsWith("/")) return v.startsWith("//") || v.startsWith("/\\") ? DEFAULT_SETTINGS.results : v;
	try {
		return /^https?:$/.test(new URL(v).protocol) ? v : DEFAULT_SETTINGS.results;
	} catch {
		return DEFAULT_SETTINGS.results;
	}
}

/** The settings from any value: each good field kept, each bad or missing one at its default. */
export function checkSettings(input: unknown): SearchSettings {
	const v = isObj(input) ? input : {};
	const t = isObj(v.takeover) ? v.takeover : {};
	return {
		keys: checkKeys(v.keys ?? DEFAULT_SETTINGS.keys),
		takeover: {
			enabled: typeof t.enabled === "boolean" ? t.enabled : DEFAULT_SETTINGS.takeover.enabled,
			inputName: typeof t.inputName === "string" && INPUT_NAME.test(t.inputName) ? t.inputName : DEFAULT_SETTINGS.takeover.inputName,
		},
		placeholder: checkPlaceholder(v.placeholder ?? DEFAULT_SETTINGS.placeholder),
		theme: v.theme === "light" || v.theme === "dark" || v.theme === "auto" ? v.theme : DEFAULT_SETTINGS.theme,
		results: checkResults(v.results ?? DEFAULT_SETTINGS.results),
	};
}

/** The saved settings, checked, with defaults filled in. */
export async function readSettings(kv: KvPort): Promise<SearchSettings> {
	const saved = await kv.get<unknown>(SETTINGS_KEY);
	return saved === null ? copy(DEFAULT_SETTINGS) : checkSettings(saved);
}

/** How many times a save retries when another save wrote first. */
const SAVE_TRIES = 5;

/**
 * Saves `input` over the saved settings (fields left out keep their saved value; `takeover` merges by field),
 * checked, and returns what was stored. A bad value takes its default, not its old value.
 *
 * A versioned read and a compare-and-set: when another save wrote in between, the partial update is merged
 * onto that newer value and tried again, so two saves of different fields both stick.
 */
export async function saveSettings(kv: KvPort, input: Obj): Promise<SearchSettings> {
	for (let i = 0; i < SAVE_TRIES; i++) {
		const current = await kv.getVersioned<unknown>(SETTINGS_KEY);
		const saved = current === null ? copy(DEFAULT_SETTINGS) : checkSettings(current.value);
		const takeover = isObj(input.takeover) ? { ...saved.takeover, ...input.takeover } : saved.takeover;
		const next = checkSettings({ ...saved, ...input, takeover });
		const result = await kv.compareAndSet(SETTINGS_KEY, current?.revision ?? null, next);
		if (result.applied) return next;
	}
	throw new Error("Search: the settings changed too often while saving; try again");
}

/**
 * The config tag's text for the embed (README "The config tag"). `<`, `>`, `&` and the two JavaScript line
 * separators are written as `\u` escapes, so no value can close the `<script>` tag.
 */
export function configJson(settings: SearchSettings): string {
	const config: Obj = {
		manifest: MANIFEST_PATH,
		index: "default",
		results: settings.results,
		queryParam: "q",
		paramPrefix: "",
		keys: settings.keys,
		strings: { placeholder: settings.placeholder },
		takeover: { enabled: settings.takeover.enabled, inputName: settings.takeover.inputName },
	};
	if (settings.theme !== "auto") config.theme = settings.theme;
	return JSON.stringify(config).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
