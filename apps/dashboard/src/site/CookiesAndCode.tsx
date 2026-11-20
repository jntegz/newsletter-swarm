// Site Studio → Cookies and code (flag site_custom_code): the cookie popup, and the analytics or other
// code an owner adds to their website. Code the reader must agree to waits until they do.
import {
  CODE_PRESETS,
  trackersIn,
  type CodeCategory,
  type CodePreset,
  type SiteCodeAccess,
  type SiteCodeEntry,
  type SiteConsent,
} from '@swarm/domain';
import { Checkbox, ErrorNotice, SelectField, TextAreaField, TextField } from '@swarm/ui/components';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useUpdateSiteSettings } from '../api/site';
import { Section } from '../pages/common';
import { ChoiceCards, ReadOnlyNote, SaveRow } from './controls';

const PRESET_LABEL: Record<CodePreset, { label: string; value: string; category: CodeCategory }> = {
  google_analytics: {
    label: 'Google Analytics',
    value: 'Measurement ID, like G-ABC123DEF4',
    category: 'analytics',
  },
  google_tag_manager: {
    label: 'Google Tag Manager',
    value: 'Container ID, like GTM-ABC123',
    category: 'analytics',
  },
  plausible: { label: 'Plausible', value: 'Your site’s domain', category: 'analytics' },
  fathom: { label: 'Fathom', value: 'Site ID', category: 'analytics' },
  meta_pixel: { label: 'Meta Pixel', value: 'Pixel ID', category: 'marketing' },
  verification: {
    label: 'Site verification tag',
    value: 'The whole <meta> tag',
    category: 'necessary',
  },
  custom: { label: 'My own code', value: 'HTML and scripts', category: 'analytics' },
};

const CATEGORIES: { value: CodeCategory; label: string }[] = [
  { value: 'analytics', label: 'Analytics: waits for the reader to agree' },
  { value: 'marketing', label: 'Marketing: waits for the reader to agree' },
  { value: 'necessary', label: 'Strictly necessary: always runs' },
];

