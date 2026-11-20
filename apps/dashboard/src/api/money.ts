// Queries and mutations for Phase 5 money: Settings → Payments, Membership levels and their
// prices, coupons, comp access, Gates and the meter, Gift Passes, pledges and revenue.
import type {
  CompGrant,
  ConnectPayPal,
  ConnectStripeKey,
  PayPalStatus,
  ConnectUrl,
  Coupon,
  CreateCompGrant,
  CreateCoupon,
  CreateLevelPrice,
  CreateMembershipLevel,
  Gate,
  GateSettings,
  GiftPass,
  LevelPrice,
  MembershipLevel,
  MembershipLevelList,
  MeterGrant,
  PaymentsStatus,
  Pledge,
  PutGate,
  Revenue,
  UpdateCoupon,
  UpdateGateSettings,
  UpdateMembershipLevel,
  UpdatePayments,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { memberKeys } from './members';
import { isFeatureDisabled } from './site';

export { isFeatureDisabled };

const moneyKeys = {
  payments: (channelId: string) => ['channels', channelId, 'payments'] as const,
  levels: (channelId: string) => ['channels', channelId, 'levels'] as const,
  level: (channelId: string, levelId: string) =>
    ['channels', channelId, 'levels', levelId] as const,
  coupons: (channelId: string) => ['channels', channelId, 'coupons'] as const,
  gateSettings: (channelId: string) => ['channels', channelId, 'gate-settings'] as const,
  gate: (dispatchId: string) => ['dispatches', dispatchId, 'gate'] as const,
  comp: (channelId: string, memberId: string) => ['channels', channelId, 'comp', memberId] as const,
  revenue: (channelId: string) => ['channels', channelId, 'revenue'] as const,
  giftPasses: (channelId: string) => ['channels', channelId, 'gift-passes'] as const,
  pledges: (channelId: string) => ['channels', channelId, 'pledges'] as const,
};

const base = (channelId: string) => `/api/v1/channels/${channelId}`;

/** feature_disabled is an answer, not a hiccup: don't retry it. */
const retryUnlessOff = (count: number, error: unknown) => !isFeatureDisabled(error) && count < 2;

// ---- Settings → Payments -------------------------------------------------------------------

export const paymentsQuery = (channelId: string) =>
  queryOptions({
    queryKey: moneyKeys.payments(channelId),
    queryFn: ({ signal }) => api.get<PaymentsStatus>(`${base(channelId)}/payments`, signal),
  });

/** Asks for Stripe's Connect page; the caller sends the browser there. */
export const useConnectStripe = (channelId: string) =>
  useMutation({
    mutationFn: () => api.post<ConnectUrl>(`${base(channelId)}/payments/connect`),
  });

function usePaymentsMutation<I>(channelId: string, call: (input: I) => Promise<PaymentsStatus>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (status) => {
      client.setQueryData(moneyKeys.payments(channelId), status);
      void client.invalidateQueries({ queryKey: moneyKeys.levels(channelId) });
    },
  });
}

export const useUpdatePayments = (channelId: string) =>
  usePaymentsMutation(channelId, (input: UpdatePayments) =>
    api.patch<PaymentsStatus>(`${base(channelId)}/payments`, input),
  );

const paypalKey = (channelId: string) => ['channels', channelId, 'paypal'] as const;

export const paypalQuery = (channelId: string) =>
  queryOptions({
    queryKey: paypalKey(channelId),
    queryFn: ({ signal }) => api.get<PayPalStatus>(`${base(channelId)}/payments/paypal`, signal),
  });

function usePayPalMutation<I>(channelId: string, call: (input: I) => Promise<PayPalStatus>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: (status) => client.setQueryData(paypalKey(channelId), status),
  });
}

export const useConnectPayPal = (channelId: string) =>
  usePayPalMutation(channelId, (input: ConnectPayPal) =>
    api.put<PayPalStatus>(`${base(channelId)}/payments/paypal`, input),
  );

export const useDisconnectPayPal = (channelId: string) =>
  usePayPalMutation(channelId, () =>
    api.delete<PayPalStatus>(`${base(channelId)}/payments/paypal`),
  );

