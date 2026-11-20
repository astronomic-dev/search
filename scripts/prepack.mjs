/**
 * Runs before `pnpm pack` and `pnpm publish`. pnpm swaps in publishConfig.exports (the dist/ entry points); npm does
 * not, and would publish entry points into src/, which the package does not hold. So: pnpm only, then build.
 */
if (!(process.env.npm_config_user_agent ?? "").startsWith("pnpm/")) {
	console.error("Pack and publish this package with pnpm (pnpm pack, pnpm publish). npm ignores publishConfig.exports.");
	process.exit(1);
}
await import("./build.mjs");
