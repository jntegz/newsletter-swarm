// Growth → Champions: Members who bring in other Members. Settings and fraud controls, rewards
// and Milestones, the leaderboard, held referrals to review, and awards to fulfil.
import {
  CHAMPION_DEFAULTS,
  type ChampionAward,
  type ChampionMilestone,
  type ChampionReward,
  type ChampionRewardKind,
  type ChampionSettings,
  type CreateChampionReward,
  type Referral,
  type ReferralStatus,
} from '@swarm/domain';
import {
  Button,
  Checkbox,
  Dialog,
  ErrorNotice,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  awardsQuery,
  championLeaderboardQuery,
  championMilestonesQuery,
  championRewardsQuery,
  championSettingsQuery,
  referralsQuery,
  useCreateMilestone,
  useCreateReward,
  useDeleteMilestone,
  useFulfilAward,
  useReviewReferral,
  useUpdateChampionSettings,
  useUpdateMilestone,
  useUpdateReward,
} from '../api/growth';
import { couponsQuery, levelsQuery } from '../api/money';
import { useChannelFlag } from '../api/queries';
import { Bands, Section, formatDateTime, formatDay, numberFormat } from '../pages/common';
import { InlineAdd } from '../shell/InlineAdd';
import { UnsavedBar } from '../shell/UnsavedBar';
import { rewardKinds } from './helpers';
import { QueryState, useGrowth } from './Layout';

export function ChampionsPage() {
  return (
    <Bands>
      <SettingsSection />
      <MilestonesSection />
      <RewardsSection />
      <ReferralsSection />
      <AwardsSection />
      <LeaderboardSection />
    </Bands>
  );
}

// ---- Settings ------------------------------------------------------------------------------

function SettingsSection() {
  const { channel } = useGrowth();
  const settings = useQuery(championSettingsQuery(channel.id));
  return (
    <Section
      title="Referral programme"
      description="Every subscriber gets a share link. Referrals count once the new subscriber confirms and opens a post, and count towards Milestones."
    >
      <QueryState query={settings} label="Loading referral settings">
        {settings.data && <SettingsForm settings={settings.data} />}
      </QueryState>
    </Section>
  );
}

const settingsDraft = (settings: ChampionSettings) => ({
  enabled: settings.enabled,
  engagementDays: String(settings.engagementDays),
  clusterLimit: String(settings.clusterLimit),
  clusterWindowHours: String(settings.clusterWindowHours),
  blockDisposable: settings.blockDisposable,
  publicLeaderboard: settings.publicLeaderboard,
  shareText: settings.shareText ?? '',
});

