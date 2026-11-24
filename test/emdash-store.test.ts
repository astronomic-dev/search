import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeKv, D1_ROW_BYTES } from "./emdash/fake-kv.ts";
import {
	CHUNK_MAX_BYTES,
	LEASE_MS,
	MAX_INDEX_BYTES,
	STATE_KEY,
	chunkKey,
	cleanUp,
	emptyState,
	largestFile,
	planChunks,
	publish,
	readIndex,
	readState,
	splitChunks,
	takeLease,
	updateState,
	writeChunks,
} from "../src/emdash/core/store.ts";
import type { ActiveIndex, SearchState } from "../src/emdash/core/ports.ts";

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).byteLength;

/** A string of about `size` UTF-8 bytes, heavy on quotes and backslashes (they double when stored). */
function quoteyIndex(size: number): string {
	const unit = '{"t":"say \\"hi\\"","q":"\\"\\"\\"","p":"a\\\\b"},';
	return "[" + unit.repeat(Math.ceil(size / unit.length)).slice(0, size - 2) + "]";
}

/** About `size` bytes mixing quotes, non-ASCII text, emoji (surrogate pairs) and control characters. */
function mixedIndex(size: number): string {
	const unit = 'Zürich "Ångström" — 東京 naïve 🚀🎉 \n\t\u0001 \\ crème brûlée; ';
	const whole = unit.repeat(Math.floor(size / bytes(unit)));
	return whole + "x".repeat(size - bytes(whole));
}

function activeFor(runId: string, locales: Record<string, number>, version = `v-${runId}`, builtAt = 1000): ActiveIndex {
	return {
		runId,
		version,
		builtAt,
		locales: Object.fromEntries(Object.entries(locales).map(([l, chunks]) => [l, { chunks, etag: `"${version}-${l}"`, gzBytes: 100, rawBytes: 1000 }])),
		pages: 3,
		sections: 0,
		records: 3,
		skipped: 0,
	};
}

/** Takes the lease, writes each locale and publishes. */
async function build(kv: ReturnType<typeof createFakeKv>, now: number, files: Record<string, string>) {
	const lease = await takeLease(kv, now);
	assert.ok(lease, "lease taken");
	const counts: Record<string, number> = {};
	for (const [locale, json] of Object.entries(files)) counts[locale] = await writeChunks(kv, lease.runId, locale, json);
	const active = activeFor(lease.runId, counts, `v-${lease.runId}`, now);
	const result = await publish(kv, lease.runId, lease.gen, active, () => now);
	return { ...lease, active, result };
}

test("readState on an empty KV gives the empty state and no revision", async () => {
	const kv = createFakeKv();
	const { state, revision } = await readState(kv);
	assert.deepEqual(state, emptyState());
	assert.equal(revision, null);
	assert.equal(state.active, null);
	assert.deepEqual(state.retired, []);
});

test("updateState writes by compareAndSet and returns null when fn makes no change", async () => {
	const kv = createFakeKv();
	const s1 = await updateState(kv, (s) => ({ ...s, dirty: s.dirty + 1 }));
	assert.equal(s1?.dirty, 1);
	assert.equal((await readState(kv)).state.dirty, 1);
	const before = kv.revisionOf(STATE_KEY);
	assert.equal(await updateState(kv, () => null), null);
	assert.equal(kv.revisionOf(STATE_KEY), before);
});

test("updateState retries on a conflict", async () => {
	const kv = createFakeKv();
	await updateState(kv, (s) => ({ ...s, dirty: 1 }));
	kv.beforeCompareAndSet(async () => {
		await updateState(kv, (s) => ({ ...s, dirty: s.dirty + 10 }));
	});
	const out = await updateState(kv, (s) => ({ ...s, dirty: s.dirty + 1 }));
	assert.equal(out?.dirty, 12);
});

test("a 5 MB index with many quotes writes as 4+ chunks under 1,500,000 stored bytes and reads back equal", async () => {
	const kv = createFakeKv();
	const json = quoteyIndex(5_000_000);
	const { active, result } = await build(kv, 1000, { en: json });
	assert.equal(result, "published");
	const keys = kv.keys(`chunk:${active.runId}:en:`);
	assert.ok(keys.length >= 4, `chunks: ${keys.length}`);
	assert.equal(active.locales.en.chunks, keys.length);
	for (const key of keys) assert.ok(bytes(kv.raw(key)!) <= CHUNK_MAX_BYTES, `${key}: ${bytes(kv.raw(key)!)}`);
	const { state } = await readState(kv);
	assert.equal(await readIndex(kv, state, active.version, "en"), json);
});

