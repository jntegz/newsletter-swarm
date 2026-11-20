// Section analytics (docs/site-themes.md): a signup through the site's own form inside a home
// page section adds one to that section's variant in site_section_daily. The hidden sw_section
// and sw_variant fields are counted for nothing else, and only from the Channel's own site.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  daily,
  member,
  seedChannel,
  seedForm,
  submitForm,
  submitJson,
  uniqueEmail,
} from './helpers';
import { turnstile } from './turnstile';

async function signups(channelId: string) {
  const { results } = await env.DB.prepare(
    `SELECT section_id, variant, reached, signups FROM site_section_daily
      WHERE channel_id = ?1 ORDER BY section_id, variant`,
  )
    .bind(channelId)
    .all<{ section_id: string; variant: string; reached: number; signups: number }>();
  return results;
}

describe('signups by home page section', () => {
  it('counts a signup from the site’s own form for its section and variant', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const site = `http://${channel.slug}.swarm.test`;
    const from = { origin: site, referer: `${site}/` };
    const fields = (email: string, extra: Record<string, string>) => ({
      email,
      'cf-turnstile-response': 'ok',
      ...extra,
    });

    const email = uniqueEmail();
    const res = await submitForm(id, fields(email, { sw_section: 'hero', sw_variant: 'b' }), from);
    expect(res.status).toBe(200);
    expect(await member(channel.channelId, email)).toBeTruthy();
    await submitForm(id, fields(uniqueEmail(), { sw_section: 'hero', sw_variant: 'b' }), from);
    await submitForm(id, fields(uniqueEmail(), { sw_section: 'hero', sw_variant: 'a' }), from);
    await submitForm(
      id,
      fields(uniqueEmail(), { sw_section: 'subscribe_band-2', sw_variant: 'a' }),
      from,
    );
    expect(await signups(channel.channelId)).toEqual([
      { section_id: 'hero', variant: 'a', reached: 0, signups: 1 },
      { section_id: 'hero', variant: 'b', reached: 0, signups: 2 },
      { section_id: 'subscribe_band-2', variant: 'a', reached: 0, signups: 1 },
    ]);
    expect(await daily(id)).toMatchObject({ submissions: 4 });
  });

  it('ignores invalid values, other sites, the form frame and refused posts', async () => {
    const channel = await seedChannel();
    const { id } = await seedForm(channel);
    const site = `http://${channel.slug}.swarm.test`;
    const from = { origin: site, referer: `${site}/` };
    const ok = { 'cf-turnstile-response': 'ok' };

    // Invalid section ids and variants: the signup goes through, nothing is counted.
    for (const extra of [
      { sw_section: 'Hero Section', sw_variant: 'a' },
      { sw_section: 'hero', sw_variant: 'c' },
      { sw_section: 'x'.repeat(41), sw_variant: 'a' },
      { sw_section: 'hero' },
      { sw_variant: 'b' },
    ]) {
      const email = uniqueEmail();
      const res = await submitForm(id, { email, ...ok, ...extra }, from);
      expect(res.status).toBe(200);
      expect(await member(channel.channelId, email)).toBeTruthy();
    }
    // A host page elsewhere (an embed on another site) never counts for the site's sections.
    await submitForm(id, { email: uniqueEmail(), ...ok, sw_section: 'hero', sw_variant: 'a' });
    // Nor another Channel's site.
    const other = await seedChannel();
    const elsewhere = `http://${other.slug}.swarm.test`;
    await submitForm(
      id,
      { email: uniqueEmail(), ...ok, sw_section: 'hero', sw_variant: 'a' },
      { origin: elsewhere, referer: `${elsewhere}/` },
    );
    // The form frame posts JSON and has no section.
    await submitJson(id, { email: uniqueEmail(), sw_section: 'hero', sw_variant: 'a' });
    // A filled honeypot gets the ordinary answer and counts nothing.
    await submitForm(
      id,
      { email: uniqueEmail(), ...ok, website: 'spam', sw_section: 'hero', sw_variant: 'a' },
      from,
    );
    // A failed check counts nothing (the challenge page comes back).
    turnstile.pass = false;
    try {
      const refused = await submitForm(
        id,
        { email: uniqueEmail(), ...ok, sw_section: 'hero', sw_variant: 'a' },
        from,
      );
      expect(await refused.text()).toContain('name="sw_section" value="hero"');
    } finally {
      turnstile.pass = true;
    }
    expect(await signups(channel.channelId)).toEqual([]);
  });
});
