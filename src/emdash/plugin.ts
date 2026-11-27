/**
 * The native EmDash wrapper (plan decisions 1, 6, 8 and 10): wires the platform-free core (`./core/`) to EmDash's
 * hooks, cron, routes, `page:fragments` and `after()`. `index.ts` passes the result to `definePlugin`.
 *
 * - Content hooks only mark the index dirty (`onContentEvent`); EmDash gives a hook 5 s.
 * - `plugin:install` and `plugin:activate` schedule the recurring `tick` (every minute) and `nightly` (03:00), and
 *   mark the index dirty with `force`, so the first tick builds.
 * - One `cron` hook takes `tick`, `rebuild-soon` and `nightly`, with a 150 s timeout: longer than the 2 min build
 *   deadline, shorter than the 3 min lease.
 * - `manifest` and `index` are public raw JSON routes with `PUBLIC_CACHE_CONTROL`; every other route is private
 *   (`plugins:manage`, EmDash's JSON envelope). This table is part of the security contract.
 * - The index holds paths only, built from the listed rows (`urlRules`), so no site URL is needed: EmDash never reads
 *   Astro's `site`, and a request's Host is never stored or trusted. `page:fragments` writes nothing.
 * - `page:fragments` prints the embed boot and the JSON config tag at `body:end`, never on preview or edit-mode
 *   requests. EmDash's renderer keeps an `inline-script`'s attributes as given (`page/fragments.ts`), so the config
 *   tag keeps `type="application/json"`; the config text has `<`, `>` and `&` escaped, so it holds no `</`.
 */
import type { PageFragmentContribution, PluginContext, PluginDefinition, PluginRoute } from "emdash";
import { after as emdashAfter, getAllTermsForEntries as emdashTerms, getI18nConfig, getRequestContext as emdashRequestContext, PluginRouteError, pluginResponse } from "emdash";
import { runIfDue, startRebuild } from "./core/build.ts";
import type { CollectionInfo, ContentPort, EmDashEntry, PluginOptions, RouteHandler, RouteMethod, RouteName, RouteRequest, RunReason, SearchPorts, UrlLocale, UrlRules } from "./core/ports.ts";
import { CONTENT_EVENTS, markDirty, onContentEvent, type ContentEventPayload } from "./core/refresh.ts";
import { createRoutes, PUBLIC_CACHE_CONTROL } from "./core/routes.ts";
import { configJson, readSettings } from "./core/settings.ts";

/** The plugin id; it shows in the route URLs (`/_emdash/api/plugins/astronomic-search/...`). */
export const PLUGIN_ID = "astronomic-search";
/** The package version; the boot's `?ver=` changes with it. A unit test keeps it equal to package.json. */
export const VERSION = "0.2.3";
export const CAPABILITIES = ["content:read", "schema:read", "hooks.page-fragments:register"] as const;
export const ADMIN_ENTRY = "@astronomic-dev/search/emdash/admin";
export const ADMIN_PAGES = [{ path: "/settings", label: "Search", icon: "magnifying-glass" }];
/** Where the site serves the embed files by default; must match `searchFiles()`. */
export const DEFAULT_FILES_PATH = "/_search/embed/";
export const BOOT_FILE = "search-embed.js";

/** Cron task names and schedules. */
export const TICK = "tick";
export const TICK_SCHEDULE = "* * * * *";
export const NIGHTLY = "nightly";
export const NIGHTLY_SCHEDULE = "0 3 * * *";
export const REBUILD_SOON = "rebuild-soon";
/** The cron hook's timeout: over the 2 min build deadline, under the 3 min lease. */
export const CRON_TIMEOUT_MS = 150_000;

const CRON_REASONS: Record<string, RunReason> = { [TICK]: "tick", [REBUILD_SOON]: "soon", [NIGHTLY]: "nightly" };
/** EmDash's largest list page (`ContentRepository.findMany` caps `limit` at 100). */
const LIST_LIMIT = 100;

/** What the wrapper takes from EmDash's runtime; tests pass fakes. */
export interface WrapperDeps {
	after(fn: () => Promise<void>): void;
	getRequestContext(): { editMode?: boolean; preview?: unknown } | undefined;
	/** EmDash's batch read of terms; it opens the database itself, in a request, in cron and in `after()`. */
	getAllTermsForEntries(collection: string, ids: string[], options: { locale: string }): Promise<Map<string, Record<string, Array<{ label: string }>>>>;
}

const defaultDeps: WrapperDeps = { after: emdashAfter, getRequestContext: emdashRequestContext, getAllTermsForEntries: emdashTerms };

