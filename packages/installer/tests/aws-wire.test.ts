// The browser setup can't carry the AWS SDK, so it speaks to AWS itself (src/wizard/aws.ts). These
// tests send the same call both ways, answer both with the same bytes, and require the same request
// and the same reading of the answer. The responses follow AWS's documented shapes. This proves the
// two agree; only a run against real AWS proves AWS accepts them.
import { Readable } from 'node:stream';
import {
  IAMClient,
  CreateAccessKeyCommand,
  CreateUserCommand,
  GetUserCommand,
  ListAccessKeysCommand,
  PutUserPolicyCommand,
} from '@aws-sdk/client-iam';
import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateEmailIdentityCommand,
  GetAccountCommand,
  GetConfigurationSetCommand,
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
  PutAccountDetailsCommand,
  PutAccountSuppressionAttributesCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SESv2Client,
  SendEmailCommand,
} from '@aws-sdk/client-sesv2';
import {
  CreateTopicCommand,
  ListSubscriptionsByTopicCommand,
  SNSClient,
  SetTopicAttributesCommand,
  SubscribeCommand,
} from '@aws-sdk/client-sns';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { describe, expect, it } from 'vitest';
import type { AwsService } from '../src/transport';
import { WorkerTransport } from '../src/wizard/transport';

const credentials = { accessKeyId: 'AKIATESTTESTTESTTEST', secretAccessKey: 'test'.repeat(10) };
const region = 'eu-west-1';
const xml = { 'content-type': 'text/xml' };
const json = { 'content-type': 'application/json' };

interface Canned {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Seen {
  method: string;
  host: string;
  path: string;
  body: unknown;
}

function readBody(body: string, contentType: string | undefined): unknown {
  if (!body) return null;
  if (contentType?.includes('json')) return JSON.parse(body);
  return Object.fromEntries(new URLSearchParams(body));
}

const decodedPath = (path: string) => decodeURIComponent(path);

/** Sends one call through the real SDK, answered by `canned`, and notes what it asked for. */
async function throughSdk(service: AwsService, command: unknown, canned: Canned) {
  let seen: Seen | undefined;
  const requestHandler = {
    metadata: { handlerProtocol: 'http/1.1' },
    updateHttpClientConfig() {},
    httpHandlerConfigs: () => ({}),
    destroy() {},
    async handle(request: {
      method: string;
      hostname: string;
      path: string;
      headers: Record<string, string>;
      body?: string;
    }) {
      seen = {
        method: request.method,
        host: request.hostname,
        path: decodedPath(request.path),
        body: readBody(request.body ?? '', request.headers['content-type']),
      };
      return {
        response: {
          statusCode: canned.status,
          headers: canned.headers,
          body: Readable.from([Buffer.from(canned.body)]),
        },
      };
    },
  };
  const options = { region, credentials, requestHandler, maxAttempts: 1 };
  const client = {
    sesv2: () => new SESv2Client(options),
    sns: () => new SNSClient(options),
    iam: () => new IAMClient(options),
    sts: () => new STSClient(options),
  }[service]() as unknown as { send(command: unknown): Promise<Record<string, unknown>> };
  const outcome = await client.send(command).then(
    (result) => ({ result, error: null }),
    (error: Error) => ({ result: null, error }),
  );
  return { ...outcome, seen };
}

/** The same call through the browser setup's transport. */
async function throughWorker(
  service: AwsService,
  operation: string,
  input: Record<string, unknown>,
  canned: Canned,
) {
  let seen: Seen | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    const headers = init?.headers as Record<string, string>;
    seen = {
      method: String(init?.method),
      host: target.hostname,
      path: decodedPath(target.pathname),
      body: readBody(String(init?.body ?? ''), headers['content-type']),
    };
    return new Response(canned.body, { status: canned.status, headers: canned.headers });
  };
  const outcome = await new WorkerTransport(fetcher)
    .aws<Record<string, unknown>>({ service, operation, input, region, credentials })
    .then(
      (result) => ({ result, error: null }),
      (error: Error) => ({ result: null, error }),
    );
  return { ...outcome, seen };
}

const topic = 'arn:aws:sns:eu-west-1:123456789012:swarm-production-ses-events';
const endpoint = 'https://events.example.com/sns/ses';

