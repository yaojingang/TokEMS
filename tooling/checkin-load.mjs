import { createHmac } from 'node:crypto';
import { cleanupTestEvents } from './lib/test-event-cleanup.mjs';

const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:8088/api/v1';
const deviceCount = Number(process.env.CHECKIN_DEVICE_COUNT ?? 100);
const paymentWebhookSecret = process.env.PAYMENT_WEBHOOK_SECRET;
if (!paymentWebhookSecret) {
  throw new Error('PAYMENT_WEBHOOK_SECRET is required for the check-in load test');
}
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const slugRunId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
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
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${options.method ?? 'GET'} ${path} returned ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

try {
  const login = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL ?? 'admin@tokems.local',
      password: process.env.ADMIN_PASSWORD ?? 'admin',
    }),
  });
  const headers = { Authorization: `Bearer ${login.accessToken}` };
  const blueprints = await request('/admin/event-blueprints', { headers });
  const templateOptions = await request('/admin/template-options', { headers });
  const templateVersionId = templateOptions.find(
    (item) => item.currentPublishedVersionId,
  )?.currentPublishedVersionId;
  if (!templateVersionId) throw new Error('No published conference template is available');
  const slug = `load-${slugRunId}`;
  const event = await request('/admin/events', {
    method: 'POST',
    headers: {
      ...headers,
      'Idempotency-Key': `checkin-load-event-${runId}`,
    },
    body: JSON.stringify({
      name: `百台设备并发核销验收 ${runId}`,
      shortName: '百台核销验收',
      slug,
      startsAt: '2027-10-18T01:00:00.000Z',
      endsAt: '2027-10-18T10:00:00.000Z',
      timezone: 'Asia/Shanghai',
      venue: '深圳并发验收中心',
      city: '深圳',
      address: '广东省深圳市南山区并发路 100 号',
      templateVersionId,
      blueprintId: blueprints[0].id,
    }),
  });
  testEventIds.push(event.id);
  await request(`/admin/events/${event.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      settings: {
        registration: {
          accountMode: 'mobile_otp_required',
        },
      },
    }),
  });

  const draftForms = await request(`/admin/events/${event.id}/registration-forms`, { headers });
  const form = await request(`/admin/events/${event.id}/registration-forms/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: draftForms[0].name,
      fields: draftForms[0].fields,
      termsVersion: `load-${runId}`.slice(0, 32),
      termsContent: '本条款用于百台设备并发核销验收，报名记录会固化当前同意快照。',
    }),
  });
  await request(`/admin/events/${event.id}/releases`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ templateKey: 'editorial-blue' }),
  });
  const eventDetail = await request(`/admin/events/${event.id}`, { headers });
  const ticketTypeId = eventDetail.tickets[0].id;

  const registrationStartedAt = performance.now();
  const checkouts = await Promise.all(
    Array.from({ length: deviceCount }, (_, index) =>
      request('/registrations', {
        method: 'POST',
        headers: {
          'Idempotency-Key': `load-registration-${runId}-${index}`,
          'X-Forwarded-For': `198.51.100.${(index % 250) + 1}`,
        },
        body: JSON.stringify({
          eventId: event.id,
          ticketTypeId,
          attendee: {
            name: `并发参会人${String(index + 1).padStart(3, '0')}`,
            mobile: `139${String(10_000_000 + index)}`,
            email: `checkin-load-${runId}-${index}@example.com`,
            company: '大会核销并发实验室',
            title: '现场验收员',
            city: '深圳',
          },
          invoiceRequired: false,
          marketingConsent: false,
          termsAccepted: true,
          formVersion: form.version,
          termsVersion: form.termsVersion,
        }),
      }),
    ),
  );
  const registrationDurationMs = Math.round(performance.now() - registrationStartedAt);

  const paymentStartedAt = performance.now();
  const payments = await Promise.all(
    checkouts.map((checkout, index) => {
      const paymentBody = JSON.stringify({
        orderId: checkout.order.id,
        externalId: `load-payment-${runId}-${index}`,
        status: 'succeeded',
        amount: checkout.order.amount,
        currency: checkout.order.currency,
        occurredAt: new Date().toISOString(),
      });
      const paymentTimestamp = String(Date.now());
      const paymentSignature = createHmac('sha256', paymentWebhookSecret)
        .update(`${paymentTimestamp}.${paymentBody}`)
        .digest('hex');
      return request('/payments/webhook/test-provider', {
        method: 'POST',
        headers: {
          'X-Payment-Timestamp': paymentTimestamp,
          'X-Payment-Signature': paymentSignature,
        },
        body: paymentBody,
      });
    }),
  );
  const paymentDurationMs = Math.round(performance.now() - paymentStartedAt);
  assert(
    new Set(payments.map((item) => item.ticket.id)).size === deviceCount,
    'Ticket issuance count is incorrect',
  );

  const devices = await Promise.all(
    Array.from({ length: deviceCount }, (_, index) =>
      request(`/admin/events/${event.id}/checkin-devices`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          deviceCode: `LOAD_${runId.replaceAll('-', '_')}_${String(index + 1).padStart(3, '0')}`,
          name: `并发核销机 ${String(index + 1).padStart(3, '0')}`,
        }),
      }),
    ),
  );

  const batches = payments.map((payment, index) => ({
    token: devices[index].token,
    payload: {
      eventId: event.id,
      checkInListId: 'main-entrance',
      deviceCode: devices[index].device.deviceCode,
      batchKey: `load-batch-${runId}-${index}`,
      records: [
        {
          localId: `local-${runId}-${index}`,
          ticketCode: payment.ticket.code,
          checkedInAt: new Date().toISOString(),
        },
      ],
    },
  }));

  const checkinStartedAt = performance.now();
  const results = await Promise.all(
    batches.map((batch) =>
      request('/admin/checkins/sync', {
        method: 'POST',
        headers: { ...headers, 'X-Device-Token': batch.token },
        body: JSON.stringify(batch.payload),
      }),
    ),
  );
  const checkinDurationMs = Math.round(performance.now() - checkinStartedAt);
  assert(
    results.reduce((sum, item) => sum + item.accepted, 0) === deviceCount,
    'Not every device check-in was accepted',
  );

  const retryResults = await Promise.all(
    batches.map((batch) =>
      request('/admin/checkins/sync', {
        method: 'POST',
        headers: { ...headers, 'X-Device-Token': batch.token },
        body: JSON.stringify(batch.payload),
      }),
    ),
  );
  assert(
    retryResults.every((item) => item.cached === true),
    'Check-in batch retries were not idempotent',
  );

  const dashboard = await request(`/admin/dashboard?eventId=${event.id}`, { headers });
  assert(
    dashboard.metrics.checkedIn === deviceCount,
    'Dashboard check-in metric does not match the load result',
  );
  await request(`/admin/events/${event.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'archived' }),
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        eventId: event.id,
        devices: deviceCount,
        registrations: checkouts.length,
        tickets: payments.length,
        accepted: results.reduce((sum, item) => sum + item.accepted, 0),
        idempotentRetries: retryResults.filter((item) => item.cached).length,
        durationMs: {
          registrations: registrationDurationMs,
          payments: paymentDurationMs,
          concurrentCheckins: checkinDurationMs,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await cleanupTestEvents(testEventIds);
}
