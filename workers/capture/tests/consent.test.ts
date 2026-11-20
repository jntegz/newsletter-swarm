import { env } from 'cloudflare:test';
import { defaultCaptureFormConfig } from '@swarm/domain';
import { FORM_STAMP_DAYS, formStamp } from '@swarm/engine';
import { describe, expect, it } from 'vitest';
import { testLinks } from './links';
import { turnstile } from './turnstile';
import {
  HOST,
  call,
  enableFlag,
  mailTo,
  member,
  republish,
  seedChannel,
  seedForm,
  submitForm,
  submitJson,
  uniqueEmail,
} from './helpers';

const WORDING_V1 = 'I agree to receive this newsletter.';
const WORDING_V2 = 'I agree to receive this newsletter and offers.';

const consents = (memberId: string) =>
  env.DB.prepare('SELECT * FROM member_consents WHERE member_id = ?1 ORDER BY id')
    .bind(memberId)
    .all<{
      source: string;
      form_id: string | null;
      form_version: number | null;
      wording: string | null;
      ticked: number | null;
      must_confirm: number;
      version_claimed: number;
      verified_host: string | null;
      claimed_origin: string | null;
      stamped_at: number | null;
    }>()
    .then((result) => result.results);

describe('requiring confirmation', () => {
  it.each([
    // Channel settings, form setting, status expected.
    [{}, null, 'pending'],
    [{}, false, 'active'],
    [{ doubleOptIn: false }, null, 'active'],
    [{ doubleOptIn: false }, true, 'pending'],
    // The new setting wins over a form set to off, and over a default turned off.
    [{ requireConfirmation: true }, false, 'pending'],
    [{ requireConfirmation: true, doubleOptIn: false }, false, 'pending'],
  ] as const)('channel %j with form %j gives %s', async (settings, form, status) => {
    const channel = await seedChannel(settings);
    const { id } = await seedForm(channel, { doubleOptIn: form });
    const email = uniqueEmail();
    expect((await submitJson(id, { email })).status).toBe(200);
    expect(await member(channel.channelId, email)).toMatchObject({ status });
  });
});

