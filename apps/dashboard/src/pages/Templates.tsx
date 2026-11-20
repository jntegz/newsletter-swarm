// Template Library: the starters that ship with Swarm (./StarterTemplates), and saved Dispatch
// layouts for one Channel or every Channel of the workspace.
// Import an HTML email, export one, start a Dispatch from one; design templates sit behind the
// design_templates flag. SaveAsTemplateDialog is used by the Dispatch editor.
import type { Channel, Dispatch, TemplateSummary } from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { SelectField } from '../flows/Select';
import { ApiError } from '../api/client';
import {
  isFeatureDisabled,
  templateExportUrl,
  templatesQuery,
  useCreateTemplate,
  useDeleteTemplate,
  useImportTemplate,
  useSaveAsTemplate,
  useUpdateTemplate,
  useUseTemplate,
} from '../api/flows';
import * as Icon from '../icons';
import { useSession } from '../session';
import { PageHeader } from './Channels';
import { WithChannel, formatDay } from './common';
import { StarterTemplates } from './StarterTemplates';

const RANK = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 } as const;

export function TemplatesPage({ channelId }: { channelId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <WithChannel
      channelId={channelId}
      onChange={(id) => void navigate({ to: '/templates', search: { channel: id } })}
    >
      {(channel, picker) => <TemplateLibrary key={channel.id} channel={channel} picker={picker} />}
    </WithChannel>
  );
}