/** Several fields saved together: the Unsaved changes bar appears once one changes. */
export function SettingsForm({ settings }: { settings: ChampionSettings }) {
  const { channel, canAdmin } = useGrowth();
  const update = useUpdateChampionSettings(channel.id);
  const formId = useId();
  const [saved, setSaved] = useState(() => settingsDraft(settings));
  const [draft, setDraft] = useState(saved);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const error = update.error instanceof ApiError ? update.error : null;
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const int = (text: string, min: number, max: number) => {
    const n = Number(text);
    return Number.isInteger(n) && n >= min && n <= max
      ? null
      : `Use a whole number, ${min}–${max}.`;
  };
  const problems = {
    engagementDays: int(draft.engagementDays, 1, 90),
    clusterLimit: int(draft.clusterLimit, 1, 100),
    clusterWindowHours: int(draft.clusterWindowHours, 1, 720),
  };
  type Checked = keyof typeof problems;
  const invalid = Object.values(problems).some(Boolean);
  // A field says what is wrong once the person leaves it or tries to save, never on first render.
  const [left, setLeft] = useState<Partial<Record<Checked, true>>>({});
  const [attempted, setAttempted] = useState(false);
  const shown = (key: Checked) => (attempted || left[key] ? problems[key] : null);
  const leave = (key: Checked) => () => setLeft((l) => ({ ...l, [key]: true }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (invalid) return;
    const sent = draft;
    update.mutate(
      {
        enabled: sent.enabled,
        engagementDays: Number(sent.engagementDays),
        clusterLimit: Number(sent.clusterLimit),
        clusterWindowHours: Number(sent.clusterWindowHours),
        blockDisposable: sent.blockDisposable,
        publicLeaderboard: sent.publicLeaderboard,
        shareText: sent.shareText.trim() || null,
      },
      {
        onSuccess: () => {
          setSaved(sent);
          setAttempted(false);
          setLeft({});
        },
      },
    );
  };

  return (
    <form id={formId} className="grid gap-4" onSubmit={submit}>
      <Checkbox
        label="Award Milestones"
        hint="Referrals are recorded either way; rewards are only given while this is on."
        checked={draft.enabled}
        disabled={!canAdmin}
        onChange={(v) => set('enabled', v)}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Must open within (days)"
          type="number"
          inputMode="numeric"
          min={1}
          max={90}
          readOnly={!canAdmin}
          value={draft.engagementDays}
          onChange={(e) => set('engagementDays', e.target.value)}
          onBlur={leave('engagementDays')}
          hint={`A referral counts once the new subscriber opens a post within this many days. Default ${CHAMPION_DEFAULTS.engagementDays}.`}
          error={shown('engagementDays') ?? error?.field('engagementDays')}
        />
        <TextField
          label="Hold for review after (sign-ups)"
          type="number"
          inputMode="numeric"
          min={1}
          max={100}
          readOnly={!canAdmin}
          value={draft.clusterLimit}
          onChange={(e) => set('clusterLimit', e.target.value)}
          onBlur={leave('clusterLimit')}
          hint="More sign-ups than this for one referrer from one network are held for review."
          error={shown('clusterLimit') ?? error?.field('clusterLimit')}
        />
        <TextField
          label="Within (hours)"
          type="number"
          inputMode="numeric"
          min={1}
          max={720}
          readOnly={!canAdmin}
          value={draft.clusterWindowHours}
          onChange={(e) => set('clusterWindowHours', e.target.value)}
          onBlur={leave('clusterWindowHours')}
          error={shown('clusterWindowHours') ?? error?.field('clusterWindowHours')}
        />
      </div>
      <Checkbox
        label="Don’t count throwaway email addresses"
        hint="Referrals from known disposable email domains never count."
        checked={draft.blockDisposable}
        disabled={!canAdmin}
        onChange={(v) => set('blockDisposable', v)}
      />
      <Checkbox
        label="Show the top referrers on the website"
        hint="A public leaderboard page with first names only. Needs the leaderboard option on for this publication."
        checked={draft.publicLeaderboard}
        disabled={!canAdmin}
        onChange={(v) => set('publicLeaderboard', v)}
      />
      <TextAreaField
        label="Share text"
        rows={2}
        maxLength={280}
        readOnly={!canAdmin}
        value={draft.shareText}
        onChange={(e) => set('shareText', e.target.value)}
        hint="Suggested words subscribers share with their link."
        error={error?.field('shareText')}
      />
      {canAdmin ? (
        <UnsavedBar
          label="Unsaved changes to the referral programme"
          dirty={dirty}
          pending={update.isPending}
          form={formId}
          onDiscard={() => {
            setDraft(saved);
            setAttempted(false);
            setLeft({});
            update.reset();
          }}
          error={
            error && !error.details.length
              ? `Not saved: ${error.message}`
              : attempted && invalid
                ? 'Not saved: some fields need attention.'
                : null
          }
        />
      ) : (
        <p className="text-[12.5px] text-sub">An admin changes these settings.</p>
      )}
    </form>
  );
}

// ---- Milestones ----------------------------------------------------------------------------

/** Name, count and reward of a Milestone, for the inline add form and the edit dialog. */
function useMilestoneDraft(milestone: ChampionMilestone | null) {
  const [name, setName] = useState(milestone?.name ?? '');
  const [count, setCount] = useState(String(milestone?.referralsRequired ?? 3));
  const [rewardId, setRewardId] = useState(milestone?.rewardId ?? '');
  const n = Number(count);
  const countProblem =
    Number.isInteger(n) && n >= 1 && n <= 100_000 ? null : 'Use a whole number from 1.';
  return {
    name,
    setName,
    count,
    setCount,
    rewardId,
    setRewardId,
    countProblem,
    ready: !countProblem && !!name.trim(),
    body: () => ({ name: name.trim(), referralsRequired: n, rewardId: rewardId || null }),
    clear: () => {
      setName('');
      setCount('3');
      setRewardId('');
    },
  };
}

function MilestoneFields({
  draft,
  rewards,
  error,
}: {
  draft: ReturnType<typeof useMilestoneDraft>;
  rewards: ChampionReward[];
  error: ApiError | null;
}) {
  return (
    <>
      <TextField
        label="Name"
        required
        maxLength={80}
        value={draft.name}
        placeholder="For example “Bronze supporter”"
        onChange={(e) => draft.setName(e.target.value)}
        error={error?.field('name')}
      />
      <TextField
        label="Counted referrals needed"
        type="number"
        inputMode="numeric"
        min={1}
        value={draft.count}
        onChange={(e) => draft.setCount(e.target.value)}
        error={draft.countProblem ?? error?.field('referralsRequired')}
      />
      <SelectField
        label="Reward"
        value={draft.rewardId}
        onChange={(e) => draft.setRewardId(e.target.value)}
        options={[
          { value: '', label: 'No reward (recognition only)' },
          ...rewards
            .filter((r) => r.status === 'active' || r.id === draft.rewardId)
            .map((r) => ({ value: r.id, label: r.name })),
        ]}
        hint={rewards.length === 0 ? 'Add rewards under Rewards below.' : undefined}
        error={error?.field('rewardId')}
      />
    </>
  );
}

function MilestonesSection() {
  const { channel, canAdmin } = useGrowth();
  const milestones = useQuery(championMilestonesQuery(channel.id));
  const rewards = useQuery(championRewardsQuery(channel.id));
  const [editing, setEditing] = useState<ChampionMilestone | null>(null);
  const list = [...(milestones.data ?? [])].sort(
    (a, b) => a.referralsRequired - b.referralsRequired,
  );
  const rewardName = (id: string | null) =>
    id ? (rewards.data?.find((r) => r.id === id)?.name ?? 'A removed reward') : 'No reward';

  return (
    <Section
      title="Milestones"
      description="Steps on the way, for example 3, 5 and 10 counted referrals. Reaching one gives its reward once."
    >
      <QueryState query={milestones} label="Loading Milestones">
        {list.length === 0 ? (
          <p className="text-[13.5px] text-sub">
            No Milestones yet. Add one so referrers have something to reach.
          </p>
        ) : (
          <ul className="divide-y divide-line border-b border-line">
            {list.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center gap-3 py-3 text-[13.5px] first:pt-0"
              >
                <span className="tabular grid size-10 shrink-0 place-items-center rounded-pill bg-lavender font-bold text-purple-deep">
                  {m.referralsRequired}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{m.name}</span>
                  <span className="block text-[12.5px] text-sub">
                    {numberFormat.format(m.referralsRequired)} referral
                    {m.referralsRequired === 1 ? '' : 's'} · {rewardName(m.rewardId)}
                  </span>
                </span>
                {m.status === 'archived' && <Pill>Archived</Pill>}
                {canAdmin && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(m)}>
                    Edit<span className="sr-only"> {m.name}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {canAdmin && (
        <div className="mt-4">
          <AddMilestone rewards={rewards.data ?? []} />
        </div>
      )}
      {editing && (
        <MilestoneDialog
          milestone={editing}
          rewards={rewards.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </Section>
  );
}

function AddMilestone({ rewards }: { rewards: ChampionReward[] }) {
  const { channel } = useGrowth();
  const create = useCreateMilestone(channel.id);
  const draft = useMilestoneDraft(null);
  const error = create.error instanceof ApiError ? create.error : null;
  return (
    <InlineAdd
      label="Add Milestone"
      formLabel="Add a Milestone"
      pending={create.isPending}
      onCancel={() => {
        draft.clear();
        create.reset();
      }}
      onSubmit={(done) => {
        if (!draft.ready) return;
        const body = draft.body();
        create.mutate(body, {
          onSuccess: () => {
            draft.clear();
            done(`Added the Milestone ${body.name}.`);
          },
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <MilestoneFields draft={draft} rewards={rewards} error={error} />
      </div>
      {error && !error.details.length && <ErrorNotice message={error.message} />}
    </InlineAdd>
  );
}

function MilestoneDialog({
  milestone,
  rewards,
  onClose,
}: {
  milestone: ChampionMilestone;
  rewards: ChampionReward[];
  onClose: () => void;
}) {
  const { channel } = useGrowth();
  const update = useUpdateMilestone(channel.id);
  const remove = useDeleteMilestone(channel.id);
  const draft = useMilestoneDraft(milestone);
  const [archived, setArchived] = useState(milestone.status === 'archived');
  const error = update.error instanceof ApiError ? update.error : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.ready) return;
    update.mutate(
      { id: milestone.id, ...draft.body(), status: archived ? 'archived' : 'active' },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit Milestone"
      actions={
        <>
          <Button
            variant="quiet"
            loading={remove.isPending}
            onClick={() => {
              if (window.confirm(`Delete the Milestone “${milestone.name}”?`)) {
                remove.mutate(milestone.id, { onSuccess: onClose });
              }
            }}
          >
            Delete
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="milestone-form" loading={update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="milestone-form" className="grid gap-4" onSubmit={submit}>
        <MilestoneFields draft={draft} rewards={rewards} error={error} />
        <Checkbox
          label="Archived"
          hint="Archived Milestones are no longer awarded."
          checked={archived}
          onChange={setArchived}
        />
        {error && !error.details.length && <ErrorNotice message={error.message} />}
        {remove.error && <ErrorNotice title="Not deleted" message={remove.error.message} />}
      </form>
    </Dialog>
  );
}

// ---- Rewards -------------------------------------------------------------------------------

const REWARD_KIND: Record<ChampionRewardKind, string> = {
  comp_level: 'Free access to a paid plan',
  coupon: 'A coupon code',
  goods: 'A Goods item',
  manual: 'Something you send yourself',
};

/** A reward's fields, for the inline add form and the edit dialog. */
function useRewardDraft(reward: ChampionReward | null) {
  const [kind, setKind] = useState<ChampionRewardKind>(reward?.kind ?? 'manual');
  const [name, setName] = useState(reward?.name ?? '');
  const [description, setDescription] = useState(reward?.description ?? '');
  const [levelId, setLevelId] = useState(reward?.levelId ?? '');
  const [compDays, setCompDays] = useState(String(reward?.compDays ?? 30));
  const [couponId, setCouponId] = useState(reward?.couponId ?? '');
  const [goodsRef, setGoodsRef] = useState(reward?.goodsRef ?? '');
  return {
    reward,
    kind,
    setKind,
    name,
    setName,
    description,
    setDescription,
    levelId,
    setLevelId,
    compDays,
    setCompDays,
    couponId,
    setCouponId,
    goodsRef,
    setGoodsRef,
    fields: () => ({
      name: name.trim(),
      description: description.trim() || null,
      levelId: kind === 'comp_level' ? levelId || null : null,
      compDays: kind === 'comp_level' ? Number(compDays) || null : null,
      couponId: kind === 'coupon' ? couponId || null : null,
      goodsRef: kind === 'goods' ? goodsRef.trim() || null : null,
    }),
    clear: () => {
      setKind('manual');
      setName('');
      setDescription('');
      setLevelId('');
      setCompDays('30');
      setCouponId('');
      setGoodsRef('');
    },
  };
}

function RewardFields({
  draft,
  error,
}: {
  draft: ReturnType<typeof useRewardDraft>;
  error: ApiError | null;
}) {
  const { channel } = useGrowth();
  const levels = useQuery(levelsQuery(channel.id));
  const coupons = useQuery(couponsQuery(channel.id));
  const goodsOn = useChannelFlag(channel.id, 'goods') === true;
  const { reward, kind } = draft;
  return (
    <>
      <SelectField
        label="Kind"
        value={kind}
        disabled={!!reward}
        onChange={(e) => draft.setKind(e.target.value as ChampionRewardKind)}
        options={rewardKinds(goodsOn, reward?.kind).map((k) => ({
          value: k,
          label: REWARD_KIND[k],
        }))}
        hint={reward ? 'The kind is fixed once the reward exists.' : undefined}
      />
      <TextField
        label="Name"
        required
        maxLength={80}
        value={draft.name}
        onChange={(e) => draft.setName(e.target.value)}
        error={error?.field('name')}
      />
      <TextAreaField
        label="Description (optional)"
        rows={2}
        maxLength={500}
        value={draft.description}
        onChange={(e) => draft.setDescription(e.target.value)}
        error={error?.field('description')}
      />
      {kind === 'comp_level' && (
        <>
          <SelectField
            label="Paid plan"
            value={draft.levelId}
            onChange={(e) => draft.setLevelId(e.target.value)}
            options={[
              { value: '', label: levels.isPending ? 'Loading plans…' : 'Choose a plan' },
              ...(levels.data?.items ?? []).map((l) => ({ value: l.id, label: l.name })),
            ]}
            error={error?.field('levelId')}
          />
          <TextField
            label="For (days)"
            type="number"
            inputMode="numeric"
            min={1}
            max={3650}
            value={draft.compDays}
            onChange={(e) => draft.setCompDays(e.target.value)}
            error={error?.field('compDays')}
          />
        </>
      )}
      {kind === 'coupon' && (
        <SelectField
          label="Coupon"
          value={draft.couponId}
          onChange={(e) => draft.setCouponId(e.target.value)}
          options={[
            { value: '', label: coupons.isPending ? 'Loading coupons…' : 'Choose a coupon' },
            ...(coupons.data ?? []).map((c) => ({ value: c.id, label: c.code })),
          ]}
          hint="Its code is emailed to the referrer."
          error={error?.field('couponId')}
        />
      )}
      {kind === 'goods' && (
        <TextField
          label="Goods item"
          maxLength={80}
          value={draft.goodsRef}
          onChange={(e) => draft.setGoodsRef(e.target.value)}
          hint="Until Goods arrive, the award waits for you to send it."
          error={error?.field('goodsRef')}
        />
      )}
    </>
  );
}

function RewardsSection() {
  const { channel, canAdmin } = useGrowth();
  const rewards = useQuery(championRewardsQuery(channel.id));
  const goodsOn = useChannelFlag(channel.id, 'goods') === true;
  const [editing, setEditing] = useState<ChampionReward | null>(null);
  const hasGoods = goodsOn || rewards.data?.some((r) => r.kind === 'goods');
  return (
    <Section
      title="Rewards"
      description={`What a Milestone gives. Free access and coupons are sent automatically; ${hasGoods ? 'Goods and manual' : 'manual'} rewards wait for you in Awards.`}
    >
      <QueryState query={rewards} label="Loading rewards">
        {rewards.data?.length === 0 ? (
          <p className="text-[13.5px] text-sub">No rewards yet.</p>
        ) : (
          <ul className="divide-y divide-line border-b border-line">
            {rewards.data?.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-3 py-3 text-[13.5px] first:pt-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{r.name}</span>
                  <span className="block text-[12.5px] text-sub">
                    {REWARD_KIND[r.kind]}
                    {r.kind === 'comp_level' && r.compDays ? ` for ${r.compDays} days` : ''}
                  </span>
                </span>
                {r.status === 'archived' && <Pill>Archived</Pill>}
                {canAdmin && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(r)}>
                    Edit<span className="sr-only"> {r.name}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {canAdmin && (
        <div className="mt-4">
          <AddReward />
        </div>
      )}
      {editing && <RewardDialog reward={editing} onClose={() => setEditing(null)} />}
    </Section>
  );
}

function AddReward() {
  const { channel } = useGrowth();
  const create = useCreateReward(channel.id);
  const draft = useRewardDraft(null);
  const error = create.error instanceof ApiError ? create.error : null;
  return (
    <InlineAdd
      label="Add reward"
      formLabel="Add a reward"
      pending={create.isPending}
      onCancel={() => {
        draft.clear();
        create.reset();
      }}
      onSubmit={(done) => {
        const body: CreateChampionReward = { kind: draft.kind, ...draft.fields() };
        if (!body.name) return;
        create.mutate(body, {
          onSuccess: () => {
            draft.clear();
            done(`Added the reward ${body.name}.`);
          },
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <RewardFields draft={draft} error={error} />
      </div>
      {error && !error.details.length && <ErrorNotice message={error.message} />}
    </InlineAdd>
  );
}

function RewardDialog({ reward, onClose }: { reward: ChampionReward; onClose: () => void }) {
  const { channel } = useGrowth();
  const update = useUpdateReward(channel.id);
  const draft = useRewardDraft(reward);
  const [archived, setArchived] = useState(reward.status === 'archived');
  const error = update.error instanceof ApiError ? update.error : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      { id: reward.id, ...draft.fields(), status: archived ? 'archived' : 'active' },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit reward"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="reward-form" loading={update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="reward-form" className="grid gap-4" onSubmit={submit}>
        <RewardFields draft={draft} error={error} />
        <Checkbox
          label="Archived"
          hint="Archived rewards can’t be picked for new Milestones."
          checked={archived}
          onChange={setArchived}
        />
        {error && !error.details.length && <ErrorNotice message={error.message} />}
      </form>
    </Dialog>
  );
}

// ---- Referrals -----------------------------------------------------------------------------

const REFERRAL_FILTERS: { value: ReferralStatus | 'all'; label: string }[] = [
  { value: 'held', label: 'Held for review' },
  { value: 'pending', label: 'Waiting to count' },
  { value: 'counted', label: 'Counted' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
];

const REASON: Record<NonNullable<Referral['reviewReason']>, string> = {
  disposable_domain: 'Throwaway email address',
  ip_cluster: 'Many sign-ups from one network',
  not_engaged: 'Never opened a post',
  operator: 'Reviewed by your team',
  unsubscribed: 'Unsubscribed',
};

const REFERRAL_PILL: Record<
  ReferralStatus,
  { tone: 'success' | 'scheduled' | 'neutral' | 'danger'; label: string }
> = {
  pending: { tone: 'scheduled', label: 'Waiting' },
  counted: { tone: 'success', label: 'Counted' },
  held: { tone: 'danger', label: 'Held' },
  rejected: { tone: 'neutral', label: 'Rejected' },
};

/** Pages through a cursor list: a stack of cursors, so Previous works. */
function useCursorPages() {
  const [stack, setStack] = useState<(string | null)[]>([null]);
  const cursor = stack[stack.length - 1] ?? null;
  return {
    cursor,
    page: stack.length,
    next: (c: string) => setStack((s) => [...s, c]),
    previous: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    reset: () => setStack([null]),
  };
}

function Pager({
  pages,
  nextCursor,
  label,
}: {
  pages: ReturnType<typeof useCursorPages>;
  nextCursor: string | null | undefined;
  label: string;
}) {
  if (pages.page === 1 && !nextCursor) return null;
  return (
    <nav aria-label={label} className="mt-3 flex items-center gap-2">
      <Button variant="ghost" size="sm" disabled={pages.page === 1} onClick={pages.previous}>
        Previous
      </Button>
      <span className="tabular text-[12.5px] text-sub">Page {pages.page}</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={!nextCursor}
        onClick={() => nextCursor && pages.next(nextCursor)}
      >
        Next
      </Button>
    </nav>
  );
}

function ReferralsSection() {
  const { channel, canEdit } = useGrowth();
  const [filter, setFilter] = useState<ReferralStatus | 'all'>('held');
  const pages = useCursorPages();
  const referrals = useQuery(
    referralsQuery(channel.id, filter === 'all' ? undefined : filter, pages.cursor),
  );
  const review = useReviewReferral(channel.id);

  return (
    <Section
      title="Referrals"
      description="Sign-ups that look unusual are held until someone on your team looks at them."
      action={
        <SelectField
          label="Show"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as ReferralStatus | 'all');
            pages.reset();
          }}
          options={REFERRAL_FILTERS}
        />
      }
    >
      <QueryState query={referrals} label="Loading referrals">
        {referrals.data?.items.length === 0 ? (
          <p className="text-[13.5px] text-sub">
            {filter === 'held' ? 'Nothing waits for review.' : 'No referrals here yet.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="table-head">
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Referrer
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    New subscriber
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Joined
                  </th>
                  <th scope="col" className="py-2 pl-3 text-right font-semibold">
                    <span className="sr-only">Review</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {referrals.data?.items.map((r) => (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="py-2.5 pr-3 font-mono text-[12.5px] break-all">
                      {r.referrerEmail ?? 'Deleted subscriber'}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="block font-mono text-[12.5px] break-all">
                        {r.referredEmail ?? 'Deleted subscriber'}
                      </span>
                      {r.ipPrefix && (
                        <span className="block text-[12px] text-sub">Network {r.ipPrefix}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Pill tone={REFERRAL_PILL[r.status].tone}>
                        {REFERRAL_PILL[r.status].label}
                      </Pill>
                      {r.reviewReason && (
                        <span className="mt-1 block text-[12px] text-sub">
                          {REASON[r.reviewReason]}
                        </span>
                      )}
                    </td>
                    <td className="tabular px-3 py-2.5 text-sub">{formatDay(r.createdAt)}</td>
                    <td className="py-2.5 pl-3 text-right">
                      {r.status === 'held' && canEdit && (
                        <span className="inline-flex gap-1.5">
                          <Button
                            size="sm"
                            loading={
                              review.isPending &&
                              review.variables?.id === r.id &&
                              review.variables.approve
                            }
                            onClick={() => review.mutate({ id: r.id, approve: true })}
                          >
                            Count it
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={
                              review.isPending &&
                              review.variables?.id === r.id &&
                              !review.variables.approve
                            }
                            onClick={() => review.mutate({ id: r.id, approve: false })}
                          >
                            Reject
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager pages={pages} nextCursor={referrals.data?.nextCursor} label="Referral pages" />
      </QueryState>
      {review.error && <ErrorNotice title="Not reviewed" message={review.error.message} />}
      {!canEdit && (
        <p className="mt-3 text-[12.5px] text-sub">An editor or admin reviews held referrals.</p>
      )}
    </Section>
  );
}

// ---- Awards --------------------------------------------------------------------------------

const AWARD_PILL: Record<
  ChampionAward['status'],
  { tone: 'success' | 'scheduled' | 'neutral' | 'danger'; label: string }
> = {
  pending: { tone: 'scheduled', label: 'To send' },
  fulfilled: { tone: 'success', label: 'Sent' },
  failed: { tone: 'danger', label: 'Failed' },
  revoked: { tone: 'neutral', label: 'Revoked' },
};

function AwardsSection() {
  const { channel, canAdmin } = useGrowth();
  const [filter, setFilter] = useState<ChampionAward['status'] | 'all'>('pending');
  const pages = useCursorPages();
  const awards = useQuery(
    awardsQuery(channel.id, filter === 'all' ? undefined : filter, pages.cursor),
  );
  const [fulfilling, setFulfilling] = useState<ChampionAward | null>(null);

  return (
    <Section
      title="Awards"
      description="Milestones referrers have reached. Goods and manual rewards wait here until you send them."
      action={
        <SelectField
          label="Show"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as ChampionAward['status'] | 'all');
            pages.reset();
          }}
          options={[
            { value: 'pending', label: 'To send' },
            { value: 'failed', label: 'Failed' },
            { value: 'fulfilled', label: 'Sent' },
            { value: 'all', label: 'All' },
          ]}
        />
      }
    >
      <QueryState query={awards} label="Loading awards">
        {awards.data?.items.length === 0 ? (
          <p className="text-[13.5px] text-sub">
            {filter === 'pending' ? 'Nothing waits to be sent.' : 'No awards here yet.'}
          </p>
        ) : (
          <ul className="divide-y divide-line border-b border-line">
            {awards.data?.items.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-3 py-3 text-[13.5px] first:pt-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[12.5px] break-all">
                    {a.memberEmail ?? 'Deleted subscriber'}
                  </span>
                  <span className="block text-[12.5px] text-sub">
                    {a.milestoneName ?? 'A removed Milestone'} · {a.rewardName ?? 'no reward'} ·{' '}
                    {formatDateTime(a.createdAt)}
                  </span>
                  {a.detail && <span className="block text-[12.5px]">{a.detail}</span>}
                </span>
                <Pill tone={AWARD_PILL[a.status].tone}>{AWARD_PILL[a.status].label}</Pill>
                {canAdmin && (a.status === 'pending' || a.status === 'failed') && (
                  <Button size="sm" variant="ghost" onClick={() => setFulfilling(a)}>
                    {a.status === 'failed' ? 'Try again' : 'Mark as sent'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <Pager pages={pages} nextCursor={awards.data?.nextCursor} label="Award pages" />
      </QueryState>
      {fulfilling && <FulfilDialog award={fulfilling} onClose={() => setFulfilling(null)} />}
    </Section>
  );
}

function FulfilDialog({ award, onClose }: { award: ChampionAward; onClose: () => void }) {
  const { channel } = useGrowth();
  const fulfil = useFulfilAward(channel.id);
  const [detail, setDetail] = useState('');
  const automatic = award.rewardKind === 'comp_level' || award.rewardKind === 'coupon';
  return (
    <Dialog
      open
      onClose={onClose}
      title={automatic ? 'Try the award again' : 'Mark the award as sent'}
      description={
        automatic
          ? `Swarm tries again to give ${award.memberEmail ?? 'the subscriber'} “${award.rewardName ?? 'the reward'}”.`
          : `Confirm you have sent “${award.rewardName ?? 'the reward'}” to ${award.memberEmail ?? 'the subscriber'}.`
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={fulfil.isPending}
            onClick={() =>
              fulfil.mutate({ id: award.id, detail: detail.trim() || null }, { onSuccess: onClose })
            }
          >
            {automatic ? 'Try again' : 'Mark as sent'}
          </Button>
        </>
      }
    >
      {!automatic && (
        <TextAreaField
          label="Note (optional)"
          rows={2}
          maxLength={500}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          hint="For your team, for example a tracking number."
        />
      )}
      {fulfil.error && <ErrorNotice title="Not done" message={fulfil.error.message} />}
    </Dialog>
  );
}

// ---- Leaderboard ---------------------------------------------------------------------------

function LeaderboardSection() {
  const { channel } = useGrowth();
  const pages = useCursorPages();
  const board = useQuery(championLeaderboardQuery(channel.id, pages.cursor));
  return (
    <Section title="Leaderboard" description="Referrers by counted referrals.">
      <QueryState query={board} label="Loading the leaderboard">
        {board.data?.items.length === 0 ? (
          <p className="text-[13.5px] text-sub">
            No referrers yet. Subscribers appear here once someone joins through their share link.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-[13px]">
              <thead>
                <tr className="table-head">
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Referrer
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Counted
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Waiting
                  </th>
                  <th scope="col" className="py-2 pl-3 text-right font-semibold">
                    Held
                  </th>
                </tr>
              </thead>
              <tbody>
                {board.data?.items.map((entry) => (
                  <tr key={entry.memberId} className="border-t border-line">
                    <td className="py-2.5 pr-3">
                      <span className="block font-semibold">
                        {[entry.firstName, entry.lastName].filter(Boolean).join(' ') || entry.email}
                      </span>
                      {(entry.firstName || entry.lastName) && (
                        <span className="block font-mono text-[12px] text-sub">{entry.email}</span>
                      )}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right font-semibold">
                      {numberFormat.format(entry.counted)}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">
                      {numberFormat.format(entry.pending)}
                    </td>
                    <td className="tabular py-2.5 pl-3 text-right">
                      {numberFormat.format(entry.held)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager pages={pages} nextCursor={board.data?.nextCursor} label="Leaderboard pages" />
      </QueryState>
    </Section>
  );
}
