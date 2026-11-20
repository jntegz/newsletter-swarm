// Why a standing feed (webhook endpoint, export destination) sends nothing while active, as the
// dashboard says it (docs/security.md "Standing feeds"). An admin confirms it to adopt it.
import type { FeedSuspension } from '@swarm/domain';

export const SUSPENSION_TEXT: Record<FeedSuspension, string> = {
  unconfirmed:
    'An API key or app set this up. It receives nothing until an admin confirms it here.',
  confirmer_left:
    'The admin who set this up no longer has the admin role here. It sends nothing until an admin confirms it, or remove it.',
  credential_revoked:
    'The API key or app that set this up was revoked, so it sends nothing. Remove it, or set it up again.',
  channel_deleted: 'Its publication was deleted, so it sends nothing.',
  plan: 'Your plan no longer includes this, so it sends nothing.',
};

/** Whether confirming it would bring it back (the other reasons need something else first). */
export const confirmable = (reason: FeedSuspension | null) =>
  reason === 'unconfirmed' || reason === 'confirmer_left';
