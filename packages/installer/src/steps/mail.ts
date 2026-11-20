import { randomBytes } from 'node:crypto';
import { save, saveSecrets, type Ctx } from '../context';
import { hostnamesFor, type Hostnames } from '../hostnames';
import { MailgunRest, mailgunSigningKey, mailgunZoneRecords } from '../mailgun';
import { PostmarkRest, checkedPostmarkServer, postmarkZoneRecords } from '../postmark';
import { ResendRest, resendZoneRecords, validateResendKey } from '../resend';
import { configurationSet } from '../config/render';
import {
  SES_SUPPRESSED_REASONS,
  SNS_SIGNATURE_VERSION,
  WORKER_SES_ACTIONS,
  sesSuppressionOutdated,
  sesPolicyOutdated,
  sesTopicOutdated,
} from '../ses-policy';
import type { DnsRecordSpec } from '../state';
import type { AwsService } from '../transport';
import { InstallError } from '../ui';
import { askAwsAdmin } from './prompts';
import type { Step } from './step';

const SES_EVENT_TYPES = ['BOUNCE', 'COMPLAINT', 'DELIVERY', 'REJECT'];
const EVENT_DESTINATION = 'swarm-sns';

/** SES Easy DKIM and MAIL FROM records for mail.D (same shapes as @swarm/engine domains.ts). */
function sesRecords(h: Hostnames, region: string, tokens: string[]): DnsRecordSpec[] {
  return [
    ...tokens.map((token) => ({
      type: 'CNAME' as const,
      name: `${token}._domainkey.${h.mail}`,
      content: `${token}.dkim.amazonses.com`,
      proxied: false,
    })),
    { type: 'MX', name: h.bounce, content: `feedback-smtp.${region}.amazonses.com`, priority: 10 },
    { type: 'TXT', name: h.bounce, content: 'v=spf1 include:amazonses.com ~all' },
  ];
}

const isNotFound = (error: unknown) =>
  error instanceof Error && /NotFound|NoSuchEntity/.test(error.name);

function awsCall(ctx: Ctx, region: string) {
  const credentials = ctx.session.awsAdmin;
  if (!credentials) throw new InstallError('No AWS key for the SES setup.');
  return <T = Record<string, unknown>>(
    service: AwsService,
    operation: string,
    input: Record<string, unknown> = {},
  ) =>
    ctx.t.aws<T>({ service, operation, input, region, credentials }).catch((error: unknown) => {
      if (isNotFound(error)) throw error;
      const e = error as Error;
      if (
        /AccessDenied|AuthorizationError|UnrecognizedClient|InvalidClientTokenId|InvalidSignature|SignatureDoesNotMatch/.test(
          e.name,
        )
      ) {
        throw new InstallError(
          `AWS refused ${service}:${operation} (${e.name}).`,
          'Use a key that can manage SES, SNS and IAM, such as one with the setup policy or an administrator key, then try again.',
        );
      }
      throw error;
    });
}

