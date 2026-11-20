// The emails an owner can reword: what each one is, which values it can use, and its built-in
// wording. Values a stranger could choose never appear in mail that goes to an address someone
// merely typed: there, a stranger could send their own words to anyone.
import { z } from '@hono/zod-openapi';

interface MessageDefinition {
  label: string;
  /** When it goes out, for the person editing it. */
  when: string;
  /** Values it can use, with a sample for the preview. */
  variables: Record<string, string>;
  /** The link the message exists to deliver. HTML mode must use it. */
  link: string;
  /** Plain text only: a security email keeps Swarm's layout. */
  textOnly?: boolean;
  /** Sent only after the owner saves it (a payment service may already send its own). */
  offUntilSaved?: boolean;
  subject: string;
  heading: string;
  body: string;
  button: string;
  footnote: string;
}

const CHANNEL = { channel_name: 'Field Notes' };

export const MESSAGES = {
  confirm: {
    label: 'Confirm your email',
    when: 'When someone signs up and confirmation is on.',
    variables: { ...CHANNEL, days_left: '7', confirm_url: 'https://example.com/confirm' },
    link: 'confirm_url',
    subject: 'Confirm your email for {{channel_name}}',
    heading: 'Confirm your email',
    body: 'Someone asked to join {{channel_name}} with this address. Confirm it was you and you are in.\n\nThe link works for {{days_left}} days.',
    button: 'Confirm my email',
    footnote: 'If you did not ask for this, ignore this email. Nothing happens unless you confirm.',
  },
  confirm_reminder: {
    label: 'Confirmation reminder',
    when: 'Once, 48 hours later, if they have not confirmed.',
    variables: { ...CHANNEL, days_left: '5', confirm_url: 'https://example.com/confirm' },
    link: 'confirm_url',
    subject: 'Reminder: confirm your email for {{channel_name}}',
    heading: 'Confirm your email',
    body: 'Someone asked to join {{channel_name}} with this address. Confirm it was you and you are in.\n\nThe link works for {{days_left}} days.',
    button: 'Confirm my email',
    footnote:
      'This is the only reminder. If you did not ask for this, ignore it and you will not hear from us again.',
  },
  rejoin: {
    label: 'Welcome back',
    when: 'When someone who unsubscribed signs up again.',
    variables: { ...CHANNEL, days_left: '7', confirm_url: 'https://example.com/confirm' },
    link: 'confirm_url',
    subject: 'Welcome back to {{channel_name}}: confirm to rejoin',
    heading: 'Welcome back',
    body: 'Someone asked to rejoin {{channel_name}} with this address. Confirm and you will start receiving it again.\n\nThe link works for {{days_left}} days.',
    button: 'Confirm and rejoin',
    footnote: 'If you did not ask for this, ignore this email. Nothing happens unless you confirm.',
  },
  member_center: {
    label: 'Manage your subscription link',
    when: 'When a subscriber asks for a link to their settings.',
    variables: { ...CHANNEL, center_url: 'https://example.com/m' },
    link: 'center_url',
    subject: 'Manage your subscription to {{channel_name}}',
    heading: 'Manage your subscription',
    body: 'Use this link to update your details, pause or change how often you hear from {{channel_name}}.\n\nThe link works for 30 days.',
    button: 'Manage your subscription',
    footnote:
      'If you did not ask for this, you can ignore it. Nobody can use the link without this email.',
  },
  reader_signin: {
    label: 'Website sign-in',
    when: 'When a subscriber signs in on your website.',
    variables: { ...CHANNEL, signin_url: 'https://example.com/signin' },
    link: 'signin_url',
    textOnly: true,
    subject: 'Sign in to read {{channel_name}}',
    heading: 'Sign in to read',
    body: 'Use this link to sign in on the {{channel_name}} website. It works once and expires in 20 minutes.',
    button: 'Sign in',
    footnote:
      'If you did not ask for this email, you can ignore it. Nobody can sign in without the link.',
  },
  data_export: {
    label: 'Their data is ready',
    when: 'When someone’s request for a copy of their data is ready.',
    variables: { ...CHANNEL, days: '7', download_url: 'https://example.com/export' },
    link: 'download_url',
    textOnly: true,
    subject: 'Your data from {{channel_name}}',
    heading: 'Your data is ready',
    body: 'You asked for a copy of the data {{channel_name}} holds about this address. It is one JSON file.\n\nThe link works for {{days}} days.',
    button: 'Download my data',
    footnote:
      'If you did not ask for this, nobody else can open the link without this email. You can ignore it.',
  },
  gift_recipient: {
    label: 'You have a gift subscription',
    when: 'When someone buys a gift subscription for this person.',
    variables: {
      ...CHANNEL,
      buyer_email: 'friend@example.com',
      duration: '3 months',
      level: 'Supporter',
      claim_by: 'March 3, 2027',
      claim_url: 'https://example.com/gift',
    },
    link: 'claim_url',
    subject: 'A gift for you from {{channel_name}}',
    heading: 'You have a gift subscription',
    body: '{{buyer_email}} gave you {{duration}} of {{level}} on {{channel_name}}.\n\nClaim it by {{claim_by}}.',
    button: 'Claim the gift subscription',
    footnote: 'Keep this link private: it can be claimed once.',
  },
  gift_buyer: {
    label: 'Your gift subscription is ready',
    when: 'When someone buys a gift subscription without naming who it is for.',
    variables: {
      ...CHANNEL,
      duration: '3 months',
      level: 'Supporter',
      claim_by: 'March 3, 2027',
      claim_url: 'https://example.com/gift',
    },
    link: 'claim_url',
    subject: 'Your gift subscription for {{channel_name}}',
    heading: 'Your gift subscription is ready',
    body: 'Thank you for buying {{duration}} of {{level}} on {{channel_name}} as a gift.\n\nSend this link to the person you are giving it to. Whoever opens it first can claim it.\n\nIt can be claimed until {{claim_by}}.',
    button: 'Claim the gift subscription',
    footnote: 'Keep this link private: it can be claimed once.',
  },
  gift_expiry: {
    label: 'Gift subscription ends soon',
    when: 'A week before a claimed gift subscription ends.',
    variables: {
      ...CHANNEL,
      level: 'Supporter',
      ends_on: 'March 3, 2027',
      plans_url: 'https://example.com/subscribe',
    },
    link: 'plans_url',
    subject: 'Your {{channel_name}} gift subscription ends soon',
    heading: 'Your gift subscription ends soon',
    body: 'The gift subscription for {{level}} on {{channel_name}} ends on {{ends_on}}.\n\nTo keep reading after that, choose a plan. Nothing is charged until you do.',
    button: 'Keep my subscription',
    footnote: 'You are receiving this because you claimed a gift subscription with this address.',
  },
  trial_ending: {
    label: 'Trial ends soon',
    when: 'Three days before a paid trial ends.',
    variables: {
      ...CHANNEL,
      first_name: 'Ada',
      level: 'Supporter',
      trial_ends_on: 'March 3, 2027',
      manage_url: 'https://example.com/m',
    },
    link: 'manage_url',
    subject: 'Your {{channel_name}} trial ends soon',
    heading: 'Your trial ends soon',
    body: 'Your trial of {{level}} on {{channel_name}} ends on {{trial_ends_on}}.\n\nAfter that your card is charged and your paid subscription continues. To change or cancel it, open your subscriber settings.',
    button: 'Manage my subscription',
    footnote: 'You are receiving this because you started a trial with this address.',
  },
  goods_library: {
    label: 'Your downloads',
    when: 'After someone buys a product, or asks for their library link.',
    variables: { ...CHANNEL, good_name: 'The Handbook', library_url: 'https://example.com/lib' },
    link: 'library_url',
    subject: 'Your purchase from {{channel_name}}',
    heading: 'Thanks for your purchase',
    body: 'Your files and any license key are in your library.\n\nYou can ask for a new link from the same page any time.',
    button: 'Open your library',
    footnote: 'Keep this link private: anyone who has it can download your files.',
  },
  champion_award: {
    label: 'Referral reward',
    when: 'When a subscriber reaches a referral milestone.',
    variables: {
      ...CHANNEL,
      first_name: 'Ada',
      award: 'You reached 5 referrals. Your reward: a free month.',
      center_url: 'https://example.com/m',
    },
    link: 'center_url',
    subject: 'You reached a referral milestone on {{channel_name}}',
    heading: 'You earned a referral reward',
    body: '{{award}}',
    button: 'Open your subscriber settings',
    footnote: 'You are receiving this because people joined through your share link.',
  },
  pledge: {
    label: 'Paid subscriptions are open',
    when: 'When you tell people who pledged that paid subscriptions have opened.',
    variables: { ...CHANNEL, plans_url: 'https://example.com/subscribe' },
    link: 'plans_url',
    subject: '{{channel_name}}: paid subscriptions are open',
    heading: 'Paid subscriptions are open',
    body: 'You pledged to support {{channel_name}}. Paid subscriptions are open now.',
    button: 'See plans',
    footnote: 'Nothing is charged until you subscribe.',
  },
  payment_failed: {
    label: 'Payment failed',
    when: 'When a renewal payment first fails.',
    variables: {
      ...CHANNEL,
      first_name: 'Ada',
      level: 'Supporter',
      manage_url: 'https://example.com/m',
    },
    link: 'manage_url',
    subject: 'Your {{channel_name}} payment did not go through',
    heading: 'Your payment did not go through',
    body: 'We could not take the payment for {{level}} on {{channel_name}}. You keep your access for now, and we will try again.\n\nTo keep your paid subscription, check your payment details.',
    button: 'Check my payment details',
    footnote: 'You are receiving this because you have a paid subscription with this address.',
  },
  subscription_cancelled: {
    label: 'Paid subscription ended',
    when: 'When a paid subscription ends.',
    variables: {
      ...CHANNEL,
      first_name: 'Ada',
      level: 'Supporter',
      plans_url: 'https://example.com/subscribe',
    },
    link: 'plans_url',
    subject: 'Your {{channel_name}} paid subscription has ended',
    heading: 'Your paid subscription has ended',
    body: 'Your {{level}} subscription on {{channel_name}} has ended. You are still on the free list unless you unsubscribed.\n\nYou can come back at any time.',
    button: 'See plans',
    footnote: 'You are receiving this because you had a paid subscription with this address.',
  },
  payment_receipt: {
    label: 'Payment receipt',
    when: 'After each payment. Off until you save it, because your payment service may send its own.',
    variables: {
      ...CHANNEL,
      first_name: 'Ada',
      level: 'Supporter',
      amount: '$8.00',
      manage_url: 'https://example.com/m',
    },
    link: 'manage_url',
    offUntilSaved: true,
    subject: 'Your receipt from {{channel_name}}',
    heading: 'Thank you',
    body: 'We received your payment of {{amount}} for {{level}} on {{channel_name}}.',
    button: 'Manage my subscription',
    footnote: 'You are receiving this because you have a paid subscription with this address.',
  },
} satisfies Record<string, MessageDefinition>;

