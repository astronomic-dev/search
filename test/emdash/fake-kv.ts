/**
 * An in-memory plugin KV that behaves like EmDash 1.4's on D1 (`plugins/context.ts`,
 * `plugins/conditional-storage.ts`, `database/repositories/options.ts`):
 *
 * - values are stored as `JSON.stringify(value)` and parsed on read (so a read is a copy);
 * - every `set` and applied `compareAndSet` gives the key a new revision;
 * - `compareAndSet(key, null, v)` creates only when the key is absent;
 * - `compareAndSet` throws a `TypeError` on a value over 1 MiB of JSON, `set` throws on a row over
 *   2,000,000 UTF-8 bytes (D1's row cap);
 * - keys must be nonempty and at most 1,024 characters, revisions at most 128;
 * - a `settings:` key throws here (EmDash sends it to the plugin settings store; the core must not use it).
 *
 * Faults for tests: fail the n-th `set`, make a `compareAndSet` throw before or after it applies, and run
 * code just before a `compareAndSet` checks its revision (to race a hook against a publish).
 */
import type { CompareAndSetResult, KvPort, Versioned } from "../../src/emdash/core/ports.ts";

export const D1_ROW_BYTES = 2_000_000;
export const CAS_MAX_BYTES = 1024 * 1024;
const MAX_KEY_LENGTH = 1024;
const MAX_REVISION_LENGTH = 128;

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).byteLength;

export type KvOp = "get" | "getVersioned" | "compareAndSet" | "set" | "delete";

export interface FakeKv extends KvPort {
	/** Every call, in order. */
	calls: Array<{ op: KvOp; key: string }>;
	/** Keys present now, sorted; with a prefix, only those. */
	keys(prefix?: string): string[];
	/** The stored JSON of a key, or undefined. */
	raw(key: string): string | undefined;
	/** The current revision of a key, or undefined. */
	revisionOf(key: string): string | undefined;
	/** Makes the n-th `set` from now (1 = the next one) throw, optionally only counting keys that match. */
	failSet(n: number, match?: (key: string) => boolean): void;
	/**
	 * Makes the next `compareAndSet` (on a matching key) throw. `"after"`: it applies, then throws (an
	 * unclear write). `"before"`: it throws without applying.
	 */
	throwOnCompareAndSet(when: "before" | "after", match?: (key: string) => boolean): void;
	/** Runs once, just before the next `compareAndSet` (on a matching key) checks its revision. */
	beforeCompareAndSet(fn: () => Promise<void> | void, match?: (key: string) => boolean): void;
	/** Clears `calls`. */
	resetCalls(): void;
}

function assertKey(key: unknown): asserts key is string {
	if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
		throw new TypeError(`Storage key must be a nonempty string of at most ${MAX_KEY_LENGTH} characters`);
	}
	if (key.startsWith("settings:")) {
		throw new Error(`fake-kv: "${key}" goes to EmDash's plugin settings store, not KV; do not use a settings: key`);
	}
}

function serialize(value: unknown): string {
	const json = JSON.stringify(value);
	if (json === undefined) throw new TypeError("Storage value must be JSON serializable");
	return json;
}

export function createFakeKv(initial: Record<string, unknown> = {}): FakeKv {
	const rows = new Map<string, { json: string; revision: string }>();
	let nextRevision = 1;
	const newRevision = () => `rev-${nextRevision++}`;

	let setFault: { left: number; match: (key: string) => boolean } | null = null;
	let casFault: { when: "before" | "after"; match: (key: string) => boolean } | null = null;
	let casHook: { fn: () => Promise<void> | void; match: (key: string) => boolean } | null = null;
	const any = () => true;

	for (const [key, value] of Object.entries(initial)) rows.set(key, { json: serialize(value), revision: newRevision() });

	const kv: FakeKv = {
		calls: [],

		async get<T>(key: string): Promise<T | null> {
			assertKey(key);
			kv.calls.push({ op: "get", key });
			const row = rows.get(key);
			return row ? (JSON.parse(row.json) as T) : null;
		},

		async getVersioned<T>(key: string): Promise<Versioned<T> | null> {
			assertKey(key);
			kv.calls.push({ op: "getVersioned", key });
			const row = rows.get(key);
			return row ? { value: JSON.parse(row.json) as T, revision: row.revision } : null;
		},

		async compareAndSet(key: string, expectedRevision: string | null, value: unknown): Promise<CompareAndSetResult> {
			assertKey(key);
			kv.calls.push({ op: "compareAndSet", key });
			if (expectedRevision !== null && (typeof expectedRevision !== "string" || expectedRevision.length === 0 || expectedRevision.length > MAX_REVISION_LENGTH)) {
				throw new TypeError("Storage revision must be a nonempty string of at most 128 characters");
			}
			const json = serialize(value);
			if (byteLength(json) > CAS_MAX_BYTES) throw new TypeError("Conditional storage value must not exceed 1 MiB of JSON");

			if (casHook && casHook.match(key)) {
				const { fn } = casHook;
				casHook = null;
				await fn();
			}
			let fault: "before" | "after" | null = null;
			if (casFault && casFault.match(key)) {
				fault = casFault.when;
				casFault = null;
			}
			if (fault === "before") throw new Error("fake-kv: compareAndSet failed (not applied)");

			const row = rows.get(key);
			const matches = expectedRevision === null ? row === undefined : row?.revision === expectedRevision;
			let result: CompareAndSetResult = { applied: false };
			if (matches) {
				const revision = newRevision();
				rows.set(key, { json, revision });
				result = { applied: true, revision };
			}
			if (fault === "after") throw new Error("fake-kv: compareAndSet failed (unclear: it may have applied)");
			return result;
		},

		async set(key: string, value: unknown): Promise<void> {
			assertKey(key);
			kv.calls.push({ op: "set", key });
			if (setFault && setFault.match(key)) {
				setFault.left -= 1;
				if (setFault.left === 0) {
					setFault = null;
					throw new Error(`fake-kv: set "${key}" failed`);
				}
			}
			const json = serialize(value);
			const bytes = byteLength(json);
			if (bytes > D1_ROW_BYTES) throw new Error(`fake-kv: row "${key}" is ${bytes} bytes, over D1's ${D1_ROW_BYTES}-byte cap`);
			rows.set(key, { json, revision: newRevision() });
		},

		async delete(key: string): Promise<boolean> {
			assertKey(key);
			kv.calls.push({ op: "delete", key });
			return rows.delete(key);
		},

		keys(prefix = "") {
			return [...rows.keys()].filter((k) => k.startsWith(prefix)).sort();
		},
		raw(key) {
			return rows.get(key)?.json;
		},
		revisionOf(key) {
			return rows.get(key)?.revision;
		},
		failSet(n, match = any) {
			if (!Number.isInteger(n) || n < 1) throw new Error("fake-kv: failSet(n) takes n >= 1");
			setFault = { left: n, match };
		},
		throwOnCompareAndSet(when, match = any) {
			casFault = { when, match };
		},
		beforeCompareAndSet(fn, match = any) {
			casHook = { fn, match };
		},
		resetCalls() {
			kv.calls.length = 0;
		},
	};
	return kv;
}