/** Why code stays off the website's address on this Swarm's domain, and what to do about it. */
function CodeAccessNotice({
  channelId,
  access,
  platformUrl,
  hasCode,
}: {
  channelId: string;
  access: SiteCodeAccess;
  platformUrl: string;
  hasCode: boolean;
}) {
  if (access.platformAddress) return null;
  const address = platformUrl.replace(/^https?:\/\//, '');
  const domains = (
    <Link to="/site/$channelId/domains" params={{ channelId }} className="font-semibold underline">
      add your own domain
    </Link>
  );
  let body: ReactNode;
  if (access.customDomain) {
    body = (
      <>
        Code runs on your own domain only. On {address} it stays off, because that address is on
        this Swarm’s own domain, which every publication here shares.
      </>
    );
  } else if (hasCode && access.reason === 'held') {
    body = (
      <>
        Your code is saved but does not run. The owner of this Swarm let every workspace add code on{' '}
        {address}, but code that was already waiting stays off until they allow this workspace by
        itself in Settings → Instance. Or {domains}, where it always runs.
      </>
    );
  } else if (hasCode) {
    body = (
      <>
        Your code is saved but does not run. {address} is on this Swarm’s own domain, which every
        publication here shares, so code there needs the owner’s permission. To run it, {domains},
        or ask the owner of this Swarm to allow code for this workspace in Settings → Instance.
      </>
    );
  } else {
    body = (
      <>
        Code runs only on your own domain. {address} is on this Swarm’s own domain, which every
        publication here shares, so you can add a tool once you {domains}, or once the owner of this
        Swarm allows code for this workspace. Verification tags work anywhere.
      </>
    );
  }
  return (
    <p
      role={hasCode && !access.customDomain ? 'alert' : undefined}
      className={`rounded-[12px] p-3 text-[13px] ${
        hasCode && !access.customDomain
          ? 'bg-warn-soft text-ink'
          : 'border border-line-app bg-surface-alt'
      }`}
    >
      {body}
    </p>
  );
}

/** Code changed in a way that could change which tools it uses, so a confirmation is asked again. */
const RECONFIRM: (keyof SiteCodeEntry)[] = ['preset', 'value', 'category'];

export function CookiesAndCode({
  channelId,
  consent: initialConsent,
  code: initialCode,
  codeAccess,
  platformUrl,
  admin,
}: {
  channelId: string;
  consent: SiteConsent;
  code: SiteCodeEntry[];
  codeAccess: SiteCodeAccess;
  platformUrl: string;
  admin: boolean;
}) {
  const update = useUpdateSiteSettings(channelId);
  const [saved, setSaved] = useState(false);
  const [consent, setConsent] = useState(initialConsent);
  const [code, setCode] = useState(initialCode);
  const change = <K extends keyof SiteConsent>(key: K, value: SiteConsent[K]) =>
    setConsent((current) => ({ ...current, [key]: value }));
  const changeEntry = (index: number, patch: Partial<SiteCodeEntry>) =>
    setCode((list) =>
      list.map((entry, i) => {
        if (i !== index) return entry;
        const next = { ...entry, ...patch };
        if (RECONFIRM.some((key) => key in patch && patch[key] !== entry[key])) {
          delete next.necessaryConfirmed;
        }
        return next;
      }),
    );
  const waiting = !consent.enabled && code.some((e) => e.category !== 'necessary');
  const fieldError = (path: string) =>
    update.error instanceof ApiError ? update.error.field(path) : undefined;

  const save = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    update.mutate({ consent, code }, { onSuccess: () => setSaved(true) });
  };

  if (!admin) {
    return <ReadOnlyNote>The cookie popup and site code need the admin role.</ReadOnlyNote>;
  }

  return (
    <form onSubmit={save} className="grid max-w-[820px] gap-5" aria-label="Cookies and code">
      <Section
        title="Cookie popup"
        description="Asks readers before anything that needs their agreement runs. Whether your site needs one, and what it must say, is your responsibility."
      >
        <div className="grid gap-4">
          <label className="flex items-center gap-2.5 text-[13.5px] font-semibold">
            <input
              type="checkbox"
              checked={consent.enabled}
              onChange={(e) => change('enabled', e.target.checked)}
              className="size-4 accent-purple"
            />
            Show a cookie popup on my website
          </label>
          {consent.enabled && (
            <>
              <TextAreaField
                label="Message"
                rows={3}
                maxLength={600}
                value={consent.text}
                onChange={(e) => change('text', e.target.value)}
              />
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <TextField
                  label="Accept button"
                  maxLength={40}
                  value={consent.acceptLabel}
                  onChange={(e) => change('acceptLabel', e.target.value)}
                />
                <TextField
                  label="Reject button"
                  maxLength={40}
                  value={consent.rejectLabel}
                  onChange={(e) => change('rejectLabel', e.target.value)}
                  hint="Shown just as prominently as Accept."
                />
              </div>
              <TextField
                label="Cookie policy link"
                maxLength={500}
                value={consent.policyUrl}
                onChange={(e) => change('policyUrl', e.target.value)}
                error={fieldError('consent.policyUrl')}
                hint="A path on your site, like /cookies, or an https address."
              />
              <ChoiceCards
                legend="Position"
                value={consent.position}
                onChange={(value) => change('position', value)}
                options={[
                  { value: 'bottom', title: 'Bottom', description: 'Centred along the bottom.' },
                  {
                    value: 'bottom_left',
                    title: 'Bottom left',
                    description: 'A small corner box.',
                  },
                  { value: 'center', title: 'Centre', description: 'In the middle of the page.' },
                ]}
              />
              <div className="flex flex-wrap gap-6 text-[13px]">
                {(
                  [
                    ['background', 'Background', '#ffffff'],
                    ['textColor', 'Text', '#111111'],
                  ] as const
                ).map(([key, label, fallback]) => (
                  <label key={key} className="flex items-center gap-2.5 font-semibold">
                    <input
                      type="color"
                      value={consent[key] ?? fallback}
                      onChange={(e) => change(key, e.target.value)}
                      className="h-9 w-12 cursor-pointer rounded-control border border-line-control bg-surface p-1"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      </Section>
      <Section
        title="Site code"
        description="Add analytics and other tools. They load from other companies, so readers’ data goes to them. Code stays off gift links, signup steps and account pages, never runs for a signed-in reader, and stays off paywalled posts shown in full (a free read, a gift link), so analytics count visitors who aren’t signed in, on public pages."
      >
        <div className="grid gap-4">
          <CodeAccessNotice
            channelId={channelId}
            access={codeAccess}
            platformUrl={platformUrl}
            hasCode={code.some((entry) => entry.preset !== 'verification')}
          />
          {waiting && (
            <p className="rounded-card-app border border-line-app bg-surface-alt p-3 text-[13px]">
              Turn on the cookie popup, or code marked Analytics or Marketing won’t run: without it,
              readers have no way to agree.
            </p>
          )}
          {code.map((entry, index) => (
            <div key={index} className="grid gap-3 rounded-card-app border border-line-app p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label="Name"
                  required
                  maxLength={60}
                  value={entry.name}
                  onChange={(e) => changeEntry(index, { name: e.target.value })}
                />
                <SelectField
                  label="Tool"
                  value={entry.preset}
                  onChange={(e) => {
                    const preset = e.target.value as CodePreset;
                    changeEntry(index, { preset, category: PRESET_LABEL[preset].category });
                  }}
                  options={CODE_PRESETS.map((preset) => ({
                    value: preset,
                    label: PRESET_LABEL[preset].label,
                  }))}
                />
              </div>
              {entry.preset === 'custom' ? (
                <TextAreaField
                  label="Code"
                  required
                  rows={6}
                  className="font-mono text-[12.5px]"
                  value={entry.value}
                  onChange={(e) => changeEntry(index, { value: e.target.value })}
                  hint="Runs with your site’s full access to the page. Only add code you trust. Scripts that use eval won’t run."
                />
              ) : (
                <TextField
                  label={PRESET_LABEL[entry.preset].value}
                  required
                  value={entry.value}
                  onChange={(e) => changeEntry(index, { value: e.target.value })}
                />
              )}
              {entry.preset !== 'verification' && (
                <SelectField
                  label="When it runs"
                  value={entry.category}
                  onChange={(e) => changeEntry(index, { category: e.target.value as CodeCategory })}
                  options={CATEGORIES}
                />
              )}
              <NecessaryCheck
                entry={entry}
                onConfirm={(necessaryConfirmed) => changeEntry(index, { necessaryConfirmed })}
              />
              <div>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => setCode((list) => list.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() =>
                setCode((list) => [
                  ...list,
                  {
                    name: 'Google Analytics',
                    preset: 'google_analytics',
                    category: 'analytics',
                    value: '',
                  },
                ])
              }
            >
              Add a tool
            </button>
          </div>
        </div>
      </Section>
      {/* SaveRow leaves errors with details to their fields. Only the policy link has one here. */}
      {update.error instanceof ApiError &&
        update.error.details
          .filter((detail) => detail.path !== 'consent.policyUrl')
          .map((detail) => <ErrorNotice key={detail.message} message={detail.message} />)}
      <SaveRow pending={update.isPending} saved={saved} error={update.error} />
    </form>
  );
}

/**
 * Code marked strictly necessary that looks like a tracking tool: asks the owner to confirm, and
 * never moves it on its own. The server refuses the save without the confirmation and logs it.
 */
function NecessaryCheck({
  entry,
  onConfirm,
}: {
  entry: SiteCodeEntry;
  onConfirm: (confirmed: boolean) => void;
}) {
  const tools = entry.category === 'necessary' ? trackersIn(entry) : [];
  if (!tools.length) return null;
  return (
    <div className="grid gap-2.5 rounded-[12px] bg-warn-soft p-3 text-[13px]">
      <p>
        This looks like {tools.join(', ')}. Tools like this usually track readers, so most cookie
        rules say they must wait for the reader to agree. Choose Analytics or Marketing, unless your
        site cannot work without it.
      </p>
      <Checkbox
        label="It is strictly necessary for my site to work"
        hint="Saved with your name in the audit log. It then runs for every reader, before they choose."
        checked={!!entry.necessaryConfirmed}
        onChange={onConfirm}
      />
    </div>
  );
}
