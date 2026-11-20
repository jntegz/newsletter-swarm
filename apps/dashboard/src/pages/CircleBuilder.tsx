import type { Channel, Circle, CircleGroup, CirclePreview } from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Spinner,
  Tabs,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  circleMembersQuery,
  circlePreviewQuery,
  circleQuery,
  isEvaluating,
  memberFieldsQuery,
  tagsQuery,
  useCreateCircle,
  useDebounced,
  useDeleteCircle,
  useRefreshCircle,
  useUpdateCircle,
} from '../api/circles';
import { ApiError } from '../api/client';
import { dispatchQuery, useSaveDispatch } from '../api/send';
import { levelsQuery } from '../api/money';
import { channelQuery, useChannelFlag } from '../api/queries';
import { RuleEditor } from '../circles/RuleEditor';
import {
  asRootGroup,
  fieldCatalogue,
  membershipLeaves,
  newCondition,
  serverRuleErrors,
  validateRule,
  type FieldSpec,
} from '../circles/rules';
import { CirclePill, MemberRows, evaluationNote } from '../circles/status';
import { UnsavedBar } from '../shell/UnsavedBar';
import { PageHeader } from './Channels';
import { BulkBar } from './MemberBulk';
import { Bands, Section, WithChannel, numberFormat } from './common';

const PREVIEW_DEBOUNCE_MS = 400;

export function NewCirclePage({
  channelId,
  forPost,
}: {
  channelId: string | undefined;
  /** The draft whose send panel asked for this segment. */
  forPost?: string | undefined;
}) {
  const navigate = useNavigate();
  return (
    <WithChannel
      channelId={channelId}
      onChange={(id) => void navigate({ to: '/circles/new', search: { channel: id } })}
    >
      {(channel, picker) => (
        <WithCatalogue key={channel.id} channel={channel}>
          {(catalogue) => (
            <CircleBuilder
              channel={channel}
              catalogue={catalogue}
              // Another publication's segment can't go on this post, so the picker goes too.
              picker={forPost ? undefined : picker}
              {...(forPost ? { forPost } : {})}
            />
          )}
        </WithCatalogue>
      )}
    </WithChannel>
  );
}

export function CirclePage({ circleId }: { circleId: string }) {
  const circle = useQuery(circleQuery(circleId));
  const channel = useQuery({
    ...channelQuery(circle.data?.channelId ?? ''),
    enabled: !!circle.data,
  });
  if (circle.error || channel.error) {
    return (
      <ErrorNotice
        title="Segment not available"
        message={(circle.error ?? channel.error)?.message ?? ''}
        action={
          <Link to="/circles" className="btn-ghost">
            Back to segments
          </Link>
        }
      />
    );
  }
  if (!circle.data || !channel.data) return <LoadingRows label="Loading segment" rows={5} />;
  return (
    <WithCatalogue channel={channel.data}>
      {(catalogue) => (
        <CircleBuilder
          key={circle.data.id}
          channel={channel.data}
          circle={circle.data}
          catalogue={catalogue}
        />
      )}
    </WithCatalogue>
  );
}

/** Loads the Channel's profile fields and tags, which conditions can test. */
function WithCatalogue({
  channel,
  children,
}: {
  channel: Channel;
  children: (catalogue: FieldSpec[]) => ReactNode;
}) {
  const fields = useQuery(memberFieldsQuery(channel.id));
  const tags = useQuery(tagsQuery(channel.id));
  const levels = useQuery(levelsQuery(channel.id));
  const engagementScores = useChannelFlag(channel.id, 'engagement_scores') === true;
  const emailChecks = useChannelFlag(channel.id, 'email_verification') === true;
  const catalogue = useMemo(
    () => [
      ...fieldCatalogue(fields.data ?? [], tags.data ?? [], { engagementScores, emailChecks }),
      // Only Membership levels: a segment built from other segments would hide what it depends on.
      ...membershipLeaves([], levels.data?.items ?? []).filter((spec) => spec.value === 'level'),
    ],
    [fields.data, tags.data, levels.data, engagementScores, emailChecks],
  );
  if (fields.isPending || tags.isPending) return <LoadingRows label="Loading fields" rows={4} />;
  const error = fields.error ?? tags.error;
  return (
    <>
      {error && (
        <div className="mb-4">
          <ErrorNotice
            title="Profile fields or tags didn’t load"
            message={`${error.message} Conditions on them aren’t available until they do.`}
            action={
              <Button
                variant="ghost"
                onClick={() => {
                  void fields.refetch();
                  void tags.refetch();
                }}
              >
                Try again
              </Button>
            }
          />
        </div>
      )}
      {children(catalogue)}
    </>
  );
}