async function setUpSes(ctx: Ctx) {
  const choices = ctx.state.choices;
  if (!choices) throw new InstallError('Answers are missing.', 'Run `pnpm swarm` first.');
  const region = choices.mail.region;
  const h = hostnamesFor(ctx.state.zone?.name ?? '', ctx.env, ctx.state.choices?.addresses);
  if (!ctx.session.awsAdmin) {
    const keyGiven = !!(ctx.answers.mail?.awsAccessKeyId && ctx.answers.mail.awsSecretAccessKey);
    if (ctx.state.ses && ctx.secrets.aws && !keyGiven) {
      const topicOutdated = sesTopicOutdated(ctx.state.ses);
      const policyOutdated = sesPolicyOutdated(ctx.state.ses);
      if (topicOutdated) {
        ctx.ui.warn(
          'Swarm refuses the bounce and complaint reports this SES topic sends, so bad addresses are not suppressed and sends do not pause. Run `pnpm swarm` with the AWS admin key to fix it.',
        );
      }
      if (policyOutdated) {
        ctx.ui.warn(
          "The workers' AWS policy is out of date, so the SES suppression list may not sync and Settings can't show your SES limits. Run `pnpm swarm` with the AWS admin key to update it.",
        );
      }
      // Installs made before the installer set the suppression list to bounces only. The
      // workers' key may read the account; only the admin key may change it.
      const listOutdated = await ctx.t
        .aws<{ SuppressionAttributes?: { SuppressedReasons?: string[] } }>({
          service: 'sesv2',
          operation: 'GetAccount',
          input: {},
          region,
          credentials: ctx.secrets.aws,
        })
        .then((a) => sesSuppressionOutdated(a.SuppressionAttributes?.SuppressedReasons))
        .catch(() => false);
      if (listOutdated) {
        ctx.ui.warn(
          'The SES suppression list is not set to bounces only, so one workspace’s complaint can stop another workspace’s sends. Run `pnpm swarm` with the AWS admin key to set it.',
        );
      }
      if (!topicOutdated && !policyOutdated && !listOutdated) {
        ctx.ui.info('Amazon SES is already set up; skipping it (no AWS admin key in this run).');
      }
      return;
    }
    await askAwsAdmin(ctx);
  }
  const aws = awsCall(ctx, region);

  const awsAccountId = await ctx.ui.task(
    'Checking the AWS key',
    async () => {
      const identity = await aws<{ Account?: string }>('sts', 'GetCallerIdentity');
      if (!identity.Account)
        throw new InstallError('AWS did not say which account the key belongs to.');
      return identity.Account;
    },
    (id) => `done (account ${id})`,
  );

  const topicName = `swarm-${ctx.env}-ses-events`;
  const topicArn = await ctx.ui.task(`Creating SNS topic ${topicName}`, async () => {
    const { TopicArn } = await aws<{ TopicArn?: string }>('sns', 'CreateTopic', {
      Name: topicName,
    });
    if (!TopicArn) throw new InstallError('AWS did not return the topic ARN.');
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AllowSesPublish',
          Effect: 'Allow',
          Principal: { Service: 'ses.amazonaws.com' },
          Action: 'sns:Publish',
          Resource: TopicArn,
          Condition: { StringEquals: { 'aws:SourceAccount': awsAccountId } },
        },
      ],
    };
    await aws('sns', 'SetTopicAttributes', {
      TopicArn,
      AttributeName: 'Policy',
      AttributeValue: JSON.stringify(policy),
    });
    await aws('sns', 'SetTopicAttributes', {
      TopicArn,
      AttributeName: 'SignatureVersion',
      AttributeValue: SNS_SIGNATURE_VERSION,
    });
    return TopicArn;
  });

  for (const kind of ['broadcasts', 'transactional', 'direct'] as const) {
    const name = configurationSet(ctx.env, kind);
    let created = false;
    await ctx.ui.task(
      `Creating configuration set ${name}`,
      async () => {
        try {
          await aws('sesv2', 'GetConfigurationSet', { ConfigurationSetName: name });
        } catch (error) {
          if (!isNotFound(error)) throw error;
          created = true;
          await aws('sesv2', 'CreateConfigurationSet', {
            ConfigurationSetName: name,
            ReputationOptions: { ReputationMetricsEnabled: true },
          });
        }
        const { EventDestinations = [] } = await aws<{ EventDestinations?: { Name?: string }[] }>(
          'sesv2',
          'GetConfigurationSetEventDestinations',
          { ConfigurationSetName: name },
        );
        if (!EventDestinations.some((d) => d.Name === EVENT_DESTINATION)) {
          await aws('sesv2', 'CreateConfigurationSetEventDestination', {
            ConfigurationSetName: name,
            EventDestinationName: EVENT_DESTINATION,
            EventDestination: {
              Enabled: true,
              MatchingEventTypes: SES_EVENT_TYPES,
              SnsDestination: { TopicArn: topicArn },
            },
          });
        }
      },
      () => (created ? 'done' : 'already there'),
    );
  }

  const userName = `swarm-${ctx.env}-workers`;
  await ctx.ui.task(`Creating IAM user ${userName}`, async () => {
    try {
      await aws('iam', 'GetUser', { UserName: userName });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await aws('iam', 'CreateUser', { UserName: userName });
    }
    await aws('iam', 'PutUserPolicy', {
      UserName: userName,
      PolicyName: 'swarm-send-mail',
      PolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: WORKER_SES_ACTIONS, Resource: '*' }],
      }),
    });
  });

  let reused = false;
  await ctx.ui.task(
    "Creating the workers' access key",
    async () => {
      const { AccessKeyMetadata = [] } = await aws<{
        AccessKeyMetadata?: { AccessKeyId?: string }[];
      }>('iam', 'ListAccessKeys', { UserName: userName });
      const stored = ctx.secrets.aws;
      if (stored && AccessKeyMetadata.some((k) => k.AccessKeyId === stored.accessKeyId)) {
        reused = true;
        return;
      }
      if (AccessKeyMetadata.length >= 2) {
        throw new InstallError(
          `The IAM user ${userName} already has two access keys, and neither is the one saved in .swarm/.`,
          'Delete one of its keys in the AWS console (IAM > Users), then run `pnpm swarm` again.',
        );
      }
      const { AccessKey } = await aws<{
        AccessKey?: { AccessKeyId?: string; SecretAccessKey?: string };
      }>('iam', 'CreateAccessKey', { UserName: userName });
      if (!AccessKey?.AccessKeyId || !AccessKey.SecretAccessKey)
        throw new InstallError('AWS did not return the new access key.');
      ctx.secrets.aws = {
        accessKeyId: AccessKey.AccessKeyId,
        secretAccessKey: AccessKey.SecretAccessKey,
      };
      await saveSecrets(ctx);
    },
    () => (reused ? 'kept the saved key' : 'done'),
  );

  const tokens = await ctx.ui.task(`Adding the sending domain ${h.mail} to SES`, async () => {
    let result: { DkimAttributes?: { Tokens?: string[] } };
    try {
      result = await aws('sesv2', 'GetEmailIdentity', { EmailIdentity: h.mail });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      result = await aws('sesv2', 'CreateEmailIdentity', {
        EmailIdentity: h.mail,
        DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
      });
    }
    await aws('sesv2', 'PutEmailIdentityMailFromAttributes', {
      EmailIdentity: h.mail,
      MailFromDomain: h.bounce,
      BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
    });
    return result.DkimAttributes?.Tokens ?? [];
  });

  const owner = choices.owner.email;
  await ctx.ui.task(
    `Verifying ${owner} with SES`,
    async () => {
      try {
        const identity = await aws<{ VerifiedForSendingStatus?: boolean }>(
          'sesv2',
          'GetEmailIdentity',
          { EmailIdentity: owner },
        );
        return identity.VerifiedForSendingStatus
          ? 'already verified'
          : 'waiting for you to click the link AWS sent';
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await aws('sesv2', 'CreateEmailIdentity', { EmailIdentity: owner });
        return 'sent; click the link in the email from AWS';
      }
    },
    (status) => status,
  );

  const account = await aws<{
    ProductionAccessEnabled?: boolean;
    SuppressionAttributes?: { SuppressedReasons?: string[] };
  }>('sesv2', 'GetAccount');
  const productionAccess = account.ProductionAccessEnabled === true;

  // The account-level suppression list is shared by every workspace: bounces only, so one
  // workspace's complaints stay with it. Safe to repeat; a key without the permission only warns.
  await ctx.ui.task(
    'Setting the SES suppression list to bounces only',
    async () => {
      if (!sesSuppressionOutdated(account.SuppressionAttributes?.SuppressedReasons)) {
        return 'already set';
      }
      try {
        await aws('sesv2', 'PutAccountSuppressionAttributes', {
          SuppressedReasons: SES_SUPPRESSED_REASONS,
        });
        return 'done';
      } catch (error) {
        if (!(error instanceof InstallError)) throw error;
        ctx.ui.warn(
          'AWS refused to change the SES suppression list, so it is not set to bounces only, and one workspace’s complaint can stop another workspace’s sends. Give the setup key ses:PutAccountSuppressionAttributes, or run `aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE`.',
        );
        return 'not changed';
      }
    },
    (status) => status,
  );
  ctx.state.ses = {
    awsAccountId,
    topicArn,
    iamUser: userName,
    dkimTokens: tokens,
    productionAccess,
    topicSignatureVersion: SNS_SIGNATURE_VERSION,
    workerActions: WORKER_SES_ACTIONS,
  };
  ctx.state.mailRecords = sesRecords(h, region, tokens);
  await save(ctx);

  if (!productionAccess) {
    ctx.ui.note(
      'Your AWS account is in the SES sandbox',
      [
        'In the sandbox, SES only delivers to addresses you have verified, up to 200 emails a day.',
        `Sign-in mail to ${owner} works once you click the link AWS sent. To send to subscribers,`,
        'AWS has to move the account to production access; a person at AWS reviews the request,',
        'usually within a day.',
      ].join('\n'),
    );
    const request =
      ctx.answers.mail?.requestProductionAccess ??
      (ctx.interactive && !ctx.yes
        ? await ctx.ui.prompts.confirm({
            message: 'Ask AWS for production access now?',
            initialValue: true,
          })
        : false);
    if (request) {
      await ctx.ui.task('Requesting SES production access', () =>
        aws('sesv2', 'PutAccountDetails', {
          MailType: 'MARKETING',
          WebsiteURL: `https://${h.app}`,
          ContactLanguage: 'EN',
          UseCaseDescription:
            'Self-hosted Swarm newsletter platform. Subscribers sign up with confirmed opt-in on our own forms; ' +
            'every email has one-click unsubscribe (RFC 8058). Bounces and complaints arrive over SNS and suppress the address automatically.',
          AdditionalContactEmailAddresses: [owner],
          ProductionAccessEnabled: true,
        }),
      );
    }
  }
}