/** The embed boot and the config tag (plan decision 10). */
export function pageFragments(config: string, filesPath = DEFAULT_FILES_PATH, version = VERSION): PageFragmentContribution[] {
	const base = filesPath.endsWith("/") ? filesPath : `${filesPath}/`;
	return [
		{
			kind: "external-script",
			placement: "body:end",
			src: `${base}${BOOT_FILE}?ver=${encodeURIComponent(version)}`,
			attributes: { type: "module" },
			key: "astronomic-search-boot",
		},
		{
			kind: "inline-script",
			placement: "body:end",
			code: config,
			attributes: { type: "application/json", "data-search-config": "" },
			key: "astronomic-search-config",
		},
	];
}

/**
 * The URL rules EmDash's `getPublicUrl` reads. EmDash reads Astro's i18n config (`astro:config/server`);
 * a plugin gets the same config from `getI18nConfig()`, normalized: locale paths plus `localeAliases`
 * (code to path). Each custom-path locale is rebuilt as Astro's `{ path, codes }`.
 */
export function urlRulesFrom(site: { locale?: string; trailingSlash?: "always" | "never" | "ignore" }, i18n: ReturnType<typeof getI18nConfig>): UrlRules {
	let rules: UrlRules["i18n"] = null;
	if (i18n) {
		const aliases = Object.entries(i18n.localeAliases ?? {});
		const locales: UrlLocale[] = i18n.locales.map((path) => {
			const codes = aliases.filter(([, to]) => to === path).map(([code]) => code);
			return codes.length > 0 ? { path, codes } : path;
		});
		rules = { defaultLocale: i18n.defaultLocale, locales, prefixDefaultLocale: i18n.prefixDefaultLocale ?? false };
	}
	return { siteLocale: site.locale || "en", trailingSlash: site.trailingSlash ?? "ignore", i18n: rules };
}

/** The core's content port over EmDash's content access. */
function contentPort(ctx: PluginContext): ContentPort {
	const site = () => ctx.site.url.replace(/\/+$/, "");
	return {
		async list(collection, cursor) {
			if (!ctx.content) throw new Error("Search: EmDash gave no content access (capability content:read)");
			// Only published entries can be indexed; the core applies the rest of the skip rules.
			const page = await ctx.content.list(collection, { limit: LIST_LIMIT, ...(cursor ? { cursor } : {}), where: { status: "published" } });
			return { items: page.items as EmDashEntry[], ...(page.hasMore && page.cursor ? { nextCursor: page.cursor } : {}) };
		},
		// Paths from the listed rows: no query per entry (D1: 50 queries per run on Free, 1,000 on Paid).
		urlRules: () => urlRulesFrom(ctx.site, getI18nConfig()),
		async publicPath(collection, id) {
			const url = (await ctx.content?.getPublicUrl?.(collection, id)) ?? null;
			if (url === null) return null;
			// getPublicUrl is `${site.url}${path}`: keep the path exactly as EmDash resolved it.
			const prefix = site();
			if (prefix && url.startsWith(prefix)) return url.slice(prefix.length) || "/";
			try {
				return new URL(url).pathname;
			} catch {
				return url.startsWith("/") ? url : null;
			}
		},
		siteUrl: () => site() || null,
		defaultLocale: () => getI18nConfig()?.defaultLocale || ctx.site.locale || "en",
	};
}

/** The core's ports from one EmDash plugin context. */
export function portsFrom(ctx: PluginContext, deps: WrapperDeps): SearchPorts {
	return {
		kv: ctx.kv,
		content: contentPort(ctx),
		schema: {
			async listCollections(): Promise<CollectionInfo[]> {
				if (!ctx.schema) throw new Error("Search: EmDash gave no schema access (capability schema:read)");
				return (await ctx.schema.listCollections()).map((c) => ({
					slug: c.slug,
					label: c.label,
					supports: c.supports,
					routable: c.routable,
					hidden: c.hidden,
					urlPattern: c.urlPattern,
					fields: c.fields.map((f) => f.slug),
				}));
			},
		},
		terms: {
			// Not `ctx.taxonomies`: in EmDash 1.4 that is one query or more per entry.
			async labels(collection, ids, locale) {
				const found = await deps.getAllTermsForEntries(collection, [...ids], { locale });
				return new Map([...found].map(([id, terms]) => [id, Object.fromEntries(Object.entries(terms).map(([name, list]) => [name, list.map((t) => t.label)]))]));
			},
		},
		log: ctx.log,
		async queue(at) {
			if (!ctx.cron) throw new Error("Search: EmDash gave no cron access");
			await ctx.cron.schedule(REBUILD_SOON, { schedule: at.toISOString() });
		},
		defer(task) {
			deps.after(async () => {
				try {
					await task();
				} catch (error) {
					ctx.log.error("Search: deferred build failed", { error: String(error) });
				}
			});
		},
		now: () => Date.now(),
	};
}

function toRequest(ctx: { request: Request; input?: unknown }, method: RouteMethod): RouteRequest {
	return {
		method,
		query: new URL(ctx.request.url).searchParams,
		headers: ctx.request.headers,
		...(method === "POST" ? { body: ctx.input } : {}),
	};
}

