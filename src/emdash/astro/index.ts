/**
 * `searchFiles()`: the Astro integration that puts the search embed's files into an EmDash site, so the site serves
 * every file itself. The plugin's `page:fragments` prints the boot's URL (`/_search/embed/search-embed.js?ver=...`);
 * this integration makes that URL answer.
 *
 * - `astro build`: copies the embed build (`search-embed.js`, `chunks/`, `engine.json`, `files.json`) into the build's
 *   client folder under the path. The previous build's files are kept for one more release: a boot cached for its
 *   300 s, or an open tab, still loads the old (hashed) chunk names. Astro empties its output folder before a build, so
 *   each build also saves its files in Astro's cache folder (`astronomic-search-files/`), and the next build copies the
 *   ones it no longer lists back in. Where the cache folder does not survive between builds (a fresh CI checkout), only
 *   the new build's files ship. Only files a previous build wrote are ever removed, and no path through a symlink is
 *   written.
 * - Cloudflare adapter: also writes the folder's cache rules to `_headers` (chunks a year, the rest short).
 * - `astro dev`: serves the same files from a Vite middleware.
 *
 * The files come from the package's `dist/embed/` (an install). From `src/` (this repo and its tests) the embed is
 * built on the fly into the site's cache folder by `scripts/build-embed.mjs`, which `dist/` never imports.
 */
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

export interface SearchFilesOptions {
	/**
	 * The URL path the embed's files are served at. Must match the plugin's `filesPath`. Default `/_search/embed/`.
	 * A site `base` is not supported yet.
	 */
	path?: string;
}

/** The boot's fixed name (scripts/build-embed.mjs). */
export const BOOT = "search-embed.js";
export const DEFAULT_FILES_PATH = "/_search/embed/";

const START = "# astronomic-search:start";
const END = "# astronomic-search:end";

/** The extension of this package's own files: ".ts" from src/, ".js" from dist/. */
const OWN_EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
/** The build-only embed builder, for src/ only. A variable, so no bundler that reads dist/ tries to resolve it. */
const DEV_BUILDER = "../../../scripts/build-embed.mjs";

interface FilesList {
	boot: string;
	files: string[];
	/** Files of the release before, kept beside this one (written by copyEmbed, so the next build may remove them). */
	kept?: string[];
}

/** A relative path with no empty, "." or ".." part and no backslash. */
const safeRel = (f: unknown): f is string => typeof f === "string" && f !== "" && !f.includes("\\") && f.split("/").every((p) => p !== "" && p !== "." && p !== "..");

/** The folder's files.json when it is an embed build, else null. */
async function readList(dir: string): Promise<FilesList | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(join(dir, "files.json"), "utf8"));
	} catch {
		return null;
	}
	const list = parsed as Partial<FilesList> | null;
	if (list?.boot !== BOOT || !Array.isArray(list.files) || !list.files.every(safeRel)) return null;
	const kept = Array.isArray(list.kept) ? list.kept.filter(safeRel) : [];
	return { boot: list.boot, files: list.files, kept };
}

/**
 * Throws when any part of `rel` under `dir` is a symlink, and `dir` itself unless `self` is false: a write or delete
 * there would land elsewhere. Each segment is checked from `dir` down, so a linked parent folder is caught too.
 */
async function refuseLinks(dir: string, rel: string, self = true): Promise<void> {
	let at = dir;
	for (const part of [...(self ? [""] : []), ...rel.split("/").filter((p) => p !== "")]) {
		at = part === "" ? at : join(at, part);
		let link = false;
		try {
			link = (await lstat(at)).isSymbolicLink();
		} catch {
			return; // Missing: nothing below it exists either.
		}
		if (link) throw new Error(`Search: ${at} is a symlink; searchFiles() does not write through links`);
	}
}

/** Every file under `dir`, relative, with "/" separators; [] when it does not exist. */
async function listFiles(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { recursive: true, withFileTypes: true });
		return entries
			.filter((e) => e.isFile())
			.map((e) => relative(dir, join(e.parentPath, e.name)).split("\\").join("/"))
			.sort();
	} catch {
		return [];
	}
}

/**
 * Checks the option and returns it; the path must start and end with "/" and have a folder. A site `base` other than
 * "/" is refused: the plugin's config and index URLs (`/_emdash/...`) do not carry it yet.
 */
