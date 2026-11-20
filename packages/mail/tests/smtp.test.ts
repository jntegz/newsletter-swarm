import { describe, expect, it } from 'vitest';
import type { SmtpError } from '../src/index';
import {
  MailProviderError,
  SmtpClient,
  SmtpDomains,
  SmtpMail,
  dotStuff,
  type SmtpConnect,
  type SmtpSocket,
} from '../src/index';

interface ServerOptions {
  /** Offered in the EHLO answer. */
  starttls?: boolean;
  auth?: string;
  /** Answers by the start of a command, instead of the normal one. */
  answers?: Record<string, string>;
  /** Says nothing after this command. */
  hangAfter?: string;
  closeOnConnect?: boolean;
  greeting?: string;
}

/** A mail server that follows the SMTP conversation and records what it hears. */
function fakeServer(options: ServerOptions = {}) {
  const heard: { line: string; encrypted: boolean }[] = [];
  const state = {
    encrypted: false,
    data: null as string | null,
    closed: 0,
    connects: [] as { port: number; secureTransport: string }[],
  };
  let loginAnswers = 0;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const makeSocket = (): SmtpSocket => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    const say = (text: string) => controller.enqueue(encoder.encode(text));
    let inData = false;
    let buffer = '';
    const hear = (line: string) => {
      heard.push({ line, encrypted: state.encrypted });
      if (options.hangAfter && line.startsWith(options.hangAfter)) return;
      const answer = Object.entries(options.answers ?? {}).find(([start]) =>
        line.startsWith(start),
      )?.[1];
      if (answer) return say(answer);
      if (line.startsWith('EHLO')) {
        const lines = ['250-mail.test'];
        if (options.starttls ?? true) lines.push('250-STARTTLS');
        if (options.auth ?? 'PLAIN LOGIN') lines.push(`250-AUTH ${options.auth ?? 'PLAIN LOGIN'}`);
        lines.push('250 SIZE 1000000');
        return say(`${lines.join('\r\n')}\r\n`);
      }
      if (line === 'STARTTLS') return say('220 go ahead\r\n');
      if (line.startsWith('AUTH PLAIN')) return say('235 ok\r\n');
      if (line === 'AUTH LOGIN') {
        loginAnswers = 2;
        return say('334 VXNlcm5hbWU6\r\n');
      }
      if (line === 'DATA') {
        inData = true;
        return say('354 go\r\n');
      }
      if (line === 'QUIT') return say('221 bye\r\n');
      if (loginAnswers > 0) {
        loginAnswers--;
        return say(loginAnswers === 1 ? '334 UGFzc3dvcmQ6\r\n' : '235 ok\r\n');
      }
      return say('250 ok\r\n');
    };
    const socket: SmtpSocket = {
      readable,
      writable: new WritableStream<Uint8Array>({
        write: (chunk) => {
          buffer += decoder.decode(chunk);
          if (inData) {
            const end = buffer.indexOf('\r\n.\r\n');
            if (end === -1) return;
            state.data = buffer.slice(0, end);
            buffer = buffer.slice(end + 5);
            inData = false;
            say((options.answers ?? {})['.'] ?? '250 queued\r\n');
            return;
          }
          let end: number;
          while ((end = buffer.indexOf('\r\n')) !== -1) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            hear(line);
          }
        },
      }),
      startTls: () => {
        state.encrypted = true;
        const next = makeSocket();
        // A server greets nobody again after STARTTLS; it waits for EHLO.
        return next;
      },
      close: async () => {
        state.closed++;
      },
    };
    return Object.assign(socket, { say });
  };

  const connect: SmtpConnect = async ({ port }, { secureTransport }) => {
    state.connects.push({ port, secureTransport });
    if (options.closeOnConnect) throw new Error('connection refused');
    state.encrypted = secureTransport === 'on';
    const socket = makeSocket() as SmtpSocket & { say(text: string): void };
    socket.say(options.greeting ?? '220 mail.test ready\r\n');
    return socket;
  };
  return { connect, heard, state };
}

const config = {
  host: 'mail.test',
  username: 'user@test',
  password: 'test-only-password',
  heloName: 'swarm.test',
  timeoutMs: 200,
};
const client = (server: ReturnType<typeof fakeServer>, port = 587) =>
  new SmtpClient({ ...config, port, connect: server.connect });

const mail = {
  category: 'broadcast',
  from: { name: 'Field Notes', address: 'notes@news.example' },
  to: 'reader@example.org',
  subject: 'Hello',
  html: '<p>Hi</p>',
  text: 'Hi',
  messageId: 'dl_1@news.example',
};

const failure = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error as SmtpError,
  );

