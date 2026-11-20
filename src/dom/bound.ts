/**
 * The attribute a trigger carries while it is bound (trigger.ts), so the boot script (browser/start.ts) leaves its
 * clicks to the binder. Its own module, so the boot script imports this name and not the binder: a bundler that
 * splits by module would otherwise put the whole binder in the boot chunk.
 */
export const BOUND = "data-search-bound";
