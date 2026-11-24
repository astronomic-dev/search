/**
 * The `state` record, the build lease and the chunked index store (plan decision 5).
 *
 * - `state` is one small versioned record, written only by `compareAndSet` on its revision.
 * - An index file is split into `chunk:<runId>:<locale>:<n>` keys, each at most `CHUNK_MAX_BYTES` of
 *   stored JSON. Chunk keys are per run, so two runs never touch each other's chunks.
 * - `publish` writes `state` once, after every chunk is in, and only while the run holds the lease.
 * - Old runs go into `state.retired`; `cleanUp` deletes their chunks, then drops them from `retired`.
 *
 * Platform-free: imports nothing from emdash, node, react or astro.
 */
import type { ActiveIndex, HistoryEntry, KvPort, RetiredRun, SearchState } from "./ports.ts";

export const STATE_KEY = "state";
/** A chunk's stored JSON (`JSON.stringify(slice)` in UTF-8) is at most this, under D1's 2,000,000-byte row. */
export const CHUNK_MAX_BYTES = 1_500_000;
/** Each locale's index JSON is capped here, because EmDash rejects a route body over 8 MiB. */
export const MAX_INDEX_BYTES = 8_000_000;
/** A lease is dead this long after it was taken. */
export const LEASE_MS = 3 * 60_000;
/** Builds kept in `state.history`. */
export const HISTORY_LENGTH = 10;
/** `compareAndSet` tries before `updateState` gives up. */
const STATE_TRIES = 5;
/** `publish` tries on a conflict (a hook bumping `dirty` meanwhile). */
const PUBLISH_TRIES = 10;

const encoder = new TextEncoder();
const utf8Bytes = (s: string) => encoder.encode(s).byteLength;

export function chunkKey(runId: string, locale: string, n: number): string {
	return `chunk:${runId}:${locale}:${n}`;
}

export function emptyState(): SearchState {
	return {
		dirty: 0,
		builtGen: 0,
		lastChangeAt: null,
		dirtySince: null,
		force: false,
		lease: null,
		active: null,
		retired: [],
		last: null,
		history: [],
		interrupted: 0,
	};
}

/** Fills fields a stored state might lack, so a read never trips on a missing one. */
function normalize(value: Partial<SearchState> | null | undefined): SearchState {
	const s = { ...emptyState(), ...(value ?? {}) };
	if (!Array.isArray(s.retired)) s.retired = [];
	if (!Array.isArray(s.history)) s.history = [];
	if (typeof s.interrupted !== "number" || !Number.isFinite(s.interrupted)) s.interrupted = 0;
	return s;
}

export async function readState(kv: KvPort): Promise<{ state: SearchState; revision: string | null }> {
	const row = await kv.getVersioned<SearchState>(STATE_KEY);
	if (!row) return { state: emptyState(), revision: null };
	return { state: normalize(row.value), revision: row.revision };
}

/**
 * Reads `state`, applies `fn` and writes the result by `compareAndSet`, retrying on a conflict.
 * `fn` returns null for no change (then nothing is written and this returns null). Throws when every
 * try conflicts, or when the host throws.
 */
export async function updateState(kv: KvPort, fn: (s: SearchState) => SearchState | null, tries = STATE_TRIES): Promise<SearchState | null> {
	for (let i = 0; i < tries; i++) {
		const { state, revision } = await readState(kv);
		const next = fn(state);
		if (next === null) return null;
		const result = await kv.compareAndSet(STATE_KEY, revision, next);
		if (result.applied) return next;
	}
	throw new Error(`search: the state record kept changing (${tries} tries)`);
}

function newRunId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * `state.retired` with the lease's run added (unless it is already there), with the chunk counts the
 * run recorded by `planChunks`, or `locales: null` (probe) if it recorded none.
 */
export function retireLease(s: SearchState): RetiredRun[] {
	const lease = s.lease;
	if (!lease || s.retired.some((r) => r.runId === lease.runId)) return s.retired;
	return [...s.retired, { runId: lease.runId, locales: lease.locales ? { ...lease.locales } : null }];
}

