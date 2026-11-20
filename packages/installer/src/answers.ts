import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { array, bool, object, oneOf, optional, str } from './validate';
import { InstallError } from './ui';

/**
 * Answers for a non-interactive run (`--answers file.json`). Every key is optional; a missing
 * answer the run needs is an error that names it. Keys and tokens can also come from the
 * environment: SWARM_DNS_TOKEN, RESEND_API_KEY, MAILGUN_API_KEY, POSTMARK_ACCOUNT_TOKEN, AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY,
 * DEBOUNCE_API_KEY.
 */
const answersShape = object({
  /** Cloudflare account id or name, when the login can see several. */
  account: optional(str),
  /** The zone (domain) on that account, e.g. "example.com". */
  zone: optional(str),
  dnsToken: optional(str),
  /** Keep the DNS token in .swarm/ for `update` and `doctor`. Default false. */
  storeDnsToken: optional(bool),
  owner: optional(object({ name: str, email: str })),
  publication: optional(object({ name: str, slug: str })),
  /** The dashboard's subdomain, and whether the publication lives at the domain itself. */
  addresses: optional(object({ dashboard: optional(str), publicationAtRoot: optional(bool) })),
  mail: optional(
    object({
      provider: oneOf('ses', 'resend', 'mailgun', 'postmark', 'smtp'),
      region: optional(str),
      resendApiKey: optional(str),
      mailgunApiKey: optional(str),
      postmarkAccountToken: optional(str),
      smtp: optional(
        object({
          host: str,
          port: str,
          username: str,
          password: str,
          dkimSelector: str,
          /** Comma-separated domains the server's own bounces authenticate as, if not its own. */
          bounceDomains: optional(str),
        }),
      ),
      awsAccessKeyId: optional(str),
      awsSecretAccessKey: optional(str),
      /** Ask AWS to move the account out of the SES sandbox. Default false. */
      requestProductionAccess: optional(bool),
    }),
  ),
  /** Proxied subdomains to keep away from the Channel-site wildcard route. */
  excludeHosts: optional(array(str)),
  /** For `enable custom-domains`. */
  cfApiToken: optional(str),
  /** For `enable payments`. */
  stripe: optional(object({ secretKey: str, connectClientId: str })),
  /** For `enable google`. */
  google: optional(object({ clientId: str, clientSecret: str })),
  /** For `enable debounce`: the DeBounce API key. */
  debounceApiKey: optional(str),
});
export type Answers = ReturnType<typeof answersShape>;

export async function loadAnswers(path: string): Promise<Answers> {
  // pnpm runs the installer in packages/installer; INIT_CWD is where `pnpm swarm` was typed.
  const vars = process.env;
  const file = resolve(vars.INIT_CWD ?? process.cwd(), path);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new InstallError(
      `Cannot read the answers file ${file}.`,
      'Check the path given to --answers.',
    );
  }
  try {
    return withEnvironment(answersShape(JSON.parse(text), ''));
  } catch (error) {
    throw new InstallError(`The answers file ${file} is not valid: ${(error as Error).message}.`);
  }
}

/** Fills keys from the environment, so secrets need not sit in the answers file. */
function withEnvironment(answers: Answers): Answers {
  const out = { ...answers };
  const vars = process.env;
  if (!out.dnsToken && vars.SWARM_DNS_TOKEN) out.dnsToken = vars.SWARM_DNS_TOKEN;
  if (!out.debounceApiKey && vars.DEBOUNCE_API_KEY) out.debounceApiKey = vars.DEBOUNCE_API_KEY;
  if (out.mail) {
    const mail = { ...out.mail };
    if (mail.provider === 'resend' && !mail.resendApiKey && vars.RESEND_API_KEY) {
      mail.resendApiKey = vars.RESEND_API_KEY;
    }
    if (mail.provider === 'mailgun' && !mail.mailgunApiKey && vars.MAILGUN_API_KEY) {
      mail.mailgunApiKey = vars.MAILGUN_API_KEY;
    }
    if (mail.provider === 'postmark' && !mail.postmarkAccountToken && vars.POSTMARK_ACCOUNT_TOKEN) {
      mail.postmarkAccountToken = vars.POSTMARK_ACCOUNT_TOKEN;
    }
    if (
      mail.provider === 'ses' &&
      !mail.awsAccessKeyId &&
      vars.AWS_ACCESS_KEY_ID &&
      vars.AWS_SECRET_ACCESS_KEY
    ) {
      mail.awsAccessKeyId = vars.AWS_ACCESS_KEY_ID;
      mail.awsSecretAccessKey = vars.AWS_SECRET_ACCESS_KEY;
    }
    out.mail = mail;
  }
  return out;
}