describe('SmtpClient', () => {
  it('upgrades to TLS on 587 before it sends the login or the message', async () => {
    const server = fakeServer();
    await client(server).send('bounce@u.example', 'reader@example.org', 'Subject: x\r\n\r\nHi');
    expect(server.state.connects).toEqual([{ port: 587, secureTransport: 'starttls' }]);
    expect(server.heard.map((h) => h.line.split(' ')[0]!)).toEqual([
      'EHLO',
      'STARTTLS',
      'EHLO',
      'AUTH',
      'MAIL',
      'RCPT',
      'DATA',
      'QUIT',
    ]);
    // Everything from the second EHLO on went over TLS.
    expect(server.heard.slice(2).every((h) => h.encrypted)).toBe(true);
    expect(server.heard.slice(0, 2).some((h) => h.line.startsWith('AUTH'))).toBe(false);
    expect(server.heard.map((h) => h.line)).toContain('MAIL FROM:<bounce@u.example>');
    expect(server.heard.map((h) => h.line)).toContain('RCPT TO:<reader@example.org>');
    expect(server.state.data).toBe('Subject: x\r\n\r\nHi');
    expect(server.state.closed).toBe(1);
  });

  it('uses TLS from the start on 465, without STARTTLS', async () => {
    const server = fakeServer({ starttls: false });
    await client(server, 465).send('a@b.example', 'c@d.example', 'x');
    expect(server.state.connects).toEqual([{ port: 465, secureTransport: 'on' }]);
    expect(server.heard.map((h) => h.line)).not.toContain('STARTTLS');
    expect(server.heard.every((h) => h.encrypted)).toBe(true);
  });

  it('refuses a server without STARTTLS, and never sends the password', async () => {
    const server = fakeServer({ starttls: false });
    const error = await failure(client(server).send('a@b.example', 'c@d.example', 'x'));
    expect(error.code).toBe('tls_required');
    expect(error.halting).toBe(true);
    expect(server.heard.some((h) => h.line.startsWith('AUTH'))).toBe(false);
    expect(server.state.closed).toBe(1);
  });

  it('logs in with PLAIN when offered', async () => {
    const server = fakeServer();
    await client(server).send('a@b.example', 'c@d.example', 'x');
    const auth = server.heard.find((h) => h.line.startsWith('AUTH'))!.line;
    expect(atob(auth.slice('AUTH PLAIN '.length))).toBe('\0user@test\0test-only-password');
  });

  it('falls back to LOGIN', async () => {
    const server = fakeServer({ auth: 'LOGIN' });
    await client(server).send('a@b.example', 'c@d.example', 'x');
    const lines = server.heard.map((h) => h.line);
    expect(lines).toContain('AUTH LOGIN');
    expect(lines).toContain(btoa('user@test'));
    expect(lines).toContain(btoa('test-only-password'));
  });

  it('stops the send when the login is refused, and keeps the password out of the error', async () => {
    const server = fakeServer({ answers: { 'AUTH PLAIN': '535 bad credentials\r\n' } });
    const error = await failure(client(server).send('a@b.example', 'c@d.example', 'x'));
    expect(error).toBeInstanceOf(MailProviderError);
    expect([error.status, error.halting, error.retryable]).toEqual([535, true, false]);
    expect(JSON.stringify([error.message, error.code])).not.toContain('test-only-password');
    expect(server.heard.some((h) => h.line.startsWith('MAIL'))).toBe(false);
  });

  it('stops the send when no login method is offered', async () => {
    const server = fakeServer({ auth: 'GSSAPI' });
    const error = await failure(client(server).send('a@b.example', 'c@d.example', 'x'));
    expect([error.code, error.halting]).toEqual(['auth_unsupported', true]);
  });

  it('fails only this email when a recipient is refused', async () => {
    const server = fakeServer({ answers: { RCPT: '550 no such user\r\n' } });
    const error = await failure(client(server).send('a@b.example', 'c@d.example', 'x'));
    expect([error.status, error.halting, error.retryable]).toEqual([550, false, false]);
    expect(server.state.closed).toBe(1);
  });

  it('retries a 4xx answer, including at the end of the message', async () => {
    const greylisted = fakeServer({ answers: { RCPT: '451 try later\r\n' } });
    const first = await failure(client(greylisted).send('a@b.example', 'c@d.example', 'x'));
    expect([first.retryable, first.halting]).toEqual([true, false]);
    const full = fakeServer({ answers: { '.': '452 queue full\r\n' } });
    expect((await failure(client(full).send('a@b.example', 'c@d.example', 'x'))).retryable).toBe(
      true,
    );
  });

  it('retries a failed connection, a silent server and a wrong greeting', async () => {
    const refused = await failure(
      client(fakeServer({ closeOnConnect: true })).send('a@b.example', 'c@d.example', 'x'),
    );
    expect([refused.status, refused.retryable]).toEqual([0, true]);

    const silent = fakeServer({ hangAfter: 'MAIL' });
    const timedOut = await failure(client(silent).send('a@b.example', 'c@d.example', 'x'));
    expect([timedOut.code, timedOut.retryable]).toEqual(['timeout', true]);
    expect(silent.state.closed).toBe(1);

    const busy = await failure(
      client(fakeServer({ greeting: '421 too busy\r\n' })).send('a@b.example', 'c@d.example', 'x'),
    );
    expect(busy.retryable).toBe(true);
    const notSmtp = await failure(
      client(fakeServer({ greeting: 'HTTP/1.1 400 Bad\r\n' })).send(
        'a@b.example',
        'c@d.example',
        'x',
      ),
    );
    expect(notSmtp.code).toBe('bad_reply');
  });

  it('refuses an address that could smuggle a command', async () => {
    const server = fakeServer();
    for (const bad of ['a@b.example>\r\nRCPT TO:<x@y.example', 'a b@c.example', 'nobody']) {
      const error = await failure(client(server).send(bad, 'c@d.example', 'x'));
      expect([error.status, error.retryable]).toEqual([553, false]);
      await failure(client(server).send('c@d.example', bad, 'x'));
    }
    expect(server.state.connects).toEqual([]);
  });

  it('refuses port 25, which Cloudflare blocks', () => {
    expect(() => client(fakeServer(), 25)).toThrow(/port 25/);
  });
});