export function checkFilesPath(path: string, base: string): string {
	if (base !== "/" && base !== "") throw new Error(`Search: searchFiles does not support a site base yet (base is ${JSON.stringify(base)})`);
	const parts = path.split("/").slice(1, -1);
	if (!path.startsWith("/") || !path.endsWith("/") || parts.length === 0 || !parts.every((p) => safeRel(p))) {
		throw new Error(`Search: searchFiles({ path }) must be a folder path such as "${DEFAULT_FILES_PATH}" (got ${JSON.stringify(path)})`);
	}
	return path;
}

/**
 * Copies the embed build in `from` into `to`, with the release before kept: the files `to`'s own files.json lists, and
 * the files of `cache` (the previous build, saved there) that this build does not list. Removes only files a previous
 * files.json in `to` listed or kept and this one keeps no more; any other file there is left alone. Refuses a `to` that
 * holds files but is not an embed build, and any path through a symlink, from `root` (the Astro output folder, which
 * holds `to`) down: a linked `<root>/_search` is refused before anything is read, written or removed. Writes files.json
 * last, then saves this build in `cache`.
 */
export async function copyEmbed(from: string, to: string, cache?: string, root?: string): Promise<{ copied: number; kept: number; removed: number }> {
	const list = await readList(from);
	if (!list) throw new Error(`Search: ${from} is not an embed build (no files.json naming ${BOOT}); rebuild the package`);
	if (root !== undefined) {
		const under = relative(root, to).split("\\").join("/");
		if (under === "" || under.startsWith("..") || isAbsolute(under)) throw new Error(`Search: ${to} is not inside the output folder ${root}`);
		await refuseLinks(root, under, false);
	}
	await refuseLinks(to, "");
	const there = new Set(await listFiles(to));
	const inTo = await readList(to);
	if (there.size > 0 && !inTo) throw new Error(`Search: ${to} holds files but is not an embed build; remove it, or set searchFiles({ path }) and the plugin's filesPath to another folder`);
	const saved = cache ? await readList(cache) : null;
	const fresh = new Set(list.files);
	const restore = (saved?.files ?? []).filter((f) => !fresh.has(f) && !there.has(f));
	const keepThere = [...new Set([...(inTo?.files ?? []), ...(saved?.files ?? [])])].filter((f) => !fresh.has(f) && there.has(f));
	const keptList = [...new Set([...keepThere, ...restore])].sort();
	const keep = new Set([...fresh, ...keptList]);
	const remove = [...(inTo?.files ?? []), ...(inTo?.kept ?? [])].filter((f) => !keep.has(f) && there.has(f));
	const order = [...list.files.filter((f) => f !== "files.json"), "files.json"];
	for (const f of [...remove, ...restore, ...order]) await refuseLinks(to, f);
	for (const f of remove) await rm(join(to, f), { force: true });
	const put = async (src: string, f: string) => {
		await mkdir(dirname(join(to, f)), { recursive: true });
		await copyFile(src, join(to, f));
	};
	let restored = 0;
	for (const f of restore) {
		try {
			await put(join(cache!, f), f);
			restored++;
		} catch {
			keptList.splice(keptList.indexOf(f), 1); // Gone from the cache: the old release just loses that file.
		}
	}
	for (const f of order.slice(0, -1)) await put(join(from, f), f);
	const json = JSON.parse(await readFile(join(from, "files.json"), "utf8")) as FilesList;
	if (keptList.length > 0) json.kept = keptList;
	await writeFile(join(to, "files.json"), keptList.length > 0 ? JSON.stringify(json) : await readFile(join(from, "files.json")));
	if (cache) {
		await rm(cache, { recursive: true, force: true });
		for (const f of order) {
			await mkdir(dirname(join(cache, f)), { recursive: true });
			await copyFile(join(from, f), join(cache, f));
		}
	}
	return { copied: order.length, kept: keepThere.length + restored, removed: remove.length };
}

/** The `_headers` block for the folder: chunks a year; the boot, engine.json and files.json short. */
export function headersBlock(path: string): string {
	return [
		START,
		`${path}*`,
		"  Cache-Control: public, max-age=31536000, immutable",
		"",
		...[BOOT, "engine.json", "files.json"].flatMap((f) => [`${path}${f}`, "  ! Cache-Control", "  Cache-Control: public, max-age=300", ""]),
		END,
	].join("\n");
}

