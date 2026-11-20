import { ChannelSlugSchema } from '@swarm/domain';
import { CloudflareApi, dnsTokenLink, verifyToken, type DnsRecord } from '../cloudflare';
import { accountId, oauthApi, save, saveSecrets, type Ctx } from '../context';
import { hostnamesFor, hostnameTable, type Hostnames } from '../hostnames';
import { sesPolicyOutdated, sesTopicOutdated } from '../ses-policy';
import { MAILGUN_REGIONS, RESEND_REGIONS, type MailProvider } from '../state';
import { InstallError } from '../ui';
import type { Step } from './step';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AWS_REGION = /^[a-z]{2}-[a-z]+-\d$/;

export function slugProblem(slug: string): string | undefined {
  const parsed = ChannelSlugSchema.safeParse(slug);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Not a valid address.';
  // The schema reserves the installer's own labels; staging's take this prefix (hostnames.ts).
  if (slug.startsWith('staging-')) {
    return `"${slug}" is used by Swarm itself. Pick another address.`;
  }
  return undefined;
}

/** Subdomains Swarm itself uses, which the dashboard can't take. */
const TAKEN_LABELS = [
  'forms',
  'link',
  'media',
  'events',
  'sites',
  'mail',
  'unsubscribe',
  'dmarc',
  'www',
];

export function dashboardProblem(label: string): string | undefined {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    return 'Use lowercase letters, numbers and dashes, with no dots.';
  }
  if (TAKEN_LABELS.includes(label)) return `"${label}" is used by Swarm itself. Pick another.`;
  return undefined;
}

export const suggestSlug = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'news';

async function pickZone(ctx: Ctx) {
  const zones = await ctx.ui.task('Listing your domains', () =>
    oauthApi(ctx).list<{ id: string; name: string; status: string }>(
      '/zones',
      { 'account.id': accountId(ctx) },
      50,
    ),
  );
  if (zones.length === 0) {
    throw new InstallError(
      'This Cloudflare account has no domains.',
      'Add your domain to Cloudflare first (Websites > Add a domain), then run `pnpm swarm` again.',
    );
  }
  const wanted = ctx.answers.zone ?? ctx.state.zone?.name;
  let zone = wanted ? zones.find((z) => z.name === wanted) : undefined;
  if (wanted && !zone) {
    throw new InstallError(
      `The domain ${wanted} is not on this Cloudflare account.`,
      'Pick one of: ' + zones.map((z) => z.name).join(', '),
    );
  }
  if (!zone) {
    if (!ctx.interactive)
      throw new InstallError(
        'No domain was chosen.',
        'Add "zone": "example.com" to the answers file.',
      );
    const id = await ctx.ui.prompts.select({
      message:
        'Which domain should Swarm use? It gets a few subdomains; your main site is not touched.',
      options: zones.map((z) => ({
        value: z.id,
        label: z.name,
        ...(z.status !== 'active' ? { hint: z.status } : {}),
      })),
    });
    zone = zones.find((z) => z.id === id);
  }
  if (!zone) throw new InstallError('No domain was chosen.');
  if (zone.status && zone.status !== 'active') {
    ctx.ui.warn(
      `${zone.name} is "${zone.status}" on Cloudflare. Its nameservers must point to Cloudflare before the install can work.`,
    );
  }
  ctx.state.zone = { id: zone.id, name: zone.name };
  return zone;
}

async function confirmHostnames(ctx: Ctx, h: Hostnames) {
  const width = Math.max(...hostnameTable(h).map(([host]) => host.length));
  ctx.ui.note(
    'These addresses will be set up',
    hostnameTable(h)
      .map(([host, use]) => `${host.padEnd(width)}  ${use}`)
      .join('\n'),
  );
  if (ctx.env === 'staging') {
    ctx.ui.warn(
      `Publication websites are not set up on staging: the *.${h.zone} wildcard belongs to production. Use a separate domain for a staging that needs them.`,
    );
  }
  if (ctx.interactive && !ctx.yes) {
    const ok = await ctx.ui.prompts.confirm({
      message: 'Continue with these addresses?',
      initialValue: true,
    });
    if (!ok)
      throw new InstallError(
        'Stopped before creating anything.',
        'Pick another domain by running `pnpm swarm` again.',
      );
  }
}