export const useConnectStripeKey = (channelId: string) =>
  usePaymentsMutation(channelId, (input: ConnectStripeKey) =>
    api.put<PaymentsStatus>(`${base(channelId)}/payments/stripe-key`, input),
  );

export const useDisconnectStripe = (channelId: string) =>
  usePaymentsMutation(channelId, () =>
    api.post<PaymentsStatus>(`${base(channelId)}/payments/disconnect`),
  );

// ---- Membership levels ---------------------------------------------------------------------

export const levelsQuery = (channelId: string, includeArchived = false) =>
  queryOptions({
    queryKey: [...moneyKeys.levels(channelId), { includeArchived }],
    queryFn: ({ signal }) =>
      api.get<MembershipLevelList>(
        `${base(channelId)}/levels${includeArchived ? '?includeArchived=true' : ''}`,
        signal,
      ),
  });

/** One level, with its retired prices too. */
export const levelQuery = (channelId: string, levelId: string) =>
  queryOptions({
    queryKey: moneyKeys.level(channelId, levelId),
    queryFn: ({ signal }) =>
      api.get<MembershipLevel>(`${base(channelId)}/levels/${levelId}`, signal),
  });

export function useCreateLevel(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMembershipLevel) =>
      api.post<MembershipLevel>(`${base(channelId)}/levels`, input),
    onSuccess: (level) => {
      client.setQueryData(moneyKeys.level(channelId, level.id), level);
      void client.invalidateQueries({ queryKey: moneyKeys.levels(channelId), exact: false });
    },
  });
}

export function useUpdateLevel(channelId: string, levelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMembershipLevel) =>
      api.patch<MembershipLevel>(`${base(channelId)}/levels/${levelId}`, input),
    onSuccess: (level) => {
      client.setQueryData(moneyKeys.level(channelId, levelId), level);
      void client.invalidateQueries({ queryKey: moneyKeys.levels(channelId) });
    },
  });
}

function usePriceMutation<I, O>(
  channelId: string,
  levelId: string,
  call: (input: I) => Promise<O>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    // Prices change the level and the list (and may retire another price): refetch both.
    onSuccess: () => client.invalidateQueries({ queryKey: moneyKeys.levels(channelId) }),
  });
}

/** A new price now, or a scheduled change (effectiveAt). */
export const useAddPrice = (channelId: string, levelId: string) =>
  usePriceMutation(channelId, levelId, (input: CreateLevelPrice) =>
    api.post<LevelPrice>(`${base(channelId)}/levels/${levelId}/prices`, input),
  );

/** Cancels a scheduled change, or stops offering an active price. */
export const useRetirePrice = (channelId: string, levelId: string) =>
  usePriceMutation(channelId, levelId, (priceId: string) =>
    api.delete(`${base(channelId)}/levels/${levelId}/prices/${priceId}`),
  );

// ---- Coupons -------------------------------------------------------------------------------

export const couponsQuery = (channelId: string) =>
  queryOptions({
    queryKey: moneyKeys.coupons(channelId),
    queryFn: ({ signal }) =>
      api.get<{ items: Coupon[] }>(`${base(channelId)}/coupons`, signal).then((r) => r.items),
  });

export function useCreateCoupon(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCoupon) => api.post<Coupon>(`${base(channelId)}/coupons`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: moneyKeys.coupons(channelId) }),
  });
}

export function useUpdateCoupon(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateCoupon & { id: string }) =>
      api.patch<Coupon>(`${base(channelId)}/coupons/${id}`, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: moneyKeys.coupons(channelId) });
      // Archiving takes a coupon out of the Gate.
      void client.invalidateQueries({ queryKey: moneyKeys.gateSettings(channelId) });
    },
  });
}

// ---- Comp access ---------------------------------------------------------------------------

export const memberCompQuery = (channelId: string, memberId: string) =>
  queryOptions({
    queryKey: moneyKeys.comp(channelId, memberId),
    queryFn: ({ signal }) =>
      api
        .get<{ items: CompGrant[] }>(`${base(channelId)}/members/${memberId}/comp`, signal)
        .then((r) => r.items),
  });

