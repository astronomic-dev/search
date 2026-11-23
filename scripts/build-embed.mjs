/**
 * Builds the embed: the search for a page that is not built with Astro and gives its settings at run time. Two esbuild
 * runs:
 * 1. the lazy entries (embed-app, embed-results) into chunks/, hashed, each one whole file with no chunk shared between
 *    them: the boot retries a failed load from the entry's URL with a fresh query, which refetches the entry only, so
 *    the entry must be its whole graph (a browser may keep a failed import of a shared chunk under its URL);
 * 2. the boot (src/browser/embed.ts) alone as search-embed.js, no splitting, with the app and results chunks' paths
 *    from run 1's metafile defined as __SEARCH_EMBED_APP__ and __SEARCH_EMBED_RESULTS__ (loaded relative to the boot's
 *    own URL). Both runs minify the sources' stylesheets (minifyCss).
 * It also writes engine.json (the engine the chunks carry) and files.json (every file written, for a server to copy).
 * It builds into a staging folder beside the output and swaps it in only once files.json and the chunk graph check
 * out, so a failed build leaves the previous output as it was. It refuses an output folder that is not safe to replace
 * (checkOutDir). Build-only tooling, never in dist/.
 * Usage: node scripts/build-embed.mjs [outDir]   (outDir from the current folder; default the package's dist/embed)
 */
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { minifyCss } from "./compile.mjs";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const BOOT = "search-embed.js";
const common = { bundle: true, metafile: true, format: "esm", minify: true, target: "es2022", logLevel: "error", legalComments: "none" };

/** The repo root: the nearest folder above the package with a .git (a folder, or a worktree's file). */
function repoRoot() {
	for (let at = dirname(pkg); at !== dirname(at); at = dirname(at)) if (existsSync(join(at, ".git"))) return at;
	return resolve(pkg, "../..");
}

/**
 * The real path of `p` (absolute, or from the current folder) as the file system resolves it: symlinks followed and
 * each ".." taken after the link before it, so "/work/link/../site" is the site next to the link's target. A part that
 * does not exist yet is joined to its parent's real path.
 * @param {string} p
 * @returns {string}
 */
export function realPath(p) {
	if (!isAbsolute(p)) p = `${process.cwd()}/${p}`;
	try {
		// .native: the JS realpathSync takes each ".." before it follows a link.
		return realpathSync.native(p);
	} catch (e) {
		if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT" || dirname(p) === p) throw e;
		return join(realPath(dirname(p)), basename(p));
	}
}

/** Whether `dir` is `other` or a folder above it. */
const isAtOrAbove = (dir, other) => {
	const rel = relative(dir, other);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Whether `dir` (not empty) holds a previous embed build: its files.json names the boot. */
export function isEmbedBuild(dir) {
	try {
		const previous = JSON.parse(readFileSync(join(dir, "files.json"), "utf8"));
		return previous?.boot === BOOT && Array.isArray(previous.files);
	} catch {
		return false;
	}
}

/**
 * Throws unless `out` (absolute) is safe to replace: not the current folder, the package, the repo root or any folder
 * above them, and either missing, empty or a previous build of the caller's (`isPrevious`; by default an embed build,
 * whose files.json names the boot). The browser fixture build (test/browser/embed-build.mjs) passes its own check.
 * Every check is on the real path (realPath), and the caller writes and deletes only the path this returns.
 * @param {string} out
 * @param {(dir: string) => boolean} [isPrevious]
 * @param {string} [what] the build's name in the error
 * @returns {string} the real path of `out`
 */
export function checkOutDir(out, isPrevious = isEmbedBuild, what = `an embed build (no files.json naming ${BOOT})`) {
	const dir = realPath(out);
	for (const [name, other] of [["the current folder", process.cwd()], ["the package", pkg], ["the repo root", repoRoot()]]) {
		if (isAtOrAbove(dir, realPath(other))) throw new Error(`build-embed: refusing to empty ${dir}: it is or holds ${name}`);
	}
	if (!existsSync(dir) || !readdirSync(dir).length) return dir;
	if (!isPrevious(dir)) throw new Error(`build-embed: refusing to empty ${dir}: it is not empty and not ${what}`);
	return dir;
}

/**
 * engine.json from the engine the chunks bundle: createMinisearchEngine() and SCHEMA, compiled with esbuild (no .ts
 * import at run time, so this runs on a Node with no type stripping).
 */
async function engineMeta() {
	const meta = await build({
		stdin: {
			contents: `import { createMinisearchEngine } from "./src/core/minisearch.ts"; import { SCHEMA } from "./src/core/types.ts"; const e = createMinisearchEngine(); export default { schema: SCHEMA, engine: e.name, engineVersion: e.version };`,
			resolveDir: pkg,
			loader: "ts",
		},
		bundle: true,
		format: "esm",
		platform: "node",
		write: false,
		logLevel: "error",
	});
	const code = meta.outputFiles[0]?.text ?? "";
	return (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)).default;
}

/** @param {string} dir */
const listFiles = (dir) =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => relative(dir, join(e.parentPath, e.name)).split("\\").join("/"))
		.sort();

/** The lazy entries: each one's name in chunks/, its source, and the define that carries its path into the boot. */
const LAZY = [
	{ name: "embed-app", source: "src/browser/embed-app.ts", define: "__SEARCH_EMBED_APP__" },
	{ name: "embed-results", source: "src/browser/embed-results.ts", define: "__SEARCH_EMBED_RESULTS__" },
];