test("a 7,900,000-byte index (quotes, non-ASCII, emoji, control chars) writes as 6+ chunks and reads back equal", async () => {
	const kv = createFakeKv();
	const json = mixedIndex(7_900_000);
	assert.ok(bytes(json) <= MAX_INDEX_BYTES && bytes(json) > 7_800_000);
	const { active } = await build(kv, 1000, { en: json });
	const keys = kv.keys(`chunk:${active.runId}:en:`);
	assert.ok(keys.length >= 6, `chunks: ${keys.length}`);
	for (const key of keys) assert.ok(bytes(kv.raw(key)!) <= CHUNK_MAX_BYTES);
	const { state } = await readState(kv);
	assert.equal(await readIndex(kv, state, active.version, "en"), json);
});

test("splitChunks keeps surrogate pairs whole and measures escaped size", () => {
	const s = "🚀".repeat(10) + '"'.repeat(10) + "\u0001".repeat(10);
	const parts = splitChunks(s, 20);
	assert.equal(parts.join(""), s);
	for (const p of parts) {
		assert.ok(bytes(JSON.stringify(p)) <= 20, `${JSON.stringify(p)}`);
		assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p), "no split pair");
	}
	assert.deepEqual(splitChunks("", 20), [""]);
});

test("writeChunks refuses an index over MAX_INDEX_BYTES and writes nothing", async () => {
	const kv = createFakeKv();
	const lease = (await takeLease(kv, 1000))!;
	await assert.rejects(writeChunks(kv, lease.runId, "en", "x".repeat(MAX_INDEX_BYTES + 1)), /too large|MAX_INDEX_BYTES|8,000,000/i);
	assert.deepEqual(kv.keys("chunk:"), []);
	assert.ok(MAX_INDEX_BYTES === 8_000_000 && CHUNK_MAX_BYTES === 1_500_000 && CHUNK_MAX_BYTES < D1_ROW_BYTES);
});

test("active moves only after every chunk is written; a failed chunk write leaves the old active and no new chunks", async () => {
	const kv = createFakeKv();
	const first = await build(kv, 1000, { en: quoteyIndex(3_000_000) });
	const lease = (await takeLease(kv, 2000))!;
	kv.failSet(2, (k) => k.startsWith(`chunk:${lease.runId}:`));
	await assert.rejects(writeChunks(kv, lease.runId, "en", quoteyIndex(3_000_000)));
	assert.deepEqual(kv.keys(`chunk:${lease.runId}:`), []);
	const { state } = await readState(kv);
	assert.equal(state.active?.runId, first.active.runId);
	assert.ok(kv.keys(`chunk:${first.active.runId}:`).length > 0);
});

test("writeChunks runs beforeWrite before each chunk; a throw stops it and deletes its chunks", async () => {
	const kv = createFakeKv();
	const lease = (await takeLease(kv, 1000))!;
	let calls = 0;
	await assert.rejects(
		writeChunks(kv, lease.runId, "en", quoteyIndex(5_000_000), {
			beforeWrite() {
				calls += 1;
				if (calls === 3) throw new Error("deadline");
			},
		}),
		/deadline/,
	);
	assert.equal(calls, 3);
	assert.deepEqual(kv.keys("chunk:"), []);
});

test("after three publishes only the active run's chunks are left, and retired is empty", async () => {
	const kv = createFakeKv();
	let last;
	for (let i = 0; i < 3; i++) last = await build(kv, 1000 + i * 1000, { en: quoteyIndex(2_000_000), fr: `["fr${i}"]` });
	const { state } = await readState(kv);
	assert.equal(state.active?.runId, last!.active.runId);
	assert.deepEqual(state.retired, []);
	assert.deepEqual(
		kv.keys("chunk:").map((k) => k.split(":")[1]),
		kv.keys("chunk:").map(() => last!.active.runId),
	);
	assert.equal(state.lease, null);
	assert.equal(state.history.length, 3);
	assert.equal(state.last?.ok, true);
});

test("publish keeps the last 10 history entries", async () => {
	const kv = createFakeKv();
	for (let i = 0; i < 12; i++) await build(kv, 1000 + i, { en: `["${i}"]` });
	const { state } = await readState(kv);
	assert.equal(state.history.length, 10);
	assert.equal(state.history.at(-1)?.builtAt, 1011);
	assert.equal(state.history[0].builtAt, 1002);
});

