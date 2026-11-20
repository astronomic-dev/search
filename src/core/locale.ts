/**
 * Locale lookup, shared by the build (to map a page's `<html lang>` onto the site's locales) and the browser (to pick
 * the index file for the page). Pure, with no imports, so the browser loader can take it without the core runtime.
 */

/** The tag with its likely script and region filled in ("zh-TW" -> "zh-Hant-TW"), or null for a bad tag. */
function maximize(tag: string): Intl.Locale | null {
	try {
		return new Intl.Locale(tag).maximize();
	} catch {
		return null;
	}
}

/**
 * The closest of `locales` to `lang`, by BCP 47 lookup: the full tag, then drop the last subtag each time
 * ("zh-Hant-TW", "zh-Hant", "zh"). Then the same lookup on the maximized tag ("zh-TW" -> "zh-Hant-TW"). Then a sibling
 * with the same primary subtag, preferring one with the same likely script. Undefined when nothing matches or `lang`
 * is empty. Case is ignored; the result is spelled as in `locales`.
 */
export function matchLocale(lang: string | null | undefined, locales: readonly string[]): string | undefined {
	const want = (lang ?? "").trim();
	if (!want) return undefined;
	const byLower = new Map(locales.map((l) => [l.toLowerCase(), l]));
	const lookup = (tag: string): string | undefined => {
		const parts = tag.toLowerCase().split("-").filter(Boolean);
		for (let n = parts.length; n > 0; n--) {
			const hit = byLower.get(parts.slice(0, n).join("-"));
			if (hit) return hit;
		}
		return undefined;
	};
	const plain = lookup(want);
	if (plain) return plain;
	const max = maximize(want);
	const maxHit = max ? lookup(max.toString()) : undefined;
	if (maxHit) return maxHit;
	const primary = want.toLowerCase().split("-")[0];
	const siblings = locales.filter((l) => l.toLowerCase().split("-")[0] === primary);
	const sameScript = max?.script ? siblings.find((l) => maximize(l)?.script === max.script) : undefined;
	return sameScript ?? siblings[0];
}

/**
 * A record's locale at build time: `lang` mapped onto the site's locales (the configured ones, else the default
 * alone), so "en-US" and "en" give one locale and one id. A language with no match keeps its own tag; no tag is the
 * default.
 */
export function buildLocale(lang: string | null | undefined, defaultLocale: string, locales?: readonly string[]): string {
	const want = (lang ?? "").trim();
	if (!want) return defaultLocale;
	const known = locales && locales.length > 0 ? locales : [defaultLocale];
	return matchLocale(want, known) ?? want;
}
