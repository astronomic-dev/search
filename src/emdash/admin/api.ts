/**
 * The admin page's data layer (plan Task U1): typed calls to the plugin's private routes (plan decision 8) and a
 * status watch that polls while a build is queued or running, and more slowly while a failed build is retried by
 * the cron tick.
 *
 * `apiFetch` from `emdash/plugin-utils` is passed in (it adds the `X-EmDash-Request: 1` header EmDash needs on
 * private routes), so tests use a fake and this file imports nothing at runtime: no React, no emdash.
 *
 * EmDash wraps a private route's value as `{ success: true, data }` and an error as
 * `{ success: false, error: { code, message } }` (`api/error.ts`); `call` unwraps both.
 */
import type { IndexesResponse, RebuildResponse, SearchSettings, StatusResponse } from "../core/ports.ts";

export type { IndexesItem, IndexesResponse, HistoryEntry, SearchSettings } from "../core/ports.ts";

/** The plugin's route URLs (the same as `ROUTE_BASE` in `core/routes.ts`; kept here so the admin bundle stays small). */
export const ADMIN_ROUTE_BASE = "/_emdash/api/plugins/astronomic-search/";

/** Poll gap while a build is queued or running. */
export const POLL_MS = 2_000;
/** Poll gap while a failed build is one the next tick retries by itself (`retrying`). */
export const RETRY_POLL_MS = 15_000;
/** Poll gap after a failed check. */
export const BACKOFF_MS = 30_000;
/** Failed checks in a row before the page says "could not check". */
export const FAILS_BEFORE_COULD_NOT_CHECK = 3;

export type ApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A build status; `errorCode` is any string the server sends (new codes such as `plan-limit` pass through). */
export type AdminStatus = Omit<StatusResponse, "errorCode"> & { errorCode?: string };

/** A rebuild reply; a refused rebuild has `started: false` and the server's `code`. */
export type AdminRebuild = Omit<RebuildResponse, "code" | "status"> & { code?: string; status: AdminStatus };

/** A failed call. `code` is the server's error code, or `network` / `bad-response`. */
export class AdminApiError extends Error {
	readonly code: string;
	/** HTTP status; 0 when the request never got a reply. */
	readonly status: number;
	constructor(code: string, message: string, status: number) {
		super(message);
		this.name = "AdminApiError";
		this.code = code;
		this.status = status;
	}
}

export interface AdminApi {
	indexes(): Promise<IndexesResponse>;
	status(): Promise<AdminStatus>;
	rebuild(): Promise<AdminRebuild>;
	settings(): Promise<SearchSettings>;
	/** Returns the settings as saved, after the server's checks (a bad value takes its default). */
	saveSettings(settings: SearchSettings): Promise<SearchSettings>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const STATES: ReadonlySet<unknown> = new Set(["idle", "queued", "running", "failed"]);
const optional = (v: Record<string, unknown>, key: string, type: "number" | "string" | "boolean") => v[key] === undefined || typeof v[key] === type;

/** True when `v` is a status the page can show: a known `state`, and the other fields of the right type. */
export function isAdminStatus(v: unknown): v is AdminStatus {
	return (
		isRecord(v) &&
		STATES.has(v.state) &&
		optional(v, "pending", "boolean") &&
		optional(v, "pages", "number") &&
		optional(v, "sections", "number") &&
		optional(v, "builtAt", "number") &&
		optional(v, "error", "string") &&
		optional(v, "errorCode", "string")
	);
}

function checkStatus(v: unknown): AdminStatus {
	if (!isAdminStatus(v)) throw new AdminApiError("bad-response", "Unexpected status reply", 200);
	return v;
}

function checkRebuild(v: unknown): AdminRebuild {
	if (!isRecord(v) || typeof v.started !== "boolean") throw new AdminApiError("bad-response", "Unexpected rebuild reply", 200);
	checkStatus(v.status);
	return v as unknown as AdminRebuild;
}

export function createAdminApi(apiFetch: ApiFetch, base: string = ADMIN_ROUTE_BASE): AdminApi {
	async function call<T>(route: string, init?: RequestInit): Promise<T> {
		let res: Response;
		try {
			res = await apiFetch(base + route, init);
		} catch (e) {
			throw new AdminApiError("network", e instanceof Error ? e.message : "Network error", 0);
		}
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			throw new AdminApiError("bad-response", `Unexpected reply (${res.status})`, res.status);
		}
		if (!res.ok || !isRecord(body) || body.success === false) {
			const err = isRecord(body) && isRecord(body.error) ? body.error : {};
			const code = typeof err.code === "string" ? err.code : res.ok ? "bad-response" : "error";
			const message = typeof err.message === "string" ? err.message : `Request failed (${res.status})`;
			throw new AdminApiError(code, message, res.status);
		}
		if (!("data" in body)) throw new AdminApiError("bad-response", "Unexpected reply", res.status);
		return body.data as T;
	}
	const post = (value?: unknown): RequestInit =>
		value === undefined
			? { method: "POST" }
			: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) };

	return {
		indexes: () => call<IndexesResponse>("indexes"),
		status: () => call<unknown>("status").then(checkStatus),
		rebuild: () => call<unknown>("rebuild", post()).then(checkRebuild),
		settings: () => call<SearchSettings>("settings"),
		saveSettings: (settings) => call<SearchSettings>("settings", post(settings)),
	};
}

// ---------------------------------------------------------------------------
// Status watch
// ---------------------------------------------------------------------------

export interface Scheduler {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(id: unknown): void;
}