/** What `takeLease` took. */
export interface TakenLease {
	runId: string;
	/** The `dirty` value this build covers. */
	gen: number;
	/** `force` was set (nightly or Rebuild now) when the lease was taken. */
	forced: boolean;
	/** `state.interrupted` after this take. */
	interrupted: number;
	/** Set when this take found a dead lease whose run never recorded a result: that run's `gen`. */
	interruptedGen?: number;
}

/**
 * Takes the build lease for `LEASE_MS`. Null while another live lease is held. A dead lease is taken
 * over, and its run goes into `retired` (see `retireLease`), so `cleanUp` deletes its chunks. A dead
 * lease whose run never recorded a result (no publish, no recorded failure: the Worker was killed)
 * counts one more interrupted run in `state.interrupted`.
 * In the same write it clears `force` and returns `gen`, the `dirty` value this build covers.
 *
 * With `read` (the `state` and revision the caller decided on), it writes once, on that revision only, and
 * returns `"stale"` when `state` changed since: the caller's decision may no longer hold (another run published).
 * Without it, it re-reads and retries on a conflict.
 */
export async function takeLease(kv: KvPort, now: number): Promise<TakenLease | null>;
export async function takeLease(kv: KvPort, now: number, read: { state: SearchState; revision: string | null }): Promise<TakenLease | null | "stale">;
export async function takeLease(kv: KvPort, now: number, read?: { state: SearchState; revision: string | null }): Promise<TakenLease | null | "stale"> {
	const runId = newRunId();
	let taken: TakenLease | null = null;
	const take = (s: SearchState): SearchState | null => {
		if (s.lease && s.lease.until > now) return null;
		const dead = s.lease && !s.lease.recorded ? s.lease : null;
		const interrupted = dead ? s.interrupted + 1 : s.interrupted;
		taken = { runId, gen: s.dirty, forced: s.force, interrupted, ...(dead ? { interruptedGen: dead.gen ?? s.dirty } : {}) };
		return { ...s, lease: { runId, until: now + LEASE_MS, gen: s.dirty }, force: false, retired: retireLease(s), interrupted };
	};
	if (read) {
		const next = take(read.state);
		if (!next) return null;
		return (await kv.compareAndSet(STATE_KEY, read.revision, next)).applied ? taken : "stale";
	}
	const next = await updateState(kv, take);
	return next ? taken : null;
}

/**
 * Records in the lease the chunk count of each locale this run is about to write, so a crash at any
 * point leaves every key it may have written known to `cleanUp`. False when the lease is not this run's.
 */
export async function planChunks(kv: KvPort, runId: string, locales: Record<string, number>): Promise<boolean> {
	const next = await updateState(kv, (s) => (s.lease?.runId === runId ? { ...s, lease: { ...s.lease, locales: { ...locales } } } : null));
	return next !== null;
}

/** JSON-escaped UTF-8 size of each code unit (pairs are measured on the high half; see `splitChunks`). */
function unitCost(c: number): number {
	if (c === 0x22 || c === 0x5c) return 2;
	if (c < 0x20) return c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d ? 2 : 6;
	if (c < 0x80) return 1;
	if (c < 0x800) return 2;
	return 3;
}

/**
 * Splits `json` into slices whose stored form, `JSON.stringify(slice)` in UTF-8, is at most `maxBytes`.
 * Measures the escaped size (quotes and backslashes double, control characters grow) and never cuts a
 * surrogate pair. Joining the slices gives `json` back.
 */