describe('dotStuff', () => {
  it('doubles a dot at the start of a line, so it cannot end the message', () => {
    expect(dotStuff('.\r\nhi\r\n.dot\r\nmid.dot\r\n..')).toBe(
      '..\r\nhi\r\n..dot\r\nmid.dot\r\n...',
    );
  });

  it('keeps a smuggled end of message inside the message', async () => {
    const server = fakeServer();
    await client(server).send('a@b.example', 'c@d.example', 'one\r\n.\r\nMAIL FROM:<evil@x>');
    expect(server.state.data).toBe('one\r\n..\r\nMAIL FROM:<evil@x>');
    expect(server.heard.map((h) => h.line)).not.toContain('MAIL FROM:<evil@x>');
  });
});

describe('SmtpMail.send', () => {
  it('sends real MIME with its headers, to the return path, and keeps the Message-ID', async () => {
    const server = fakeServer();
    const sent = await new SmtpMail(client(server), 'mail.swarm.test').send({
      ...mail,
      replyTo: 'editor@example.org',
      returnPath: 'bounce+abc@u.example',
      headers: { 'List-Unsubscribe': '<https://link.example/u/x>' },
    });
    expect(sent).toEqual({ messageId: 'dl_1@news.example' });
    expect(server.heard.map((h) => h.line)).toContain('MAIL FROM:<bounce+abc@u.example>');
    expect(server.state.data).toContain('Message-ID: <dl_1@news.example>');
    expect(server.state.data).toContain('List-Unsubscribe: <https://link.example/u/x>');
    expect(server.state.data).toContain('Reply-To: editor@example.org');
    expect(server.state.data).toContain('multipart/alternative');
  });

  it('falls back to the From address when there is no return path', async () => {
    const server = fakeServer();
    await new SmtpMail(client(server), 'mail.swarm.test').send(mail);
    expect(server.heard.map((h) => h.line)).toContain('MAIL FROM:<notes@news.example>');
  });
});

describe('SmtpDomains', () => {
  const domains = (records: Record<string, string[]>) =>
    new SmtpDomains(async (name) => records[name] ?? [], 'sel');

  it('has nothing to create, and removes nothing', async () => {
    expect(await domains({}).create()).toEqual({ records: [], providerRef: null });
    await expect(domains({}).remove()).resolves.toBeUndefined();
  });

  it('waits for the DKIM record before the domain can send', async () => {
    expect(await domains({}).status('news.example')).toEqual({
      verifiedForSending: false,
      dkimStatus: 'pending',
      mailFromStatus: 'pending',
    });
    expect(
      await domains({
        'sel._domainkey.news.example': ['v=DKIM1; k=rsa; p=ABC'],
        'news.example': ['v=spf1 mx ~all'],
      }).status('news.example'),
    ).toEqual({ verifiedForSending: true, dkimStatus: 'success', mailFromStatus: 'success' });
  });

  it('does not count a revoked DKIM key, which has an empty p=', async () => {
    const status = await domains({ 'sel._domainkey.news.example': ['v=DKIM1; p='] }).status(
      'news.example',
    );
    expect(status.verifiedForSending).toBe(false);
  });

  it('treats a DNS failure as not found yet', async () => {
    const failing = new SmtpDomains(async () => {
      throw new Error('DNS down');
    }, 'sel');
    expect((await failing.status('news.example')).dkimStatus).toBe('pending');
  });
});
