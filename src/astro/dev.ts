/**
 * The dev server's `/_search/*`: the scripts from memory, and the manifest and index files built on request from the
 * dev server's own records route plus the hooks. There is no built HTML in dev, so html() sources give nothing.
 * Any watched file change drops the cache.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AstroIntegrationLogger, HookParameters } from "astro";
import type { EngineFactory } from "../core/types.ts";
import type { UrlOptions } from "../core/url.ts";
import { collectRecords, hasCollections, searchDir, writeIndexes, type RouteData, type Settings } from "./build.ts";
import { MANIFEST, type Bundle } from "./bundle.ts";

export interface DevOptions {
	settings: Settings;
	bundle: Bundle;
	engine: EngineFactory;
	urlOptions: UrlOptions;
	defaultLocale: string;
	logger: AstroIntegrationLogger;
}

const RECORDS = "__records.json";

/** The part of the dev server `devOrigin` reads. */
export interface DevAddress {
	resolvedUrls: { local: string[]; network: string[] } | null;
	config: { server: { port?: number } };
}

/**
 * The dev server's own origin, for fetching its records route. Never from a request's Host header: a forged one (DNS
 * rebinding) would make the server fetch from another host and cache what it gave.
 */
export function devOrigin(server: DevAddress): string {
	const local = server.resolvedUrls?.local[0];
	if (local) return new URL(local).origin;
	return `http://localhost:${server.config.server.port ?? 4321}`;
}

export function devMiddleware(server: HookParameters<"astro:server:setup">["server"], o: DevOptions): void {
	const dir = searchDir(o.urlOptions.base);
	let cache: Promise<Map<string, string>> | null = null;
	let htmlLogged = false;
	server.watcher.on("all", () => {
		cache = null;
	});

	const build = async (origin: string): Promise<Map<string, string>> => {
		let route: RouteData | null = null;
		if (hasCollections(o.settings)) {
			const res = await fetch(`${origin}${dir}${RECORDS}`);
			if (!res.ok) throw new Error(`Search: ${dir}${RECORDS} returned ${res.status}`);
			route = (await res.json()) as RouteData;
		}
		const byIndex = await collectRecords(o.settings, {
			route,
			scan: async () => {
				if (!htmlLogged) o.logger.info("html() sources give no records in dev (there are no built pages); run a build to see them");
				htmlLogged = true;
				return [];
			},
			urlOptions: o.urlOptions,
			defaultLocale: o.defaultLocale,
			warn: (m) => o.logger.warn(m),
		});
		const out = writeIndexes(byIndex, o.settings, o.engine, { base: o.urlOptions.base, defaultLocale: o.defaultLocale, urlOptions: o.urlOptions, dev: true });
		for (const w of out.warnings) o.logger.warn(w);
		const files = new Map(out.files.map((f) => [f.name, f.body]));
		files.set(MANIFEST, JSON.stringify(out.manifest));
		return files;
	};

	server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
		const path = (req.url ?? "").split("?")[0] ?? "";
		const name = path.startsWith(dir) ? path.slice(dir.length) : path.startsWith("/_search/") ? path.slice("/_search/".length) : null;
		if (name === null || name === RECORDS || name.includes("/")) return next();
		const send = (type: string, body: string, cacheControl = "no-cache") => {
			res.setHeader("content-type", type);
			res.setHeader("cache-control", cacheControl);
			res.end(body);
		};
		for (const script of [o.bundle.boot, o.bundle.app]) if (name === script.name) return send("text/javascript", script.code);
		if (!name.endsWith(".json")) return next();
		cache ??= build(devOrigin(server));
		const mine = cache;
		mine
			.then((files) => {
				const body = files.get(name);
				if (body === undefined) {
					res.statusCode = 404;
					return send("text/plain", `Search: no file ${name}`);
				}
				send("application/json", body);
			})
			.catch((e: unknown) => {
				if (cache === mine) cache = null;
				const message = e instanceof Error ? e.message : String(e);
				o.logger.error(message);
				res.statusCode = 500;
				send("text/plain", message);
			});
	});
}