function useCompMutation<I, O>(
  channelId: string,
  memberId: string,
  call: (input: I) => Promise<O>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: moneyKeys.comp(channelId, memberId) });
      void client.invalidateQueries({ queryKey: memberKeys.detail(memberId), exact: true });
      void client.invalidateQueries({ queryKey: moneyKeys.levels(channelId) });
      void client.invalidateQueries({ queryKey: moneyKeys.revenue(channelId) });
    },
  });
}

export const useGrantComp = (channelId: string, memberId: string) =>
  useCompMutation(channelId, memberId, (input: CreateCompGrant) =>
    api.post<CompGrant>(`${base(channelId)}/members/${memberId}/comp`, input),
  );

export const useRevokeComp = (channelId: string, memberId: string) =>
  useCompMutation(channelId, memberId, (grantId: string) =>
    api.delete(`${base(channelId)}/comp-grants/${grantId}`),
  );

// ---- Gates and the meter -------------------------------------------------------------------

export const gateQuery = (dispatchId: string) =>
  queryOptions({
    queryKey: moneyKeys.gate(dispatchId),
    queryFn: ({ signal }) => api.get<Gate>(`/api/v1/dispatches/${dispatchId}/gate`, signal),
  });

export function usePutGate(dispatchId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: PutGate) => api.put<Gate>(`/api/v1/dispatches/${dispatchId}/gate`, input),
    onSuccess: (gate) => client.setQueryData(moneyKeys.gate(dispatchId), gate),
  });
}

export const gateSettingsQuery = (channelId: string) =>
  queryOptions({
    queryKey: moneyKeys.gateSettings(channelId),
    queryFn: ({ signal }) => api.get<GateSettings>(`${base(channelId)}/gate-settings`, signal),
  });

export function useUpdateGateSettings(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateGateSettings) =>
      api.patch<GateSettings>(`${base(channelId)}/gate-settings`, input),
    onSuccess: (settings) => client.setQueryData(moneyKeys.gateSettings(channelId), settings),
  });
}

/** Extra gated reads on the meter for a Member, this period. */
export const useMeterGrant = (channelId: string, memberId: string) =>
  useMutation({
    mutationFn: (extra: number) =>
      api.post<MeterGrant>(`${base(channelId)}/members/${memberId}/meter-grants`, { extra }),
  });

// ---- Gift Passes and pledges ---------------------------------------------------------------

export const giftPassesQuery = (channelId: string, status: string) =>
  queryOptions({
    queryKey: [...moneyKeys.giftPasses(channelId), status],
    queryFn: ({ signal }) =>
      api.get<{ items: GiftPass[]; nextCursor: string | null }>(
        `${base(channelId)}/gift-passes?limit=100${status ? `&status=${status}` : ''}`,
        signal,
      ),
    retry: retryUnlessOff,
  });

export const pledgesQuery = (channelId: string, status: string) =>
  queryOptions({
    queryKey: [...moneyKeys.pledges(channelId), status],
    queryFn: ({ signal }) =>
      api.get<{ items: Pledge[]; nextCursor: string | null }>(
        `${base(channelId)}/pledges?limit=100${status ? `&status=${status}` : ''}`,
        signal,
      ),
    retry: retryUnlessOff,
  });

export interface PledgeNotifyResult {
  notified: number;
  emailed: number;
  remaining: number;
}

export function useNotifyPledgers(channelId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<PledgeNotifyResult>(`${base(channelId)}/pledges/notify`),
    onSuccess: () => client.invalidateQueries({ queryKey: moneyKeys.pledges(channelId) }),
  });
}

// ---- Revenue -------------------------------------------------------------------------------

export const revenueQuery = (channelId: string, range: { from: string; to: string }) =>
  queryOptions({
    queryKey: [...moneyKeys.revenue(channelId), range],
    queryFn: ({ signal }) =>
      api.get<Revenue>(
        `${base(channelId)}/revenue?${new URLSearchParams({ from: range.from, to: range.to })}`,
        signal,
      ),
    placeholderData: (previous) => previous,
  });
