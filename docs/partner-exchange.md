# Partner Exchange

Partner Exchange (flag `partner_exchange`, off at install) lets a publication recommend other publications by hand. In the dashboard it is called Partners, under Grow. Code: `workers/api/src/routes/partners.ts`, `workers/site/src/routes/partners.ts`, `partner_picks` (`migrations/0046_partners_sponsors.sql`).

There is no shared network. Each install stands alone, so nothing matches publications with each other, no credits change hands, and any swap is agreed between the two publishers. The partner doesn't need to run Swarm. `signals` and `signals_paid` stay postponed for that reason.

## Where recommendations show

- **After signup:** add a "Recommended publications" step to a signup journey. It is skipped when there is nothing to show.
- **On the website:** the first four show on the homepage, and all of them at `/partners`.

Each recommendation can be turned on or off for either place.

## Clicks

Links go through `/_swarm/partner/<id>`, which counts the click by where it came from and leads on, adding `utm_source=<your publication>` and `utm_medium=partner_exchange` so the partner can see what came from you. The counts are plain totals with no visitor identifiers. Bots, prefetches and HEAD requests aren't counted. Totals show on the Partners page and don't prove how many people subscribed.

The target is read from the database, so the link can't be used as an open redirect.

## With the flag off

The pages, click links and API answer 404, the homepage section and journey step disappear, and the recommendations are kept. A journey with a recommendations step can't be saved while it is off.