export function splitChunks(json: string, maxBytes = CHUNK_MAX_BYTES): string[] {
	const budget = maxBytes - 2; // the two quotes around the stored string
	if (budget < 6) throw new RangeError("search: chunk size too small");
	const out: string[] = [];
	let start = 0;
	let size = 0;
	let i = 0;
	while (i < json.length) {
		const c = json.charCodeAt(i);
		let width = 1;
		let cost: number;
		if (c >= 0xd800 && c <= 0xdbff) {
			const d = i + 1 < json.length ? json.charCodeAt(i + 1) : 0;
			if (d >= 0xdc00 && d <= 0xdfff) {
				width = 2;
				cost = 4;
			} else cost = 6; // a lone surrogate is stored as \uXXXX
		} else if (c >= 0xdc00 && c <= 0xdfff) cost = 6;
		else cost = unitCost(c);
		if (size + cost > budget) {
			out.push(json.slice(start, i));
			start = i;
			size = 0;
		}
		size += cost;
		i += width;
	}
	out.push(json.slice(start));
	return out;
}

export interface WriteChunksOptions {
	/** Runs before each chunk write; a throw (a deadline, say) stops the write. */
	beforeWrite?: () => void;
}

/**
 * Writes one locale's index file as chunks of this run and returns the chunk count. Refuses a file over
 * `MAX_INDEX_BYTES` before writing anything. On any error it deletes the chunks it wrote, then rethrows.
 */
export async function writeChunks(kv: KvPort, runId: string, locale: string, json: string, options: WriteChunksOptions = {}): Promise<number> {
	const size = utf8Bytes(json);
	if (size > MAX_INDEX_BYTES) {
		throw new RangeError(`search: the "${locale}" index is too large (${size} bytes, over ${MAX_INDEX_BYTES})`);
	}
	const slices = splitChunks(json);
	let written = 0;
	try {
		for (const slice of slices) {
			options.beforeWrite?.();
			await kv.set(chunkKey(runId, locale, written), slice);
			written += 1;
		}
	} catch (error) {
		// Also the chunk whose write threw: it may have landed.
		await deleteChunks(kv, runId, { [locale]: written + 1 }).catch(() => {});
		throw error;
	}
	return slices.length;
}

/**
 * Deletes a run's chunks. With counts, deletes `0..count-1` of each locale. With `null` (count unknown),
 * probes `0, 1, ...` until a delete finds nothing, for each locale in `probeLocales`.
 */
export async function deleteChunks(kv: KvPort, runId: string, locales: Record<string, number> | null, probeLocales: Iterable<string> = []): Promise<void> {
	if (locales) {
		for (const [locale, count] of Object.entries(locales)) {
			for (let n = 0; n < count; n++) await kv.delete(chunkKey(runId, locale, n));
		}
		return;
	}
	for (const locale of new Set(probeLocales)) {
		for (let n = 0; await kv.delete(chunkKey(runId, locale, n)); n++);
	}
}

export function chunkCounts(active: ActiveIndex): Record<string, number> {
	return Object.fromEntries(Object.entries(active.locales).map(([locale, file]) => [locale, file.chunks]));
}

/** An index's size: its largest locale file, gzip and raw (the budget is per locale file). */
export function largestFile(active: ActiveIndex): { gzBytes: number; rawBytes: number } {
	const files = Object.values(active.locales);
	return { gzBytes: Math.max(0, ...files.map((f) => f.gzBytes)), rawBytes: Math.max(0, ...files.map((f) => f.rawBytes)) };
}

function historyEntry(active: ActiveIndex): HistoryEntry {
	return { builtAt: active.builtAt, ...largestFile(active), pages: active.pages, sections: active.sections };
}

/**
 * Publishes this run's index: one `compareAndSet` of `state` that still holds this run's lease, sets
 * `active`, moves the old `active` into `retired`, sets `builtGen` to `gen`, records `last` and
 * `history`, and frees the lease. A conflict (a hook bumped `dirty`) retries. Then it runs `cleanUp`
 * (best effort: a failure leaves the retired runs for the next build).
 *
 * - The lease is gone, or past its `until` by `now()` on this try: deletes this run's chunks and
 *   returns `"lost-lease"`.
 * - The write throws (unclear): re-reads `state`; this run in `active` means it landed. Otherwise it
 *   rethrows and deletes nothing: the write may still land. The caller frees the lease (which retires
 *   the run, and moves the revision on so a late write cannot apply), or the lease expires and a
 *   takeover retires it.
 */
