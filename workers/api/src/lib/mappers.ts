import { toIso } from '@swarm/db';
import { channelSettings } from '@swarm/engine';
import { EmailDesignSchema } from '@swarm/domain';
import type {
  Channel,
  ChannelBranding,
  Invite,
  MediaAsset,
  Operator,
  SeatRole,
  SignupPath,
  Workspace,
} from '@swarm/domain';

export interface ChannelRow {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  description: string | null;
  branding_json: string;
  settings_json: string;
  status: 'active' | 'paused';
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export function toChannel(row: ChannelRow, role: SeatRole): Channel {
  const branding = JSON.parse(row.branding_json) as Partial<ChannelBranding>;
  const settings = JSON.parse(row.settings_json) as {
    doubleOptIn?: unknown;
    requireConfirmation?: unknown;
    signupPath?: SignupPath;
    sunsetDays?: number | null;
    emailDesign?: unknown;
    confirmDays?: number;
    styleGuide?: unknown;
  };
  const tracking = channelSettings(row.settings_json);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    branding: {
      accentColor: branding.accentColor ?? null,
      logoMediaId: branding.logoMediaId ?? null,
    },
    status: row.status,
    // Double opt-in is on unless the Channel turned it off.
    doubleOptIn: settings.doubleOptIn !== false,
    requireConfirmation: settings.requireConfirmation === true,
    signupPath: settings.signupPath ?? 'email',
    sunsetDays: settings.sunsetDays ?? null,
    // Tracking choices (docs/privacy-controls.md): on unless turned off; profiling needs opens.
    trackOpens: tracking.trackOpens,
    trackClicks: tracking.trackClicks,
    profileReaders: tracking.profileReaders,
    emailDesign: EmailDesignSchema.parse(settings.emailDesign ?? {}),
    confirmDays: settings.confirmDays ?? 7,
    // The operator's style guide, given to agents as publication context; empty until written.
    styleGuide: typeof settings.styleGuide === 'string' ? settings.styleGuide : '',
    role,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: row.deleted_at === null ? null : toIso(row.deleted_at),
  };
}

export interface OperatorRow {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
}

export function toOperator(row: OperatorRow): Operator {
  return { id: row.id, email: row.email, name: row.name, createdAt: toIso(row.created_at) };
}

export interface WorkspaceRow {
  id: string;
  name: string;
  plan: Workspace['plan'];
  role: SeatRole;
  created_at: number;
}

export function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    plan: row.plan,
    role: row.role,
    createdAt: toIso(row.created_at),
  };
}

export interface InviteRow {
  id: string;
  email: string;
  role: Invite['role'];
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
}

export function toInvite(row: InviteRow, now = Date.now()): Invite {
  const status = row.accepted_at
    ? 'accepted'
    : row.revoked_at
      ? 'revoked'
      : row.expires_at <= now
        ? 'expired'
        : 'pending';
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    status,
  };
}

export interface MediaRow {
  id: string;
  channel_id: string | null;
  r2_key: string;
  content_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  alt_text: string | null;
  focal_x: number | null;
  focal_y: number | null;
  created_at: number;
}

/** What a media file is, from its sniffed type. */
const mediaKind = (contentType: string): MediaAsset['kind'] =>
  contentType.startsWith('image/') ? 'image' : contentType.startsWith('font/') ? 'font' : 'file';

export function toMedia(row: MediaRow, mediaOrigin: string): MediaAsset {
  return {
    id: row.id,
    channelId: row.channel_id,
    contentType: row.content_type,
    kind: mediaKind(row.content_type),
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    altText: row.alt_text,
    focalPoint:
      row.focal_x === null || row.focal_y === null ? null : { x: row.focal_x, y: row.focal_y },
    url: `${mediaOrigin}/media/${row.r2_key}`,
    createdAt: toIso(row.created_at),
  };
}
