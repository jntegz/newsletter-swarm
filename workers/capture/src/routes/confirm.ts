// Confirm opt-in and leaving before confirming.
//
// - /v1/confirm/<token>  GET shows a Confirm button and changes nothing (mail scanners prefetch
//                        links); POST confirms. Only a "confirm" token works here.
// - /v1/leave/<token>    the List-Unsubscribe target of confirmation mail. GET shows a button,
//                        POST leaves, including the RFC 8058 One-Click POST.
import {
  confirmRequest,
  describeConfirmRequest,
  leaveBeforeConfirming,
  linksFor,
  memberCenterUrl,
  readConfirmToken,
  readLeaveToken,
  emailCheckAvailability,
  VAULT_HELD_KEY,
} from '@swarm/engine';
import { createLogger } from '@swarm/runtime';
import type { Hono } from 'hono';
import { audienceDeps, clientIp, env, later, refreshCirclesOf, type AppEnv } from '../context';
import { originOf } from '../env';
import { evidenceLinks } from '../vault';
import { rateLimit } from '../guard';
import { brokenLink, expiredLink, h, page, slowDown } from '../pages';

const log = createLogger({ service: 'capture' });

const EXPIRED =
  'Confirm links only work for a while. Join again through the form to get a new one.';

const used = (channelName: string | null) =>
  page(
    'This link was already used',
    `${channelName ? `<p class="channel">${h(channelName)}</p>` : ''}<h1>This link was already used</h1><p>There is nothing more to do here.</p>`,
  );

export function confirmRoutes(app: Hono<AppEnv>): void {
  app.get('/v1/confirm/:token', async (c) => {
    const e = env(c);
    const read = await readConfirmToken(linksFor(e), c.req.param('token'));
    if (!read.ok) return read.reason === 'expired' ? expiredLink(EXPIRED) : brokenLink();
    const { requestId, channelId } = read.value;
    const { state, channelName } = await describeConfirmRequest(
      e.DB,
      requestId,
      Date.now(),
      channelId,
    );
    if (state === 'not_found') return brokenLink();
    if (state === 'expired') return expiredLink(EXPIRED);
    if (state === 'used') return used(channelName);
    return page(
      'Confirm your email',
      `<p class="channel">${h(channelName ?? '')}</p><h1>Confirm your email</h1>
<p>Confirm that you want to receive ${h(channelName ?? 'these emails')}.</p>
<form method="post"><button type="submit">Confirm</button></form>`,
    );
  });

  app.post('/v1/confirm/:token', async (c) => {
    const e = env(c);
    const read = await readConfirmToken(linksFor(e), c.req.param('token'));
    if (!read.ok) return read.reason === 'expired' ? expiredLink(EXPIRED) : brokenLink();
    const wait = await rateLimit(e, [[clientIp(c), 'actionIp']]);
    if (wait) return slowDown(wait);
    const result = await confirmRequest(
      e.DB,
      read.value.requestId,
      Date.now(),
      read.value.channelId,
    );
    if (result.outcome !== 'confirmed') {
      if (result.outcome === 'not_found') return brokenLink();
      return result.outcome === 'expired' ? expiredLink(EXPIRED) : used(result.channelName);
    }
    refreshCirclesOf(c, result.memberId);
    // Email checks (docs/email-verification.md): a signup from a form that asks people to confirm
    // is checked now that its holder has proved the mailbox, never before. The jobs worker reads
    // the workspace's settings and rules; the message names the Member, not the address.
    // Only where the workspace may use email checks. Whether the install has a DeBounce key is
    // the jobs worker's to know (it holds the key, and skips the check without one).
    const checks = result.formId
      ? await emailCheckAvailability(
          e.DB,
          { ENVIRONMENT: e.ENVIRONMENT, DEBOUNCE_API_KEY: VAULT_HELD_KEY },
          result.workspaceId,
          result.channelId,
        )
      : null;
    if (checks?.available) {
      later(
        c,
        e.PUBLIC_QUEUE.send({
          type: 'email_check',
          workspaceId: result.workspaceId,
          channelId: result.channelId,
          memberIds: [result.memberId],
          confirmed: true,
        }).catch((error: unknown) =>
          log.warn('email check not queued', {
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    }
    // Minted by the vault for this request, just confirmed; without it the page links /m.
    const center = await memberCenterUrl(
      audienceDeps(
        e,
        evidenceLinks(e, { kind: 'confirmed-request', requestId: read.value.requestId }),
      ),
      { memberId: result.memberId, channelId: result.channelId },
    ).catch(() => `${originOf(e)}/m`);
    return page(
      'You are in',
      `<p class="channel">${h(result.channelName)}</p><h1>You are in</h1>
<p>Your email is confirmed. You will receive ${h(result.channelName)} from now on.</p>
<p>To change your details or how often you hear from us: <a href="${h(center)}">Manage your subscription</a>.</p>`,
    );
  });

  app.get('/v1/leave/:token', async (c) => {
    const e = env(c);
    if (!(await readLeaveToken(linksFor(e), c.req.param('token')))) return brokenLink();
    return page(
      'Stop these emails',
      `<h1>Stop these emails</h1><p>You will not be added, and no reminder will follow.</p>
<form method="post"><button type="submit">Stop these emails</button></form>`,
    );
  });

  app.post('/v1/leave/:token', async (c) => {
    const e = env(c);
    const link = await readLeaveToken(linksFor(e), c.req.param('token'));
    if (!link) return brokenLink();
    const { memberId } = link;
    const body = await c.req.text();
    const result = await leaveBeforeConfirming(e.DB, memberId, Date.now(), link.channelId);
    if (!result) return brokenLink();
    refreshCirclesOf(c, memberId);
    // Mailbox providers POST "List-Unsubscribe=One-Click" and only look at the status.
    if (/(^|&)List-Unsubscribe=One-Click(&|$)/.test(body)) {
      return c.text('Unsubscribed', 200, { 'cache-control': 'no-store' });
    }
    return page(
      'Done',
      `<p class="channel">${h(result.channelName)}</p><h1>Done</h1><p>You will not receive emails from ${h(result.channelName)}.</p>`,
    );
  });
}
