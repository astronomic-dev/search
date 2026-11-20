---
title: Content
excerpt: Edit Agency's content in Markdown, or switch it to EmDash.
order: 2
---

## Markdown

By default, the content is in Markdown, JSON and YAML files in `content/`:

- `content/projects/`: case studies.
- `content/services/`: services.
- `content/team/`: team members.
- `content/testimonials/`: client quotes.
- `content/posts/`: journal posts.
- `content/pages/`: pages such as About and Privacy.
- `content/clients.json`: clients.
- `content/home.yaml`: the home page sections, in order. Move an item to reorder the page.
- `content/site.json`: studio details, such as name, email, address and availability.
- `content/menus.json` and `content/taxonomies.json`: menus and taxonomies.
- `content/media/`: images.

## Journal posts

A post has a `title`, a `date` and an `excerpt`. It may also have an `updated` date, for when you change it later. When `updated` is on a later day than `date`, the post shows an "Updated" row, and the sitemap and the structured data use it. See [Search and sharing](/docs/agency/seo#dates).

Set `noindex: true` on a post, a case study, a service or a page to keep it out of search engines, the sitemap and site search.

## Switch to EmDash

EmDash is a CMS built on Astro, with an admin UI. To use it, change the source in `astro.config.mjs`:

```js
const content = await contentSource(process.env.CONTENT_SOURCE ?? "emdash", import.meta.url);
```

Then load the demo content and images into a local database (`data.db`):

```sh
pnpm seed:emdash
pnpm dev
```

The admin UI is at `http://localhost:4321/_emdash/admin`.

`pnpm test:parity` builds the site from each source and checks that they give the same content and pages.

With Markdown, the build is a static site. With EmDash, the build is a server app for Node. See [Deploy](/docs/agency/deploy). For a longer comparison, read [Markdown or EmDash](/learn/markdown-or-emdash).

## Contact form

The theme has no form endpoint of its own. `/contact` shows a form only when `contactFormAction` is set in `content/site.json`. In EmDash, this is the "Contact form URL" field of the Studio details. Without it, the page shows the email.

The demo sets `https://example.com/contact-form`, a placeholder. Until your site is live, a placeholder address gets a demo form: it sends nothing and says so. On a live site (a real `SITE_URL`, or any EmDash server), no form renders on a placeholder address, and the log says why. The same goes for the sample email (`example.com`), links on `example.com`, and social links with no username such as `https://github.com`: a live site leaves each one out, and a logo keeps its picture with no link. With no real form and no real email, `/contact` says the studio is still setting them up and shows any phone, address and availability you set. Text you write in a page's body is left as it is, so check it for sample addresses. Replace it with the URL from your form service, or leave it empty. The form posts `name`, `email` and `message`.

After a message is sent, send people to `/contact/thanks`. Most form services take this redirect URL in their own settings. Enter the full address, for example `https://example.com/contact/thanks`. If you set `site` in `astro.config.mjs`, the form also sends a hidden `_next` field with that address. Some services read it, others ignore it.

## Availability

`availability` in `content/site.json` takes a `status` (`open`, `limited` or `closed`), a `label`, and an optional `detail`: one short line under the label on `/contact`. In EmDash, these are the `availability_status`, `availability_label` and `availability_detail` fields.

## Privacy page

The privacy page is demo text for a made-up studio. It is in `content/pages/privacy.md`, and in the `privacy` page of the EmDash seed. Do not publish it as it is. Its claims must match your own setup, and its rights section is written for a US studio, naming state privacy laws such as California's in general terms. Change the studio name, address and email too. If you are not sure what your policy must say, ask someone who knows the privacy law where you work.

## The /system page

Run `pnpm dev`, then open `/system`. It shows the colors, type, components and sections. A build leaves it out unless you set `ASTRONOMIC_SYSTEM=1`.
