/**
 * Element ids for options. A record id can hold any text ("docs/intro#install"), so the HTML id is a readable,
 * sanitized part plus a short FNV-1a hash of the full record id: stable across renders and valid in HTML and CSS
 * selectors. Two record ids that sanitize to the same text get different ids unless their 32-bit hashes also match,
 * which is rare but possible; createIdFor() catches that case and adds a suffix.
 */

/** FNV-1a, 32 bits, in base 36. */
export function hash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

function clean(text: string, max: number): string {
	return text
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max);
}

/** The option element id for `recordId`, under `prefix` (one prefix per search surface on the page). */
export function idFor(prefix: string, recordId: string): string {
	let head = clean(prefix, 24);
	if (!/^[A-Za-z]/.test(head)) head = `s${head ? `-${head}` : ""}`;
	const body = clean(recordId, 32);
	return `${head}-${body ? `${body}-` : ""}${hash(recordId)}`;
}

/**
 * idFor for one search surface, with collisions handled: the first record id keeps the plain id, and a different
 * record id that would get the same id gets "-2", "-3" and so on. The answer for a record id never changes, so the
 * recipe's render and the combobox (which looks options up by id) agree when both use the same function.
 */
export function createIdFor(prefix: string): (recordId: string) => string {
	const byRecord = new Map<string, string>();
	const taken = new Set<string>();
	return (recordId) => {
		const known = byRecord.get(recordId);
		if (known) return known;
		const base = idFor(prefix, recordId);
		let id = base;
		for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
		byRecord.set(recordId, id);
		taken.add(id);
		return id;
	};
}