async function dnsToken(ctx: Ctx) {
  let token = ctx.answers.dnsToken ?? ctx.session.dnsToken ?? ctx.secrets.dnsToken;
  if (!token) {
    if (!ctx.interactive)
      throw new InstallError(
        'No DNS token was given.',
        'Add "dnsToken" to the answers file or set SWARM_DNS_TOKEN.',
      );
    ctx.ui.note(
      'A DNS token',
      [
        'Swarm adds its DNS records with a token that can only edit DNS. It is used during this install',
        'and is not given to any worker. Open this link, check the permissions, and create the token:',
        '',
        dnsTokenLink(),
        '',
        'Permissions: Zone > DNS > Edit, Zone > Zone > Read, Zone > Workers Routes > Edit,',
        'Zone > Zone Settings > Edit. Zone resources: your domain (or all zones).',
      ].join('\n'),
    );
    token = await ctx.ui.prompts.password({
      message: 'Paste the DNS token',
      validate: (v) => (v.length < 20 ? 'That looks too short for a Cloudflare token.' : undefined),
    });
  }
  await ctx.ui.task('Checking the DNS token', () =>
    verifyToken(new CloudflareApi(ctx.t, token, 'DNS token')),
  );
  ctx.session.dnsToken = token;
  if (!ctx.secrets.dnsToken) {
    const keep =
      ctx.answers.storeDnsToken ??
      (ctx.interactive && !ctx.yes
        ? await ctx.ui.prompts.confirm({
            message:
              'Keep the DNS token in .swarm/ so `update` and `doctor` can fix DNS later? (You can paste it again instead.)',
            initialValue: false,
          })
        : false);
    if (keep) {
      ctx.secrets.dnsToken = token;
      await saveSecrets(ctx);
    }
  }
}

/** Proxied subdomains that the *.D/* route would catch once it exists. */
export function caughtByWildcard(records: DnsRecord[], h: Hostnames): string[] {
  const ours = new Set([h.app, h.forms, h.link, h.media, h.events, h.sites, `*.${h.zone}`]);
  const names = records
    .filter((r) => r.proxied && ['A', 'AAAA', 'CNAME'].includes(r.type))
    .map((r) => r.name)
    .filter((name) => name !== h.zone && name.endsWith(`.${h.zone}`) && !ours.has(name))
    // The wildcard covers one level only.
    .filter((name) => !name.slice(0, -h.zone.length - 1).includes('.'));
  return [...new Set(names)].sort();
}

async function exclusions(ctx: Ctx, h: Hostnames) {
  if (!h.wildcard) return [];
  const cf = new CloudflareApi(ctx.t, ctx.session.dnsToken as string, 'DNS token');
  const records = await ctx.ui.task(
    'Looking for subdomains the publication websites would catch',
    () => cf.list<DnsRecord>(`/zones/${ctx.state.zone?.id}/dns_records`, {}, 500),
  );
  const caught = caughtByWildcard(records, h);
  if (caught.length === 0) return [];
  if (ctx.answers.excludeHosts)
    return ctx.answers.excludeHosts.filter((host) => caught.includes(host));
  ctx.ui.warn(
    `These proxied subdomains would start reaching Swarm's website worker through the *.${h.zone}/* route: ${caught.join(', ')}.`,
  );
  if (!ctx.interactive || ctx.yes) {
    ctx.ui.info('Adding an exclusion route for each, so they keep working as they do now.');
    return caught;
  }
  return ctx.ui.prompts.multiselect({
    message: 'Keep these subdomains as they are? (An exclusion route sends them past Swarm.)',
    options: caught.map((host) => ({ value: host, label: host })),
    initialValues: caught,
  });
}

async function ask(
  ctx: Ctx,
  question: string,
  validate: (v: string) => string | undefined,
  initialValue?: string,
) {
  if (!ctx.interactive)
    throw new InstallError(`Missing answer: ${question}`, 'Add it to the answers file.');
  return ctx.ui.prompts.text({
    message: question,
    validate,
    ...(initialValue ? { initialValue } : {}),
  });
}

