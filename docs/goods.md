# Goods

Goods (flag `goods`, off at install) sells digital products through the publication's own Stripe account. Swarm takes nothing, and the money goes straight to the publisher. Code: `packages/engine/src/goods.ts`, `workers/site/src/routes/goods.ts`, `workers/api/src/routes/goods.ts`, tables in `migrations/0045_goods.sql`. In the dashboard it is called Products, under Earn.

It starts off because no fraud and abuse review has happened and it has not yet been tried with real money. Turn it on in Settings → Instance or with the command line.

## What's in it

- Products with one or more prices, each with its own page at `/goods/<slug>` and a list at `/goods`.
- PDF files. Other kinds wait for a real virus scanner, because the upload scanner (`workers/api/src/lib/scan.ts`) accepts everything today.
- Checkout on the publisher's connected Stripe account, using Stripe Tax when the publisher has it turned on.
- A buyer's library, an optional license key per order, refunds and webhooks.
- A Product entry in the editor's Insert menu, which adds an ordinary button so it works in any mail client.

Not built: bundles, upsells, order bumps, affiliates, reviews, appointments, payment plans, quantities and multi-currency pricing.

## Buying

The order is written before Checkout as `pending`, and only the signed `checkout.session.completed` webhook marks it paid, so a repeated event changes nothing. Buying doesn't sign anyone up: an existing subscriber is linked to the order, and nobody is added to the list.

An email to the buyer's address gives the library link. The thank-you page gives a link to this order's files only, because the address on an anonymous checkout is typed, not proved; a reader signed in as the Member who bought gets the whole library link there instead. If the email fails, the payment still stands, and the buyer can ask for the link again at `/_swarm/library`. That page answers the same, and as fast, whether or not the address bought anything: the lookup and the email happen after the answer. One address gets at most three library emails a day from one publication, however often it is asked for.

## Files and the library

A library link is signed, lasts 90 days, and is good for one address at one publication. Library and order links name one of the buyer's orders, never the address, which Swarm looks up when the link is used, so a link (or a log line holding one) doesn't say who bought. Links mailed before this change carried the address and keep working until their 90 days are up. Each page and download checks the orders again, so a refund takes effect at once even while the link is still valid.

Files are streamed through that check and sent as downloads. Buyers never see the media address. The file itself sits in the media library, but once a product uses it its media address stops working (404), so it can't be read without an order, and a refund ends access. That also means a PDF a product uses can't be linked in a free post. A file a product uses can't be deleted from the media library until it is removed from the product; removed from every product, its media address works again.

Changes to a product's files reach past buyers too. A price change doesn't touch past orders.

## License keys

A key has 100 random bits. Check one from your own server with `GET /v2/channels/{channelId}/license-keys/{licenseKey}` (scope `goods:read`), which answers `valid: false` for an unknown key or a refunded order. Keys are stored as plain text so that buyers and the publisher can see them again, which means someone who could read the database could read them. Don't use them to protect anything more valuable than the product.

## Refunds and disputes

Refund from the Orders table, or in Stripe. Either way the full refund ends access and revokes the license key. A partial refund leaves access alone. A dispute ends access too, and winning one doesn't bring it back automatically.

Webhooks: `good.purchased` and `good.refunded` (also sent for a dispute, with `status: disputed`).

## Privacy

A buyer's orders are in their data export. Erasing them keeps the order's amount for the publisher's books, without the address or the Member, and deletes the license key.

## With the flag off

Product pages, the library and the API answer 404, the checkout refuses, and the dashboard hides Products. Orders and files are kept, and come back when the flag is on. Buyers can't reach their files while it is off, so turn it off with care.
