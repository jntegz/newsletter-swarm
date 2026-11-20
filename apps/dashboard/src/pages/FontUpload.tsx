// Uploading a font to the media library (docs/site-themes.md, "Uploaded fonts"): a WOFF2 or WOFF
// file up to 2 MB, its name, and the owner's word that its licence allows use on a website. The
// server checks the file's bytes; this form checks what it can first, so most mistakes are caught
// before anything is sent. Used by Style's font menu and by the media library.
import type { MediaAsset } from '@swarm/domain';
import { Button, Checkbox, ErrorNotice, TextField } from '@swarm/ui/components';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useUploadMedia } from '../api/queries';

const FONT_MAX_BYTES = 2 * 1024 * 1024;
const FONT_ACCEPT = '.woff2,.woff,font/woff2,font/woff';

/** A file's own name as a font name: "brand-sans_bold.woff2" reads "brand sans bold". */
export const fontNameFromFile = (name: string) =>
  name
    .replace(/\.(woff2?|ttf|otf)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .slice(0, 120);

/** What is wrong with a chosen file before it is sent, or null. */
export function fontFileProblem(file: Pick<File, 'name' | 'size'>): string | null {
  if (!/\.woff2?$/i.test(file.name)) {
    return /\.(ttf|otf)$/i.test(file.name)
      ? 'Use the font’s WOFF2 or WOFF file. Most font shops include one with the web licence.'
      : 'Choose a WOFF2 or WOFF font file.';
  }
  if (file.size > FONT_MAX_BYTES) return 'Fonts can be up to 2 MB.';
  return null;
}

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function FontUpload({
  channelId,
  onUploaded,
  onCancel,
  formId,
  actions = true,
  onPendingChange,
}: {
  channelId: string;
  onUploaded: (asset: MediaAsset) => void;
  onCancel?: () => void;
  /** The form's id, for a submit button outside it (a dialog's actions). */
  formId?: string;
  /** Draw the Upload and Cancel buttons inside the form; false when a dialog holds them. */
  actions?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const upload = useUploadMedia(channelId);
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [licensed, setLicensed] = useState(false);
  const [tried, setTried] = useState(false);

  const fileProblem = file ? fontFileProblem(file) : tried ? 'Choose a font file first.' : null;
  const licenceProblem =
    tried && !licensed ? 'Confirm the licence allows use on a website.' : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!file || fontFileProblem(file) || !licensed || upload.isPending) return;
    onPendingChange?.(true);
    upload.mutate(
      { file, alt: name.trim() || fontNameFromFile(file.name) },
      {
        onSuccess: (asset) => onUploaded(asset),
        onSettled: () => onPendingChange?.(false),
      },
    );
  };

  return (
    <form id={formId} noValidate onSubmit={submit} className="grid gap-4">
      <div className="grid gap-1.5">
        <span className="text-[13px] font-semibold" id={`${fileId}-label`}>
          Font file
        </span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <label className="btn-ghost btn-sm cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-purple">
            {file ? 'Choose another file' : 'Choose a file'}
            <input
              id={fileId}
              type="file"
              accept={FONT_ACCEPT}
              className="sr-only"
              aria-labelledby={`${fileId}-label`}
              aria-describedby={`${fileId}-hint${fileProblem ? ` ${fileId}-error` : ''}`}
              aria-invalid={fileProblem ? true : undefined}
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                setFile(chosen);
                if (chosen && (!name.trim() || name === fontNameFromFile(file?.name ?? '')))
                  setName(fontNameFromFile(chosen.name));
                upload.reset();
                event.target.value = '';
              }}
            />
          </label>
          {file && (
            <span className="min-w-0 truncate text-[13px] text-sub">
              {file.name} · {size(file.size)}
            </span>
          )}
        </div>
        <p id={`${fileId}-hint`} className="text-[12.5px] text-sub">
          WOFF2 or WOFF, up to 2 MB.
        </p>
        {fileProblem && (
          <p
            id={`${fileId}-error`}
            role="alert"
            className="text-[12.5px] font-semibold text-danger"
          >
            {fileProblem}
          </p>
        )}
      </div>
      <TextField
        label="Name"
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
        hint="How it shows in Style and in the media library."
      />
      <Checkbox
        label="Its licence allows use on a website"
        hint="Fonts bought for print or desktop apps often need a separate web licence."
        checked={licensed}
        error={licenceProblem}
        onChange={setLicensed}
      />
      {upload.error && <ErrorNotice title="Not uploaded" message={upload.error.message} />}
      {actions && (
        <FormActions>
          <Button type="submit" size="sm" loading={upload.isPending}>
            {upload.isPending ? 'Uploading…' : 'Upload font'}
          </Button>
          {onCancel && (
            <Button variant="quiet" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </FormActions>
      )}
    </form>
  );
}

function FormActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
