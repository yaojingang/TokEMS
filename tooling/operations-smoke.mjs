import { createHmac } from 'node:crypto';
import { cleanupTestEvents } from './lib/test-event-cleanup.mjs';

const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:8088/api/v1';
const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@tokems.local';
const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin';
const paymentWebhookSecret = process.env.PAYMENT_WEBHOOK_SECRET;
if (!paymentWebhookSecret) {
  throw new Error('PAYMENT_WEBHOOK_SECRET is required for the operations smoke test');
}
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  return { response, body };
}

function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function expectStatus(path, status, options = {}) {
  try {
    await request(path, options);
  } catch (error) {
    assert(error.status === status, `${path} expected ${status}, received ${error.status}`);
    return error.body;
  }
  throw new Error(`${path} expected ${status}, request succeeded`);
}

try {
  const { body: login } = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  assert(login.accessToken, 'Admin login did not return an access token');
  const token = login.accessToken;
  const headers = authHeaders(token);

  const [
    { body: identity },
    { body: organizationSettings },
    { body: integrations },
    { body: blueprints },
    { body: templates },
    { body: conferenceTemplates },
    { body: members },
  ] = await Promise.all([
    request('/auth/me', { headers }),
    request('/admin/organization/settings', { headers }),
    request('/admin/integrations/status', { headers }),
    request('/admin/event-blueprints', { headers }),
    request('/admin/template-packages', { headers }),
    request('/admin/template-options', { headers }),
    request('/admin/organization/members', { headers }),
  ]);
  assert(identity.membership.status === 'active', 'Current organization identity is inactive');
  assert(organizationSettings.settings.defaultTimezone, 'Organization settings are incomplete');
  assert(
    Object.values(integrations).every((item) => typeof item.configured === 'boolean'),
    'Integration status response is invalid',
  );
  assert(blueprints.length >= 1, 'No event blueprint is available');
  assert(templates.length >= 2, 'Two site templates are required');
  assert(
    conferenceTemplates.some((item) => item.currentPublishedVersionId),
    'No published conference template is available',
  );
  assert(members.length >= 1, 'Organization members are missing');
  const templateVersionId = conferenceTemplates.find(
    (item) => item.currentPublishedVersionId,
  ).currentPublishedVersionId;
  const currentMember = members[0];
  const { body: updatedMember } = await request(`/admin/organization/members/${currentMember.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      name: currentMember.name,
      mobile: currentMember.mobile,
      role: currentMember.role,
      grants: currentMember.grants,
      profile: {
        company: currentMember.profile?.company ?? null,
        title: currentMember.profile?.title ?? null,
        city: currentMember.profile?.city ?? null,
        bio: currentMember.profile?.bio ?? null,
        tags: currentMember.profile?.tags ?? [],
      },
    }),
  });
  assert(updatedMember.id === currentMember.id, 'Organization member update failed');

  const invitedEmail = `invited-${runId}@example.com`;
  const { body: invitationResult } = await request('/admin/organization/invitations', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: invitedEmail,
      role: 'viewer',
      grants: ['event.read', 'event.dashboard.read'],
    }),
  });
  assert(invitationResult.acceptanceToken, 'Invitation did not return its one-time token');
  const { body: acceptedMember } = await request('/auth/invitations/accept', {
    method: 'POST',
    body: JSON.stringify({
      token: invitationResult.acceptanceToken,
      name: '邀请验收成员',
      password: 'Conference2026!',
    }),
  });
  assert(acceptedMember.email === invitedEmail, 'Invitation acceptance created the wrong member');
  const { body: invitedLogin } = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: invitedEmail,
      password: 'Conference2026!',
      organizationSlug: identity.organization.slug,
    }),
  });
  assert(invitedLogin.accessToken, 'Invited member could not select the invited organization');
  await request(`/admin/organization/members/${acceptedMember.id}`, {
    method: 'DELETE',
    headers,
  });

  const delegatedEmail = `delegated-manager-${runId}@example.com`;
  const { body: delegatedInvitation } = await request('/admin/organization/invitations', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: delegatedEmail,
      role: 'event_owner',
      grants: ['event.*', 'org.member.read', 'org.member.manage'],
    }),
  });
  const { body: delegatedMember } = await request('/auth/invitations/accept', {
    method: 'POST',
    body: JSON.stringify({
      token: delegatedInvitation.acceptanceToken,
      name: '受限成员管理员',
      password: 'Conference2026!',
    }),
  });
  const { body: delegatedLogin } = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: delegatedEmail,
      password: 'Conference2026!',
      organizationSlug: identity.organization.slug,
    }),
  });
  const delegatedHeaders = authHeaders(delegatedLogin.accessToken);
  await expectStatus('/admin/organization/invitations', 403, {
    method: 'POST',
    headers: delegatedHeaders,
    body: JSON.stringify({
      email: `escalated-${runId}@example.com`,
      role: 'organization_admin',
      grants: ['*'],
    }),
  });
  await expectStatus(`/admin/organization/members/${delegatedMember.id}`, 403, {
    method: 'PATCH',
    headers: delegatedHeaders,
    body: JSON.stringify({
      name: delegatedMember.name,
      mobile: delegatedMember.mobile,
      role: 'organization_admin',
      grants: ['*'],
      profile: {
        company: null,
        title: null,
        city: null,
        bio: null,
        tags: [],
      },
    }),
  });
  await request(`/admin/organization/members/${delegatedMember.id}`, {
    method: 'DELETE',
    headers,
  });

  const { body: cancellableInvitation } = await request('/admin/organization/invitations', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: `cancelled-${runId}@example.com`,
      role: 'operator',
      grants: ['event.read', 'event.registration.read', 'event.checkin.execute'],
    }),
  });
  const { body: cancelledInvitation } = await request(
    `/admin/organization/invitations/${cancellableInvitation.invitation.id}`,
    { method: 'DELETE', headers },
  );
  assert(cancelledInvitation.cancelled === true, 'Invitation cancellation failed');

  const slug = `acceptance-conference-${runId}`;
  const eventCreateKey = `event-create-${runId}`;
  const eventCreateInput = {
    name: `系统验收大会 ${runId}`,
    shortName: '系统验收大会',
    slug,
    startsAt: '2027-06-18T01:00:00.000Z',
    endsAt: '2027-06-19T10:00:00.000Z',
    timezone: 'Asia/Shanghai',
    venue: '深圳国际会议中心',
    city: '深圳',
    address: '广东省深圳市南山区验收路 1 号',
    templateVersionId,
    blueprintId: blueprints[0].id,
  };
  const { body: event } = await request('/admin/events', {
    method: 'POST',
    headers: authHeaders(token, { 'Idempotency-Key': eventCreateKey }),
    body: JSON.stringify(eventCreateInput),
  });
  const { body: repeatedEvent } = await request('/admin/events', {
    method: 'POST',
    headers: authHeaders(token, { 'Idempotency-Key': eventCreateKey }),
    body: JSON.stringify(eventCreateInput),
  });
  assert(repeatedEvent.id === event.id, 'Event creation idempotent replay returned another event');
  await expectStatus('/admin/events', 409, {
    method: 'POST',
    headers: authHeaders(token, { 'Idempotency-Key': eventCreateKey }),
    body: JSON.stringify({ ...eventCreateInput, shortName: '幂等冲突大会' }),
  });
  const eventId = event.id;
  testEventIds.push(eventId);
  assert(eventId, 'Event creation failed');
  await request(`/admin/events/${eventId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      settings: {
        registration: {
          accountMode: 'guest_allowed',
        },
      },
    }),
  });
  const releaseOneTagline = event.tagline;
  const saveAsTemplateKey = `event-save-template-${runId}`;
  const saveAsTemplateInput = {
    name: `大会另存模板 ${runId}`,
    description: '从大会体验配置提取的自动化验收模板',
    tags: ['另存验收'],
    includeContent: false,
  };
  const { body: savedTemplate } = await request(`/admin/events/${eventId}/save-as-template`, {
    method: 'POST',
    headers: authHeaders(token, { 'Idempotency-Key': saveAsTemplateKey }),
    body: JSON.stringify(saveAsTemplateInput),
  });
  const { body: repeatedSavedTemplate } = await request(
    `/admin/events/${eventId}/save-as-template`,
    {
      method: 'POST',
      headers: authHeaders(token, { 'Idempotency-Key': saveAsTemplateKey }),
      body: JSON.stringify(saveAsTemplateInput),
    },
  );
  assert(savedTemplate.summary.currentVersion === 1, '大会另存模板未发布 V1');
  assert(
    repeatedSavedTemplate.summary.id === savedTemplate.summary.id,
    '大会另存模板幂等重试生成了重复模板',
  );
  await request(`/admin/templates/${savedTemplate.summary.id}/archive`, {
    method: 'POST',
    headers: authHeaders(token, { 'Idempotency-Key': `template-archive-${runId}` }),
    body: JSON.stringify({ revision: savedTemplate.draft.revision }),
  });

  const contentManagerEmail = `content-manager-${runId}@example.com`;
  const { body: contentManagerInvitation } = await request('/admin/organization/invitations', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: contentManagerEmail,
      role: 'content_manager',
      grants: [
        'event.read',
        'event.content.manage',
        'event.site.read',
        'event.ai.read',
        'event.ai.generate',
        'event.ai.approve',
        'event.notification.read',
      ],
    }),
  });
  const { body: contentManagerMember } = await request('/auth/invitations/accept', {
    method: 'POST',
    body: JSON.stringify({
      token: contentManagerInvitation.acceptanceToken,
      name: '内容权限验收成员',
      password: 'Conference2026!',
    }),
  });
  const { body: contentManagerLogin } = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: contentManagerEmail,
      password: 'Conference2026!',
      organizationSlug: identity.organization.slug,
    }),
  });
  const contentManagerHeaders = authHeaders(contentManagerLogin.accessToken);
  await request(`/admin/events/${eventId}/content`, { headers: contentManagerHeaders });
  const { body: contentManagerExperience } = await request(`/admin/events/${eventId}/experience`, {
    headers: contentManagerHeaders,
  });
  await request(`/admin/events/${eventId}/experience/faq`, {
    method: 'PUT',
    headers: contentManagerHeaders,
    body: JSON.stringify({
      revision: contentManagerExperience.overrides.faq.revision,
      document: {},
    }),
  });
  await expectStatus(`/admin/events/${eventId}/ticket-types`, 403, {
    method: 'POST',
    headers: contentManagerHeaders,
    body: JSON.stringify({
      code: 'FORBIDDEN_TICKET',
      name: '不应创建的票种',
      description: '用于验证内容管理员不能修改票务',
      price: 100,
      currency: 'CNY',
      capacity: 1,
      recommended: false,
      benefits: [],
    }),
  });
  await expectStatus(`/admin/events/${eventId}/registration-forms/publish`, 403, {
    method: 'POST',
    headers: contentManagerHeaders,
    body: JSON.stringify({
      name: '不应发布的报名表',
      fields: [],
      termsVersion: 'forbidden',
      termsContent: '内容管理员不能发布报名表条款。',
    }),
  });
  await request(`/admin/organization/members/${contentManagerMember.id}`, {
    method: 'DELETE',
    headers,
  });

  const { body: temporaryTicket } = await request(`/admin/events/${eventId}/ticket-types`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      code: `TEST_${runId.replaceAll('-', '_').toUpperCase()}`.slice(0, 40),
      name: '验收临时票种',
      description: '用于验证票种创建与删除能力',
      price: 9900,
      currency: 'CNY',
      capacity: 10,
      recommended: false,
      benefits: ['验收权益'],
    }),
  });
  await request(`/admin/events/${eventId}/ticket-types/${temporaryTicket.id}`, {
    method: 'DELETE',
    headers,
  });
  const { body: archivedTickets } = await request(
    `/admin/events/${eventId}/ticket-types/archived`,
    {
      headers,
    },
  );
  assert(
    archivedTickets.some((item) => item.id === temporaryTicket.id),
    'Archived ticket was not available for recovery',
  );
  await request(`/admin/events/${eventId}/ticket-types/${temporaryTicket.id}/restore`, {
    method: 'POST',
    headers,
  });
  await request(`/admin/events/${eventId}/ticket-types/${temporaryTicket.id}`, {
    method: 'DELETE',
    headers,
  });

  await expectStatus(`/admin/dashboard?eventId=00000000-0000-4000-8000-000000000000`, 400, {
    headers,
  });

  const { body: content } = await request(`/admin/events/${eventId}/content`, { headers });
  assert(Array.isArray(content.speakers), 'Content response is invalid');
  const { body: speaker } = await request(`/admin/events/${eventId}/speakers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: '验收嘉宾',
      role: '系统验收负责人',
      topic: '大会运营平台全链路验收',
      initials: '验',
      accentFrom: '#2563eb',
      accentTo: '#1e3a8a',
      tags: ['系统验收'],
      sortOrder: 0,
    }),
  });
  const { body: session } = await request(`/admin/events/${eventId}/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      day: 1,
      startsAt: '2027-06-18T01:00:00.000Z',
      endsAt: '2027-06-18T01:40:00.000Z',
      title: '全链路验收开场',
      speaker: '验收嘉宾',
      kind: 'talk',
      sortOrder: 0,
    }),
  });

  const { body: formVersions } = await request(`/admin/events/${eventId}/registration-forms`, {
    headers,
  });
  const sourceForm = formVersions[0];
  const { body: publishedForm } = await request(
    `/admin/events/${eventId}/registration-forms/publish`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: sourceForm.name,
        fields: [
          ...sourceForm.fields,
          {
            key: 'dietary_preference',
            label: '餐饮偏好',
            type: 'select',
            required: true,
            options: ['标准餐', '素食'],
            placeholder: '请选择餐饮偏好',
          },
        ],
        termsVersion: `acceptance-${runId}`.slice(0, 32),
        termsContent: '本条款用于大会运营平台自动化验收，提交报名会保存表单与条款同意快照。',
      }),
    },
  );
  assert(publishedForm.status === 'published', 'Registration form was not published');

  const { body: draftReleases } = await request(`/admin/events/${eventId}/releases`, { headers });
  assert(draftReleases.length === 0, 'Draft saves created a public release before launch');
  await request(`/admin/events/${eventId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'prepublished' }),
  });
  const { body: releasesAfterLaunch } = await request(`/admin/events/${eventId}/releases`, {
    headers,
  });
  const release1 = releasesAfterLaunch[0];
  assert(release1?.version === 1, 'First launch did not activate release V1');
  assert(
    release1.activationKind === 'initial',
    'First launch was not recorded as initial activation',
  );

  await request(`/admin/events/${eventId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ tagline: releaseOneTagline }),
  });
  const { body: releasesAfterIdenticalSave } = await request(`/admin/events/${eventId}/releases`, {
    headers,
  });
  assert(
    releasesAfterIdenticalSave.length === releasesAfterLaunch.length,
    'Identical save created a redundant release',
  );

  const liveTagline = `验收保存即生效 ${runId}`;
  await request(`/admin/events/${eventId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ tagline: liveTagline }),
  });
  const { body: releasesAfterSave } = await request(`/admin/events/${eventId}/releases`, {
    headers,
  });
  const release2 = releasesAfterSave[0];
  assert(release2.version === release1.version + 1, 'Release version did not increase');
  assert(release2.activationKind === 'save', 'Live save was not recorded as save activation');
  const { body: publicAfterLiveSave } = await request(`/events/${slug}`, {
    headers: { 'X-Organization-Slug': identity.organization.slug },
  });
  assert(
    publicAfterLiveSave.tagline === liveTagline,
    'Saved event copy was not immediately public',
  );
  const { body: rolledBack } = await request(
    `/admin/events/${eventId}/releases/${release1.id}/rollback`,
    { method: 'POST', headers },
  );
  assert(rolledBack.active, 'Release rollback did not change the active version');

  const { body: publicEvent } = await request(`/events/${slug}`, {
    headers: { 'X-Organization-Slug': identity.organization.slug },
  });
  assert(
    publicEvent.tagline === releaseOneTagline,
    'Rollback did not restore public release content',
  );
  assert(
    publicEvent.registrationForm.version === publishedForm.version,
    'Public form version is stale',
  );
  assert(publicEvent.tickets.length >= 1, 'Blueprint tickets were not cloned');

  const releasedTicket = publicEvent.tickets[0];
  await request(`/admin/events/${eventId}/ticket-types/${releasedTicket.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      name: `实时生效票种 ${runId}`,
      price: releasedTicket.price + 1700,
    }),
  });
  const { body: publicAfterTicketEdit } = await request(`/events/${slug}`, {
    headers: { 'X-Organization-Slug': identity.organization.slug },
  });
  const activeTicket = publicAfterTicketEdit.tickets.find((item) => item.id === releasedTicket.id);
  assert(
    activeTicket?.name === `实时生效票种 ${runId}` &&
      activeTicket.price === releasedTicket.price + 1700,
    'Saved ticket changes were not immediately public',
  );

  await request(`/admin/events/${eventId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'registration_open' }),
  });

  const registrationKey = `registration-${runId}`;
  const registrationPayload = {
    eventId,
    ticketTypeId: activeTicket.id,
    attendee: {
      name: '验收参会人',
      mobile: '13800138000',
      email: `acceptance-${runId}@example.com`,
      company: '大会系统验收实验室',
      title: '质量负责人',
      city: '深圳',
    },
    invoiceRequired: false,
    marketingConsent: true,
    termsAccepted: true,
    formVersion: publicAfterTicketEdit.registrationForm.version,
    termsVersion: publicAfterTicketEdit.registrationForm.termsVersion,
    formAnswers: { dietary_preference: '素食' },
  };
  await expectStatus('/registrations', 400, {
    method: 'POST',
    headers: { 'Idempotency-Key': `invalid-form-${runId}` },
    body: JSON.stringify({
      ...registrationPayload,
      formAnswers: { dietary_preference: '未发布的选项' },
    }),
  });
  const { body: checkout } = await request('/registrations', {
    method: 'POST',
    headers: { 'Idempotency-Key': registrationKey },
    body: JSON.stringify(registrationPayload),
  });
  assert(
    checkout.order.amount === activeTicket.price,
    'Checkout ignored the released ticket price',
  );
  assert(
    checkout.registration.formAnswers?.dietary_preference === '素食',
    'Dynamic form answer was not persisted',
  );
  const { body: cachedCheckout } = await request('/registrations', {
    method: 'POST',
    headers: { 'Idempotency-Key': registrationKey },
    body: JSON.stringify(registrationPayload),
  });
  assert(cachedCheckout.order.id === checkout.order.id, 'Registration retry created another order');
  await expectStatus('/registrations', 409, {
    method: 'POST',
    headers: { 'Idempotency-Key': registrationKey },
    body: JSON.stringify({
      ...registrationPayload,
      attendee: { ...registrationPayload.attendee, name: '冲突参会人' },
    }),
  });

  const paymentExternalId = `operations-payment-${runId}`;
  const paymentCallback = {
    orderId: checkout.order.id,
    externalId: paymentExternalId,
    status: 'succeeded',
    amount: checkout.order.amount,
    currency: checkout.order.currency,
    occurredAt: new Date().toISOString(),
  };
  const paymentBody = JSON.stringify(paymentCallback);
  const paymentTimestamp = String(Date.now());
  const paymentSignature = createHmac('sha256', paymentWebhookSecret)
    .update(`${paymentTimestamp}.${paymentBody}`)
    .digest('hex');
  const callbacks = await Promise.all(
    Array.from({ length: 10 }, () =>
      request('/payments/webhook/test-provider', {
        method: 'POST',
        headers: {
          'X-Payment-Timestamp': paymentTimestamp,
          'X-Payment-Signature': paymentSignature,
        },
        body: paymentBody,
      }),
    ),
  );
  const ticketCodes = new Set(callbacks.map((item) => item.body.ticket.code));
  assert(ticketCodes.size === 1, 'Concurrent payment callbacks issued multiple tickets');
  const ticket = callbacks[0].body.ticket;

  const secondRegistrationKey = `registration-second-${runId}`;
  const { body: secondCheckout } = await request('/registrations', {
    method: 'POST',
    headers: { 'Idempotency-Key': secondRegistrationKey },
    body: JSON.stringify({
      ...registrationPayload,
      attendee: {
        ...registrationPayload.attendee,
        name: '第二验收人',
        mobile: '13800138001',
        email: `acceptance-second-${runId}@example.com`,
      },
    }),
  });
  const conflictingPaymentBody = JSON.stringify({
    ...paymentCallback,
    orderId: secondCheckout.order.id,
    amount: secondCheckout.order.amount,
    currency: secondCheckout.order.currency,
    occurredAt: new Date().toISOString(),
  });
  const conflictingPaymentTimestamp = String(Date.now());
  const conflictingPaymentSignature = createHmac('sha256', paymentWebhookSecret)
    .update(`${conflictingPaymentTimestamp}.${conflictingPaymentBody}`)
    .digest('hex');
  await expectStatus('/payments/webhook/test-provider', 409, {
    method: 'POST',
    headers: {
      'X-Payment-Timestamp': conflictingPaymentTimestamp,
      'X-Payment-Signature': conflictingPaymentSignature,
    },
    body: conflictingPaymentBody,
  });

  const { body: deviceResult } = await request(`/admin/events/${eventId}/checkin-devices`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ deviceCode: `GATE_${runId.replaceAll('-', '_')}`, name: '验收核销机' }),
  });
  assert(deviceResult.token, 'Device token was not returned on registration');
  const batchKey = `offline-batch-${runId}`;
  const offlinePayload = {
    eventId,
    checkInListId: 'main-entrance',
    deviceCode: deviceResult.device.deviceCode,
    batchKey,
    records: [
      { localId: `local-${runId}`, ticketCode: ticket.code, checkedInAt: new Date().toISOString() },
    ],
  };
  await expectStatus('/admin/checkins/sync', 403, {
    method: 'POST',
    headers,
    body: JSON.stringify(offlinePayload),
  });
  await expectStatus('/admin/checkins/sync', 403, {
    method: 'POST',
    headers: authHeaders(token, { 'X-Device-Token': 'invalid-device-token' }),
    body: JSON.stringify(offlinePayload),
  });
  const { body: syncResult } = await request('/admin/checkins/sync', {
    method: 'POST',
    headers: authHeaders(token, { 'X-Device-Token': deviceResult.token }),
    body: JSON.stringify(offlinePayload),
  });
  assert(syncResult.accepted === 1, 'Offline check-in was not accepted');
  const { body: cachedSync } = await request('/admin/checkins/sync', {
    method: 'POST',
    headers: authHeaders(token, { 'X-Device-Token': deviceResult.token }),
    body: JSON.stringify(offlinePayload),
  });
  assert(cachedSync.cached === true, 'Offline batch retry was not served from idempotency cache');

  const { body: aiDraft } = await request('/admin/ai/generate', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      eventId,
      task: 'notification_body',
      brief: '生成一条准确的验收大会提醒',
      knowledge: ['时间为 2027 年 6 月 18 日', '地点为深圳国际会议中心'],
    }),
  });
  assert(aiDraft.status === 'draft', 'AI output did not enter draft review state');
  const { body: notificationTemplates } = await request('/admin/notification-templates', {
    headers,
  });
  const notificationPayload = {
    templateId: notificationTemplates[0].id,
    eventId,
    registrationId: checkout.registration.id,
    recipient: registrationPayload.attendee.email,
    variables: {
      attendeeName: registrationPayload.attendee.name,
      eventName: publicEvent.name,
      ticketCode: ticket.code,
    },
    aiRunId: aiDraft.id,
  };
  await expectStatus('/admin/notifications/queue', 409, {
    method: 'POST',
    headers,
    body: JSON.stringify(notificationPayload),
  });
  await request(`/admin/ai/runs/${aiDraft.id}/approve`, { method: 'POST', headers });
  const { body: delivery } = await request('/admin/notifications/queue', {
    method: 'POST',
    headers,
    body: JSON.stringify(notificationPayload),
  });

  let deliveryStatus = delivery.status;
  for (let attempt = 0; attempt < 20 && deliveryStatus !== 'sent'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { body: deliveries } = await request(
      `/admin/notification-deliveries?eventId=${eventId}`,
      {
        headers,
      },
    );
    deliveryStatus = deliveries.find((item) => item.id === delivery.id)?.status;
  }
  assert(deliveryStatus === 'sent', 'Notification worker did not complete delivery');

  const refundKey = `refund-${runId}`;
  const refundPayload = { amount: checkout.order.amount, reason: '自动化验收全额退款' };
  const { body: refund } = await request(`/admin/orders/${checkout.order.id}/refunds`, {
    method: 'POST',
    headers: authHeaders(token, { 'Idempotency-Key': refundKey }),
    body: JSON.stringify(refundPayload),
  });
  const { body: cachedRefund } = await request(`/admin/orders/${checkout.order.id}/refunds`, {
    method: 'POST',
    headers: authHeaders(token, { 'Idempotency-Key': refundKey }),
    body: JSON.stringify(refundPayload),
  });
  assert(cachedRefund.id === refund.id, 'Refund retry created another refund');
  await expectStatus(`/admin/orders/${checkout.order.id}/refunds`, 409, {
    method: 'POST',
    headers: authHeaders(token, { 'Idempotency-Key': refundKey }),
    body: JSON.stringify({ amount: 1, reason: '冲突退款内容' }),
  });

  const { body: csv } = await request(`/admin/events/${eventId}/registrations/export.csv`, {
    headers,
  });
  assert(
    csv.includes('# 导出用户 ID') &&
      csv.includes('# 数据范围') &&
      csv.includes('dietary_preference'),
    'Registration export watermark is missing',
  );
  const { body: auditLogs } = await request(`/admin/audit-logs?eventId=${eventId}`, { headers });
  assert(
    auditLogs.some((item) => item.action === 'registration.export'),
    'Export audit event is missing',
  );

  const freeSlug = `free-conference-${runId}`;
  const { body: freeEvent } = await request('/admin/events', {
    method: 'POST',
    headers: authHeaders(token, { 'Idempotency-Key': `free-event-create-${runId}` }),
    body: JSON.stringify({
      name: `免费报名验收大会 ${runId}`,
      shortName: '免费报名验收',
      slug: freeSlug,
      startsAt: '2027-08-18T01:00:00.000Z',
      endsAt: '2027-08-18T10:00:00.000Z',
      timezone: 'Asia/Shanghai',
      venue: '深圳创新中心',
      city: '深圳',
      address: '广东省深圳市南山区免费路 1 号',
      templateVersionId,
      blueprintId: blueprints[0].id,
    }),
  });
  testEventIds.push(freeEvent.id);
  const { body: freeEventDraft } = await request(`/admin/events/${freeEvent.id}`, { headers });
  for (const freeTicket of freeEventDraft.tickets) {
    await request(`/admin/events/${freeEvent.id}/ticket-types/${freeTicket.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ price: 0 }),
    });
  }
  await request(`/admin/events/${freeEvent.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      settings: {
        registration: {
          paymentMode: 'free',
          currency: 'CNY',
          registrationOpen: true,
          accountMode: 'guest_allowed',
        },
      },
    }),
  });
  const { body: freeForms } = await request(`/admin/events/${freeEvent.id}/registration-forms`, {
    headers,
  });
  const freeSourceForm = freeForms[0];
  await request(`/admin/events/${freeEvent.id}/registration-forms/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: freeSourceForm.name,
      fields: freeSourceForm.fields,
      termsVersion: freeSourceForm.termsVersion,
      termsContent: freeSourceForm.termsContent,
    }),
  });
  await request(`/admin/events/${freeEvent.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'prepublished' }),
  });
  await request(`/admin/events/${freeEvent.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'registration_open' }),
  });
  const { body: freePublicEvent } = await request(`/events/${freeSlug}`, {
    headers: { 'X-Organization-Slug': identity.organization.slug },
  });
  assert(
    freePublicEvent.registration.paymentMode === 'free',
    'Free registration mode was not released',
  );
  assert(
    freePublicEvent.tickets.every((item) => item.price === 0),
    'Free event release contains a paid ticket',
  );
  const { body: freeCheckout } = await request('/registrations', {
    method: 'POST',
    headers: { 'Idempotency-Key': `free-registration-${runId}` },
    body: JSON.stringify({
      eventId: freeEvent.id,
      ticketTypeId: freePublicEvent.tickets[0].id,
      attendee: {
        name: '免费报名验收人',
        mobile: '13900139000',
        email: `free-${runId}@example.com`,
        company: '免费报名验收实验室',
        title: '质量负责人',
        city: '深圳',
      },
      invoiceRequired: false,
      marketingConsent: true,
      termsAccepted: true,
      formVersion: freePublicEvent.registrationForm.version,
      termsVersion: freePublicEvent.registrationForm.termsVersion,
      formAnswers: {},
    }),
  });
  assert(freeCheckout.order.amount === 0, 'Free checkout created a non-zero order');
  assert(freeCheckout.order.status === 'paid', 'Free checkout order was not completed');
  assert(freeCheckout.registration.status === 'confirmed', 'Free registration was not confirmed');
  assert(freeCheckout.ticket?.code, 'Free registration did not issue a ticket');

  await request(`/admin/events/${eventId}/ticket-types/${temporaryTicket.id}/restore`, {
    method: 'POST',
    headers,
  });
  await request(`/admin/events/${eventId}/ticket-types/${releasedTicket.id}`, {
    method: 'DELETE',
    headers,
  });
  const { body: releasesAfterTicketArchive } = await request(`/admin/events/${eventId}/releases`, {
    headers,
  });
  const releaseAfterTicketArchive = releasesAfterTicketArchive[0];
  assert(
    releaseAfterTicketArchive.changeScope === 'ticket',
    'Ticket archive did not create a ticket-scoped change record',
  );
  const { body: publicAfterTicketArchive } = await request(`/events/${slug}`, {
    headers: { 'X-Organization-Slug': identity.organization.slug },
  });
  assert(
    !publicAfterTicketArchive.tickets.some((item) => item.id === releasedTicket.id),
    'Archived ticket remained in the next public release',
  );
  assert(publicAfterTicketArchive.tickets.length >= 1, 'Ticket replacement was not released');
  await request(`/admin/events/${eventId}/releases/${release1.id}/rollback`, {
    method: 'POST',
    headers,
  });
  const { body: publicAfterArchivedTicketRollback } = await request(`/events/${slug}`, {
    headers: { 'X-Organization-Slug': identity.organization.slug },
  });
  assert(
    publicAfterArchivedTicketRollback.tickets.some((item) => item.id === releasedTicket.id),
    'Rollback could not restore a previously archived ticket snapshot',
  );
  await request(`/admin/events/${eventId}/releases/${releaseAfterTicketArchive.id}/rollback`, {
    method: 'POST',
    headers,
  });

  await request(`/admin/events/${eventId}/speakers/${speaker.id}`, { method: 'DELETE', headers });
  await request(`/admin/events/${eventId}/sessions/${session.id}`, { method: 'DELETE', headers });
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
        releaseVersions: [release1.version, release2.version],
        formVersion: publishedForm.version,
        paymentCallbacks: callbacks.length,
        ticketCount: ticketCodes.size,
        offlineSync: { accepted: syncResult.accepted, cached: cachedSync.cached },
        ai: { draft: aiDraft.id, approved: true },
        notification: deliveryStatus,
        refund: refund.status,
        organization: {
          identity: identity.membership.role,
          invitationAccepted: acceptedMember.id,
          invitationCancelled: cancelledInvitation.id,
        },
        freeRegistration: {
          eventId: freeEvent.id,
          orderStatus: freeCheckout.order.status,
          ticket: freeCheckout.ticket.code,
        },
        auditEvents: auditLogs.length,
      },
      null,
      2,
    ),
  );
} finally {
  await cleanupTestEvents(testEventIds);
}