type Tab = 'rule' | 'members';

function CircleBuilder({
  channel,
  circle,
  catalogue,
  picker,
  forPost,
}: {
  channel: Channel;
  circle?: Circle;
  catalogue: FieldSpec[];
  picker?: ReactNode;
  /** Set when a post's send panel asked for this segment: it goes on that post, then back. */
  forPost?: string;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const addToPost = useSaveDispatch(forPost ?? '');
  const readOnly = channel.role === 'viewer';
  const savedRule = useMemo(() => (circle ? asRootGroup(circle.rule) : null), [circle]);
  const [name, setName] = useState(circle?.name ?? '');
  const [description, setDescription] = useState(circle?.description ?? '');
  const [rule, setRule] = useState<CircleGroup>(
    () => savedRule ?? { op: 'and', children: [newCondition(catalogue, 'tag')] },
  );
  const [showErrors, setShowErrors] = useState(false);
  const [tab, setTab] = useState<Tab>('rule');
  const [deleting, setDeleting] = useState(false);

  const create = useCreateCircle(channel.id);
  const update = useUpdateCircle({ id: circle?.id ?? '', channelId: channel.id });
  const refresh = useRefreshCircle({ id: circle?.id ?? '', channelId: channel.id });
  const save = circle ? update : create;

  const ruleJson = JSON.stringify(rule);
  const dirty =
    !circle ||
    name !== circle.name ||
    description !== (circle.description ?? '') ||
    ruleJson !== JSON.stringify(savedRule);

  // Client checks mirror the compiler, so the preview only runs on a rule it can evaluate.
  const clientErrors = useMemo(() => validateRule(rule, catalogue), [rule, catalogue]);
  const complete = Object.keys(clientErrors).length === 0;
  const debounced = useDebounced(complete ? rule : null, PREVIEW_DEBOUNCE_MS);
  const preview = useQuery(circlePreviewQuery(channel.id, debounced));

  // Server errors apply to the rule they were reported for; editing clears them.
  const [saveError, setSaveError] = useState<{ rule: string; error: ApiError } | null>(null);
  const previewError = preview.error instanceof ApiError ? preview.error : null;
  const errors = {
    ...(showErrors ? clientErrors : {}),
    ...(previewError && debounced && JSON.stringify(debounced) === ruleJson
      ? serverRuleErrors(previewError.details)
      : {}),
    ...(saveError && saveError.rule === ruleJson ? serverRuleErrors(saveError.error.details) : {}),
  };
  const nameError =
    (showErrors && !name.trim() ? 'Name the segment.' : undefined) ??
    saveError?.error.field('name');
  const descriptionError = saveError?.error.field('description');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setShowErrors(true);
    setSaveError(null);
    if (!name.trim() || !complete) return;
    const submitted = ruleJson;
    const onError = (error: Error) => {
      if (error instanceof ApiError) setSaveError({ rule: submitted, error });
    };
    if (circle) {
      update.mutate(
        {
          ...(name !== circle.name ? { name: name.trim() } : {}),
          ...(description !== (circle.description ?? '')
            ? { description: description.trim() || null }
            : {}),
          ...(ruleJson !== JSON.stringify(savedRule) ? { rule } : {}),
        },
        { onError, onSuccess: () => setShowErrors(false) },
      );
    } else {
      create.mutate(
        { name: name.trim(), description: description.trim() || null, rule },
        {
          onError,
          onSuccess: async (created) => {
            if (forPost) {
              // The new segment goes on the post's audience, and the writer goes back to the post
              // with it chosen. If that fails, the segment still exists and the post says so.
              try {
                const post = await client.fetchQuery(dispatchQuery(forPost));
                const include = [...new Set([...post.audience.include, created.id])];
                await addToPost.mutateAsync({
                  audience: {
                    ...post.audience,
                    include,
                    exclude: post.audience.exclude.filter((id) => id !== created.id),
                  },
                });
              } catch {
                // The send panel shows the audience as it is; the segment can be picked there.
              }
              void navigate({
                to: '/dispatches/$dispatchId',
                params: { dispatchId: forPost },
                replace: true,
              });
              return;
            }
            void navigate({
              to: '/circles/$circleId',
              params: { circleId: created.id },
              replace: true,
            });
          },
        },
      );
    }
  };

  const blocked = showErrors && (!complete || !name.trim());

  return (
    <>
      <PageHeader
        title={circle ? circle.name : 'New segment'}
        subtitle={
          circle
            ? `A segment in ${channel.name}.`
            : forPost
              ? `Subscribers of ${channel.name} who match a rule. Once it’s created, it goes on your post and you go back to it.`
              : `Subscribers of ${channel.name} who match a rule.`
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            {picker}
            {forPost ? (
              <Link
                to="/dispatches/$dispatchId"
                params={{ dispatchId: forPost }}
                className="btn-quiet"
              >
                Back to the post
              </Link>
            ) : (
              <Link to="/circles" search={{ channel: channel.id }} className="btn-quiet">
                All segments
              </Link>
            )}
            {circle && !readOnly && (
              <Button
                variant="ghost"

                loading={refresh.isPending}
                disabled={isEvaluating(circle)}
                onClick={() => refresh.mutate()}
              >
                Refresh now
              </Button>
            )}
            {circle && !readOnly && (
              <Button variant="quiet" onClick={() => setDeleting(true)}>
                Delete
              </Button>
            )}
            {/* A saved segment's changes go through the Unsaved changes bar below. */}
            {!readOnly && !circle && (
              <Button type="submit" form="circle-form" loading={save.isPending}>
                Create segment
              </Button>
            )}
          </div>
        }
      />

      {circle && (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px]"
        >
          <CirclePill status={circle.status} />
          <span className="tabular font-semibold">
            {numberFormat.format(circle.memberCount)} subscriber
            {circle.memberCount === 1 ? '' : 's'}
          </span>
          <span className={circle.status === 'failed' ? 'text-danger' : 'text-sub'}>
            {evaluationNote(circle)}
          </span>
        </div>
      )}
      {refresh.error && <ErrorNotice title="Not refreshed" message={refresh.error.message} />}

      {circle && (
        <CircleTabs
          tab={tab}
          onChange={setTab}
          tabs={[
            { id: 'rule', label: 'Rule' },
            { id: 'members', label: `Subscribers (${numberFormat.format(circle.memberCount)})` },
          ]}
        />
      )}

      <div
        role={circle ? 'tabpanel' : undefined}
        id="circle-panel-rule"
        aria-labelledby={circle ? 'circle-tab-rule' : undefined}
        hidden={tab !== 'rule'}
      >
        <form id="circle-form" noValidate onSubmit={submit} className="grid">
          {save.error && !(save.error instanceof ApiError && save.error.details.length) && (
            <div className="mb-4">
              <ErrorNotice title="Not saved" message={save.error.message} />
            </div>
          )}
          {blocked && (
            <div className="mb-4">
              <ErrorNotice
                title="Not saved yet"
                message="Some parts of the segment need attention. They are marked below."
              />
            </div>
          )}
          <Bands ruled={!circle}>
            <Section title="Details">
              <div className="grid gap-4 md:grid-cols-2">
                <TextField
                  label="Name"
                  value={name}
                  maxLength={80}
                  required
                  readOnly={readOnly}
                  error={nameError}
                  onChange={(e) => setName(e.target.value)}
                />
                <TextAreaField
                  label="Description"
                  hint="Optional. Only your team sees it."
                  value={description}
                  maxLength={280}
                  rows={2}
                  readOnly={readOnly}
                  error={descriptionError}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </Section>

            <Section
              title="Rule"
              description="Subscribers are in the segment while they match. Segments update as subscriber data changes."
              action={
                <CountPill
                  complete={complete}
                  settling={complete && JSON.stringify(debounced) !== ruleJson}
                  preview={preview}
                />
              }
            >
              <RuleEditor
                root={rule}
                onChange={setRule}
                catalogue={catalogue}
                errors={errors}
                readOnly={readOnly}
              />
            </Section>

            <Section
              title="Who matches now"
              description="Up to 25 matching subscribers, newest first, for the rule as it stands, saved or not."
            >
              {!complete ? (
                <p className="text-[13.5px] text-sub">
                  Complete each condition to see who matches.
                </p>
              ) : preview.isPending ? (
                <LoadingRows label="Finding matching subscribers" rows={3} />
              ) : preview.error ? (
                <ErrorNotice title="Couldn’t count" message={preview.error.message} />
              ) : preview.data.sample.length === 0 ? (
                <p className="text-[13.5px] text-sub">No subscribers match this rule yet.</p>
              ) : (
                <MemberRows members={preview.data.sample} caption="Subscribers matching the rule" />
              )}
            </Section>
          </Bands>
          {circle && !readOnly && (
            <UnsavedBar
              label="Unsaved changes to the segment"
              dirty={dirty}
              pending={save.isPending}
              form="circle-form"
              onDiscard={() => {
                setName(circle.name);
                setDescription(circle.description ?? '');
                if (savedRule) setRule(savedRule);
                setShowErrors(false);
                setSaveError(null);
              }}
            />
          )}
        </form>
      </div>

      {circle && (
        <div
          role="tabpanel"
          id="circle-panel-members"
          aria-labelledby="circle-tab-members"
          hidden={tab !== 'members'}
        >
          {tab === 'members' && <CircleMembers circle={circle} onEdit={() => setTab('rule')} />}
        </div>
      )}

      {circle && (
        <DeleteDialog
          circle={circle}
          open={deleting}
          onClose={() => setDeleting(false)}
          onDeleted={() => void navigate({ to: '/circles', search: { channel: channel.id } })}
        />
      )}
    </>
  );
}

