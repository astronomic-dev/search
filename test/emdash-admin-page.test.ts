import { test } from "node:test";
import assert from "node:assert/strict";
import { detailsStale, mergeSaved, type AdminStatus, type IndexesItem } from "../src/emdash/admin/api.ts";
import { DEFAULT_SETTINGS } from "../src/emdash/core/settings.ts";
import type { SearchSettings } from "../src/emdash/core/ports.ts";

const base: SearchSettings = { ...DEFAULT_SETTINGS, keys: ["mod+k", "/"], takeover: { ...DEFAULT_SETTINGS.takeover } };

test("mergeSaved: no edits during the save takes the saved values", () => {
	const saved = { ...base, placeholder: "Find", keys: ["mod+k"] };
	const m = mergeSaved({ ...base, placeholder: "Find", keys: ["mod+k", ""] }, { ...base, placeholder: "Find", keys: ["mod+k", ""] }, saved);
	assert.deepEqual(m, { draft: saved, dirty: false });
});

test("mergeSaved: a field typed during the save keeps the edit and stays unsaved", () => {
	const sent = { ...base, placeholder: "Fin" };
	const current = { ...sent, placeholder: "Find pages", results: "/s" };
	const m = mergeSaved(sent, current, { ...sent });
	assert.equal(m.dirty, true);
	assert.equal(m.draft.placeholder, "Find pages");
	assert.equal(m.draft.results, "/s");
	assert.equal(m.draft.theme, sent.theme);
});

const idle = (pages?: number, sections?: number): AdminStatus => ({ state: "idle", pending: false, pages, sections });
const running: AdminStatus = { state: "running", pending: false };
const shown = (pages: number, sections: number): IndexesItem => ({ name: "default", active: { gzBytes: 1, rawBytes: 1, pages, sections, builtAt: 1 }, budgetKB: 70, history: [] });

test("detailsStale: a build that just ended reads the details again; a busy status never does", () => {
	assert.equal(detailsStale(running, idle(3, 4), shown(3, 4)), true);
	assert.equal(detailsStale(running, { state: "failed", pending: false }, shown(3, 4)), true);
	assert.equal(detailsStale(null, running, undefined), false);
	assert.equal(detailsStale(idle(3, 4), idle(3, 4), shown(3, 4)), false);
});

test("detailsStale: the first terminal status reads again unless it agrees with what is shown", () => {
	// The index read came back before the first publish: "Not built yet" is stale.
	assert.equal(detailsStale(null, idle(3, 4), { ...shown(0, 0), active: null }), true);
	// The read is still out: read again (the older answer is dropped).
	assert.equal(detailsStale(null, idle(3, 4), undefined), true);
	assert.equal(detailsStale(null, idle(5, 6), shown(3, 4)), true);
	assert.equal(detailsStale(null, idle(3, 4), shown(3, 4)), false);
});

test("detailsStale: a newer build time reads again even with the same counts", () => {
	const at = (builtAt: number): AdminStatus => ({ ...idle(3, 4), builtAt });
	assert.equal(detailsStale(at(1), at(2), shown(3, 4)), true);
	assert.equal(detailsStale(null, at(2), shown(3, 4)), true);
	assert.equal(detailsStale(at(1), at(1), shown(3, 4)), false);
	assert.equal(detailsStale(null, at(1), shown(3, 4)), false);
});