const queryOk = (operation: string, inner: string, namespace: string): Canned => ({
  status: 200,
  headers: xml,
  body: `<?xml version="1.0"?><${operation}Response xmlns="${namespace}"><${operation}Result>${inner}</${operation}Result><ResponseMetadata><RequestId>abc</RequestId></ResponseMetadata></${operation}Response>`,
});
const SNS = 'http://sns.amazonaws.com/doc/2010-03-31/';
const IAM = 'https://iam.amazonaws.com/doc/2010-05-08/';
const STS = 'https://sts.amazonaws.com/doc/2011-06-15/';
const jsonOk = (body: unknown): Canned => ({
  status: 200,
  headers: json,
  body: JSON.stringify(body),
});

type Case = [
  service: AwsService,
  operation: string,
  input: Record<string, unknown>,
  command: new (input: never) => unknown,
  canned: Canned,
  /** What the installer's steps read from the answer, so an empty result can't pass by accident. */
  reads?: Record<string, unknown>,
];

const CASES: Case[] = [
  [
    'sts',
    'GetCallerIdentity',
    {},
    GetCallerIdentityCommand,
    queryOk(
      'GetCallerIdentity',
      '<Arn>arn:aws:iam::123456789012:user/x</Arn><UserId>U</UserId><Account>123456789012</Account>',
      STS,
    ),
    { Account: '123456789012' },
  ],
  [
    'sns',
    'CreateTopic',
    { Name: 'swarm-production-ses-events' },
    CreateTopicCommand,
    queryOk('CreateTopic', `<TopicArn>${topic}</TopicArn>`, SNS),
    { TopicArn: topic },
  ],
  [
    'sns',
    'SetTopicAttributes',
    { TopicArn: topic, AttributeName: 'SignatureVersion', AttributeValue: '2' },
    SetTopicAttributesCommand,
    {
      status: 200,
      headers: xml,
      body: `<SetTopicAttributesResponse xmlns="${SNS}"><ResponseMetadata><RequestId>abc</RequestId></ResponseMetadata></SetTopicAttributesResponse>`,
    },
  ],
  [
    'sns',
    'Subscribe',
    { TopicArn: topic, Protocol: 'https', Endpoint: endpoint },
    SubscribeCommand,
    queryOk('Subscribe', '<SubscriptionArn>pending confirmation</SubscriptionArn>', SNS),
    { SubscriptionArn: 'pending confirmation' },
  ],
  [
    'sns',
    'ListSubscriptionsByTopic',
    { TopicArn: topic },
    ListSubscriptionsByTopicCommand,
    queryOk(
      'ListSubscriptionsByTopic',
      `<Subscriptions><member><TopicArn>${topic}</TopicArn><Protocol>https</Protocol><SubscriptionArn>PendingConfirmation</SubscriptionArn><Owner>123456789012</Owner><Endpoint>${endpoint}</Endpoint></member></Subscriptions>`,
      SNS,
    ),
    { Subscriptions: [{ Endpoint: endpoint, SubscriptionArn: 'PendingConfirmation' }] },
  ],
  [
    'iam',
    'GetUser',
    { UserName: 'swarm-production-workers' },
    GetUserCommand,
    queryOk(
      'GetUser',
      '<User><Path>/</Path><UserName>swarm-production-workers</UserName><UserId>U</UserId><Arn>arn:aws:iam::123456789012:user/swarm-production-workers</Arn></User>',
      IAM,
    ),
    { User: { UserName: 'swarm-production-workers' } },
  ],
  [
    'iam',
    'CreateUser',
    { UserName: 'swarm-production-workers' },
    CreateUserCommand,
    queryOk(
      'CreateUser',
      '<User><Path>/</Path><UserName>swarm-production-workers</UserName><UserId>U</UserId><Arn>arn:aws:iam::123456789012:user/swarm-production-workers</Arn></User>',
      IAM,
    ),
  ],
  [
    'iam',
    'PutUserPolicy',
    {
      UserName: 'swarm-production-workers',
      PolicyName: 'swarm-send-mail',
      PolicyDocument: '{"a":"b & c"}',
    },
    PutUserPolicyCommand,
    {
      status: 200,
      headers: xml,
      body: `<PutUserPolicyResponse xmlns="${IAM}"><ResponseMetadata><RequestId>abc</RequestId></ResponseMetadata></PutUserPolicyResponse>`,
    },
  ],
  [
    'iam',
    'ListAccessKeys',
    { UserName: 'swarm-production-workers' },
    ListAccessKeysCommand,
    queryOk(
      'ListAccessKeys',
      '<UserName>swarm-production-workers</UserName><AccessKeyMetadata><member><UserName>swarm-production-workers</UserName><AccessKeyId>AKIAONE</AccessKeyId><Status>Active</Status></member></AccessKeyMetadata><IsTruncated>false</IsTruncated>',
      IAM,
    ),
    { AccessKeyMetadata: [{ AccessKeyId: 'AKIAONE' }] },
  ],
  [
    'iam',
    'CreateAccessKey',
    { UserName: 'swarm-production-workers' },
    CreateAccessKeyCommand,
    queryOk(
      'CreateAccessKey',
      '<AccessKey><UserName>swarm-production-workers</UserName><AccessKeyId>AKIANEW</AccessKeyId><Status>Active</Status><SecretAccessKey>s3cr&amp;t</SecretAccessKey></AccessKey>',
      IAM,
    ),
    { AccessKey: { AccessKeyId: 'AKIANEW', SecretAccessKey: 's3cr&t' } },
  ],
  [
    'sesv2',
    'GetAccount',
    {},
    GetAccountCommand,
    jsonOk({
      ProductionAccessEnabled: false,
      SendingEnabled: true,
      SuppressionAttributes: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
    }),
    {
      ProductionAccessEnabled: false,
      SuppressionAttributes: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
    },
  ],
  [
    'sesv2',
    'PutAccountSuppressionAttributes',
    { SuppressedReasons: ['BOUNCE'] },
    PutAccountSuppressionAttributesCommand,
    jsonOk({}),
  ],
  [
    'sesv2',
    'PutAccountDetails',
    {
      MailType: 'MARKETING',
      WebsiteURL: 'https://app.example.com',
      ContactLanguage: 'EN',
      UseCaseDescription: 'A newsletter',
      AdditionalContactEmailAddresses: ['ada@example.com'],
      ProductionAccessEnabled: true,
    },
    PutAccountDetailsCommand,
    jsonOk({}),
  ],
  [
    'sesv2',
    'GetConfigurationSet',
    { ConfigurationSetName: 'swarm-production-broadcasts' },
    GetConfigurationSetCommand,
    jsonOk({ ConfigurationSetName: 'swarm-production-broadcasts' }),
  ],
  [
    'sesv2',
    'CreateConfigurationSet',
    {
      ConfigurationSetName: 'swarm-production-broadcasts',
      ReputationOptions: { ReputationMetricsEnabled: true },
    },
    CreateConfigurationSetCommand,
    jsonOk({}),
  ],
  [
    'sesv2',
    'GetConfigurationSetEventDestinations',
    { ConfigurationSetName: 'swarm-production-broadcasts' },
    GetConfigurationSetEventDestinationsCommand,
    jsonOk({ EventDestinations: [{ Name: 'swarm-sns', Enabled: true }] }),
    { EventDestinations: [{ Name: 'swarm-sns' }] },
  ],
  [
    'sesv2',
    'CreateConfigurationSetEventDestination',
    {
      ConfigurationSetName: 'swarm-production-broadcasts',
      EventDestinationName: 'swarm-sns',
      EventDestination: {
        Enabled: true,
        MatchingEventTypes: ['BOUNCE', 'COMPLAINT', 'DELIVERY', 'REJECT'],
        SnsDestination: { TopicArn: topic },
      },
    },
    CreateConfigurationSetEventDestinationCommand,
    jsonOk({}),
  ],
  [
    'sesv2',
    'GetEmailIdentity',
    { EmailIdentity: 'ada+test@example.com' },
    GetEmailIdentityCommand,
    jsonOk({ VerifiedForSendingStatus: true, DkimAttributes: { Tokens: ['one', 'two', 'three'] } }),
    { VerifiedForSendingStatus: true, DkimAttributes: { Tokens: ['one', 'two', 'three'] } },
  ],
  [
    'sesv2',
    'CreateEmailIdentity',
    {
      EmailIdentity: 'mail.example.com',
      DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
    },
    CreateEmailIdentityCommand,
    jsonOk({ DkimAttributes: { Tokens: ['one', 'two', 'three'] } }),
    { DkimAttributes: { Tokens: ['one', 'two', 'three'] } },
  ],
  [
    'sesv2',
    'PutEmailIdentityMailFromAttributes',
    {
      EmailIdentity: 'mail.example.com',
      MailFromDomain: 'bounce.mail.example.com',
      BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
    },
    PutEmailIdentityMailFromAttributesCommand,
    jsonOk({}),
  ],
  [
    'sesv2',
    'SendEmail',
    {
      FromEmailAddress: 'signin@mail.example.com',
      Destination: { ToAddresses: ['ada@example.com'] },
      ConfigurationSetName: 'swarm-production-transactional',
      Content: { Simple: { Subject: { Data: 'Hi' }, Body: { Text: { Data: 'Hello' } } } },
    },
    SendEmailCommand,
    jsonOk({ MessageId: 'm-1' }),
    { MessageId: 'm-1' },
  ],
];

