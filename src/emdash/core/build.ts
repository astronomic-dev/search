/**
 * The build (plan decisions 5, 6 and 14): `runIfDue` takes the lease, collects the records, builds one
 * index file per locale with the engine, measures it, stores it in chunks and publishes.
 *
 * - Every chunk write, and the publish, is preceded by a deadline check (`BUILD_DEADLINE_MS` from the start). Past it the
 *   run stops, deletes its chunks and leaves its lease to expire, so the next tick retries.
 * - Each locale's file is measured before any chunk is written; one over `MAX_INDEX_BYTES` fails the
 *   build with `too-large`, and the active index stays.
 * - A change that comes in during the build leaves `dirty > builtGen`, so the next tick builds again.
 * - A failure whose text is a Cloudflare plan limit (`PLAN_LIMIT_ERRORS`) records `plan-limit`
 *   (decision 17: the plugin needs the Workers Paid plan); the active index stays.
 * - A run killed before it records anything (a CPU-limit kill, or a D1 query limit that also fails the
 *   failure write) leaves only a dead lease. `takeLease` counts each such takeover in `state.interrupted`;
 *   at `INTERRUPTED_LIMIT` in a row the takeover settles with `interrupted` instead of building again
 *   (unless `force` is set). Any run that records a result resets the count.
 * - `too-large`, `no-collections`, `plan-limit` and `interrupted` are settled failures: retrying gives the same answer,
 *   so they set `builtGen` and wait for the next change, the nightly run or Rebuild now. `deadline` and
 *   `error` stay due and the next tick retries. `no-collections` on a site never built retries by itself once a
 *   collection opts in (`retryDue`; a template's seed adds its collections without content hooks).
 * - The index holds paths only (`entryPath` in paths.ts builds them from the listed rows), so a build needs no
 *   site URL. EmDash's site URL, when set, is kept on the index only for the admin's "Built for" line.
 * - The lease is taken by one `compareAndSet` on the `state` revision the due check read (`takeLease` with `read`):
 *   a run that another worker overtook (it built and published meanwhile) reads `state` again and decides again,
 *   so a stale decision never builds. The collection list a `no-collections` retry check read is reused by the build.
 *
 * `state` and chunks are touched only through `store.ts`. Platform-free: `crypto.subtle` for the hash
 * and `CompressionStream` for the gzip size; no `emdash`, `node:*`, `react` or `astro` imports.
 */
import { DEFAULT_BUDGET_KB, checkClip, indexSettings, type IndexShape } from "../../core/index-settings.ts";
import { DEFAULT_WEIGHTS, minisearchEngine } from "../../core/minisearch.ts";
import { capKeywords } from "../../core/schema.ts";
import type { EngineFactory, SearchRecord } from "../../core/types.ts";
import { indexDefaultLocale } from "./paths.ts";
import type { ActiveIndex, BuildErrorCode, BuildResult, LocaleIndex, PluginOptions, RunReason, SearchPorts, SearchState } from "./ports.ts";
import { collectRecords, searchCollections } from "./records.ts";
import { markDirty, markForce, isDue } from "./refresh.ts";
import { MAX_INDEX_BYTES, chunkCounts, cleanUp, deleteChunks, planChunks, publish, readState, retireLease, splitChunks, takeLease, updateState, writeChunks } from "./store.ts";

/** A run stops before a chunk write past this long from its start (under the 150 s cron hook timeout). */
export const BUILD_DEADLINE_MS = 2 * 60_000;
/** The one index the plugin builds. */
export const INDEX_NAME = "default";
/** At this many page records the site is past the size this engine is made for (`switchToPagefindAt`). */
export const SWITCH_ENGINE_AT = 5000;

const SETTLED: ReadonlySet<BuildErrorCode> = new Set(["too-large", "no-collections", "plan-limit", "interrupted"]);

/** Interrupted runs in a row (killed before they recorded a result) before the build settles with `interrupted`. */
export const INTERRUPTED_LIMIT = 2;
/** `last.error` of an `interrupted` build. */
export const INTERRUPTED_MESSAGE = `The search build stopped before it finished ${INTERRUPTED_LIMIT} times in a row, most likely at a Cloudflare plan limit (D1 queries or CPU time). On Cloudflare, the plugin needs the Workers Paid plan. The old index stays live.`;

