/**
 * The one route that reads the content collections (an integration cannot call `getCollection`). It is prerendered
 * to `/_search/__records.json`; the integration reads it after the build and deletes it. In dev the middleware
 * fetches it from the dev server.
 */
import { getCollection, render } from "astro:content";
import specs from "virtual:astronomic-search/specs";
import { entryRecords } from "../adapters/collections.ts";
import type { RouteData } from "./build.ts";

export const prerender = true;

export async function GET(): Promise<Response> {
	const out: RouteData = { sources: {} };
	for (const { key, collection, spec, data } of specs.sources) {
		const entries = (await getCollection(collection as never)) as unknown as { id: string; collection: string; data: Record<string, unknown>; body?: string }[];
		const got: RouteData["sources"][string] = { entries: [] };
		for (const entry of entries) {
			if (entry.data?.draft === true || entry.data?.noindex === true) continue;
			const headings = typeof entry.body === "string" ? (await render(entry as never)).headings : undefined;
			const one = entryRecords(entry, headings, spec, specs);
			if (!one) continue;
			// The data only for a spec with a filter: the integration runs it on each entry.
			got.entries.push({ id: entry.id, ...(data ? { data: entry.data } : {}), records: one.records, warnings: one.warnings });
		}
		out.sources[key] = got;
	}
	return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
}