async function people(ctx: Ctx) {
  const saved = ctx.state.choices;
  const ownerAnswer = ctx.answers.owner ?? saved?.owner;
  const owner = ownerAnswer ?? {
    name: await ask(ctx, 'Your name (the owner of this Swarm)', (v) =>
      v ? undefined : 'Enter a name.',
    ),
    email: await ask(ctx, 'Your email address (you sign in with it)', (v) =>
      EMAIL.test(v) ? undefined : 'Enter an email address.',
    ),
  };
  if (!EMAIL.test(owner.email)) throw new InstallError(`"${owner.email}" is not an email address.`);
  const pubAnswer = ctx.answers.publication ?? saved?.publication;
  let publication = pubAnswer;
  if (!publication) {
    const name = await ask(ctx, 'Name of your first publication', (v) =>
      v && v.length <= 80 ? undefined : 'Enter a name of up to 80 characters.',
    );
    const slug = await ask(
      ctx,
      `Its web address: <address>.${ctx.state.zone?.name}`,
      (v) => slugProblem(v),
      suggestSlug(name),
    );
    publication = { name, slug };
  }
  const problem = slugProblem(publication.slug);
  if (problem) throw new InstallError(`The publication address "${publication.slug}": ${problem}`);
  return {
    owner: { name: owner.name.slice(0, 80), email: owner.email.toLowerCase() },
    publication,
  };
}

export async function mailChoice(ctx: Ctx) {
  const saved = ctx.state.choices?.mail;
  const answer = ctx.answers.mail;
  let provider: MailProvider | undefined = answer?.provider ?? saved?.provider;
  if (!provider) {
    if (!ctx.interactive)
      throw new InstallError(
        'No mail provider was chosen.',
        'Add "mail": {"provider": "resend"} to the answers file.',
      );
    provider = await ctx.ui.prompts.select<MailProvider>({
      message: 'How should Swarm send email?',
      options: [
        {
          value: 'resend',
          label: 'Resend',
          hint: 'quick start: one API key; free for 3,000 emails a month',
        },
        {
          value: 'ses',
          label: 'Amazon SES',
          hint: 'cheapest at volume; needs an AWS account and leaving the SES sandbox',
        },
        {
          value: 'mailgun',
          label: 'Mailgun',
          hint: 'one API key, with US or EU data storage',
        },
        {
          value: 'postmark',
          label: 'Postmark',
          hint: 'one account token; new accounts need Postmark to approve them',
        },
        {
          value: 'smtp',
          label: 'Your own mail server (SMTP)',
          hint: 'advanced: no spam complaint reports unless your server sends them',
        },
      ],
    });
  }
  let region = answer?.region ?? saved?.region;
  if (!region) {
    if (provider === 'resend') {
      region = ctx.interactive
        ? await ctx.ui.prompts.select({
            message: 'Resend region',
            options: RESEND_REGIONS.map((r) => ({ value: r as string, label: r })),
            initialValue: 'us-east-1',
          })
        : 'us-east-1';
    } else if (provider === 'postmark') {
      region = 'us';
    } else if (provider === 'smtp') {
      region = 'none';
    } else if (provider === 'mailgun') {
      region = ctx.interactive
        ? await ctx.ui.prompts.select({
            message: 'Mailgun region (the one your account is in)',
            options: MAILGUN_REGIONS.map((r) => ({ value: r as string, label: r.toUpperCase() })),
            initialValue: 'us',
          })
        : 'us';
    } else {
      region = ctx.interactive
        ? await ctx.ui.prompts.text({
            message: 'AWS region for SES',
            initialValue: 'eu-west-1',
            validate: (v) => (AWS_REGION.test(v) ? undefined : 'A region such as eu-west-1.'),
          })
        : 'eu-west-1';
    }
  }
  if (provider === 'resend' && !(RESEND_REGIONS as readonly string[]).includes(region)) {
    throw new InstallError(
      `Resend has no region "${region}".`,
      `Use one of ${RESEND_REGIONS.join(', ')}.`,
    );
  }
  if (provider === 'mailgun' && !(MAILGUN_REGIONS as readonly string[]).includes(region)) {
    throw new InstallError(
      `Mailgun has no region "${region}".`,
      `Use one of ${MAILGUN_REGIONS.join(', ')}.`,
    );
  }
  if (provider === 'ses' && !AWS_REGION.test(region))
    throw new InstallError(`"${region}" is not an AWS region.`);

  if (provider === 'resend') {
    const key = answer?.resendApiKey ?? ctx.secrets.resendApiKey;
    if (key) ctx.secrets.resendApiKey = key;
    else if (!ctx.interactive)
      throw new InstallError(
        'No Resend API key was given.',
        'Add "mail.resendApiKey" or set RESEND_API_KEY.',
      );
    else {
      ctx.ui.info(
        'Create an API key with Full access at https://resend.com/api-keys. The workers send with it.',
      );
      ctx.secrets.resendApiKey = await ctx.ui.prompts.password({
        message: 'Paste the Resend API key',
        validate: (v) => (v.startsWith('re_') ? undefined : 'Resend keys start with re_.'),
      });
    }
    await saveSecrets(ctx);
  } else if (provider === 'mailgun') {
    const key = answer?.mailgunApiKey ?? ctx.secrets.mailgunApiKey;
    if (key) ctx.secrets.mailgunApiKey = key;
    else if (!ctx.interactive)
      throw new InstallError(
        'No Mailgun API key was given.',
        'Add "mail.mailgunApiKey" or set MAILGUN_API_KEY.',
      );
    else {
      ctx.ui.info(
        'Copy the Private API key from Account Settings > API Keys in Mailgun. A domain sending key is not enough, because the workers also add domains.',
      );
      ctx.secrets.mailgunApiKey = await ctx.ui.prompts.password({
        message: 'Paste the Mailgun API key',
        validate: (v) => (v.length >= 16 ? undefined : 'That looks too short.'),
      });
    }
    await saveSecrets(ctx);
  } else if (provider === 'postmark') {
    const key = answer?.postmarkAccountToken ?? ctx.secrets.postmarkAccountToken;
    if (key) ctx.secrets.postmarkAccountToken = key;
    else if (!ctx.interactive)
      throw new InstallError(
        'No Postmark account token was given.',
        'Add "mail.postmarkAccountToken" or set POSTMARK_ACCOUNT_TOKEN.',
      );
    else {
      ctx.ui.info(
        'Copy the Account API token from the API Tokens page in Postmark. Swarm uses it to create a server and add domains.',
      );
      ctx.secrets.postmarkAccountToken = await ctx.ui.prompts.password({
        message: 'Paste the Postmark account token',
        validate: (v) => (v.length >= 16 ? undefined : 'That looks too short.'),
      });
    }
    await saveSecrets(ctx);
  } else if (provider === 'ses' && !ctx.session.awsAdmin) {
    // A saved install needs the key again only to change something at AWS: the workers' policy, the
    // topic, or a subscription that never confirmed. A scripted run without a key carries on, and
    // the mail step warns.
    const ses = ctx.state.ses;
    const repairs =
      ses && (sesPolicyOutdated(ses) || sesTopicOutdated(ses) || !ses.subscriptionConfirmed);
    if (!ses || (ctx.interactive && repairs)) await askAwsAdmin(ctx);
  }
  const smtp = provider === 'smtp' ? await smtpChoice(ctx) : undefined;
  return { provider, region, ...(smtp ? { smtp } : {}) };
}

