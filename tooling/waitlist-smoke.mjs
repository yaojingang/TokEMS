import { createHmac, randomUUID } from 'node:crypto';
import { hash } from '../apps/api/node_modules/bcryptjs/index.js';
import { createDatabase, memberships, users } from '../packages/database/dist/index.js';
import { DEMO_IDS } from '../packages/contracts/dist/index.js';
import { cleanupTestEvents } from './lib/test-event-cleanup.mjs';
import { createCustomerSession } from './lib/customer-session.mjs';

const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:8088/api/v1';
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://conference:conference@localhost:15432/conference';
const notificationSinkUrl = process.env.NOTIFICATION_SINK_URL ?? 'http://localhost:4080';
const publicOrganizationSlug = process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference';
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const slugRunId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const mobileSuffix = String(Date.now()).slice(-8);
const testEventIds = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const error = new Error(`${options.method ?? 'GET'} ${path} failed: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function expectStatus(path, status, options = {}) {
  try {
    await request(path, options);
  } catch (error) {
    assert(error.status === status, `${path} expected ${status}, received ${error.status}`);
    return;
  }
  throw new Error(`${path} expected ${status}, request succeeded`);
}

function auth(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function pause(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

try {
  const login = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL ?? 'admin@tokems.local',
      password: process.env.ADMIN_PASSWORD ?? 'admin',
    }),
  });
  const headers = auth(login.accessToken);
  const blueprints = await request('/admin/event-blueprints', { headers });
  const templateOptions = await request('/admin/template-options', { headers });
  const templateVersionId = templateOptions.find(
    (item) => item.currentPublishedVersionId,
  )?.currentPublishedVersionId;
  assert(templateVersionId, 'No published conference template is available');
  const slug = `wait-${slugRunId}`;
  const event = await request('/admin/events', {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': `waitlist-event-${runId}`,
    },
    body: JSON.stringify({
      name: `候补闭环验收大会 ${runId}`,
      shortName: '候补闭环验收',
      slug,
      startsAt: '2027-10-18T01:00:00.000Z',
      endsAt: '2027-10-18T10:00:00.000Z',
      timezone: 'Asia/Shanghai',
      venue: '深圳候补验收会场',
      city: '深圳',
      address: '深圳市南山区候补验收路 1 号',
      templateVersionId,
      blueprintId: blueprints[0].id,
    }),
  });
  const eventId = event.id;
  testEventIds.push(eventId);
  const adminEvent = await request(`/admin/events/${eventId}`, { headers });
  const ticket = adminEvent.tickets[0];
  await request(`/admin/events/${eventId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      settings: {
        registration: {
          paymentMode: 'ticketed',
          currency: 'CNY',
          registrationOpen: true,
          accountMode: 'mobile_otp_required',
        },
      },
    }),
  });
  await request(`/admin/events/${eventId}/ticket-types/${ticket.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ capacity: 1 }),
  });
  const forms = await request(`/admin/events/${eventId}/registration-forms`, { headers });
  const publishedForm = await request(`/admin/events/${eventId}/registration-forms/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: forms[0].name,
      fields: forms[0].fields,
      termsVersion: `waitlist-${runId}`.slice(0, 32),
      termsContent: '本条款用于候补闭环自动化验收，并记录参会人的授权快照。',
    }),
  });
  await request(`/admin/events/${eventId}/releases`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ templateKey: 'editorial-blue' }),
  });
  const publicEvent = await request(`/events/${slug}`, {
    headers: { 'X-Organization-Slug': publicOrganizationSlug },
  });
  const publicTicket = publicEvent.tickets.find((item) => item.id === ticket.id);
  assert(publicTicket.remaining === 1, 'The single test seat was not published');

  const firstPayload = {
    eventId,
    ticketTypeId: ticket.id,
    attendee: {
      name: '候补占位参会人',
      mobile: `138${mobileSuffix}`,
      email: `waitlist-holder-${runId}@example.com`,
      company: '候补闭环实验室',
      title: '首席验收官',
      city: '深圳',
    },
    invoiceRequired: false,
    marketingConsent: true,
    termsAccepted: true,
    purchaseFor: 'self',
    purchaseIntentId: randomUUID(),
    formVersion: publishedForm.version,
    termsVersion: publishedForm.termsVersion,
  };
  const holderSession = await createCustomerSession({
    apiBase: baseUrl,
    mobile: firstPayload.attendee.mobile,
    organizationSlug: publicOrganizationSlug,
  });
  const holderHeaders = {
    'Idempotency-Key': `waitlist-holder-${runId}`,
    ...holderSession.headers,
  };
  const firstCheckout = await request('/registrations', {
    method: 'POST',
    headers: holderHeaders,
    body: JSON.stringify(firstPayload),
  });
  const repeatedCheckout = await request('/registrations', {
    method: 'POST',
    headers: holderHeaders,
    body: JSON.stringify(firstPayload),
  });
  assert(
    repeatedCheckout.order.id === firstCheckout.order.id &&
      repeatedCheckout.orderAccessToken !== firstCheckout.orderAccessToken,
    'Registration retry did not preserve the checkout with a freshly issued access token',
  );
  const paymentCallback = {
    orderId: firstCheckout.order.id,
    externalId: `provider-payment-${runId}`,
    status: 'succeeded',
    amount: firstCheckout.order.amount,
    currency: firstCheckout.order.currency,
    occurredAt: new Date().toISOString(),
  };
  const paymentBody = JSON.stringify(paymentCallback);
  const paymentTimestamp = String(Date.now());
  const paymentWebhookSecret =
    process.env.PAYMENT_WEBHOOK_SECRET ?? 'conference-local-payment-webhook-secret-2026';
  const paymentSignature = createHmac('sha256', paymentWebhookSecret)
    .update(`${paymentTimestamp}.${paymentBody}`)
    .digest('hex');
  const providerPayment = await request('/payments/webhook/test-provider', {
    method: 'POST',
    headers: {
      'X-Payment-Timestamp': paymentTimestamp,
      'X-Payment-Signature': paymentSignature,
    },
    body: paymentBody,
  });
  const providerPaymentRetry = await request('/payments/webhook/test-provider', {
    method: 'POST',
    headers: {
      'X-Payment-Timestamp': paymentTimestamp,
      'X-Payment-Signature': paymentSignature,
    },
    body: paymentBody,
  });
  assert(
    providerPayment.ticket.code === providerPaymentRetry.ticket.code,
    'Provider payment callback is not idempotent',
  );

  const waitlistEmail = `waitlist-candidate-${runId}@example.com`;
  const waitlistMobile = `139${mobileSuffix}`;
  const waitlistInput = {
    eventId,
    ticketTypeId: ticket.id,
    name: '候补申请人',
    email: waitlistEmail,
    mobile: waitlistMobile,
  };
  const candidateSession = await createCustomerSession({
    apiBase: baseUrl,
    mobile: waitlistMobile,
    organizationSlug: publicOrganizationSlug,
  });
  const entry = await request('/waitlist', {
    method: 'POST',
    headers: {
      'Idempotency-Key': `waitlist-join-${runId}`,
      ...candidateSession.headers,
    },
    body: JSON.stringify(waitlistInput),
  });
  const repeatedEntry = await request('/waitlist', {
    method: 'POST',
    headers: {
      'Idempotency-Key': `waitlist-join-retry-${runId}`,
      ...candidateSession.headers,
    },
    body: JSON.stringify(waitlistInput),
  });
  assert(
    entry.id === repeatedEntry.id && entry.status === 'waiting',
    'Waitlist join is not idempotent',
  );
  const emailOnlyRetry = await request('/waitlist', {
    method: 'POST',
    headers: {
      'Idempotency-Key': `waitlist-email-retry-${runId}`,
      ...candidateSession.headers,
    },
    body: JSON.stringify({
      eventId,
      ticketTypeId: ticket.id,
      name: '候补申请人',
      email: waitlistEmail,
    }),
  });
  assert(
    emailOnlyRetry.id === entry.id && emailOnlyRetry.mobile === `+86${waitlistMobile}`,
    'Authenticated waitlist retry did not preserve the owner contact',
  );
  const spoofedMobileRetry = await request('/waitlist', {
    method: 'POST',
    headers: {
      'Idempotency-Key': `waitlist-email-conflict-${runId}`,
      ...candidateSession.headers,
    },
    body: JSON.stringify({
      ...waitlistInput,
      mobile: `137${mobileSuffix}`,
    }),
  });
  assert(
    spoofedMobileRetry.id === entry.id && spoofedMobileRetry.mobile === `+86${waitlistMobile}`,
    'Authenticated waitlist retry accepted an unverified mobile',
  );
  await expectStatus('/waitlist', 409, {
    method: 'POST',
    headers: {
      'Idempotency-Key': `waitlist-mobile-conflict-${runId}`,
      ...candidateSession.headers,
    },
    body: JSON.stringify({
      ...waitlistInput,
      email: `waitlist-conflict-${runId}@example.com`,
    }),
  });

  await request(`/admin/orders/${firstCheckout.order.id}/refunds`, {
    method: 'POST',
    headers: auth(login.accessToken, { 'Idempotency-Key': `waitlist-refund-${runId}` }),
    body: JSON.stringify({
      amount: firstCheckout.order.amount,
      reason: '释放库存用于候补递补验收',
    }),
  });

  let invited;
  let delivery;
  for (let attempt = 0; attempt < 40 && (!invited || delivery?.status !== 'sent'); attempt += 1) {
    await pause(250);
    const waitlist = await request(`/admin/events/${eventId}/waitlist`, { headers });
    invited = waitlist.find((item) => item.id === entry.id && item.status === 'invited');
    const deliveries = await request(`/admin/notification-deliveries?eventId=${eventId}`, {
      headers,
    });
    delivery = deliveries.find((item) => item.subject.includes('候补名额'));
  }
  assert(invited?.expiresAt, 'Released inventory did not invite the first waitlist entry');
  assert(delivery?.status === 'sent', 'Waitlist offer notification was not delivered');
  assert(
    delivery.recipient !== waitlistEmail && !delivery.body.includes('http'),
    'Notification management API exposed recipient or access link',
  );
  const sinkResponse = await fetch(`${notificationSinkUrl}/notifications/${delivery.id}`, {
    headers: {
      Authorization: `Bearer ${process.env.NOTIFICATION_WEBHOOK_TOKEN ?? 'conference-local-notification-token'}`,
    },
  });
  const deliveredPayload = await sinkResponse.json();
  assert(sinkResponse.ok, 'Local notification provider did not retain the delivered message');
  const registrationLink = deliveredPayload.body.match(/https?:\/\/\S+/)?.[0];
  assert(registrationLink, 'Waitlist notification does not contain the registration link');
  const offerToken = new URL(registrationLink).searchParams.get('offer');
  assert(offerToken, 'Waitlist registration link does not contain an offer token');

  const invitedPayload = {
    ...firstPayload,
    purchaseIntentId: randomUUID(),
    attendee: {
      ...firstPayload.attendee,
      name: '候补申请人',
      mobile: waitlistMobile,
      email: waitlistEmail,
    },
    waitlistOfferToken: offerToken,
  };
  const invitedHeaders = {
    'Idempotency-Key': `waitlist-claim-${runId}`,
    ...candidateSession.headers,
  };
  const invitedCheckout = await request('/registrations', {
    method: 'POST',
    headers: invitedHeaders,
    body: JSON.stringify(invitedPayload),
  });
  assert(
    invitedCheckout.order.amount === publicTicket.price,
    'Waitlist checkout price is incorrect',
  );
  await expectStatus('/registrations', 409, {
    method: 'POST',
    headers: {
      ...candidateSession.headers,
      'Idempotency-Key': `waitlist-token-replay-${runId}`,
    },
    body: JSON.stringify({
      ...invitedPayload,
      attendee: { ...invitedPayload.attendee, name: '候补令牌重放者' },
    }),
  });
  const claimedWaitlist = await request(`/admin/events/${eventId}/waitlist`, { headers });
  assert(
    claimedWaitlist.find((item) => item.id === entry.id)?.status === 'claimed',
    'Waitlist offer was not marked as claimed',
  );

  const { db, pool } = createDatabase(databaseUrl);
  const viewerId = randomUUID();
  const viewerEmail = `viewer-${runId}@example.com`;
  try {
    const storedIdempotency = await pool.query(
      `select response_body
       from idempotency_keys
       where scope = 'registration:create' and key = $1`,
      [`waitlist-holder-${runId}`],
    );
    assert(storedIdempotency.rows.length === 1, 'Registration idempotency record is missing');
    assert(
      !JSON.stringify(storedIdempotency.rows[0].response_body).includes(
        firstCheckout.orderAccessToken,
      ),
      'Registration idempotency record retained a plaintext access token',
    );
    await db.insert(users).values({
      id: viewerId,
      email: viewerEmail,
      name: '只读权限验收成员',
      passwordHash: await hash('ViewerPassword2026', 10),
    });
    await db.insert(memberships).values({
      organizationId: DEMO_IDS.organization,
      userId: viewerId,
      role: 'viewer',
      grants: ['event.read'],
    });
    const viewerLogin = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: viewerEmail, password: 'ViewerPassword2026' }),
    });
    await request('/admin/events', { headers: auth(viewerLogin.accessToken) });
    await expectStatus(`/admin/events/${eventId}/releases`, 403, {
      method: 'POST',
      headers: auth(viewerLogin.accessToken),
      body: JSON.stringify({ templateKey: 'editorial-blue' }),
    });
  } finally {
    await pool.query('delete from users where id = $1', [viewerId]);
    await pool.end();
  }

  await request(`/admin/events/${eventId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'archived' }),
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        eventId,
        waitlistPosition: entry.position,
        offer: invited.status,
        delivery: delivery.status,
        claim: 'claimed',
        replay: 'rejected',
        rbac: 'viewer publish rejected',
      },
      null,
      2,
    ),
  );
} finally {
  await cleanupTestEvents(testEventIds, databaseUrl);
}