export type MessageKey = keyof typeof MESSAGES;
export const MESSAGE_KEYS = Object.keys(MESSAGES) as MessageKey[];
// Own keys only: "constructor" or "toString" from a URL is no email.
export const isMessageKey = (key: string): key is MessageKey => Object.hasOwn(MESSAGES, key);
export const messageDefinition = (key: MessageKey): MessageDefinition => MESSAGES[key];

const MESSAGE_BODY_MAX = 50_000;

export const SaveMessageSchema = z
  .object({
    subject: z.string().trim().min(1, 'Add a subject.').max(200),
    mode: z.enum(['text', 'html']),
    heading: z.string().trim().max(200).default(''),
    body: z.string().min(1, 'Add the message.').max(MESSAGE_BODY_MAX),
    buttonLabel: z.string().trim().max(80).default(''),
  })
  .openapi('SaveMessage');
export type SaveMessage = z.infer<typeof SaveMessageSchema>;

export const MessageSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    when: z.string(),
    variables: z.array(z.string()),
    link: z.string(),
    textOnly: z.boolean(),
    offUntilSaved: z.boolean(),
    /** Whether the owner has their own wording saved. */
    customized: z.boolean(),
    subject: z.string(),
    mode: z.enum(['text', 'html']),
    heading: z.string(),
    body: z.string(),
    buttonLabel: z.string(),
    updatedAt: z.string().nullable(),
  })
  .openapi('Message');