test("history sizes are the largest locale file, like the indexes route, not the sum", async () => {
	const kv = createFakeKv();
	const lease = await takeLease(kv, 1000);
	assert.ok(lease);
	const counts = { en: await writeChunks(kv, lease.runId, "en", `["en"]`), es: await writeChunks(kv, lease.runId, "es", `["es"]`) };
	const active = activeFor(lease.runId, counts, "v1", 1000);
	active.locales.en = { ...active.locales.en!, gzBytes: 300, rawBytes: 2000 };
	active.locales.es = { ...active.locales.es!, gzBytes: 200, rawBytes: 5000 };
	await publish(kv, lease.runId, lease.gen, active, () => 1000);
	const { state } = await readState(kv);
	assert.deepEqual(largestFile(active), { gzBytes: 300, rawBytes: 5000 });
	assert.deepEqual(state.history.at(-1), { builtAt: 1000, gzBytes: 300, rawBytes: 5000, pages: 3, sections: 0 });
});

test("takeLease returns null while another live lease is held, reads gen and clears force", async () => {
	const kv = createFakeKv();
	await updateState(kv, (s) => ({ ...s, dirty: 4, force: true }));
	const a = await takeLease(kv, 1000);
	assert.ok(a);
	assert.equal(a.gen, 4);
	const { state } = await readState(kv);
	assert.equal(state.force, false);
	assert.deepEqual(state.lease, { runId: a.runId, until: 1000 + LEASE_MS, gen: 4 });
	assert.equal(a.forced, true);
	assert.equal(await takeLease(kv, 1000 + LEASE_MS - 1), null);
});

test("an expired lease is taken over; the old run goes into retired and its chunks are deleted by probing", async () => {
	const kv = createFakeKv();
	await build(kv, 0, { en: '["old"]', fr: '["old-fr"]' });
	const a = (await takeLease(kv, 1000))!;
	await writeChunks(kv, a.runId, "en", quoteyIndex(2_000_000));
	await writeChunks(kv, a.runId, "fr", '["a-fr"]');
	assert.ok(kv.keys(`chunk:${a.runId}:`).length >= 3);
	// A crashes. B takes over after expiry.
	const b = (await takeLease(kv, 1000 + LEASE_MS))!;
	assert.ok(b);
	assert.notEqual(b.runId, a.runId);
	const { state } = await readState(kv);
	assert.deepEqual(state.retired, [{ runId: a.runId, locales: null }]);
	await cleanUp(kv);
	assert.deepEqual(kv.keys(`chunk:${a.runId}:`), []);
	assert.deepEqual((await readState(kv)).state.retired, []);
});

test("stalled run: A loses its lease to B, B publishes, A's publish is lost-lease and A's chunks are gone", async () => {
	const kv = createFakeKv();
	const a = (await takeLease(kv, 1000))!;
	const aCount = await writeChunks(kv, a.runId, "en", '["a"]');
	const b = await build(kv, 1000 + LEASE_MS + 1, { en: '["b"]' });
	assert.equal(b.result, "published");
	const result = await publish(kv, a.runId, a.gen, activeFor(a.runId, { en: aCount }), () => 1000);
	assert.equal(result, "lost-lease");
	const { state } = await readState(kv);
	assert.equal(state.active?.runId, b.runId);
	assert.deepEqual(kv.keys(`chunk:${a.runId}:`), []);
	assert.equal(await readIndex(kv, state, state.active!.version, "en"), '["b"]');
});

test("lost lease while A's chunks hold more than one locale deletes all of them", async () => {
	const kv = createFakeKv();
	const a = (await takeLease(kv, 1000))!;
	const counts = { en: await writeChunks(kv, a.runId, "en", quoteyIndex(2_000_000)), de: await writeChunks(kv, a.runId, "de", '["de"]') };
	await updateState(kv, (s) => ({ ...s, lease: { runId: "someone-else", until: 1e12 } }));
	assert.equal(await publish(kv, a.runId, a.gen, activeFor(a.runId, counts), () => 1000), "lost-lease");
	assert.deepEqual(kv.keys("chunk:"), []);
});

