// The Views menu on Subscribers: saved views shared by the publication's team. Choosing one shows
// its filters; editors and up save the filters on screen as a view, rename it and delete it.
import type { MemberView } from '@swarm/domain';
import { Button, Dialog, ErrorNotice, TextField } from '@swarm/ui/components';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { useCreateMemberView, useDeleteMemberView, useUpdateMemberView } from '../api/members';
import * as Icon from '../icons';
import { useDisclosure } from '../shell/useDisclosure';
import {
  describeFilters,
  filtersFromView,
  isFiltered,
  viewFilters,
  type ListFilters,
} from './member-views';
import type { ListColumn } from './members-helpers';

type Pending = 'save' | 'rename' | 'delete' | null;

export function ViewsMenu({
  channelId,
  canEdit,
  views,
  loadError,
  active,
  filters,
  columns,
  segmentName,
  onApply,
  onNotice,
}: {
  channelId: string;
  canEdit: boolean;
  /** Undefined while loading. */
  views: MemberView[] | undefined;
  loadError: string | null;
  /** The saved view whose filters are on screen. */
  active: MemberView | undefined;
  filters: ListFilters;
  columns: readonly ListColumn[];
  segmentName: (id: string) => string | undefined;
  /** Shows a view's filters, or everyone for null. */
  onApply: (view: MemberView | null) => void;
  onNotice: (message: string) => void;
}) {
  const menu = useDisclosure();
  const [dialog, setDialog] = useState<Pending>(null);
  // The view being renamed or deleted, kept while its dialog is open even once it is gone.
  const [target, setTarget] = useState<MemberView | null>(null);
  const everyone = !isFiltered(filters) && !active;

  // The panel closes first and focus goes back to the button, so the dialog returns it there.
  const open = (kind: Exclude<Pending, null>) => {
    menu.close(true);
    setTarget(active ?? null);
    setDialog(kind);
  };
  const choose = (view: MemberView | null) => {
    menu.close(true);
    onApply(view);
  };

  return (
    // On a phone the panel hangs from the toolbar's right edge (see Members), not from this button,
    // which sits left of Columns: from here it would run off the left of the screen.
    <div className="relative ml-auto max-w-full max-sm:static">
      <button type="button" {...menu.buttonProps} className="btn-ghost max-w-full">
        <Icon.Filter size={16} className="shrink-0" />
        {active ? (
          <span className="min-w-0 truncate">
            <span className="font-normal text-sub">View:</span> {active.name}
          </span>
        ) : (
          'Views'
        )}
        <Icon.ChevronDown size={16} className="shrink-0" />
      </button>
      <div
        {...menu.panelProps}
        className="line-menu absolute top-[calc(100%+6px)] right-0 w-[min(340px,calc(100vw-32px))]"
      >
        <p className="table-head px-2.5 pt-1.5 pb-1">Saved views</p>
        <ViewItem
          label="All subscribers"
          detail="No filters"
          current={everyone}
          onClick={() => choose(null)}
        />
        {views?.map((view) => (
          <ViewItem
            key={view.id}
            label={view.name}
            detail={describeFilters(filtersFromView(view), segmentName)}
            current={active?.id === view.id}
            onClick={() => choose(view)}
          />
        ))}
        {!views && !loadError && <p className="px-2.5 py-2 text-[13px] text-sub">Loading views…</p>}
        {loadError && (
          <p role="alert" className="px-2.5 py-2 text-[13px] text-danger">
            Saved views didn’t load: {loadError}
          </p>
        )}
        {views?.length === 0 && (
          <p className="px-2.5 py-2 text-[13px] text-sub">
            No saved views yet.
            {canEdit
              ? ' Choose a status, tag, segment or search, then save it here for the team.'
              : ''}
          </p>
        )}
        <hr className="my-1.5 border-line" />
        {canEdit ? (
          <>
            <button
              type="button"
              className="line-menu-item items-start"
              disabled={!!active}
              onClick={() => open('save')}
            >
              <Icon.Plus size={18} className="mt-0.5 shrink-0 text-sub" />
              <span>
                Save view
                <small className="block text-[13px] leading-snug text-sub">
                  {active
                    ? `These filters are saved as “${active.name}”.`
                    : 'Keep these filters and columns for everyone on the team'}
                </small>
              </span>
            </button>
            {active && (
              <>
                <button type="button" className="line-menu-item" onClick={() => open('rename')}>
                  <Icon.Pen size={18} className="shrink-0 text-sub" />
                  Rename view
                </button>
                <button
                  type="button"
                  className="line-menu-item text-danger"
                  onClick={() => open('delete')}
                >
                  <Icon.Close size={18} className="shrink-0" />
                  Delete view
                </button>
              </>
            )}
          </>
        ) : (
          <p className="px-2.5 py-1.5 text-[13px] text-sub">
            Editors and admins can save views for the team.
          </p>
        )}
      </div>

      {canEdit && (
        <>
          <SaveViewDialog
            channelId={channelId}
            open={dialog === 'save'}
            summary={describeFilters(filters, segmentName)}
            columnCount={columns.length}
            onClose={() => setDialog(null)}
            onSave={(name) => ({ name, filters: viewFilters(filters, columns) })}
            onSaved={(view) =>
              onNotice(
                `Saved the view “${view.name}”. Everyone on the team can open it from Views.`,
              )
            }
          />
          {target && (
            <>
              <RenameViewDialog
                channelId={channelId}
                view={target}
                open={dialog === 'rename'}
                onClose={() => setDialog(null)}
                onRenamed={(view) => onNotice(`Renamed the view to “${view.name}”.`)}
              />
              <DeleteViewDialog
                channelId={channelId}
                view={target}
                open={dialog === 'delete'}
                onClose={() => setDialog(null)}
                onDeleted={(name) => onNotice(`Deleted the view “${name}”.`)}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function ViewItem({
  label,
  detail,
  current,
  onClick,
}: {
  label: string;
  detail: string;
  current: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="line-menu-item items-start"
      aria-current={current || undefined}
      onClick={onClick}
    >
      <span className="mt-0.5 size-[18px] shrink-0 text-purple">
        {current && <Icon.Check size={18} />}
      </span>
      <span className="min-w-0">
        <span className={`block truncate ${current ? 'font-semibold' : ''}`}>{label}</span>
        <small className="block text-[13px] leading-snug text-sub">{detail}</small>
      </span>
    </button>
  );
}

const nameError = (error: unknown) =>
  error instanceof ApiError
    ? (error.field('name') ?? (error.code === 'conflict' ? error.message : undefined))
    : undefined;
const otherError = (error: unknown) =>
  error instanceof Error && !nameError(error) ? error.message : null;

function SaveViewDialog({
  channelId,
  open,
  summary,
  columnCount,
  onClose,
  onSave,
  onSaved,
}: {
  channelId: string;
  open: boolean;
  summary: string;
  columnCount: number;
  onClose: () => void;
  onSave: (name: string) => Parameters<ReturnType<typeof useCreateMemberView>['mutate']>[0];
  onSaved: (view: MemberView) => void;
}) {
  const create = useCreateMemberView(channelId);
  const [name, setName] = useState('');
  const close = () => {
    create.reset();
    setName('');
    onClose();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(onSave(name), {
      onSuccess: (view) => {
        onSaved(view);
        close();
      },
    });
  };
  const columns = `${columnCount + 1} ${columnCount === 0 ? 'column' : 'columns'}`;
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Save view"
      description="Everyone on this publication’s team sees saved views in Views and in the command menu."
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="save-member-view" loading={create.isPending}>
            Save view
          </Button>
        </>
      }
    >
      <form id="save-member-view" onSubmit={submit} className="grid gap-4">
        <TextField
          label="Name"
          required
          maxLength={60}
          autoComplete="off"
          placeholder="Paid readers"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={nameError(create.error)}
        />
        <p className="text-[13.5px] text-sub">
          Saves {summary === 'No filters' ? 'no filters' : summary}, with the {columns} shown now.
        </p>
        {otherError(create.error) && <ErrorNotice message={otherError(create.error)!} />}
      </form>
    </Dialog>
  );
}

function RenameViewDialog({
  channelId,
  view,
  open,
  onClose,
  onRenamed,
}: {
  channelId: string;
  view: MemberView;
  open: boolean;
  onClose: () => void;
  onRenamed: (view: MemberView) => void;
}) {
  const rename = useUpdateMemberView(channelId);
  const [name, setName] = useState(view.name);
  const [shownFor, setShownFor] = useState<string | null>(null);
  // Start from the view's name each time the dialog opens.
  if (open && shownFor !== view.id) {
    setShownFor(view.id);
    setName(view.name);
  }
  if (!open && shownFor !== null) setShownFor(null);
  const close = () => {
    rename.reset();
    onClose();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    rename.mutate(
      { id: view.id, name },
      {
        onSuccess: (renamed) => {
          onRenamed(renamed);
          close();
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Rename view"
      description="The new name shows for everyone on the team."
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="rename-member-view" loading={rename.isPending}>
            Rename view
          </Button>
        </>
      }
    >
      <form id="rename-member-view" onSubmit={submit} className="grid gap-4">
        <TextField
          label="Name"
          required
          maxLength={60}
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={nameError(rename.error)}
        />
        {otherError(rename.error) && <ErrorNotice message={otherError(rename.error)!} />}
      </form>
    </Dialog>
  );
}

function DeleteViewDialog({
  channelId,
  view,
  open,
  onClose,
  onDeleted,
}: {
  channelId: string;
  view: MemberView;
  open: boolean;
  onClose: () => void;
  onDeleted: (name: string) => void;
}) {
  const remove = useDeleteMemberView(channelId);
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Delete this view?"
      description={`“${view.name}” goes for everyone on the team. The subscribers it shows don’t change, and the list keeps these filters until you change them.`}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(view.id, {
                onSuccess: () => {
                  onDeleted(view.name);
                  close();
                },
              })
            }
          >
            Delete view
          </Button>
        </>
      }
    >
      {remove.error && <ErrorNotice message={remove.error.message} />}
    </Dialog>
  );
}