/**
 * Cloudflare's texts for a run over a plan limit (decision 17). Matched case-insensitively against the
 * thrown message; a match records `plan-limit` instead of `error`.
 * - D1 queries per Worker run (50 Free, 1,000 Paid): "Too many API requests by single Worker invocation"
 *   (developers.cloudflare.com/d1/platform/limits/, Batch limits note).
 * - Worker CPU time: error 1102 "Worker exceeded resource limits" (developers.cloudflare.com/workers/platform/limits/),
 *   listed as "Worker exceeded CPU time limit." and "Exceeded CPU Time Limits"
 *   (developers.cloudflare.com/workers/observability/errors/).
 */
export const PLAN_LIMIT_ERRORS: readonly RegExp[] = [
	/too many api requests by single worker invocation/i,
	/worker exceeded (?:cpu time|resource) limits?/i,
	/exceeded cpu time limits?/i,
];

/** True when `message` is one of Cloudflare's plan-limit texts. */
export function isPlanLimit(message: string): boolean {
	return PLAN_LIMIT_ERRORS.some((re) => re.test(message));
}

/** `runIfDue` tries this many times when `state` changes between its due check and the lease write. */
const LEASE_TRIES = 5;

/** The search collections, as `searchCollections` gives them; read once per run. */
type Found = Awaited<ReturnType<typeof searchCollections>>;

/**
 * Whether a settled failure can now give another answer, so the run tries again though `isDue` says no:
 * `no-collections` on a site never built (no index, no history) once a collection opts into search. Costs one
 * read only while in that failure. Returns the collections it read (the build reuses them), or null.
 */
export async function retryDue(p: SearchPorts, o: PluginOptions, s: SearchState): Promise<Found | null> {
	const last = s.last;
	if (!last || last.ok) return null;
	if (last.errorCode === "no-collections" && s.active === null && s.history.length === 0) {
		const found = await searchCollections(p.schema, o);
		return found.collections.length > 0 ? found : null;
	}
	return null;
}

