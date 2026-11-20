/**
 * Outbound mail. Workers depend on the MailAdapter interface only. Adapters:
 * - SesMail (./ses): raw MIME through SES v2 with a configuration set (the primary engine);
 * - ResendMail (./resend): the Resend API, for small installs that want a quick start;
 * - MailgunMail (./mailgun): the Mailgun API;
 * - PostmarkMail (./postmark): the Postmark API;
 * - SmtpMail (./smtp): a person's own mail server;
 * - DevMailbox: an R2 bucket read by the dev mail viewer, never selectable outside development.
 */
import {
  sesIdentityRecords,
  type CreatedIdentity,
  type DomainIdentities,
  type ProviderDnsRecord,
  type DomainIdentityStatus,
} from './ses';
import { IdentityExistsError } from './errors';
export * from './embeds';

export interface Address {
  name?: string;
  address: string;
}

export interface OutgoingMail {
  from: Address;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  /** Extra headers, e.g. List-Unsubscribe. Adapters must deliver every one of them. */
  headers?: Record<string, string>;
  /** Short label for logs and provider tags, e.g. "quickpass". */
  category: string;
  /** Message-ID without angle brackets; adapters generate one when absent. */
  messageId?: string;
  /** Provider tags (SES EmailTags), e.g. broadcast and channel ids. */
  tags?: Record<string, string>;
  /**
   * A Channel's own SES configuration set (Phase 7); absent uses the adapter's shared one.
   * Adapters without configuration sets (Resend) ignore it.
   */
  configurationSet?: string;
  /** Where bounces should go, for adapters that set the envelope sender themselves (SMTP). */
  returnPath?: string;
}

export interface SentMail {
  messageId: string;
}

export interface MailAdapter {
  send(mail: OutgoingMail): Promise<SentMail>;
  /** Sends a Broadcast batch keeps in flight at once; absent means 10. */
  readonly maxConcurrency?: number;
}

export interface StoredMail extends OutgoingMail {
  id: string;
  sentAt: string;
}

const PREFIX = 'mail/';

/**
 * Local development mailbox: messages are written to an R2 bucket and read back by the
 * dev mail viewer and end-to-end tests. Never selectable outside development and test.
 */
export class DevMailbox implements MailAdapter {
  constructor(private readonly bucket: R2Bucket) {}

  async send(mail: OutgoingMail): Promise<SentMail> {
    const sentAt = new Date();
    // Reverse-chronological keys make "latest first" a plain prefix listing.
    const order = (9_999_999_999_999 - sentAt.getTime()).toString().padStart(13, '0');
    const id = `${order}-${crypto.randomUUID()}`;
    const stored: StoredMail = { ...mail, id, sentAt: sentAt.toISOString() };
    await this.bucket.put(`${PREFIX}${id}.json`, JSON.stringify(stored), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { to: mail.to.toLowerCase(), category: mail.category },
    });
    return { messageId: `dev-${id}` };
  }

  async list(options: { to?: string; limit?: number } = {}): Promise<StoredMail[]> {
    const limit = options.limit ?? 50;
    const listing = await this.bucket.list({
      prefix: PREFIX,
      limit: 500,
      include: ['customMetadata'],
    });
    const wanted = options.to?.toLowerCase();
    const keys = listing.objects
      .filter((object) => !wanted || object.customMetadata?.to === wanted)
      .slice(0, limit)
      .map((object) => object.key);
    const messages = await Promise.all(keys.map((key) => this.bucket.get(key)));
    const parsed = await Promise.all(
      messages.filter((m): m is R2ObjectBody => m !== null).map((m) => m.json<StoredMail>()),
    );
    return parsed;
  }

  async get(id: string): Promise<StoredMail | null> {
    if (!/^[0-9]{13}-[0-9a-f-]{36}$/.test(id)) return null;
    const object = await this.bucket.get(`${PREFIX}${id}.json`);
    return object ? object.json<StoredMail>() : null;
  }
}

