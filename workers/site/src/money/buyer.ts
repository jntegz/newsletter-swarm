// Who a purchase is for, on every form that posts to /_swarm/checkout while a reader is signed in
// (security review S02-P2-T-gift-login-csrf). Gift claims no longer sign anyone in (routes/gifts.ts),
// so they can't plant a session; any other way a session ends up in someone else's browser is
// still covered here: a signed-in purchase is credited to the reader, and reuses their saved
// payment details, only when the form named the account and offered a way to buy as someone else.
// The form carries `buyer`, and checkout.ts compares it with the session.
import { h } from '../readers/pages';

/** Who is buying: the account, a way out, and its id for checkout. */
export function buyerLine(buyer: { memberId: string; email: string }): string {
  return `<p class="sw-muted sw-buyer">Buying as <strong>${h(buyer.email)}</strong>. Not you? <button type="submit" form="sw-signout" class="sw-ghost">Sign out</button> to buy as someone else.</p>
<input type="hidden" name="buyer" value="${h(buyer.memberId)}">`;
}

/** The sign-out form the buyer line's button submits (forms can't nest). */
export const SIGNOUT_FORM =
  '<form id="sw-signout" method="post" action="/_swarm/reader/signout" hidden></form>';