export async function publish(kv: KvPort, runId: string, gen: number, active: ActiveIndex, now: () => number): Promise<"published" | "lost-lease"> {
	if (active.runId !== runId) throw new Error("search: publish got an index from another run");
	const own = chunkCounts(active);
	// Same bytes as the live index: keep its run (a reader of the old state still finds its chunks) and
	// retire this run instead, so an unchanged rebuild never 404s a live version.
	const landed = (s: SearchState) => s.active?.runId === runId || (s.active?.version === active.version && s.active.builtAt === active.builtAt && s.lease?.runId !== runId);
	for (let i = 0; i < PUBLISH_TRIES; i++) {
		const { state, revision } = await readState(kv);
		if (landed(state)) return finish(kv);
		if (state.lease?.runId !== runId || state.lease.until <= now()) {
			await deleteChunks(kv, runId, own);
			return "lost-lease";
		}
		const same = state.active?.version === active.version ? state.active : null;
		const retired: RetiredRun[] = same ? [...state.retired, { runId, locales: own }] : state.active ? [...state.retired, { runId: state.active.runId, locales: chunkCounts(state.active) }] : state.retired;
		const next: SearchState = {
			...state,
			active: same ? { ...active, runId: same.runId, locales: same.locales } : active,
			retired,
			builtGen: gen,
			dirtySince: state.dirty > gen ? state.dirtySince : null,
			lease: null,
			interrupted: 0,
			last: { ok: true, at: active.builtAt },
			history: [...state.history, historyEntry(active)].slice(-HISTORY_LENGTH),
		};
		let applied: boolean;
		try {
			applied = (await kv.compareAndSet(STATE_KEY, revision, next)).applied;
		} catch (error) {
			const after = await readState(kv); // a throw here rethrows too
			if (landed(after.state)) return finish(kv);
			throw error; // no deleting on a guess: the write may still land
		}
		if (applied) return finish(kv);
	}
	// Every try conflicted and none applied, so the chunks are unused.
	await deleteChunks(kv, runId, own);
	throw new Error(`search: the state record kept changing during publish (${PUBLISH_TRIES} tries)`);
}

async function finish(kv: KvPort): Promise<"published"> {
	await cleanUp(kv).catch(() => {});
	return "published";
}

/**
 * Reads the active index file of a locale. Null (a 404) when `version` is not the active one, the
 * locale has no file, or a chunk is gone (clean-up ran after the caller read `state`).
 */
export async function readIndex(kv: KvPort, state: SearchState, version: string, locale: string): Promise<string | null> {
	const active = state.active;
	if (!active || active.version !== version) return null;
	const file = active.locales[locale];
	if (!file) return null;
	const parts: string[] = [];
	for (let n = 0; n < file.chunks; n++) {
		const part = await kv.get<string>(chunkKey(active.runId, locale, n));
		if (typeof part !== "string") return null;
		parts.push(part);
	}
	return parts.join("");
}

/**
 * Deletes the chunks of every retired run, then drops those runs from `retired` (one `compareAndSet`).
 * A run whose chunk count is unknown is probed in every locale `state` knows of (the active index's and
 * the other retired runs'). A run whose delete throws stays in `retired` for the next build.
 */
export async function cleanUp(kv: KvPort): Promise<void> {
	const { state } = await readState(kv);
	if (state.retired.length === 0) return;
	const locales = new Set<string>(Object.keys(state.active?.locales ?? {}));
	for (const run of state.retired) for (const locale of Object.keys(run.locales ?? {})) locales.add(locale);
	const done = new Set<string>();
	for (const run of state.retired) {
		if (run.runId === state.active?.runId || run.runId === state.lease?.runId) continue;
		try {
			await deleteChunks(kv, run.runId, run.locales, locales);
			done.add(run.runId);
		} catch {
			// Left in `retired`; the next build tries again.
		}
	}
	if (done.size === 0) return;
	await updateState(kv, (s) => {
		const retired = s.retired.filter((r) => !done.has(r.runId));
		return retired.length === s.retired.length ? null : { ...s, retired };
	});
}
