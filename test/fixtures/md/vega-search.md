---
title: Home search and map
excerpt: How Vega's home search and map work, how many listings the search holds, and what the map asks for.
order: 5
---

Vega has two searches. The home search, at `/homes/`, finds homes. The small site search, at `/search/`, finds posts and pages.

## The home search

The home search runs in the visitor's browser. It fetches `/listings.json` once, then searches it there. It works the same with both content sources.

- `/listings.json` has one record for each home that is not sold. A sold home keeps its page but is not in the search.
- With Markdown, the build writes the file. With EmDash, the server makes it on each request, and a browser or CDN may keep it for a minute.
- Readers switch between Buy and Rent, type a place, filter and sort. The filters and sorts are in `src/content/fields.ts`.
- The search's address holds the filters, so a visitor can share a search.
- Later pages, at `/homes/page/<n>/`, are plain lists that need no script. So a visitor with no JavaScript still sees every home that is in the search.

## How many listings it holds

How many homes Vega handles depends on your content source:

| Content source | Recommended up to | What to watch |
| --- | --- | --- |
| Markdown (static build) | About 1,000 homes | The build. Each home gets its own share image, so a build takes about 5 minutes for every 1,000 homes. |
| EmDash (server) | About 2,500 homes | The download. Each visitor's browser loads every home for the search. Share images are made on request, so the build does not grow. |
| Your own backend | Above 2,500 homes | Keep the homes in your own database, with a search index for fast queries, and connect it with a server adapter (below). |

These are our measurements on a static build, with a phone's processor slowed down four times:

| Homes | Search file (compressed) | Results show | A filter updates | Build time |
| --- | --- | --- | --- | --- |
| 500 | 46 KB | 0.34 s | 0.07 s | 3 min |
| 1,000 | 86 KB | 0.32 s | 0.08 s | 5.5 min |
| 2,500 | 200 KB | 0.37 s | 0.09 s | 14 min |

- The search stays fast at every size we tested. It draws one page of results at a time, and the map groups its pins away from the page.
- The test homes repeat a lot of text, so their search file compresses well. Your homes have their own text, so expect a larger file, perhaps twice the size.
- The download time is not in these numbers. A larger file takes longer on a slow phone connection.
- We have not tested an EmDash server with this many homes. It builds the search file from its database on each request, and a browser or CDN may keep it for a minute.
- Nothing stops a build above these numbers. They are where we recommend you stop.

Past 2,500 homes, or with a feed that changes by the minute, use a server adapter. It asks your server for each search:

1. Write an endpoint that answers each search, on a server of your own. The theme does not ship one. The endpoint contract is in the Pro package's README.
2. In `src/components/search/SearchPage.astro`, change `source={{ index: "/listings.json" }}` to name your endpoint, such as `source={{ endpoint: "/api/search" }}`.

The results and the map work the same with either source. The Saved page still reads `/listings.json`, so keep that file.

## Saved homes and searches

Saved homes and saved searches stay in the visitor's browser. There is no account, and nothing is sent to you. `/saved/` shows them. It is left out of search engines.

## The map

A map shows on the home search, on each home's page and on each neighborhood's page. The theme uses MapLibre GL JS, which installs as a dependency, and OpenFreeMap's tiles and styles, which need no key.

`mapCenter` in the settings sets where the map starts. For its look, see [Looks](/docs/vega/looks#the-map).

### Keep the attribution

The map's attribution must stay visible. It names OpenFreeMap, OpenMapTiles and OpenStreetMap. The map data is from OpenStreetMap, under the Open Database License.

### The map's requests

When a map shows, the visitor's browser asks OpenFreeMap for the tiles and fonts. The "Map requests" section of the privacy page, `content/pages/privacy.md`, tells your visitors so. It says:

- The request carries the visitor's IP address, as any web request does.
- The site sends no name, email or saved home with it.
- The map does not ask for the visitor's location.
- Every home's address and every neighborhood's distance are also written on the page.
- The directions link on a home's page opens Google Maps, and Google receives the home's location only if the visitor clicks it.

If you change `mapStyle` to another service, update that section. Its `[FILL IN: …]` marker asks you to name the service. If you did not change the style, delete the marker.

## Site search

`/search/` covers posts and pages. With Markdown, the build indexes them with Pagefind, so it works on the built site, not in `pnpm dev`. With EmDash, the search page asks EmDash on each request.
