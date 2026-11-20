// The public API (/v2). Each resource file registers its routes on its own router; they are all
// mounted here behind authenticateV2. The /v2 OpenAPI document is built from these routers only.
import type { createRouter } from '../lib/context';
import { v2Audience } from './audience';
import { v2Channels } from './channels';
import { v2Dispatches } from './dispatches';
import { v2Members } from './members';
import { v2Goods } from './goods';
import { v2Rosters } from './rosters';
import { sends } from './sends';
import { webhooksV2 } from './webhooks';
import { v2Feeds } from './feeds';

/** Routers mounted under /v2, in order. Workstreams add theirs here. */
export const v2Routers = [
  v2Channels,
  v2Members,
  v2Dispatches,
  v2Audience,
  sends,
  webhooksV2,
  v2Rosters,
  v2Goods,
  v2Feeds,
] as ReturnType<typeof createRouter>[];