function TemplateLibrary({ channel, picker }: { channel: Channel; picker: ReactNode }) {
  const { workspace, can } = useSession();
  const templates = useQuery(templatesQuery(workspace.id, channel.id));
  const canWrite = RANK[channel.role] >= RANK.author;
  const canShare = can('editor');
  const [dialog, setDialog] = useState<'import' | 'design' | null>(null);
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const use = useUseTemplate();
  const update = useUpdateTemplate(workspace.id);
  const del = useDeleteTemplate(workspace.id);
  const navigate = useNavigate();

  const actions = canWrite && (
    <div className="flex flex-wrap gap-2">
      <Button variant="ghost" size="sm" onClick={() => setDialog('design')}>
        New design template
      </Button>
      <Button size="sm" icon={<Icon.Plus size={16} />} onClick={() => setDialog('import')}>
        Import HTML
      </Button>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Templates"
        subtitle={`Starters that come with Swarm, and post layouts saved for ${channel.name} and the rest of ${workspace.name}.`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            {picker}
            {actions}
          </div>
        }
      />
      <p role="status" className="mb-3 text-[13px] text-success empty:hidden">
        {message}
      </p>
      {(use.error || update.error) && (
        <div className="mb-4">
          <ErrorNotice message={(use.error ?? update.error)!.message} />
        </div>
      )}
      <StarterTemplates channel={channel} canWrite={canWrite} />
      <h2 className="mb-3 text-[15px] font-semibold">Your templates</h2>
      {templates.isPending && <LoadingRows label="Loading templates" />}
      {templates.error && (
        <ErrorNotice
          message={templates.error.message}
          action={
            <Button variant="ghost" onClick={() => void templates.refetch()}>
              Try again
            </Button>
          }
        />
      )}
      {templates.data?.length === 0 && (
        <EmptyState title="No saved templates yet" action={actions}>
          Save a post as a template from the editor, or import an HTML email you already use. The
          starters above are always here.
        </EmptyState>
      )}
      {!!templates.data?.length && (
        <div className="card-app overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13.5px]">
            <caption className="sr-only">Templates</caption>
            <thead>
              <tr className="table-head">
                <th scope="col" className="px-5 py-3 font-semibold">
                  Name
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Shared with
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Updated
                </th>
                <th scope="col" className="px-5 py-3 text-right font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {templates.data.map((t) => {
                const shared = t.channelId === null;
                const writable = shared ? canShare : canWrite;
                return (
                  <tr key={t.id} className="border-t border-line align-top">
                    <td className="px-5 py-3.5">
                      <span className="font-semibold">{t.name}</span>
                      {t.kind === 'design' && (
                        <span className="ml-2">
                          <Pill tone="brand">Design</Pill>
                        </span>
                      )}
                      <p className="mt-0.5 line-clamp-1 text-[12.5px] text-sub">
                        {t.description || t.subject || 'No subject'}
                      </p>
                    </td>
                    <td className="px-3 py-3.5 text-sub">
                      {shared ? 'Every publication' : channel.name}
                    </td>
                    <td className="tabular px-3 py-3.5 text-sub">{formatDay(t.updatedAt)}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {canWrite && (
                          <Button
                            size="sm"
                            loading={use.isPending && use.variables?.id === t.id}
                            onClick={() =>
                              use.mutate(
                                { id: t.id, channelId: channel.id },
                                {
                                  onSuccess: (d) =>
                                    void navigate({
                                      to: '/dispatches/$dispatchId',
                                      params: { dispatchId: d.id },
                                    }),
                                },
                              )
                            }
                          >
                            Use<span className="sr-only"> {t.name}</span>
                          </Button>
                        )}
                        <a href={templateExportUrl(t.id)} download className="btn-ghost btn-sm">
                          Export HTML<span className="sr-only"> of {t.name}</span>
                        </a>
                        {writable && canShare && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              update.mutate(
                                { id: t.id, channelId: shared ? channel.id : null },
                                {
                                  onSuccess: () =>
                                    setMessage(
                                      shared
                                        ? `${t.name} is now kept to ${channel.name}.`
                                        : `${t.name} is now shared with every publication.`,
                                    ),
                                },
                              )
                            }
                          >
                            {shared ? 'Keep to this publication' : 'Share with workspace'}
                            <span className="sr-only"> ({t.name})</span>
                          </Button>
                        )}
                        {writable && (
                          <Button variant="quiet" size="sm" onClick={() => setDeleting(t)}>
                            Delete<span className="sr-only"> {t.name}</span>
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {dialog === 'import' && (
        <ImportDialog
          channel={channel}
          canShare={canShare}
          onClose={() => setDialog(null)}
          onDone={(name) => setMessage(`${name} was imported.`)}
        />
      )}
      {dialog === 'design' && (
        <DesignDialog
          channel={channel}
          onClose={() => setDialog(null)}
          onDone={(name) => setMessage(`${name} was created.`)}
        />
      )}
      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete this template?"
        description={
          deleting
            ? `“${deleting.name}” is removed from the library. Posts made from it stay as they are.`
            : undefined
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() =>
                deleting &&
                del.mutate(deleting.id, {
                  onSuccess: () => {
                    setMessage(`${deleting.name} was deleted.`);
                    setDeleting(null);
                  },
                })
              }
            >
              Delete template
            </Button>
          </>
        }
      >
        {del.error && <ErrorNotice message={del.error.message} />}
      </Dialog>
    </>
  );
}

function ScopeField({
  channel,
  canShare,
  value,
  onChange,
}: {
  channel: Channel;
  canShare: boolean;
  value: 'channel' | 'workspace';
  onChange: (value: 'channel' | 'workspace') => void;
}) {
  if (!canShare) return null;
  return (
    <SelectField
      label="Who can use it"
      value={value}
      onChange={(e) => onChange(e.target.value as 'channel' | 'workspace')}
    >
      <option value="channel">{channel.name} only</option>
      <option value="workspace">Every publication in the workspace</option>
    </SelectField>
  );
}

function ImportDialog({
  channel,
  canShare,
  onClose,
  onDone,
}: {
  channel: Channel;
  canShare: boolean;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const { workspace } = useSession();
  const importTemplate = useImportTemplate(workspace.id);
  const [name, setName] = useState('Imported template');
  const [html, setHtml] = useState('');
  const [scope, setScope] = useState<'channel' | 'workspace'>('channel');
  const [fileError, setFileError] = useState<string>();
  const error = importTemplate.error instanceof ApiError ? importTemplate.error : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Import an HTML email"
      description="The email body becomes one HTML block. It can be sent only where raw HTML is enabled."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!html.trim() || !name.trim()}
            loading={importTemplate.isPending}
            onClick={() =>
              importTemplate.mutate(
                { name: name.trim(), html, channelId: scope === 'workspace' ? null : channel.id },
                {
                  onSuccess: (t) => {
                    onDone(t.name);
                    onClose();
                  },
                },
              )
            }
          >
            Import
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <TextField
          label="Name"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <ScopeField channel={channel} canShare={canShare} value={scope} onChange={setScope} />
        <div className="grid gap-1.5">
          <label htmlFor="template-file" className="text-[13px] font-semibold">
            HTML file
          </label>
          <input
            id="template-file"
            type="file"
            accept=".html,.htm,text/html"
            className="text-[13px]"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 50_000) {
                setFileError('The file is larger than 50 KB.');
                return;
              }
              setFileError(undefined);
              setHtml(await file.text());
            }}
          />
          {fileError && (
            <p role="alert" className="text-[12.5px] font-semibold text-danger">
              {fileError}
            </p>
          )}
        </div>
        <TextAreaField
          label="Or paste the HTML"
          rows={5}
          maxLength={50_000}
          value={html}
          error={error?.field('html')}
          onChange={(e) => setHtml(e.target.value)}
        />
        {importTemplate.error && !error?.field('html') && (
          <ErrorNotice title="Not imported" message={importTemplate.error.message} />
        )}
      </div>
    </Dialog>
  );
}

