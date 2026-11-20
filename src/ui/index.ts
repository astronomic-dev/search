/**
 * The ui layer: the default Classic dialog, <astronomic-search>. It renders its own markup in a shadow root, themed
 * by --search-* custom properties and restyled by `part`, and uses the controller and the dom layer like any recipe.
 * It never grows a Pro layout: Pro and kit recipes build on the controller and dom layers instead.
 */
export { defineSearchElement, SearchElement, TAG, triggerKey, type ElementConfig } from "./element.ts";
export { marked, renderFacets, renderMessage, renderResults, renderShell, renderTabs, type BrowseLink, type RenderContext, type Shell } from "./render.ts";
export { css, styleSheet } from "./styles.ts";
