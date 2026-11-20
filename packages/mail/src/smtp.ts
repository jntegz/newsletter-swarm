/**
 * A person's own mail server over SMTP, for advanced installs. Workers can reach ports 465 and 587
 * (checked against real servers on 2026-11-04); Cloudflare blocks port 25.
 *
 * - One connection per email. Encryption is required: TLS from the start on 465, STARTTLS
 *   otherwise, and a server that doesn't offer it is refused, so a password never travels in clear.
 * - Plain SMTP has no API, so there is nothing to create for a domain. SmtpDomains only checks DNS
 *   for the DKIM and SPF records the person's own server needs.
 * - As with SES, a connection lost after the message was sent can in rare cases mail twice.
 *
 * The socket is injected, because `cloudflare:sockets` only exists in Workers and the dashboard
 * also imports this package.
 */
import { MailProviderError } from './errors';
import { type MailAdapter, type OutgoingMail, type SentMail } from './index';
import { buildMime } from './mime';
import type {
  CreatedIdentity,
  DomainIdentities,
  DomainIdentityStatus,
  ProviderDnsRecord,
} from './ses';

export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls(): SmtpSocket;
  close(): Promise<void>;
}

export type SmtpConnect = (
  address: { hostname: string; port: number },
  options: { secureTransport: 'on' | 'starttls'; allowHalfOpen: false },
) => Promise<SmtpSocket>;

interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  connect: SmtpConnect;
  /** The name Swarm greets the server with. */
  heloName: string;
  /** How long to wait for each answer. */
  timeoutMs?: number;
}

/** Answers that mean the login was refused, so no email can go out. */
const LOGIN_REFUSED = new Set([530, 534, 535, 538]);

/** Status 0 means the connection failed or timed out. */
export class SmtpError extends MailProviderError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = 'SmtpError';
  }

  /** A connection problem, or a 4xx: the server asks to try again later. */
  override get retryable(): boolean {
    return this.status === 0 || (this.status >= 400 && this.status < 500);
  }

  override get halting(): boolean {
    return LOGIN_REFUSED.has(this.status);
  }
}

interface Reply {
  code: number;
  lines: string[];
}

/** One SMTP conversation: reads whole replies, including the multi-line ones. */
class SmtpConversation {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private buffer = '';

  constructor(
    private socket: SmtpSocket,
    private readonly timeoutMs: number,
  ) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  async write(text: string): Promise<void> {
    await this.writer.write(this.encoder.encode(text));
  }

  private async more(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SmtpError(0, 'timeout', 'The mail server stopped answering')),
        this.timeoutMs,
      );
    });
    try {
      const { value, done } = await Promise.race([this.reader.read(), timeout]);
      if (done) throw new SmtpError(0, 'closed', 'The mail server closed the connection');
      this.buffer += this.decoder.decode(value, { stream: true });
    } finally {
      clearTimeout(timer);
    }
  }

  async read(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end === -1) {
        if (this.buffer.length > 64 * 1024) {
          throw new SmtpError(0, 'bad_reply', 'The mail server sent an endless line');
        }
        await this.more();
        continue;
      }
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      if (!/^\d{3}([ -]|$)/.test(line)) {
        throw new SmtpError(0, 'bad_reply', 'The mail server sent something that is not SMTP');
      }
      lines.push(line.slice(4));
      if (line[3] !== '-') return { code: Number(line.slice(0, 3)), lines };
    }
  }

  /** Sends a line, and throws unless the answer is one of `expected`. */
  async command(line: string | null, expected: number[]): Promise<Reply> {
    if (line !== null) await this.write(`${line}\r\n`);
    const reply = await this.read();
    if (!expected.includes(reply.code)) {
      throw new SmtpError(
        reply.code,
        `smtp_${reply.code}`,
        reply.lines.join(' ').slice(0, 300) || `The mail server answered ${reply.code}`,
      );
    }
    return reply;
  }

  /** Moves the conversation onto TLS, after the server has agreed to STARTTLS. */
  upgrade(): void {
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.socket = this.socket.startTls();
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.buffer = '';
  }

  async close(): Promise<void> {
    await this.socket.close().catch(() => {});
  }
}

