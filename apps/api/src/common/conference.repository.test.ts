import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_EVENT, type PublicEvent } from '@conference/contracts';
import {
  ConferenceRepository,
  effectiveReleasedCapacity,
  releaseFaqsFromSnapshot,
} from './conference.repository.js';
import { DatabaseService } from './database.service.js';

describe('ConferenceRepository in-memory operational loop', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let repository: ConferenceRepository;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    repository = new ConferenceRepository(new DatabaseService());
  });

  afterEach(() => {
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  function registrationInput() {
    return {
      eventId: DEMO_EVENT.id,
      ticketTypeId: DEMO_EVENT.tickets[0]!.id,
      attendee: {
        name: '江云舟',
        mobile: '13800138000',
        email: 'jiang@example.com',
        company: '湾区品牌实验室',
        title: '增长负责人',
        city: '深圳',
      },
      invoiceRequired: false,
      marketingConsent: true,
      termsAccepted: true as const,
      formVersion: 1,
      termsVersion: '2026-07-16',
    };
  }

  function customerActor() {
    return {
      customerUserId: '11111111-1111-4111-8111-111111111101',
      organizationId: DEMO_EVENT.organizationId,
      mobile: '+8613800138000',
      profile: {
        nickname: '江云舟',
        realName: '江云舟',
        email: 'jiang@example.com',
        company: '湾区品牌实验室',
        title: '增长负责人',
        city: '深圳',
      },
    };
  }

  it('returns one checkout for repeated registration idempotency keys', async () => {
    const before = await repository.getPublicEvent();
    const first = await repository.createCheckout(
      registrationInput(),
      'registration-test-key',
      customerActor(),
    );
    const second = await repository.createCheckout(
      registrationInput(),
      'registration-test-key',
      customerActor(),
    );
    const after = await repository.getPublicEvent();

    expect(second.order.id).toBe(first.order.id);
    expect(second.registration.id).toBe(first.registration.id);
    expect(after.tickets[0]!.remaining).toBe(before.tickets[0]!.remaining - 1);
  });

  it('rejects duplicate active registration contacts across idempotency keys', async () => {
    const before = await repository.getPublicEvent();
    await repository.createCheckout(
      registrationInput(),
      'registration-contact-first-key',
      customerActor(),
    );

    await expect(
      repository.createCheckout(
        registrationInput(),
        'registration-contact-second-key',
        customerActor(),
      ),
    ).rejects.toMatchObject({ status: 409 });

    const after = await repository.getPublicEvent();
    expect(after.tickets[0]!.remaining).toBe(before.tickets[0]!.remaining - 1);
  });

  it('does not consume in-memory inventory when attendee mobile validation fails', async () => {
    const before = await repository.getPublicEvent();
    const invalid = registrationInput();
    invalid.attendee.mobile = 'not-a-mobile';

    await expect(
      repository.createCheckout(invalid, 'registration-invalid-mobile-key', customerActor()),
    ).rejects.toMatchObject({ status: 400 });

    const after = await repository.getPublicEvent();
    expect(after.tickets[0]!.remaining).toBe(before.tickets[0]!.remaining);
  });

  it('issues one ticket when payment confirmation is retried', async () => {
    const checkout = await repository.createCheckout(
      registrationInput(),
      'payment-registration-key',
      customerActor(),
    );
    const first = await repository.confirmMockPayment(checkout.order.id, 'payment-confirm-key');
    const second = await repository.confirmMockPayment(checkout.order.id, 'payment-confirm-key');

    expect(first.order.status).toBe('paid');
    expect(second.ticket.code).toBe(first.ticket.code);
    await expect(repository.getTicket(first.ticket.code)).resolves.toMatchObject({
      attendeeName: '江云舟',
      status: 'valid',
    });
  });

  it('atomically completes a zero-amount checkout and returns its ticket', async () => {
    const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
    demoEvent.tickets[0]!.price = 0;

    const checkout = await repository.createCheckout(
      registrationInput(),
      'free-registration-key',
      customerActor(),
    );

    expect(checkout.registration.status).toBe('confirmed');
    expect(checkout.order).toMatchObject({
      status: 'paid',
      amount: 0,
      paymentMethod: 'free',
    });
    expect(checkout.order.paymentUrl).toBeUndefined();
    expect(checkout.ticket?.registrationId).toBe(checkout.registration.id);
    await expect(repository.getTicket(checkout.registration.id)).resolves.toMatchObject({
      code: checkout.ticket?.code,
      status: 'valid',
    });
  });

  it('opens payment only after a pending registration is approved', async () => {
    const approved = await repository.reviewRegistration(
      DEMO_EVENT.id,
      'demo-registration-3',
      DEMO_EVENT.organizationId,
      'reviewer-test',
      { decision: 'approve', reason: '资料符合参会要求' },
      'review-approve-key',
    );

    expect(approved.registration.status).toBe('pending_payment');
    expect(approved.order.status).toBe('pending_payment');
    expect(approved.order.paymentUrl).toBe(`/order/${approved.order.id}`);

    const payment = await repository.confirmMockPayment(
      approved.order.id,
      'review-payment-confirm-key',
    );
    expect(payment.order.status).toBe('paid');
    expect(payment.ticket.registrationId).toBe(approved.registration.id);
  });

  it('closes a rejected registration and keeps the review idempotent', async () => {
    const first = await repository.reviewRegistration(
      DEMO_EVENT.id,
      'demo-registration-3',
      DEMO_EVENT.organizationId,
      'reviewer-test',
      { decision: 'reject', reason: '报名资料暂不完整' },
      'review-reject-key',
    );
    const second = await repository.reviewRegistration(
      DEMO_EVENT.id,
      'demo-registration-3',
      DEMO_EVENT.organizationId,
      'reviewer-test',
      { decision: 'reject', reason: '报名资料暂不完整' },
      'review-reject-key',
    );

    expect(first.registration.status).toBe('cancelled');
    expect(first.order.status).toBe('closed');
    expect(second).toEqual(first);
  });

  it('reports duplicate check-in without creating another accepted record', async () => {
    const payload = {
      eventId: DEMO_EVENT.id,
      ticketCode: 'TOK-T-0000000001',
      checkInListId: 'main-entrance',
      deviceId: 'test-device',
    };
    const first = await repository.checkIn(payload);
    const second = await repository.checkIn(payload);
    const dashboard = await repository.getDashboard();

    expect(first.result).toBe('accepted');
    expect(second.result).toBe('duplicate');
    expect(dashboard.metrics.checkedIn).toBe(1);
  });

  it('keeps in-memory demo tickets readable through the strict new-ticket contract', async () => {
    const ticket = await repository.getTicket('TOK-T-0000000001');

    expect(ticket.code).toMatch(/^TOK-T-[A-Z0-9]{10}$/u);
  });

  it('rejects check-in outside the authenticated organization scope', async () => {
    await expect(
      repository.checkIn(
        {
          eventId: DEMO_EVENT.id,
          ticketCode: 'TOK-T-0000000001',
          checkInListId: 'main-entrance',
          deviceId: 'foreign-device',
        },
        '00000000-0000-4000-8000-000000000099',
      ),
    ).rejects.toMatchObject({ status: 404 });

    const dashboard = await repository.getDashboard();
    expect(dashboard.metrics.checkedIn).toBe(0);
  });

  it('updates event content and exposes admin filters', async () => {
    const updated = await repository.updateEvent(DEMO_EVENT.id, { tagline: '测试后的大会主张' });
    const registrations = await repository.listRegistrations(DEMO_EVENT.id, { q: '广州远望' });
    const orders = await repository.listOrders(DEMO_EVENT.id, { status: 'paid' });

    expect(updated.tagline).toBe('测试后的大会主张');
    expect(registrations.items).toHaveLength(1);
    expect(registrations.total).toBe(1);
    expect(orders.every((order) => order.status === 'paid')).toBe(true);
  });

  it('keeps an offline demo event readable to administrators', async () => {
    const updated = await repository.updateEvent(DEMO_EVENT.id, { status: 'configuring' });

    expect(updated.status).toBe('configuring');
    await expect(repository.getAdminEvent(DEMO_EVENT.id)).resolves.toMatchObject({
      status: 'configuring',
    });
    await expect(repository.getPublicEvent()).rejects.toMatchObject({ status: 404 });
  });

  it('paginates admin registrations with an accurate total', async () => {
    const result = await repository.listRegistrations(DEMO_EVENT.id, {
      page: 2,
      pageSize: 3,
    });

    expect(result.total).toBe(10);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(3);
    expect(result.items).toHaveLength(3);
  });
});

describe('releaseFaqsFromSnapshot', () => {
  it('prefers the resolved experience FAQ over a legacy top-level snapshot', () => {
    expect(
      releaseFaqsFromSnapshot({
        faqs: [{ question: '旧问题', answer: '旧答案' }],
        experience: {
          faq: {
            items: [
              { question: '新问题', answer: '新答案', enabled: true },
              { question: '隐藏问题', answer: '隐藏答案', enabled: false },
            ],
          },
        },
      }),
    ).toEqual([{ question: '新问题', answer: '新答案' }]);
  });
});

describe('effectiveReleasedCapacity', () => {
  it('keeps the capacity recorded by a rolled-back release', () => {
    expect(effectiveReleasedCapacity({ capacity: 1 }, 2)).toBe(1);
    expect(effectiveReleasedCapacity(undefined, 2)).toBe(2);
  });
});
