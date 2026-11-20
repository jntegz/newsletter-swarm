import { applyEdits, modify, parse, type FormattingOptions } from 'jsonc-parser';
import { hostnamesFor, routesFor, type Hostnames } from '../hostnames';
import { LINK_WORKERS } from '../keys';
import type { EnvName, Worker } from '../paths';
import type { Features, MailProvider, State } from '../state';
import { InstallError } from '../ui';
import placeholders from './placeholders.json';

export interface RenderInput {
  env: EnvName;
  hostnames: Hostnames;
  d1Id: string;
  kvId: string;
  turnstileSiteKey: string;
  mail: {
    provider: MailProvider;
    region: string;
    topicArn?: string | undefined;
    drainingTopicArn?: string | undefined;
    smtp?:
      | { host: string; port: string; dkimSelector: string; bounceDomains?: string | undefined }
      | undefined;
  };
  features: Features;
  /** How the vault seals (state.vault). Left out: legacy writes, legacy opening on. */
  vault?: { writeFormat: 'legacy' | 'v3'; legacyOpen: boolean } | undefined;
  /**
   * How link-key holders sign (state.linkKeys): v1 until the cutover's second pass, then v2 since
   * `cutoffAt`. Left out: v1, as an install from before per-family keys.
   */
  links?: { signing: 'v1' | 'v2'; cutoffAt?: number | undefined } | undefined;
}

export const configurationSet = (env: EnvName, kind: 'broadcasts' | 'transactional' | 'direct') =>
  `swarm-${env}-${kind}`;

/** Builds the render input from saved state, or explains what is still missing. */
export function renderInput(state: State): RenderInput {
  const { zone, choices, turnstile } = state;
  const { d1, kv } = state.resources;
  const sesMissing = choices?.mail.provider === 'ses' && !state.ses;
  if (!zone || !choices || !d1 || !kv || !turnstile || sesMissing) {
    const missing = [
      !zone && 'the zone',
      !choices && 'your answers',
      !d1 && 'the database',
      !kv && 'the KV namespace',
      !turnstile && 'the Turnstile widget',
      sesMissing && 'the SES setup',
    ].filter((item): item is string => !!item);
    throw new InstallError(
      `The configs cannot be written yet: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`,
      'Run `pnpm swarm` (install) first.',
    );
  }
  return {
    env: state.env,
    hostnames: hostnamesFor(zone.name, state.env, choices.addresses),
    d1Id: d1.id,
    kvId: kv.id,
    turnstileSiteKey: turnstile.sitekey,
    mail: {
      provider: choices.mail.provider,
      region: choices.mail.region,
      topicArn: state.ses?.topicArn,
      smtp: choices.mail.smtp,
      // SES's late complaints still arrive from this topic while it's the service being left.
      drainingTopicArn:
        state.mailChange?.from.provider === 'ses' &&
        (state.mailChange.phase === 'cutting_over' || state.mailChange.phase === 'cut_over')
          ? state.ses?.topicArn
          : undefined,
    },
    features: state.features,
    vault: state.vault,
    links:
      state.linkKeys?.mode === 'v2'
        ? { signing: 'v2', cutoffAt: state.linkKeys.cutoffAt }
        : { signing: 'v1' },
  };
}

type Vars = Record<string, string | undefined>;

/** Mail variables for a worker that sends; undefined removes a key the template has. */
function mailVars(input: RenderInput, configSet: 'broadcasts' | 'transactional'): Vars {
  const ses = input.mail.provider === 'ses';
  const mailgun = input.mail.provider === 'mailgun';
  return {
    MAIL_ADAPTER: input.mail.provider,
    // With Resend, AWS_REGION names the Resend region. The other services don't use it, but the
    // workers still require a value here.
    AWS_REGION: mailgun
      ? input.mail.region === 'eu'
        ? 'eu-west-1'
        : 'us-east-1'
      : input.mail.provider === 'postmark' || input.mail.provider === 'smtp'
        ? 'us-east-1'
        : input.mail.region,
    MAILGUN_REGION: mailgun ? input.mail.region : undefined,
    SMTP_HOST: input.mail.smtp?.host,
    SMTP_PORT: input.mail.smtp?.port,
    SMTP_DKIM_SELECTOR: input.mail.smtp?.dkimSelector,
    SES_CONFIGURATION_SET: ses ? configurationSet(input.env, configSet) : undefined,
  };
}

