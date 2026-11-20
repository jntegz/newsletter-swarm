// On-demand verification of a hash chain (the audit log or the agent log), one bounded page per
// request. A long chain is checked over several requests that follow `nextCursor`, so a request
// never reads a whole chain (D1 query and Worker CPU limits).
import { first, type ChainVerifyOptions, type ChainVerifyStep } from '@swarm/db';
import { ApiError } from '@swarm/runtime';
import { signToken, verifyToken, type Keyring } from '@swarm/tokens';
import { decodeCursor, encodeCursor } from '../v2/route';

interface ChainVerifyPage {
  ok: boolean;
  checked: number;
  brokenAtSeq: number | null;
  anchorSeq: number | null;
  fromSeq: number;
  complete: boolean;
  nextCursor: string | null;
}

type Step = (
  db: D1Database,
  workspaceId: string,
  options: ChainVerifyOptions,
) => Promise<ChainVerifyStep>;

type Chain = 'audit_events' | 'agent_actions';

/**
 * The cursor carries how far earlier pages verified and how many events they checked. Hashes are
 * public (the audit list shows them), so an unsigned cursor would let anyone claim a whole chain
 * checked while skipping a tampered range: it is signed, and names its workspace and chain.
 */
const CURSOR_PURPOSE = 'chain-verify';
/** Long enough to page through any chain; a stale cursor only means starting again. */
const CURSOR_TTL_SECONDS = 24 * 60 * 60;

/** Cursor position: the last verified event (seq and hash) and the events checked so far. */
interface Position {
  w: string;
  t: Chain;
  s: number;
  h: string;
  n: number;
}

async function readCursor(
  keys: Keyring,
  workspaceId: string,
  table: Chain,
  cursor: string | undefined,
): Promise<Position | null> {
  const token = decodeCursor(cursor);
  if (token === undefined) return null;
  const verified = await verifyToken<Partial<Position>>(keys, CURSOR_PURPOSE, token);
  const p = verified.ok ? verified.payload : null;
  if (
    !p ||
    p.w !== workspaceId ||
    p.t !== table ||
    !Number.isSafeInteger(p.s) ||
    typeof p.h !== 'string' ||
    !Number.isSafeInteger(p.n)
  ) {
    throw new ApiError('invalid_input', 'That page cursor is not valid.');
  }
  return p as Position;
}

export async function verifyChainPage(
  db: D1Database,
  keys: Keyring,
  workspaceId: string,
  table: Chain,
  step: Step,
  query: { cursor?: string | undefined; limit: number },
): Promise<ChainVerifyPage> {
  let from: { seq: number; hash: string } | null = null;
  let before = 0;
  let limit = query.limit;
  const position = await readCursor(keys, workspaceId, table, query.cursor);
  if (position) {
    const row = await first<{ hash: string; prev_hash: string }>(
      db,
      `SELECT hash, prev_hash FROM ${table} WHERE workspace_id = ?1 AND seq = ?2`,
      workspaceId,
      position.s,
    );
    // Resume only while the cursor's event still has the hash the previous page verified, and
    // check that event again so an edit to it since then is found too. Otherwise (pruned by
    // retention, or its hash rewritten) start again from the beginning.
    if (row && row.hash === position.h) {
      from = { seq: position.s - 1, hash: row.prev_hash };
      before = Math.max(0, position.n - 1);
      limit += 1;
    }
  }
  const result = await step(db, workspaceId, { from, limit });
  // The step starts at the chain's start instead once retention has pruned past `from`.
  const start = result.anchorSeq ?? 0;
  const resumedAt = from && from.seq >= start ? from.seq + 1 : null;
  const checked = (resumedAt === null ? 0 : before) + result.checked;
  return {
    ok: result.ok,
    checked,
    brokenAtSeq: result.brokenAtSeq,
    anchorSeq: result.anchorSeq,
    fromSeq: resumedAt ?? start + 1,
    complete: result.done,
    nextCursor: result.done
      ? null
      : encodeCursor(
          await signToken(
            keys,
            CURSOR_PURPOSE,
            { w: workspaceId, t: table, s: result.last.seq, h: result.last.hash, n: checked },
            { expiresInSeconds: CURSOR_TTL_SECONDS },
          ),
        ),
  };
}
