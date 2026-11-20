/**
 * Reputation Ramp pause notices. A ramp paused by a bounce or complaint anomaly (ramp.ts:
 * checkRampHealth after an SES event, or rollover at the start of a UTC day) is marked
 * pause_notice = 'due'. The jobs worker's minute cron claims each due ramp ('sent') before
 * mailing, so a pause is announced at most once; operator pauses and resumes clear the mark.
 * The notice goes to the Channel's owners and admins (workspace seats a Channel role doesn't lower) from
 * the platform address, with the domain, the reason and a link to Deliverability. It is written
 * in the dashboard's words (warm-up, publication, post), and sendOperatorNotice draws it in the
 * frame every system email uses, with a plain-text part beside it.
 */
import { appendAudit } from '@swarm/db';
import type { MailAdapter } from '@swarm/mail';
import { all, first, run } from './db';
import { channelAdminEmails, sendOperatorNotice } from './flows-notify';

export interface RampNoticeEnv {
  DB: D1Database;
  mail: MailAdapter;
  /** notifications@<PLATFORM_MAIL_DOMAIN>. */
  from: string;
  /** The shared platform mail domain, named for ramps without a sending domain. */
  platformMailDomain: string;
  /** The dashboard origin, for the Deliverability link. */
  appOrigin: string;
}

interface DueRamp {
  id: string;
  channel_id: string;
  workspace_id: string;
  channel_name: string;
  domain: string | null;
  paused_reason: string | null;
}

/** Ramps per run; the rest wait a minute. */
const BATCH = 20;

export async function sendRampPauseNotices(
  env: RampNoticeEnv,
): Promise<{ notified: number; emails: number }> {
  const due = await all<DueRamp>(
    env.DB,
    `SELECT r.id, r.channel_id, c.workspace_id, c.name AS channel_name, sd.domain, r.paused_reason
       FROM reputation_ramps r
       JOIN channels c ON c.id = r.channel_id
       LEFT JOIN sending_domains sd ON sd.id = r.sending_domain_id
      WHERE r.pause_notice = 'due' AND r.status = 'paused' AND c.deleted_at IS NULL
      LIMIT ${BATCH}`,
  );
  let notified = 0;
  let emails = 0;
  for (const ramp of due) {
    // The claim: whoever flips 'due' to 'sent' sends, so overlapping runs never send twice.
    const claimed = await first<{ id: string }>(
      env.DB,
      `UPDATE reputation_ramps SET pause_notice = 'sent'
        WHERE id = ?1 AND pause_notice = 'due' AND status = 'paused' RETURNING id`,
      ramp.id,
    );
    if (!claimed) continue;
    const domain = ramp.domain ?? env.platformMailDomain;
    const link = `${env.appOrigin.replace(/\/$/, '')}/channels/${ramp.channel_id}/deliverability`;
    const to = await channelAdminEmails(env.DB, ramp.channel_id);
    const notice = {
      subject: `Sending from ${domain} is paused`,
      lines: [
        `Warm-up for ${domain} in the publication “${ramp.channel_name}” paused sending.`,
        `Reason: ${ramp.paused_reason ?? 'Bounce or complaint rate over the limit.'}`,
        'Posts you send wait instead of failing. Find out what caused it (a stale import, a list from somewhere else), then resume warm-up on the Deliverability page.',
        link,
      ],
      category: 'ramp_paused',
      tags: { channel: ramp.channel_id, reputation_ramp: ramp.id },
    };
    let sent = 0;
    for (const address of to) {
      try {
        sent += await sendOperatorNotice(
          { mail: env.mail, from: env.from },
          { ...notice, to: [address] },
        );
      } catch {
        // One bad address must not stop the others; the pause itself is recorded on the ramp.
      }
    }
    if (to.length && !sent) {
      // Nothing went out (the provider is down): owe it again on the next run.
      await run(
        env.DB,
        `UPDATE reputation_ramps SET pause_notice = 'due' WHERE id = ?1 AND pause_notice = 'sent'`,
        ramp.id,
      );
      continue;
    }
    await appendAudit(env.DB, {
      workspaceId: ramp.workspace_id,
      actorId: null,
      action: 'ramp.pause_notified',
      targetType: 'reputation_ramp',
      targetId: ramp.id,
      metadata: { recipients: sent, domain },
    });
    notified++;
    emails += sent;
  }
  return { notified, emails };
}