describe('the browser setup speaks to AWS as the SDK does', () => {
  it.each(CASES)('%s %s', async (service, operation, input, Command, canned, reads) => {
    const sdk = await throughSdk(service, new Command(input as never), canned);
    const worker = await throughWorker(service, operation, input, canned);
    expect(sdk.error).toBeNull();
    expect(worker.error).toBeNull();
    expect(worker.seen).toEqual(sdk.seen);
    // Compared on what the steps read: the SDK drops fields it doesn't model, and types the rest.
    if (reads) {
      expect(sdk.result).toMatchObject(reads);
      expect(worker.result).toMatchObject(reads);
    }
  });

  it('reads an empty list the way the steps expect', async () => {
    const canned = queryOk('ListSubscriptionsByTopic', '<Subscriptions/>', SNS);
    const worker = await throughWorker(
      'sns',
      'ListSubscriptionsByTopic',
      { TopicArn: topic },
      canned,
    );
    // `Subscriptions ?? []` in postdeploy.ts relies on this: an empty string would break it.
    expect(worker.result?.Subscriptions).toBeUndefined();
  });

  const NOT_FOUND = /NotFound|NoSuchEntity/;
  const REFUSED =
    /AccessDenied|AuthorizationError|UnrecognizedClient|InvalidClientTokenId|InvalidSignature|SignatureDoesNotMatch/;
  const queryError = (status: number, code: string): Canned => ({
    status,
    headers: xml,
    body: `<ErrorResponse xmlns="${IAM}"><Error><Type>Sender</Type><Code>${code}</Code><Message>Nope</Message></Error><RequestId>abc</RequestId></ErrorResponse>`,
  });
  const jsonError = (status: number, code: string): Canned => ({
    status,
    headers: { ...json, 'x-amzn-errortype': `${code}:http://internal.amazon.com/` },
    body: JSON.stringify({ message: 'Nope' }),
  });

  it.each<
    [string, AwsService, string, Record<string, unknown>, new (i: never) => unknown, Canned, RegExp]
  >([
    [
      'a missing SES identity',
      'sesv2',
      'GetEmailIdentity',
      { EmailIdentity: 'mail.example.com' },
      GetEmailIdentityCommand,
      jsonError(404, 'NotFoundException'),
      NOT_FOUND,
    ],
    [
      'a missing IAM user',
      'iam',
      'GetUser',
      { UserName: 'swarm-x' },
      GetUserCommand,
      queryError(404, 'NoSuchEntity'),
      NOT_FOUND,
    ],
    [
      'SES refusing the key',
      'sesv2',
      'GetAccount',
      {},
      GetAccountCommand,
      jsonError(403, 'AccessDeniedException'),
      REFUSED,
    ],
    [
      'SNS refusing the key',
      'sns',
      'CreateTopic',
      { Name: 'swarm-x' },
      CreateTopicCommand,
      queryError(403, 'AuthorizationError'),
      REFUSED,
    ],
    [
      'IAM refusing the key',
      'iam',
      'CreateUser',
      { UserName: 'swarm-x' },
      CreateUserCommand,
      queryError(403, 'AccessDenied'),
      REFUSED,
    ],
    [
      'STS not knowing the key',
      'sts',
      'GetCallerIdentity',
      {},
      GetCallerIdentityCommand,
      queryError(403, 'InvalidClientTokenId'),
      REFUSED,
    ],
  ])(
    'names %s so the steps react the same',
    async (_what, service, operation, input, Command, canned, pattern) => {
      const sdk = await throughSdk(service, new Command(input as never), canned);
      const worker = await throughWorker(service, operation, input, canned);
      expect(sdk.error?.name).toMatch(pattern);
      expect(worker.error?.name).toMatch(pattern);
      expect(worker.error?.message).toBe('Nope');
    },
  );
});

