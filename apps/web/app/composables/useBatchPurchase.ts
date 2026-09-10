import type {
  ClaimInvitationResult,
  CustomerOrderDetail,
  GenerateClaimInvitation,
  SelectedOrderItems,
  UpdatePurchasedOrderAttendee,
} from '@conference/contracts';
import { useCustomerSession } from './useCustomerSession';

/** Purchaser-only batch actions use the existing customer session and CSRF protection. */
export function useBatchPurchase() {
  const config = useRuntimeConfig();
  const customer = useCustomerSession();
  const api = useConferenceApi();
  const baseURL = import.meta.server ? config.apiInternalBase : config.public.apiBase;
  const orderPath = (orderId: string) => `/customer/orders/${encodeURIComponent(orderId)}`;
  const headers = (key?: string) => ({
    'X-Organization-Slug': config.public.organizationSlug,
    ...(customer.session.value?.csrfToken
      ? { 'X-CSRF-Token': customer.session.value.csrfToken }
      : {}),
    ...(key ? { 'Idempotency-Key': key } : {}),
  });
  return {
    quote: api.quoteRegistrationBatch,
    create: api.createRegistrationBatch,
    detail: (orderId: string) =>
      $fetch<CustomerOrderDetail>(orderPath(orderId), {
        baseURL,
        credentials: 'include',
        headers: headers(),
        retry: 0,
        timeout: 6_000,
      }),
    cancel: (orderId: string, expectedVersion: number, key: string) =>
      $fetch<CustomerOrderDetail>(`${orderPath(orderId)}/cancel`, {
        method: 'POST',
        baseURL,
        credentials: 'include',
        headers: headers(key),
        body: { expectedVersion },
        retry: 0,
        timeout: 15_000,
      }),
    cancelFree: (orderId: string, input: SelectedOrderItems, key: string) =>
      $fetch<CustomerOrderDetail>(`${orderPath(orderId)}/items/cancel-free`, {
        method: 'POST',
        baseURL,
        credentials: 'include',
        headers: headers(key),
        body: input,
        retry: 0,
        timeout: 15_000,
      }),
    updateAttendee: (
      orderId: string,
      itemId: string,
      expectedVersion: number,
      input: UpdatePurchasedOrderAttendee,
      key: string,
    ) =>
      $fetch<CustomerOrderDetail>(
        `${orderPath(orderId)}/items/${encodeURIComponent(itemId)}/attendee`,
        {
          method: 'PATCH',
          baseURL,
          credentials: 'include',
          headers: headers(key),
          body: { ...input, expectedVersion },
          retry: 0,
          timeout: 15_000,
        },
      ),
    invitation: (orderId: string, itemId: string, input: GenerateClaimInvitation, key: string) =>
      $fetch<ClaimInvitationResult>(
        `${orderPath(orderId)}/items/${encodeURIComponent(itemId)}/claim-invitation`,
        {
          method: 'POST',
          baseURL,
          credentials: 'include',
          headers: headers(key),
          body: input,
          retry: 0,
          timeout: 15_000,
        },
      ),
  };
}

export function batchErrorMessage(error: unknown, fallback: string) {
  const failure = error as { data?: { message?: string }; message?: string };
  return failure.data?.message ?? failure.message ?? fallback;
}

export function batchErrorStatus(error: unknown) {
  const failure = error as { statusCode?: number; status?: number; response?: { status?: number } };
  return failure.statusCode ?? failure.status ?? failure.response?.status;
}