export interface StatusUpdate {
	/** The last good status (kept through failed checks); null before the first one. */
	status: AdminStatus | null;
	/** True after `FAILS_BEFORE_COULD_NOT_CHECK` failed checks in a row. */
	couldNotCheck: boolean;
	/** Failed checks in a row. */
	failures: number;
	/** The last failure, while `failures > 0`. */
	error?: AdminApiError;
}

export interface StatusWatch {
	/** Check now and poll again while queued, running or retrying (call after Rebuild now). */
	refresh(): void;
	/** Stop for good (call on unmount). */
	stop(): void;
}

export interface WatchOptions {
	scheduler?: Scheduler;
	/** A status already known (from a rebuild reply): shown at once, and the first check waits `POLL_MS`. */
	initial?: AdminStatus;
}

const busy = (s: AdminStatus) => s.state === "queued" || s.state === "running";

/**
 * A failed build the cron tick retries by itself: still `pending` (a `deadline` or `error` leaves the build due), or
 * `no-collections` on a site never built (it retries once a collection opts in). Settled failures wait for a change.
 */
export const retrying = (s: AdminStatus) => s.state === "failed" && (s.pending || (s.errorCode === "no-collections" && s.builtAt === undefined));

/** The next poll gap for a status, or null to stop. */
const nextPoll = (s: AdminStatus): number | null => (busy(s) ? POLL_MS : retrying(s) ? RETRY_POLL_MS : null);

/**
 * Checks `status` now, then every `POLL_MS` while queued or running, and every `RETRY_POLL_MS` while a failed build
 * is `retrying`, so a background recovery shows without a reload (the page then reads the details again: the
 * status's `builtAt` changes). Stops on `idle` or a settled failure. After a failed
 * check it waits `BACKOFF_MS`, and after `FAILS_BEFORE_COULD_NOT_CHECK` in a row it reports `couldNotCheck`
 * (and keeps trying every `BACKOFF_MS` until a check works).
 */
export function watchStatus(api: Pick<AdminApi, "status">, onUpdate: (u: StatusUpdate) => void, options: WatchOptions = {}): StatusWatch {
	const sched: Scheduler = options.scheduler ?? {
		setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
		clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
	};
	let status: AdminStatus | null = null;
	let failures = 0;
	let timer: unknown = null;
	let stopped = false;
	/** Bumped by each check, so a reply that a newer check or `stop` overtook is dropped. */
	let gen = 0;

	const clear = () => {
		if (timer !== null) sched.clearTimeout(timer);
		timer = null;
	};
	const schedule = (ms: number) => {
		clear();
		timer = sched.setTimeout(check, ms);
	};

	/** False once `stop` ran or a newer check started (also from inside `onUpdate`). */
	const current = (mine: number) => !stopped && mine === gen;

	function check(): void {
		timer = null;
		if (stopped) return;
		const mine = ++gen;
		api.status().then(
			(s) => {
				if (!current(mine)) return;
				status = s;
				failures = 0;
				onUpdate({ status, couldNotCheck: false, failures });
				const gap = nextPoll(s);
				if (current(mine) && gap !== null) schedule(gap);
			},
			(e: unknown) => {
				if (!current(mine)) return;
				failures++;
				const error = e instanceof AdminApiError ? e : new AdminApiError("error", e instanceof Error ? e.message : String(e), 0);
				onUpdate({ status, couldNotCheck: failures >= FAILS_BEFORE_COULD_NOT_CHECK, failures, error });
				if (current(mine)) schedule(BACKOFF_MS);
			},
		);
	}

	if (options.initial) {
		status = options.initial;
		onUpdate({ status, couldNotCheck: false, failures: 0 });
		const gap = nextPoll(status);
		if (!stopped && gap !== null) schedule(gap);
	} else {
		check();
	}

	return {
		refresh() {
			if (stopped) return;
			clear();
			check();
		},
		stop() {
			stopped = true;
			clear();
		},
	};
}

// ---------------------------------------------------------------------------
// Page rules (pure, so they run under node --test)
// ---------------------------------------------------------------------------

/**
 * The form after a save resolves: each field still as it was when Save was pressed takes the saved value; a field
 * edited during the save keeps the edit. `dirty` is true when an edit made during the save is not saved yet.
 */
export function mergeSaved(sent: SearchSettings, current: SearchSettings, saved: SearchSettings): { draft: SearchSettings; dirty: boolean } {
	const draft = { ...saved };
	let dirty = false;
	for (const k of Object.keys(current) as (keyof SearchSettings)[]) {
		if (JSON.stringify(current[k]) === JSON.stringify(sent[k])) continue;
		(draft as Record<string, unknown>)[k] = current[k];
		dirty = true;
	}
	return { draft, dirty };
}

/**
 * Whether a status means the shown index details are stale: a build just ended (the last status was busy), the
 * status names a build time other than the one shown (a rebuild with the same counts), or this is the first status
 * and it ended differently from what is shown (the first index read may predate a publish).
 */
export function detailsStale(prev: AdminStatus | null, next: AdminStatus, shown: IndexesResponse[number] | null | undefined): boolean {
	if (busy(next)) return false;
	if (prev && busy(prev)) return true;
	const a = shown?.active;
	// A build the page did not see run (it ended between checks) still shows as a newer build time.
	if (prev) return next.builtAt !== undefined && next.builtAt !== a?.builtAt;
	return !a || next.pages !== a.pages || next.sections !== a.sections || (next.builtAt !== undefined && next.builtAt !== a.builtAt);
}
