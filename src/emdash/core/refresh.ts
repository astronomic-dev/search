/**
 * When the index is rebuilt (plan decision 6).
 *
 * - Content hooks only mark: `markDirty` bumps `state.dirty` (EmDash gives a hook 5 s, so a hook never
 *   builds). Only the first change on a clean state queues the one-shot `rebuild-soon` 10 s ahead; later
 *   changes do not move it, so a stream of saves cannot push the build out.
 * - Correctness comes from `dirty`, not from the one-shot (EmDash drops a one-shot queued while it runs):
 *   the recurring `tick` calls `runIfDue`, which builds when `isDue` says so.
 *
 * Platform-free: no `emdash`, `node:*`, `react` or `astro` imports.
 */
import type { PluginOptions, SearchPorts, SearchState } from "./ports.ts";
import { updateState } from "./store.ts";

/** The one-shot `rebuild-soon` runs this long after the first change. */
export const SOON_MS = 10_000;
/** Due this long after the last change... */
export const QUIET_MS = 10_000;
/** ...or this long after the first change, even while changes keep coming. */
export const MAX_WAIT_MS = 60_000;

/** The EmDash content hooks the plugin listens to (`content:<event>`). */
export type ContentEvent = "afterSave" | "afterPublish" | "afterUnpublish" | "afterDelete" | "afterRestore" | "afterSchedule" | "afterUnschedule";

export const CONTENT_EVENTS: readonly ContentEvent[] = ["afterSave", "afterPublish", "afterUnpublish", "afterDelete", "afterRestore", "afterSchedule", "afterUnschedule"];

/** The parts of EmDash's hook events the rules read (`ContentHookEvent`, `ContentStateChangeEvent`, `ContentDeleteEvent`). */
export interface ContentEventPayload {
	collection: string;
	content?: Record<string, unknown>;
	id?: string;
	[key: string]: unknown;
}

/**
 * Whether a hook event can change live content. `afterSave` skips only a new draft: EmDash 1.4 gives no
 * previous status, so a save of an existing entry counts even as a draft (it may have been published and
 * just been saved back to draft). With `collections` listed, changes to
 * other collections (but the ones `listPages` and `excludeWhen` read) do not count; with the default (every search collection), every collection counts, since
 * telling which ones opt in would cost a schema read inside a 5 s hook.
 */
export function countsAsChange(event: ContentEvent, payload: ContentEventPayload, options: PluginOptions = {}): boolean {
	const listed = () =>
		options.listPages?.some((page) => page.from.some((f) => f.collection === payload.collection)) === true ||
		options.excludeWhen?.some((rule) => rule.collection === payload.collection) === true;
	if (options.collections && !options.collections.includes(payload.collection) && !listed()) return false;
	if (event === "afterSave") return payload.content?.status === "published" || payload.isNew !== true;
	return true;
}

/**
 * Bumps `dirty` and sets `lastChangeAt` (and `dirtySince` when it was empty), by `compareAndSet` with
 * up to 5 tries. With `force`, also sets `force` (Rebuild now). Only on the first change since the last
 * build does it queue `rebuild-soon` at now + `SOON_MS`; a queue failure is only logged (the tick builds).
 */
export async function markDirty(p: Pick<SearchPorts, "kv" | "queue" | "now" | "log">, options: { force?: boolean } = {}): Promise<{ state: SearchState; queued: boolean }> {
	const now = p.now();
	let first = false;
	const state = (await updateState(p.kv, (s) => {
		first = s.dirtySince === null;
		return { ...s, dirty: s.dirty + 1, lastChangeAt: now, dirtySince: s.dirtySince ?? now, force: s.force || options.force === true };
	}))!;
	let queued = false;
	if (first) {
		try {
			await p.queue(new Date(now + SOON_MS));
			queued = true;
		} catch (error) {
			p.log.warn("Search: could not queue the rebuild; the next tick builds instead", { error: String(error) });
		}
	}
	return { state, queued };
}

/** The hook rule in one call: marks when the event counts. True when it marked. */
export async function onContentEvent(p: Pick<SearchPorts, "kv" | "queue" | "now" | "log">, event: ContentEvent, payload: ContentEventPayload, options: PluginOptions = {}): Promise<boolean> {
	if (!countsAsChange(event, payload, options)) return false;
	await markDirty(p);
	return true;
}

/** Sets `force` so the next `runIfDue` builds even a clean state (nightly). */
export async function markForce(p: Pick<SearchPorts, "kv">): Promise<void> {
	await updateState(p.kv, (s) => (s.force ? null : { ...s, force: true }));
}

/**
 * Whether a build is due: `force` is set; or the lease is dead (a crashed run is retried); or there is a change (`dirty > builtGen`) and it is either
 * `QUIET_MS` since the last change or `MAX_WAIT_MS` since the first. A site that has never tried a build
 * (no `active`, no `last`) is due too, so the first tick after install builds.
 */
export function isDue(s: SearchState, now: number): boolean {
	if (s.force) return true;
	if (s.lease && s.lease.until <= now) return true; // a dead run (its takeover clears force)
	if (s.active === null && s.last === null) return true;
	if (s.dirty <= s.builtGen) return false;
	if (s.lastChangeAt === null || s.dirtySince === null) return true;
	return now - s.lastChangeAt >= QUIET_MS || now - s.dirtySince >= MAX_WAIT_MS;
}
