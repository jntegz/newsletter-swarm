// Media library: every image, font and file a Channel has uploaded, with alt text and focal
// points for images and a name for fonts and files. A font shows a line set in its own face.
import type { Channel, MediaAsset } from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  channelQuery,
  mediaQuery,
  useDeleteMedia,
  useUpdateMedia,
  useUploadMedia,
} from '../api/queries';
import * as Icon from '../icons';
import { addUploadedFont, uploadedFontName, uploadedStack } from '../design/uploadedFonts';
import { PageHeader } from './Channels';
import { focalStyle, formatDateTime, numberFormat } from './common';
import { FontUpload } from './FontUpload';

const RANK = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 } as const;

export function MediaPage({ channelId }: { channelId: string }) {
  const channel = useQuery(channelQuery(channelId));
  if (channel.isPending) return <LoadingRows label="Loading publication" rows={4} />;
  if (channel.error)
    return <ErrorNotice title="Publication not available" message={channel.error.message} />;
  return <MediaLibrary channel={channel.data} />;
}

const isImage = (asset: MediaAsset) => asset.kind === 'image';
const isFont = (asset: MediaAsset) => asset.kind === 'font';
const FONT_SAMPLE = 'The quick brown fox jumps over the lazy dog';

/** A line set in an uploaded font, loaded from its media address for the dashboard. */
function FontSample({
  asset,
  className = '',
  text = FONT_SAMPLE,
}: {
  asset: MediaAsset;
  className?: string;
  text?: string;
}) {
  useEffect(() => addUploadedFont(asset), [asset]);
  return (
    <span className={className} style={{ fontFamily: uploadedStack(asset.id) }}>
      {text}
    </span>
  );
}
const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${numberFormat.format(Math.max(1, Math.round(bytes / 1024)))} KB`;

function MediaLibrary({ channel }: { channel: Channel }) {
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<MediaAsset['kind'] | undefined>(undefined);
  const [addingFont, setAddingFont] = useState(false);
  const media = useQuery(mediaQuery(channel.id, search, kind));
  const upload = useUploadMedia(channel.id);
  const [open, setOpen] = useState<MediaAsset | null>(null);
  const canUpload = RANK[channel.role] >= RANK.author;

  return (
    <>
      <PageHeader
        title="Media"
        subtitle={`Images, fonts and files in ${channel.name}. Alt text set here is used whenever the image is added to a post.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/channels/$channelId"
              params={{ channelId: channel.id }}
              className="btn-ghost"
            >
              Publication settings
            </Link>
            {canUpload && (
              <Button variant="ghost" onClick={() => setAddingFont(true)}>
                Upload a font
              </Button>
            )}
            {canUpload && (
              <label className="btn-primary cursor-pointer">
                {upload.isPending ? 'Uploading…' : 'Upload'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,image/avif,application/pdf"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) upload.mutate(file, { onSuccess: (asset) => setOpen(asset) });
                    event.target.value = '';
                  }}
                />
              </label>
            )}
          </div>
        }
      />
      {upload.error && (
        <div className="mb-4">
          <ErrorNotice title="Upload failed" message={upload.error.message} />
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Icon.Search
            size={16}
            className="pointer-events-none absolute top-[18px] left-3 z-[1] -translate-y-1/2 text-sub"
          />
          <TextField
            label="Search names and alt text"
            hideLabel
            placeholder="Search names and alt text"
            size="sm"
            className="pl-9"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div role="group" aria-label="Show" className="line-chips">
          {(
            [
              [undefined, 'All'],
              ['image', 'Images'],
              ['font', 'Fonts'],
              ['file', 'Files'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
              className="line-chip"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {media.isPending && <LoadingRows label="Loading media" rows={3} />}
      {media.error && <ErrorNotice message={media.error.message} />}
      {media.data && media.data.length === 0 && (
        <EmptyState
          title={search.trim() || kind ? 'Nothing matches' : 'No media yet'}
          action={
            canUpload && !search.trim() && !kind ? (
              <label className="btn-primary btn-sm cursor-pointer">
                Upload an image or PDF
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,image/avif,application/pdf"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) upload.mutate(file, { onSuccess: (asset) => setOpen(asset) });
                    event.target.value = '';
                  }}
                />
              </label>
            ) : undefined
          }
        >
          {search.trim() || kind
            ? 'Try another search.'
            : 'Upload images for your posts, PDFs to send as download links and fonts for your website.'}
        </EmptyState>
      )}
      {media.data && media.data.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {media.data.map((asset) => (
            <li key={asset.id}>
              <button
                type="button"
                onClick={() => setOpen(asset)}
                className="card-app block w-full overflow-hidden text-left hover:border-lavender-line focus-visible:outline-2 focus-visible:outline-purple"
              >
                <span className="block aspect-[4/3] bg-surface-alt">
                  {isImage(asset) ? (
                    <img
                      src={asset.url}
                      alt=""
                      loading="lazy"
                      className="size-full object-cover"
                      style={focalStyle(asset)}
                    />
                  ) : isFont(asset) ? (
                    <span className="flex size-full flex-col justify-center gap-1 overflow-hidden px-3 text-ink">
                      <FontSample
                        asset={asset}
                        text="Aa Bb Cc"
                        className="text-[30px] leading-none"
                      />
                      <FontSample
                        asset={asset}
                        className="line-clamp-2 text-[14px] leading-[1.35] text-sub"
                      />
                    </span>
                  ) : (
                    <span className="grid size-full place-items-center text-[13px] font-semibold text-sub">
                      {asset.contentType === 'application/pdf' ? 'PDF' : 'File'}
                    </span>
                  )}
                </span>
                <span className="block px-3 py-2">
                  <span className="block truncate text-[13px] font-semibold">
                    {isFont(asset)
                      ? uploadedFontName(asset)
                      : asset.altText || (isImage(asset) ? 'No alt text' : 'Untitled file')}
                  </span>
                  <span className="block text-[12px] text-sub">{size(asset.bytes)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <MediaDialog key={open.id} channel={channel} asset={open} onClose={() => setOpen(null)} />
      )}
      <FontUploadDialog
        channel={channel}
        open={addingFont}
        onClose={() => setAddingFont(false)}
        onUploaded={(asset) => {
          setAddingFont(false);
          setOpen(asset);
        }}
      />
    </>
  );
}

function FontUploadDialog({
  channel,
  open,
  onClose,
  onUploaded,
}: {
  channel: Channel;
  open: boolean;
  onClose: () => void;
  onUploaded: (asset: MediaAsset) => void;
}) {
  const formId = useId();
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Upload a font"
      description="For your website’s headings and text. Choose it in Website, Design, Style."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={pending}>
            {pending ? 'Uploading…' : 'Upload font'}
          </Button>
        </>
      }
    >
      {open && (
        <FontUpload
          channelId={channel.id}
          formId={formId}
          actions={false}
          onPendingChange={setPending}
          onUploaded={onUploaded}
        />
      )}
    </Dialog>
  );
}

const clamp = (value: number) => Math.min(1, Math.max(0, Math.round(value * 100) / 100));

function MediaDialog({
  channel,
  asset,
  onClose,
}: {
  channel: Channel;
  asset: MediaAsset;
  onClose: () => void;
}) {
  const update = useUpdateMedia(channel.id);
  const remove = useDeleteMedia(channel.id);
  const canEdit = RANK[channel.role] >= RANK.author;
  const canDelete = RANK[channel.role] >= RANK.editor;
  const [alt, setAlt] = useState(asset.altText ?? '');
  const [focal, setFocal] = useState(asset.focalPoint);
  const [confirming, setConfirming] = useState(false);
  const image = isImage(asset);
  const font = isFont(asset);

  const pick = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setFocal({
      x: clamp((event.clientX - box.left) / box.width),
      y: clamp((event.clientY - box.top) / box.height),
    });
  };
  const nudge = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const move = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (!move) return;
    event.preventDefault();
    const current = focal ?? { x: 0.5, y: 0.5 };
    setFocal({ x: clamp(current.x + move[0]!), y: clamp(current.y + move[1]!) });
  };

  const save = () =>
    update.mutate(
      { id: asset.id, altText: alt.trim() || null, ...(image ? { focalPoint: focal } : {}) },
      { onSuccess: onClose },
    );

  return (
    <Dialog
      open
      onClose={onClose}
      title={image ? 'Image' : font ? 'Font' : 'File'}
      description={`${asset.contentType} · ${size(asset.bytes)}${asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''} · uploaded ${formatDateTime(asset.createdAt)}`}
      actions={
        confirming ? (
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate(asset.id, { onSuccess: onClose })}
            >
              Delete for good
            </Button>
          </>
        ) : (
          <>
            {canDelete && (
              <Button variant="quiet" onClick={() => setConfirming(true)}>
                Delete
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              {canEdit ? 'Cancel' : 'Close'}
            </Button>
            {canEdit && (
              <Button loading={update.isPending} onClick={save}>
                Save
              </Button>
            )}
          </>
        )
      }
    >
      <div className="grid gap-4">
        {confirming && (
          <ErrorNotice
            title="Delete this file?"
            message="It stops loading straight away, including in posts already sent. Drafts that use it can’t be sent until it’s replaced."
          />
        )}
        {image ? (
          <div>
            <p className="mb-1.5 text-[13px] font-semibold text-ink">Focal point</p>
            <button
              type="button"
              disabled={!canEdit}
              onClick={pick}
              onKeyDown={nudge}
              aria-label={`Focal point ${focal ? `at ${Math.round(focal.x * 100)}% across, ${Math.round(focal.y * 100)}% down` : 'not set'}. Click the subject, or use the arrow keys.`}
              className="relative block w-full overflow-hidden rounded-[10px] border border-line-app focus-visible:outline-2 focus-visible:outline-purple disabled:cursor-default"
            >
              <img src={asset.url} alt="" className="block max-h-72 w-full object-contain" />
              {focal && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-purple/70 shadow"
                  style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }}
                />
              )}
            </button>
            <p className="mt-1.5 text-[12.5px] text-sub">
              Crops keep this point in view.{' '}
              {focal && canEdit && (
                <button
                  type="button"
                  className="font-semibold text-purple-deep"
                  onClick={() => setFocal(null)}
                >
                  Clear
                </button>
              )}
            </p>
          </div>
        ) : font ? (
          <div className="grid gap-2 rounded-[10px] border border-line-app px-4 py-4 text-ink">
            <FontSample asset={asset} text="Aa Bb Cc 123" className="text-[34px] leading-none" />
            <FontSample asset={asset} className="text-[18px] leading-[1.4]" />
          </div>
        ) : (
          <a href={asset.url} target="_blank" rel="noreferrer" className="btn-ghost btn-sm w-fit">
            Open file
          </a>
        )}
        <TextField
          label={image ? 'Alt text' : 'Name'}
          value={alt}
          maxLength={300}
          readOnly={!canEdit}
          onChange={(e) => setAlt(e.target.value)}
          hint={
            image
              ? 'Describe the image for people who can’t see it.'
              : font
                ? 'How it shows in Style when you choose your website’s fonts.'
                : 'Shown when you attach the file to a post.'
          }
        />
        {update.error && <ErrorNotice message={update.error.message} />}
        {remove.error && <ErrorNotice message={remove.error.message} />}
      </div>
    </Dialog>
  );
}
