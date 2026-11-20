// Settings → Sending → System emails (flag message_templates): the owner's own wording or HTML for
// confirmations, sign-in links and payment notices. Every send falls back to the built-in wording
// if a saved version can't be used, so editing here can't stop a confirmation going out.
import type { Channel, Message, SaveMessage } from '@swarm/domain';
import {
  Button,
  ErrorNotice,
  LoadingRows,
  Pill,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useMutation, useQuery, useQueryClient, queryOptions } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { useChannelFlag } from '../api/queries';
import { Section } from '../pages/common';

const messagesKey = (channelId: string) => ['system-emails', channelId] as const;
const messagesQuery = (channelId: string) =>
  queryOptions({
    queryKey: messagesKey(channelId),
    queryFn: ({ signal }) => api.get<Message[]>(`/api/v1/channels/${channelId}/messages`, signal),
  });

interface Rendered {
  subject: string;
  html: string;
  text: string;
}

export function SystemEmailsSection({ channel, admin }: { channel: Channel; admin: boolean }) {
  const on = useChannelFlag(channel.id, 'message_templates');
  if (on !== true) return null;
  return <SystemEmails channel={channel} admin={admin} />;
}

function SystemEmails({ channel, admin }: { channel: Channel; admin: boolean }) {
  const list = useQuery(messagesQuery(channel.id));
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = list.data?.find((m) => m.key === openKey) ?? null;
  return (
    <Section
      title="System emails"
      description="Change the wording or HTML of the emails sent for you. If a saved version can’t be used, the built-in wording goes out, so people always get their link."
    >
      {list.isPending && <LoadingRows label="Loading system emails" />}
      {list.error && <ErrorNotice message={list.error.message} />}
      <ul className="grid gap-1">
        {list.data?.map((message) => (
          <li
            key={message.key}
            className="flex flex-wrap items-center justify-between gap-3 border-b border-line-app py-2.5 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold">{message.label}</p>
              <p className="text-[12.5px] text-sub">{message.when}</p>
            </div>
            <div className="flex items-center gap-2">
              {message.customized ? (
                <Pill tone="success">Your wording</Pill>
              ) : message.offUntilSaved ? (
                <Pill tone="scheduled">Off</Pill>
              ) : null}
              {admin && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpenKey(openKey === message.key ? null : message.key)}
                >
                  {openKey === message.key ? 'Close' : 'Edit'}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {open && admin && (
        <MessageEditor
          // Keyed by the email only. A save changes updatedAt, and starting the form again then would
          // wipe the "Saved." it has just shown, and the preview. Reset closes the form.
          key={open.key}
          channelId={channel.id}
          message={open}
          onClose={() => setOpenKey(null)}
        />
      )}
    </Section>
  );
}

function MessageEditor({
  channelId,
  message,
  onClose,
}: {
  channelId: string;
  message: Message;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [subject, setSubject] = useState(message.subject);
  const [mode, setMode] = useState(message.mode);
  const [heading, setHeading] = useState(message.heading);
  const [body, setBody] = useState(message.body);
  const [buttonLabel, setButtonLabel] = useState(message.buttonLabel);
  const [preview, setPreview] = useState<Rendered | null>(null);
  const [note, setNote] = useState('');
  const base = `/api/v1/channels/${channelId}/messages/${message.key}`;
  const draft = (): SaveMessage => ({ subject, mode, heading, body, buttonLabel });
  const refresh = () => client.invalidateQueries({ queryKey: messagesKey(channelId) });

  const save = useMutation({
    mutationFn: () => api.put<Message>(base, draft()),
    onSuccess: async () => {
      setNote('Saved.');
      await refresh();
    },
  });
  const reset = useMutation({
    mutationFn: () => api.delete(base),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const show = useMutation({
    mutationFn: () => api.post<Rendered>(`${base}/preview`, draft()),
    onSuccess: setPreview,
  });
  const test = useMutation({
    mutationFn: () => api.post<{ sentTo: string }>(`${base}/test`, draft()),
    onSuccess: (sent) => setNote(`Test sent to ${sent.sentTo}.`),
  });
  const failure = [save.error, reset.error, show.error, test.error].find(Boolean);
  const fieldError = (path: string) =>
    failure instanceof ApiError ? failure.field(path) : undefined;

  return (
    <div className="mt-4 grid gap-4 border-t border-line pt-4">
      <h3 className="text-[14px] font-semibold">{message.label}</h3>
      {!message.textOnly && (
        <fieldset className="flex gap-4 text-[13.5px]">
          <legend className="sr-only">Format</legend>
          {(['text', 'html'] as const).map((value) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name={`mode-${message.key}`}
                checked={mode === value}
                onChange={() => setMode(value)}
                className="size-4 accent-purple"
              />
              {value === 'text' ? 'Text in the standard design' : 'My own HTML'}
            </label>
          ))}
        </fieldset>
      )}
      <TextField
        label="Subject"
        required
        maxLength={200}
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        error={fieldError('subject')}
      />
      {mode === 'text' && (
        <TextField
          label="Heading"
          maxLength={200}
          value={heading}
          onChange={(e) => setHeading(e.target.value)}
          error={fieldError('heading')}
        />
      )}
      <TextAreaField
        label={mode === 'text' ? 'Message' : 'HTML'}
        required
        rows={mode === 'text' ? 6 : 14}
        value={body}
        className={mode === 'html' ? 'font-mono text-[12.5px]' : undefined}
        onChange={(e) => setBody(e.target.value)}
        error={fieldError('body')}
        hint={
          mode === 'text'
            ? 'Leave a blank line between paragraphs.'
            : `Must include {{${message.link}}}. Scripts, frames and forms are refused.`
        }
      />
      {mode === 'text' && (
        <TextField
          label="Button text"
          required
          maxLength={80}
          value={buttonLabel}
          onChange={(e) => setButtonLabel(e.target.value)}
          error={fieldError('buttonLabel')}
        />
      )}
      <p className="text-[12.5px] text-sub">
        You can use:{' '}
        {message.variables.map((name, index) => (
          <span key={name}>
            {index > 0 && ', '}
            <code>{`{{${name}}}`}</code>
          </span>
        ))}
      </p>
      {failure && !(failure instanceof ApiError && failure.details.length) && (
        <ErrorNotice message={failure.message} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
        <Button variant="ghost" loading={show.isPending} onClick={() => show.mutate()}>
          Preview
        </Button>
        <Button variant="ghost" loading={test.isPending} onClick={() => test.mutate()}>
          Send me a test
        </Button>
        {message.customized && (
          <Button variant="ghost" loading={reset.isPending} onClick={() => reset.mutate()}>
            {message.offUntilSaved ? 'Turn off' : 'Reset to built-in'}
          </Button>
        )}
        <p role="status" className="text-[13px] text-success">
          {note}
        </p>
      </div>
      {preview && (
        <div className="grid gap-2">
          <p className="text-[13px]">
            <span className="text-sub">Subject:</span> {preview.subject}
          </p>
          {/* No scripts or same-origin access: this is the owner's own HTML, shown as written. */}
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={preview.html}
            className="h-[460px] w-full rounded-card-app border border-line-app bg-white"
          />
        </div>
      )}
    </div>
  );
}
