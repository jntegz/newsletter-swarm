import { describe, expect, it } from 'vitest';
import { save } from '../src/context';
import { FakeTransport } from '../src/fake';
import { DEPLOY_ORDER } from '../src/paths';
import { WORKER_SES_ACTIONS } from '../src/ses-policy';
import { MemoryStateStore } from '../src/state';
import { INSTALL_STEPS, runSteps } from '../src/steps';
import { provisionResources } from '../src/steps/resources';
import { answers, fakeRun } from './helpers';

const QUEUES = [
  'send',
  'send-dlq',
  'jobs',
  'jobs-dlq',
  'webhooks',
  'webhooks-dlq',
  'public',
  'public-dlq',
];

const deploys = (actions: string[]) =>
  actions
    .filter((a) => a.startsWith('wrangler deploy'))
    .map((a) => /workers\/(\w+)\/wrangler/.exec(a)?.[1]);

const creates = (actions: string[]) =>
  actions.filter((a) =>
    /^POST \S+\/(d1\/database|storage\/kv\/namespaces|r2\/buckets|queues|challenges\/widgets)\s/.test(
      a,
    ),
  );

describe('a dry-run install', () => {
  it('runs every step in order: realtime deploys first, api last', async () => {
    const { ctx, transport, output } = await fakeRun({});
    await runSteps(ctx, INSTALL_STEPS);
    const order = deploys(transport.actions);
    expect(order.slice(0, DEPLOY_ORDER.length)).toEqual([...DEPLOY_ORDER]);
    expect(order[0]).toBe('realtime');
    expect(order[DEPLOY_ORDER.length - 1]).toBe('api');
    // The Resend webhook secret arrives after the first deploy; events is redeployed with it.
    expect(order.slice(DEPLOY_ORDER.length)).toEqual(['events']);

    const index = (pattern: RegExp) => transport.actions.findIndex((a) => pattern.test(a));
    const milestones = [
      index(/^wrangler whoami/),
      index(/d1\/database\s+swarm-production$/),
      index(/challenges\/widgets\s/),
      index(/^POST api\.resend\.com\/domains\s/),
      index(/dns_records\s+app\.example\.com AAAA/),
      index(/^write workers\/api\/wrangler\.production\.generated\.jsonc/),
      index(/^wrangler d1 migrations apply/),
      // Sign-up closes before any worker can answer, and stays closed until the owner exists.
      index(/query\s+INSERT INTO instance_settings/),
      index(/^pnpm --filter @swarm\/dashboard build/),
      index(/^wrangler deploy .*workers\/realtime/),
      index(/^POST api\.resend\.com\/webhooks/),
      index(/email\/routing\/rules\s/),
      index(/query\s+INSERT INTO operators/),
      index(/query\s+INSERT INTO quickpass_tokens/),
      index(/^GET app\.example\.com\/healthz/),
    ];
    expect(milestones.every((i) => i >= 0)).toBe(true);
    expect([...milestones].sort((a, b) => a - b)).toEqual(milestones);

    // Secrets never show up in the log or the output.
    const log = transport.actions.join('\n') + output.join('');
    for (const value of Object.values(ctx.secrets.keys))
      expect(log).not.toContain(value.split(':')[1]);
    expect(log).not.toContain('re_dry_run');
    expect(output.join('')).toContain('/sign-in/continue#token=');
    expect(output.join('')).toContain('Sign-up is now invite-only');
  });

  it('keeps open sign-up on a re-run, and reports invite-only as already kept', async () => {
    const store = new MemoryStateStore();
    const transport = new FakeTransport({ zone: 'example.com' });
    const first = await fakeRun({ store, transport });
    await runSteps(first.ctx, INSTALL_STEPS);
    expect(transport.db.signup).toBe('invite_only');

    const again: string[] = [];
    const second = await fakeRun({ store, transport, output: again });
    await runSteps(second.ctx, INSTALL_STEPS);
    expect(transport.db.signup).toBe('invite_only');
    expect(again.join('')).toContain('Kept the sign-up setting');

    transport.db.signup = 'open';
    const third = await fakeRun({ store, transport });
    await runSteps(third.ctx, INSTALL_STEPS);
    expect(transport.db.signup).toBe('open');
  });

  it('writes valid configs and a deploy secrets file per worker, removed afterwards', async () => {
    const { ctx, transport } = await fakeRun({});
    await runSteps(ctx, INSTALL_STEPS);
    const generated = [...transport.files.keys()].filter((f) => f.endsWith('.generated.jsonc'));
    expect(generated).toHaveLength(9);
    expect([...transport.files.keys()].filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('a second run creates nothing new and keeps the keys', async () => {
    const store = new MemoryStateStore();
    const transport = new FakeTransport({ zone: 'example.com' });
    const first = await fakeRun({ store, transport });
    await runSteps(first.ctx, INSTALL_STEPS);
    const keysBefore = { ...first.ctx.secrets.keys };
    const before = transport.actions.length;

    const second = await fakeRun({ store, transport });
    await runSteps(second.ctx, INSTALL_STEPS);
    const again = transport.actions.slice(before);
    expect(creates(again)).toEqual([]);
    expect(again.filter((a) => /^POST \S+\/dns_records\s/.test(a))).toEqual([]);
    expect(again.filter((a) => /^POST api\.resend\.com\/(domains|webhooks)\s/.test(a))).toEqual([]);
    expect(second.ctx.secrets.keys).toEqual(keysBefore);
    // No new webhook secret, so events is not redeployed a second time.
    expect(deploys(again)).toEqual([...DEPLOY_ORDER]);
  });

  it('sets up SES when chosen', async () => {
    const base = await answers();
    const { ctx, transport, output } = await fakeRun({
      answers: {
        ...base,
        mail: {
          provider: 'ses',
          region: 'eu-west-1',
          awsAccessKeyId: 'AKIAADMINDRYRUN00000',
          awsSecretAccessKey: 'admin-secret-dry-run-000000000000000000',
        },
      },
    });
    await runSteps(ctx, INSTALL_STEPS);
    const aws = transport.actions.filter((a) => a.startsWith('aws '));
    expect(aws).toEqual(
      expect.arrayContaining([
        'aws sns CreateTopic swarm-production-ses-events',
        'aws sesv2 CreateConfigurationSet swarm-production-broadcasts',
        'aws sesv2 CreateConfigurationSet swarm-production-transactional',
        'aws sesv2 CreateConfigurationSet swarm-production-direct',
        'aws iam CreateUser swarm-production-workers',
        'aws sesv2 CreateEmailIdentity mail.example.com',
        'aws sesv2 CreateEmailIdentity ada@example.com',
        'aws sns Subscribe arn:aws:sns:eu-west-1:123456789012:swarm-production-ses-events https://events.example.com/sns/ses',
      ]),
    );
    expect(
      transport.actions.some((a) => a.includes('dkimtokenone._domainkey.mail.example.com CNAME')),
    ).toBe(true);
    // The admin key is never saved; the workers' own key is.
    expect(JSON.stringify(ctx.secrets)).not.toContain('admin-secret-dry-run');
    expect(ctx.secrets.aws?.accessKeyId).toBe('AKIADRYRUN0000000001');
    expect(output.join('')).toContain('SES sandbox');
    expect(deploys(transport.actions)).toEqual([...DEPLOY_ORDER]);
    expect(JSON.parse(transport.awsState.workerPolicy).Statement[0].Action).toEqual(
      WORKER_SES_ACTIONS,
    );
    expect(ctx.state.ses?.workerActions).toEqual(WORKER_SES_ACTIONS);
    // The events worker only accepts version 2, so anything else never confirms.
    const topic = 'arn:aws:sns:eu-west-1:123456789012:swarm-production-ses-events';
    expect(transport.awsState.topicAttributes.get(topic)?.SignatureVersion).toBe('2');
    expect(ctx.state.ses?.subscriptionConfirmed).toBe(true);
    expect(transport.awsState.identityKeyLengths.get('mail.example.com')).toBe('RSA_2048_BIT');
    // The shared suppression list adds addresses for bounces only, never complaints.
    expect(transport.awsState.suppressedReasons).toEqual(['BOUNCE']);
    expect(aws).toContain('aws sesv2 PutAccountSuppressionAttributes');
    expect(output.join('')).toMatch(/Setting the SES suppression list to bounces only.*done/);
  });

  describe('the SES suppression list', () => {
    const withKey = {
      provider: 'ses' as const,
      region: 'eu-west-1',
      awsAccessKeyId: 'AKIAADMINDRYRUN00000',
      awsSecretAccessKey: 'admin-secret-dry-run-000000000000000000',
    };

    it('a re-run with the admin key leaves it alone once it is bounces only', async () => {
      const store = new MemoryStateStore();
      const transport = new FakeTransport({ zone: 'example.com' });
      const first = await fakeRun({
        store,
        transport,
        answers: { ...(await answers()), mail: withKey },
      });
      await runSteps(first.ctx, INSTALL_STEPS);
      transport.actions.length = 0;
      const output: string[] = [];
      const again = await fakeRun({
        store,
        transport,
        output,
        answers: { ...(await answers()), mail: withKey },
      });
      await runSteps(again.ctx, INSTALL_STEPS);
      expect(transport.actions).not.toContain('aws sesv2 PutAccountSuppressionAttributes');
      expect(output.join('')).toMatch(
        /Setting the SES suppression list to bounces only.*already set/,
      );
    });

    it('an install made before this warns without the admin key, and is fixed with it', async () => {
      const store = new MemoryStateStore();
      const transport = new FakeTransport({ zone: 'example.com' });
      const first = await fakeRun({
        store,
        transport,
        answers: { ...(await answers()), mail: withKey },
      });
      await runSteps(first.ctx, INSTALL_STEPS);
      transport.awsState.suppressedReasons = ['BOUNCE', 'COMPLAINT'];
      const output: string[] = [];
      const noKey = await fakeRun({
        store,
        transport,
        output,
        answers: { ...(await answers()), mail: { provider: 'ses', region: 'eu-west-1' } },
      });
      await runSteps(noKey.ctx, INSTALL_STEPS);
      expect(transport.awsState.suppressedReasons).toEqual(['BOUNCE', 'COMPLAINT']);
      expect(output.join('')).toContain('The SES suppression list is not set to bounces only');
      const fixed = await fakeRun({
        store,
        transport,
        answers: { ...(await answers()), mail: withKey },
      });
      await runSteps(fixed.ctx, INSTALL_STEPS);
      expect(transport.awsState.suppressedReasons).toEqual(['BOUNCE']);
    });
  });

  describe('repairing an SES install whose topic signs with version 1', () => {
    const withKey = {
      provider: 'ses' as const,
      region: 'eu-west-1',
      awsAccessKeyId: 'AKIAADMINDRYRUN00000',
      awsSecretAccessKey: 'admin-secret-dry-run-000000000000000000',
    };
    const topic = 'arn:aws:sns:eu-west-1:123456789012:swarm-production-ses-events';
    const endpoint = 'https://events.example.com/sns/ses';

    async function brokenInstall() {
      const store = new MemoryStateStore();
      const transport = new FakeTransport({ zone: 'example.com' });
      const first = await fakeRun({
        store,
        transport,
        answers: { ...(await answers()), mail: withKey },
      });
      await runSteps(first.ctx, INSTALL_STEPS);
      // What an older install left behind: a version 1 topic and a subscription stuck pending.
      transport.awsState.topicAttributes.delete(topic);
      transport.awsState.subscriptions = [
        { Endpoint: endpoint, SubscriptionArn: 'PendingConfirmation' },
      ];
      if (first.ctx.state.ses) {
        delete first.ctx.state.ses.topicSignatureVersion;
        first.ctx.state.ses.subscriptionConfirmed = false;
      }
      await save(first.ctx);
      return { store, transport };
    }

    it('fixes the topic and subscribes again with the admin key', async () => {
      const { store, transport } = await brokenInstall();
      const { ctx } = await fakeRun({
        store,
        transport,
        answers: { ...(await answers()), mail: withKey },
      });
      await runSteps(ctx, INSTALL_STEPS);
      expect(transport.awsState.topicAttributes.get(topic)?.SignatureVersion).toBe('2');
      expect(ctx.state.ses?.topicSignatureVersion).toBe('2');
      expect(ctx.state.ses?.subscriptionConfirmed).toBe(true);
      expect(transport.awsState.subscriptions).toEqual([
        { Endpoint: endpoint, SubscriptionArn: `${topic}:subscription-dry-run` },
      ]);
    });

    it('says bounce reports are being refused when it has no key to fix it', async () => {
      const { store, transport } = await brokenInstall();
      const output: string[] = [];
      const { ctx } = await fakeRun({
        store,
        transport,
        output,
        answers: { ...(await answers()), mail: { provider: 'ses', region: 'eu-west-1' } },
      });
      await runSteps(ctx, INSTALL_STEPS);
      expect(transport.awsState.topicAttributes.get(topic)?.SignatureVersion).toBeUndefined();
      expect(output.join('')).toContain('bounce and complaint reports');
    });

    it('asks for the key in an interactive run, so a person can actually fix it', async () => {
      const { store, transport } = await brokenInstall();
      const { ctx } = await fakeRun({
        store,
        transport,
        answers: { ...(await answers()), mail: { provider: 'ses', region: 'eu-west-1' } },
      });
      ctx.interactive = true;
      const asked: string[] = [];
      ctx.ui.prompts = {
        ...ctx.ui.prompts,
        confirm: async () => true,
        text: async ({ message }: { message: string }) => {
          asked.push(message);
          return withKey.awsAccessKeyId;
        },
        password: async ({ message }: { message: string }) => {
          asked.push(message);
          return withKey.awsSecretAccessKey;
        },
      } as typeof ctx.ui.prompts;
      ctx.session.oauthToken = 'test-only-token';
      ctx.session.accountId = 'account-dry-run';
      const step = INSTALL_STEPS.find((s) => s.id === 'prompts');
      await step?.run(ctx);
      expect(asked).toEqual(['AWS access key id', 'AWS secret access key']);
      expect(ctx.session.awsAdmin?.accessKeyId).toBe(withKey.awsAccessKeyId);
    });
  });

  it('does not subscribe again when the subscription is already confirmed', async () => {
    const base = await answers();
    const store = new MemoryStateStore();
    const transport = new FakeTransport({ zone: 'example.com' });
    const mail = {
      provider: 'ses' as const,
      region: 'eu-west-1',
      awsAccessKeyId: 'AKIAADMINDRYRUN00000',
      awsSecretAccessKey: 'admin-secret-dry-run-000000000000000000',
    };
    const first = await fakeRun({ store, transport, answers: { ...base, mail } });
    await runSteps(first.ctx, INSTALL_STEPS);
    const before = transport.actions.length;
    const second = await fakeRun({ store, transport, answers: { ...base, mail } });
    await runSteps(second.ctx, INSTALL_STEPS);
    expect(
      transport.actions.slice(before).filter((a) => a.startsWith('aws sns Subscribe')),
    ).toEqual([]);
  });

  describe('re-running an SES install from before the suppression actions', () => {
    const withKey = {
      provider: 'ses' as const,
      region: 'eu-west-1',
      awsAccessKeyId: 'AKIAADMINDRYRUN00000',
      awsSecretAccessKey: 'admin-secret-dry-run-000000000000000000',
    };

    async function oldInstall() {
      const store = new MemoryStateStore();
      const transport = new FakeTransport({ zone: 'example.com' });
      const first = await fakeRun({
        store,
        transport,
        answers: { ...(await answers()), mail: withKey },
      });
      await runSteps(first.ctx, INSTALL_STEPS);
      // What an older install saved, and the policy it was given.
      delete first.ctx.state.ses?.workerActions;
      await save(first.ctx);
      transport.awsState.workerPolicy = 'old policy';
      return { store, transport };
    }

    it('updates the policy with the admin key', async () => {
      const { store, transport } = await oldInstall();
      const { ctx } = await fakeRun({
        store,
        transport,
        answers: { ...(await answers()), mail: withKey },
      });
      await runSteps(ctx, INSTALL_STEPS);
      expect(JSON.parse(transport.awsState.workerPolicy).Statement[0].Action).toEqual(
        WORKER_SES_ACTIONS,
      );
      expect(ctx.state.ses?.workerActions).toEqual(WORKER_SES_ACTIONS);
      // The admin key is still never saved.
      expect(JSON.stringify(ctx.secrets)).not.toContain('admin-secret-dry-run');
    });

    it('warns and carries on without the key, leaving the policy for the next run', async () => {
      const { store, transport } = await oldInstall();
      const output: string[] = [];
      const { ctx } = await fakeRun({
        store,
        transport,
        output,
        answers: { ...(await answers()), mail: { provider: 'ses', region: 'eu-west-1' } },
      });
      await runSteps(ctx, INSTALL_STEPS);
      expect(transport.awsState.workerPolicy).toBe('old policy');
      expect(output.join('')).toContain("The workers' AWS policy is out of date");
    });
  });
});

describe('resources', () => {
  it('reuses what already exists and creates nothing', async () => {
    const transport = new FakeTransport({ zone: 'example.com' });
    transport.d1.push({ uuid: 'existing-d1', name: 'swarm-production' });
    transport.kv.push({ id: 'existing-kv', title: 'swarm-production-cache' });
    for (const b of ['media', 'imports', 'exports', 'reports'])
      transport.r2.push({ name: `swarm-production-${b}` });
    for (const q of QUEUES) {
      transport.queues.push({ queue_id: `q-${q}`, queue_name: `swarm-production-${q}` });
    }
    const { ctx } = await fakeRun({ transport });
    ctx.session = { accountId: 'account-dry-run', oauthToken: 'token' };
    await provisionResources(ctx);
    expect(creates(transport.actions)).toEqual([]);
    expect(ctx.state.resources.d1).toEqual({ id: 'existing-d1', name: 'swarm-production' });
    expect(ctx.state.resources.kv).toEqual({ id: 'existing-kv', title: 'swarm-production-cache' });
    expect(ctx.state.resources.queues).toHaveLength(8);
  });

  it('gives an install from before the public queue that queue and its dead-letter queue only', async () => {
    const transport = new FakeTransport({ zone: 'example.com' });
    transport.d1.push({ uuid: 'existing-d1', name: 'swarm-production' });
    transport.kv.push({ id: 'existing-kv', title: 'swarm-production-cache' });
    for (const b of ['media', 'imports', 'exports', 'reports'])
      transport.r2.push({ name: `swarm-production-${b}` });
    for (const q of QUEUES.filter((q) => !q.startsWith('public'))) {
      transport.queues.push({ queue_id: `q-${q}`, queue_name: `swarm-production-${q}` });
    }
    const { ctx } = await fakeRun({ transport });
    ctx.session = { accountId: 'account-dry-run', oauthToken: 'token' };
    await provisionResources(ctx);
    expect(creates(transport.actions).map((a) => a.split(/\s+/).pop())).toEqual([
      'swarm-production-public',
      'swarm-production-public-dlq',
    ]);
    expect(ctx.state.resources.queues).toContain('swarm-production-public');
  });
});
