// Settings → Sending → Email design (flag email_design): the look of every email the publication
// sends, for those who'd rather not write CSS. Applies to previews and test sends straight away.
import type { Channel, EmailDesign } from '@swarm/domain';
import { SelectField, TextField } from '@swarm/ui/components';
import { useId, useState, type FormEvent } from 'react';
import { useChannelFlag, useUpdateChannel } from '../api/queries';
import { Section } from '../pages/common';
import { UnsavedBar } from '../shell/UnsavedBar';

const COLOURS = [
  ['pageColor', 'Page', '#fbfbfd'],
  ['cardColor', 'Message', '#ffffff'],
  ['textColor', 'Text', '#0f0f12'],
] as const;

export function EmailDesignSection({ channel, admin }: { channel: Channel; admin: boolean }) {
  const on = useChannelFlag(channel.id, 'email_design');
  if (on !== true) return null;
  return <EmailDesignForm channel={channel} admin={admin} />;
}

function EmailDesignForm({ channel, admin }: { channel: Channel; admin: boolean }) {
  const update = useUpdateChannel(channel.id);
  const formId = useId();
  // What is saved: the design as loaded, then what each save sent.
  const [saved, setSaved] = useState<EmailDesign>(channel.emailDesign);
  const [design, setDesign] = useState<EmailDesign>(channel.emailDesign);
  const dirty = JSON.stringify(design) !== JSON.stringify(saved);
  const set = <K extends keyof EmailDesign>(key: K, value: EmailDesign[K]) =>
    setDesign((current) => ({ ...current, [key]: value }));
  const clear = (key: 'pageColor' | 'cardColor' | 'textColor') =>
    setDesign(({ [key]: _gone, ...rest }) => rest);
  const save = (event: FormEvent) => {
    event.preventDefault();
    const sent = design;
    update.mutate({ emailDesign: sent }, { onSuccess: () => setSaved(sent) });
  };
  return (
    <Section
      title="Email design"
      description="How every email from this publication looks. The logo comes from Publication settings."
    >
      <form id={formId} onSubmit={save} className="grid gap-4">
        <fieldset disabled={!admin} className="grid gap-4">
          <SelectField
            label="Font"
            value={design.font}
            onChange={(e) => set('font', e.target.value as EmailDesign['font'])}
            options={[
              { value: 'system', label: 'Clean: the reader’s system font' },
              { value: 'serif', label: 'Bookish: Georgia' },
              { value: 'mono', label: 'Typewriter: monospace' },
            ]}
          />
          <label className="flex items-center gap-2.5 text-[13.5px] font-semibold">
            <input
              type="checkbox"
              checked={design.showLogo}
              onChange={(e) => set('showLogo', e.target.checked)}
              className="size-4 accent-purple"
            />
            Show my logo at the top
          </label>
          <TextField
            label="Line under your name"
            maxLength={200}
            value={design.header}
            onChange={(e) => set('header', e.target.value)}
          />
          <TextField
            label="Postal address"
            maxLength={500}
            value={design.footer}
            onChange={(e) => set('footer', e.target.value)}
            hint="Printed at the foot of every email, under the unsubscribe link. Anti-spam laws in the US, Canada and elsewhere require a postal address where you can be reached."
          />
          <div className="flex flex-wrap gap-6 text-[13px]">
            {COLOURS.map(([key, label, fallback]) => (
              <div key={key} className="flex items-center gap-2">
                <input
                  id={`email-${key}`}
                  type="color"
                  value={design[key] ?? fallback}
                  onChange={(e) => set(key, e.target.value)}
                  className="h-9 w-12 cursor-pointer rounded-control border border-line-control bg-surface p-1"
                />
                <label htmlFor={`email-${key}`} className="font-semibold">
                  {label}
                </label>
                {design[key] && (
                  <button type="button" className="btn-ghost btn-sm" onClick={() => clear(key)}>
                    Default
                  </button>
                )}
              </div>
            ))}
          </div>
        </fieldset>
        {admin && (
          <UnsavedBar
            label="Unsaved changes to the email design"
            dirty={dirty}
            pending={update.isPending}
            form={formId}
            onDiscard={() => {
              setDesign(saved);
              update.reset();
            }}
            error={update.error?.message}
          />
        )}
      </form>
    </Section>
  );
}
