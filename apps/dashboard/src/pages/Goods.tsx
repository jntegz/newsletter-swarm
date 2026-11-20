// Goods: products sold through the publication's own Stripe account, and their orders.
import type { Channel, Good, GoodOrder, MediaAsset } from '@swarm/domain';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  LoadingRows,
  Pill,
  TextField,
} from '@swarm/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { goodOrdersQuery, goodsQuery, useRefundOrder, useSaveGood } from '../api/goods';
import { mediaQuery, useUploadMedia } from '../api/queries';
import { formatMoney, majorValue } from '../money/helpers';
import { Section, WithChannel, formatDateTime } from './common';
import {
  GOOD_STATUS_LABEL,
  ORDER_STATUS_LABEL,
  draftInput,
  emptyDraft,
  slugFrom,
  type GoodDraft,
} from './goods-helpers';

const RANK = { viewer: 0, author: 1, editor: 2, admin: 3, owner: 4 } as const;

export function GoodsPage({ channelId }: { channelId: string | undefined }) {
  return (
    <WithChannel channelId={channelId}>{(channel) => <Goods channel={channel} />}</WithChannel>
  );
}

const toDraft = (good: Good): GoodDraft => ({
  name: good.name,
  slug: good.slug,
  description: good.description,
  licenseKeys: good.licenseKeys,
  prices: good.prices.map((p) => ({
    id: p.id,
    name: p.name,
    amount: majorValue(p.amount, p.currency),
    currency: p.currency,
  })),
  files: good.files.map((f) => ({ mediaId: f.mediaId, name: f.name })),
});

