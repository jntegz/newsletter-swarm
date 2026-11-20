// The post's cover image, near the top of the writing area: add, change or remove it and write its
// alt text. It uses the media library's picker and upload, and saves with the editor's autosave.
// People who can't edit the post see the image and its alt text read-only.
import type { CoverImage, MediaAsset } from '@swarm/domain';
import { Button, Dialog } from '@swarm/ui/components';
import { useId, useRef, useState } from 'react';
import * as Icon from '../icons';
import { MediaPicker } from '../pages/MediaPicker';
import { COVER_ALT_MAX, coverFromAsset } from './coverImage';

export function CoverImageField({
  channelId,
  cover,
  canWrite,
  onChange,
  inline = false,
}: {
  channelId: string;
  cover: CoverImage | null;
  canWrite: boolean;
  onChange: (cover: CoverImage | null) => void;
  /** Without a cover, only a small "Cover image" button (the editor's header row). */
  inline?: boolean;
}) {
  const headingId = useId();
  const altId = useId();
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<MediaAsset | null>(null);
  const altRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  const closePicker = () => {
    setPicking(false);
    setChosen(null);
  };

  // The button that had focus goes away with these, so focus moves to what replaces it.
  const confirmChosen = () => {
    if (!chosen) return;
    onChange(coverFromAsset(chosen));
    closePicker();
    requestAnimationFrame(() => altRef.current?.focus());
  };
  const remove = () => {
    onChange(null);
    requestAnimationFrame(() => addRef.current?.focus());
  };

  if (!cover && !canWrite) return null;

  const picker = canWrite && (
    <Dialog
      open={picking}
      onClose={closePicker}
      title="Choose a cover image"
      description="Pick from this publication's media library or upload a new image."
      actions={
        <>
          <Button variant="ghost" onClick={closePicker}>
            Cancel
          </Button>
          <Button disabled={!chosen} onClick={confirmChosen}>
            Use this image
          </Button>
        </>
      }
    >
      {picking && (
        <MediaPicker channelId={channelId} enabled chosen={chosen} onChoose={setChosen} />
      )}
    </Dialog>
  );

  if (!cover && inline) {
    return (
      <section aria-label="Cover image">
        <button
          ref={addRef}
          type="button"
          className="btn-quiet btn-sm gap-1.5"
          title="Shown large at the top of the post, in the email and on the website"
          onClick={() => setPicking(true)}
        >
          <Icon.Image size={16} />
          Add cover image
        </button>
        {picker}
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId}>
      <p id={headingId} className="mb-1.5 text-[15px] font-semibold">
        Cover image
      </p>
      {!cover && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <button
            ref={addRef}
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => setPicking(true)}
          >
            Add cover image
          </button>
          <span className="text-[13px] text-sub">
            Shown large at the top of the post, in the email and on the website.
          </span>
        </div>
      )}
      {cover && (
        <div className="grid gap-3">
          {cover.url ? (
            <img
              src={cover.url}
              alt={cover.alt}
              {...(cover.width && cover.height ? { width: cover.width, height: cover.height } : {})}
              className="block h-auto max-h-[320px] w-full rounded-card border border-line object-cover"
            />
          ) : (
            <p className="rounded-card bg-warn-soft px-3.5 py-3 text-[13px] text-warn">
              This image is no longer in the media library, so readers won’t see it.
            </p>
          )}
          <div>
            <label htmlFor={altId} className="mb-1.5 block text-[13px] font-semibold">
              Alt text
            </label>
            <input
              ref={altRef}
              id={altId}
              type="text"
              value={cover.alt}
              maxLength={COVER_ALT_MAX}
              readOnly={!canWrite}
              autoComplete="off"
              onChange={(e) => onChange({ ...cover, alt: e.target.value })}
              aria-describedby={canWrite ? `${altId}-help` : undefined}
              className="line-input"
            />
            {canWrite && (
              <p id={`${altId}-help`} className="mt-1.5 text-[13px] text-sub">
                Describe the image for people who can’t see it.
              </p>
            )}
          </div>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-ghost btn-sm" onClick={() => setPicking(true)}>
                Change image
              </button>
              <button type="button" className="btn-quiet btn-sm" onClick={remove}>
                Remove image
              </button>
            </div>
          )}
        </div>
      )}
      {picker}
    </section>
  );
}