async function setUpResend(ctx: Ctx) {
  const choices = ctx.state.choices;
  const key = ctx.secrets.resendApiKey;
  if (!choices || !key)
    throw new InstallError('The Resend API key is missing.', 'Run `pnpm swarm` and paste the key.');
  const h = hostnamesFor(ctx.state.zone?.name ?? '', ctx.env, ctx.state.choices?.addresses);
  const api = new ResendRest(ctx.t, key);
  await ctx.ui.task('Checking the Resend API key', () => validateResendKey(api));
  let created = false;
  const domain = await ctx.ui.task(
    `Adding the sending domain ${h.mail} to Resend`,
    async () => {
      const existing = (await api.listDomains()).find((d) => d.name === h.mail);
      if (existing) return api.getDomain(existing.id);
      created = true;
      return api.createDomain(h.mail, choices.mail.region, 'bounce');
    },
    () => (created ? 'done' : 'already there'),
  );
  if (domain.region && domain.region !== choices.mail.region) {
    ctx.ui.warn(`${h.mail} already exists in Resend's ${domain.region} region; keeping it there.`);
    choices.mail.region = domain.region;
  }
  ctx.state.resend = { ...ctx.state.resend, domainId: domain.id, status: domain.status };
  ctx.state.mailRecords = resendZoneRecords(h.mail, domain.records ?? []);
  await save(ctx);
}

