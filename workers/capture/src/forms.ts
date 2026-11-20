// Loading a published Capture Form, a specific published version of it, and its profile fields.
import { first, all, retryRead } from '@swarm/db';
import {
  CaptureFormConfigSchema,
  idPattern,
  resolveDoubleOptIn,
  type CaptureFormConfig,
} from '@swarm/domain';
import type { FieldDef } from '@swarm/engine';

export interface PublishedForm {
  id: string;
  channelId: string;
  workspaceId: string;
  channelName: string;
  /** The version being served: the one asked for, or the latest. */
  version: number;
  latestVersion: number;
  config: CaptureFormConfig;
  accent: string;
  /** The Channel default, overridden by the form unless the Channel requires confirmation. */
  doubleOptIn: boolean;
  /** The steps of the website's signup form. */
  signupPath: string;
}

const FORM_ID = idPattern('captureForm');

/**
 * A form that is published, not deleted, in a live Channel. With `version`, that published
 * version's config (so a script pinned by SRI keeps matching); without, the latest.
 */
export async function loadPublishedForm(
  db: D1Database,
  formId: string,
  version?: number | null,
): Promise<PublishedForm | null> {
  if (!FORM_ID.test(formId)) return null;
  const row = await retryRead(() =>
    first<{
      id: string;
      channel_id: string;
      workspace_id: string;
      version: number;
      published_config_json: string | null;
      channel_name: string;
      branding_json: string;
      settings_json: string;
    }>(
      db,
      `SELECT f.id, f.channel_id, f.workspace_id, f.version, f.published_config_json,
              c.name AS channel_name, c.branding_json, c.settings_json
         FROM capture_forms f JOIN channels c ON c.id = f.channel_id
        WHERE f.id = ?1 AND f.deleted_at IS NULL AND f.status = 'published'
          AND c.deleted_at IS NULL AND c.status = 'active'`,
      formId,
    ),
  );
  if (!row?.published_config_json) return null;
  let json = row.published_config_json;
  let served = row.version;
  if (version !== undefined && version !== null && version !== row.version) {
    const old = await retryRead(() =>
      first<{ config_json: string }>(
        db,
        'SELECT config_json FROM capture_form_versions WHERE form_id = ?1 AND version = ?2',
        formId,
        version,
      ),
    );
    if (!old) return null;
    json = old.config_json;
    served = version;
  }
  const parsed = CaptureFormConfigSchema.safeParse(JSON.parse(json));
  if (!parsed.success) return null;
  const config = parsed.data;
  const branding = JSON.parse(row.branding_json) as { accentColor?: unknown };
  const settings = JSON.parse(row.settings_json) as {
    doubleOptIn?: unknown;
    requireConfirmation?: unknown;
    signupPath?: unknown;
  };
  const channelAccent =
    typeof branding.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(branding.accentColor)
      ? branding.accentColor
      : null;
  return {
    id: row.id,
    channelId: row.channel_id,
    workspaceId: row.workspace_id,
    channelName: row.channel_name,
    version: served,
    latestVersion: row.version,
    config,
    accent: config.theme.accentColor ?? channelAccent ?? '#6c4cf1',
    doubleOptIn: resolveDoubleOptIn(config.doubleOptIn, settings),
    signupPath: typeof settings.signupPath === 'string' ? settings.signupPath : 'email',
  };
}

export type FormFieldDef = FieldDef & { id: string; label: string };

/** The Channel's profile fields that the form asks for, by key. */
export async function formFieldDefs(
  db: D1Database,
  form: PublishedForm,
): Promise<Map<string, FormFieldDef>> {
  const keys = form.config.fields
    .filter((f) => f.key.startsWith('field:'))
    .map((f) => f.key.slice('field:'.length));
  if (keys.length === 0) return new Map();
  const rows = await retryRead(() =>
    all<{
      id: string;
      key: string;
      label: string;
      type: FieldDef['type'];
      options_json: string;
      encrypted: number;
    }>(
      db,
      `SELECT id, key, label, type, options_json, encrypted FROM member_fields
        WHERE channel_id = ?1 AND deleted_at IS NULL AND key IN (SELECT value FROM json_each(?2))`,
      form.channelId,
      JSON.stringify(keys),
    ),
  );
  return new Map(
    rows.map((r) => [
      r.key,
      {
        id: r.id,
        key: r.key,
        label: r.label,
        type: r.type,
        options: JSON.parse(r.options_json) as string[],
        encrypted: r.encrypted === 1,
      },
    ]),
  );
}
