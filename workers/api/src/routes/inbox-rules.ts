// Inbox rules: a Channel's limits on automated email. The engine applies them at each Flow send
// (packages/engine/src/flows-holds.ts); they live in channels.settings_json, off until set.
import { createRoute } from '@hono/zod-openapi';
import { first } from '@swarm/db';
import {
  InboxRuleSettingsSchema,
  UpdateInboxRuleSettingsSchema,
  idPattern,
  inboxRulesFromSettings,
  type InboxRuleSettings,
} from '@swarm/domain';
import { heldNowInChannel, isTimeZone, saveInboxRules } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from '../lib/access';
import { createRouter, env, type AppContext } from '../lib/context';
import { errors, idParam, jsonBody, ok } from '../lib/openapi';
import { audit } from '../lib/site';

export const inboxRules = createRouter();

const channelParam = idParam('channelId', idPattern('channel'));

async function settingsOf(c: AppContext, channelId: string): Promise<InboxRuleSettings> {
  const db = env(c).DB;
  const row = await first<{ settings_json: string }>(
    db,
    'SELECT settings_json FROM channels WHERE id = ?1',
    channelId,
  );
  const settings = JSON.parse(row?.settings_json ?? '{}') as { timezone?: unknown };
  return {
    rules: inboxRulesFromSettings(settings),
    timezone: isTimeZone(settings.timezone) ? settings.timezone : null,
    heldNow: await heldNowInChannel(db, channelId),
  };
}

inboxRules.openapi(
  createRoute({
    method: 'get',
    path: '/api/v1/channels/{channelId}/inbox-rules',
    tags: ['Flows'],
    summary: 'A Channel’s limits on automated email',
    description: 'Every rule is off until someone sets it, for existing and new Channels alike.',
    request: { params: channelParam },
    responses: {
      200: ok(InboxRuleSettingsSchema, 'Inbox rules'),
      ...errors('unauthorized', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    await requireChannel(c, channelId, 'viewer');
    return c.json({ data: await settingsOf(c, channelId) }, 200);
  },
);

inboxRules.openapi(
  createRoute({
    method: 'put',
    path: '/api/v1/channels/{channelId}/inbox-rules',
    tags: ['Flows'],
    summary: 'Set a Channel’s limits on automated email',
    description:
      'Held Flow emails wait and are looked at again under the new rules at the next sweep. The time zone is the Channel’s own, used for Members whose time zone is not known.',
    request: { params: channelParam, body: jsonBody(UpdateInboxRuleSettingsSchema) },
    responses: {
      200: ok(InboxRuleSettingsSchema, 'Saved'),
      ...errors('invalid_input', 'unauthorized', 'forbidden', 'not_found'),
    },
  }),
  async (c) => {
    const { channelId } = c.req.valid('param');
    const input = c.req.valid('json');
    const access = await requireChannel(c, channelId, 'editor');
    if (input.timezone !== null && !isTimeZone(input.timezone)) {
      throw new ApiError('invalid_input', 'That time zone is not known.', [
        { path: 'timezone', message: 'Choose a time zone from the list.' },
      ]);
    }
    await saveInboxRules(env(c).DB, channelId, input, Date.now());
    await audit(c, access, 'channel.inbox_rules_updated', 'channel', channelId, {
      rules: input.rules,
      timezone: input.timezone,
    });
    return c.json({ data: await settingsOf(c, channelId) }, 200);
  },
);