async function setUpMailgun(ctx: Ctx) {
  const choices = ctx.state.choices;
  const key = ctx.secrets.mailgunApiKey;
  if (!choices || !key)
    throw new InstallError(
      'The Mailgun API key is missing.',
      'Run `pnpm swarm` and paste the key.',
    );
  const h = hostnamesFor(ctx.state.zone?.name ?? '', ctx.env, ctx.state.choices?.addresses);
  const api = new MailgunRest(ctx.t, key, choices.mail.region as 'us' | 'eu');
  // Read now so the events worker has the key on its first deploy.
  const signingKey = await ctx.ui.task('Checking the Mailgun API key', () =>
    mailgunSigningKey(api),
  );
  if (signingKey !== ctx.secrets.mailgunWebhookSigningKey) {
    ctx.secrets.mailgunWebhookSigningKey = signingKey;
    await saveSecrets(ctx);
  }
  let created = false;
  const domain = await ctx.ui.task(
    `Adding the sending domain ${h.mail} to Mailgun`,
    async () => {
      const existing = await api.getDomain(h.mail);
      if (existing) return existing;
      created = true;
      return api.createDomain(h.mail);
    },
    () => (created ? 'done' : 'already there'),
  );
  ctx.state.mailgun = {
    ...ctx.state.mailgun,
    domain: h.mail,
    ...(domain.domain?.state ? { status: domain.domain.state } : {}),
  };
  ctx.state.mailRecords = mailgunZoneRecords(h.mail, domain);
  await save(ctx);
}

