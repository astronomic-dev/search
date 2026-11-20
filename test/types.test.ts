import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA } from "../src/core/types.ts";
import type { IndexSettings, Manifest } from "../src/core/types.ts";

test("types load as .ts and the schema is version 1", () => {
	assert.equal(SCHEMA, 1);
	const settings: IndexSettings = {
		weights: { title: 3, heading: 2, text: 1, keywords: 1 },
		group: { dialog: "type", page: false },
		groupOrder: "best",
		types: { themes: { label: "Themes", weight: 2 } },
		facets: {},
	};
	const manifest: Manifest = {
		schema: SCHEMA,
		defaultLocale: "en",
		indexes: {
			site: { version: "a1", locales: { en: "/_search/site.en.a1.json" } },
			kit: { version: "b2", locales: { en: "/_search/kit.en.b2.json" } },
		},
	};
	assert.equal(settings.types.themes?.weight, 2);
	assert.deepEqual(Object.keys(manifest.indexes), ["site", "kit"]);
});
