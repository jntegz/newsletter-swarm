// Channel settings → Fields and tags: profile fields (type and encryption fixed once created) and
// tags with their Member counts.
import type { Channel, FieldType, MemberField, Tag } from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  memberFieldsQuery,
  tagsQuery,
  useCreateMemberField,
  useCreateTag,
  useDeleteMemberField,
  useDeleteTag,
  useRenameTag,
  useUpdateMemberField,
} from '../api/members';
import { channelQuery } from '../api/queries';
import { PageHeader } from './Channels';
import { Section, numberFormat } from './common';
import { FIELD_TYPE_LABEL, keyFromLabel } from './members-helpers';

const RANK = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 } as const;

export function MemberSettingsPage({ channelId }: { channelId: string }) {
  const channel = useQuery(channelQuery(channelId));
  if (channel.isPending) return <LoadingRows label="Loading publication" rows={4} />;
  if (channel.error)
    return <ErrorNotice title="Publication not available" message={channel.error.message} />;
  return <MemberSettings channel={channel.data} />;
}

function MemberSettings({ channel }: { channel: Channel }) {
  const canEdit = RANK[channel.role] >= RANK.editor;
  return (
    <>
      <PageHeader
        title="Fields and tags"
        subtitle={`Profile fields and tags for subscribers of ${channel.name}.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/channels/$channelId"
              params={{ channelId: channel.id }}
              className="btn-ghost"
            >
              Publication settings
            </Link>
            <Link to="/members" search={{ channel: channel.id }} className="btn-ghost">
              Subscribers
            </Link>
            {RANK[channel.role] >= RANK.admin && (
              <Link
                to="/channels/$channelId/export-destinations"
                params={{ channelId: channel.id }}
                className="btn-ghost"
              >
                Export destinations
              </Link>
            )}
          </div>
        }
      />
      <div className="grid max-w-[880px] gap-5">
        <FieldsSection channelId={channel.id} canEdit={canEdit} />
        <TagsSection channelId={channel.id} canEdit={canEdit} />
      </div>
    </>
  );
}

// ---- Profile fields --------------------------------------------------------------------------

const isChoice = (type: FieldType) => type === 'select' || type === 'multi_select';
const choicesFrom = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

type FieldDialogState = { mode: 'create' } | { mode: 'edit'; field: MemberField } | null;

function FieldsSection({ channelId, canEdit }: { channelId: string; canEdit: boolean }) {
  const fields = useQuery(memberFieldsQuery(channelId));
  const [dialog, setDialog] = useState<FieldDialogState>(null);
  const [deleting, setDeleting] = useState<MemberField | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const openDialog = (state: FieldDialogState) => {
    setDialogKey((k) => k + 1);
    setDialog(state);
  };

  return (
    <Section
      title="Profile fields"
      description="Extra details you keep about each subscriber, usable in merge tags as {{fields.key}} and in segment rules."
      action={
        canEdit &&
        !!fields.data?.length && (
          <Button size="sm" onClick={() => openDialog({ mode: 'create' })}>
            Add profile field
          </Button>
        )
      }
    >
      {fields.isPending && <LoadingRows label="Loading profile fields" rows={2} />}
      {fields.error && <ErrorNotice message={fields.error.message} />}
      {fields.data?.length === 0 && (
        <EmptyState
          title="No profile fields yet"
          action={
            canEdit && (
              <Button size="sm" onClick={() => openDialog({ mode: 'create' })}>
                Add profile field
              </Button>
            )
          }
        >
          Add a field for anything you want to remember about subscribers, like a company or a
          birthday.
        </EmptyState>
      )}
      {!!fields.data?.length && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[13.5px]">
            <thead>
              <tr className="table-head">
                <th scope="col" className="py-2 pr-3 font-semibold">
                  Label
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Key
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Type
                </th>
                <th scope="col" className="py-2 pl-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {fields.data.map((field) => (
                <tr key={field.id} className="border-t border-line">
                  <td className="py-2.5 pr-3 font-semibold">
                    {field.label}
                    {field.encrypted && (
                      <span className="ml-2">
                        <Pill tone="brand">Encrypted</Pill>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[12.5px]">{field.key}</td>
                  <td className="px-3 py-2.5 text-sub">
                    {FIELD_TYPE_LABEL[field.type]}
                    {isChoice(field.type) &&
                      ` · ${field.options.length} ${field.options.length === 1 ? 'choice' : 'choices'}`}
                  </td>
                  <td className="py-2 pl-3 text-right whitespace-nowrap">
                    {canEdit && (
                      <>
                        <Button
                          variant="quiet"
                          size="sm"
                          aria-label={`Edit ${field.label}`}
                          onClick={() => openDialog({ mode: 'edit', field })}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="quiet"
                          size="sm"
                          aria-label={`Delete ${field.label}`}
                          onClick={() => setDeleting(field)}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialog && (
        <FieldDialog
          key={dialogKey}
          channelId={channelId}
          state={dialog}
          onClose={() => setDialog(null)}
        />
      )}
      <DeleteFieldDialog channelId={channelId} field={deleting} onClose={() => setDeleting(null)} />
    </Section>
  );
}

function FieldDialog({
  channelId,
  state,
  onClose,
}: {
  channelId: string;
  state: NonNullable<FieldDialogState>;
  onClose: () => void;
}) {
  const editing = state.mode === 'edit' ? state.field : null;
  const create = useCreateMemberField(channelId);
  const update = useUpdateMemberField(channelId);
  const mutation = editing ? update : create;
  const [open, setOpen] = useState(true);
  const [label, setLabel] = useState(editing?.label ?? '');
  const [key, setKey] = useState(editing?.key ?? '');
  const [keyEdited, setKeyEdited] = useState(false);
  const [type, setType] = useState<FieldType>(editing?.type ?? 'text');
  const [choices, setChoices] = useState(editing?.options.join('\n') ?? '');
  const [encrypted, setEncrypted] = useState(editing?.encrypted ?? false);
  const error = mutation.error instanceof ApiError ? mutation.error : null;
  const shownKey = editing || keyEdited ? key : keyFromLabel(label);

  const close = () => setOpen(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const options = isChoice(type) ? choicesFrom(choices) : undefined;
    if (editing) {
      update.mutate(
        {
          id: editing.id,
          label: label.trim(),
          ...(options ? { options } : {}),
        },
        { onSuccess: close },
      );
    } else {
      create.mutate(
        {
          key: shownKey,
          label: label.trim(),
          type,
          encrypted,
          ...(options ? { options } : {}),
        },
        { onSuccess: close },
      );
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${editing.label}` : 'Add a profile field'}
      description={
        editing
          ? 'The key, type and encryption are fixed once a field is created. To change them, add a new field.'
          : 'The type and encryption can’t change later.'
      }
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="member-field" loading={mutation.isPending}>
            {editing ? 'Save field' : 'Add field'}
          </Button>
        </>
      }
    >
      <form id="member-field" onSubmit={submit} className="grid gap-4">
        <TextField
          label="Label"
          required
          maxLength={80}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          error={error?.field('label')}
        />
        {editing ? (
          <p className="text-[13px] text-sub">
            Key <code className="font-mono text-ink">{editing.key}</code> ·{' '}
            {FIELD_TYPE_LABEL[editing.type]}
            {editing.encrypted ? ' · Encrypted' : ''}
          </p>
        ) : (
          <>
            <TextField
              label="Key"
              required
              maxLength={40}
              pattern="[a-z][a-z0-9_]{0,39}"
              hint={
                <>
                  Used in merge tags as{' '}
                  <code className="font-mono">{`{{fields.${shownKey || 'key'}}}`}</code>. Lowercase
                  letters, digits and underscores.
                </>
              }
              value={shownKey}
              onChange={(e) => {
                setKeyEdited(true);
                setKey(e.target.value);
              }}
              error={error?.field('key')}
            />
            <SelectField
              label="Type"
              value={type}
              onChange={(e) => setType(e.target.value as FieldType)}
              options={(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map((t) => ({
                value: t,
                label: FIELD_TYPE_LABEL[t],
              }))}
              error={error?.field('type')}
            />
          </>
        )}
        {isChoice(type) && (
          <TextAreaField
            label="Choices"
            hint="One per line, up to 100."
            required
            value={choices}
            onChange={(e) => setChoices(e.target.value)}
            error={error?.details.find((d) => d.path.startsWith('options'))?.message}
          />
        )}
        {!editing && (
          <div className="rounded-card-app border border-line-app bg-surface-alt p-3.5">
            <label className="flex cursor-pointer items-start gap-2.5 text-[13.5px] font-semibold">
              <input
                type="checkbox"
                checked={encrypted}
                onChange={(e) => setEncrypted(e.target.checked)}
                aria-describedby="member-field-encrypted-hint"
                className="mt-0.5 size-4 shrink-0 accent-purple"
              />
              Encrypt this field
            </label>
            <p id="member-field-encrypted-hint" className="mt-1.5 pl-[26px] text-[12.5px] text-sub">
              For sensitive details. Values are encrypted when stored, and segments can only test
              whether the field is set.
            </p>
          </div>
        )}
        {error && (error.code === 'conflict' || !error.details.length) && (
          <ErrorNotice
            title={error.code === 'conflict' ? 'Not saved' : 'Something went wrong'}
            message={error.message}
          />
        )}
      </form>
    </Dialog>
  );
}

