/**
 * Changing the email service from the setup page. Unlike an install, this keeps nothing here: each
 * request brings the install's settings and mail keys from the recovery kit, which stays in the
 * person's browser, and takes the updated ones back. The encryption keyrings never leave it.
 */
import { CloudflareApi } from '../cloudflare';
import {
  applyMailBindings,
  cancelSwitch,
  cutOver,
  finishSwitch,
  prepareSwitch,
  rollBack,
  switchStatus,
  type SwitchReadiness,
} from '../commands/mail-switch';
import { refuseStaleMailService } from '../commands/update';
import type { Ctx } from '../context';
import { scriptName } from '../paths';
import type { Answers } from '../answers';
import type { MailProvider, Secrets, State, StateStore } from '../state';
import type { AwsCredentials, Transport } from '../transport';
import { consoleUi, InstallError, noPrompter } from '../ui';

export type ChangeAction = 'prepare' | 'status' | 'cutover' | 'rollback' | 'cancel' | 'finish';

interface ChangeRequest {
  action: ChangeAction;
  transport: Transport;
  token: string;
  state: State;
  /** The mail keys from the kit, with no keyrings. */
  secrets: Secrets;
  provider?: MailProvider;
  mail?: Answers['mail'];
  awsAdmin?: AwsCredentials;
  /** The person has read what moving now would stop, and goes ahead. */
  acknowledged: boolean;
  log: (line: string) => void;
}

interface ChangeResult {
  state: State;
  secrets: Secrets;
  readiness: SwitchReadiness | null;
}

/** The kit has to be for this account, and as new as what's running. */
async function checkKit(ctx: Ctx) {
  const account = ctx.state.account?.id;
  if (!account || !ctx.state.choices) {
    throw new InstallError(
      "This recovery kit doesn't describe an install.",
      'Use the file the setup page gave you.',
    );
  }
  const cf = new CloudflareApi(ctx.t, ctx.session.oauthToken ?? '', 'setup token');
  const scripts = await cf.list<{ id: string }>(`/accounts/${account}/workers/scripts`);
  if (!scripts.some((script) => script.id === scriptName('send', ctx.env))) {
    throw new InstallError(
      "This Cloudflare token can't see the Swarm in this recovery kit.",
      'Check you used the token for the same Cloudflare account.',
    );
  }
  await refuseStaleMailService(ctx);
}

export async function runChange(request: ChangeRequest): Promise<ChangeResult> {
  let state = request.state;
  let secrets = request.secrets;
  const store: StateStore = {
    location: 'your recovery kit',
    persistent: false,
    load: async () => ({ state, secrets }),
    save: async (next) => {
      state = next;
    },
    saveSecrets: async (_env, next) => {
      secrets = next;
    },
  };
  const ctx: Ctx = {
    root: '/',
    env: state.env,
    dryRun: false,
    yes: true,
    interactive: false,
    t: request.transport,
    ui: consoleUi(noPrompter, request.log),
    store,
    state,
    secrets,
    answers: {
      ...(request.mail ? { mail: request.mail } : {}),
      dnsToken: request.token,
      storeDnsToken: false,
    },
    session: {
      oauthToken: request.token,
      dnsToken: request.token,
      ...(state.account ? { accountId: state.account.id } : {}),
      ...(request.awsAdmin ? { awsAdmin: request.awsAdmin } : {}),
    },
    report: { unhealthy: [] },
    // Never a code upload here. Marks this as not the terminal, too, which renders local files.
    deployer: (context, worker) => applyMailBindings(context, worker),
  };
  await checkKit(ctx);

  let readiness: SwitchReadiness | null = null;
  switch (request.action) {
    case 'prepare':
      if (!request.provider) throw new InstallError('Choose a service to change to.');
      await prepareSwitch(ctx, request.provider);
      readiness = await switchStatus(ctx);
      break;
    case 'status':
      readiness = ctx.state.mailChange ? await switchStatus(ctx) : null;
      break;
    case 'cutover':
      await cutOver(ctx, { acknowledged: request.acknowledged });
      break;
    case 'rollback':
      await rollBack(ctx);
      break;
    case 'cancel':
      await cancelSwitch(ctx);
      break;
    case 'finish':
      await finishSwitch(ctx, { force: request.acknowledged });
      break;
  }
  return { state: ctx.state, secrets: ctx.secrets, readiness };
}