export type Message = z.infer<typeof MessageSchema>;

const VARIABLE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Why this wording can't be saved, or null. Refused, not rewritten: a rewrite could break a link. */
export function messageProblem(
  key: MessageKey,
  input: Pick<SaveMessage, 'subject' | 'mode' | 'heading' | 'body' | 'buttonLabel'>,
): { path: string; message: string } | null {
  const def: MessageDefinition = MESSAGES[key];
  if (def.textOnly && input.mode === 'html') {
    return { path: 'mode', message: 'This security email can only be edited as text.' };
  }
  for (const [path, text] of [
    ['subject', input.subject],
    ['heading', input.heading],
    ['body', input.body],
    ['buttonLabel', input.buttonLabel],
  ] as const) {
    for (const match of text.matchAll(VARIABLE)) {
      const name = match[1] ?? '';
      if (!Object.hasOwn(def.variables, name) && !name.startsWith('@')) {
        return { path, message: `{{${name}}} isn’t available in this email.` };
      }
      if (name.startsWith('@')) return { path, message: `{{${name}}} isn’t available here.` };
    }
  }
  if (input.mode === 'text') {
    if (!input.buttonLabel.trim()) {
      return { path: 'buttonLabel', message: 'Add the button’s text: the link goes on it.' };
    }
    return null;
  }
  const html = input.body;
  const uses = [...html.matchAll(VARIABLE)].some((match) => match[1] === def.link);
  if (!uses) {
    return {
      path: 'body',
      message: `Include {{${def.link}}}: without it this email can’t do its job.`,
    };
  }
  if (/<\s*(script|iframe|object|embed|form|meta|base|link)\b/i.test(html)) {
    return { path: 'body', message: 'Scripts, frames, forms and embeds don’t work in email.' };
  }
  if (/<[^>]*\son[a-z]+\s*=/i.test(html)) {
    return { path: 'body', message: 'Event handlers such as onclick don’t work in email.' };
  }
  if (/(href|src)\s*=\s*["']?\s*(javascript|vbscript|data:text)/i.test(html)) {
    return { path: 'body', message: 'That link type isn’t allowed. Use an https address.' };
  }
  return null;
}
