import {
  publicEventScopedPath,
  type CustomerPurchasedOrder,
  type EventPurchaseContext,
} from '@conference/contracts';

export type HomeRegistrationCta = {
  kind: 'loading' | 'register' | 'resume_payment' | 'purchases' | 'view_ticket' | 'attendance';
  label: string;
  href: string;
};

export function resolveSelfRegistrationState(
  context: EventPurchaseContext | null | undefined,
): 'none' | 'closed' | 'active' {
  return context?.selfRegistrationState ?? 'none';
}

export function canRestartSelfOrder(
  order: Pick<CustomerPurchasedOrder, 'registrationId' | 'status' | 'isProxyPurchase'>,
  context: EventPurchaseContext | null | undefined,
) {
  return (
    ['closed', 'pending_payment'].includes(order.status) &&
    !order.isProxyPurchase &&
    context?.myAttendance?.registrationId === order.registrationId &&
    context?.recommendedActions.includes('register_self') === true
  );
}

export function canResumePendingOrder(
  order: Pick<CustomerPurchasedOrder, 'id' | 'status'>,
  context: EventPurchaseContext | null | undefined,
) {
  return (
    order.status === 'pending_payment' &&
    context?.resumePaymentOrderId === order.id &&
    context.recommendedActions.includes('resume_payment')
  );
}

export function shouldRefreshPurchasedOrder(
  order: Pick<CustomerPurchasedOrder, 'id' | 'registrationId' | 'status'>,
  context: EventPurchaseContext | null | undefined,
) {
  return (
    ['pending_payment', 'processing'].includes(order.status) ||
    context?.resumePaymentOrderId === order.id ||
    (order.status === 'closed' &&
      context?.selfRegistrationState === 'active' &&
      context.myAttendance?.registrationId === order.registrationId)
  );
}

export function resolveHomeRegistrationCta(input: {
  eventSlug: string;
  ticketId: string;
  priceLabel: string;
  state: 'anonymous' | 'loading' | 'failed' | 'ready';
  context?: EventPurchaseContext | null;
  resumePaymentHref?: string;
}): HomeRegistrationCta {
  const register = {
    kind: 'register' as const,
    label: `立即报名 ${input.priceLabel}`,
    href: publicEventScopedPath('/register', input.eventSlug, {
      ticket: input.ticketId,
      ...(input.context?.selfRegistrationState === 'closed' ? { restart: '1' } : {}),
    }),
  };
  if (input.state === 'loading') {
    return { kind: 'loading', label: '正在确认报名状态', href: '#' };
  }
  if (input.state !== 'ready' || !input.context) return register;

  const recommendedActions = new Set(input.context.recommendedActions);
  if (input.context.resumePaymentOrderId && recommendedActions.has('resume_payment')) {
    return {
      kind: 'resume_payment',
      label: '继续支付',
      href:
        input.resumePaymentHref ??
        `${publicEventScopedPath('/account', input.eventSlug, {
          order: input.context.resumePaymentOrderId,
        })}#purchases`,
    };
  }
  if (recommendedActions.has('view_ticket') && input.context.myAttendance?.ticketCode) {
    const ticketCode = input.context.myAttendance.ticketCode;
    return {
      kind: 'view_ticket',
      label: '查看电子票',
      href: publicEventScopedPath(`/ticket/${encodeURIComponent(ticketCode)}`, input.eventSlug),
    };
  }
  if (recommendedActions.has('register_self')) return register;
  if (input.context.myPurchases.paidCount > 0) {
    return {
      kind: 'purchases',
      label: `已购 ${input.context.myPurchases.paidCount} 个名额 · 查看报名`,
      href: `${publicEventScopedPath('/account', input.eventSlug)}#purchases`,
    };
  }
  if (input.context.myAttendance && input.context.selfRegistrationState === 'active') {
    return {
      kind: 'attendance',
      label: '查看参会名额',
      href: `${publicEventScopedPath('/account', input.eventSlug)}#events`,
    };
  }
  if (input.context.selfRegistrationState === 'closed') {
    return {
      kind: 'purchases',
      label: '查看已关闭订单',
      href: `${publicEventScopedPath('/account', input.eventSlug)}#purchases`,
    };
  }
  return register;
}

export function createRegistrationIntent() {
  return crypto.randomUUID();
}

const PURCHASE_INTENT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveRegistrationIntent(value: string | null | undefined) {
  if (value && PURCHASE_INTENT_UUID_PATTERN.test(value)) {
    return { purchaseIntentId: value, shouldReplace: false } as const;
  }
  return { purchaseIntentId: createRegistrationIntent(), shouldReplace: true } as const;
}

