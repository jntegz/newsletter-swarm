import { accountId, oauthApi, saveSecrets, type Ctx } from '../context';
import { KEY_SECRET_NAMES, secretContext, secretNames } from '../keys';
import { DEPLOY_ORDER, scriptName, WORKERS } from '../paths';

/**
 * Removes keyrings a worker should no longer have. `wrangler deploy --secrets-file` adds and
 * replaces secrets but never removes one, so a keyring dropped from a worker's matrix (MEMBER_KEYS
 * once its window has passed, a keyring moved to another worker) would stay. Only names the key
 * registry manages are ever deleted; anything else on the script is left alone.
 */
export async function pruneSecrets(ctx: Ctx) {
  const cf = oauthApi(ctx);
  const account = accountId(ctx);
  const context = secretContext(ctx.state, ctx.secrets);
  for (const worker of DEPLOY_ORDER) {
    const keep = new Set(secretNames(worker, context));
    const script = scriptName(worker, ctx.env);
    const path = `/accounts/${account}/workers/scripts/${script}/secrets`;
    const have = (await cf.get<{ name: string }[]>(path)) ?? [];
    for (const { name } of have) {
      if (!KEY_SECRET_NAMES.has(name) || keep.has(name)) continue;
      await ctx.ui.task(`Removing ${name} from ${script}`, () =>
        cf.request('DELETE', `${path}/${encodeURIComponent(name)}`),
      );
    }
  }
  // Once no worker holds MEMBER_KEYS, nothing it signed is accepted anywhere: forget it.
  const stillHeld = WORKERS.some((worker) => secretNames(worker, context).includes('MEMBER_KEYS'));
  if (ctx.state.linkKeys?.mode === 'v2' && !stillHeld && ctx.secrets.keys.MEMBER_KEYS) {
    delete ctx.secrets.keys.MEMBER_KEYS;
    await saveSecrets(ctx);
    ctx.report.keysChanged = [...(ctx.report.keysChanged ?? []), 'MEMBER_KEYS (retired)'];
  }
}
