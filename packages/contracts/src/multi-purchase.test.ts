import { describe, expect, it } from 'vitest';
import {
  CreateRegistrationSchema,
  AttendeeClaimInputSchema,
  AttendeeClaimResultSchema,
  CustomerPurchasedOrderListSchema,
  CustomerOrderAccessSchema,
  CustomerRegistrationSummarySchema,
  EventRegistrationSettingsSchema,
  EventPurchaseContextSchema,
  EventSettingsSchema,
  RegistrationCheckoutSchema,
  UpdatePurchasedOrderAttendeeSchema,
} from './index.js';

describe('event multi-purchase settings contracts', () => {
  it('defaults stored events to one purchase flow with a five-seat purchaser limit', () => {
    expect(EventRegistrationSettingsSchema.parse({})).toMatchObject({
      additionalPurchaseEnabled: false,
      maxActiveSeatsPerPurchaser: 5,
    });
    expect(EventSettingsSchema.parse({}).registration).toMatchObject({
      additionalPurchaseEnabled: false,
      maxActiveSeatsPerPurchaser: 5,
    });
  });

  it('accepts purchaser seat limits from 1 through 20 only', () => {
    expect(
      EventRegistrationSettingsSchema.safeParse({ maxActiveSeatsPerPurchaser: 1 }).success,
    ).toBe(true);
    expect(
      EventRegistrationSettingsSchema.safeParse({ maxActiveSeatsPerPurchaser: 20 }).success,
    ).toBe(true);
    expect(
      EventRegistrationSettingsSchema.safeParse({ maxActiveSeatsPerPurchaser: 0 }).success,
    ).toBe(false);
    expect(
      EventRegistrationSettingsSchema.safeParse({ maxActiveSeatsPerPurchaser: 21 }).success,
    ).toBe(false);
  });
});

describe('multi-purchase customer API contracts', () => {
  const registrationSummary = {
    id: 'registration-1',
    eventId: 101,
    eventName: 'GEO 大会',
    eventSlug: 'geo-2026',
    startsAt: '2026-09-01T01:00:00.000Z',
    endsAt: '2026-09-01T10:00:00.000Z',
    registrationCode: 'REG-1',
    registrationStatus: 'confirmed' as const,
    attendeeName: '参会人',
    ticketTypeName: '标准票',
    orderId: null,
    orderNo: null,
    orderStatus: null,
    amount: null,
    currency: null,
    ticketCode: 'TICKET-1',
    ticketStatus: 'valid' as const,
    invoiceId: null,
    invoiceStatus: null,
    canManageOrder: false,
    createdAt: '2026-08-15T01:00:00.000Z',
  };

  it('describes the signed-in purchaser capacity for an event', () => {
    expect(
      EventPurchaseContextSchema.parse({
        eventId: 101,
        additionalPurchaseEnabled: true,
        maxActiveSeatsPerPurchaser: 5,
        activeSeatCount: 2,
        remainingSeatCount: 3,
        canPurchaseAdditional: true,
        myAttendance: {
          registrationId: '33333333-3333-4333-8333-333333333333',
          registrationStatus: 'confirmed',
          ticketCode: 'TICKET-SELF',
          ticketStatus: 'valid',
        },
        selfRegistrationState: 'active',
        myPurchases: { paidCount: 1, pendingCount: 1, activeSeatCount: 2 },
        resumePaymentOrderId: '44444444-4444-4444-8444-444444444444',
        recommendedActions: ['view_ticket', 'resume_payment', 'buy_more'],
      }),
    ).toMatchObject({
      activeSeatCount: 2,
      remainingSeatCount: 3,
      selfRegistrationState: 'active',
      myPurchases: { paidCount: 1, pendingCount: 1 },
      resumePaymentOrderId: '44444444-4444-4444-8444-444444444444',
    });
  });

  it('keeps attendee-only registration summaries free of order financial data', () => {
    expect(CustomerRegistrationSummarySchema.parse(registrationSummary)).toMatchObject({
      canManageOrder: false,
      amount: null,
      invoiceId: null,
    });
  });

  it('rejects order financial data when the attendee cannot manage the order', () => {
    expect(
      CustomerRegistrationSummarySchema.safeParse({
        ...registrationSummary,
        orderId: 'order-1',
        orderNo: 'ORDER-1',
        orderStatus: 'paid',
        amount: 39900,
        currency: 'CNY',
        invoiceId: 'invoice-1',
        invoiceStatus: 'issued',
      }).success,
    ).toBe(false);
  });

  it('defaults legacy self-purchase summaries to manageable orders with required order data', () => {
    const { canManageOrder: _canManageOrder, ...legacy } = registrationSummary;
    void _canManageOrder;
    expect(
      CustomerRegistrationSummarySchema.parse({
        ...legacy,
        orderId: 'order-1',
        orderNo: 'ORDER-1',
        orderStatus: 'paid',
        amount: 39900,
        currency: 'CNY',
      }),
    ).toMatchObject({ canManageOrder: true, orderId: 'order-1', amount: 39900 });
    expect(CustomerRegistrationSummarySchema.safeParse(legacy).success).toBe(false);
  });

  it('represents purchased orders separately from attendee registrations', () => {
    expect(
      CustomerPurchasedOrderListSchema.parse({
        items: [
          {
            id: 'order-1',
            orderNo: 'ORDER-1',
            registrationId: 'registration-1',
            eventId: 101,
            eventName: 'GEO 大会',
            eventSlug: 'geo-2026',
            attendeeName: '参会人',
            attendeeMobile: '13800138000',
            isProxyPurchase: true,
            attendeeClaimed: false,
            canEditAttendee: true,
            ticketTypeName: '标准票',
            status: 'paid',
            paymentStatus: 'succeeded',
            amount: 39900,
            currency: 'CNY',
            ticketCode: 'TICKET-1',
            ticketStatus: 'valid',
            invoiceId: null,
            invoiceStatus: null,
            expiresAt: '2026-08-15T01:15:00.000Z',
            createdAt: '2026-08-15T01:00:00.000Z',
          },
        ],
        nextCursor: null,
      }).items,
    ).toEqual([
      expect.objectContaining({
        attendeeClaimed: false,
        canEditAttendee: true,
        isProxyPurchase: true,
      }),
    ]);
  });

  it('marks checkout ownership so proxy completion never opens attendee-only surfaces', () => {
    const result = RegistrationCheckoutSchema.parse({
      isProxyPurchase: true,
      registration: {
        id: 'registration-1',
        eventId: 101,
        registrationCode: 'REG-1',
        status: 'confirmed',
        attendee: {
          name: '参会人',
          mobile: '13800138000',
          email: '',
          company: '',
          title: '',
          city: '',
        },
        ticketType: {
          id: 'ticket-1',
          name: '标准票',
          description: '',
          price: 0,
          currency: 'CNY',
          remaining: 1,
          benefits: [],
          recommended: false,
        },
        createdAt: '2026-08-15T01:00:00.000Z',
      },
      order: {
        id: 'order-1',
        orderNo: 'ORDER-1',
        registrationId: 'registration-1',
        status: 'paid',
        amount: 0,
        currency: 'CNY',
        paymentMethod: 'free',
        expiresAt: '2026-08-15T01:00:00.000Z',
        createdAt: '2026-08-15T01:00:00.000Z',
      },
    });

    expect(result.isProxyPurchase).toBe(true);
    expect(
      CustomerOrderAccessSchema.parse({
        ...result.order,
        isProxyPurchase: result.isProxyPurchase,
      }).isProxyPurchase,
    ).toBe(true);
  });

  it('validates attendee claim input and returns the claimed registration', () => {
    expect(
      AttendeeClaimInputSchema.safeParse({
        registrationId: 'registration-1',
        claimToken: 'short',
      }).success,
    ).toBe(false);
    expect(
      AttendeeClaimInputSchema.safeParse({
        registrationId: '11111111-1111-4111-8111-111111111111',
        claimToken: 'a'.repeat(32),
      }).success,
    ).toBe(true);
    expect(
      AttendeeClaimResultSchema.parse({
        claimed: true,
        claimedAt: '2026-08-15T02:00:00.000Z',
        registration: registrationSummary,
      }).registration.id,
    ).toBe('registration-1');
  });

  it('keeps attendee claim results free of purchaser-only financial data', () => {
    expect(
      AttendeeClaimResultSchema.safeParse({
        claimed: true,
        claimedAt: '2026-08-15T02:00:00.000Z',
        registration: {
          ...registrationSummary,
          orderId: 'order-1',
          orderNo: 'ORDER-1',
          orderStatus: 'paid',
          amount: 39900,
          currency: 'CNY',
        },
      }).success,
    ).toBe(false);
  });

  it('accepts bounded purchaser attendee edits and rejects empty patches', () => {
    expect(UpdatePurchasedOrderAttendeeSchema.safeParse({}).success).toBe(false);
    expect(
      UpdatePurchasedOrderAttendeeSchema.safeParse({
        name: '新参会人',
        mobile: '13900139000',
        email: 'new@example.com',
      }).success,
    ).toBe(true);
  });
});