/** LINK_SIGNING_MODE and LINK_LEGACY_CUTOFF (@swarm/tokens linkModeFromEnv), for link-key holders. */
function linkVars(worker: Worker, input: RenderInput): Vars {
  if (!LINK_WORKERS.includes(worker)) return {};
  const links = input.links ?? { signing: 'v1' };
  if (links.signing === 'v2' && links.cutoffAt === undefined) {
    throw new InstallError(
      'The switch to per-link keys has no cutoff time recorded.',
      'Run `pnpm swarm update` again; it records one.',
    );
  }
  return {
    LINK_SIGNING_MODE: links.signing,
    LINK_LEGACY_CUTOFF: links.signing === 'v2' ? String(links.cutoffAt) : undefined,
  };
}

/** Every variable the installer owns, per worker. Keys it does not list are left as they are. */
export function varsFor(worker: Worker, input: RenderInput): Vars {
  return { ...ownVars(worker, input), ...linkVars(worker, input) };
}

function ownVars(worker: Worker, input: RenderInput): Vars {
  const h = input.hostnames;
  const https = (host: string) => `https://${host}`;
  const ses = input.mail.provider === 'ses';
  const linkHostnames = input.features.customDomains ? 'cloudflare' : 'off';
  const webHostnames = input.features.customDomains ? 'cloudflare' : 'off';
  const payments = input.features.payments ? 'stripe' : 'off';
  const base = { ENVIRONMENT: input.env };
  switch (worker) {
    case 'api':
      return {
        ...base,
        APP_ORIGIN: https(h.app),
        MEDIA_ORIGIN: https(h.media),
        CAPTURE_ORIGIN: https(h.forms),
        ...mailVars(input, 'transactional'),
        MAIL_FROM: h.mailFrom,
        SES_DIRECT_CONFIGURATION_SET: ses ? configurationSet(input.env, 'direct') : undefined,
        SES_EVENT_TOPIC_ARN: ses ? input.mail.topicArn : undefined,
        DNS_RESOLVER: 'doh',
        LINK_HOSTNAMES: linkHostnames,
        TRACK_ORIGIN: https(h.link),
        PLATFORM_MAIL_DOMAIN: h.mail,
        UNSUBSCRIBE_MAIL_DOMAIN: h.unsubscribe,
        DMARC_MAIL_DOMAIN: h.dmarc,
        PLATFORM_SITE_DOMAIN: h.siteDomain,
        SITE_SCHEME: 'https',
        WEB_HOSTNAMES: webHostnames,
        SITE_FALLBACK_ORIGIN: h.sites,
        TURNSTILE_SITE_KEY: input.turnstileSiteKey,
        PAYMENTS: payments,
      };
    case 'send':
      return {
        ...base,
        MEDIA_ORIGIN: https(h.media),
        TRACK_ORIGIN: https(h.link),
        CAPTURE_ORIGIN: https(h.forms),
        PLATFORM_MAIL_DOMAIN: h.mail,
        UNSUBSCRIBE_MAIL_DOMAIN: h.unsubscribe,
        PLATFORM_SITE_DOMAIN: h.siteDomain,
        SITE_SCHEME: 'https',
        ...mailVars(input, 'broadcasts'),
        SES_EVENT_TOPIC_ARN: ses ? input.mail.topicArn : undefined,
        DNS_RESOLVER: 'doh',
        LINK_HOSTNAMES: linkHostnames,
      };
    case 'jobs':
      return {
        ...base,
        APP_ORIGIN: https(h.app),
        MEDIA_ORIGIN: https(h.media),
        CAPTURE_ORIGIN: https(h.forms),
        PLATFORM_SITE_DOMAIN: h.siteDomain,
        SITE_SCHEME: 'https',
        WEB_HOSTNAMES: webHostnames,
        SITE_FALLBACK_ORIGIN: h.sites,
        PAYMENTS: payments,
        ...mailVars(input, 'transactional'),
        PLATFORM_MAIL_DOMAIN: h.mail,
        // The daily re-check of verified SSO domains, like the api's.
        DNS_RESOLVER: 'doh',
      };
    case 'capture':
      return {
        ...base,
        PLATFORM_SITE_DOMAIN: h.siteDomain,
        SITE_SCHEME: 'https',
        CAPTURE_ORIGIN: https(h.forms),
        PLATFORM_MAIL_DOMAIN: h.mail,
        ...mailVars(input, 'transactional'),
        DNS_RESOLVER: 'doh',
        LINK_HOSTNAMES: 'off',
        PAYMENTS: payments,
        TURNSTILE_SITE_KEY: input.turnstileSiteKey,
      };
    case 'site':
      return {
        ...base,
        PLATFORM_SITE_DOMAIN: h.siteDomain,
        SITE_SCHEME: 'https',
        MEDIA_ORIGIN: https(h.media),
        CAPTURE_ORIGIN: https(h.forms),
        // The dashboard frames design previews (/_swarm/preview).
        APP_ORIGIN: https(h.app),
        PLATFORM_MAIL_DOMAIN: h.mail,
        ...mailVars(input, 'transactional'),
        DNS_RESOLVER: 'doh',
        LINK_HOSTNAMES: 'off',
        PAYMENTS: payments,
        TURNSTILE_SITE_KEY: input.turnstileSiteKey,
      };
    case 'events':
      return {
        ...base,
        // Optional with Resend; SES events are only accepted from these topics.
        SNS_TOPIC_ARNS: ses ? input.mail.topicArn : input.mail.drainingTopicArn,
        DMARC_MAIL_DOMAIN: h.dmarc,
        // A mailed-in bounce the relay signed counts as hard (SMTP installs).
        SMTP_HOST: input.mail.smtp?.host,
        // And one signed as these domains, for a relay whose bounces aren't under its host's.
        SMTP_BOUNCE_DOMAINS: input.mail.smtp?.bounceDomains,
      };
    case 'vault':
      return {
        ...base,
        VAULT_WRITE_FORMAT: input.vault?.writeFormat ?? 'legacy',
        VAULT_LEGACY_OPEN: (input.vault?.legacyOpen ?? true) ? 'on' : 'off',
      };
    case 'track':
    case 'realtime':
      return base;
  }
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

type Json = Record<string, unknown>;

function envBlock(text: string, env: EnvName, worker: Worker): Json {
  const config = parse(text) as { env?: Record<string, Json> } | undefined;
  const block = config?.env?.[env];
  if (!block) {
    throw new InstallError(
      `workers/${worker}/wrangler.jsonc has no "${env}" block.`,
      'Restore the file from git: git checkout -- workers/' + worker + '/wrangler.jsonc',
    );
  }
  return block;
}

/**
 * Renders one worker's config: only env.<env> changes, through jsonc-parser edits, so comments
 * and every other block stay exactly as committed. Same input, same output.
 */
export function renderWorkerConfig(worker: Worker, template: string, input: RenderInput): string {
  const formattingOptions: FormattingOptions = {
    tabSize: 2,
    insertSpaces: true,
    eol: detectEol(template),
  };
  const block = envBlock(template, input.env, worker);
  const at = (...path: (string | number)[]) => ['env', input.env, ...path];
  let text = template;
  const set = (path: (string | number)[], value: unknown) => {
    text = applyEdits(text, modify(text, path, value, { formattingOptions }));
  };

  const vars = varsFor(worker, input);
  const existing = (block.vars ?? {}) as Json;
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      if (key in existing) set(at('vars', key), undefined);
    } else {
      set(at('vars', key), value);
    }
  }

  const d1 = (block.d1_databases ?? []) as Json[];
  d1.forEach((_, i) => set(at('d1_databases', i, 'database_id'), input.d1Id));
  const kv = (block.kv_namespaces ?? []) as Json[];
  kv.forEach((_, i) => set(at('kv_namespaces', i, 'id'), input.kvId));

  const routes = routesFor(worker, input.hostnames, input.features);
  if (routes.length > 0) set(at('routes'), routes);
  else if ('routes' in block) set(at('routes'), undefined);

  return text;
}

/** Shared with scripts/check-provisioned.mjs, so the manual path refuses the same values. */
const PLACEHOLDERS: RegExp[] = placeholders.patterns.map((source) => new RegExp(source));

/** Throws when the rendered env block still has a template placeholder in it. */
export function assertNoPlaceholders(worker: Worker, rendered: string, env: EnvName): void {
  const block = JSON.stringify(envBlock(rendered, env, worker));
  const found = PLACEHOLDERS.map((pattern) =>
    pattern.exec(block)?.[0]?.replace(/^[^a-z0-9]/, ''),
  ).filter((match): match is string => !!match);
  if (found.length > 0) {
    throw new InstallError(
      `workers/${worker}: the ${env} config still contains ${found.join(', ')}.`,
      'A value the installer does not know about was added to wrangler.jsonc. Update packages/installer/src/config/render.ts.',
    );
  }
}
