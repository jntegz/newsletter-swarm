// Site Studio → Domains: the website's own domain. One domain has four roles (web, the bare-
// domain redirect, email sending and links); the last two live in Sending settings.
import type { CustomHostname, DomainRoles, HostnameRecord } from '@swarm/domain';
import {
  Button,
  Checkbox,
  Dialog,
  ErrorNotice,
  LoadingRows,
  Pill,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError } from '../api/client';
import {
  usePrimaryWebDomain,
  useRefreshWebDomain,
  useRemoveWebDomain,
  useAddWebDomain,
  webDomainsQuery,
} from '../api/site';
import { ReadOnlyNote } from '../site/controls';
import { DNS_PROVIDERS, ROLE_STATUS, planDomain, type RoleStatus } from '../site/helpers';
import { InlineAdd } from '../shell/InlineAdd';
import { Bands, Section, formatDateTime } from './common';
import { CopyButton } from './Sending';
import { useSiteStudio } from './SiteStudio';

export function SiteDomains() {
  const { channel, settings, canAdmin } = useSiteStudio();
  const list = useQuery(webDomainsQuery(channel.id));

  if (list.isPending) return <LoadingRows label="Loading domains" rows={4} />;
  if (list.error) return <ErrorNotice message={list.error.message} />;
  const { domains, hostnames, cnameTarget, available } = list.data;
  const byId = new Map(hostnames.map((h) => [h.id, h]));

  return (
    <Bands>
      <Section
        title="Your domain"
        description={
          <>
            The site is at <span className="font-mono">{settings.url}</span>
            {settings.url !== settings.platformUrl && (
              <>
                {' '}
                and always at <span className="font-mono">{settings.platformUrl}</span>
              </>
            )}
            . Connect a domain you own so readers find it there instead.
          </>
        }
      >
        {!available ? (
          <p className="text-[13.5px] text-sub">
            Custom domains are not available here. This Swarm installation serves sites at their
            platform address only.
          </p>
        ) : (
          <div className="grid gap-4">
            {domains.length === 0 && (
              <p className="text-[13.5px] text-sub">
                No domain connected yet. Add one and you’ll get two DNS records to add at your DNS
                provider.
              </p>
            )}
            {canAdmin ? (
              <AddDomainForm channelId={channel.id} />
            ) : (
              <ReadOnlyNote>An admin connects and removes domains.</ReadOnlyNote>
            )}
          </div>
        )}
      </Section>

      {domains.map((domain) => (
        <DomainCard
          key={domain.domain}
          domain={domain}
          byId={byId}
          cnameTarget={cnameTarget}
          channelId={channel.id}
          admin={canAdmin}
        />
      ))}

      {available && <DnsHelp cnameTarget={cnameTarget} />}
    </Bands>
  );
}

function AddDomainForm({ channelId }: { channelId: string }) {
  const add = useAddWebDomain(channelId);
  const [input, setInput] = useState('');
  const [redirectApex, setRedirectApex] = useState(true);
  const [touched, setTouched] = useState(false);
  const plan = planDomain(input, redirectApex);
  const isWww = plan?.hostname.startsWith('www.') && plan.hostname.split('.').length === 3;
  const error = add.error instanceof ApiError ? add.error : null;
  // A conflict's message says which TXT records prove the name is yours; its details only list them.
  const notice = error && (error.code === 'conflict' || !error.details.length) ? error : null;
  const invalid = notice ? null : error;

  const clear = () => {
    setInput('');
    setRedirectApex(true);
    setTouched(false);
    add.reset();
  };

  return (
    <InlineAdd
      label="Add domain"
      formLabel="Add a web domain"
      pending={add.isPending}
      onCancel={clear}
      onSubmit={(done) => {
        setTouched(true);
        if (!plan) return;
        const { hostname, web } = plan;
        add.mutate(
          { hostname, ...(isWww && redirectApex ? { redirectApex: true } : {}) },
          {
            onSuccess: () => {
              clear();
              done(`Added ${web}. Its DNS records are listed below.`);
            },
          },
        );
      }}
    >
      <TextField
        label="Domain"
        required
        value={input}
        placeholder="example.com"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setInput(e.target.value)}
        className="font-mono text-[13px]"
        hint={
          plan
            ? plan.apex
              ? `${plan.web} will serve the site, and ${plan.apex} will redirect to it.`
              : `${plan.web} will serve the site.`
            : 'Your domain, or a subdomain such as news.example.com.'
        }
        error={
          invalid?.field('hostname') ??
          invalid?.field('redirectApex') ??
          (touched && input && !plan ? 'Enter a domain such as example.com.' : undefined)
        }
      />
      {isWww && (
        <Checkbox
          label={`Also redirect ${plan?.hostname.slice(4)}`}
          hint="Readers who type the bare domain land on the site."
          checked={redirectApex}
          onChange={setRedirectApex}
        />
      )}
      {notice && <ErrorNotice message={notice.message} />}
    </InlineAdd>
  );
}

