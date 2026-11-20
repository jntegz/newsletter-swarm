// Landing pages: which forms a page may use, and the flag. docs/landing-pages.md.
import { env } from 'cloudflare:test';
import { LANDING_TEMPLATES, DispatchDocumentSchema, type SitePage } from '@swarm/domain';
import { renderWeb } from '@swarm/mail';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, createChannel, signIn, type Session } from './helpers';
import { data, enableFlag, errorCode } from './money-helpers';

let owner: Session;
let channelId: string;
const pages = (channel = channelId) => `/api/v1/channels/${channel}/site/pages`;

async function publishedForm(channel: string, config?: unknown) {
  const created = await data<{ id: string }>(
    await call('POST', `/api/v1/channels/${channel}/capture-forms`, {
      cookie: owner.cookie,
      body: { name: `Form ${Math.random()}`, ...(config ? { config } : {}) },
    }),
    201,
  );
  await call('POST', `/api/v1/capture-forms/${created.id}/publish`, { cookie: owner.cookie });
  return created.id;
}

beforeAll(async () => {
  owner = await signIn();
  channelId = (await createChannel(owner)).id;
});

describe('landing pages', () => {
  it('is behind its flag, and an ordinary page doesn’t need it', async () => {
    const formId = await publishedForm(channelId);
    const refused = await call('POST', pages(), {
      cookie: owner.cookie,
      body: { title: 'Join', landingFormId: formId },
    });
    expect(refused.status).toBe(404);
    expect(await errorCode(refused)).toBe('feature_disabled');
    const plain = await call('POST', pages(), { cookie: owner.cookie, body: { title: 'Plain' } });
    expect((await data<SitePage>(plain, 201)).landingFormId).toBeNull();
    await enableFlag('landing_pages', owner.workspaceId, channelId);
  });

  it('takes a published form of this publication, and only that', async () => {
    const formId = await publishedForm(channelId);
    const page = await data<SitePage>(
      await call('POST', pages(), {
        cookie: owner.cookie,
        body: { title: 'Join us', landingFormId: formId },
      }),
      201,
    );
    expect(page.landingFormId).toBe(formId);

    const draft = await data<{ id: string }>(
      await call('POST', `/api/v1/channels/${channelId}/capture-forms`, {
        cookie: owner.cookie,
        body: { name: 'Unpublished' },
      }),
      201,
    );
    const other = await createChannel(owner);
    await enableFlag('landing_pages', owner.workspaceId, other.id);
    const foreign = await publishedForm(other.id);
    for (const id of [draft.id, foreign]) {
      const res = await call('PATCH', `${pages()}/${page.id}`, {
        cookie: owner.cookie,
        body: { landingFormId: id },
      });
      expect(res.status, id).toBe(400);
    }

    const cleared = await data<SitePage>(
      await call('PATCH', `${pages()}/${page.id}`, {
        cookie: owner.cookie,
        body: { landingFormId: null },
      }),
    );
    expect(cleared.landingFormId).toBeNull();
    // Saving something else leaves the form alone.
    const again = await data<SitePage>(
      await call('PATCH', `${pages()}/${page.id}`, {
        cookie: owner.cookie,
        body: { landingFormId: formId },
      }),
    );
    const titled = await data<SitePage>(
      await call('PATCH', `${pages()}/${again.id}`, {
        cookie: owner.cookie,
        body: { title: 'Join now' },
      }),
    );
    expect(titled.landingFormId).toBe(formId);
  });

  it('refuses a form with required custom fields, which the page could never complete', async () => {
    const formId = await publishedForm(channelId);
    const row = await env.DB.prepare(
      'SELECT published_config_json FROM capture_forms WHERE id = ?1',
    )
      .bind(formId)
      .first<{ published_config_json: string }>();
    const config = JSON.parse(row!.published_config_json) as { fields: unknown[] };
    config.fields.push({ key: 'field:company', label: 'Company', required: true });
    await env.DB.prepare('UPDATE capture_forms SET published_config_json = ?1 WHERE id = ?2')
      .bind(JSON.stringify(config), formId)
      .run();
    const res = await call('POST', pages(), {
      cookie: owner.cookie,
      body: { title: 'Too many fields', landingFormId: formId },
    });
    expect(res.status).toBe(400);
  });

  it('has starters that save and render', () => {
    for (const template of LANDING_TEMPLATES) {
      expect(DispatchDocumentSchema.safeParse(template.content).success, template.id).toBe(true);
      const out = renderWeb(template.content, {
        channelName: 'Field Notes',
        media: () => null,
        allowHtmlBlocks: false,
      });
      expect(out.freeHtml, template.id).toContain('[');
    }
  });
});
