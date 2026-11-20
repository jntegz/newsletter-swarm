// The publication's logo and accent colour, set from the Website settings. Both belong to the
// publication, so emails, signup forms and the website share them: one upload, one colour.
import type { Channel, MediaAsset } from '@swarm/domain';
import { Button, Dialog, ErrorNotice } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { mediaQuery, useUpdateChannel } from '../api/queries';
import { MediaPicker } from '../pages/MediaPicker';
import { Section, focalStyle } from '../pages/common';
import { accentNote } from './template-info';

/** What the site uses when the publication has no accent colour. */
const DEFAULT_ACCENT = '#6c4cf1';

export function BrandPanel({ channel, canEdit }: { channel: Channel; canEdit: boolean }) {
  const update = useUpdateChannel(channel.id);
  const logoId = channel.branding.logoMediaId;
  const media = useQuery({ ...mediaQuery(channel.id), enabled: !!logoId });
  const logo = media.data?.find((m) => m.id === logoId) ?? null;
  const savedAccent = channel.branding.accentColor;
  const [accent, setAccent] = useState(savedAccent ?? DEFAULT_ACCENT);
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<MediaAsset | null>(null);
  const [saved, setSaved] = useState('');
  const colourId = useId();
  const noteId = useId();
  const note = accentNote(accent);
  const changed = accent.toLowerCase() !== (savedAccent ?? DEFAULT_ACCENT).toLowerCase();

  const save = (
    branding: { accentColor?: string | null; logoMediaId?: string | null },
    done: string,
  ) => {
    setSaved('');
    update.mutate({ branding }, { onSuccess: () => setSaved(done) });
  };

  const saveColour = (event: FormEvent) => {
    event.preventDefault();
    save({ accentColor: accent }, 'Colour saved.');
  };

  return (
    <Section
      title="Logo and accent colour"
      description="Your website, emails and signup forms share one logo and one colour, so you set them once."
    >
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center gap-4">
          <div className="grid size-16 place-items-center overflow-hidden rounded-[14px] border border-line-app bg-surface-alt">
            {logo ? (
              <img
                src={logo.url}
                alt={logo.altText ?? 'Logo'}
                className="size-full object-cover"
                style={focalStyle(logo)}
              />
            ) : logoId && media.isPending ? (
              <span className="text-[11px] text-sub">Loading…</span>
            ) : (
              <span className="text-[11px] text-sub">No logo</span>
            )}
          </div>
          <div className="grid gap-1.5">
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
                  {logoId ? 'Replace logo' : 'Choose logo'}
                </Button>
                {logoId && (
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => save({ logoMediaId: null }, 'Logo removed.')}
                  >
                    Remove logo
                  </Button>
                )}
              </div>
            )}
            <p className="max-w-[52ch] text-[12.5px] leading-[1.45] text-sub">
              A square image, at least 256 pixels across. It shows beside your publication’s name,
              as the browser tab icon and on shared links. Without one, the tab icon is your initial
              on the accent colour.
            </p>
          </div>
        </div>

        <form onSubmit={saveColour} className="grid gap-2" aria-label="Accent colour">
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <input
              id={colourId}
              type="color"
              value={accent}
              disabled={!canEdit}
              aria-describedby={noteId}
              onChange={(e) => setAccent(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded-control border border-line-control bg-surface p-1 disabled:cursor-not-allowed"
            />
            <label htmlFor={colourId} className="font-semibold">
              Accent colour
            </label>
            <span className="font-mono text-sub">{accent}</span>
            {canEdit && (
              <>
                <Button type="submit" size="sm" disabled={!changed} loading={update.isPending}>
                  Save colour
                </Button>
                {savedAccent && (
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => {
                      setAccent(DEFAULT_ACCENT);
                      save({ accentColor: null }, 'Back to the default colour.');
                    }}
                  >
                    Use the default
                  </Button>
                )}
              </>
            )}
          </div>
          <p id={noteId} className="max-w-[64ch] text-[12.5px] leading-[1.45] text-sub">
            Used for buttons and links.{' '}
            {note ?? 'Button text is set to black or white, whichever reads better on it.'}
          </p>
        </form>

        {update.error && <ErrorNotice message={update.error.message} />}
        <p role="status" className="text-[13px] text-success">
          {saved}
        </p>
      </div>

      <Dialog
        open={picking}
        onClose={() => setPicking(false)}
        title="Choose a logo"
        description="Pick an image from your media library or upload a new one."
        actions={
          <>
            <Button variant="ghost" onClick={() => setPicking(false)}>
              Cancel
            </Button>
            <Button
              disabled={!chosen}
              onClick={() => {
                if (chosen) save({ logoMediaId: chosen.id }, 'Logo saved.');
                setPicking(false);
              }}
            >
              Use as logo
            </Button>
          </>
        }
      >
        {picking && <MediaPicker channelId={channel.id} chosen={chosen} onChoose={setChosen} />}
      </Dialog>
    </Section>
  );
}