const ROLE_ROWS: {
  key: 'web' | 'apexRedirect' | 'email' | 'link';
  label: string;
  explain: string;
}[] = [
  { key: 'web', label: 'Website', explain: 'Serves the publication website.' },
  { key: 'apexRedirect', label: 'Root redirect', explain: 'Sends the bare domain to the website.' },
  { key: 'email', label: 'Email sending', explain: 'The From address of posts.' },
  { key: 'link', label: 'Links', explain: 'Branded links in email.' },
];

function StatusPill({ status }: { status: RoleStatus }) {
  const s = ROLE_STATUS[status];
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

function DomainCard({
  domain,
  byId,
  cnameTarget,
  channelId,
  admin,
}: {
  domain: DomainRoles;
  byId: Map<string, CustomHostname>;
  cnameTarget: string;
  channelId: string;
  admin: boolean;
}) {
  const webHosts = [domain.web.id, domain.apexRedirect.id]
    .map((id) => (id ? byId.get(id) : undefined))
    .filter((h): h is CustomHostname => !!h);
  const pending = webHosts.filter((h) => h.status !== 'active');

  return (
    <Section
      title={<span className="font-mono break-all">{domain.domain}</span>}
      description={
        webHosts.length === 0
          ? 'Used for email or links. The website isn’t on it yet.'
          : pending.length
            ? 'Waiting for its DNS records.'
            : 'Active. Keep its DNS records in place.'
      }
      action={webHosts.some((h) => h.isPrimary) ? <Pill tone="brand">Primary</Pill> : undefined}
    >
      <ul className="divide-y divide-line border-b border-line">
        {ROLE_ROWS.map((row) => {
          const role = domain[row.key];
          const host = role.id ? byId.get(role.id) : undefined;
          return (
            <li
              key={row.key}
              className="grid gap-2 py-3 text-[13.5px] first:pt-0 sm:grid-cols-[160px_1fr_auto] sm:items-center"
            >
              <span>
                <b>{row.label}</b>
                <span className="block text-[12px] text-sub">{row.explain}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[12.5px] break-all">{role.hostname ?? '—'}</span>
                <StatusPill status={role.status} />
                {host?.isPrimary && <Pill tone="brand">Primary</Pill>}
              </span>
              <span className="flex flex-wrap gap-1 sm:justify-end">
                {host ? (
                  <HostnameActions host={host} channelId={channelId} admin={admin} />
                ) : row.key === 'email' || row.key === 'link' ? (
                  <Link
                    to="/channels/$channelId/sending"
                    params={{ channelId }}
                    className="btn-quiet"
                  >
                    {role.status === 'not_set_up' ? 'Set up in Sending' : 'Manage in Sending'}
                  </Link>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {webHosts.length > 0 && (
        <div className="pt-4">
          <p className="mb-2 text-[12.5px] text-sub">
            {pending.length
              ? `Add these records at your DNS provider, pointing at ${cnameTarget}. Swarm checks every few minutes for two weeks; the certificate is issued once they resolve.`
              : 'Active. Keep these records in place.'}
          </p>
          <RecordsTable hosts={webHosts} />
          {webHosts.map(
            (h) =>
              h.detail && (
                <p key={h.id} className="mt-2 text-[12.5px] text-danger">
                  {h.hostname}: {h.detail}
                </p>
              ),
          )}
        </div>
      )}
    </Section>
  );
}

function HostnameActions({
  host,
  channelId,
  admin,
}: {
  host: CustomHostname;
  channelId: string;
  admin: boolean;
}) {
  const refresh = useRefreshWebDomain(channelId);
  const primary = usePrimaryWebDomain(channelId);
  const remove = useRemoveWebDomain(channelId);
  const [confirming, setConfirming] = useState(false);
  if (!admin) {
    return host.lastCheckedAt ? (
      <span className="text-[12px] text-sub">Checked {formatDateTime(host.lastCheckedAt)}</span>
    ) : null;
  }
  return (
    <>
      {host.status !== 'active' && (
        <Button
          variant="ghost"
          size="sm"
          loading={refresh.isPending}
          aria-label={`Check ${host.hostname} now`}
          onClick={() => refresh.mutate(host.id)}
        >
          Check now
        </Button>
      )}
      {host.role === 'web' && !host.isPrimary && (
        <Button
          variant="quiet"
          size="sm"
          loading={primary.isPending}
          aria-label={`Make ${host.hostname} the primary domain`}
          onClick={() => primary.mutate(host.id)}
        >
          Make primary
        </Button>
      )}
      <Button
        variant="quiet"
        size="sm"
        aria-label={`Remove ${host.hostname}`}
        onClick={() => setConfirming(true)}
      >
        Remove
      </Button>
      {(refresh.error ?? primary.error) && (
        <p role="alert" className="w-full text-[12.5px] text-danger">
          {(refresh.error ?? primary.error)?.message}
        </p>
      )}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Remove ${host.hostname}?`}
        description={
          host.role === 'web'
            ? 'The site stops answering at this address, and a bare-domain redirect to it is removed too. If it was the primary domain, the next one takes over, or the platform address.'
            : 'The bare domain stops redirecting to the website.'
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(host.id, { onSuccess: () => setConfirming(false) })}
            >
              Remove domain
            </Button>
          </>
        }
      >
        {remove.error && <ErrorNotice message={remove.error.message} />}
      </Dialog>
    </>
  );
}

function RecordsTable({ hosts }: { hosts: CustomHostname[] }) {
  const rows: (HostnameRecord & { host: string })[] = hosts.flatMap((h) =>
    h.records.map((r) => ({ ...r, host: h.hostname })),
  );
  if (!rows.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-left text-[12.5px]">
        <caption className="sr-only">DNS records to add</caption>
        <thead>
          <tr className="table-head">
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              Type
            </th>
            <th scope="col" className="px-2 py-1.5 font-semibold">
              Name
            </th>
            <th scope="col" className="py-1.5 pl-2 font-semibold">
              Target
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((record) => (
            <tr key={`${record.type}-${record.name}`} className="border-t border-line align-top">
              <td className="py-2 pr-3 font-mono">{record.type}</td>
              <td className="px-2 py-2">
                <span className="flex items-start gap-1 font-mono break-all">
                  {record.name}
                  <CopyButton value={record.name} label={`${record.host} record name`} />
                </span>
              </td>
              <td className="py-2 pl-2">
                <span className="flex items-start gap-1 font-mono break-all">
                  {record.value}
                  <CopyButton value={record.value} label={`${record.host} record target`} />
                </span>
                {record.note && (
                  <span className="mt-1 block font-sans text-[12px] text-sub">{record.note}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DnsHelp({ cnameTarget }: { cnameTarget: string }) {
  return (
    <Section
      title="Adding the records at your DNS provider"
      description={
        <>
          Each record points a name at <span className="font-mono">{cnameTarget}</span>. Changes
          usually show up within minutes, sometimes a few hours. The bare domain (example.com) can’t
          take a CNAME at most providers; use an ALIAS or flattened record where offered, or forward
          it to the www address.
        </>
      }
    >
      <div className="divide-y divide-line border-t border-line">
        {DNS_PROVIDERS.map((provider) => (
          <details key={provider.name} className="group py-3">
            <summary className="cursor-pointer text-[13.5px] font-semibold marker:text-sub focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple">
              {provider.name}
            </summary>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[13px] leading-[1.55]">
              {provider.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </details>
        ))}
      </div>
    </Section>
  );
}
