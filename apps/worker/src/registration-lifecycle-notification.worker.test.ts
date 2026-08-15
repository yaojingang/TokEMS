import { describe, expect, it, vi } from 'vitest';
import {
  consumeRegistrationReviewNotification,
  consumeRefundSucceededNotification,
  consumeTicketIssuedNotification,
  type LifecycleNotificationDependencies,
} from './registration-lifecycle-notification.worker.js';

function dependencies() {
  type Delivery = Parameters<LifecycleNotificationDependencies['ensureDelivery']>[0];
  type Delivered = Parameters<LifecycleNotificationDependencies['deliver']>[0];
  const deliveries = new Map<string, Delivery>();
  const delivered: Delivered[] = [];
  const deliver = vi.fn(async (input: Delivered) => {
    delivered.push(input);
  });
  const value: LifecycleNotificationDependencies = {
    publicSiteUrl: 'https://conference.example.com',
    findReviewScope: async () => ({
      organizationId: 'org-1',
      eventId: 101,
      eventName: 'GEO 大会',
      eventSlug: 'geo-2026',
      attendeeName: '参会人',
      attendeeRecipient: 'attendee@example.com',
    }),
    findTicketScope: async () => ({
      organizationId: 'org-1',
      eventId: 101,
      eventName: 'GEO 大会',
      eventSlug: 'geo-2026',
      registrationId: 'registration-1',
      ticketCode: 'TOK-TICKET-1',
      attendeeName: '参会人',
      attendeeRecipient: 'attendee@example.com',
    }),
    findRefundScope: async () => ({
      organizationId: 'org-1',
      eventId: 101,
      eventName: 'GEO 大会',
      registrationId: 'registration-1',
      orderNo: 'ORDER-1',
      amount: 10_000,
      currency: 'CNY',
      purchaserName: '购票人',
      purchaserRecipient: 'buyer@example.com',
    }),
    ensureDelivery: async (input) => {
      deliveries.set(input.id, input);
      return input.id;
    },
    deliver,
  };
  return { value, deliveries, delivered };
}

describe('registration lifecycle role notifications', () => {
  it('sends review results to the attendee without order access or financial content', async () => {
    const { value, deliveries, delivered } = dependencies();

    await consumeRegistrationReviewNotification(
      {
        eventType: 'RegistrationReviewApproved',
        correlationId: 'review-1',
        payload: {
          registrationId: 'registration-1',
          orderId: 'order-1',
          recipientRole: 'attendee',
          paymentRequired: true,
        },
      },
      value,
    );

    expect([...deliveries.values()][0]).toMatchObject({
      recipient: 'attendee@example.com',
      registrationId: 'registration-1',
    });
    const body = delivered[0]!.body;
    expect(body).toContain('购票人将收到支付通知');
    expect(body).not.toMatch(/order|access|金额|发票|¥|￥/iu);
  });

  it('delivers the ticket to the attendee and the refund to the purchaser', async () => {
    const { value, deliveries, delivered } = dependencies();

    await consumeTicketIssuedNotification(
      {
        correlationId: 'ticket-1',
        payload: {
          ticketId: 'ticket-1',
          registrationId: 'registration-1',
          recipientRole: 'attendee',
        },
      },
      value,
    );
    await consumeRefundSucceededNotification(
      {
        correlationId: 'refund-1',
        payload: { refundId: 'refund-1', orderId: 'order-1', recipientRole: 'purchaser' },
      },
      value,
    );

    expect([...deliveries.values()].map((item) => item.recipient)).toEqual([
      'attendee@example.com',
      'buyer@example.com',
    ]);
    expect(delivered[0]!.body).toContain(
      'https://conference.example.com/ticket/TOK-TICKET-1?event=geo-2026',
    );
    expect(delivered[0]!.body).not.toMatch(/金额|发票/iu);
    expect(delivered[1]!.body).toContain('购票人');
    expect(delivered[1]!.body).toContain('¥100.00');
  });

  it('uses deterministic delivery identities for repeated events', async () => {
    const { value, deliveries } = dependencies();
    const event = {
      correlationId: 'ticket-repeat',
      payload: {
        ticketId: 'ticket-1',
        registrationId: 'registration-1',
        recipientRole: 'attendee',
      },
    };

    await consumeTicketIssuedNotification(event, value);
    await consumeTicketIssuedNotification(event, value);

    expect(deliveries.size).toBe(1);
  });
});
