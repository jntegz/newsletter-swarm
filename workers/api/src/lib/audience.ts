/** Helpers for the Phase 3 Members routes: tenancy for job and field rows, mappers, errors. */
import { first, toIso, type ChannelAccess } from '@swarm/db';
import {
  canTransition,
  type BulkJob,
  type ExportJob,
  type ImportJob,
  type ImportReport,
  type ImportSource,
  type ImportTarget,
  type MemberField,
  type MemberStatus,
  type SeatRole,
  type Tag,
} from '@swarm/domain';
import { FieldValueError, type FieldRow } from '@swarm/engine';
import { ApiError } from '@swarm/runtime';
import { requireChannel } from './access';
import { env, type AppContext, type AuthContext } from './context';

const ROWS = {
  member_fields: 'Profile field',
  tags: 'Tag',
  import_jobs: 'Import',
  export_jobs: 'Export',
  bulk_jobs: 'Bulk action',
} as const;

/**
 * Resolves a row to its Channel and applies the one tenancy check. A row in a Channel the
 * operator can't see answers 404 with the row's own name, like a row that doesn't exist.
 */
export async function requireRow<T extends { channel_id: string }>(
  c: AppContext,
  table: keyof typeof ROWS,
  columns: string,
  id: string,
  minimum: SeatRole,
  options: { includeDeleted?: boolean } = {},
): Promise<{ row: T; access: ChannelAccess & { auth: AuthContext } }> {
  const notFound = new ApiError('not_found', `${ROWS[table]} not found.`);
  const live =
    table === 'member_fields' && !options.includeDeleted ? ' AND deleted_at IS NULL' : '';
  const row = await first<T>(
    env(c).DB,
    `SELECT channel_id, ${columns} FROM ${table} WHERE id = ?1${live}`,
    id,
  );
  if (!row) throw notFound;
  try {
    return { row, access: await requireChannel(c, row.channel_id, minimum) };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') throw notFound;
    throw error;
  }
}

/** A field validation failure as a 400 that names the field. */
export function fieldInputError(error: unknown, prefix = 'fields'): never {
  if (error instanceof FieldValueError) {
    throw new ApiError('invalid_input', error.message, [
      { path: `${prefix}.${error.key}`, message: error.message },
    ]);
  }
  throw error;
}

/** Why an operator can't make a status change, or null when they can. */
export function transitionRefusal(from: MemberStatus, to: MemberStatus): string | null {
  if (canTransition(from, to, 'operator')) return null;
  if (from === 'bounced' || from === 'complained') {
    return `This address ${from === 'bounced' ? 'bounced' : 'marked a post as spam'}, so it stays suppressed.`;
  }
  if (from === 'unsubscribed') {
    return 'Only the subscriber can come back after unsubscribing, by confirming from an email.';
  }
  if (from === 'pending' && to === 'active') {
    return 'A pending subscriber becomes active when they confirm their address.';
  }
  if (to === 'bounced' || to === 'complained') {
    return 'Bounced and complained are set by delivery feedback, not by hand.';
  }
  return `A ${from} subscriber can’t be moved to ${to}.`;
}

const iso = (ms: number | null) => (ms === null ? null : toIso(ms));

export const toMemberField = (row: FieldRow): MemberField => ({
  id: row.id,
  channelId: row.channel_id,
  key: row.key,
  label: row.label,
  type: row.type,
  options: JSON.parse(row.options_json) as string[],
  encrypted: row.encrypted === 1,
  position: row.position,
  createdAt: toIso(row.created_at),
});

export interface TagRow {
  id: string;
  channel_id: string;
  name: string;
  member_count: number;
  created_at: number;
}

export const TAG_COLUMNS =
  'id, name, created_at, (SELECT count(*) FROM member_tags mt WHERE mt.tag_id = tags.id) AS member_count';

export const toTag = (row: TagRow): Tag => ({
  id: row.id,
  channelId: row.channel_id,
  name: row.name,
  memberCount: row.member_count,
  createdAt: toIso(row.created_at),
});

