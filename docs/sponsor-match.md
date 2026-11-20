# Sponsor Match

Sponsor Match (flag `sponsor_match`, off at install) gives a publication a page where sponsors can book a placement. In the dashboard it is called Sponsors, under Earn. Code: `workers/api/src/routes/sponsors.ts`, `workers/site/src/routes/partners.ts`, tables in `migrations/0046_partners_sponsors.sql`.

It is not a marketplace, and it doesn't sell ads through anyone else. Sponsors find you, nothing is auctioned, and no subscriber data goes to them. **No money moves through Swarm:** the price on the page is an asking price, and the publisher bills the sponsor directly.

## How a booking goes

1. Turn on "Take bookings" and add at least one placement. The page appears at `/sponsor`.
2. A sponsor picks a placement and a date and writes their ad. The form has a bot check and a rate limit. Owners and admins get an email.
3. An admin accepts or declines. Only one sponsor can be accepted per placement per day. Nothing runs until it is accepted, and an admin can edit the ad first, which is how a publisher applies their own rules about what they will run.
4. In the post editor, Insert → Sponsor adds the ad as a link card titled "Sponsored: …". A person places it by hand, so an ad never enters a post by itself.
5. Bill the sponsor, and tick "They've paid me" for your own records.

## Clicks and reports

The ad's link goes through `/_swarm/sponsored/<id>`, which counts the click and leads to the sponsor. The count is a plain total, with no visitor identifiers. Bots, prefetches and HEAD requests aren't counted, though some mail security scanners may look like people. The link only leads to the sponsor while the booking is accepted, and otherwise goes to the homepage. Canceling a booking therefore turns off the ad's link in posts already sent.

Each booking has a private report link to share with the sponsor, which shows the click count and works for a year. It holds no subscriber data.

## Limits

No calendar view, and no automatic check that an accepted ad actually went out on its date. Ads must lead to an `https://` address.

## Privacy

Sponsor contact details aren't subscriber data, but erasing an address also clears it from bookings. The booking and its click count stay for the publisher's records.

## With the flag off

The page, click links, reports and API answer 404, and the dashboard hides Sponsors. Links in posts already sent stop working until it is back on.
