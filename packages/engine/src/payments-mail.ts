/**
 * Member-facing payment mail: the Gift Pass claim link and its reminders, and the trial-ending
 * notice. Sent from the Channel's sender (the shared platform address when its own domain can't
 * send), in the same layout as confirmation mail.
 */
import { sha256Hex } from '@swarm/db';
import type { OutgoingMail } from '@swarm/mail';
import { base64UrlEncode } from '@swarm/tokens';
import { messageDefinition, type MessageKey } from '@swarm/domain';
import type { EngineConfig } from './config';
import { first } from './db';
import { GOODS_LIBRARY_TTL_SECONDS } from './goods';
import type { PaymentsContext, PaymentsMail } from './payments';
import { channelSiteOrigin, platformSiteOrigin } from './publishing';
import {
  builtInWording,
  claimMessageSend,
  composeMessage,
  memberMail,
  messageIsSaved,
  renderMessage,
} from './messages';
import { resolveSender } from './start';

/** Unclaimed Gift Passes expire this long after payment. */
export const GIFT_CLAIM_DAYS = 90;
/** A claimed Gift Pass's holder is reminded this long before its access ends. */
export const GIFT_EXPIRY_REMINDER_DAYS = 7;
/** An unclaimed Gift Pass is reminded about this long before claim_by. */
export const GIFT_CLAIM_REMINDER_DAYS = 14;

/** A new Gift Pass claim token (the link carries it; the database keeps only its hash). */
export function newGiftClaimToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** gift_passes.claim_token_hash for a claim token: lowercase hex SHA-256. */
export const hashGiftClaimToken = (token: string): Promise<string> => sha256Hex(token);

/** The claim page on the Channel's platform address (served by the site worker). */
export function giftClaimUrl(mail: PaymentsMail, channelSlug: string, token: string): string {
  return `${platformSiteOrigin(mail.site, channelSlug)}/_swarm/gift/${token}`;
}

interface ChannelRow {
  id: string;
  slug: string;
  name: string;
  branding_json: string;
}

async function loadChannel(db: D1Database, channelId: string) {
  return first<ChannelRow>(
    db,
    'SELECT id, slug, name, branding_json FROM channels WHERE id = ?1 AND deleted_at IS NULL',
    channelId,
  );
}

const accentOf = (brandingJson: string) => {
  try {
    const accent = (JSON.parse(brandingJson) as { accentColor?: unknown }).accentColor;
    return typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#6c4cf1';
  } catch {
    return '#6c4cf1';
  }
};

async function senderFor(db: D1Database, mail: PaymentsMail, channel: ChannelRow) {
  // resolveSender reads only the platform mail domain from the engine config.
  const config = { platformMailDomain: mail.platformMailDomain } as EngineConfig;
  const sender = await resolveSender(db, config, channel, null);
  if (sender.problems.length === 0) return sender;
  return { ...sender, address: `${channel.slug}@${mail.platformMailDomain}`, replyTo: null };
}

