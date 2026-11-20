import type { Answers } from '../answers';
import type { Ctx, Report } from '../context';
import type { MailProvider, Secrets, State, StateStore } from '../state';
import { emptySecrets, emptyState } from '../state';
import type { AwsCredentials, Transport } from '../transport';
import { consoleUi, noPrompter } from '../ui';
import { deployWorkerFromRelease } from './deploy';
import type { Release } from './release';

export { CloudflareApi } from '../cloudflare';
export { dashboardProblem, slugProblem, suggestSlug } from '../steps/prompts';
export { InstallError } from '../ui';
export { SES_SETUP_POLICY } from '../ses-policy';
export { emptySecrets } from '../state';
export { MIN_KIT_PASSPHRASE, isSealedKit, openKit, sealKit, type SealedKit } from '../kit';
export { parseSecrets, parseState } from '../state';
export { cutOverWarnings } from '../commands/mail-switch';
export { runChange, type ChangeAction } from './change';
export { openRelease, releaseKeyId, withdrawnList, type Release } from './release';
export { PROJECT_RELEASE_KEYS, WITHDRAWN_RELEASES } from './trust';
export { wizardSteps } from './steps';
export { WorkerTransport } from './transport';
export type { Answers, MailProvider, Report, Secrets, State, StateStore };

/** Builds the installer's context for one step of the browser setup. */
export function wizardContext(options: {
  transport: Transport;
  store: StateStore;
  state: State | null;
  secrets: Secrets | null;
  answers: Answers;
  token: string;
  accountId?: string;
  /** The key that sets up Amazon SES. It's kept apart from the answers, so it can be forgotten. */
  awsAdmin?: AwsCredentials;
  report?: Report;
  release: Release;
  log: (line: string) => void;
}): Ctx {
  const ctx: Ctx = {
    root: '/',
    env: 'production',
    dryRun: false,
    yes: true,
    interactive: false,
    t: options.transport,
    ui: consoleUi(noPrompter, options.log),
    store: options.store,
    state: options.state ?? emptyState('production'),
    secrets: options.secrets ?? emptySecrets(),
    answers: { ...options.answers, dnsToken: options.token, storeDnsToken: false },
    session: {
      oauthToken: options.token,
      dnsToken: options.token,
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...(options.awsAdmin ? { awsAdmin: options.awsAdmin } : {}),
    },
    report: options.report ?? { unhealthy: [] },
    // A step that redeploys a Worker, as Resend's webhook does, goes through the API here too.
    deployer: (context, worker) => deployWorkerFromRelease(context, options.release, worker),
    // What the release being installed signs, from its signed manifest, never this build's own.
    linkV2Ready: options.release.linkSigning === 'v2',
  };
  return ctx;
}
