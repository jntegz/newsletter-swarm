/** The mocked Stripe API (see setup.ts): every call is recorded; `answer` decides the response. */
export interface StripeCall {
  method: string;
  path: string;
  /** Form body for POST, query string for GET. */
  params: URLSearchParams;
  account: string | null;
}

export const stripe = {
  calls: [] as StripeCall[],
  answer: (_call: StripeCall): Response => Response.json({}),
};
