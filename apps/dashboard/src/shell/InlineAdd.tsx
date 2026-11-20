// "Add something" on a settings page: a button that opens a short form in its place, so an empty
// form isn't always showing. Focus moves into the form; Cancel or Esc closes it and puts focus back
// on the button; a successful add closes it and announces what was added. See DESIGN.md.
import { Button } from '@swarm/ui/components';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

interface InlineAddProps {
  /** The button that opens the form, such as "Add sender". */
  label: string;
  /** The form's accessible name, such as "Add a sender". Defaults to `label`. */
  formLabel?: string;
  /** The submit button. Defaults to `label`. */
  submitLabel?: string;
  pending?: boolean;
  /** Called on submit. Call `done` with a sentence for screen readers once the add worked. */
  onSubmit: (done: (announcement: string) => void) => void;
  /** Called when the form closes without adding, to clear what was typed. */
  onCancel?: () => void;
  /** The quieter button style, for a second add in one band. */
  variant?: 'primary' | 'ghost';
  /** The fields. Errors from the server go here too; the form stays open on a failure. */
  children: ReactNode;
}

const FOCUSABLE = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea';

export function InlineAdd({
  label,
  formLabel,
  submitLabel,
  pending = false,
  onSubmit,
  onCancel,
  variant = 'ghost',
  children,
}: InlineAddProps) {
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  // Focus goes back to the button only after the form closed, never on first render.
  const returnFocus = useRef(false);

  useEffect(() => {
    if (open) {
      form.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      button.current?.focus();
    }
  }, [open]);

  const close = (message = '') => {
    returnFocus.current = true;
    setAnnouncement(message);
    setOpen(false);
  };
  const cancel = () => {
    onCancel?.();
    close();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onSubmit((message) => close(message));
  };

  return (
    <div>
      {open ? (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc from any field closes the form, as in a dialog
        <form
          ref={form}
          aria-label={formLabel ?? label}
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
          className="grid gap-4"
        >
          {children}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" loading={pending}>
              {submitLabel ?? label}
            </Button>
            <Button variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <button
            ref={button}
            type="button"
            className={`${variant === 'primary' ? 'btn-primary' : 'btn-ghost'} btn-sm`}
            onClick={() => {
              setAnnouncement('');
              setOpen(true);
            }}
          >
            {label}
          </button>
        </div>
      )}
      {/* Always in the page, so screen readers hear what changes in it. */}
      <p role="status" className="mt-2 text-[13px] text-success empty:mt-0">
        {announcement}
      </p>
    </div>
  );
}
