import { describe, expect, it } from 'vitest';
import type { CustomerPurchasedOrder, EventPurchaseContext } from '@conference/contracts';
import {
  canRestartSelfOrder,
  canResumePendingOrder,
  createRegistrationIntent,
  customerRegistrationTicketHref,
  parseAttendeeClaimFragment,
  registrationIdempotencyKey,
  resolveRegistrationIntent,
  resolveSelfRegistrationState,
  shouldRefreshPurchasedOrder,
  resolveHomeRegistrationCta,
  resolveCheckoutSuccessDestination,
} from './purchase-journey';

const context: EventPurchaseContext = {
  eventId: 101,
  additionalPurchaseEnabled: true,
  maxActiveSeatsPerPurchaser: 5,
  activeSeatCount: 1,
  remainingSeatCount: 4,
  canPurchaseAdditional: true,
  myAttendance: null,
  selfRegistrationState: 'none',
  myPurchases: { paidCount: 1, pendingCount: 0, activeSeatCount: 1 },
  resumePaymentOrderId: null,
  recommendedActions: ['buy_more', 'register_self'],
};

describe('purchase journey helpers', () => {
  it('keeps the public registration CTA until authenticated context is ready', () => {
    expect(
      resolveHomeRegistrationCta({
        eventSlug: 'geo-2026',
        ticketId: 'ticket-1',
        priceLabel: '¥399',
        state: 'loading',
      }),
    ).toEqual({ kind: 'loading', label: '正在确认报名状态', href: '#' });
  });

  it('prioritizes a resumable payment over prior paid purchases', () => {
    const pendingOrderId = '6da64028-8d52-44ee-9262-9ca5922bc2d9';
    expect(
      resolveHomeRegistrationCta({
        eventSlug: 'geo-2026',
        ticketId: 'ticket-1',
        priceLabel: '¥399',
        state: 'ready',
        context: {
          ...context,
          myPurchases: { paidCount: 1, pendingCount: 1, activeSeatCount: 2 },
          resumePaymentOrderId: pendingOrderId,
          recommendedActions: ['resume_payment', 'buy_more'],
        },
        resumePaymentHref: `/e/geo-2026/order/${pendingOrderId}`,
      }),
    ).toEqual({
      kind: 'resume_payment',
      label: '继续支付',
      href: `/e/geo-2026/order/${pendingOrderId}`,
    });
  });

  it('prioritizes self-registration for purchasers who only bought for others', () => {
    expect(
      resolveHomeRegistrationCta({
        eventSlug: 'geo-2026',
        ticketId: 'ticket-1',
        priceLabel: '¥399',
        state: 'ready',
        context,
      }),
    ).toEqual({
      kind: 'register',
      label: '立即报名 ¥399',
      href: '/register?event=geo-2026&ticket=ticket-1',
    });
  });

  it('points paid purchasers at their orders when self-registration is unavailable', () => {
    expect(
      resolveHomeRegistrationCta({
        eventSlug: 'geo-2026',
        ticketId: 'ticket-1',
        priceLabel: '¥399',
        state: 'ready',
        context: {
          ...context,
          activeSeatCount: 5,
          remainingSeatCount: 0,
          canPurchaseAdditional: false,
          myPurchases: { paidCount: 1, pendingCount: 0, activeSeatCount: 5 },
          recommendedActions: [],
        },
      }),
    ).toEqual({
      kind: 'purchases',
      label: '已购 1 个名额 · 查看报名',
      href: '/account?event=geo-2026#purchases',
    });
  });

  it('routes attendee-only accounts to their ticket or attendance record', () => {
    expect(
      resolveHomeRegistrationCta({
        eventSlug: 'geo-2026',
        ticketId: 'ticket-1',
        priceLabel: '¥399',
        state: 'ready',
        context: {
          ...context,
          myAttendance: {
            registrationId: '503d251a-7a43-43e8-99c3-708d2a0f4f0d',
            registrationStatus: 'confirmed',
            ticketCode: 'TOK-TICKET-1',
            ticketStatus: 'valid',
          },
          selfRegistrationState: 'active',
          myPurchases: { paidCount: 0, pendingCount: 0, activeSeatCount: 0 },
          recommendedActions: ['view_ticket'],
        },
      }),
    ).toEqual({
      kind: 'view_ticket',
      label: '查看电子票',
      href: '/ticket/TOK-TICKET-1?event=geo-2026',
    });

    expect(
      resolveHomeRegistrationCta({
        eventSlug: 'geo-2026',
        ticketId: 'ticket-1',
        priceLabel: '¥399',
        state: 'ready',
        context: {
          ...context,
          myAttendance: {
            registrationId: '503d251a-7a43-43e8-99c3-708d2a0f4f0d',
            registrationStatus: 'pending_review',
            ticketCode: null,
            ticketStatus: null,
          },
          selfRegistrationState: 'active',
          myPurchases: { paidCount: 0, pendingCount: 0, activeSeatCount: 0 },
          recommendedActions: [],
        },
      }),
    ).toEqual({
      kind: 'attendance',
      label: '查看参会名额',
      href: '/account?event=geo-2026#events',
    });
  });

  it('allows a customer with a cancelled attendance record to register again', () => {
    expect(
      resolveHomeRegistrationCta({
        eventSlug: 'geo-2026',
        ticketId: 'ticket-1',
        priceLabel: '¥399',
        state: 'ready',
        context: {
          ...context,
          myAttendance: {
            registrationId: '503d251a-7a43-43e8-99c3-708d2a0f4f0d',
            registrationStatus: 'cancelled',
            ticketCode: null,
            ticketStatus: null,
          },
          selfRegistrationState: 'closed',
          myPurchases: { paidCount: 0, pendingCount: 0, activeSeatCount: 0 },
          resumePaymentOrderId: null,
          recommendedActions: ['register_self'],
        },
      }),
    ).toEqual({
      kind: 'register',
      label: '立即报名 ¥399',
      href: '/register?event=geo-2026&ticket=ticket-1',
    });
  });

  it('distinguishes a recoverable closed registration from an active attendance', () => {
    const cancelledContext: EventPurchaseContext = {
      ...context,
      additionalPurchaseEnabled: false,
      canPurchaseAdditional: false,
      activeSeatCount: 0,
      remainingSeatCount: 5,
      myAttendance: {
        registrationId: '503d251a-7a43-43e8-99c3-708d2a0f4f0d',
        registrationStatus: 'cancelled',
        ticketCode: null,
        ticketStatus: null,
      },
      selfRegistrationState: 'closed',
      myPurchases: { paidCount: 0, pendingCount: 0, activeSeatCount: 0 },
      recommendedActions: ['register_self'],
    };
    expect(resolveSelfRegistrationState(cancelledContext)).toBe('closed');
    expect(
      resolveSelfRegistrationState({
        ...cancelledContext,
        recommendedActions: [],
      }),
    ).toBe('closed');
    expect(
      resolveHomeRegistrationCta({
        eventSlug: 'geo-2026',
        ticketId: 'ticket-1',
        priceLabel: '¥399',
        state: 'ready',
        context: { ...cancelledContext, recommendedActions: [] },
      }),
    ).toEqual({
      kind: 'purchases',
      label: '查看已关闭订单',
      href: '/account?event=geo-2026#purchases',
    });
    expect(
      resolveSelfRegistrationState({
        ...cancelledContext,
        myAttendance: {
          ...cancelledContext.myAttendance!,
          registrationStatus: 'pending_payment',
        },
        recommendedActions: [],
        selfRegistrationState: 'closed',
      } as EventPurchaseContext & { selfRegistrationState: 'closed' }),
    ).toBe('closed');
    expect(
      resolveSelfRegistrationState({
        ...cancelledContext,
        myAttendance: { ...cancelledContext.myAttendance!, registrationStatus: 'confirmed' },
        selfRegistrationState: 'active',
        recommendedActions: [],
      }),
    ).toBe('active');

    const closedSelfOrder = {
      registrationId: cancelledContext.myAttendance!.registrationId,
      status: 'closed',
      isProxyPurchase: false,
    } as Pick<CustomerPurchasedOrder, 'registrationId' | 'status' | 'isProxyPurchase'>;
    expect(canRestartSelfOrder(closedSelfOrder, cancelledContext)).toBe(true);
    expect(
      canRestartSelfOrder({ ...closedSelfOrder, status: 'pending_payment' }, cancelledContext),
    ).toBe(true);
    expect(
      canRestartSelfOrder({ ...closedSelfOrder, isProxyPurchase: true }, cancelledContext),
    ).toBe(false);
  });

  it('only resumes a pending order while the server still marks it payable', () => {
    const order = {
      id: '6da64028-8d52-44ee-9262-9ca5922bc2d9',
      status: 'pending_payment',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as Pick<CustomerPurchasedOrder, 'id' | 'status' | 'expiresAt'>;
    const resumableContext: EventPurchaseContext = {
      ...context,
      myPurchases: { paidCount: 0, pendingCount: 1, activeSeatCount: 1 },
      selfRegistrationState: 'active',
      resumePaymentOrderId: order.id,
      recommendedActions: ['resume_payment'],
    };
    expect(canResumePendingOrder(order, resumableContext)).toBe(true);
    expect(canResumePendingOrder(order, { ...resumableContext, resumePaymentOrderId: null })).toBe(
      false,
    );
    expect(canResumePendingOrder({ ...order, status: 'processing' }, resumableContext)).toBe(false);
    expect(
      canResumePendingOrder(
        { ...order, expiresAt: new Date(Date.now() - 60_000).toISOString() },
        resumableContext,
      ),
    ).toBe(false);
  });

  it('refreshes a locally closed order after the same registration becomes active elsewhere', () => {
    const registrationId = '503d251a-7a43-43e8-99c3-708d2a0f4f0d';
    const order = {
      id: '6da64028-8d52-44ee-9262-9ca5922bc2d9',
      registrationId,
      status: 'closed',
    } as Pick<CustomerPurchasedOrder, 'id' | 'registrationId' | 'status'>;
    const activeContext: EventPurchaseContext = {
      ...context,
      myAttendance: {
        registrationId,
        registrationStatus: 'confirmed',
        ticketCode: 'TOK-TICKET-1',
        ticketStatus: 'valid',
      },
      selfRegistrationState: 'active',
      recommendedActions: ['view_ticket'],
    };

    expect(shouldRefreshPurchasedOrder(order, activeContext)).toBe(true);
    expect(
      shouldRefreshPurchasedOrder(order, {
        ...activeContext,
        myAttendance: { ...activeContext.myAttendance!, registrationId: crypto.randomUUID() },
      }),
    ).toBe(false);
  });

  it('prioritizes the server self-registration action over paid proxy purchases', () => {
    expect(
      resolveHomeRegistrationCta({
        eventSlug: 'geo-2026',
        ticketId: 'ticket-1',
        priceLabel: '¥399',
        state: 'ready',
        context: {
          ...context,
          myAttendance: {
            registrationId: '503d251a-7a43-43e8-99c3-708d2a0f4f0d',
            registrationStatus: 'cancelled',
            ticketCode: null,
            ticketStatus: null,
          },
          selfRegistrationState: 'closed',
          myPurchases: { paidCount: 1, pendingCount: 0, activeSeatCount: 1 },
          recommendedActions: ['buy_more', 'register_self'],
        },
      }),
    ).toEqual({
      kind: 'register',
      label: '立即报名 ¥399',
      href: '/register?event=geo-2026&ticket=ticket-1',
    });
  });

  it('keeps registration-detail ticket links in the current event scope', () => {
    expect(customerRegistrationTicketHref('TOK-TICKET-1', 'geo-2026')).toBe(
      '/ticket/TOK-TICKET-1?event=geo-2026',
    );
  });

  it('keeps proxy checkout completion on purchaser order management', () => {
    expect(
      resolveCheckoutSuccessDestination({
        isProxyPurchase: true,
        eventSlug: 'geo-2026',
        registrationId: 'registration-1',
        ticketCode: 'TOK-TICKET-1',
        memberProfileEnabled: true,
        attendeeNeedsEnabled: true,
      }),
    ).toBeNull();
    expect(
      resolveCheckoutSuccessDestination({
        isProxyPurchase: false,
        eventSlug: 'geo-2026',
        registrationId: 'registration-1',
        ticketCode: 'TOK-TICKET-1',
        memberProfileEnabled: true,
        attendeeNeedsEnabled: true,
      }),
    ).toBe('/account/registrations/registration-1/showcase?event=geo-2026');
  });

  it('continues to attendee needs when the profile step is disabled', () => {
    expect(
      resolveCheckoutSuccessDestination({
        isProxyPurchase: false,
        eventSlug: 'geo-2026',
        registrationId: 'registration-1',
        ticketCode: 'TOK-TICKET-1',
        memberProfileEnabled: false,
        attendeeNeedsEnabled: true,
      }),
    ).toBe('/account/registrations/registration-1/needs?event=geo-2026');
  });

  it('creates a fresh UUID when the purchaser starts another seat', () => {
    const first = createRegistrationIntent();
    const second = createRegistrationIntent();
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second).not.toBe(first);
  });

  it('keeps registration retries on the purchase intent idempotency key', () => {
    const purchaseIntentId = '503d251a-7a43-43e8-99c3-708d2a0f4f0d';
    expect(registrationIdempotencyKey(purchaseIntentId)).toBe(`registration-${purchaseIntentId}`);
    expect(registrationIdempotencyKey(purchaseIntentId)).toBe(`registration-${purchaseIntentId}`);
  });

  it('accepts only strict UUID purchase intents and replaces missing or malformed values', () => {
    const valid = '503d251a-7a43-43e8-99c3-708d2a0f4f0d';
    expect(resolveRegistrationIntent(valid)).toEqual({
      purchaseIntentId: valid,
      shouldReplace: false,
    });
    expect(resolveRegistrationIntent('------------------------------------')).toMatchObject({
      purchaseIntentId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      shouldReplace: true,
    });
    expect(resolveRegistrationIntent(null)).toMatchObject({ shouldReplace: true });
  });

  it('reads attendee claim credentials only from a valid fragment', () => {
    const registrationId = '6da64028-8d52-44ee-9262-9ca5922bc2d9';
    const claimToken = 'a'.repeat(48);
    expect(
      parseAttendeeClaimFragment(`#registration=${registrationId}&claim=${claimToken}`),
    ).toEqual({ registrationId, claimToken });
    expect(parseAttendeeClaimFragment(`#registration=bad&claim=${claimToken}`)).toBeNull();
    expect(parseAttendeeClaimFragment('')).toBeNull();
  });
});
