import { describe, expect, it } from 'vitest';
import type {
  CustomerPurchasedOrder,
  CustomerRegistrationSummary,
  CustomerServiceHubItem,
} from '@conference/contracts';
import {
  selectFeaturedAccountContext,
  selectFeaturedRegistration,
  shouldRevealOrganizerContact,
  visibleServiceHubItems,
} from './account-service-hub';

function registration(
  id: string,
  eventSlug: string,
  startsAt: string,
  endsAt: string,
  registrationStatus: CustomerRegistrationSummary['registrationStatus'] = 'confirmed',
): CustomerRegistrationSummary {
  return {
    id,
    eventId: Number(id),
    eventName: eventSlug,
    eventSlug,
    startsAt,
    endsAt,
    registrationCode: `R-${id}`,
    registrationStatus,
    attendeeName: '参会者',
    ticketTypeName: '大会通票',
    ticketCode: 'TICKET',
    ticketStatus: 'valid',
    createdAt: startsAt,
    canManageOrder: false,
    orderId: null,
    orderNo: null,
    orderStatus: null,
    amount: null,
    currency: null,
    invoiceId: null,
    invoiceStatus: null,
  };
}

function order(id: string, eventSlug: string, status: CustomerPurchasedOrder['status'] = 'paid') {
  return {
    id,
    orderNo: `O-${id}`,
    registrationId: `R-${id}`,
    eventId: Number(id),
    eventName: eventSlug,
    eventSlug,
    attendeeName: '代购参会者',
    attendeeMobile: '138****0000',
    isProxyPurchase: true,
    attendeeClaimed: false,
    canEditAttendee: true,
    ticketTypeName: '大会通票',
    status,
    paymentStatus: null,
    amount: 199900,
    currency: 'CNY',
    ticketCode: null,
    ticketStatus: null,
    invoiceId: null,
    invoiceStatus: null,
    expiresAt: '2026-08-30T00:30:00.000Z',
    createdAt: '2026-08-30T00:00:00.000Z',
  } satisfies CustomerPurchasedOrder;
}

describe('selectFeaturedRegistration', () => {
  const now = new Date('2026-08-30T12:00:00.000Z');
  const ended = registration('1', 'ended', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z');
  const upcoming = registration(
    '2',
    'upcoming',
    '2026-09-20T00:00:00.000Z',
    '2026-09-21T00:00:00.000Z',
  );
  const ongoing = registration(
    '3',
    'ongoing',
    '2026-08-29T00:00:00.000Z',
    '2026-08-31T00:00:00.000Z',
  );
  const pending = registration(
    '4',
    'pending',
    '2026-10-01T00:00:00.000Z',
    '2026-10-02T00:00:00.000Z',
    'pending_payment',
  );

  it('restores an explicitly selected大会', () => {
    expect(selectFeaturedRegistration([pending, ongoing], 'ongoing', now)?.id).toBe('3');
  });

  it('prioritizes action required before event timing', () => {
    expect(selectFeaturedRegistration([ongoing, pending], null, now)?.id).toBe('4');
  });

  it('uses ongoing, nearest upcoming, then most recent ended', () => {
    expect(selectFeaturedRegistration([ended, upcoming, ongoing], null, now)?.id).toBe('3');
    expect(selectFeaturedRegistration([ended, upcoming], null, now)?.id).toBe('2');
    expect(selectFeaturedRegistration([ended], null, now)?.id).toBe('1');
  });
});

describe('selectFeaturedAccountContext', () => {
  it('uses the requested registration when one大会 has multiple tickets', () => {
    const first = registration(
      '1',
      'shared-event',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    );
    const second = registration(
      '2',
      'shared-event',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    );

    expect(
      selectFeaturedAccountContext([first, second], [], 'shared-event', {
        requestedRegistrationId: '2',
      }).registration?.id,
    ).toBe('2');
  });

  it('keeps the fixed-date positional contract for existing callers', () => {
    const ended = registration(
      '1',
      'ended',
      '2026-07-01T00:00:00.000Z',
      '2026-07-02T00:00:00.000Z',
    );
    const upcoming = registration(
      '2',
      'upcoming',
      '2026-09-20T00:00:00.000Z',
      '2026-09-21T00:00:00.000Z',
    );

    expect(
      selectFeaturedAccountContext(
        [ended, upcoming],
        [],
        null,
        new Date('2026-08-30T12:00:00.000Z'),
      ).registration?.id,
    ).toBe('2');
  });

  it('can switch from a personal registration to an order-only event', () => {
    const personal = registration(
      '1',
      'personal-event',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    );
    const proxyOrder = order('2', 'proxy-event');

    expect(
      selectFeaturedAccountContext([personal], [proxyOrder], 'proxy-event').registration,
    ).toBeNull();
    expect(selectFeaturedAccountContext([personal], [proxyOrder], 'proxy-event').order?.id).toBe(
      '2',
    );
  });

  it('falls back to the registration priority when the query is stale', () => {
    const personal = registration(
      '1',
      'personal-event',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    );
    expect(selectFeaturedAccountContext([personal], [], 'removed-event').registration?.id).toBe(
      '1',
    );
  });
});

describe('visibleServiceHubItems', () => {
  it('hides invoice service from attendees who do not manage the order', () => {
    const items = [
      { code: 'ticket', state: 'complete', label: '电子票', description: '可使用' },
      { code: 'invoice', state: 'unavailable', label: '发票', description: '由购买人管理' },
    ] satisfies CustomerServiceHubItem[];
    expect(visibleServiceHubItems(items, false).map((item) => item.code)).toEqual(['ticket']);
    expect(visibleServiceHubItems(items, true)).toHaveLength(2);
  });
});
describe('shouldRevealOrganizerContact', () => {
  it('reveals a matching deep link before availability is considered', () => {
    expect(
      shouldRevealOrganizerContact('organizer_contact', 'registration-1', 'registration-1'),
    ).toBe(true);
    expect(
      shouldRevealOrganizerContact('organizer_contact', 'registration-2', 'registration-1'),
    ).toBe(false);
  });
});