const toBase64 = (text: string) => {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const capability = (reply: Reply, name: string): string | null => {
  for (const line of reply.lines) {
    const match = new RegExp(`^${name}(?:[ =](.*))?$`, 'i').exec(line.trim());
    if (match) return match[1] ?? '';
  }
  return null;
};

/** A line starting with a dot gets a second one, so it can't end the message early. */
export const dotStuff = (message: string) => message.replace(/(^|\r\n)\./g, '$1..');

/** Refuses anything that could add a command to the conversation. */
const safeAddress = (address: string): string => {
  if (!/^[^\s<>]+@[^\s<>]+$/.test(address)) {
    throw new SmtpError(553, 'bad_address', 'The address is not valid');
  }
  return address;
};

export class SmtpClient {
  constructor(private readonly config: SmtpConfig) {
    if (config.port === 25) throw new Error('Cloudflare blocks port 25; use 465 or 587');
  }

  /** Sends one message. `data` is the full message, with CRLF line endings. */
  async send(envelopeFrom: string, to: string, data: string): Promise<void> {
    const from = safeAddress(envelopeFrom);
    const rcpt = safeAddress(to);
    const { host, port, heloName, timeoutMs = 20_000 } = this.config;
    const secureTransport = port === 465 ? 'on' : 'starttls';
    let conversation: SmtpConversation | null = null;
    try {
      const socket = await this.config.connect(
        { hostname: host, port },
        { secureTransport, allowHalfOpen: false },
      );
      conversation = new SmtpConversation(socket, timeoutMs);
      await conversation.command(null, [220]);
      let hello = await conversation.command(`EHLO ${heloName}`, [250]);
      if (secureTransport === 'starttls') {
        if (capability(hello, 'STARTTLS') === null) {
          // Treated like a refused login: no email can go out until the server is fixed.
          throw new SmtpError(530, 'tls_required', 'The mail server does not offer STARTTLS');
        }
        await conversation.command('STARTTLS', [220]);
        conversation.upgrade();
        hello = await conversation.command(`EHLO ${heloName}`, [250]);
      }
      await this.logIn(conversation, hello);
      await conversation.command(`MAIL FROM:<${from}>`, [250]);
      await conversation.command(`RCPT TO:<${rcpt}>`, [250, 251]);
      await conversation.command('DATA', [354]);
      await conversation.write(`${dotStuff(data)}\r\n.\r\n`);
      await conversation.command(null, [250]);
      await conversation.write('QUIT\r\n').catch(() => {});
    } catch (error) {
      if (error instanceof SmtpError) throw error;
      throw new SmtpError(0, 'connection', `Could not talk to the mail server: ${String(error)}`);
    } finally {
      await conversation?.close();
    }
  }

  private async logIn(conversation: SmtpConversation, hello: Reply): Promise<void> {
    const { username, password } = this.config;
    const methods = (capability(hello, 'AUTH') ?? '').toUpperCase().split(/\s+/);
    if (methods.includes('PLAIN')) {
      await conversation.command(`AUTH PLAIN ${toBase64(`\0${username}\0${password}`)}`, [235]);
    } else if (methods.includes('LOGIN')) {
      await conversation.command('AUTH LOGIN', [334]);
      await conversation.command(toBase64(username), [334]);
      await conversation.command(toBase64(password), [235]);
    } else {
      throw new SmtpError(535, 'auth_unsupported', 'The mail server offers no login Swarm can use');
    }
  }
}

/** MailAdapter for a person's own server: Broadcasts, transactional mail and Direct Sends alike. */
export class SmtpMail implements MailAdapter {
  /** An unknown server: a small number of connections at once is the polite default. */
  readonly maxConcurrency = 4;

  constructor(
    private readonly client: SmtpClient,
    private readonly messageIdDomain: string,
  ) {}

  async send(mail: OutgoingMail): Promise<SentMail> {
    const messageId = mail.messageId ?? `${crypto.randomUUID()}@${this.messageIdDomain}`;
    const data = buildMime({
      from: mail.from,
      to: mail.to,
      replyTo: mail.replyTo ?? null,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      messageId,
      headers: mail.headers ?? {},
    });
    await this.client.send(mail.returnPath ?? mail.from.address, mail.to, data);
    return { messageId };
  }
}

/** Checks DNS for the records a person's own server needs. Their server does the signing. */
export class SmtpDomains implements DomainIdentities {
  constructor(
    private readonly lookupTxt: (name: string) => Promise<string[]>,
    private readonly dkimSelector: string,
  ) {}

  async create(): Promise<CreatedIdentity> {
    return { records: [], providerRef: null };
  }

  /** Only the person's own server knows these values, so the check looks for any valid record. */
  async records(domain: string): Promise<ProviderDnsRecord[]> {
    return [
      {
        purpose: 'dkim',
        type: 'TXT',
        name: `${this.dkimSelector}._domainkey.${domain}`,
        value: '',
      },
      { purpose: 'mail_from_spf', type: 'TXT', name: domain, value: '' },
    ];
  }

  async status(domain: string): Promise<DomainIdentityStatus> {
    const found = async (name: string, pattern: RegExp) =>
      (await this.lookupTxt(name).catch(() => [])).some((value) => pattern.test(value));
    const dkim = await found(`${this.dkimSelector}._domainkey.${domain}`, /(^|;)\s*p=[^;\s]/);
    const spf = await found(domain, /^"?v=spf1\b/i);
    return {
      verifiedForSending: dkim,
      dkimStatus: dkim ? 'success' : 'pending',
      mailFromStatus: spf ? 'success' : 'pending',
    };
  }

  async remove(): Promise<void> {}
}
