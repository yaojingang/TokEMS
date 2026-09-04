import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_EVENT, type Order, type PublicEvent, type Registration } from '@conference/contracts';
import { openSecret } from '@conference/security';
import {
  ConferenceRepository,
  deriveRegistrationBusinessStatus,
  effectiveReleasedCapacity,
  registrationHasOwnershipConflict,
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
    vi.useRealTimers();
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
      purchaseFor: 'self' as const,
      purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c034891791a7',
      proxyAuthorizationAccepted: false,
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

  it('round-trips multi-purchase settings through the admin and public event APIs', async () => {
    await repository.updateEvent(DEMO_EVENT.id, {
      settings: {
        registration: {
          additionalPurchaseEnabled: true,
          maxActiveSeatsPerPurchaser: 12,
        },
      },
    });

    await expect(
      repository.getAdminEvent(DEMO_EVENT.id, DEMO_EVENT.organizationId),
    ).resolves.toMatchObject({
      registration: {
        additionalPurchaseEnabled: true,
        maxActiveSeatsPerPurchaser: 12,
      },
    });
    await expect(repository.getPublicEvent()).resolves.toMatchObject({
      registration: {
        additionalPurchaseEnabled: true,
        maxActiveSeatsPerPurchaser: 12,
      },
    });
  });

  it('returns live public aggregates and increments page views from the first load', async () => {
    const before = await repository.getPublicEvent();
    const first = await repository.recordPublicEventView(DEMO_EVENT.id, DEMO_EVENT.organizationId);
    const second = await repository.recordPublicEventView(DEMO_EVENT.id, DEMO_EVENT.organizationId);
    const after = await repository.getPublicEvent();

    expect(before.publicMetrics).toMatchObject({
      pageViews: 0,
      trackingStartedAt: null,
      confirmedAttendees: 6,
      organizationCount: 6,
      cityCount: 2,
    });
    expect(first.pageViews).toBe(1);
    expect(second.pageViews).toBe(2);
    expect(second.trackingStartedAt).toBe(first.trackingStartedAt);
    expect(after.publicMetrics.pageViews).toBe(2);
  });

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
    expect(second.orderAccessToken).not.toBe(first.orderAccessToken);
    await expect(
      repository.getOrder(second.order.id, second.orderAccessToken!),
    ).resolves.toMatchObject({ id: second.order.id, status: 'pending_payment' });
    expect(after.tickets[0]!.remaining).toBe(before.tickets[0]!.remaining - 1);
  });

  it('creates a checkout when profile fields are optional or removed', async () => {
    const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
    demoEvent.registrationForm = {
      id: 'optional-profile-form',
      eventId: demoEvent.id,
      name: '精简报名表',
      version: 1,
      status: 'published',
      fields: [
        { key: 'name', label: '姓名', type: 'text', required: true },
        { key: 'mobile', label: '手机号码', type: 'tel', required: true },
        { key: 'email', label: '电子邮箱', type: 'email', required: true },
        { key: 'company', label: '公司/机构', type: 'text', required: false },
      ],
      termsVersion: '2026-07-16',
      termsContent: '提交报名即表示同意大会报名条款与个人信息处理说明。',
      publishedAt: new Date().toISOString(),
    };
    const input = registrationInput();
    input.attendee.company = '';
    input.attendee.title = '';
    input.attendee.city = '';
    const actor = customerActor();
    actor.profile.company = '';
    actor.profile.title = '';
    actor.profile.city = '';

    const checkout = await repository.createCheckout(
      input,
      'registration-optional-profile-fields-key',
      actor,
    );

    expect(checkout.registration.formAnswers).toMatchObject({ company: '' });
    expect(checkout.registration.formAnswers).not.toHaveProperty('title');
    expect(checkout.registration.formAnswers).not.toHaveProperty('city');
  });

  it('never restores a disabled email from the customer profile or submitted answers', async () => {
    const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
    demoEvent.registrationForm!.fields = [
      { key: 'mobile', label: '手机号', type: 'tel', required: true },
      { key: 'email', label: '邮箱', type: 'email', required: true, enabled: false },
    ];
    const input = { ...registrationInput(), formAnswers: { email: 'hidden@example.com' } };
    input.attendee.email = '';
    const actor = customerActor();
    actor.profile.email = 'profile@example.com';
    const checkout = await repository.createCheckout(input, 'disabled-email-checkout', actor);
    expect(checkout.registration.attendee.email).toBe('');
    expect(checkout.registration.formAnswers).toEqual({ mobile: actor.mobile });
  });

  it('preserves blank optional fields after the attendee clears prefilled profile values', async () => {
    const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
    demoEvent.registrationForm!.fields = demoEvent.registrationForm!.fields.map((field) => ({
      ...field,
      enabled: true,
      required: field.key === 'mobile',
    }));
    const input = registrationInput();
    input.attendee = {
      name: '',
      email: '',
      company: '',
      title: '',
      city: '',
      mobile: input.attendee.mobile,
    };
    const checkout = await repository.createCheckout(
      input,
      'blank-optional-fields',
      customerActor(),
    );
    expect(checkout.registration.attendee).toEqual({
      ...input.attendee,
      mobile: customerActor().mobile,
    });
    expect(checkout.registration.formAnswers).toMatchObject({ email: '', name: '', company: '' });
  });

  it.each([false, true])(
    'uses the phone for waitlist contact with email enabled=%s and submitted blank',
    async (enabled) => {
      const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
      demoEvent.tickets[0]!.remaining = 0;
      demoEvent.registrationForm!.fields = [
        { key: 'mobile', label: '手机号', type: 'tel', required: true },
        { key: 'email', label: '邮箱', type: 'email', required: false, enabled },
      ];
      const actor = customerActor();
      const entry = await repository.joinWaitlist(
        {
          eventId: demoEvent.id,
          ticketTypeId: demoEvent.tickets[0]!.id,
          name: '隐藏姓名',
          email: enabled ? '' : 'hidden@example.com',
          mobile: actor.mobile,
        },
        'waitlist-hidden-email',
        actor,
      );
      expect(entry).toMatchObject({ name: '', email: '', mobile: actor.mobile });
    },
  );

  it('keeps one registration per logged-in customer and event across idempotency keys', async () => {
    const before = await repository.getPublicEvent();
    const firstInput = registrationInput();
    firstInput.attendee.mobile = '13900139000';
    const first = await repository.createCheckout(
      firstInput,
      'registration-contact-first-key',
      customerActor(),
    );

    const second = await repository.createCheckout(
      {
        ...registrationInput(),
        purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c0348917940',
      },
      'registration-contact-second-key',
      customerActor(),
    );

    const after = await repository.getPublicEvent();
    expect(first.registration.attendee.mobile).toBe(customerActor().mobile);
    expect(second.registration.id).toBe(first.registration.id);
    expect(second.order.id).toBe(first.order.id);
    expect(after.tickets[0]!.remaining).toBe(before.tickets[0]!.remaining - 1);
  });

  it('creates a separate unclaimed registration when a purchaser buys for another attendee', async () => {
    const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
    demoEvent.registration.additionalPurchaseEnabled = true;

    const selfCheckout = await repository.createCheckout(
      registrationInput(),
      'registration-self-before-other-key',
      customerActor(),
    );
    await repository.confirmMockPayment(selfCheckout.order.id, 'registration-self-paid-key');

    const otherInput = {
      ...registrationInput(),
      purchaseFor: 'other' as const,
      purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c034891791a8',
      proxyAuthorizationAccepted: true,
      attendee: {
        ...registrationInput().attendee,
        name: '陈星河',
        mobile: '13900139000',
        email: 'chen@example.com',
      },
    };
    const otherCheckout = await repository.createCheckout(
      otherInput,
      'registration-other-key',
      customerActor(),
    );

    expect(selfCheckout.isProxyPurchase).toBe(false);
    expect(otherCheckout.isProxyPurchase).toBe(true);
    expect(otherCheckout.registration.id).not.toBe(selfCheckout.registration.id);
    expect(otherCheckout.registration.attendee.mobile).toBe('+8613900139000');
    await expect(
      repository.getOrder(selfCheckout.order.id, selfCheckout.orderAccessToken!),
    ).resolves.toMatchObject({ isProxyPurchase: false });
    await expect(
      repository.getOrder(otherCheckout.order.id, otherCheckout.orderAccessToken!),
    ).resolves.toMatchObject({ isProxyPurchase: true });
    const proxyPayment = await repository.confirmMockPayment(
      otherCheckout.order.id,
      'registration-other-paid-key',
    );
    expect(proxyPayment).not.toHaveProperty('ticket');
    await expect(
      repository.getOrderTicket(otherCheckout.order.id, otherCheckout.orderAccessToken!),
    ).rejects.toMatchObject({ status: 403 });
    const replayedOtherCheckout = await repository.createCheckout(
      otherInput,
      'registration-other-replay-key',
      customerActor(),
    );
    expect(replayedOtherCheckout.ticket).toBeUndefined();
    expect(
      (Reflect.get(repository, 'memoryRegistrationCustomers') as Map<string, string>).has(
        otherCheckout.registration.id,
      ),
    ).toBe(false);
    const claims = Reflect.get(repository, 'memoryAttendeeClaims') as Map<
      string,
      { tokenHash: string; mobileDigest: string }
    >;
    const invitations = Reflect.get(repository, 'memoryOutboxEvents') as Array<{
      eventType: string;
      payload: Record<string, unknown>;
    }>;
    expect(claims.get(otherCheckout.registration.id)).toMatchObject({
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      mobileDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(claims.get(otherCheckout.registration.id)?.mobileDigest).not.toContain('13900139000');
    expect(invitations).toContainEqual({
      eventType: 'AttendeeClaimInvitationRequested',
      payload: expect.objectContaining({
        registrationId: otherCheckout.registration.id,
        recipientRole: 'attendee',
        recipient: '+8613900139000',
        sealedAttendeeClaimToken: expect.any(String),
      }),
    });
    const submitted = invitations.find(
      (event) =>
        event.eventType === 'RegistrationSubmitted' &&
        event.payload.registrationId === otherCheckout.registration.id,
    );
    const attendeeInvitation = invitations.find(
      (event) => event.eventType === 'AttendeeClaimInvitationRequested',
    );
    expect(submitted?.payload).toMatchObject({
      registrationId: otherCheckout.registration.id,
      recipientRole: 'purchaser',
      recipient: 'jiang@example.com',
    });
    expect(submitted?.payload).not.toHaveProperty('attendeeClaimToken');
    expect(submitted?.payload).not.toHaveProperty('sealedAttendeeClaimToken');
    expect(attendeeInvitation?.payload).not.toHaveProperty('attendeeClaimToken');
    expect(attendeeInvitation?.payload).not.toHaveProperty('orderAccessToken');
    const claimToken = openSecret(
      String(attendeeInvitation?.payload.sealedAttendeeClaimToken),
      process.env.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET ??
        process.env.JWT_SECRET ??
        'conference-notification-payload-development-secret',
    );
    expect(claims.get(otherCheckout.registration.id)?.tokenHash).toBe(
      createHash('sha256').update(claimToken).digest('hex'),
    );
  });

  it('replays the same purchase intent across transport retries and rejects changed payloads', async () => {
    const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
    demoEvent.registration.additionalPurchaseEnabled = true;
    const input = {
      ...registrationInput(),
      purchaseFor: 'other' as const,
      purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c034891791a9',
      proxyAuthorizationAccepted: true,
      attendee: { ...registrationInput().attendee, mobile: '13900139001' },
    };

    const first = await repository.createCheckout(
      input,
      'purchase-intent-first-key',
      customerActor(),
    );
    const replay = await repository.createCheckout(
      input,
      'purchase-intent-retry-key',
      customerActor(),
    );
    expect(replay.order.id).toBe(first.order.id);

    await expect(
      repository.createCheckout(
        { ...input, attendee: { ...input.attendee, name: '被篡改的姓名' } },
        'purchase-intent-conflict-key',
        customerActor(),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('enforces the additional-purchase flag, one pending order, waitlist scope, and seat cap', async () => {
    const otherInput = (mobile: string, intent: string) => ({
      ...registrationInput(),
      purchaseFor: 'other' as const,
      purchaseIntentId: intent,
      proxyAuthorizationAccepted: true,
      attendee: { ...registrationInput().attendee, mobile },
    });

    await expect(
      repository.createCheckout(
        otherInput('13900139010', '73e2ddc2-c755-4a5f-a61a-c0348917920'),
        'additional-disabled-key',
        customerActor(),
      ),
    ).rejects.toMatchObject({ status: 409 });

    const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
    demoEvent.registration.additionalPurchaseEnabled = true;
    const selfCheckout = await repository.createCheckout(
      registrationInput(),
      'pending-self-key',
      customerActor(),
    );
    await expect(
      repository.createCheckout(
        otherInput('13900139011', '73e2ddc2-c755-4a5f-a61a-c0348917921'),
        'second-pending-key',
        customerActor(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await repository.confirmMockPayment(selfCheckout.order.id, 'pending-self-paid-key');

    await expect(
      repository.createCheckout(
        {
          ...otherInput('13900139012', '73e2ddc2-c755-4a5f-a61a-c0348917922'),
          waitlistOfferToken: 'waitlist-token-cannot-be-transferred',
        },
        'other-waitlist-key',
        customerActor(),
      ),
    ).rejects.toMatchObject({ status: 409 });

    demoEvent.tickets[0]!.price = 0;
    demoEvent.registration.maxActiveSeatsPerPurchaser = 5;
    for (let index = 0; index < 4; index += 1) {
      await repository.createCheckout(
        otherInput(`1390013910${index}`, `73e2ddc2-c755-4a5f-a61a-c034891793${index}`),
        `seat-cap-${index}`,
        customerActor(),
      );
    }
    await expect(
      repository.createCheckout(
        otherInput('13900139109', '73e2ddc2-c755-4a5f-a61a-c0348917939'),
        'seat-cap-overflow',
        customerActor(),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('allows a fresh purchase after another pending-payment order expires', async () => {
    const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
    demoEvent.registration.additionalPurchaseEnabled = true;
    const expired = await repository.createCheckout(
      registrationInput(),
      'expired-purchaser-order-first',
      customerActor(),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(new Date(expired.order.expiresAt).getTime() + 1));

    await expect(
      repository.createCheckout(
        {
          ...registrationInput(),
          purchaseFor: 'other',
          purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c0348917949',
          proxyAuthorizationAccepted: true,
          attendee: { ...registrationInput().attendee, mobile: '13900139999' },
        },
        'expired-purchaser-order-second',
        customerActor(),
      ),
    ).resolves.toMatchObject({ isProxyPurchase: true });
  });

  it('rejects restoring one closed order while another purchaser order is pending', async () => {
    const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
    demoEvent.registration.additionalPurchaseEnabled = true;
    const makeOther = (mobile: string, intent: string) => ({
      ...registrationInput(),
      purchaseFor: 'other' as const,
      purchaseIntentId: intent,
      proxyAuthorizationAccepted: true,
      attendee: { ...registrationInput().attendee, mobile },
    });
    const closed = await repository.createCheckout(
      makeOther('13900139201', '73e2ddc2-c755-4a5f-a61a-c0348917951'),
      'restore-pending-closed',
      customerActor(),
    );
    const orders = Reflect.get(repository, 'memory').orders as Map<string, Order>;
    orders.set(closed.order.id, { ...closed.order, status: 'closed' });
    await repository.createCheckout(
      makeOther('13900139202', '73e2ddc2-c755-4a5f-a61a-c0348917952'),
      'restore-pending-active',
      customerActor(),
    );

    await expect(
      repository.createCheckout(
        makeOther('13900139201', '73e2ddc2-c755-4a5f-a61a-c0348917953'),
        'restore-pending-attempt',
        customerActor(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(orders.get(closed.order.id)?.status).toBe('closed');
  });

  it('rejects restoring a closed order when the purchaser active-seat cap is full', async () => {
    const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
    demoEvent.registration.additionalPurchaseEnabled = true;
    demoEvent.registration.maxActiveSeatsPerPurchaser = 5;
    demoEvent.tickets[0]!.price = 0;
    const makeOther = (mobile: string, intent: string) => ({
      ...registrationInput(),
      purchaseFor: 'other' as const,
      purchaseIntentId: intent,
      proxyAuthorizationAccepted: true,
      attendee: { ...registrationInput().attendee, mobile },
    });
    const closed = await repository.createCheckout(
      makeOther('13900139211', '73e2ddc2-c755-4a5f-a61a-c0348917961'),
      'restore-cap-closed',
      customerActor(),
    );
    const orders = Reflect.get(repository, 'memory').orders as Map<string, Order>;
    orders.set(closed.order.id, { ...closed.order, status: 'closed' });
    await repository.createCheckout(
      makeOther('13900139212', '73e2ddc2-c755-4a5f-a61a-c0348917962'),
      'restore-cap-active',
      customerActor(),
    );
    demoEvent.registration.maxActiveSeatsPerPurchaser = 1;

    await expect(
      repository.createCheckout(
        makeOther('13900139211', '73e2ddc2-c755-4a5f-a61a-c0348917963'),
        'restore-cap-attempt',
        customerActor(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(orders.get(closed.order.id)?.status).toBe('closed');
  });

  it('rejects restoring an expired other-attendee order after additional purchases are disabled', async () => {
    const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
    demoEvent.registration.additionalPurchaseEnabled = true;
    const input = {
      ...registrationInput(),
      purchaseFor: 'other' as const,
      purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c0348917971',
      proxyAuthorizationAccepted: true,
      attendee: { ...registrationInput().attendee, mobile: '13900139221' },
    };
    const expired = await repository.createCheckout(input, 'restore-flag-first', customerActor());
    const orders = Reflect.get(repository, 'memory').orders as Map<string, Order>;
    orders.set(expired.order.id, {
      ...expired.order,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    demoEvent.registration.additionalPurchaseEnabled = false;

    await expect(
      repository.createCheckout(
        {
          ...input,
          purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c0348917972',
        },
        'restore-flag-second',
        customerActor(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(orders.get(expired.order.id)?.status).toBe('pending_payment');
  });

  it('lets the original purchaser resume an expired proxy order after attendee claim', async () => {
    const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
    demoEvent.registration.additionalPurchaseEnabled = true;
    const input = {
      ...registrationInput(),
      purchaseFor: 'other' as const,
      purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c0348917975',
      proxyAuthorizationAccepted: true,
      attendee: { ...registrationInput().attendee, mobile: '13900139225' },
    };
    const expired = await repository.createCheckout(input, 'claimed-proxy-first', customerActor());
    const claimedBy = '44444444-4444-4444-8444-444444444444';
    const registrations = Reflect.get(repository, 'memoryRegistrationCustomers') as Map<
      string,
      string
    >;
    registrations.set(expired.registration.id, claimedBy);
    const orders = Reflect.get(repository, 'memory').orders as Map<string, Order>;
    orders.set(expired.order.id, {
      ...expired.order,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const resumed = await repository.createCheckout(
      {
        ...input,
        purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c0348917976',
      },
      'claimed-proxy-second',
      customerActor(),
    );

    expect(resumed.order.id).toBe(expired.order.id);
    expect(registrations.get(expired.registration.id)).toBe(claimedBy);
  });

  it('counts a failed purchase intent once while throttling the eleventh distinct attempt', async () => {
    const failedInput = (intent: string) => ({
      ...registrationInput(),
      purchaseFor: 'other' as const,
      purchaseIntentId: intent,
      proxyAuthorizationAccepted: true,
      attendee: { ...registrationInput().attendee, mobile: '13900139231' },
    });
    const repeatedIntent = '73e2ddc2-c755-4a5f-a61a-c0348917980';
    for (let index = 0; index < 12; index += 1) {
      await expect(
        repository.createCheckout(
          failedInput(repeatedIntent),
          `failed-intent-repeat-${index}`,
          customerActor(),
        ),
      ).rejects.toMatchObject({ status: 409 });
    }
    for (let index = 1; index < 10; index += 1) {
      await expect(
        repository.createCheckout(
          failedInput(`73e2ddc2-c755-4a5f-a61a-c034891798${index}`),
          `failed-intent-distinct-${index}`,
          customerActor(),
        ),
      ).rejects.toMatchObject({ status: 409 });
    }
    await expect(
      repository.createCheckout(
        failedInput('73e2ddc2-c755-4a5f-a61a-c0348917999'),
        'failed-intent-rate-limited',
        customerActor(),
      ),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('rotates the attendee claim invitation once when an other-attendee order is restored', async () => {
    const demoEvent = Reflect.get(repository, 'demoEvent') as PublicEvent;
    demoEvent.registration.additionalPurchaseEnabled = true;
    const firstInput = {
      ...registrationInput(),
      purchaseFor: 'other' as const,
      purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c0348917991',
      proxyAuthorizationAccepted: true,
      attendee: {
        ...registrationInput().attendee,
        mobile: '13900139241',
        email: 'restore-claim@example.com',
      },
    };
    const first = await repository.createCheckout(
      firstInput,
      'restore-claim-first',
      customerActor(),
    );
    const orders = Reflect.get(repository, 'memory').orders as Map<string, Order>;
    orders.set(first.order.id, {
      ...first.order,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const claims = Reflect.get(repository, 'memoryAttendeeClaims') as Map<
      string,
      { tokenHash: string }
    >;
    const firstHash = claims.get(first.registration.id)?.tokenHash;
    const restoredInput = {
      ...firstInput,
      purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c0348917992',
    };
    const restored = await repository.createCheckout(
      restoredInput,
      'restore-claim-second',
      customerActor(),
    );
    const invitations = Reflect.get(repository, 'memoryOutboxEvents') as Array<{
      eventType: string;
      payload: Record<string, unknown>;
    }>;
    const claimEventsAfterRestore = invitations.filter(
      (event) =>
        event.eventType === 'AttendeeClaimInvitationRequested' &&
        event.payload.registrationId === first.registration.id,
    );
    expect(restored.order.id).toBe(first.order.id);
    expect(claims.get(first.registration.id)?.tokenHash).not.toBe(firstHash);
    expect(claimEventsAfterRestore).toHaveLength(2);
    expect(claimEventsAfterRestore[0]?.payload.sealedAttendeeClaimToken).not.toBe(
      claimEventsAfterRestore[1]?.payload.sealedAttendeeClaimToken,
    );
    expect(
      claimEventsAfterRestore.every((event) => !Object.hasOwn(event.payload, 'attendeeClaimToken')),
    ).toBe(true);

    await repository.createCheckout(
      restoredInput,
      'restore-claim-same-intent-replay',
      customerActor(),
    );
    expect(
      invitations.filter(
        (event) =>
          event.eventType === 'AttendeeClaimInvitationRequested' &&
          event.payload.registrationId === first.registration.id,
      ),
    ).toHaveLength(2);
  });

  it('returns a stable identity conflict when legacy duplicates both match', async () => {
    const first = await repository.createCheckout(
      registrationInput(),
      'registration-legacy-conflict-first-key',
      customerActor(),
    );
    const registrations = Reflect.get(repository, 'memory').registrations as Map<
      string,
      typeof first.registration
    >;
    const orders = Reflect.get(repository, 'memory').orders as Map<string, typeof first.order>;
    const customers = Reflect.get(repository, 'memoryRegistrationCustomers') as Map<string, string>;
    const duplicateRegistrationId = crypto.randomUUID();
    registrations.set(duplicateRegistrationId, {
      ...first.registration,
      id: duplicateRegistrationId,
      registrationCode: 'TOK-R-LEGACY-DUPLICATE',
      status: 'cancelled',
    });
    orders.set(crypto.randomUUID(), {
      ...first.order,
      id: crypto.randomUUID(),
      registrationId: duplicateRegistrationId,
      status: 'closed',
    });
    customers.set(duplicateRegistrationId, customerActor().customerUserId);

    await expect(
      repository.createCheckout(
        {
          ...registrationInput(),
          purchaseIntentId: '73e2ddc2-c755-4a5f-a61a-c0348917941',
        },
        'registration-legacy-conflict-second-key',
        customerActor(),
      ),
    ).rejects.toMatchObject({
      response: { code: 'REGISTRATION_IDENTITY_CONFLICT' },
      status: 409,
    });
  });

  it('blocks a mobile identity that belongs to another customer', async () => {
    await repository.createCheckout(
      registrationInput(),
      'registration-owner-first-key',
      customerActor(),
    );
    const otherCustomer = {
      ...customerActor(),
      customerUserId: '11111111-1111-4111-8111-111111111102',
    };

    await expect(
      repository.createCheckout(
        registrationInput(),
        'registration-owner-second-key',
        otherCustomer,
      ),
    ).rejects.toMatchObject({
      response: { code: 'REGISTRATION_IDENTITY_CONFLICT' },
      status: 409,
    });
  });

  it('reopens an expired order while keeping one registration and one order', async () => {
    const first = await repository.createCheckout(
      registrationInput(),
      'registration-resume-first-key',
      customerActor(),
    );
    const orders = Reflect.get(repository, 'memory').orders as Map<string, typeof first.order>;
    const registrations = Reflect.get(repository, 'memory').registrations as Map<
      string,
      typeof first.registration
    >;
    orders.set(first.order.id, {
      ...first.order,
      status: 'closed',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    registrations.set(first.registration.id, {
      ...first.registration,
      status: 'cancelled',
    });

    const resumed = await repository.createCheckout(
      registrationInput(),
      'registration-resume-first-key',
      customerActor(),
    );

    expect(resumed.registration.id).toBe(first.registration.id);
    expect(resumed.order.id).toBe(first.order.id);
    expect(resumed.registration.status).toBe('pending_payment');
    expect(resumed.order.status).toBe('pending_payment');
    expect(new Date(resumed.order.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(orders.get(first.order.id)?.status).toBe('pending_payment');
    expect(registrations.get(first.registration.id)?.status).toBe('pending_payment');
    expect(orders).toHaveLength(11);
    expect(registrations).toHaveLength(11);
  });

  it('does not consume in-memory inventory when the authenticated mobile is invalid', async () => {
    const before = await repository.getPublicEvent();
    const invalidActor = customerActor();
    invalidActor.mobile = 'not-a-mobile';

    await expect(
      repository.createCheckout(
        registrationInput(),
        'registration-invalid-mobile-key',
        invalidActor,
      ),
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
    expect(second.ticket!.code).toBe(first.ticket!.code);
    await expect(repository.getTicket(first.ticket!.code)).resolves.toMatchObject({
      attendeeName: '江云舟',
      status: 'valid',
    });
  });

  it('allows local payment simulation only for the linked allowlisted order owner', async () => {
    const checkout = await repository.createCheckout(
      registrationInput(),
      'local-payment-registration-key',
      customerActor(),
    );
    const accessToken = checkout.orderAccessToken!;

    await expect(
      repository.canUseLocalPaymentSimulation(checkout.order.id, accessToken, [
        customerActor().mobile,
      ]),
    ).resolves.toBe(true);
    await expect(
      repository.canUseLocalPaymentSimulation(checkout.order.id, accessToken, ['+8618600184180']),
    ).resolves.toBe(false);
    await expect(
      repository.canUseLocalPaymentSimulation(checkout.order.id, 'x'.repeat(43), [
        customerActor().mobile,
      ]),
    ).rejects.toMatchObject({ status: 401 });

    const paid = await repository.confirmLocalPaymentSimulation(
      checkout.order.id,
      accessToken,
      'local-payment-confirm-key',
      [customerActor().mobile],
    );
    expect(paid.order.status).toBe('paid');
    expect(paid.ticket!.registrationId).toBe(checkout.registration.id);
  });

  it('returns the original business IDs after payment and after a full refund', async () => {
    const checkout = await repository.createCheckout(
      registrationInput(),
      'registration-paid-original-key',
      customerActor(),
    );
    const paid = await repository.confirmMockPayment(
      checkout.order.id,
      'registration-paid-confirm-key',
    );
    const repeatedPaid = await repository.createCheckout(
      registrationInput(),
      'registration-paid-repeat-key',
      customerActor(),
    );
    expect(repeatedPaid.registration.id).toBe(checkout.registration.id);
    expect(repeatedPaid.order.id).toBe(checkout.order.id);
    expect(repeatedPaid.order.status).toBe('paid');
    expect(repeatedPaid.ticket?.id).toBe(paid.ticket!.id);

    const orders = Reflect.get(repository, 'memory').orders as Map<string, typeof checkout.order>;
    orders.set(checkout.order.id, { ...repeatedPaid.order, status: 'refunded' });
    const repeatedRefunded = await repository.createCheckout(
      registrationInput(),
      'registration-refunded-repeat-key',
      customerActor(),
    );
    expect(repeatedRefunded.registration.id).toBe(checkout.registration.id);
    expect(repeatedRefunded.order.id).toBe(checkout.order.id);
    expect(repeatedRefunded.order.status).toBe('refunded');
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
    expect(payment.ticket!.registrationId).toBe(approved.registration.id);
  });

  it.each([0, 39900])(
    'keeps a %i-amount review pending when inventory disappeared before approval',
    async (amount) => {
      const registrations = Reflect.get(repository, 'memory').registrations as Map<
        string,
        Registration
      >;
      const orders = Reflect.get(repository, 'memory').orders as Map<string, Order>;
      const registration = registrations.get('demo-registration-3')!;
      const order = orders.get('demo-order-3')!;
      orders.set(order.id, { ...order, amount });
      (Reflect.get(repository, 'memory').ticketRemaining as Map<string, number>).set(
        registration.ticketType.id,
        0,
      );

      await expect(
        repository.reviewRegistration(
          DEMO_EVENT.id,
          registration.id,
          DEMO_EVENT.organizationId,
          'reviewer-test',
          { decision: 'approve', reason: '库存不足时不得通过' },
          `review-inventory-${amount}`,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(registrations.get(registration.id)?.status).toBe('pending_review');
      expect(orders.get(order.id)?.status).toBe('pending_review');
    },
  );

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

  it('reports paid orders, active paid seats, confirmed attendees, and purchasers separately', async () => {
    const dashboard = await repository.getDashboard();

    expect(dashboard.metrics).toMatchObject({
      registrations: 10,
      paidOrders: 6,
      paidSeats: 6,
      confirmedAttendees: 6,
      purchasers: 6,
      conversionRate: 60,
    });
    expect(dashboard.metrics.revenue).toBeGreaterThan(0);
  });

  it('returns every day in a custom dashboard trend range', async () => {
    const dashboard = await repository.getDashboard(DEMO_EVENT.id, DEMO_EVENT.organizationId, {
      from: '2026-07-06',
      to: '2026-08-04',
    });

    expect(dashboard.registrationTrend).toHaveLength(30);
    expect(dashboard.registrationTrend[0]?.date).toBe('2026-07-06');
    expect(dashboard.registrationTrend.at(-1)?.date).toBe('2026-08-04');
  });

  it('returns the requested number of preset trend days', async () => {
    const dashboard = await repository.getDashboard(DEMO_EVENT.id, DEMO_EVENT.organizationId, {
      days: 30,
    });

    expect(dashboard.registrationTrend).toHaveLength(30);
  });

  it('anchors preset trend days to the event timezone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T16:30:00.000Z'));

    const dashboard = await repository.getDashboard(DEMO_EVENT.id, DEMO_EVENT.organizationId, {
      days: 1,
    });

    expect(dashboard.registrationTrend.map((item) => item.date)).toEqual(['2026-08-04']);
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
    expect(orders.items.every((order) => order.status === 'paid')).toBe(true);
    expect(orders.pageSize).toBe(20);
  });

  it('searches orders by attendee mobile', async () => {
    const result = await repository.listOrders(DEMO_EVENT.id, { q: '13800002101' });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      attendeeName: '王欣怡',
      attendeeMobile: '13800002101',
    });
  });

  it('searches registrations by their order number', async () => {
    const firstPage = await repository.listRegistrations(DEMO_EVENT.id, { pageSize: 1 });
    const orderNo = firstPage.items[0]?.order?.orderNo;
    expect(orderNo).toBeTruthy();

    const result = await repository.listRegistrations(DEMO_EVENT.id, { q: orderNo });

    expect(result.total).toBe(1);
    expect(result.items[0]?.order?.orderNo).toBe(orderNo);
  });

  it('returns exactly 20 orders per page', async () => {
    for (let index = 0; index < 11; index += 1) {
      const suffix = String(3000 + index);
      const input = registrationInput();
      const actor = customerActor();
      input.attendee.mobile = `1390000${suffix}`;
      input.attendee.email = `pagination-${index}@example.com`;
      actor.customerUserId = `11111111-1111-4111-8111-${String(200 + index).padStart(12, '0')}`;
      actor.mobile = `+861390000${suffix}`;
      actor.profile.email = input.attendee.email;
      await repository.createCheckout(input, `order-pagination-${index}-key`, actor);
    }

    const firstPage = await repository.listOrders(DEMO_EVENT.id, { page: 1 });
    const secondPage = await repository.listOrders(DEMO_EVENT.id, { page: 2 });

    expect(firstPage).toMatchObject({ total: 21, page: 1, pageSize: 20 });
    expect(firstPage.items).toHaveLength(20);
    expect(secondPage).toMatchObject({ total: 21, page: 2, pageSize: 20 });
    expect(secondPage.items).toHaveLength(1);
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

describe('registration business status derivation', () => {
  it('prioritizes refunds and payment attempts over the registration status', () => {
    expect(
      deriveRegistrationBusinessStatus({
        registrationStatus: 'cancelled',
        orderStatus: 'refunded',
        orderAmount: 39900,
        latestPaymentStatus: 'refunded',
        paidAmount: 39900,
        refundedAmount: 39900,
      }),
    ).toBe('refunded');
    expect(
      deriveRegistrationBusinessStatus({
        registrationStatus: 'pending_payment',
        orderStatus: 'pending_payment',
        orderAmount: 39900,
        latestPaymentStatus: 'failed',
        paidAmount: 0,
        refundedAmount: 0,
      }),
    ).toBe('payment_failed');
  });
});

describe('registration ownership validation', () => {
  it('blocks a mobile-matched registration that belongs to another customer', () => {
    expect(
      registrationHasOwnershipConflict(
        '11111111-1111-4111-8111-111111111101',
        '11111111-1111-4111-8111-111111111102',
      ),
    ).toBe(true);
    expect(
      registrationHasOwnershipConflict(
        '11111111-1111-4111-8111-111111111101',
        '11111111-1111-4111-8111-111111111101',
      ),
    ).toBe(false);
    expect(registrationHasOwnershipConflict(null, '11111111-1111-4111-8111-111111111101')).toBe(
      false,
    );
  });
});

describe('migration-aware health', () => {
  it('reports degraded when PostgreSQL is reachable with a different migration hash', async () => {
    const database = {
      ping: vi.fn().mockResolvedValue({
        mode: 'postgresql',
        ok: true,
        migration: { ok: false, expected: 'a'.repeat(64), applied: 'b'.repeat(64) },
      }),
    } as unknown as DatabaseService;
    const repository = new ConferenceRepository(database);

    await expect(repository.health()).resolves.toMatchObject({
      status: 'degraded',
      database: { migration: { ok: false, expected: 'a'.repeat(64), applied: 'b'.repeat(64) } },
    });
  });

  it('reports healthy when PostgreSQL and the migration hash are current', async () => {
    const database = {
      ping: vi.fn().mockResolvedValue({
        mode: 'postgresql',
        ok: true,
        migration: { ok: true, expected: 'a'.repeat(64), applied: 'a'.repeat(64) },
      }),
    } as unknown as DatabaseService;
    const repository = new ConferenceRepository(database);

    await expect(repository.health()).resolves.toMatchObject({
      status: 'ok',
      database: { migration: { ok: true } },
    });
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

describe('registration review transaction retry', () => {
  it('retries a PostgreSQL deadlock before returning the review failure', async () => {
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const transaction = vi.fn<() => Promise<never>>().mockRejectedValue(deadlock);
    const repository = new ConferenceRepository({
      db: { transaction },
    } as unknown as DatabaseService);

    await expect(
      repository.reviewRegistration(
        DEMO_EVENT.id,
        '11111111-1111-4111-8111-111111111111',
        DEMO_EVENT.organizationId,
        '22222222-2222-4222-8222-222222222222',
        { decision: 'approve', reason: '验证死锁重试行为' },
        'review-deadlock-retry',
      ),
    ).rejects.toBe(deadlock);
    expect(transaction).toHaveBeenCalledTimes(3);
  });
});