function DesignDialog({
  channel,
  onClose,
  onDone,
}: {
  channel: Channel;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const { workspace } = useSession();
  const create = useCreateTemplate(workspace.id);
  const [name, setName] = useState('');
  const off = isFeatureDisabled(create.error);
  return (
    <Dialog
      open
      onClose={onClose}
      title="New design template"
      description="A design template keeps a look (header, footer, buttons) without the words."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {off ? 'Close' : 'Cancel'}
          </Button>
          {!off && (
            <Button
              disabled={!name.trim()}
              loading={create.isPending}
              onClick={() =>
                create.mutate(
                  {
                    channelId: channel.id,
                    name: name.trim(),
                    kind: 'design',
                    content: { type: 'doc', content: [{ type: 'paragraph' }] },
                  },
                  {
                    onSuccess: (t) => {
                      onDone(t.name);
                      onClose();
                    },
                  },
                )
              }
            >
              Create
            </Button>
          )}
        </>
      }
    >
      {off ? (
        <ErrorNotice
          title="Design templates are not turned on"
          message="Design templates are an optional feature. A workspace admin can ask for it to be enabled; until then, save posts as templates instead."
        />
      ) : (
        <>
          <TextField
            label="Name"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {create.error && (
            <div className="mt-3">
              <ErrorNotice title="Not created" message={create.error.message} />
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

/** "Save as template" from the Dispatch editor. */
export function SaveAsTemplateDialog({
  dispatch,
  onClose,
}: {
  dispatch: Pick<Dispatch, 'id' | 'subject' | 'channelId'>;
  onClose: () => void;
}) {
  const { workspace, can } = useSession();
  const save = useSaveAsTemplate(workspace.id, dispatch.id);
  const [name, setName] = useState(dispatch.subject || 'Untitled template');
  const [description, setDescription] = useState('');
  const [shared, setShared] = useState(false);
  const error = save.error instanceof ApiError ? save.error : null;

  if (save.data) {
    return (
      <Dialog
        open
        onClose={onClose}
        title="Saved as a template"
        description={`${save.data.name} is in the Template Library${shared ? ' for every publication' : ''}.`}
        actions={<Button onClick={onClose}>Done</Button>}
      />
    );
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Save as template"
      description="Keeps the subject, preview text and body, so new posts can start from them."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim()}
            loading={save.isPending}
            onClick={() =>
              save.mutate({
                name: name.trim(),
                ...(description.trim() ? { description: description.trim() } : {}),
                shared,
              })
            }
          >
            Save template
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <TextField
          label="Template name"
          maxLength={80}
          value={name}
          error={error?.field('name')}
          onChange={(e) => setName(e.target.value)}
        />
        <TextAreaField
          label="Description"
          hint="Optional."
          rows={2}
          maxLength={280}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {can('editor') && (
          <label className="flex items-center gap-2.5 text-[13.5px]">
            <input
              type="checkbox"
              className="size-4 accent-purple"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
            />
            Share with every publication in the workspace
          </label>
        )}
        {save.error && !error?.field('name') && (
          <ErrorNotice title="Not saved" message={save.error.message} />
        )}
      </div>
    </Dialog>
  );
}
