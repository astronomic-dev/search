/**
 * The virtual modules the integration's Vite plugin serves. A recipe that reads `virtual:astronomic-search/assets`
 * gets these types from `@astronomic-dev/search/astro/virtual`.
 *
 * Types come in through `import("…")` types: an `import` statement inside `declare module` may not use a relative
 * path (TS2439), and the build points these at the ".js" files next to this one in dist/.
 */
declare module "virtual:astronomic-search/specs" {
	const specs: {
		sources: import("./build.ts").RouteSpec[];
		urlOptions: import("../core/url.ts").UrlOptions;
		defaultLocale: string;
		locales: string[];
	};
	export default specs;
}

declare module "virtual:astronomic-search/assets" {
	/**
	 * The script and manifest URLs (base applied), the default index, the shortcut, the browse links and the `strings`
	 * setting (overrides only; a recipe fills the rest from the US English defaults).
	 */
	const assets: {
		boot: string;
		app: string;
		manifest: string;
		index: string;
		shortcut: { keys: string[] } | false;
		browse: { label: string; href: string }[];
		strings: import("../controller/strings.ts").StringsInput;
	};
	export default assets;
}