describe('the consent record', () => {
  it('keeps the wording, the version and the box for a new subscriber', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { consent: { text: WORDING_V1, required: true } });
    const email = uniqueEmail();
    await submitJson(id, { email, consent: true, formVersion: 1 });
    const row = await member(channel.channelId, email);
    expect(await consents(row!.id)).toMatchObject([
      {
        source: 'form',
        form_id: id,
        form_version: 1,
        wording: WORDING_V1,
        ticked: 1,
        must_confirm: 1,
      },
    ]);
  });

  it('keeps the wording the reader saw when a cached page shows an older version', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { consent: { text: WORDING_V1, required: true } });
    await republish(id, {
      ...defaultCaptureFormConfig(),
      consent: { text: WORDING_V2, required: true },
    });
    const old = uniqueEmail('old');
    await submitJson(id, { email: old, consent: true, formVersion: 1 });
    const oldRow = await member(channel.channelId, old);
    expect(await consents(oldRow!.id)).toMatchObject([{ form_version: 1, wording: WORDING_V1 }]);

    const latest = uniqueEmail('latest');
    await submitJson(id, { email: latest, consent: true, formVersion: 2 });
    const latestRow = await member(channel.channelId, latest);
    expect(await consents(latestRow!.id)).toMatchObject([{ form_version: 2, wording: WORDING_V2 }]);
  });

  it('marks an older version as claimed, and applies its own required box', async () => {
    const channel = await seedChannel();
    // Version 1 had a required box; version 2 (served now) has none.
    const { id } = await seedForm(channel, { consent: { text: WORDING_V1, required: true } });
    await republish(id, { ...defaultCaptureFormConfig(), consent: null });
    const current = uniqueEmail('current');
    await submitJson(id, { email: current, formVersion: 2 });
    const currentRow = await member(channel.channelId, current);
    expect(await consents(currentRow!.id)).toMatchObject([
      { form_version: 2, wording: null, ticked: null, version_claimed: 0 },
    ]);
    // Naming version 1 without its box is refused, not recorded as a version with no box.
    const skipped = uniqueEmail('skipped');
    expect((await submitJson(id, { email: skipped, formVersion: 1 })).status).toBe(400);
    expect(await member(channel.channelId, skipped)).toBeNull();
    // Ticked: the record keeps version 1's wording, but as what the submission said it showed.
    const cached = uniqueEmail('cached');
    await submitJson(id, { email: cached, consent: true, formVersion: 1 });
    const cachedRow = await member(channel.channelId, cached);
    expect(await consents(cachedRow!.id)).toMatchObject([
      { form_version: 1, wording: WORDING_V1, ticked: 1, version_claimed: 1 },
    ]);
  });

  it('records an older version as shown when the server stamped it, and as claimed when not', async () => {
    const keys = testLinks();
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { consent: { text: WORDING_V1, required: true } });
    await republish(id, { ...defaultCaptureFormConfig(), consent: null });
    // A cached site page of version 1, stamped when it was rendered an hour ago.
    const issued = Date.now() - 3_600_000;
    const stamped = uniqueEmail('stamped');
    await submitJson(id, {
      email: stamped,
      consent: true,
      formVersion: 1,
      formStamp: await formStamp(keys, id, 1, issued),
    });
    const [record] = await consents((await member(channel.channelId, stamped))!.id);
    expect(record).toMatchObject({ form_version: 1, wording: WORDING_V1, version_claimed: 0 });
    expect(Math.abs(record!.stamped_at! - issued)).toBeLessThan(1000);
    // The stamp's version is what counts, and its required box still applies.
    expect(
      (
        await submitJson(id, {
          email: uniqueEmail('skip'),
          formVersion: 2,
          formStamp: await formStamp(keys, id, 1),
        })
      ).status,
    ).toBe(400);
    // A plain post carries it too.
    const plain = uniqueEmail('plain');
    await submitForm(id, {
      email: plain,
      consent: 'yes',
      formVersion: '1',
      formStamp: await formStamp(keys, id, 1),
      website: '',
      'cf-turnstile-response': 'ok',
    });
    expect(await consents((await member(channel.channelId, plain))!.id)).toMatchObject([
      { form_version: 1, version_claimed: 0 },
    ]);
    // A stamp for another form, a forged one, an expired one, or none: claimed, as before.
    const other = await seedForm(channel, { consent: { text: WORDING_V1, required: true } });
    const expired = Date.now() - (FORM_STAMP_DAYS + 1) * 86_400_000;
    const wrong = [
      await formStamp(keys, other.id, 1),
      `${(await formStamp(keys, id, 1)).slice(0, -4)}AAAA`,
      await formStamp(keys, id, 1, expired),
      undefined,
    ];
    for (const formStamp of wrong) {
      const email = uniqueEmail('claim');
      await submitJson(id, { email, consent: true, formVersion: 1, formStamp });
      expect(await consents((await member(channel.channelId, email))!.id)).toMatchObject([
        { form_version: 1, version_claimed: 1, stamped_at: null },
      ]);
    }
  });

  it('stamps the current version on the form frame it serves', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const res = await call(`/v1/${id}/frame?v=1`, { headers: { referer: `${HOST}/` } });
    const html = await res.text();
    const config = JSON.parse(
      /<script type="application\/json" id="swarm-form">([^<]*)<\/script>/.exec(html)![1]!,
    ) as { stamp: string; version: number };
    const email = uniqueEmail('frame');
    await submitJson(id, { email, formVersion: config.version, formStamp: config.stamp });
    const [record] = await consents((await member(channel.channelId, email))!.id);
    expect(record!.stamped_at).not.toBeNull();
  });

  it('falls back to the latest wording for a version that does not exist', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { consent: { text: WORDING_V1, required: true } });
    const email = uniqueEmail();
    await submitJson(id, { email, consent: true, formVersion: 999 });
    const row = await member(channel.channelId, email);
    expect(await consents(row!.id)).toMatchObject([{ form_version: 1, wording: WORDING_V1 }]);
  });

  it('records an optional box left empty, and a form with no box', async () => {
    const channel = await seedChannel();
    const optional = await seedForm(channel, { consent: { text: WORDING_V1, required: false } });
    const empty = uniqueEmail('empty');
    await submitJson(optional.id, { email: empty, consent: false });
    const emptyRow = await member(channel.channelId, empty);
    expect(await consents(emptyRow!.id)).toMatchObject([{ wording: WORDING_V1, ticked: 0 }]);

    const plain = await seedForm(channel);
    const none = uniqueEmail('none');
    await submitJson(plain.id, { email: none });
    const noneRow = await member(channel.channelId, none);
    expect(await consents(noneRow!.id)).toMatchObject([{ wording: null, ticked: null }]);
  });

  it('carries the version through a plain form post', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { consent: { text: WORDING_V1, required: true } });
    const email = uniqueEmail();
    await submitForm(id, {
      email,
      consent: 'yes',
      formVersion: '1',
      website: '',
      'cf-turnstile-response': 'ok',
    });
    const row = await member(channel.channelId, email);
    expect(await consents(row!.id)).toMatchObject([{ form_version: 1, ticked: 1 }]);
  });

  it('adds nothing for an address that is already active', async () => {
    const channel = await seedChannel({ doubleOptIn: false });
    const { id } = await seedForm(channel);
    const email = uniqueEmail();
    await submitJson(id, { email });
    await submitJson(id, { email });
    const row = await member(channel.channelId, email);
    expect(await consents(row!.id)).toHaveLength(1);
  });
});