export interface BulkJobRow {
  id: string;
  channel_id: string;
  workspace_id: string;
  action: BulkJob['action'];
  params_json: string;
  selection_json: string;
  status: BulkJob['status'];
  total: number;
  processed: number;
  entered: number;
  error: string | null;
  created_at: number;
  completed_at: number | null;
}

export const BULK_COLUMNS =
  'id, workspace_id, action, params_json, selection_json, status, total, processed, entered, error, created_at, completed_at';

export function toBulkJob(row: BulkJobRow): BulkJob {
  const selection = JSON.parse(row.selection_json) as { circleId?: string };
  return {
    id: row.id,
    channelId: row.channel_id,
    action: row.action,
    params: JSON.parse(row.params_json) as BulkJob['params'],
    selection: selection.circleId
      ? { kind: 'circle', circleId: selection.circleId }
      : { kind: 'members', circleId: null },
    status: row.status,
    total: row.total,
    processed: Math.min(row.processed, row.total),
    entered: row.entered,
    error: row.error,
    createdAt: toIso(row.created_at),
    completedAt: iso(row.completed_at),
  };
}

export interface ImportJobRow {
  id: string;
  channel_id: string;
  workspace_id: string;
  status: ImportJob['status'];
  file_name: string;
  r2_key: string;
  bytes: number;
  mapping_json: string;
  consent_attested: number;
  update_existing: number;
  report_json: string | null;
  total_rows: number;
  processed_rows: number;
  check_addresses: number;
  email_check_run_id: string | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
}

export const IMPORT_COLUMNS =
  'id, workspace_id, status, file_name, r2_key, bytes, mapping_json, consent_attested, update_existing, report_json, total_rows, processed_rows, check_addresses, email_check_run_id, error, created_at, completed_at';

export function toImportJob(row: ImportJobRow): ImportJob {
  const mapping = JSON.parse(row.mapping_json) as {
    columns?: string[];
    map?: Record<string, ImportTarget>;
    source?: ImportSource;
  };
  return {
    id: row.id,
    channelId: row.channel_id,
    status: row.status,
    fileName: row.file_name,
    bytes: row.bytes,
    columns: mapping.columns ?? [],
    mapping: mapping.map ?? {},
    consentAttested: row.consent_attested === 1,
    updateExisting: row.update_existing === 1,
    source: mapping.source ?? 'csv',
    report: row.report_json ? (JSON.parse(row.report_json) as ImportReport) : null,
    totalRows: row.total_rows,
    processedRows: row.processed_rows,
    checkAddresses: row.check_addresses === 1,
    emailCheckRunId: row.email_check_run_id,
    error: row.error,
    createdAt: toIso(row.created_at),
    completedAt: iso(row.completed_at),
  };
}

export interface ExportJobRow {
  id: string;
  channel_id: string;
  workspace_id: string;
  format: ExportJob['format'];
  filter_json: string;
  status: ExportJob['status'];
  r2_key: string | null;
  row_count: number;
  error: string | null;
  created_at: number;
  completed_at: number | null;
  expires_at: number | null;
}

export const EXPORT_COLUMNS =
  'id, workspace_id, format, filter_json, status, r2_key, row_count, error, created_at, completed_at, expires_at';

/** The filter as the API shows it; `rosters` (the file has a rosters column) stays internal. */
function exportFilter(json: string): ExportJob['filter'] {
  const { rosters: _column, ...filter } = JSON.parse(json) as ExportJob['filter'] & {
    rosters?: boolean;
  };
  return filter;
}

export function toExportJob(row: ExportJobRow, downloadUrl: string | null): ExportJob {
  return {
    id: row.id,
    channelId: row.channel_id,
    format: row.format,
    filter: exportFilter(row.filter_json),
    status: row.status,
    rowCount: row.row_count,
    error: row.error,
    createdAt: toIso(row.created_at),
    completedAt: iso(row.completed_at),
    expiresAt: iso(row.expires_at),
    downloadUrl,
  };
}