class BuildFailure extends Error {
	readonly code: BuildErrorCode;
	constructor(code: BuildErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

const encoder = new TextEncoder();

async function hash10(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

async function gzipSize(bytes: Uint8Array): Promise<number> {
	const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip")).getReader();
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return size;
		size += value.byteLength;
	}
}

/** The engine settings shape: the package defaults, with the collections as types and `clip` if set. */
function indexShape(types: Record<string, { label: string }>, options: PluginOptions): IndexShape {
	return {
		weights: { ...DEFAULT_WEIGHTS },
		group: { dialog: "type", page: false },
		groupOrder: "best",
		...(options.clip !== undefined ? { clip: checkClip("search()", options.clip) } : {}),
		types,
		typeOverrides: {},
		facets: {},
	};
}

/** Drops records whose id (locale + URL) another record already has, keeping the first. */
function dedupe(records: SearchRecord[], warnings: string[]): SearchRecord[] {
	const seen = new Set<string>();
	const out: SearchRecord[] = [];
	for (const r of records) {
		if (seen.has(r.id)) {
			warnings.push(`Search: two entries have the same URL (${r.url}); only the first is indexed`);
			continue;
		}
		seen.add(r.id);
		out.push(r);
	}
	return out;
}

interface BuiltFile {
	locale: string;
	json: string;
	file: Omit<LocaleIndex, "chunks">;
}

/**
 * Builds the files of every locale (the default locale always has one) and measures them. Throws
 * `too-large` before anything is stored when a file is over `MAX_INDEX_BYTES`.
 */
async function buildFiles(byLocale: Record<string, SearchRecord[]>, defaultLocale: string, shape: IndexShape, engine: EngineFactory): Promise<BuiltFile[]> {
	const locales = [...new Set([defaultLocale, ...Object.keys(byLocale)])].sort();
	const out: BuiltFile[] = [];
	for (const locale of locales) {
		const records = byLocale[locale] ?? [];
		const json = JSON.stringify(engine.build(INDEX_NAME, locale, records, indexSettings(shape, records)));
		const bytes = encoder.encode(json);
		if (bytes.byteLength > MAX_INDEX_BYTES) {
			const over = bytes.byteLength - MAX_INDEX_BYTES;
			throw new BuildFailure("too-large", `The "${locale}" index is ${bytes.byteLength} bytes, ${over} bytes over the ${MAX_INDEX_BYTES}-byte cap. Index fewer collections or set a smaller clip.`);
		}
		out.push({ locale, json, file: { etag: `"${await hash10(bytes)}"`, gzBytes: await gzipSize(bytes), rawBytes: bytes.byteLength } });
	}
	return out;
}

/**
 * Records a failed run in `last` while this run still holds the lease. Unless `keepLease`, frees the
 * lease and retires the run (its chunks go to `cleanUp`). True when it freed the lease.
 */
async function recordFailure(p: SearchPorts, runId: string, gen: number, code: BuildErrorCode, error: string, keepLease: boolean): Promise<boolean> {
	const at = p.now();
	try {
		const done = await updateState(p.kv, (s) => {
			if (s.lease?.runId !== runId) return null;
			// A recorded result ends the interrupted streak; `interrupted` itself keeps it, so the next one settles at once.
			const next = { ...s, last: { ok: false, at, error, errorCode: code }, interrupted: code === "interrupted" ? s.interrupted : 0 };
			if (keepLease) {
				next.lease = { ...s.lease!, recorded: true };
			} else {
				next.retired = retireLease(s);
				next.lease = null;
				// Nothing opts into search any more: take the old index down too (public routes then 503/404).
				if (code === "no-collections" && s.active) {
					next.retired = [...next.retired, { runId: s.active.runId, locales: chunkCounts(s.active) }];
					next.active = null;
				}
			}
			if (SETTLED.has(code)) {
				next.builtGen = Math.max(s.builtGen, gen);
				next.dirtySince = s.dirty > gen ? s.dirtySince : null;
			}
			return next;
		});
		return done !== null && !keepLease;
	} catch (e) {
		p.log.error("Search: could not record the failed build", { error: String(e) });
		return false;
	}
}

/** One build under a held lease. */
async function build(p: SearchPorts, o: PluginOptions, runId: string, gen: number, start: number, found?: Found): Promise<BuildResult> {
	const written: Record<string, number> = {};
	let publishing = false;
	const beforeWrite = () => {
		if (p.now() - start > BUILD_DEADLINE_MS) throw new BuildFailure("deadline", `Search: the build ran past ${BUILD_DEADLINE_MS / 1000} s; the next tick retries`);
	};
	try {
		const collected = await collectRecords(p, o, found);
		const warnings = [...collected.warnings];
		if (Object.keys(collected.types).length === 0) throw new BuildFailure("no-collections", "No collection is set up for search");

		const byLocale: Record<string, SearchRecord[]> = {};
		let pages = 0;
		let sections = 0;
		let records = 0;
		for (const [locale, list] of Object.entries(collected.byLocale)) {
			const sourced = dedupe(list, warnings).map((record) => ({ record, origin: `EmDash ${record.type}` }));
			warnings.push(...capKeywords(sourced));
			byLocale[locale] = sourced.map((s) => s.record);
			for (const r of byLocale[locale]) {
				records++;
				if (r.kind === "page") pages++;
				else if (r.kind === "heading") sections++;
			}
		}

		const shape = indexShape(collected.types, o);
		const files = await buildFiles(byLocale, indexDefaultLocale(p.content), shape, minisearchEngine);

		const planned = Object.fromEntries(files.map((f) => [f.locale, splitChunks(f.json).length]));
		if (!(await planChunks(p.kv, runId, planned))) {
			p.log.warn("Search: another build took over; this one did not publish");
			return { ok: false, code: "lost-lease" };
		}

		const locales: Record<string, LocaleIndex> = {};
		for (const f of files) {
			beforeWrite();
			written[f.locale] = 0;
			const chunks = await writeChunks(p.kv, runId, f.locale, f.json, { beforeWrite });
			written[f.locale] = chunks;
			locales[f.locale] = { chunks, ...f.file };
		}
		const version = await hash10(encoder.encode(files.map((f) => f.file.etag).sort().join(",")));
		beforeWrite(); // a stall in the last chunk write or the hash is past the deadline too
		const siteUrl = p.content.siteUrl();
		const active: ActiveIndex = { runId, version, builtAt: p.now(), locales, pages, sections, records, skipped: collected.skipped, ...(siteUrl ? { siteUrl } : {}) };

		publishing = true;
		if ((await publish(p.kv, runId, gen, active, p.now)) === "lost-lease") {
			p.log.warn("Search: another build took over; this one did not publish");
			return { ok: false, code: "lost-lease" };
		}

		const budgetKB = o.budget?.gzipKB ?? DEFAULT_BUDGET_KB;
		for (const f of files) {
			const kb = Math.round((f.file.gzBytes / 1024) * 10) / 10;
			if (kb > budgetKB) warnings.push(`Search: the "${f.locale}" index is ${kb} KB gzipped, over the ${budgetKB} KB budget. Set a smaller clip or index fewer collections.`);
		}
		if (pages >= SWITCH_ENGINE_AT) warnings.push(`Search: ${pages} pages is past the ${SWITCH_ENGINE_AT.toLocaleString("en-US")} pages this search is made for; it gets slow to load`);
		for (const w of warnings) p.log.warn(w);
		p.log.info(`Search: built ${pages} pages in ${files.length} locale file${files.length === 1 ? "" : "s"} (${collected.skipped} skipped)`);
		return { ok: true, active };
	} catch (error) {
		const failure = error instanceof BuildFailure ? error : null;
		const message = error instanceof Error ? error.message : String(error);
		const code: BuildErrorCode =
			failure?.code ?? (error instanceof RangeError && /too large/.test(error.message) ? "too-large" : isPlanLimit(message) ? "plan-limit" : "error");
		// writeChunks already deleted the chunks of the locale it was writing; delete the finished ones.
		// Not once publish has started: its outcome may be unknown, so freeing the lease retires the run
		// (moving the revision on, so a late publish write cannot apply) and cleanUp deletes them.
		if (!publishing) await deleteChunks(p.kv, runId, written).catch(() => {});
		if (await recordFailure(p, runId, gen, code, message, code === "deadline")) await cleanUp(p.kv).catch(() => {});
		(code === "error" ? p.log.error : p.log.warn)(`Search: the build failed (${code}): ${message}`);
		return { ok: false, code, error: message };
	}
}

/**
 * The one entry point of `tick`, `rebuild-soon`, `nightly` and Rebuild now. `nightly` and `admin` set
 * `force` first, so they build a clean state too. Not due: `{ ok: true, skipped: "not-due" }`. A live
 * lease: `code: "running"` (and `force`, if set, stays for the next run).
 */
export async function runIfDue(p: SearchPorts, o: PluginOptions, reason: RunReason): Promise<BuildResult | { ok: true; skipped: "not-due" }> {
	if (reason === "nightly" || reason === "admin") await markForce(p);
	const start = p.now();
	let lease: Awaited<ReturnType<typeof takeLease>> = null;
	let found: Found | undefined;
	for (let i = 0; ; i++) {
		const read = await readState(p.kv);
		found = undefined;
		if (!isDue(read.state, start)) {
			const retry = await retryDue(p, o, read.state);
			if (!retry) return { ok: true, skipped: "not-due" };
			found = retry;
		}
		// Only on the revision this decision read: a change meanwhile (another run published) means decide again.
		const taken = await takeLease(p.kv, start, read);
		if (taken === "stale") {
			if (i + 1 < LEASE_TRIES) continue;
			throw new Error(`search: the state record kept changing (${LEASE_TRIES} tries)`);
		}
		lease = taken;
		break;
	}
	if (!lease) return { ok: false, code: "running" };
	if (lease.interruptedGen !== undefined && lease.interrupted >= INTERRUPTED_LIMIT && !lease.forced) {
		// Settled at the interrupted run's gen: a change that came in during it still gets one more try.
		if (await recordFailure(p, lease.runId, lease.interruptedGen, "interrupted", INTERRUPTED_MESSAGE, false)) await cleanUp(p.kv).catch(() => {});
		p.log.warn(`Search: the build failed (interrupted): ${INTERRUPTED_MESSAGE}`);
		return { ok: false, code: "interrupted", error: INTERRUPTED_MESSAGE };
	}
	return build(p, o, lease.runId, lease.gen, start, found);
}

/**
 * Rebuild now: bumps `dirty`, sets `force`, and runs the build through `p.defer` so the request returns
 * at once. With a live lease it says `running` (the build still comes: `force` stays set). With no
 * search collection it says `no-collections` and starts nothing.
 */
export async function startRebuild(p: SearchPorts, o: PluginOptions): Promise<{ started: boolean; code?: "running" | "no-collections" }> {
	const { collections } = await searchCollections(p.schema, o);
	if (collections.length === 0) return { started: false, code: "no-collections" };
	const { state } = await markDirty(p, { force: true });
	if (state.lease && state.lease.until > p.now()) return { started: false, code: "running" };
	p.defer(async () => {
		await runIfDue(p, o, "admin");
	});
	return { started: true };
}
