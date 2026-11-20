// The media library picker: upload, search by alt text and choose one image. Used by the
// editor's image dialog and by Site Studio's social image.
import type { MediaAsset } from '@swarm/domain';
import { ErrorNotice, LoadingRows, TextField } from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { mediaQuery, useUploadMedia } from '../api/queries';
import { focalStyle, formatDateTime } from './common';

export function MediaPicker({
  channelId,
  enabled = true,
  chosen,
  onChoose,
}: {
  channelId: string;
  enabled?: boolean;
  chosen: MediaAsset | null;
  onChoose: (asset: MediaAsset) => void;
}) {
  const [search, setSearch] = useState('');
  const media = useQuery({ ...mediaQuery(channelId, search, 'image'), enabled });
  const upload = useUploadMedia(channelId);
  const images = media.data ?? [];

  return (
    <div className="grid gap-4">
      <label className="btn-ghost btn-sm w-fit cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-purple">
        {upload.isPending ? 'Uploading…' : 'Upload image'}
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file, { onSuccess: (asset) => onChoose(asset) });
            event.target.value = '';
          }}
        />
      </label>
      {upload.error && <ErrorNotice title="Upload failed" message={upload.error.message} />}
      <TextField
        label="Search by alt text"
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {media.isPending && <LoadingRows label="Loading media" rows={1} />}
      {media.error && <ErrorNotice message={media.error.message} />}
      {images.length > 0 && (
        <div
          role="radiogroup"
          aria-label="Media library"
          className="grid max-h-56 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4"
        >
          {images.map((asset) => (
            <button
              key={asset.id}
              type="button"
              role="radio"
              aria-checked={chosen?.id === asset.id}
              aria-label={asset.altText || `Image uploaded ${formatDateTime(asset.createdAt)}`}
              onClick={() => onChoose(asset)}
              className={`aspect-square overflow-hidden rounded-[10px] border-2 ${chosen?.id === asset.id ? 'border-purple' : 'border-transparent'}`}
            >
              <img
                src={asset.url}
                alt=""
                className="size-full object-cover"
                style={focalStyle(asset)}
              />
            </button>
          ))}
        </div>
      )}
      {media.data && images.length === 0 && !upload.isPending && (
        <p className="text-[13px] text-sub">
          {search.trim() ? 'No images match.' : 'No images yet. Upload one to start.'}
        </p>
      )}
    </div>
  );
}