function CountPill({
  complete,
  settling,
  preview,
}: {
  complete: boolean;
  /** The rule changed and the debounced count hasn't caught up yet. */
  settling: boolean;
  preview: UseQueryResult<CirclePreview>;
}) {
  let text: string;
  if (!complete) text = 'Complete each condition to count';
  else if (preview.isPending) text = 'Counting…';
  else if (preview.error) text = 'Count unavailable';
  else {
    const { count, activeCount } = preview.data;
    text = `${numberFormat.format(count)} ${count === 1 ? 'subscriber matches' : 'subscribers match'} · ${numberFormat.format(activeCount)} active`;
  }
  const updating = complete && !preview.isPending && (settling || preview.isFetching);
  return (
    <p
      aria-live="polite"
      aria-atomic="true"
      aria-busy={updating || undefined}
      data-testid="circle-count"
      className="tabular inline-flex min-h-9 items-center gap-2 rounded-pill bg-lavender px-3.5 text-[13px] font-semibold text-purple-deep"
    >
      {updating && <Spinner />}
      {text}
    </p>
  );
}

function CircleTabs({
  tab,
  onChange,
  tabs,
}: {
  tab: Tab;
  onChange: (tab: Tab) => void;
  tabs: { id: Tab; label: string }[];
}) {
  return (
    <div className="mb-4">
      <Tabs
        label="Segment"
        tabs={tabs}
        value={tab}
        onChange={onChange}
        idFor={(id) => `circle-tab-${id}`}
        panelFor={(id) => `circle-panel-${id}`}
        compact
        className="border-line"
      />
    </div>
  );
}