async function smtpChoice(ctx: Ctx) {
  const answer = ctx.answers.mail?.smtp;
  const saved = ctx.state.choices?.mail.smtp;
  if (!answer && !saved && !ctx.interactive) {
    throw new InstallError(
      'No mail server was given.',
      'Add "mail.smtp" with host, port, username, password and dkimSelector.',
    );
  }
  const ask = async (
    message: string,
    initialValue: string,
    validate: (v: string) => string | undefined,
  ) => (ctx.interactive ? ctx.ui.prompts.text({ message, initialValue, validate }) : initialValue);
  const host =
    answer?.host ??
    saved?.host ??
    (await ask('Mail server address', '', (v) =>
      /^[A-Za-z0-9.-]+$/.test(v) ? undefined : 'An address such as mail.example.com.',
    ));
  const port =
    answer?.port ??
    saved?.port ??
    (await ask('Port (465 or 587)', '587', (v) =>
      /^(?!25$)[1-9]\d{0,4}$/.test(v) ? undefined : 'Use 465 or 587. Cloudflare blocks port 25.',
    ));
  if (!/^(?!25$)[1-9]\d{0,4}$/.test(port)) {
    throw new InstallError(
      `Swarm can't use port ${port}.`,
      'Use port 465 or 587 on your mail server. Cloudflare blocks port 25.',
    );
  }
  const dkimSelector =
    answer?.dkimSelector ??
    saved?.dkimSelector ??
    (await ask('DKIM selector your server signs with', 'default', (v) =>
      /^[A-Za-z0-9._-]+$/.test(v) ? undefined : 'A selector such as default.',
    ));
  // Optional, and asked once: a saved server keeps what was chosen, even nothing.
  const bounceDomains = (
    answer
      ? answer.bounceDomains
      : saved
        ? saved.bounceDomains
        : await ask(
            'Domains your server signs its bounces as, comma-separated (blank for its own)',
            '',
            (v) => (isDomainList(v) ? undefined : 'Domains such as messagingengine.com.'),
          )
  )?.trim();
  if (bounceDomains && !isDomainList(bounceDomains)) {
    throw new InstallError(
      `"${bounceDomains}" isn't a list of domains.`,
      'Give mail.smtp.bounceDomains as domains separated by commas, such as messagingengine.com.',
    );
  }
  if (answer) ctx.secrets.smtp = { username: answer.username, password: answer.password };
  else if (!ctx.secrets.smtp) {
    const username = await ask('Mail server username', '', (v) => (v ? undefined : 'Required.'));
    const password = await ctx.ui.prompts.password({
      message: 'Mail server password',
      validate: (v) => (v ? undefined : 'Required.'),
    });
    ctx.secrets.smtp = { username, password };
  }
  await saveSecrets(ctx);
  return { host, port, dkimSelector, ...(bounceDomains ? { bounceDomains } : {}) };
}

