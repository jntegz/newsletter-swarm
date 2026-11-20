import { linkV2Ready, save, saveSecrets } from '../context';
import { ensureKeyrings, initialLinkKeys } from '../keys';
import type { Step } from './step';

export const keys: Step = {
  id: 'keys',
  title: 'Signing and encryption keys',
  async run(ctx) {
    // No keys at all: nothing was ever signed, so there are no old links to keep working.
    const fresh = Object.keys(ctx.secrets.keys).length === 0;
    if (!ctx.state.linkKeys) {
      ctx.state.linkKeys = initialLinkKeys(fresh, linkV2Ready(ctx), Date.now());
      await save(ctx);
    }
    const legacy = ctx.state.linkKeys.mode !== 'v2';
    const created = await ctx.ui.task(
      'Generating keys',
      () => ensureKeyrings(ctx.secrets, { legacy }),
      (list) => (list.length ? `done (${list.length} new)` : 'kept the existing keys'),
    );
    if (created.length) await saveSecrets(ctx);
    if (created.length && !fresh) {
      ctx.report.keysChanged = [...(ctx.report.keysChanged ?? []), ...created];
    }
  },
};