function CircleMembers({ circle, onEdit }: { circle: Circle; onEdit: () => void }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const members = useQuery(circleMembersQuery(circle.id, circle.evaluatedAt, cursor));
  if (members.isPending) return <LoadingRows label="Loading subscribers" />;
  if (members.error) {
    return (
      <ErrorNotice
        message={members.error.message}
        action={
          <Button variant="ghost" onClick={() => void members.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (members.data.items.length === 0 && cursors.length === 1) {
    return (
      <EmptyState
        title={
          isEvaluating(circle)
            ? 'Working out who is in this segment'
            : 'No subscribers in this segment'
        }
        action={
          <Button size="sm" onClick={onEdit}>
            Edit the rule
          </Button>
        }
      >
        {isEvaluating(circle)
          ? 'Subscribers appear here once the evaluation finishes.'
          : 'Nobody matched the rule at the last evaluation. Loosen a condition to bring subscribers in.'}
      </EmptyState>
    );
  }
  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-sub">
        Subscribers in the segment as of the last evaluation of the saved rule. Any status is shown;
        Posts go to active subscribers only.
      </p>
      <BulkBar
        channelId={circle.channelId}
        circle={circle}
        onStarted={() => void members.refetch()}
      />
      <MemberRows members={members.data.items} caption={`Subscribers in ${circle.name}`} />
      {(cursors.length > 1 || members.data.nextCursor) && (
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={cursors.length === 1}
            onClick={() => setCursors((list) => list.slice(0, -1))}
          >
            Previous
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!members.data.nextCursor}
            onClick={() => {
              const next = members.data.nextCursor;
              if (next) setCursors((list) => [...list, next]);
            }}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function DeleteDialog({
  circle,
  open,
  onClose,
  onDeleted,
}: {
  circle: Circle;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useDeleteCircle(circle);
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Delete ${circle.name}?`}
      description="Subscribers stay on the publication; only the segment goes. Draft posts addressed to it will ask for a new audience."
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Keep it
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() => remove.mutate(undefined, { onSuccess: onDeleted })}
          >
            Delete segment
          </Button>
        </>
      }
    >
      {remove.error && (
        <ErrorNotice
          title={
            remove.error instanceof ApiError && remove.error.status === 409
              ? 'This segment is in use'
              : 'Not deleted'
          }
          message={remove.error.message}
        />
      )}
    </Dialog>
  );
}
