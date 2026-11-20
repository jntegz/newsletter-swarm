# Your publication's website

Every publication gets a website the moment it is created. It lives at `<address>.<your site domain>` (the dashboard shows the exact link under **Website → General**), and you can put it on your own domain later. Posts appear on it when you publish them to the web; nothing else is needed.

The website is built to be fast and private. Pages are rendered on the server and cached at the edge, they run no JavaScript of their own, and they load nothing from other companies: fonts, styles and images all come from your site.

This guide covers everything under **Website** in the dashboard.

## What is on the site

| Address               | What it is                                                                      |
| --------------------- | ------------------------------------------------------------------------------- |
| `/`                   | The home page: your latest posts and a signup form                              |
| `/archive`            | Every post, newest first, with a **Top** tab for the most read                  |
| `/p/<post>`           | A post                                                                          |
| `/about`              | Your About page                                                                 |
| `/s/<section>`        | The posts in one section                                                        |
| `/<page>`             | A page you made (see [Pages](#pages))                                           |
| `/search`             | Search across your posts                                                        |
| `/subscribe`          | The plans page: free and paid plans                                             |
| `/feed`, `/feed.json` | RSS and JSON feeds                                                              |
| `/sitemap`            | A list of every page for readers; `/sitemap.xml` is the same for search engines |

Every page has a **Subscribe** button in the header and a signup form near the bottom, so a visitor can always join from where they are.

## Logo and accent colour

**Website → Branding → Logo and accent colour.**

- **Logo.** A square image, at least 256 pixels across. It shows beside your publication's name in the header, as the browser tab icon, on the Link Hub page and on shared links that have no picture of their own. Choose one from your media library or upload a new one. Without a logo, the tab icon is your publication's initial on the accent colour.
- **Accent colour.** Used for buttons and links. Pick any colour: the site keeps it readable for you. Button text turns black or white, whichever reads better, and links are darkened on light pages (or lightened on dark ones) until they pass the usual contrast standard. The colour you picked is still used, unchanged, for buttons.

Both belong to the publication, so your emails and signup forms use the same logo and colour. You set them once. They can also be changed in the publication's settings.

## Templates

**Website → Branding → Template.** A template is the design of your home page and archive. Post pages keep the same reading layout in all of them, with the template's typeface. You can switch at any time; your posts, pages and settings stay as they are.

| Template           | What a visitor sees first                                                                       | Good for                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Current layout** | The standard home page: your latest posts as cards or as headlines (chosen under General)       | A simple start, before you pick a look                              |
| **Gate**           | One screen with your name, a sentence and the signup form. Past posts are a link away           | New publications, and anyone who wants signups before anything else |
| **Letter**         | A single quiet column in a serif face: a short introduction, the signup form, then a dated list | Personal essays and letters from one writer                         |
| **Magazine**       | A bold masthead, the newest post as a large lead story, then a grid of posts with their images  | Publications with pictures and several posts a week                 |
| **Newspaper**      | A centred masthead between rules, a lead story beside a column of headlines, then dense columns | News, links and digests where headlines matter more than images     |
| **Launch**         | A sales page: a large headline, what subscribers get, and the signup form in a coloured panel   | Paid newsletters, courses and anything you are announcing           |

A subscriber who is signed in sees your posts instead of the signup screen on Gate, and no signup form on Letter and Launch.

Every template works on phones, follows the reader's light or dark setting, and shows a tidy "first issue is on its way" message with the signup form while you have no posts yet.

### Template settings

These appear once you choose a template.

| Setting                       | What it does                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Headline**                  | The large heading on the home page. Empty uses your publication's name. Up to 120 characters.                                                                                              |
| **Pitch**                     | The line under it. Empty uses your publication's description. Up to 400 characters.                                                                                                        |
| **What subscribers get**      | Launch only. One benefit per line, up to 6.                                                                                                                                                |
| **Show the subscriber count** | Adds "Read by 1,234 subscribers" to the home page. It only shows from 100 subscribers, because a small number says little.                                                                 |
| **Template font**             | Each template has a font chosen for it. You can pick Grotesk (warm and confident), Archivo (strong at large sizes) or Serif (bookish, uses a font already on the reader's device) instead. |
| **Page colour**               | The background of every page. With your own page colour the site keeps that colour for every reader instead of switching between light and dark, and picks light or dark text to match.    |
| **Text colour**               | The colour of headings and text. It is used wherever it is readable: a dark text colour is left out of the dark scheme so text never disappears.                                           |
| **Custom CSS**                | Your own style rules, added after the template's. Admins only. See [Custom CSS](#custom-css).                                                                                              |

### Type and colour scheme

These apply with or without a template.

- **Font** (Current layout only): Geist or Inter. Both use the copy on the reader's device when there is one, and a system font otherwise.
- **Colour scheme**: follow the reader's device (the default), always light, or always dark.
- **Drop caps**: starts each post with a large first letter.

## Home page

**Website → General.**

- **Layout** (Current layout only): **Magazine** shows the newest post as a wide card and the rest as a grid; **Newspaper** shows a lead story beside a column of headlines.
- **Pinned posts**: up to 3 posts shown first on the home page, in the order you set. Use them for a welcome post or your best work.
- **Previous and next links**: adds links to the neighbouring posts at the end of each post.

## Navigation and sections

**Website → Navigation.**

- **Navigation links** appear in the header, in your order, up to 20. A link is either a path on your site (such as `/about`) or a full `https` address. With no links of your own, the header shows **Archive** and **About**. On a phone the links sit in one row that scrolls sideways.
- **Sections** group posts, for example "Essays" and "Links". Each section has its own page at `/s/<address>` and is added to the header. Choose a post's section in the editor.
- A page can also be added to the header from its own settings (see below).

## Pages

**Website → Pages.** Pages are for things that are not posts: an About page with more detail, a contact page, a reading list.

- Write a page in the same editor as a post, with images, buttons, quotes and embeds.
- A page starts as a draft. Publish it to put it on the site at `/<address>`.
- Tick **Show in the navigation** to add it to the header.
- Some addresses are taken by the site itself (`archive`, `about`, `search`, `subscribe` and a few more); the dashboard tells you when you pick one.

The **About** page at `/about` is edited at the top of **Website → Pages**.

### Landing pages

A landing page is a page built around one signup form. It carries your publication's name and design but no navigation, search or footer links, so nothing leads a visitor away from the form. Use one as the link in an advert, a social profile or a guest post.

Make one under **Website → Pages → New page**: pick a starter (newsletter signup, free download or waitlist), choose a published signup form, and replace the words in square brackets with your own. More detail: [landing-pages.md](landing-pages.md).

## The paywall on the site

Each post has a visibility, set in the editor:

- **Public**: anyone can read all of it.
- **Subscribers**: free subscribers who are signed in read all of it.
- **Paid**: paid subscribers read all of it.

Visitors who cannot read the whole post see the start of it, then a panel that invites them to subscribe or sign in. Where the post stops is up to you: put a **Paywall break** in the post and everything above it is the free preview. Without one, the site shows the first few blocks (at most 3, and never more than half of the post).

The same preview is used everywhere: on cards, in search results, in feeds and in the description search engines see. Nothing shows more than the post page does.

Readers sign in with a link sent to their email address, from the **Sign in** link in the footer or on the paywall. There are no passwords.

The wording of the paywall panel, free reads per week or month, and discount codes are set under **Paid subscriptions → Paywall**. Free reads stop casual readers, not determined ones: a visitor who isn't signed in can clear the meter cookie or use another browser to read again, and a soft paywall lets anyone continue past it. For posts that must only reach paying readers, use a hard paywall with no free reads, or turn the meter off for that post's Gate. The plans page at `/subscribe` lists your free plan and every public paid plan.

## Search

`/search` searches the titles and text of your published posts and shows the best 20 matches with the matching words marked. Only the free preview of a paywalled post is searched, so search never reveals paid text. The search box is in the header on larger screens and linked from the footer on every screen.

## Feeds

- `/feed` is an RSS feed and `/feed.json` a JSON feed of your latest 50 posts. Browsers and feed readers find them automatically from any page.
- Public posts are in the feed in full. Paywalled posts carry their free preview and a link to the site.

## What the site does for search engines and sharing

You do not need to set any of this up.

- Every page has a title, a description and a canonical address, so a post reached through different links counts as one page.
- Shared links show a card with the post's title, description and picture (Open Graph and Twitter card tags). The picture is the post's cover image, else its first image, else your **Social image**, else your logo on your accent colour.
- Posts carry structured data (Article, with the publish date and whether the post is free), and the site describes itself as a WebSite with a search box.
- `/sitemap.xml` lists every post and page; `/robots.txt` points to it.
- Images are sent in modern formats and several sizes where the server supports it, and load only when they are about to be seen.
- The browser tab icon comes from your logo, or your initial when you have none.

Under **Website → SEO** you can add:

- a **Social image** for pages with no picture of their own (wide, at least 1200 pixels across);
- **verification tokens** for Google and Bing;
- your **profiles elsewhere**, which search engines use to connect the site to them;
- for admins, **Show paywalled content to verified search engines**, so paid posts can rank for their full text while readers still stop at the paywall.

Each post also has its own search title and description in the editor.

**Bot Rules** (admins) decide whether AI crawlers may read the site. **Redirects** send an old address to a new one, for example after moving from another platform; they can be imported from a CSV file.

## Custom CSS

**Website → Branding → Custom CSS** (admins, with a template chosen). Your rules are added after the template's, so they win. Up to 20,000 characters.

To keep the site private and safe, custom CSS cannot load anything from elsewhere or run code:

- no `@import`;
- `url()` may only hold an inline `data:image/...` picture, never a file on another site;
- no backslash escapes and no `</`;
- no `expression()`, `javascript:`, `behavior:` or `-moz-binding`.

The dashboard refuses a rule that breaks these and says which one.

Useful names to target:

| Name                                                               | What it is                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| `--accent`, `--link`                                               | The button colour and the readable link colour        |
| `--page`, `--surface`, `--ink`, `--text`                           | Page background, card background, headings, body text |
| `.sw-header`, `.sw-footer`                                         | The top and bottom of every page                      |
| `.sw-brand`, `.sw-nav`                                             | Your name and logo, and the header links              |
| `.sw-article`, `.sw-prose`                                         | A post, and its text                                  |
| `.sw-card`, `.sw-list`                                             | Post cards and post lists                             |
| `.sw-subscribe`                                                    | The signup box                                        |
| `.sw-gate`                                                         | The paywall panel                                     |
| `html.sw-t-letter` (and `gate`, `magazine`, `newspaper`, `launch`) | The whole site while that template is chosen          |

For example, a narrower reading column with larger text:

```css
.sw-article {
  max-width: 640px;
}
.sw-prose {
  font-size: 20px;
}
```

Dark-scheme readers get the dark colours automatically. To change a colour for them only, use `html[data-scheme='dark']` and `@media (prefers-color-scheme: dark) { html[data-scheme='auto'] { ... } }`.

## Your own domain

**Website → Domains** (admins). You can serve the site from a domain you own, such as `www.example.com`, with the bare domain redirecting to it. The platform address keeps working, and search engines are told the custom domain is the real one.

- Step by step, with the DNS records to add: [domains.md](domains.md).
- If you run Swarm yourself, custom domains have to be switched on once for the whole installation with `enable custom-domains`: see [self-hosting.md](self-hosting.md).

## Cookies and code

**Website → Cookies and code** (admins, when the feature is on). Add a cookie popup and tools such as analytics or a site verification tag. Code marked Analytics or Marketing waits until the reader agrees in the popup; code marked Strictly necessary runs for everyone.

- **Where your code runs.** On your own domain, always. On the address Swarm gives you (`yourname.<this Swarm's domain>`), every publication on the install shares the owner's domain, so scripts there run only if the owner of this Swarm allowed it for your workspace (their own workspace is allowed when it is made; making them an owner of yours does not allow it). If they don't, the page says so: your code is kept, it just doesn't run there. Add your domain under **Domains**, or ask the owner. Verification tags work everywhere.
- **Tracking tools marked strictly necessary.** If a tool you mark Strictly necessary looks like a known tracking or advertising tool (Google Analytics, Meta Pixel, TikTok, LinkedIn, Hotjar, Microsoft Clarity and similar), Swarm asks you to confirm before saving and keeps your confirmation in the audit log. Most cookie rules say such tools must wait for the reader to agree, so choose Analytics or Marketing unless your site really cannot work without it.
- **For the owner of a Swarm.** **Settings → Instance → Code on websites** lists every workspace with a switch for each, and one switch to let every workspace add code to websites on this Swarm's domain. Both are off by default, except for the workspace the installer made for you, and any workspace you made yourself before you became an instance admin. A workspace where you are an owner says so, but its switch is what counts: someone who invited you can make you an owner without asking. Leave them off when people you don't know can make a workspace.

## Other tabs

- **Authors**: author pages with a name, photo and bio, linked from each post's byline.
- **Analytics**: visits and most read pages, counted without cookies.
- **Cookies and code**: a cookie notice and your own analytics or verification code, when you need them.
- **Import past issues**: bring posts over from another platform.
- **Link Hub**: a "link in bio" page at `/links`. See [link-hub.md](link-hub.md).

Some tabs only appear when the feature is switched on for your installation.
