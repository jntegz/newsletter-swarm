/**
 * The AWS calls the installer makes, over plain fetch, for the browser setup: a Worker can't carry
 * the SDK the terminal installer uses. tests/aws-wire.test.ts runs both against the same responses,
 * so this table can't drift from what the installer's steps read.
 */
import { signRequest } from '@swarm/mail/sigv4';
import { parseXml, type XmlElement } from '@swarm/mail/xml';
import type { AwsRequest } from '../transport';

type Input = Record<string, unknown>;
type Call = { method: string; url: string; headers: Record<string, string>; body: string };

const segment = (value: unknown) => encodeURIComponent(String(value));
const without = (input: Input, key: string) =>
  Object.fromEntries(Object.entries(input).filter(([name]) => name !== key));

/** SES v2 is REST and JSON. */
const SESV2: Record<string, (input: Input) => { method: string; path: string; body?: Input }> = {
  GetAccount: () => ({ method: 'GET', path: '/v2/email/account' }),
  PutAccountSuppressionAttributes: (input) => ({
    method: 'PUT',
    path: '/v2/email/account/suppression',
    body: input,
  }),
  PutAccountDetails: (input) => ({
    method: 'POST',
    path: '/v2/email/account/details',
    body: input,
  }),
  GetConfigurationSet: (input) => ({
    method: 'GET',
    path: `/v2/email/configuration-sets/${segment(input.ConfigurationSetName)}`,
  }),
  CreateConfigurationSet: (input) => ({
    method: 'POST',
    path: '/v2/email/configuration-sets',
    body: input,
  }),
  GetConfigurationSetEventDestinations: (input) => ({
    method: 'GET',
    path: `/v2/email/configuration-sets/${segment(input.ConfigurationSetName)}/event-destinations`,
  }),
  CreateConfigurationSetEventDestination: (input) => ({
    method: 'POST',
    path: `/v2/email/configuration-sets/${segment(input.ConfigurationSetName)}/event-destinations`,
    body: without(input, 'ConfigurationSetName'),
  }),
  GetEmailIdentity: (input) => ({
    method: 'GET',
    path: `/v2/email/identities/${segment(input.EmailIdentity)}`,
  }),
  CreateEmailIdentity: (input) => ({ method: 'POST', path: '/v2/email/identities', body: input }),
  PutEmailIdentityMailFromAttributes: (input) => ({
    method: 'PUT',
    path: `/v2/email/identities/${segment(input.EmailIdentity)}/mail-from`,
    body: without(input, 'EmailIdentity'),
  }),
  SendEmail: (input) => ({ method: 'POST', path: '/v2/email/outbound-emails', body: input }),
};

/** SNS, IAM and STS are form-encoded requests with XML answers. IAM has one global endpoint. */
const QUERY = {
  sns: {
    version: '2010-03-31',
    host: (region: string) => `sns.${region}.amazonaws.com`,
    signingRegion: (region: string) => region,
    operations: ['CreateTopic', 'SetTopicAttributes', 'Subscribe', 'ListSubscriptionsByTopic'],
  },
  iam: {
    version: '2010-05-08',
    host: () => 'iam.amazonaws.com',
    signingRegion: () => 'us-east-1',
    operations: ['GetUser', 'CreateUser', 'PutUserPolicy', 'ListAccessKeys', 'CreateAccessKey'],
  },
  sts: {
    version: '2011-06-15',
    host: (region: string) => `sts.${region}.amazonaws.com`,
    signingRegion: (region: string) => region,
    operations: ['GetCallerIdentity'],
  },
} as const;

function unsupported(request: AwsRequest): Error {
  return new Error(`unknown AWS operation ${request.service}:${request.operation}`);
}

async function signed(request: AwsRequest): Promise<Call> {
  if (request.service === 'sesv2') {
    const route = SESV2[request.operation];
    if (!route) throw unsupported(request);
    const { method, path, body } = route(request.input);
    const url = `https://email.${request.region}.amazonaws.com${path}`;
    const payload = body === undefined ? '' : JSON.stringify(body);
    return {
      method,
      url,
      body: payload,
      headers: await signRequest({
        method,
        url,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: payload,
        service: 'ses',
        region: request.region,
        credentials: request.credentials,
      }),
    };
  }
  const service = QUERY[request.service];
  if (!(service.operations as readonly string[]).includes(request.operation)) {
    throw unsupported(request);
  }
  const form = new URLSearchParams({ Action: request.operation, Version: service.version });
  for (const [name, value] of Object.entries(request.input)) {
    // Every Query input the installer sends is flat. Anything else would be silently wrong.
    if (typeof value !== 'string') {
      throw new Error(`AWS input ${name} of ${request.operation} must be a string`);
    }
    form.set(name, value);
  }
  const url = `https://${service.host(request.region)}/`;
  const body = form.toString();
  return {
    method: 'POST',
    url,
    body,
    headers: await signRequest({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
      service: request.service,
      region: service.signingRegion(request.region),
      credentials: request.credentials,
    }),
  };
}

/**
 * An element as the SDK shows it: `member` lists become arrays, and empty elements go away. Values
 * stay strings, unlike the SDK's, because nothing the installer reads here is a number or boolean.
 */
function fromXml(element: XmlElement): unknown {
  if (!element.children.length) return element.text.trim() || undefined;
  if (element.children.every((c) => c.name === 'member')) return element.children.map(fromXml);
  const out: Record<string, unknown> = {};
  for (const child of element.children) {
    const value = fromXml(child);
    if (value !== undefined) out[child.name] = value;
  }
  return out;
}

function queryResult(text: string): unknown {
  const result = parseXml(text, 'AWS response').children.find((c) => c.name.endsWith('Result'));
  return result ? (fromXml(result) ?? {}) : {};
}

/** Named as AWS names it, because the installer's steps decide what to do from the name. */
class AwsError extends Error {
  constructor(
    code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = code;
  }
}

function errorFrom(status: number, headers: Headers, text: string): AwsError {
  const fallback = `AWS answered ${status}`;
  let code = headers.get('x-amzn-errortype')?.split(':')[0];
  let message: string | undefined;
  if (text.trimStart().startsWith('<')) {
    try {
      const fields = fromXml(parseXml(text, 'AWS error')) as {
        Error?: { Code?: string; Message?: string };
      };
      code = fields.Error?.Code ?? code;
      message = fields.Error?.Message;
    } catch {
      // Not the XML AWS documents, such as a gateway's error page: the status says enough.
    }
  } else {
    try {
      const fields = JSON.parse(text) as {
        __type?: string;
        code?: string;
        message?: string;
        Message?: string;
      };
      code = fields.__type?.split('#').pop() ?? fields.code ?? code;
      message = fields.message ?? fields.Message;
    } catch {
      // As above.
    }
  }
  return new AwsError(code ?? `Http${status}`, message ?? fallback, status);
}

const worthRetrying = (status: number) => status === 429 || status >= 500;

/** One AWS call. It retries once on throttling or a server error, as the SDK does. */
export async function callAws<T>(
  request: AwsRequest,
  fetcher: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // Signed afresh each time, since a signature carries the time it was made.
    const call = await signed(request);
    const response = await fetcher(call.url, {
      method: call.method,
      headers: call.headers,
      ...(call.body ? { body: call.body } : {}),
    });
    const text = await response.text();
    if (response.ok) {
      if (request.service !== 'sesv2') return queryResult(text) as T;
      return (text ? JSON.parse(text) : {}) as T;
    }
    if (attempt === 0 && worthRetrying(response.status)) {
      await sleep(1_000);
      continue;
    }
    throw errorFrom(response.status, response.headers, text);
  }
}