/**
 * Throws unless `dir` holds a whole build: files.json names the boot and lists exactly the files in the folder, the
 * boot names every lazy entry's chunk, and every relative import in every script resolves to a listed file.
 * @param {string} dir
 * @param {string[]} chunks the lazy entries' chunk paths, relative to dir
 */
function checkBuild(dir, chunks) {
	const fail = (why) => {
		throw new Error(`build-embed: incomplete build in ${dir}: ${why}`);
	};
	let manifest = null;
	try {
		manifest = JSON.parse(readFileSync(join(dir, "files.json"), "utf8"));
	} catch {
		fail("no readable files.json");
	}
	if (manifest.boot !== BOOT || !Array.isArray(manifest.files)) fail(`files.json does not name ${BOOT}`);
	const listed = new Set(manifest.files);
	if (JSON.stringify([...manifest.files].sort()) !== JSON.stringify(listFiles(dir))) fail("files.json does not match the folder");
	for (const f of [BOOT, ...chunks, "engine.json", "files.json"]) if (!listed.has(f)) fail(`${f} is missing`);
	const boot = readFileSync(join(dir, BOOT), "utf8");
	for (const f of chunks) if (!boot.includes(JSON.stringify(`./${f}`))) fail(`${BOOT} does not name ./${f}`);
	for (const f of manifest.files.filter((f) => f.endsWith(".js"))) {
		for (const m of readFileSync(join(dir, f), "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
			const to = join(dirname(f), m[1]).split("\\").join("/");
			if (!listed.has(to)) fail(`${f} imports ${m[1]}, which is not written`);
		}
	}
}

/**
 * @param {string} [outDir] relative to the package folder, or absolute
 * @param {{ afterApp?: () => void | Promise<void> }} [hooks] afterApp runs between the two esbuild runs (for tests)
 * @returns {Promise<{ files: string[] }>}
 */
export async function buildEmbed(outDir = "dist/embed", hooks = {}) {
	// Not resolve(): it would take a ".." before the file system follows a symlink (see realPath).
	const out = checkOutDir(isAbsolute(outDir) ? outDir : pkg + outDir);
	mkdirSync(dirname(out), { recursive: true });
	// A sibling, so the swap is a rename on one file system. A plain mkdir, so the output gets the umask's permissions.
	const stage = sibling(out, "staging");
	mkdirSync(stage);
	try {
		const chunks = await buildInto(stage, hooks);
		const files = [...listFiles(stage), "files.json"].sort();
		writeFileSync(join(stage, "files.json"), JSON.stringify({ boot: BOOT, files }));
		checkBuild(stage, chunks);
		// Again: another process may have put its own files there during the build.
		checkOutDir(out);
		swapIn(stage, out);
		return { files };
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

/**
 * Writes the boot, the chunks and engine.json into `dir`; returns the lazy entries' chunk paths, relative to dir.
 * @param {string} dir
 * @param {{ afterApp?: () => void | Promise<void> }} hooks
 */
async function buildInto(dir, hooks) {
	// Run 1: the lazy entries, each bundled whole (see the file comment), hashed.
	const lazy = await build({
		...common,
		absWorkingDir: pkg,
		entryPoints: Object.fromEntries(LAZY.map((e) => [e.name, e.source])),
		splitting: false,
		outdir: dir,
		entryNames: "chunks/[name]-[hash]",
		plugins: [minifyCss],
	});
	/** @type {Record<string, string>} each entry's output path, relative to dir */
	const entries = {};
	for (const [path, meta] of Object.entries(lazy.metafile.outputs)) {
		if (meta.entryPoint) entries[meta.entryPoint] = relative(dir, resolve(pkg, path)).split("\\").join("/");
	}
	const chunks = LAZY.map((e) => {
		const path = entries[e.source];
		if (!path) throw new Error(`build-embed: no ${e.name} output in the metafile (${Object.keys(entries).join(", ")})`);
		return path;
	});
	await hooks.afterApp?.();

	// Run 2: the boot alone, with the chunk paths it loads.
	await build({
		...common,
		absWorkingDir: pkg,
		entryPoints: ["src/browser/embed.ts"],
		outfile: join(dir, BOOT),
		define: Object.fromEntries(LAZY.map((e, i) => [e.define, JSON.stringify(`./${chunks[i]}`)])),
		plugins: [minifyCss],
	});

	const { schema, engine, engineVersion } = await engineMeta();
	writeFileSync(join(dir, "engine.json"), JSON.stringify({ schema, engine, engineVersion }));
	return chunks;
}

/**
 * A new, unused path beside `out`, named for `what`.
 * @param {string} out
 * @param {string} what
 */
const sibling = (out, what) => join(dirname(out), `.${basename(out)}-${what}-${randomUUID().slice(0, 8)}`);

/**
 * Replaces `out` with `stage`. The old output moves aside first and comes back if the second rename fails.
 * @param {string} stage
 * @param {string} out
 */
function swapIn(stage, out) {
	if (!existsSync(out)) return renameSync(stage, out);
	const old = sibling(out, "old");
	renameSync(out, old);
	try {
		renameSync(stage, out);
	} catch (e) {
		renameSync(old, out);
		throw e;
	}
	rmSync(old, { recursive: true, force: true });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	await buildEmbed(process.argv[2] ? realPath(process.argv[2]) : undefined);
}