describe('the browser setup talking to AWS', () => {
  const call = (fetcher: typeof fetch) =>
    new WorkerTransport(fetcher).aws({
      service: 'sts',
      operation: 'GetCallerIdentity',
      input: {},
      region,
      credentials,
    });

  it('signs each request, without the secret on the wire', async () => {
    let headers: Record<string, string> = {};
    let body = '';
    await call(async (_url, init) => {
      headers = init?.headers as Record<string, string>;
      body = String(init?.body);
      return new Response(queryOk('GetCallerIdentity', '<Account>1</Account>', STS).body);
    });
    expect(headers.authorization).toContain(`Credential=${credentials.accessKeyId}/`);
    expect(headers.authorization).toContain(`/${region}/sts/aws4_request`);
    expect(JSON.stringify(headers) + body).not.toContain(credentials.secretAccessKey);
  });

  it('signs IAM for its one global endpoint, whatever region SES is in', async () => {
    let url = '';
    let headers: Record<string, string> = {};
    await new WorkerTransport(async (target, init) => {
      url = String(target);
      headers = init?.headers as Record<string, string>;
      return new Response(queryOk('GetUser', '<User><UserName>x</UserName></User>', IAM).body);
    }).aws({ service: 'iam', operation: 'GetUser', input: { UserName: 'x' }, region, credentials });
    expect(url).toBe('https://iam.amazonaws.com/');
    expect(headers.authorization).toContain('/us-east-1/iam/aws4_request');
  });

  it('retries once on throttling, signing again', async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      seen.push((init?.headers as Record<string, string>).authorization ?? '');
      return seen.length === 1
        ? new Response('', { status: 429 })
        : new Response(queryOk('GetCallerIdentity', '<Account>1</Account>', STS).body);
    };
    const transport = new WorkerTransport(fetcher);
    transport.sleep = async () => {};
    await expect(
      transport.aws({
        service: 'sts',
        operation: 'GetCallerIdentity',
        input: {},
        region,
        credentials,
      }),
    ).resolves.toEqual({ Account: '1' });
    expect(seen).toHaveLength(2);
  });

  it('gives up after one retry, and never retries a refusal', async () => {
    let calls = 0;
    const transport = new WorkerTransport(async () => {
      calls++;
      return new Response('<html>Bad gateway</html>', { status: 502 });
    });
    transport.sleep = async () => {};
    await expect(
      transport.aws({
        service: 'sts',
        operation: 'GetCallerIdentity',
        input: {},
        region,
        credentials,
      }),
    ).rejects.toThrow('AWS answered 502');
    expect(calls).toBe(2);

    calls = 0;
    await expect(
      call(async () => {
        calls++;
        return new Response(
          `<ErrorResponse><Error><Code>InvalidClientTokenId</Code><Message>Nope</Message></Error></ErrorResponse>`,
          { status: 403 },
        );
      }),
    ).rejects.toThrow('Nope');
    expect(calls).toBe(1);
  });

  it('refuses a call it has no route for, and an input it would get wrong', async () => {
    const never: typeof fetch = async () => {
      throw new Error('should not be called');
    };
    await expect(
      new WorkerTransport(never).aws({
        service: 'sesv2',
        operation: 'DeleteAccount',
        input: {},
        region,
        credentials,
      }),
    ).rejects.toThrow('unknown AWS operation');
    await expect(
      new WorkerTransport(never).aws({
        service: 'sns',
        operation: 'DeleteTopic',
        input: {},
        region,
        credentials,
      }),
    ).rejects.toThrow('unknown AWS operation');
    await expect(
      new WorkerTransport(never).aws({
        service: 'sns',
        operation: 'CreateTopic',
        input: { Name: 1 },
        region,
        credentials,
      }),
    ).rejects.toThrow('must be a string');
  });

  it('covers every AWS operation the installer calls', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
    const covered = new Set(CASES.map(([service, operation]) => `${service}:${operation}`));
    const root = join(import.meta.dirname, '../src');
    const called = new Set<string>();
    for (const file of walk(root)) {
      if (file.endsWith('fake.ts') || file.endsWith('wizard/aws.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/aws(?:<[^(]*>)?\(\s*'(sesv2|sns|iam|sts)',\s*'(\w+)'/g)) {
        called.add(`${m[1]}:${m[2]}`);
      }
      for (const m of source.matchAll(/service: '(sesv2|sns|iam|sts)',\s*operation: '(\w+)'/g)) {
        called.add(`${m[1]}:${m[2]}`);
      }
    }
    // postdeploy.ts passes the service once and the operation at each call.
    for (const m of readFileSync(join(root, 'steps/postdeploy.ts'), 'utf8').matchAll(
      /aws(?:<\w+>)?\('(\w+)', \{/g,
    )) {
      called.add(`sns:${m[1]}`);
    }
    expect(called.size).toBeGreaterThan(15);
    expect([...called].filter((operation) => !covered.has(operation))).toEqual([]);
  });
});