/** RFC 5322 display-name formatting with RFC 2047 encoding for non-ASCII names. */
export function formatAddress({ name, address }: Address): string {
  if (!name) return address;
  if (/^[\x20-\x7e]*$/.test(name)) {
    return `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`;
  }
  const bytes = new TextEncoder().encode(name);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?= <${address}>`;
}

/** Escapes text for safe interpolation into HTML email bodies. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Domains the dev mail service has that Swarm didn't create there, as another environment's or the
 * operator's own would be (tests seed it). remove() forgets one.
 */
export const devProviderDomains = new Set<string>();

/**
 * Domain identities for development and tests: fixed DKIM tokens, and every domain verifies on
 * the first status check. Never selectable outside development and test.
 */
export class DevDomainIdentities implements DomainIdentities {
  async create(domain: string, mailFromDomain: string): Promise<CreatedIdentity> {
    if (devProviderDomains.has(domain.toLowerCase())) throw new IdentityExistsError(domain);
    const base = domain
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 20)
      .toLowerCase();
    const tokens = [1, 2, 3].map((n) => `dev${n}${base}`);
    return {
      records: sesIdentityRecords(domain, tokens, 'us-east-1', mailFromDomain),
      providerRef: null,
    };
  }

  async records(domain: string): Promise<ProviderDnsRecord[]> {
    return (await this.create(domain, `bounce.${domain}`)).records;
  }

  async status(): Promise<DomainIdentityStatus> {
    return { verifiedForSending: true, dkimStatus: 'success', mailFromStatus: 'success' };
  }

  async remove(domain: string): Promise<void> {
    devProviderDomains.delete(domain.toLowerCase());
  }
}

/** A call recorded by DevDedicatedSending. */
interface DedicatedCall {
  method: 'createConfigurationSet' | 'createDedicatedIpPool' | 'attachPool' | 'poolWarmup';
  args: string[];
}

/** Every DevDedicatedSending call in this isolate, oldest first (tests read it). */
export const devDedicatedCalls: DedicatedCall[] = [];

/**
 * Dedicated sending for development and tests: records each call and reports every pool as
 * warmed up. Never selectable outside development and test (it rides on MAIL_ADAPTER=dev).
 */
export class DevDedicatedSending {
  private record(method: DedicatedCall['method'], ...args: string[]) {
    devDedicatedCalls.push({ method, args });
    if (devDedicatedCalls.length > 1000) devDedicatedCalls.splice(0, 500);
  }
  async createConfigurationSet(name: string): Promise<void> {
    this.record('createConfigurationSet', name);
  }
  async createDedicatedIpPool(name: string): Promise<void> {
    this.record('createDedicatedIpPool', name);
  }
  async attachPool(configurationSet: string, pool: string): Promise<void> {
    this.record('attachPool', configurationSet, pool);
  }
  async poolWarmup(pool: string): Promise<{ state: 'done'; percent: number }> {
    this.record('poolWarmup', pool);
    return { state: 'done', percent: 100 };
  }
}

export * from './click-map';
export * from './click-map-scale';
export * from './css';
export * from './highlight';
/** A call recorded by DevSuppressionList. */
interface SuppressionCall {
  method: 'putSuppressed' | 'deleteSuppressed' | 'listSuppressed';
  args: string[];
}

/** Every DevSuppressionList call in this isolate, oldest first (tests read it). */
export const devSuppressionCalls: SuppressionCall[] = [];

/** The dev provider's suppression list, by lowercased address (tests may seed it). */
export const devSuppressedDestinations = new Map<
  string,
  { reason: 'BOUNCE' | 'COMPLAINT'; updatedAt: number }
>();

/** Addresses whose next DevSuppressionList put or delete fails with a retryable error (tests). */
export const devSuppressionFailures = new Set<string>();

/**
 * The provider suppression list for development and tests: an in-memory list that records each
 * call. Never selectable outside development and test (it rides on MAIL_ADAPTER=dev).
 */
export class DevSuppressionList {
  private record(method: SuppressionCall['method'], ...args: string[]) {
    devSuppressionCalls.push({ method, args });
    if (devSuppressionCalls.length > 1000) devSuppressionCalls.splice(0, 500);
  }
  private fail(email: string) {
    if (!devSuppressionFailures.delete(email.toLowerCase())) return;
    throw Object.assign(new Error('dev suppression list: injected failure'), { retryable: true });
  }
  async putSuppressed(email: string, reason: 'BOUNCE' | 'COMPLAINT'): Promise<void> {
    this.record('putSuppressed', email, reason);
    this.fail(email);
    devSuppressedDestinations.set(email.toLowerCase(), { reason, updatedAt: Date.now() });
  }
  async deleteSuppressed(email: string): Promise<void> {
    this.record('deleteSuppressed', email);
    this.fail(email);
    devSuppressedDestinations.delete(email.toLowerCase());
  }
  async listSuppressed(input: { from: number; to: number; nextToken?: string | undefined }) {
    this.record('listSuppressed', String(input.from), String(input.to), input.nextToken ?? '');
    const items = [...devSuppressedDestinations]
      .filter(([, row]) => row.updatedAt >= input.from && row.updatedAt < input.to)
      .map(([email, row]) => ({ email, reason: row.reason, updatedAt: row.updatedAt }));
    return { items, nextToken: null };
  }
}

export * from './blocklist';
export * from './content-check';
export * from './dns-check';
export * from './errors';
export * from './mailgun';
export * from './mime';
export * from './postmark';
export * from './render';
export * from './resend';
export * from './ses';
export * from './service-change';
export * from './sigv4';
export * from './smtp';
export * from './snippets';
export * from './system-mail';
export * from './web';