/** Blank, or domains separated by commas, as the events worker reads SMTP_BOUNCE_DOMAINS. */
const isDomainList = (value: string) =>
  value.trim() === '' ||
  value.split(',').every((domain) => /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i.test(domain.trim()));

/** The AWS admin key is held in memory for this run only and never written anywhere. */
export async function askAwsAdmin(ctx: Ctx) {
  const answer = ctx.answers.mail;
  if (answer?.awsAccessKeyId && answer.awsSecretAccessKey) {
    ctx.session.awsAdmin = {
      accessKeyId: answer.awsAccessKeyId,
      secretAccessKey: answer.awsSecretAccessKey,
    };
    return;
  }
  if (!ctx.interactive) {
    throw new InstallError(
      'SES setup needs an AWS key.',
      'Add mail.awsAccessKeyId and mail.awsSecretAccessKey, or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.',
    );
  }
  ctx.ui.note(
    'An AWS key for the setup',
    [
      'Swarm creates the SES setup with an AWS key that can manage SES, SNS and IAM (an admin key works).',
      'It is used only during this run and is never saved. The workers get their own key,',
      'limited to sending mail.',
    ].join('\n'),
  );
  const accessKeyId = await ctx.ui.prompts.text({
    message: 'AWS access key id',
    validate: (v) => (/^A[A-Z0-9]{15,}$/.test(v) ? undefined : 'Access key ids look like AKIA…'),
  });
  const secretAccessKey = await ctx.ui.prompts.password({
    message: 'AWS secret access key',
    validate: (v) => (v.length >= 30 ? undefined : 'That looks too short.'),
  });
  ctx.session.awsAdmin = { accessKeyId, secretAccessKey };
}

export const prompts: Step = {
  id: 'prompts',
  title: 'A few questions',
  async run(ctx) {
    const zone = await pickZone(ctx);
    const addresses = ctx.answers.addresses ?? ctx.state.choices?.addresses;
    const problem = addresses?.dashboard ? dashboardProblem(addresses.dashboard) : undefined;
    if (problem)
      throw new InstallError(`The dashboard address "${addresses?.dashboard}": ${problem}`);
    const h = hostnamesFor(zone.name, ctx.env, addresses);
    await confirmHostnames(ctx, h);
    await dnsToken(ctx);
    const excludeHosts = await exclusions(ctx, h);
    const { owner, publication } = await people(ctx);
    if (!h.root && h.app === `${publication.slug}.${zone.name}`) {
      throw new InstallError(
        `The dashboard and the publication can't both use ${h.app}.`,
        'Pick a different address for one of them.',
      );
    }
    const mail = await mailChoice(ctx);
    ctx.state.choices = {
      owner,
      publication,
      mail,
      excludeHosts,
      ...(addresses ? { addresses } : {}),
    };
    await save(ctx);
    ctx.ui.info(
      'Payments (Stripe), Google sign-in and custom domains start switched off. Turn them on later with `pnpm swarm enable payments|google|custom-domains`.',
    );
  },
};