/** One core handler as an EmDash route. The route table here is part of the security contract (plan decision 8). */
function toRoute(name: RouteName, shape: RouteHandler, handlerFor: (ctx: PluginContext) => RouteHandler): PluginRoute {
	const run = (ctx: PluginContext & { request: Request; input?: unknown }) =>
		handlerFor(ctx).handle(toRequest(ctx, ctx.request.method.toUpperCase() as RouteMethod));
	if (shape.public) {
		return {
			public: true,
			methods: [...shape.methods],
			response: "raw",
			cacheControl: PUBLIC_CACHE_CONTROL,
			handler: async (ctx) => {
				const res = await run(ctx);
				return pluginResponse({ status: res.status, headers: res.headers, body: res.body === undefined ? null : { kind: "text", value: res.body } });
			},
		};
	}
	return {
		permission: "plugins:manage",
		methods: [...shape.methods],
		handler: async (ctx) => {
			const res = await run(ctx);
			const body: unknown = res.body === undefined ? null : JSON.parse(res.body);
			if (res.status >= 400) {
				const error = (body as { error?: unknown } | null)?.error;
				const code = typeof error === "string" ? error : "SEARCH_ERROR";
				throw new PluginRouteError(code, `Search: ${name} failed (${code})`, res.status);
			}
			return body;
		},
	};
}

/** The route table, built from the core's handlers (each request gets ports from its own context). */
export function searchRoutes(options: PluginOptions = {}, deps: WrapperDeps = defaultDeps): Record<RouteName, PluginRoute> {
	// The core decides each route's name, methods and public flag; read them from a table on ports that are never called.
	const shape = createRoutes(shapePorts, options, async () => ({ started: false }));
	const routes = {} as Record<RouteName, PluginRoute>;
	for (const name of Object.keys(shape) as RouteName[]) {
		routes[name] = toRoute(name, shape[name], (ctx) => {
			const p = portsFrom(ctx, deps);
			return createRoutes(p, options, () => startRebuild(p, options))[name];
		});
	}
	return routes;
}

/** Never called: the core only reads handler shapes when no request runs. */
const unused = () => {
	throw new Error("Search: route shape ports used");
};
const shapePorts: SearchPorts = {
	kv: { get: unused, getVersioned: unused, compareAndSet: unused, set: unused, delete: unused },
	content: { list: unused, publicPath: unused, siteUrl: unused, defaultLocale: unused },
	schema: { listCollections: unused },
	log: { info: unused, warn: unused, error: unused },
	queue: unused,
	defer: unused,
	now: unused,
};

/** Schedules `tick` and `nightly`, and marks the index dirty with `force` so the next tick builds. */
async function setUp(ctx: PluginContext, deps: WrapperDeps): Promise<void> {
	if (ctx.cron) {
		await ctx.cron.schedule(TICK, { schedule: TICK_SCHEDULE });
		await ctx.cron.schedule(NIGHTLY, { schedule: NIGHTLY_SCHEDULE });
	} else ctx.log.warn("Search: EmDash gave no cron access; the index is built only by Rebuild now");
	await markDirty(portsFrom(ctx, deps), { force: true });
}

/** The `definePlugin` definition (plan decision 1). */
export function pluginDefinition(options: PluginOptions = {}, deps: WrapperDeps = defaultDeps): PluginDefinition {
	const contentHooks = Object.fromEntries(
		CONTENT_EVENTS.map((event) => [
			`content:${event}`,
			async (payload: ContentEventPayload, ctx: PluginContext) => {
				await onContentEvent(portsFrom(ctx, deps), event, payload, options);
			},
		]),
	);
	return {
		id: PLUGIN_ID,
		version: VERSION,
		capabilities: [...CAPABILITIES],
		admin: { entry: ADMIN_ENTRY, pages: ADMIN_PAGES },
		hooks: {
			...contentHooks,
			"plugin:install": async (_event, ctx) => setUp(ctx, deps),
			"plugin:activate": async (_event, ctx) => setUp(ctx, deps),
			cron: {
				timeout: CRON_TIMEOUT_MS,
				handler: async (event, ctx) => {
					const reason = CRON_REASONS[event.name];
					if (!reason) return;
					const result = await runIfDue(portsFrom(ctx, deps), options, reason);
					if (!result.ok && result.code !== "running") ctx.log.warn(`Search: build did not publish (${result.code})`, result.error ? { error: result.error } : undefined);
				},
			},
			"page:fragments": async (_event, ctx) => {
				const request = deps.getRequestContext();
				if (request?.editMode || request?.preview) return null;
				return pageFragments(configJson(await readSettings(ctx.kv)), options.filesPath);
			},
		},
		routes: searchRoutes(options, deps),
	} as PluginDefinition;
}
