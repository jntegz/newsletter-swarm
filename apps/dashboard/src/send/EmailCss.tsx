// Settings → Sending → Email CSS (flag custom_email_css): the Channel's own stylesheet for its
// emails. The lint runs as the operator types (the same lintEmailCss the API runs on save), so
// errors show before saving; the server refuses them again either way.
import type { Channel } from '@swarm/domain';
import { EMAIL_CSS_CLASSES, EMAIL_CSS_MAX_BYTES, lintEmailCss } from '@swarm/mail/css';
import { ErrorNotice, LoadingRows, Pill, TextAreaField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { useChannelFlag } from '../api/queries';
import { emailCssQuery, useSaveEmailCss } from '../api/send';
import { Section, formatDateTime } from '../pages/common';
import { UnsavedBar } from '../shell/UnsavedBar';

/** The section, or nothing when the flag is off for the Channel. */
export function EmailCssSection({ channel, admin }: { channel: Channel; admin: boolean }) {
  const on = useChannelFlag(channel.id, 'custom_email_css');
  if (on !== true) return null;
  return <EmailCssSettings channel={channel} admin={admin} />;
}

function EmailCssSettings({ channel, admin }: { channel: Channel; admin: boolean }) {
  const stored = useQuery(emailCssQuery(channel.id));
  return (
    <Section
      title="Email CSS"
      description={
        <>
          Your own styles for every email {channel.name} sends, including previews and test sends.
          Simple rules are written into each element; @media rules go in the email’s head. Target
          elements such as <code>p</code> and <code>h2</code>, or the classes{' '}
          {EMAIL_CSS_CLASSES.map((c, i) => (
            <span key={c}>
              {i > 0 && ', '}
              <code>.{c}</code>
            </span>
          ))}
          .
        </>
      }
    >
      {stored.isPending && <LoadingRows label="Loading email CSS" rows={3} />}
      {stored.error && <ErrorNotice message={stored.error.message} />}
      {stored.data && (
        <EmailCssForm
          channelId={channel.id}
          initial={stored.data.css}
          updatedAt={stored.data.updatedAt}
          admin={admin}
        />
      )}
    </Section>
  );
}

function EmailCssForm({
  channelId,
  initial,
  updatedAt,
  admin,
}: {
  channelId: string;
  initial: string;
  updatedAt: string | null;
  admin: boolean;
}) {
  const formId = useId();
  // Not keyed by updatedAt: a save keeps the form, so its "Saved" can show. `saved` follows it.
  const [saved, setSaved] = useState(initial);
  const [css, setCss] = useState(initial);
  const save = useSaveEmailCss(channelId);
  const lint = useMemo(() => lintEmailCss(css), [css]);
  const bytes = useMemo(() => new TextEncoder().encode(css).length, [css]);
  const serverError = save.error instanceof ApiError ? save.error : null;
  const changed = css !== saved;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // The lint above already says what is wrong; the server would refuse it too.
    if (!lint.ok) return;
    const sent = css;
    save.mutate(sent, { onSuccess: () => setSaved(sent) });
  };

  return (
    <form id={formId} onSubmit={submit} className="grid gap-4">
      <TextAreaField
        label="Stylesheet"
        value={css}
        readOnly={!admin}
        spellCheck={false}
        rows={12}
        onChange={(e) => setCss(e.target.value)}
        className="font-mono text-[12.5px]"
        hint={`${bytes.toLocaleString()} of ${EMAIL_CSS_MAX_BYTES.toLocaleString()} bytes${
          updatedAt ? ` · saved ${formatDateTime(updatedAt)}` : ''
        }`}
        error={
          lint.errors[0] ? `Line ${lint.errors[0].line}: ${lint.errors[0].message}` : undefined
        }
      />
      {(lint.errors.length > 1 || lint.warnings.length > 0) && (
        <ul className="grid gap-2 text-[13px]" aria-label="Lint results">
          {lint.errors.slice(1).map((issue, i) => (
            <li key={`e${i}`} className="flex items-start gap-2">
              <Pill tone="danger">Error</Pill>
              <span>
                Line {issue.line}: {issue.message}
              </span>
            </li>
          ))}
          {lint.warnings.map((issue, i) => (
            <li key={`w${i}`} className="flex items-start gap-2">
              <Pill>Warning</Pill>
              <span className="text-sub">
                Line {issue.line}: {issue.message}
              </span>
            </li>
          ))}
        </ul>
      )}
      {serverError && <ErrorNotice title="Not saved" message={serverError.message} />}
      {admin ? (
        <UnsavedBar
          label="Unsaved changes to the email CSS"
          dirty={changed}
          pending={save.isPending}
          form={formId}
          onDiscard={() => {
            setCss(saved);
            save.reset();
          }}
        />
      ) : (
        <p className="text-[13px] text-sub">Only admins can change the email CSS.</p>
      )}
    </form>
  );
}
