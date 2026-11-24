/**
 * The plugin's route handlers, platform-free (plan decisions 7 and 8). Each returns `{ status, headers, body }`;
 * the native wrapper (`src/emdash/plugin.ts`) maps them to EmDash routes.
 *
 * - `manifest` and `index` are public, GET and HEAD, JSON only, with an ETag and 304. Their `Cache-Control` is
 *   not set here: EmDash drops it from a raw route's headers and sets the route's `cacheControl`
 *   (`PUBLIC_CACHE_CONTROL`) instead. EmDash passes on only a few headers (`plugins/route-wire.ts`), so these
 *   handlers send only `content-type`, `etag` and `retry-after`.
 * - Only the active version is served; any other `v`, or a chunk that clean-up removed meanwhile, is 404, and the
 *   embed then reads the manifest again (`src/controller/load.ts`).
 * - The manifest names each index file by an absolute path. A path relative to the manifest URL would break on a
 *   site with `trailingSlash: "always"`, where the manifest URL ends in "/". Such a site rewrites the unslashed
 *   `/_emdash/...` URLs anyway (EmDash's own admin calls them unslashed).
 * - `indexes`, `status`, `rebuild` and `settings` are private: EmDash checks `plugins:manage`, the token scope and
 *   `X-EmDash-Request` before they run, and sends `private, no-store`.
 *
 * Platform-free: imports nothing from emdash, node, react or astro.
 */
import { SCHEMA, type Manifest } from "../../core/types.ts";
import type {
	IndexesResponse,
	PluginOptions,
	RebuildResponse,
	RequestRebuild,
	RouteHandler,
	RouteMethod,
	RouteName,
	RouteRequest,
	RouteResponse,
	SearchPorts,
	SearchState,
	StatusResponse,
} from "./ports.ts";
import { indexDefaultLocale } from "./records.ts";
import { largestFile, readIndex, readState } from "./store.ts";
import { MANIFEST_PATH, readSettings, saveSettings } from "./settings.ts";

export { MANIFEST_PATH };

/** The plugin's route URLs start here (plugin id `astronomic-search`). */
export const ROUTE_BASE = "/_emdash/api/plugins/astronomic-search/";

/** The `cacheControl` of both public routes: always revalidate, so a new build is seen at once. */
export const PUBLIC_CACHE_CONTROL = "public, max-age=0, must-revalidate";

/** Seconds the embed is told to wait when no index is built yet. */
export const RETRY_AFTER_S = 30;

const DEFAULT_BUDGET_KB = 300;
const JSON_TYPE = "application/json; charset=utf-8";

const json = (status: number, value: unknown, extra: Record<string, string> = {}): RouteResponse => ({
	status,
	headers: { "content-type": JSON_TYPE, ...extra },
	body: JSON.stringify(value),
});

const noBody = (res: RouteResponse): RouteResponse => {
	const { body: _body, ...rest } = res;
	return rest;
};

/** A quoted strong ETag; a value that is already quoted (or weak) is kept. */
function quoteEtag(tag: string): string {
	return /^(?:W\/)?"[^"]*"$/.test(tag) ? tag : `"${tag.replace(/[^\x21\x23-\x7e]/g, (c) => encodeURIComponent(c))}"`;
}