function Goods({ channel }: { channel: Channel & { role: keyof typeof RANK } }) {
  const goods = useQuery(goodsQuery(channel.id));
  const save = useSaveGood(channel.id);
  const canEdit = RANK[channel.role] >= RANK.editor;
  const canAdmin = RANK[channel.role] >= RANK.admin;
  const [editing, setEditing] = useState<Good | 'new' | null>(null);

  return (
    <div className="grid gap-5">
      <header>
        <h1 className="page-title">Products</h1>
        <p className="mt-1 text-[14px] text-sub">
          Sell PDFs through your own Stripe account. Buyers get a private link to their files, and
          lose it if you refund them.
        </p>
      </header>
      <Section
        title="Your products"
        action={
          canEdit ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              New product
            </Button>
          ) : undefined
        }
      >
        {goods.isPending && <LoadingRows label="Loading products" rows={3} />}
        {goods.error && <ErrorNotice message={goods.error.message} />}
        {goods.data?.length === 0 && (
          <EmptyState title="No products yet">
            Add a PDF and a price, then put it on sale. It gets its own page on your website.
          </EmptyState>
        )}
        {!!goods.data?.length && (
          <ul className="grid gap-2">
            {goods.data.map((good) => (
              <li
                key={good.id}
                className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line px-4 py-3"
              >
                <span className="min-w-0 grow">
                  <span className="block font-semibold">{good.name}</span>
                  <span className="block text-[13px] break-all text-sub">{good.url}</span>
                </span>
                <span className="text-[13px] text-sub">
                  {good.prices.map((p) => formatMoney(p.amount, p.currency)).join(' · ') ||
                    'No price'}
                </span>
                <Pill tone={good.status === 'published' ? 'success' : 'neutral'}>
                  {GOOD_STATUS_LABEL[good.status]}
                </Pill>
                {canEdit && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(good)}>
                      Edit
                    </Button>
                    {good.status !== 'published' ? (
                      <Button
                        size="sm"
                        disabled={save.isPending}
                        onClick={() => save.mutate({ id: good.id, patch: { status: 'published' } })}
                      >
                        Put on sale
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={save.isPending}
                        onClick={() => save.mutate({ id: good.id, patch: { status: 'archived' } })}
                      >
                        Stop selling
                      </Button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {save.error && !editing && <ErrorNotice message={save.error.message} />}
      </Section>
      {canAdmin && <Orders channelId={channel.id} />}
      {editing && (
        <GoodDialog
          channelId={channel.id}
          good={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function GoodDialog({
  channelId,
  good,
  onClose,
}: {
  channelId: string;
  good: Good | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<GoodDraft>(good ? toDraft(good) : emptyDraft('usd'));
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSaveGood(channelId);
  const files = useQuery(mediaQuery(channelId, '', 'file'));
  const upload = useUploadMedia(channelId);
  const set = (patch: Partial<GoodDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const addFile = (asset: MediaAsset, name: string) =>
    setDraft((d) =>
      d.files.some((f) => f.mediaId === asset.id)
        ? d
        : { ...d, files: [...d.files, { mediaId: asset.id, name }] },
    );

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const result = draftInput(draft);
    if ('error' in result) {
      setProblem(result.error);
      return;
    }
    setProblem(null);
    save.mutate(good ? { id: good.id, patch: result.input } : { create: result.input }, {
      onSuccess: onClose,
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={good ? `Edit ${good.name}` : 'New product'}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => submit()} disabled={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form className="grid gap-4" onSubmit={submit}>
        <TextField
          label="Name"
          required
          maxLength={120}
          value={draft.name}
          onChange={(e) =>
            set({
              name: e.target.value,
              ...(good ? {} : { slug: slugFrom(e.target.value) }),
            })
          }
        />
        <TextField
          label="Address"
          hint="The last part of the product’s web address, after /goods/."
          required
          maxLength={80}
          value={draft.slug}
          onChange={(e) => set({ slug: e.target.value })}
        />
        <label className="grid gap-1 text-[13.5px] font-medium">
          Description
          <textarea
            className="line-input min-h-24 py-2 font-normal"
            maxLength={5000}
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </label>
        <fieldset className="grid gap-2">
          <legend className="text-[13.5px] font-medium">Prices</legend>
          {draft.prices.map((price, i) => (
            <div key={price.id ?? i} className="flex flex-wrap items-end gap-2">
              <TextField
                label="Option"
                value={price.name}
                maxLength={80}
                onChange={(e) =>
                  set({
                    prices: draft.prices.map((p, j) =>
                      j === i ? { ...p, name: e.target.value } : p,
                    ),
                  })
                }
              />
              <TextField
                label="Amount"
                inputMode="decimal"
                value={price.amount}
                onChange={(e) =>
                  set({
                    prices: draft.prices.map((p, j) =>
                      j === i ? { ...p, amount: e.target.value } : p,
                    ),
                  })
                }
              />
              <TextField
                label="Currency"
                maxLength={3}
                value={price.currency}
                onChange={(e) =>
                  set({
                    prices: draft.prices.map((p, j) =>
                      j === i ? { ...p, currency: e.target.value.toLowerCase() } : p,
                    ),
                  })
                }
              />
              {draft.prices.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => set({ prices: draft.prices.filter((_, j) => j !== i) })}
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="w-fit"
            onClick={() =>
              set({
                prices: [
                  ...draft.prices,
                  { name: '', amount: '', currency: draft.prices[0]?.currency ?? 'usd' },
                ],
              })
            }
          >
            Add a price
          </Button>
        </fieldset>
        <fieldset className="grid gap-2">
          <legend className="text-[13.5px] font-medium">Files</legend>
          {draft.files.map((file, i) => (
            <div key={file.mediaId} className="flex items-end gap-2">
              <TextField
                label="File name"
                value={file.name}
                maxLength={120}
                onChange={(e) =>
                  set({
                    files: draft.files.map((f, j) =>
                      j === i ? { ...f, name: e.target.value } : f,
                    ),
                  })
                }
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => set({ files: draft.files.filter((_, j) => j !== i) })}
              >
                Remove
              </Button>
            </div>
          ))}
          <label className="btn-ghost btn-sm w-fit cursor-pointer">
            {upload.isPending ? 'Uploading…' : 'Upload a PDF'}
            <input
              type="file"
              accept="application/pdf"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  upload.mutate(file, {
                    onSuccess: (asset) => addFile(asset, file.name.replace(/\.[a-z0-9]+$/i, '')),
                  });
                }
                event.target.value = '';
              }}
            />
          </label>
          {upload.error && <ErrorNotice title="Upload failed" message={upload.error.message} />}
          {!!files.data?.length && (
            <label className="grid gap-1 text-[13px] text-sub">
              Or use a file you already uploaded
              <select
                className="line-input"
                value=""
                onChange={(e) => {
                  const asset = files.data.find((a) => a.id === e.target.value);
                  if (asset) addFile(asset, asset.altText || 'Download');
                }}
              >
                <option value="">Choose a file</option>
                {files.data
                  .filter((a) => a.contentType === 'application/pdf')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.altText || `Uploaded ${formatDateTime(a.createdAt)}`}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </fieldset>
        <label className="flex items-center gap-2.5 text-[13.5px]">
          <input
            type="checkbox"
            className="size-4 accent-purple"
            checked={draft.licenseKeys}
            onChange={(e) => set({ licenseKeys: e.target.checked })}
          />
          Give each buyer a license key
        </label>
        {problem && <ErrorNotice message={problem} />}
        {save.error && <ErrorNotice message={save.error.message} />}
      </form>
    </Dialog>
  );
}

function Orders({ channelId }: { channelId: string }) {
  const orders = useQuery(goodOrdersQuery(channelId));
  const refund = useRefundOrder(channelId);
  const [refunding, setRefunding] = useState<GoodOrder | null>(null);
  return (
    <Section title="Orders">
      {orders.isPending && <LoadingRows label="Loading orders" rows={3} />}
      {orders.error && <ErrorNotice message={orders.error.message} />}
      {orders.data?.items.length === 0 && (
        <EmptyState title="No orders yet">Orders appear here once someone has paid.</EmptyState>
      )}
      {!!orders.data?.items.length && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <caption className="sr-only">Orders</caption>
            <thead>
              <tr className="table-head">
                <th scope="col" className="py-2 pr-3 font-semibold">
                  Buyer
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Product
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Amount
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Status
                </th>
                <th scope="col" className="py-2 pl-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.data.items.map((order) => (
                <tr key={order.id} className="border-t border-line align-top">
                  <td className="py-2.5 pr-3 font-mono break-all">{order.email}</td>
                  <td className="px-3 py-2.5">
                    {order.goodName}
                    {order.licenseKey && (
                      <span className="block font-mono text-[12px] text-sub">
                        {order.licenseKey}
                      </span>
                    )}
                  </td>
                  <td className="tabular px-3 py-2.5">
                    {formatMoney(order.amount, order.currency)}
                  </td>
                  <td className="px-3 py-2.5">{ORDER_STATUS_LABEL[order.status]}</td>
                  <td className="py-2.5 pl-3 text-right">
                    {order.status === 'paid' && (
                      <Button variant="ghost" size="sm" onClick={() => setRefunding(order)}>
                        Refund
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {refunding && (
        <Dialog
          open
          onClose={() => setRefunding(null)}
          title="Refund this order?"
          description={`${formatMoney(refunding.amount, refunding.currency)} goes back to ${refunding.email} through Stripe. They lose access to the files, and any license key stops working. This can’t be undone.`}
          actions={
            <>
              <Button variant="ghost" onClick={() => setRefunding(null)}>
                Keep the order
              </Button>
              <Button
                variant="danger"
                disabled={refund.isPending}
                onClick={() => refund.mutate(refunding.id, { onSuccess: () => setRefunding(null) })}
              >
                Refund
              </Button>
            </>
          }
        >
          {refund.error && <ErrorNotice message={refund.error.message} />}
        </Dialog>
      )}
    </Section>
  );
}