const formatDate = (at: number) =>
  new Date(at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

async function levelName(db: D1Database, levelId: string | null): Promise<string | null> {
  if (!levelId) return null;
  const row = await first<{ name: string }>(
    db,
    'SELECT name FROM membership_levels WHERE id = ?1',
    levelId,
  );
  return row?.name ?? null;
}

/** Mails the claim link of a paid Gift Pass to its recipient, or to the buyer when there's none. */
export async function sendGiftPassMail(
  ctx: PaymentsContext,
  input: {
    channelId: string;
    giftPassId: string;
    to: string;
    toRecipient: boolean;
    purchaserEmail: string;
    months: number;
    levelId: string | null;
    message: string | null;
    token: string;
    claimBy: number;
  },
): Promise<void> {
  const mail = ctx.mail;
  if (!mail) throw new Error('mail is not configured: a Gift Pass claim link cannot be delivered');
  const channel = await loadChannel(ctx.db, input.channelId);
  if (!channel) return;
  const level = (await levelName(ctx.db, input.levelId)) ?? 'a paid subscription';
  const duration = input.months === 1 ? '1 month' : `${input.months} months`;
  const url = giftClaimUrl(mail, channel.slug, input.token);
  const paragraphs = input.toRecipient
    ? [
        `${input.purchaserEmail} gave you ${duration} of ${level} on ${channel.name}.`,
        ...(input.message ? [`Their note: “${input.message}”`] : []),
        `Claim it by ${formatDate(input.claimBy)}.`,
      ]
    : [
        `Thank you for buying ${duration} of ${level} on ${channel.name} as a gift.`,
        'Send this link to the person you are giving it to. Whoever opens it first can claim it.',
        `It can be claimed until ${formatDate(input.claimBy)}.`,
      ];
  const body = memberMail({
    channelName: channel.name,
    accent: accentOf(channel.branding_json),
    heading: input.toRecipient ? 'You have a gift subscription' : 'Your gift subscription is ready',
    paragraphs,
    button: { label: 'Claim the gift subscription', url },
    footnote: 'Keep this link private: it can be claimed once.',
  });
  const sender = await senderFor(ctx.db, mail, channel);
  const message = await composeMessage(ctx.db, {
    key: input.toRecipient ? 'gift_recipient' : 'gift_buyer',
    channelId: channel.id,
    channelName: channel.name,
    accent: accentOf(channel.branding_json),
    variables: {
      channel_name: channel.name,
      buyer_email: input.purchaserEmail,
      duration,
      level,
      claim_by: formatDate(input.claimBy),
      claim_url: url,
    },
    fallback: {
      subject: input.toRecipient
        ? `A gift for you from ${channel.name}`
        : `Your gift subscription for ${channel.name}`,
      ...body,
    },
  });
  const outgoing: OutgoingMail = {
    category: 'gift_pass',
    from: { name: sender.name, address: sender.address },
    to: input.to,
    replyTo: sender.replyTo ?? sender.address,
    subject: message.subject,
    html: message.html,
    text: message.text,
    tags: { channel: channel.id, kind: 'gift_pass' },
  };
  await mail.adapter.send(outgoing);
}

/**
 * A Member's subscriber-settings link for payment mail. Without a signer (the site's development
 * checkout, which holds no Member key) it is the page that emails one.
 */
async function memberCenterLink(
  ctx: Pick<PaymentsContext, 'memberLinks' | 'now' | 'mail'>,
  member: { channelId: string; memberId: string },
): Promise<string> {
  const origin = ctx.mail?.captureOrigin ?? '';
  if (!ctx.memberLinks) return `${origin}/m`;
  const token = await ctx.memberLinks.memberToken(member, { now: ctx.now });
  return `${origin}/m/${token}`;
}

/** The link to a buyer's library. Their payment stands even if this can't be delivered. */
export async function sendGoodsLibraryMail(
  ctx: Pick<PaymentsContext, 'db' | 'goodsLinks' | 'now' | 'mail'>,
  /** `orderId`: one of the address's orders, which the link names instead of the address. */
  input: { channelId: string; to: string; orderId: string; goodName: string | null },
): Promise<void> {
  const mail = ctx.mail;
  if (!mail || !ctx.goodsLinks) return;
  const channel = await loadChannel(ctx.db, input.channelId);
  if (!channel) return;
  const token = await ctx.goodsLinks.libraryToken({
    channelId: channel.id,
    orderId: input.orderId,
    now: ctx.now,
  });
  const url = `${platformSiteOrigin(mail.site, channel.slug)}/_swarm/library/${token}`;
  const body = memberMail({
    channelName: channel.name,
    accent: accentOf(channel.branding_json),
    heading: input.goodName ? `Thanks for buying ${input.goodName}` : 'Your downloads',
    paragraphs: [
      input.goodName
        ? 'Your files and any license key are in your library.'
        : `Here is the link to everything you have bought from ${channel.name}.`,
      `The link works for ${Math.round(GOODS_LIBRARY_TTL_SECONDS / 86_400)} days. You can ask for a new one from the same page any time.`,
    ],
    button: { label: 'Open your library', url },
    footnote: 'Keep this link private: anyone who has it can download your files.',
  });
  const sender = await senderFor(ctx.db, mail, channel);
  const message = await composeMessage(ctx.db, {
    key: 'goods_library',
    channelId: channel.id,
    channelName: channel.name,
    accent: accentOf(channel.branding_json),
    variables: { channel_name: channel.name, good_name: input.goodName ?? '', library_url: url },
    fallback: {
      subject: input.goodName
        ? `Your purchase from ${channel.name}`
        : `Your downloads from ${channel.name}`,
      ...body,
    },
  });
  await mail.adapter.send({
    category: 'goods_library',
    from: { name: sender.name, address: sender.address },
    to: input.to,
    replyTo: sender.replyTo ?? sender.address,
    subject: message.subject,
    html: message.html,
    text: message.text,
    tags: { channel: channel.id, kind: 'goods_library' },
  });
}

/** A short notice three days before a trial ends (customer.subscription.trial_will_end). */
export async function sendTrialEndingMail(
  ctx: PaymentsContext,
  input: {
    channelId: string;
    memberId: string;
    levelId: string | null;
    trialEnd: number;
  },
): Promise<void> {
  const mail = ctx.mail;
  if (!mail) return;
  const channel = await loadChannel(ctx.db, input.channelId);
  const member = await first<{ email: string; first_name: string | null }>(
    ctx.db,
    'SELECT email, first_name FROM members WHERE id = ?1 AND channel_id = ?2',
    input.memberId,
    input.channelId,
  );
  if (!channel || !member) return;
  const level = (await levelName(ctx.db, input.levelId)) ?? 'your paid subscription';
  const manageUrl = await memberCenterLink(ctx, input);
  const body = memberMail({
    channelName: channel.name,
    accent: accentOf(channel.branding_json),
    heading: 'Your trial ends soon',
    paragraphs: [
      `Your trial of ${level} on ${channel.name} ends on ${formatDate(input.trialEnd)}.`,
      'After that your card is charged and your paid subscription continues. To change or cancel it, open your subscriber settings.',
    ],
    button: { label: 'Manage my subscription', url: manageUrl },
    footnote: 'You are receiving this because you started a trial with this address.',
  });
  const sender = await senderFor(ctx.db, mail, channel);
  const message = await composeMessage(ctx.db, {
    key: 'trial_ending',
    channelId: channel.id,
    channelName: channel.name,
    accent: accentOf(channel.branding_json),
    variables: {
      channel_name: channel.name,
      first_name: member.first_name ?? '',
      level,
      trial_ends_on: formatDate(input.trialEnd),
      manage_url: manageUrl,
    },
    fallback: { subject: `Your ${channel.name} trial ends soon`, ...body },
  });
  await mail.adapter.send({
    category: 'trial_ending',
    from: { name: sender.name, address: sender.address },
    to: member.email,
    replyTo: sender.replyTo ?? sender.address,
    subject: message.subject,
    html: message.html,
    text: message.text,
    tags: { channel: channel.id, kind: 'trial_ending' },
  });
}

/** What the Gift Pass reminders need: the cron has no PaymentsContext, only these. */
interface GiftReminderMail {
  db: D1Database;
  mail: PaymentsMail;
}

/**
 * A week before a claimed Gift Pass's access ends: when it ends and a link to the plans page to
 * keep reading. Returns false when there was nobody to send it to.
 */
export async function sendGiftExpiryReminder(
  deps: GiftReminderMail,
  input: { channelId: string; memberId: string; levelId: string | null; endsAt: number },
): Promise<boolean> {
  const channel = await loadChannel(deps.db, input.channelId);
  const member = await first<{ email: string }>(
    deps.db,
    `SELECT email FROM members WHERE id = ?1 AND channel_id = ?2 AND status IN ('active', 'paused')`,
    input.memberId,
    input.channelId,
  );
  if (!channel || !member) return false;
  const level = (await levelName(deps.db, input.levelId)) ?? 'your paid subscription';
  const { origin } = await channelSiteOrigin(deps.db, deps.mail.site, channel.id);
  const body = memberMail({
    channelName: channel.name,
    accent: accentOf(channel.branding_json),
    heading: 'Your gift subscription ends soon',
    paragraphs: [
      `The gift subscription for ${level} on ${channel.name} ends on ${formatDate(input.endsAt)}.`,
      'To keep reading after that, choose a plan. Nothing is charged until you do.',
    ],
    button: { label: 'Keep my subscription', url: `${origin}/subscribe` },
    footnote: 'You are receiving this because you claimed a gift subscription with this address.',
  });
  const sender = await senderFor(deps.db, deps.mail, channel);
  const message = await composeMessage(deps.db, {
    key: 'gift_expiry',
    channelId: channel.id,
    channelName: channel.name,
    accent: accentOf(channel.branding_json),
    variables: {
      channel_name: channel.name,
      level,
      ends_on: formatDate(input.endsAt),
      plans_url: `${origin}/subscribe`,
    },
    fallback: { subject: `Your ${channel.name} gift subscription ends soon`, ...body },
  });
  await deps.mail.adapter.send({
    category: 'gift_pass_reminder',
    from: { name: sender.name, address: sender.address },
    to: member.email,
    replyTo: sender.replyTo ?? sender.address,
    subject: message.subject,
    html: message.html,
    text: message.text,
    tags: { channel: channel.id, kind: 'gift_pass_expiry' },
  });
  return true;
}

/**
 * A fortnight before an unclaimed Gift Pass expires: a fresh claim link to the recipient, or to
 * the buyer when the pass had no recipient. Returns false when there was nobody to send it to.
 */
export async function sendGiftClaimReminder(
  deps: GiftReminderMail,
  input: {
    channelId: string;
    to: string;
    toRecipient: boolean;
    purchaserEmail: string;
    months: number;
    levelId: string | null;
    token: string;
    claimBy: number;
  },
): Promise<boolean> {
  const channel = await loadChannel(deps.db, input.channelId);
  if (!channel) return false;
  const level = (await levelName(deps.db, input.levelId)) ?? 'a paid subscription';
  const duration = input.months === 1 ? '1 month' : `${input.months} months`;
  const body = memberMail({
    channelName: channel.name,
    accent: accentOf(channel.branding_json),
    heading: 'Your gift subscription is waiting',
    paragraphs: input.toRecipient
      ? [
          `${input.purchaserEmail} gave you ${duration} of ${level} on ${channel.name}, and it hasn't been claimed yet.`,
          `Claim it by ${formatDate(input.claimBy)}, or it expires.`,
        ]
      : [
          `The gift subscription you bought for ${duration} of ${level} on ${channel.name} hasn't been claimed yet.`,
          `Send this link to the person you are giving it to. It can be claimed until ${formatDate(input.claimBy)}.`,
        ],
    button: {
      label: 'Claim the gift subscription',
      url: giftClaimUrl(deps.mail, channel.slug, input.token),
    },
    footnote:
      'Keep this link private: the gift subscription can be claimed once. The first link still works.',
  });
  const sender = await senderFor(deps.db, deps.mail, channel);
  await deps.mail.adapter.send({
    category: 'gift_pass_reminder',
    from: { name: sender.name, address: sender.address },
    to: input.to,
    replyTo: sender.replyTo ?? sender.address,
    subject: input.toRecipient
      ? `Your gift from ${channel.name} is waiting`
      : `Your gift subscription for ${channel.name} hasn't been claimed`,
    html: body.html,
    text: body.text,
    tags: { channel: channel.id, kind: 'gift_pass_claim' },
  });
  return true;
}

/**
 * A payment notice: a failed payment, an ended membership or a receipt. Best effort, and once per
 * `dedupe` however often the payment service repeats the event: a failure here must never fail the
 * event that changes someone's access.
 */
export async function sendPaymentNotice(
  ctx: Pick<PaymentsContext, 'db' | 'memberLinks' | 'now' | 'mail'>,
  input: {
    key: Extract<MessageKey, 'payment_failed' | 'subscription_cancelled' | 'payment_receipt'>;
    channelId: string;
    memberId: string | null;
    levelId: string | null;
    amount?: string;
    dedupe: string;
  },
): Promise<void> {
  const mail = ctx.mail;
  if (!mail || !input.memberId) return;
  try {
    if (input.key === 'payment_receipt') {
      if (!(await messageIsSaved(ctx.db, input.key, input.channelId))) return;
    }
    const channel = await loadChannel(ctx.db, input.channelId);
    const member = await first<{ email: string; first_name: string | null; status: string }>(
      ctx.db,
      'SELECT email, first_name, status FROM members WHERE id = ?1 AND channel_id = ?2',
      input.memberId,
      input.channelId,
    );
    if (!channel || !member || ['bounced', 'complained'].includes(member.status)) return;
    if (!(await claimMessageSend(ctx.db, `${input.key}:${input.dedupe}`, ctx.now))) return;
    const def = messageDefinition(input.key);
    const level = (await levelName(ctx.db, input.levelId)) ?? 'your paid subscription';
    const manage = await memberCenterLink(ctx, {
      channelId: input.channelId,
      memberId: input.memberId,
    });
    const { origin } = await channelSiteOrigin(ctx.db, mail.site, channel.id);
    const variables = {
      channel_name: channel.name,
      first_name: member.first_name ?? '',
      level,
      amount: input.amount ?? '',
      manage_url: manage,
      plans_url: `${origin}/subscribe`,
    };
    const accent = accentOf(channel.branding_json);
    const fallback = renderMessage(input.key, builtInWording(input.key), {
      channelName: channel.name,
      accent,
      variables,
    });
    const message = await composeMessage(ctx.db, {
      key: input.key,
      channelId: channel.id,
      channelName: channel.name,
      accent,
      variables,
      fallback,
    });
    const sender = await senderFor(ctx.db, mail, channel);
    await mail.adapter.send({
      category: input.key,
      from: { name: sender.name, address: sender.address },
      to: member.email,
      replyTo: sender.replyTo ?? sender.address,
      subject: message.subject,
      html: message.html,
      text: message.text,
      tags: { channel: channel.id, kind: input.key, label: def.label },
    });
  } catch (error) {
    // The kind of error only: a mail provider's error text can carry the recipient's address,
    // and this line goes to the console directly, so nothing redacts it.
    console.warn('payment notice was not sent', {
      key: input.key,
      channelId: input.channelId,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}