test("change during publish: a hook bumps dirty before A's compareAndSet; A retries and publishes with builtGen = gen", async () => {
	const kv = createFakeKv();
	await updateState(kv, (s) => ({ ...s, dirty: 1, lastChangeAt: 500, dirtySince: 500 }));
	const a = (await takeLease(kv, 1000))!;
	assert.equal(a.gen, 1);
	const count = await writeChunks(kv, a.runId, "en", '["a"]');
	kv.beforeCompareAndSet(async () => {
		await updateState(kv, (s) => ({ ...s, dirty: s.dirty + 1, lastChangeAt: 1500 }));
	}, (k) => k === STATE_KEY);
	assert.equal(await publish(kv, a.runId, a.gen, activeFor(a.runId, { en: count }), () => 1000), "published");
	const { state } = await readState(kv);
	assert.equal(state.active?.runId, a.runId);
	assert.equal(state.builtGen, 1);
	assert.equal(state.dirty, 2);
	assert.ok(state.dirty > state.builtGen);
	assert.notEqual(state.dirtySince, null, "still dirty, so dirtySince stays");
});

test("publish with nothing changed during the build clears dirtySince", async () => {
	const kv = createFakeKv();
	await updateState(kv, (s) => ({ ...s, dirty: 3, lastChangeAt: 500, dirtySince: 400 }));
	await build(kv, 1000, { en: "[]" });
	const { state } = await readState(kv);
	assert.equal(state.builtGen, 3);
	assert.equal(state.dirtySince, null);
});

test("unclear publish that applied: publish re-reads, sees its runId in active and deletes nothing", async () => {
	const kv = createFakeKv();
	const a = (await takeLease(kv, 1000))!;
	const count = await writeChunks(kv, a.runId, "en", quoteyIndex(2_000_000));
	const keys = kv.keys(`chunk:${a.runId}:`);
	kv.throwOnCompareAndSet("after", (k) => k === STATE_KEY);
	assert.equal(await publish(kv, a.runId, a.gen, activeFor(a.runId, { en: count }), () => 1000), "published");
	assert.deepEqual(kv.keys(`chunk:${a.runId}:`), keys);
	const { state } = await readState(kv);
	assert.equal(state.active?.runId, a.runId);
	assert.equal(kv.calls.filter((c) => c.op === "delete" && c.key.startsWith(`chunk:${a.runId}:`)).length, 0);
});

test("unclear publish that did not apply: the chunks stay (the write may still land) until a takeover retires the run", async () => {
	const kv = createFakeKv();
	const first = await build(kv, 0, { en: '["first"]' });
	const a = (await takeLease(kv, 1000))!;
	const count = await writeChunks(kv, a.runId, "en", quoteyIndex(2_000_000));
	assert.ok(await planChunks(kv, a.runId, { en: count }));
	const keys = kv.keys(`chunk:${a.runId}:`);
	kv.throwOnCompareAndSet("before", (k) => k === STATE_KEY);
	await assert.rejects(publish(kv, a.runId, a.gen, activeFor(a.runId, { en: count }), () => 1000));
	assert.deepEqual(kv.keys(`chunk:${a.runId}:`), keys, "nothing deleted on a guess");
	const { state } = await readState(kv);
	assert.equal(state.active?.runId, first.runId);
	assert.equal(await readIndex(kv, state, first.active.version, "en"), '["first"]');
	// The lease expires; a takeover retires A with its counts and clean-up deletes the chunks.
	await build(kv, 1000 + LEASE_MS, { en: '["b"]' });
	assert.deepEqual(kv.keys(`chunk:${a.runId}:`), []);
	assert.deepEqual((await readState(kv)).state.retired, []);
});

test("publish past the lease's expiry is lost-lease even with no other runner", async () => {
	const kv = createFakeKv();
	const first = await build(kv, 0, { en: '["first"]' });
	const a = (await takeLease(kv, 1000))!;
	const count = await writeChunks(kv, a.runId, "en", '["a"]');
	assert.equal(await publish(kv, a.runId, a.gen, activeFor(a.runId, { en: count }), () => 1000 + LEASE_MS), "lost-lease");
	assert.equal((await readState(kv)).state.active?.runId, first.runId);
	assert.deepEqual(kv.keys(`chunk:${a.runId}:`), []);
});