/** Whether `If-None-Match` names `etag` (weak comparison, as RFC 9110 asks for If-None-Match). */
function notModified(request: RouteRequest, etag: string): boolean {
	const header = request.headers.get("if-none-match");
	if (!header) return false;
	const opaque = (t: string) => t.trim().replace(/^W\//, "");
	const want = opaque(etag);
	return header.split(",").some((t) => t.trim() === "*" || opaque(t) === want);
}

/** A GET/HEAD response with an ETag: 304 on a match, and no body for HEAD. */
function cached(request: RouteRequest, etag: string, body: () => Promise<string | null>): Promise<RouteResponse> {
	const headers = { "content-type": JSON_TYPE, etag };
	if (notModified(request, etag)) return Promise.resolve({ status: 304, headers });
	if (request.method === "HEAD") return Promise.resolve({ status: 200, headers });
	return body().then((text) => (text === null ? json(404, { error: "not-found" }) : { status: 200, headers, body: text }));
}

function indexPath(version: string, locale: string): string {
	return `${ROUTE_BASE}index?${new URLSearchParams({ v: version, l: locale })}`;
}

/** The admin's view of `state` (plan decision 8). */
export function statusOf(state: SearchState, now: number): StatusResponse {
	const pending = state.dirty > state.builtGen || state.force;
	const last = state.last;
	// A failure stays shown until a change or Rebuild now comes after it, though `dirty` keeps the build due.
	const failedNow = !!last && !last.ok && !state.force && (state.lastChangeAt ?? 0) <= last.at;
	const running = !!state.lease && state.lease.until > now;
	const out: StatusResponse = { state: running ? "running" : failedNow ? "failed" : pending ? "queued" : "idle", pending };
	if (state.active) {
		out.pages = state.active.pages;
		out.sections = state.active.sections;
		out.builtAt = state.active.builtAt;
	}
	if (last && !last.ok) {
		if (last.error !== undefined) out.error = last.error;
		if (last.errorCode !== undefined) out.errorCode = last.errorCode;
	}
	return out;
}

function route(isPublic: boolean, methods: readonly RouteMethod[], handle: (request: RouteRequest) => Promise<RouteResponse>): RouteHandler {
	return {
		public: isPublic,
		methods,
		async handle(request) {
			if (!methods.includes(request.method)) return json(405, { error: "method-not-allowed" });
			const res = await handle(request);
			return request.method === "HEAD" ? noBody(res) : res;
		},
	};
}

export function createRoutes(p: SearchPorts, o: PluginOptions, requestRebuild: RequestRebuild): Record<RouteName, RouteHandler> {
	const budgetKB = o.budget?.gzipKB ?? DEFAULT_BUDGET_KB;
	const status = async () => statusOf((await readState(p.kv)).state, p.now());

	return {
		manifest: route(true, ["GET", "HEAD"], async (request) => {
			const { state } = await readState(p.kv);
			const active = state.active;
			if (!active) return json(503, { error: "not-built" }, { "retry-after": String(RETRY_AFTER_S) });
			const defaultLocale = indexDefaultLocale(p.content);
			const locales: Record<string, string> = {};
			for (const locale of Object.keys(active.locales)) locales[locale] = indexPath(active.version, locale);
			const manifest: Manifest = { schema: SCHEMA, defaultLocale, indexes: { default: { version: active.version, locales } } };
			const etag = quoteEtag(`m.${active.version}.${defaultLocale}`);
			return cached(request, etag, async () => JSON.stringify(manifest));
		}),

		index: route(true, ["GET", "HEAD"], async (request) => {
			const version = request.query.get("v");
			const locale = request.query.get("l");
			const { state } = await readState(p.kv);
			const active = state.active;
			const file = active && locale !== null && Object.hasOwn(active.locales, locale) ? active.locales[locale] : undefined;
			if (!active || !file || version !== active.version || locale === null) return json(404, { error: "not-found" });
			return cached(request, quoteEtag(file.etag), () => readIndex(p.kv, state, version, locale));
		}),

		indexes: route(false, ["GET"], async () => {
			const { state } = await readState(p.kv);
			const a = state.active;
			// The budget is per locale file, so the largest one is what the admin colors.
			const body: IndexesResponse = [
				{
					name: "default",
					active: a
						? {
								...largestFile(a),
								pages: a.pages,
								sections: a.sections,
								builtAt: a.builtAt,
								...(a.siteUrl ? { siteUrl: a.siteUrl } : {}),
							}
						: null,
					budgetKB,
					history: state.history,
				},
			];
			return json(200, body);
		}),

		status: route(false, ["GET"], async () => json(200, await status())),

		rebuild: route(false, ["POST"], async () => {
			const r = await requestRebuild();
			const body: RebuildResponse = { started: r.started, ...(r.code ? { code: r.code } : {}), status: await status() };
			return json(200, body);
		}),

		settings: route(false, ["GET", "POST"], async (request) => {
			if (request.method === "GET") return json(200, await readSettings(p.kv));
			const input = request.body;
			if (typeof input !== "object" || input === null || Array.isArray(input)) return json(400, { error: "bad-body" });
			return json(200, await saveSettings(p.kv, input as Record<string, unknown>));
		}),
	};
}