describe('a website signup in steps', () => {
  const plain = (id: string, email: string, extra: Record<string, string> = {}) =>
    submitForm(id, { email, join: '1', 'cf-turnstile-response': 'ok', ...extra });

  it('saves the address at once and goes on to the site, with no address in the URL', async () => {
    const channel = await seedChannel({ signupPath: 'email_name' });
    await enableFlag(channel.channelId, 'signup_paths');
    const { id } = await seedForm(channel);
    const email = uniqueEmail();
    const res = await plain(id, email);
    expect(res.status).toBe(303);
    const location = res.headers.get('location')!;
    expect(location.startsWith(`http://${channel.slug}.swarm.test/_swarm/join/`)).toBe(true);
    expect(location).not.toContain(encodeURIComponent(email));
    expect(location).not.toContain(email);
    // Leaving now still leaves them on the list.
    expect(await member(channel.channelId, email)).toMatchObject({ status: 'pending' });
    expect(await mailTo(email)).toHaveLength(1);
  });

  it('gives a known address the same answer, and a required name can wait', async () => {
    const channel = await seedChannel({ signupPath: 'email_name' });
    await enableFlag(channel.channelId, 'signup_paths');
    const { id } = await seedForm(channel, {
      fields: [
        { key: 'email', label: 'Email', required: true },
        { key: 'first_name', label: 'First name', required: true },
      ],
    });
    const email = uniqueEmail();
    const first = await plain(id, email);
    const again = await plain(id, email);
    expect(first.status).toBe(303);
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toContain('/_swarm/join/');
  });

  it('keeps the ordinary answer when the flag is off, the path is email or no step is asked', async () => {
    const off = await seedChannel({ signupPath: 'email_name' });
    const form = await seedForm(off);
    expect((await plain(form.id, uniqueEmail())).status).toBe(200);

    const email = await seedChannel({ signupPath: 'email' });
    await enableFlag(email.channelId, 'signup_paths');
    const emailForm = await seedForm(email);
    expect((await plain(emailForm.id, uniqueEmail())).status).toBe(200);

    const on = await seedChannel({ signupPath: 'email_name' });
    await enableFlag(on.channelId, 'signup_paths');
    const onForm = await seedForm(on);
    const res = await submitForm(onForm.id, {
      email: uniqueEmail(),
      'cf-turnstile-response': 'ok',
    });
    expect(res.status).toBe(200);
  });

  it('lets the challenge page lead on to the site', async () => {
    const channel = await seedChannel({ signupPath: 'email_name' });
    await enableFlag(channel.channelId, 'signup_paths');
    const { id } = await seedForm(channel);
    const res = await submitForm(id, { email: uniqueEmail(), join: '1' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain(
      `form-action 'self' http://${channel.slug}.swarm.test`,
    );
    expect(await res.text()).toContain('name="join" value="1"');
  });
});

describe('where the form was (S04-P2-TR-form-origin-honest-binding)', () => {
  it('keeps the host Turnstile reported for a pass bound to this form apart from the claimed site', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { doubleOptIn: false });
    turnstile.hostname = 'widget.forms.swarm.test';
    turnstile.cdata = id;
    const email = uniqueEmail();
    await submitJson(id, { email, parentOrigin: 'https://anything.example' });
    const row = await member(channel.channelId, email);
    expect(await consents(row!.id)).toMatchObject([
      { verified_host: 'widget.forms.swarm.test', claimed_origin: 'https://anything.example' },
    ]);
  });

  it('never takes the host of a pass bound to another form: the forms address stands instead', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { doubleOptIn: false });
    turnstile.hostname = 'elsewhere.example';
    turnstile.cdata = 'cf_another_form';
    const email = uniqueEmail();
    await submitJson(id, { email });
    const row = await member(channel.channelId, email);
    expect(await consents(row!.id)).toMatchObject([
      { verified_host: 'forms.swarm.test', claimed_origin: HOST },
    ]);
  });

  it('records a plain post’s claimed site from its Origin, and the forms address as verified', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel, { doubleOptIn: false });
    const email = uniqueEmail();
    await submitForm(id, { email, 'cf-turnstile-response': 'token', website: '' });
    const row = await member(channel.channelId, email);
    expect(await consents(row!.id)).toMatchObject([
      { verified_host: 'forms.swarm.test', claimed_origin: HOST },
    ]);
  });
});