test("crash clean-up retries every recorded chunk, across a gap a partial delete left", async () => {
	const kv = createFakeKv();
	await build(kv, 0, { en: '["old"]' });
	const a = (await takeLease(kv, 1000))!;
	const big = quoteyIndex(2_000_000);
	const count = splitChunks(big).length;
	assert.ok(count >= 2);
	assert.ok(await planChunks(kv, a.runId, { en: count, de: 1 }));
	await writeChunks(kv, a.runId, "en", big);
	await writeChunks(kv, a.runId, "de", '["de"]');
	// A crashes; B takes over. Clean-up deletes chunk 0, then fails on chunk 1.
	assert.ok(await takeLease(kv, 1000 + LEASE_MS));
	await updateState(kv, (s) => ({ ...s, lease: null }));
	const realDelete = kv.delete.bind(kv);
	let fail = true;
	kv.delete = async (key: string) => {
		if (fail && key === chunkKey(a.runId, "en", 1)) throw new Error("delete failed");
		return realDelete(key);
	};
	await cleanUp(kv);
	assert.equal(kv.raw(chunkKey(a.runId, "en", 0)), undefined);
	assert.ok(kv.raw(chunkKey(a.runId, "en", 1)));
	fail = false;
	await cleanUp(kv);
	assert.deepEqual(kv.keys(`chunk:${a.runId}:`), []);
	assert.deepEqual((await readState(kv)).state.retired, []);
});

test("readIndex: a missing chunk, another version or an unknown locale gives null", async () => {
	const kv = createFakeKv();
	const { active } = await build(kv, 1000, { en: quoteyIndex(2_000_000) });
	const { state } = await readState(kv);
	assert.equal(await readIndex(kv, state, "not-it", "en"), null);
	assert.equal(await readIndex(kv, state, active.version, "xx"), null);
	assert.equal(await readIndex(kv, emptyState(), active.version, "en"), null);
	await kv.delete(chunkKey(active.runId, "en", 1));
	assert.equal(await readIndex(kv, state, active.version, "en"), null);
});

test("readIndex: the previous version gives null after a new publish", async () => {
	const kv = createFakeKv();
	const one = await build(kv, 1000, { en: '["1"]' });
	const two = await build(kv, 2000, { en: '["2"]' });
	const { state } = await readState(kv);
	assert.equal(await readIndex(kv, state, one.active.version, "en"), null);
	assert.equal(await readIndex(kv, state, two.active.version, "en"), '["2"]');
});

test("cleanUp leaves retired runs whose delete failed for the next build", async () => {
	const kv = createFakeKv();
	await build(kv, 0, { en: '["x"]' });
	const stuck = "stuck-run";
	await kv.set(chunkKey(stuck, "en", 0), "x");
	const state: SearchState = (await readState(kv)).state;
	await updateState(kv, () => ({ ...state, retired: [{ runId: stuck, locales: { en: 1 } }] }));
	const realDelete = kv.delete.bind(kv);
	let fail = true;
	kv.delete = async (key: string) => {
		if (fail && key.startsWith(`chunk:${stuck}:`)) throw new Error("delete failed");
		return realDelete(key);
	};
	await cleanUp(kv);
	assert.deepEqual((await readState(kv)).state.retired, [{ runId: stuck, locales: { en: 1 } }]);
	fail = false;
	await cleanUp(kv);
	assert.deepEqual((await readState(kv)).state.retired, []);
	assert.deepEqual(kv.keys(`chunk:${stuck}:`), []);
});

test("takeLease counts a dead lease that recorded nothing as interrupted, with its gen; a recorded one does not count", async () => {
	const kv = createFakeKv();
	await updateState(kv, (s) => ({ ...s, dirty: 3 }));
	const a = (await takeLease(kv, 1000))!;
	assert.equal(a.interrupted, 0);
	assert.equal(a.interruptedGen, undefined);
	await updateState(kv, (s) => ({ ...s, dirty: 4 })); // a change during A
	const b = (await takeLease(kv, 1000 + LEASE_MS))!;
	assert.equal(b.interrupted, 1);
	assert.equal(b.interruptedGen, 3, "A's gen, not the newer dirty");
	assert.equal(b.gen, 4);
	assert.equal((await readState(kv)).state.interrupted, 1);
	// B records its own failure and leaves the lease (a deadline): its takeover does not count.
	await updateState(kv, (s) => ({ ...s, lease: { ...s.lease!, recorded: true }, interrupted: 0 }));
	const c = (await takeLease(kv, 1000 + 2 * LEASE_MS))!;
	assert.equal(c.interrupted, 0);
	assert.equal(c.interruptedGen, undefined);
});

test("a stored state without interrupted reads as 0", async () => {
	const kv = createFakeKv();
	const { interrupted: _, ...old } = emptyState();
	await kv.compareAndSet(STATE_KEY, null, old);
	assert.equal((await readState(kv)).state.interrupted, 0);
});
