// The two queries behind a Circle's live count: shared by the preview route and the development
// route that checks their query plans (scripts/load/circle-counts.mjs), so what is planned is
// what runs.
import { CIRCLE_SAMPLE_SIZE } from '@swarm/domain';
import type { CompiledCircle } from '@swarm/engine';
import { MEMBER_COLUMNS } from './send';

export function circlePreviewQueries(compiled: CompiledCircle, channelId: string) {
  // ?1 carries the rule's values (see compileCircle); the Channel is ?2.
  return {
    count: {
      sql: `SELECT count(*) AS n, ifnull(sum(m.status = 'active'), 0) AS active
              FROM members m WHERE m.channel_id = ?2 AND (${compiled.where})`,
      params: [...compiled.params, channelId],
    },
    sample: {
      sql: `SELECT ${MEMBER_COLUMNS} FROM members m
             WHERE m.channel_id = ?2 AND (${compiled.where})
             ORDER BY m.created_at DESC, m.id DESC LIMIT ?3`,
      params: [...compiled.params, channelId, CIRCLE_SAMPLE_SIZE],
    },
  };
}
