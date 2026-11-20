// The built-in emails rendered for real: every starter template through the Dispatch renderer,
// and the Member-facing and operator emails through the frame they share with it.
import { STARTER_TEMPLATES } from '@swarm/domain';
import { GMAIL_CLIP_BYTES, personalize, renderDispatch, type OutgoingMail } from '@swarm/mail';
import { describe, expect, it } from 'vitest';
import { sendOperatorNotice } from '../src/flows-notify';
import { builtInWording, memberMail, renderMessage } from '../src/messages';

describe('starter templates as emails', () => {
  it('render with the default design, no warnings and room to spare under Gmail’s limit', () => {
    for (const starter of STARTER_TEMPLATES) {
      const out = renderDispatch(starter.content, {
        channelName: 'Field Notes',
        preheader: starter.preheader,
        mediaUrl: () => null,
        allowHtmlBlocks: false,
      });
      expect(out.warnings, starter.key).toEqual([]);
      expect(new TextEncoder().encode(out.html).length, starter.key).toBeLessThan(
        GMAIL_CLIP_BYTES / 4,
      );
      expect(out.text.length, starter.key).toBeGreaterThan(600);
      for (const link of out.links) expect(link, starter.key).toMatch(/^https:\/\/example\.com\//);
    }
  });

  it('greet a reader by name, or as “there” when there is no name', () => {
    const welcome = STARTER_TEMPLATES.find((s) => s.key === 'welcome')!;
    const template = renderDispatch(welcome.content, {
      channelName: 'Field Notes',
      mediaUrl: () => null,
      allowHtmlBlocks: false,
    });
    const send = (firstName: string | null) =>
      personalize(
        { ...template, subject: welcome.subject },
        {
          link: (i) => template.links[i]!,
          unsubscribeUrl: 'https://example.com/u',
          pixelUrl: null,
          member: { email: 'ada@example.com', firstName },
        },
      );
    expect(send('Ada').text).toMatch(/^Hi Ada,/);
    expect(send(null).html).toContain('>Hi there,</p>');
  });
});

describe('Member-facing system emails', () => {
  const mail = memberMail({
    channelName: 'Field <Notes>',
    accent: '#14203a',
    heading: 'Confirm your subscription',
    paragraphs: ['Tap the button to confirm.', 'It takes a second.'],
    button: { label: 'Confirm', url: 'https://example.com/c?a=1&b=2' },
    footnote: 'The link works for 7 days.',
  });

  it('keep their words in both parts', () => {
    expect(mail.text).toBe(
      'Field <Notes>\n\nConfirm your subscription\n\nTap the button to confirm.\n\nIt takes a second.\n\nConfirm: https://example.com/c?a=1&b=2\n\nThe link works for 7 days.\n',
    );
    for (const words of [
      'Field &lt;Notes&gt;',
      '>Confirm your subscription</h1>',
      '>Tap the button to confirm.</p>',
      '>It takes a second.</p>',
      '>The link works for 7 days.</p>',
    ]) {
      expect(mail.html).toContain(words);
    }
  });

  it('are drawn in the shared frame: preview text, Outlook-safe button, dark mode, phone', () => {
    expect(mail.html).toMatch(/mso-hide:all">Tap the button to confirm\.&#847;/);
    expect(mail.html).toContain(
      '<td class="sw-btn" align="center" bgcolor="#14203a" style="background:#14203a;border-radius:999px;mso-padding-alt:13px 24px"><a class="sw-button" href="https://example.com/c?a=1&amp;b=2"',
    );
    expect(mail.html.match(/href=/g)).toHaveLength(1);
    expect(mail.html).toContain('<!--[if mso]><table role="presentation" width="480"');
    expect(mail.html).toContain('@media (prefers-color-scheme:dark)');
    // A navy button would vanish on the dark card, so dark mode lifts it.
    expect(mail.html).toMatch(/\.sw-btn\{background:#[0-9a-f]{6}!important\}/);
    expect(mail.html).toContain('@media (max-width:620px)');
  });

  it('every built-in message renders in it', () => {
    const html = renderMessage('confirm', builtInWording('confirm'), {
      channelName: 'Field Notes',
      accent: '#6c4cf1',
      variables: { channel: 'Field Notes', confirm_url: 'https://example.com/c/abc' },
    }).html;
    expect(html).toContain('class="sw-card"');
    expect(html).toContain('class="sw-button"');
  });
});

describe('operator notices', () => {
  it('send the lines as paragraphs in the shared frame, with a bare address as a link', async () => {
    const sent: OutgoingMail[] = [];
    const count = await sendOperatorNotice(
      {
        mail: {
          send: async (mail: OutgoingMail) => {
            sent.push(mail);
            return { id: 'x' };
          },
        } as never,
        from: 'notifications@mail.example',
      },
      {
        to: ['a@example.com', 'b@example.com'],
        subject: 'Sending from mail.example is paused',
        lines: ['Warm-up paused <sending>.', 'https://app.example/channels/ch_1/deliverability'],
        category: 'ramp_paused',
        tags: {},
      },
    );
    expect(count).toBe(2);
    const { html, text } = sent[0]!;
    expect(text).toBe(
      'Warm-up paused <sending>.\n\nhttps://app.example/channels/ch_1/deliverability\n\nSwarm',
    );
    expect(text).not.toContain('\u2014');
    expect(html).toContain('>Sending from mail.example is paused</h1>');
    expect(html).toContain('>Warm-up paused &lt;sending&gt;.</p>');
    expect(html).toContain(
      '<a class="sw-a" href="https://app.example/channels/ch_1/deliverability"',
    );
    expect(html).toContain('<!--[if mso]><table role="presentation" width="480"');
  });
});
