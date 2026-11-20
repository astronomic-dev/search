/**
 * A key's own value, never one from Object.prototype: for lookups keyed by a query, a facet or type name, a URL
 * parameter or record data, where "constructor" or "__proto__" would otherwise find a built-in.
 */
export const own = <T>(obj: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);
