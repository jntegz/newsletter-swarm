import { env } from 'cloudflare:test';
import { renderMessage } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { enableFlag, mailTo, seedChannel, seedForm, submitJson, uniqueEmail } from './helpers';

const save = (
  channelId: string,
  fields: { subject: string; mode?: string; heading?: string; body: string; button?: string },
) =>
  env.DB.prepare(
    `INSERT INTO channel_messages (channel_id, key, subject, mode, heading, body, button_label, updated_at)
     VALUES (?1, 'confirm', ?2, ?3, ?4, ?5, ?6, 0)`,
  )
    .bind(
      channelId,
      fields.subject,
      fields.mode ?? 'text',
      fields.heading ?? 'Almost there',
      fields.body,
      fields.button ?? 'Yes, sign me up',
    )
    .run();

async function signUp(settings = {}) {
  const channel = await seedChannel(settings);
  const { id } = await seedForm(channel);
  return {
    channel,
    join: async () => {
      const email = uniqueEmail();
      expect((await submitJson(id, { email })).status).toBe(200);
      return (await mailTo(email)).at(-1)!;
    },
  };
}

describe('editable system emails', () => {
  it('sends the owner’s wording, in the standard design', async () => {
    const { channel, join } = await signUp();
    await enableFlag(channel.channelId, 'message_templates');
    await save(channel.channelId, {
      subject: 'One click for {{channel_name}}',
      body: 'Hello there.',
    });
    const mail = await join();
    expect(mail.subject).toBe('One click for Field Notes');
    expect(mail.html).toContain('Almost there');
    expect(mail.html).toContain('Yes, sign me up');
    expect(mail.text).toContain('/v1/confirm/');
  });

  it('sends the owner’s HTML, with a text part and the real link', async () => {
    const { channel, join } = await signUp();
    await enableFlag(channel.channelId, 'message_templates');
    await save(channel.channelId, {
      subject: 'Confirm',
      mode: 'html',
      body: '<h1>Hi</h1><p><a href="{{confirm_url}}">Confirm &amp; join</a></p>',
    });
    const mail = await join();
    expect(mail.html).toMatch(/<a href="[^"]*\/v1\/confirm\/[^"]+">Confirm &amp; join<\/a>/);
    expect(mail.text).toContain('/v1/confirm/');
    expect(mail.text).not.toContain('<h1>');
  });

  it('ignores saved wording with the flag off', async () => {
    const { channel, join } = await signUp();
    await save(channel.channelId, { subject: 'Mine', body: 'Mine' });
    expect((await join()).subject).toBe('Confirm your email for Field Notes');
  });

  it('still sends a confirmation when the saved wording is unusable or unreadable', async () => {
    const broken = await signUp();
    await enableFlag(broken.channel.channelId, 'message_templates');
    // Saved before a rule existed: HTML with no link can't do its job.
    await save(broken.channel.channelId, { subject: 'X', mode: 'html', body: '<p>No link</p>' });
    const fallback = await broken.join();
    expect(fallback.subject).toBe('Confirm your email for Field Notes');
    expect(fallback.text).toContain('/v1/confirm/');

    const failing = await signUp();
    await enableFlag(failing.channel.channelId, 'message_templates');
    await save(failing.channel.channelId, { subject: 'Mine', body: 'Mine' });
    const real = env.DB.prepare.bind(env.DB);
    const spied = env.DB as unknown as { prepare: (sql: string) => D1PreparedStatement };
    spied.prepare = (sql: string) => {
      if (sql.includes('FROM channel_messages')) throw new Error('database unavailable');
      return real(sql);
    };
    try {
      const mail = await failing.join();
      expect(mail.subject).toBe('Confirm your email for Field Notes');
    } finally {
      spied.prepare = real;
    }
  });

  it('escapes values in HTML and keeps a subject to one line', () => {
    const out = renderMessage(
      'gift_recipient',
      {
        subject: 'From {{buyer_email}}',
        mode: 'html',
        heading: '',
        body: '<p>{{buyer_email}}</p><a href="{{claim_url}}">Claim</a>',
        buttonLabel: '',
      },
      {
        channelName: 'Field Notes',
        accent: '#000000',
        variables: {
          buyer_email: '<b>x</b>\r\nBcc: victim@example.com',
          claim_url: 'https://example.com/?a=1&b=2',
        },
      },
    );
    expect(out.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(out.html).toContain('a=1&amp;b=2');
    expect(out.subject).not.toMatch(/[\r\n]/);
  });

  it('fills a variable named like an Object.prototype member with nothing', () => {
    // Wording saved before such names were refused may still hold one.
    const out = renderMessage(
      'confirm',
      {
        subject: 'Hi {{constructor}}',
        mode: 'text',
        heading: '',
        body: 'Confirm {{constructor}}.',
        buttonLabel: 'Confirm',
      },
      {
        channelName: 'Field Notes',
        accent: '#000000',
        variables: { confirm_url: 'https://example.com/c', channel_name: 'Field Notes' },
      },
    );
    expect(out.subject).toBe('Hi');
    expect(out.text).not.toContain('native code');
  });
});
