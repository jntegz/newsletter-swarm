# Landing pages

A landing page (flag `landing_pages`) is a page on the publication's website built around one signup form. It has the publication's name and theme, and no navigation, search, footer links, Smart Prompts or second subscribe box, so nothing leads people away from the form. Code: `workers/site/src/routes/pages.ts`, `site_pages.landing_form_id` (`migrations/0042_landing_pages.sql`). Dashboard: Website → Pages → New page.

## Making one

Pick a starter, choose a published form, and replace the words in square brackets with your own. It starts as a draft, at an address like `/join`, like any page. Publishing, the address, search engines, sitemaps and social images all work as they do for other pages.

## The starters

Each starter is a short page that leads with what the visitor gets, says what happens after they sign up, and ends just above the form. Everything in square brackets is a prompt to replace; the rest can stay as it is. Several prompts carry an example after "for example:" to show the kind of sentence that works.

| Starter               | Title                            | What it holds                                                                                                                                                   |
| --------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Newsletter signup** | `Get [your newsletter] by email` | One sentence on what you write and for whom, "What you get" (what arrives and how often, why it is worth opening, what it costs), and an optional line of proof |
| **Free download**     | `Get [the guide] free`           | One sentence on what the guide helps people do, "What's inside" (three things), then how it arrives and that the newsletter comes with it                       |
| **Waitlist**          | `[Your project] is coming`       | One sentence on what you are making and for whom, then "Why join the list" (hear first and when, what early subscribers get, how few emails)                    |

Keep the page short. A visitor should be able to read it and reach the form without scrolling much on a phone. Delete any prompt you have nothing to say for, rather than leaving it in brackets: brackets left on a published page are shown to visitors as they are.

The starters are defined in `LANDING_TEMPLATES` in `packages/domain/src/p4-site.ts`.

## How it looks

A landing page uses the website's stylesheet, so it follows the chosen template's typeface, your accent colour and the reader's light or dark setting. The title is set larger than on an ordinary page, the text sits in one narrow column, and the form comes straight after it. The header shows only the publication's logo and name, and the footer only the copyright line.

## The form

The form posts straight to the capture worker from the visitor's browser, exactly like the website's other forms, with the same bot check, rate limits and success message or redirect.

- **Required custom fields are refused.** Only the embed frame can ask for profile fields, so a form with required ones could never be completed here. Optional ones are left out of the page.
- **Allowed sites.** A form limited to other sites can't be used here. If that happens after the page is published, or the form is deleted or unpublished, the page falls back to the website's plain email form, so it keeps collecting signups but they no longer count toward that form.
- **Counting.** Views are in the website's analytics, by page. Signups are in the form's stats, so give each page its own form to compare them.

## With the flag off

A landing page shows as the ordinary page it also is, with the site's navigation and subscribe box. Nothing is lost, and it comes back when the flag is on.