/** Writes (or replaces) the block in the client folder's `_headers`, keeping every other rule. */
export async function writeHeaders(dir: string, path: string): Promise<void> {
	const file = join(dir, "_headers");
	let text = "";
	try {
		text = await readFile(file, "utf8");
	} catch {
		// No _headers yet.
	}
	const block = headersBlock(path);
	const at = text.indexOf(START);
	const end = text.indexOf(END, at);
	if (at >= 0 && end >= 0) text = text.slice(0, at) + block + text.slice(end + END.length);
	else text = text === "" ? `${block}\n` : `${text.replace(/\n*$/, "\n\n")}${block}\n`;
	await writeFile(file, text);
}

const TYPES: Record<string, string> = { ".js": "text/javascript", ".json": "application/json" };

/** The embed's files, by name, for `astro dev`: a middleware for `path`. */
export function filesMiddleware(path: string, source: () => Promise<string>, onError: (m: string) => void) {
	return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
		const url = (req.url ?? "").split("?")[0] ?? "";
		if (!url.startsWith(path)) return next();
		const name = url.slice(path.length);
		const send = (status: number, type: string, body: string | Buffer) => {
			res.statusCode = status;
			res.setHeader("content-type", type);
			res.setHeader("cache-control", "no-cache");
			res.end(req.method === "HEAD" ? undefined : body);
		};
		source()
			.then(async (dir) => {
				const list = await readList(dir);
				if (!list || !list.files.includes(name)) return send(404, "text/plain", `Search: no embed file ${name}`);
				const ext = name.slice(name.lastIndexOf("."));
				send(200, TYPES[ext] ?? "application/octet-stream", await readFile(join(dir, name)));
			})
			.catch((e: unknown) => {
				const message = e instanceof Error ? e.message : String(e);
				onError(message);
				send(500, "text/plain", message);
			});
	};
}

/** Puts the search embed's files into the site: copied at build time, served in `astro dev`. */
export function searchFiles(options: SearchFilesOptions = {}): AstroIntegration {
	const wanted = options.path ?? DEFAULT_FILES_PATH;
	let path = wanted;
	let cacheDir = "";
	let cloudflare = false;
	let source: Promise<string> | null = null;

	/** The folder that holds the embed build: dist/embed/ from an install, built once into the cache from src/. */
	const embedDir = (): Promise<string> => {
		if (OWN_EXT === ".js") return Promise.resolve(fileURLToPath(new URL("../../embed/", import.meta.url)));
		// src/ only (never dist/): a prebuilt embed folder, so a test can build twice with different chunk names.
		const given = process.env.ASTRONOMIC_SEARCH_EMBED_FROM;
		if (given) return Promise.resolve(given);
		source ??= (async () => {
			const out = join(cacheDir, "astronomic-search-embed");
			const { buildEmbed } = (await import(new URL(DEV_BUILDER, import.meta.url).href)) as { buildEmbed: (dir: string) => Promise<unknown> };
			await buildEmbed(out);
			return out;
		})();
		const mine = source;
		mine.catch(() => {
			if (source === mine) source = null;
		});
		return mine;
	};

	return {
		name: "@astronomic-dev/search/emdash/astro",
		hooks: {
			"astro:config:setup": ({ config }) => {
				cacheDir = fileURLToPath(config.cacheDir);
				path = checkFilesPath(wanted, config.base);
			},
			"astro:config:done": ({ config }) => {
				cloudflare = config.adapter?.name === "@astrojs/cloudflare";
			},
			"astro:server:setup": ({ server, logger }) => {
				server.middlewares.use(filesMiddleware(path, embedDir, (m) => logger.error(m)));
			},
			"astro:build:done": async ({ dir, logger }) => {
				const out = fileURLToPath(dir);
				const to = join(out, path.slice(1));
				const { copied, kept } = await copyEmbed(await embedDir(), to, join(cacheDir, "astronomic-search-files"), out);
				if (cloudflare) await writeHeaders(out, path);
				logger.info(`Search: ${copied} embed files in ${path}${kept ? ` (${kept} from the previous release kept)` : ""}${cloudflare ? ", cache rules in _headers" : ""}`);
			},
		},
	};
}
