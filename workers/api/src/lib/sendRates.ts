// How a send did, counting people: the totals Home's overview and the posts list share. Machine
// opens and clicks (privacy proxies, link scanners) are left out, as on the send report.

/**
 * SQL select list over `deliveries`, grouped by broadcast_id. Each person is counted once: a
 * delivery has one human_opened_at and one human_clicked_at, set by the first human event.
 */
export const SEND_TOTALS_SQL = `coalesce(sum(status <> 'failed'), 0) AS sent,
  coalesce(sum(status IN ('delivered', 'complained')), 0) AS delivered,
  coalesce(sum(status = 'bounced'), 0) AS bounced,
  coalesce(sum(human_opened_at IS NOT NULL), 0) AS human_opened,
  coalesce(sum(human_clicked_at IS NOT NULL), 0) AS human_clicked`;

export interface SendTotals {
  sent: number;
  delivered: number;
  bounced: number;
  human_opened: number;
  human_clicked: number;
}

interface SendRates {
  delivered: number;
  humanOpens: number;
  humanClicks: number;
  openRate: number;
  clickRate: number;
}

const rate = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0;

/** Delivered, people who opened and clicked, and their rates; zeros for a send with no rows. */
export function sendRates(t: SendTotals | undefined | null): SendRates {
  // As in the Broadcast stats: a sent message that hasn't bounced counts as delivered.
  const delivered = t ? Math.max(t.delivered, t.sent - t.bounced) : 0;
  const humanOpens = t?.human_opened ?? 0;
  const humanClicks = t?.human_clicked ?? 0;
  return {
    delivered,
    humanOpens,
    humanClicks,
    openRate: rate(humanOpens, delivered),
    clickRate: rate(humanClicks, delivered),
  };
}