type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const INTENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function readStoredRegistrationIntent(storage: IntentStorage | null, key: string, now: number) {
  try {
    const saved = JSON.parse(storage?.getItem(key) ?? 'null');
    if (
      saved &&
      typeof saved.id === 'string' &&
      PURCHASE_INTENT_UUID_PATTERN.test(saved.id) &&
      typeof saved.savedAt === 'number' &&
      saved.savedAt <= now &&
      now - saved.savedAt <= INTENT_MAX_AGE_MS
    )
      return { id: saved.id as string, replaceOnLogin: saved.replaceOnLogin === true };
  } catch {
    /* Restricted storage falls back to the current page state. */
  }
  return undefined;
}

export function registrationIntentStorageKey(
  organizationId: string,
  eventId: number | string,
  ownerId: string,
  purchaseFor: 'self' | 'other',
) {
  return `conference.registrationIntent.${[organizationId, eventId, ownerId, purchaseFor].map((part) => encodeURIComponent(String(part))).join('.')}`;
}

export function storedRegistrationIntent(
  storage: IntentStorage | null,
  key: string,
  preferred?: string,
  now = Date.now(),
) {
  const saved = readStoredRegistrationIntent(storage, key, now);
  const value = preferred || saved?.id;
  const id = resolveRegistrationIntent(value).purchaseIntentId;
  try {
    storage?.setItem(
      key,
      JSON.stringify({
        id,
        savedAt: now,
        // An explicit new attempt or legacy URL stays authoritative through the next login.
        replaceOnLogin: Boolean(preferred) || saved?.replaceOnLogin === true,
      }),
    );
  } catch {
    /* Keep registration usable without storage. */
  }
  return id;
}

export function adoptRegistrationIntent(
  storage: IntentStorage | null,
  anonymousKey: string,
  customerKey: string,
  currentIntent: string,
  now = Date.now(),
) {
  const anonymous = readStoredRegistrationIntent(storage, anonymousKey, now);
  const preferred =
    anonymous?.id === currentIntent && anonymous.replaceOnLogin
      ? currentIntent
      : (readStoredRegistrationIntent(storage, customerKey, now)?.id ?? currentIntent);
  const id = storedRegistrationIntent(storage, customerKey, preferred, now);
  if (anonymousKey !== customerKey) clearRegistrationIntent(storage, anonymousKey);
  return id;
}

export function clearRegistrationIntent(storage: IntentStorage | null, key: string) {
  try {
    storage?.removeItem(key);
  } catch {
    /* A completed checkout remains protected by server idempotency. */
  }
}

export function compactRegistrationPath(
  eventSlug: string,
  query: URLSearchParams,
  singleTicketId?: string,
) {
  const parameters = new URLSearchParams(query);
  parameters.delete('event');
  parameters.delete('intent');
  parameters.delete('restart');
  if (singleTicketId && parameters.get('ticket') === singleTicketId) parameters.delete('ticket');
  if (parameters.get('purchaseFor') === 'self') parameters.delete('purchaseFor');
  return publicEventScopedPath('/register', eventSlug, Object.fromEntries(parameters));
}

export function registrationIdempotencyKey(purchaseIntentId: string) {
  return `registration-${purchaseIntentId}`;
}

export function customerRegistrationTicketHref(ticketCode: string, eventSlug: string) {
  return publicEventScopedPath(`/ticket/${encodeURIComponent(ticketCode)}`, eventSlug);
}

export function resolveCheckoutSuccessDestination(input: {
  isProxyPurchase: boolean;
  eventSlug: string;
  registrationId: string;
  ticketCode?: string | null;
  memberProfileEnabled: boolean;
  attendeeNeedsEnabled: boolean;
}) {
  if (input.isProxyPurchase) return null;
  if (input.memberProfileEnabled) {
    return publicEventScopedPath(
      `/account/registrations/${encodeURIComponent(input.registrationId)}/showcase`,
      input.eventSlug,
    );
  }
  if (input.attendeeNeedsEnabled) {
    return publicEventScopedPath(
      `/account/registrations/${encodeURIComponent(input.registrationId)}/needs`,
      input.eventSlug,
    );
  }
  return input.ticketCode
    ? publicEventScopedPath(`/ticket/${encodeURIComponent(input.ticketCode)}`, input.eventSlug)
    : null;
}

export function parseAttendeeClaimFragment(fragment: string): {
  registrationId: string;
  claimToken: string;
} | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const registrationId = params.get('registration') ?? '';
  const claimToken = params.get('claim') ?? '';
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      registrationId,
    )
  ) {
    return null;
  }
  if (claimToken.length < 32 || claimToken.length > 500) return null;
  return { registrationId, claimToken };
}