describe('multi-purchase checkout input contract', () => {
  const base = {
    eventId: 101,
    ticketTypeId: 'ticket-standard',
    attendee: { mobile: '13800138000' },
    termsAccepted: true,
    purchaseFor: 'self' as const,
    purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c034891791a7',
  };

  it('requires explicit acceptance of the registration terms', () => {
    expect(CreateRegistrationSchema.safeParse({ ...base, termsAccepted: false }).success).toBe(
      false,
    );
    const { termsAccepted: _termsAccepted, ...withoutTerms } = base;
    void _termsAccepted;
    expect(CreateRegistrationSchema.safeParse(withoutTerms).success).toBe(false);
  });

  it('requires proxy authorization when purchasing for another attendee', () => {
    expect(
      CreateRegistrationSchema.safeParse({
        ...base,
        purchaseFor: 'other',
        proxyAuthorizationAccepted: true,
      }).success,
    ).toBe(true);
    expect(
      CreateRegistrationSchema.safeParse({
        ...base,
        purchaseFor: 'other',
        proxyAuthorizationAccepted: false,
      }).success,
    ).toBe(false);
    expect(
      CreateRegistrationSchema.safeParse({ ...base, proxyAuthorizationAccepted: false }).success,
    ).toBe(true);
  });

  it('accepts only UUID purchase intents and supplies compatibility defaults for internal callers', () => {
    expect(
      CreateRegistrationSchema.safeParse({ ...base, purchaseIntentId: 'intent-123' }).success,
    ).toBe(false);
    expect(CreateRegistrationSchema.parse(base).purchaseIntentId).toBe(base.purchaseIntentId);

    const legacy = CreateRegistrationSchema.parse({
      eventId: 101,
      ticketTypeId: 'ticket-standard',
      attendee: { mobile: '13800138000' },
      termsAccepted: true,
    });
    expect(legacy.purchaseFor).toBe('self');
    expect(legacy.purchaseIntentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(legacy.proxyAuthorizationAccepted).toBe(false);
  });
});
