/**
 * Smart Blocks (Phase 6, flag smart_blocks): top-level blocks of a Dispatch shown or hidden per
 * recipient by a Circle rule (see "Smart Blocks" in @swarm/domain p6-growth.ts for the contract).
 *
 * The renderer (@swarm/mail) wraps block i in markers; this module decides, once per recipient,
 * which blocks they see. The snapshot evaluates each block's condition with one compiled query
 * per block over the snapshot chunk and stores the visible indexes in
 * broadcast_recipients.smart_blocks_json; a Flow send does the same for one Member through
 * `smartBlockVisibility`. A condition that can no longer be compiled (a profile field was
 * deleted, say) hides its block for everyone: content meant for some readers never goes to all.
 */
import { SMART_BLOCK_MAX, SmartBlockAttrsSchema, type CircleRule } from '@swarm/domain';
import { smartBlocksOf } from '@swarm/mail';
import {
  checkCircleRuleRefs,
  circleFieldKeys,
  CircleRuleError,
  CircleValues,
  compileRule,
  loadCircleFields,
  parseCircleRule,
  type CompiledCircle,
} from './circles';
import { all } from './db';

/** One block's compiled condition; null when it can't be evaluated (hidden for everyone). */
export type CompiledSmartBlocks = (CompiledCircle | null)[];

/** The Smart Block conditions of a document, in document order (top level only). */
export function smartBlockConditions(document: unknown): unknown[] {
  return smartBlocksOf(document).map((block) => block.condition);
}

/** Compiles every Smart Block's condition for a Channel; "within N days" is measured from `now`. */
export async function compileSmartBlocks(
  db: D1Database,
  channelId: string,
  document: unknown,
  now = Date.now(),
): Promise<CompiledSmartBlocks> {
  const conditions = smartBlockConditions(document);
  if (!conditions.length) return [];
  const rules = conditions.map((condition) => {
    try {
      return parseCircleRule(condition);
    } catch {
      return null;
    }
  });
  const keys = new Set<string>();
  for (const rule of rules) if (rule) circleFieldKeys(rule, keys);
  const fields = await loadCircleFields(db, channelId, keys);
  return rules.map((rule) => {
    if (!rule) return null;
    try {
      const v = new CircleValues();
      const where = compileRule(rule, { channelId, fields, now }, v);
      return { where, params: v.params() };
    } catch (error) {
      if (error instanceof CircleRuleError) return null;
      throw error;
    }
  });
}

/**
 * Visible block indexes per Member, for Members of `channelId` selected by `scope` (an SQL
 * condition over `members m` whose parameters start at ?3). One query per block.
 */
async function visibleFor(
  db: D1Database,
  channelId: string,
  blocks: CompiledSmartBlocks,
  memberIds: readonly string[],
  scope: { sql: string; params: unknown[] },
): Promise<Map<string, number[]>> {
  const visible = new Map<string, number[]>(memberIds.map((id) => [id, []]));
  for (const [index, block] of blocks.entries()) {
    if (!block) continue;
    const rows = await all<{ id: string }>(
      db,
      `SELECT m.id FROM members m WHERE m.channel_id = ?2 AND ${scope.sql} AND (${block.where})`,
      ...block.params,
      channelId,
      ...scope.params,
    );
    for (const row of rows) visible.get(row.id)?.push(index);
  }
  return visible;
}

/**
 * Visible block indexes for the Members of a snapshot chunk: ids in (`after`, `upTo`]. Only ids
 * in `memberIds` are returned (the chunk's active Members).
 */
export function smartBlocksForRange(
  db: D1Database,
  channelId: string,
  blocks: CompiledSmartBlocks,
  memberIds: readonly string[],
  after: string,
  upTo: string,
): Promise<Map<string, number[]>> {
  return visibleFor(db, channelId, blocks, memberIds, {
    sql: 'm.id > ?3 AND m.id <= ?4',
    params: [after, upTo],
  });
}

/** Visible block indexes for a list of Members (up to a few hundred at a time). */
export function smartBlocksForMembers(
  db: D1Database,
  channelId: string,
  blocks: CompiledSmartBlocks,
  memberIds: readonly string[],
): Promise<Map<string, number[]>> {
  return visibleFor(db, channelId, blocks, memberIds, {
    sql: 'm.id IN (SELECT value FROM json_each(?3))',
    params: [JSON.stringify(memberIds)],
  });
}

/**
 * The Smart Blocks one Member sees in `document`, as indexes, for the Flow send and the "as
 * Member X" preview. JSON.stringify the result into broadcast_recipients.smart_blocks_json, or
 * store NULL when the document has no Smart Blocks (`smartBlockConditions(document).length`).
 */
export async function smartBlockVisibility(
  db: D1Database,
  channelId: string,
  memberId: string,
  document: unknown,
  now = Date.now(),
): Promise<number[]> {
  const blocks = await compileSmartBlocks(db, channelId, document, now);
  if (!blocks.length) return [];
  const visible = await smartBlocksForMembers(db, channelId, blocks, [memberId]);
  return visible.get(memberId) ?? [];
}

/** A problem with a document's Smart Blocks, with where it is (`content.<i>.attrs...`). */
export class SmartBlockError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'SmartBlockError';
  }
}

/**
 * Checks a document's Smart Blocks before it is saved or sent: at most SMART_BLOCK_MAX, valid
 * attributes, conditions that compile for this Channel and name only its Circles and levels.
 * Nesting and placement are the renderer's checks.
 */
export async function validateSmartBlocks(
  db: D1Database,
  channelId: string,
  document: unknown,
): Promise<number> {
  const content = (document as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const [position, node] of content.entries()) {
    if ((node as { type?: unknown } | null)?.type !== 'smartBlock') continue;
    count++;
    const path = `content.${position}.attrs`;
    if (count > SMART_BLOCK_MAX) {
      throw new SmartBlockError(`Use at most ${SMART_BLOCK_MAX} Smart blocks.`, path);
    }
    const attrs = SmartBlockAttrsSchema.safeParse((node as { attrs?: unknown }).attrs ?? {});
    if (!attrs.success) {
      const issue = attrs.error.issues[0];
      throw new SmartBlockError(
        issue?.message ?? 'This Smart block is not valid.',
        `${path}.${issue?.path.join('.') ?? ''}`,
      );
    }
    const rule: CircleRule = attrs.data.condition;
    try {
      const fields = await loadCircleFields(db, channelId, circleFieldKeys(rule));
      compileRule(rule, { channelId, fields, now: Date.now() });
      await checkCircleRuleRefs(db, channelId, rule);
    } catch (error) {
      if (!(error instanceof CircleRuleError)) throw error;
      throw new SmartBlockError(error.message, `${path}.condition.${error.path}`);
    }
  }
  return count;
}
