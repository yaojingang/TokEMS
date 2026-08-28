import { describe, expect, it } from 'vitest';
import type { EventPurchaseContext } from '@conference/contracts';
import {
  createRegistrationIntent,
  customerRegistrationTicketHref,
  parseAttendeeClaimFragment,
  registrationIdempotencyKey,
  resolveRegistrationIntent,
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

  it('points paid purchasers to the purchases section', () => {
    expect(
      resolveHomeRegistrationCta({
        eventSlug: 'geo-2026',
        ticketId: 'ticket-1',
        priceLabel: '¥399',
        state: 'ready',
        context,
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