async function setUpPostmark(ctx: Ctx) {
  const account = ctx.secrets.postmarkAccountToken;
  if (!ctx.state.choices || !account) {
    throw new InstallError(
      'The Postmark account token is missing.',
      'Run `pnpm swarm` and paste the token.',
    );
  }
  const h = hostnamesFor(ctx.state.zone?.name ?? '', ctx.env, ctx.state.choices?.addresses);
  const name = `swarm-${ctx.env}`;
  const server = await ctx.ui.task(`Setting up the Postmark server ${name}`, () =>
    checkedPostmarkServer(new PostmarkRest(ctx.t, { account }), name),
  );
  const token = server.ApiTokens?.[0];
  if (!token) throw new InstallError('Postmark did not return a token for the server.');
  // Generated once and before the first deploy, so the events worker has it from the start.
  const secret = ctx.secrets.postmarkWebhookSecret ?? randomBytes(32).toString('hex');
  if (token !== ctx.secrets.postmarkServerToken || secret !== ctx.secrets.postmarkWebhookSecret) {
    ctx.secrets.postmarkServerToken = token;
    ctx.secrets.postmarkWebhookSecret = secret;
    await saveSecrets(ctx);
  }
  const api = new PostmarkRest(ctx.t, { account, server: token });
  const unsubscribeHandling = await ctx.ui.task('Creating the stream for posts', () =>
    api.ensureBroadcastStream(),
  );
  if (unsubscribeHandling !== 'Custom') {
    ctx.ui.warn(
      "Postmark handles unsubscribes on the stream for posts, so it may add its own unsubscribe link next to Swarm's. Postmark says approved accounts can use custom handling; ask its support if you want only Swarm's.",
    );
  }
  const domain = await ctx.ui.task(`Adding the sending domain ${h.mail} to Postmark`, () =>
    api.ensureDomain(h.mail, h.bounce),
  );
  ctx.state.postmark = {
    serverId: server.ID,
    domainId: domain.ID,
    dkimVerified: domain.DKIMVerified === true,
    unsubscribeHandling,
  };
  ctx.state.mailRecords = postmarkZoneRecords(domain);
  await save(ctx);
}

/** Nothing to create on a person's own server: the secret, and what they must do themselves. */
async function setUpSmtp(ctx: Ctx) {
  const smtp = ctx.state.choices?.mail.smtp;
  if (!smtp) throw new InstallError('The mail server is missing.', 'Run `pnpm swarm` first.');
  const h = hostnamesFor(ctx.state.zone?.name ?? '', ctx.env, ctx.state.choices?.addresses);
  if (!ctx.secrets.smtpFeedbackSecret) {
    ctx.secrets.smtpFeedbackSecret = `whsec_${randomBytes(32).toString('base64')}`;
    await saveSecrets(ctx);
  }
  ctx.state.mailRecords = [];
  await save(ctx);
  ctx.ui.note(
    'What your mail server needs',
    [
      `Swarm sends through ${smtp.host}:${smtp.port}, from ${h.mailFrom}. Your server must:`,
      `- sign that domain with DKIM, published at ${smtp.dkimSelector}._domainkey.${h.mail}`,
      `- be allowed by an SPF record on ${h.mail}, and on ${h.unsubscribe} if it keeps Swarm's return path`,
      '',
      'Swarm cannot add these records, because only your server knows their values. It will not send',
      'until it finds the DKIM record.',
      '',
      'Spam complaints: plain SMTP does not report them, so Swarm cannot pause a send when they rise',
      'unless your server reports them. See "Your own mail server" in docs/deployment.md.',
    ].join('\n'),
  );
}

export const mail: Step = {
  id: 'mail',
  title: 'Email sending',
  async run(ctx) {
    const provider = ctx.state.choices?.mail.provider;
    if (provider === 'ses') await setUpSes(ctx);
    else if (provider === 'mailgun') await setUpMailgun(ctx);
    else if (provider === 'postmark') await setUpPostmark(ctx);
    else if (provider === 'smtp') await setUpSmtp(ctx);
    else await setUpResend(ctx);
  },
};