function DeleteFieldDialog({
  channelId,
  field,
  onClose,
}: {
  channelId: string;
  field: MemberField | null;
  onClose: () => void;
}) {
  const remove = useDeleteMemberField(channelId);
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog
      open={!!field}
      onClose={close}
      title={`Delete ${field?.label ?? 'this field'}?`}
      description="Every subscriber’s value for it is erased. Merge tags and segment rules that use it stop matching. This can’t be undone."
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Keep
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => field && remove.mutate(field.id, { onSuccess: close })}
          >
            Delete field
          </Button>
        </>
      }
    >
      {remove.error && <ErrorNotice message={remove.error.message} />}
    </Dialog>
  );
}

// ---- Tags ------------------------------------------------------------------------------------

type TagDialogState = { mode: 'create' } | { mode: 'rename'; tag: Tag } | null;

function TagsSection({ channelId, canEdit }: { channelId: string; canEdit: boolean }) {
  const tags = useQuery(tagsQuery(channelId));
  const [dialog, setDialog] = useState<TagDialogState>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [deleting, setDeleting] = useState<Tag | null>(null);
  const openDialog = (state: TagDialogState) => {
    setDialogKey((k) => k + 1);
    setDialog(state);
  };

  return (
    <Section
      title="Tags"
      description="Labels you add to subscribers by hand, in bulk or from an import."
      action={
        canEdit &&
        !!tags.data?.length && (
          <Button size="sm" onClick={() => openDialog({ mode: 'create' })}>
            Create tag
          </Button>
        )
      }
    >
      {tags.isPending && <LoadingRows label="Loading tags" rows={2} />}
      {tags.error && <ErrorNotice message={tags.error.message} />}
      {tags.data?.length === 0 && (
        <EmptyState
          title="No tags yet"
          action={
            canEdit && (
              <Button size="sm" onClick={() => openDialog({ mode: 'create' })}>
                Create tag
              </Button>
            )
          }
        >
          Tags group subscribers by hand. Imports add one automatically.
        </EmptyState>
      )}
      {!!tags.data?.length && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-[13.5px]">
            <thead>
              <tr className="table-head">
                <th scope="col" className="py-2 pr-3 font-semibold">
                  Tag
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Subscribers
                </th>
                <th scope="col" className="py-2 pl-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tags.data.map((tag) => (
                <tr key={tag.id} className="border-t border-line">
                  <td className="py-2.5 pr-3 font-semibold break-all">{tag.name}</td>
                  <td className="tabular px-3 py-2.5 text-sub">
                    {numberFormat.format(tag.memberCount)}
                  </td>
                  <td className="py-2 pl-3 text-right whitespace-nowrap">
                    {canEdit && (
                      <>
                        <Button
                          variant="quiet"
                          size="sm"
                          aria-label={`Rename ${tag.name}`}
                          onClick={() => openDialog({ mode: 'rename', tag })}
                        >
                          Rename
                        </Button>
                        <Button
                          variant="quiet"
                          size="sm"
                          aria-label={`Delete ${tag.name}`}
                          onClick={() => setDeleting(tag)}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dialog && (
        <TagDialog
          key={dialogKey}
          channelId={channelId}
          state={dialog}
          onClose={() => setDialog(null)}
        />
      )}
      <DeleteTagDialog channelId={channelId} tag={deleting} onClose={() => setDeleting(null)} />
    </Section>
  );
}

function TagDialog({
  channelId,
  state,
  onClose,
}: {
  channelId: string;
  state: NonNullable<TagDialogState>;
  onClose: () => void;
}) {
  const renaming = state.mode === 'rename' ? state.tag : null;
  const create = useCreateTag(channelId);
  const rename = useRenameTag(channelId);
  const mutation = renaming ? rename : create;
  const [open, setOpen] = useState(true);
  const [name, setName] = useState(renaming?.name ?? '');
  const error = mutation.error instanceof ApiError ? mutation.error : null;
  const close = () => setOpen(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (renaming) rename.mutate({ id: renaming.id, name: name.trim() }, { onSuccess: close });
    else create.mutate(name.trim(), { onSuccess: close });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={renaming ? `Rename ${renaming.name}` : 'Create a tag'}
      description={
        renaming
          ? `The new name applies to all ${numberFormat.format(renaming.memberCount)} subscribers who have it.`
          : undefined
      }
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="tag-form" loading={mutation.isPending}>
            {renaming ? 'Rename tag' : 'Create tag'}
          </Button>
        </>
      }
    >
      <form id="tag-form" onSubmit={submit}>
        <TextField
          label="Name"
          required
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error?.field('name') ?? (error ? error.message : undefined)}
        />
      </form>
    </Dialog>
  );
}

function DeleteTagDialog({
  channelId,
  tag,
  onClose,
}: {
  channelId: string;
  tag: Tag | null;
  onClose: () => void;
}) {
  const remove = useDeleteTag(channelId);
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog
      open={!!tag}
      onClose={close}
      title={`Delete ${tag?.name ?? 'this tag'}?`}
      description={
        tag
          ? `It is removed from ${numberFormat.format(tag.memberCount)} ${tag.memberCount === 1 ? 'subscriber' : 'subscribers'}. The subscribers stay.`
          : undefined
      }
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Keep
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => tag && remove.mutate(tag.id, { onSuccess: close })}
          >
            Delete tag
          </Button>
        </>
      }
    >
      {remove.error && <ErrorNotice message={remove.error.message} />}
    </Dialog>
  );
}
