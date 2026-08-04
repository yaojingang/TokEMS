import { createHash, createHmac } from 'node:crypto';
import { createDatabase } from '../packages/database/dist/index.js';
import { DEMO_EVENT } from '../packages/contracts/dist/index.js';

const apiBase = process.env.API_BASE ?? 'http://localhost:8088/api/v1';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for the persistent smoke test');
const paymentWebhookSecret = process.env.PAYMENT_WEBHOOK_SECRET;
if (!paymentWebhookSecret) {
  throw new Error('PAYMENT_WEBHOOK_SECRET is required for the persistent smoke test');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, init = {}) {
  const response = await fetch(`${apiBase}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${init.method ?? 'GET'} ${path} returned ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

const runId = crypto.randomUUID();
const registrationKey = `persistent-registration-${runId}`;
const paymentExternalId = `persistent-payment-${runId}`;
const paymentKey = `payment:test-provider:${paymentExternalId}`;
const attendeeName = `持久化测试-${runId.slice(0, 8)}`;
const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': registrationKey };
const registrationBody = {
  eventId: DEMO_EVENT.id,
  ticketTypeId: DEMO_EVENT.tickets[0].id,
  attendee: {
    name: attendeeName,
    mobile: `138${runId.replaceAll('-', '').slice(0, 8).replace(/[a-f]/g, '7')}`,
    email: `persistent-${runId.slice(0, 8)}@example.com`,
    company: '大会系统质量实验室',
    title: '端到端测试负责人',
    city: '深圳',
  },
  invoiceRequired: true,
  marketingConsent: true,
  termsAccepted: true,
};

const health = await request('/health');
assert(health.database?.mode === 'postgresql' && health.database?.ok, '健康检查未连接 PostgreSQL');

const login = await request('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: process.env.ADMIN_EMAIL ?? 'admin@tokems.local',
    password: process.env.ADMIN_PASSWORD ?? 'admin',
  }),
});
assert(
  typeof login.accessToken === 'string' && login.accessToken.length > 20,
  '后台登录未返回有效 Token',
);

const templateImage = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const templateImageDigest = createHash('sha256').update(templateImage).digest('hex');
const templateUpload = await request('/admin/template-assets/uploads', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${login.accessToken}`,
    'Idempotency-Key': `template-asset-upload-${runId}`,
  },
  body: JSON.stringify({
    fileName: `template-verification-${runId}.png`,
    mediaType: 'image/png',
    size: templateImage.byteLength,
    contentDigest: templateImageDigest,
    altText: '模板资源全链路验收图',
  }),
});
const templateUploadResponse = await fetch(templateUpload.uploadUrl, {
  method: 'PUT',
  headers: templateUpload.headers,
  body: templateImage,
});
assert(templateUploadResponse.ok, `模板图片上传失败：${templateUploadResponse.status}`);
const templateAsset = await request('/admin/template-assets', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${login.accessToken}`,
    'Idempotency-Key': `template-asset-create-${runId}`,
  },
  body: JSON.stringify({
    storageKey: templateUpload.storageKey,
    mediaType: 'image/png',
    size: templateImage.byteLength,
    width: 1,
    height: 1,
    contentDigest: templateImageDigest,
    altText: '模板资源全链路验收图',
  }),
});
assert(templateAsset.previewUrl, '模板资源登记后缺少预览地址');
const templateAssets = await request('/admin/template-assets', {
  headers: { Authorization: `Bearer ${login.accessToken}` },
});
assert(
  templateAssets.some((asset) => asset.id === templateAsset.id),
  '模板资源列表未返回新上传图片',
);
await request(`/admin/template-assets/${templateAsset.id}`, {
  method: 'DELETE',
  headers: {
    Authorization: `Bearer ${login.accessToken}`,
    'Idempotency-Key': `template-asset-delete-${runId}`,
  },
});
let templateObjectDeleted = false;
const templateDeleteDeadline = Date.now() + 15_000;
while (Date.now() < templateDeleteDeadline) {
  const deletedObject = await fetch(templateAsset.previewUrl);
  if (deletedObject.status === 404) {
    templateObjectDeleted = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert(templateObjectDeleted, '模板资源删除任务未清理对象存储文件');

const checkoutRetries = await Promise.all(
  Array.from({ length: 10 }, () =>
    request('/registrations', {
      method: 'POST',
      headers,
      body: JSON.stringify(registrationBody),
    }),
  ),
);
const firstCheckout = checkoutRetries[0];
const repeatedCheckout = checkoutRetries[9];
assert(
  firstCheckout.registration.id === repeatedCheckout.registration.id,
  '报名幂等重试生成了不同报名',
);
assert(firstCheckout.order.id === repeatedCheckout.order.id, '报名幂等重试生成了不同订单');
assert(firstCheckout.orderAccessToken, '报名结果未返回订单访问凭证');
assert(
  new Set(checkoutRetries.map((checkout) => checkout.orderAccessToken)).size ===
    checkoutRetries.length,
  '报名幂等重试复用了同一明文访问凭证',
);
const unauthorizedOrder = await fetch(`${apiBase}/orders/${firstCheckout.order.id}`);
assert(unauthorizedOrder.status === 401, '缺少访问凭证时仍然可以读取订单');
const authorizedOrder = await request(`/orders/${firstCheckout.order.id}`, {
  headers: { Authorization: `Bearer ${firstCheckout.orderAccessToken}` },
});
assert(authorizedOrder.id === firstCheckout.order.id, '有效访问凭证未能读取订单');

const paymentCallback = {
  orderId: firstCheckout.order.id,
  externalId: paymentExternalId,
  status: 'succeeded',
  amount: firstCheckout.order.amount,
  currency: firstCheckout.order.currency,
  occurredAt: new Date().toISOString(),
};
const paymentBody = JSON.stringify(paymentCallback);
const paymentTimestamp = String(Date.now());
const paymentSignature = createHmac('sha256', paymentWebhookSecret)
  .update(`${paymentTimestamp}.${paymentBody}`)
  .digest('hex');
const paymentRetries = await Promise.all(
  Array.from({ length: 10 }, () =>
    request('/payments/webhook/test-provider', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment-Timestamp': paymentTimestamp,
        'X-Payment-Signature': paymentSignature,
      },
      body: paymentBody,
    }),
  ),
);
const firstPayment = paymentRetries[0];
const repeatedPayment = paymentRetries[9];
assert(firstPayment.order.status === 'paid', '订单未进入已支付状态');
assert(firstPayment.ticket.code === repeatedPayment.ticket.code, '支付重试签发了不同电子票');
assert(firstPayment.invoice?.accessToken, '支付成功后未生成发票访问凭证');
assert(
  new Set(paymentRetries.map((payment) => payment.invoice?.accessToken)).size ===
    paymentRetries.length,
  '支付幂等重试复用了同一明文发票凭证',
);

const invoiceBuyer = {
  buyerType: 'company',
  title: '大会系统质量实验室',
  taxId: '91440300TEST202607',
  email: registrationBody.attendee.email,
  mobile: registrationBody.attendee.mobile,
  content: '会务费',
};
const submittedInvoice = await request(`/orders/${firstCheckout.order.id}/invoice-request`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${firstPayment.invoice.accessToken}`,
  },
  body: JSON.stringify(invoiceBuyer),
});
assert(submittedInvoice.status === 'pending_review', '发票资料提交后未进入待审核');

const invoiceAdminHeaders = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${login.accessToken}`,
  'Idempotency-Key': `invoice-approve-${runId}`,
};
const invoiceAdminBase = `/admin/events/${DEMO_EVENT.id}/invoices`;
const approvedInvoice = await request(`${invoiceAdminBase}/${firstPayment.invoice.id}/approve`, {
  method: 'POST',
  headers: invoiceAdminHeaders,
  body: JSON.stringify({ expectedUpdatedAt: submittedInvoice.updatedAt }),
});
assert(approvedInvoice.status === 'issuing', '发票审核通过后未进入开具中');

const invoiceFile = Buffer.from('%PDF-1.4\n% TokEMS invoice verification\n%%EOF\n');
const invoiceDigest = createHash('sha256').update(invoiceFile).digest('hex');
const upload = await request(`${invoiceAdminBase}/${firstPayment.invoice.id}/document-uploads`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${login.accessToken}`,
    'Idempotency-Key': `invoice-upload-${runId}`,
  },
  body: JSON.stringify({
    fileName: `invoice-${runId}.pdf`,
    mediaType: 'application/pdf',
    size: invoiceFile.byteLength,
    contentDigest: invoiceDigest,
  }),
});
const uploadResponse = await fetch(upload.uploadUrl, {
  method: 'PUT',
  headers: upload.headers,
  body: invoiceFile,
});
assert(uploadResponse.ok, `电子发票文件上传失败：${uploadResponse.status}`);

const issuedInvoice = await request(`${invoiceAdminBase}/${firstPayment.invoice.id}/documents`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${login.accessToken}`,
    'Idempotency-Key': `invoice-document-${runId}`,
  },
  body: JSON.stringify({
    documentType: 'original',
    invoiceNumber: `INV-${runId.slice(0, 8)}`,
    storageKey: upload.storageKey,
    mediaType: 'application/pdf',
    size: invoiceFile.byteLength,
    contentDigest: invoiceDigest,
  }),
});
assert(issuedInvoice.status === 'issued', '登记发票文件后未进入已开具');
assert(issuedInvoice.documents.length === 1, '已开具发票缺少文件记录');

const attendeeInvoice = await request(`/orders/${firstCheckout.order.id}/invoice-request`, {
  headers: { Authorization: `Bearer ${firstPayment.invoice.accessToken}` },
});
assert(attendeeInvoice.status === 'issued', '参会人端未读取到已开具状态');
assert(attendeeInvoice.documents[0]?.downloadUrl, '参会人端缺少安全下载链接');
const invoiceDownload = await fetch(`${apiBase}${attendeeInvoice.documents[0].downloadUrl}`);
assert(invoiceDownload.ok, `发票下载失败：${invoiceDownload.status}`);
assert(
  Buffer.from(await invoiceDownload.arrayBuffer()).equals(invoiceFile),
  '下载的发票文件与上传内容不一致',
);

const invoiceExportResponse = await fetch(`${apiBase}${invoiceAdminBase}/export.csv`, {
  headers: {
    Authorization: `Bearer ${login.accessToken}`,
    'Idempotency-Key': `invoice-export-${runId}`,
  },
});
assert(invoiceExportResponse.ok, `发票导出请求失败：${invoiceExportResponse.status}`);
let invoiceExportMode = 'direct';
let invoiceExportCsv;
if (invoiceExportResponse.status === 202) {
  invoiceExportMode = 'worker';
  let exportJob = await invoiceExportResponse.json();
  const exportDeadline = Date.now() + 30_000;
  while (Date.now() < exportDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    exportJob = await request(`${invoiceAdminBase}/export-jobs/${exportJob.id}`, {
      headers: { Authorization: `Bearer ${login.accessToken}` },
    });
    if (exportJob.status === 'ready' && exportJob.downloadPath) break;
    if (exportJob.status === 'failed') {
      throw new Error(`发票导出 Worker 任务失败：${exportJob.error}`);
    }
  }
  assert(exportJob.downloadPath, '发票导出 Worker 未在时限内生成下载链接');
  const exportDownload = await fetch(`${apiBase}${exportJob.downloadPath}`, {
    headers: { Authorization: `Bearer ${login.accessToken}` },
  });
  assert(exportDownload.ok, `发票导出文件下载失败：${exportDownload.status}`);
  invoiceExportCsv = await exportDownload.text();
} else {
  invoiceExportCsv = await invoiceExportResponse.text();
}
assert(invoiceExportCsv.includes(firstPayment.invoice.requestNo), '发票导出文件缺少本次申请记录');

const ticket = await request(`/tickets/${firstPayment.ticket.code}`);
assert(ticket.registrationId === firstCheckout.registration.id, '电子票与报名关联不一致');

const checkInBody = {
  eventId: DEMO_EVENT.id,
  ticketCode: firstPayment.ticket.code,
  checkInListId: 'main-entrance',
  deviceId: `persistent-${runId.slice(0, 8)}`,
};
const firstCheckIn = await request('/checkins', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
  body: JSON.stringify(checkInBody),
});
const repeatedCheckIn = await request('/checkins', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` },
  body: JSON.stringify(checkInBody),
});
assert(firstCheckIn.result === 'accepted', '首次核销未被接受');
assert(repeatedCheckIn.result === 'duplicate', '重复核销未返回 duplicate');

const authHeaders = { Authorization: `Bearer ${login.accessToken}` };
const [dashboard, registrations, orders] = await Promise.all([
  request(`/admin/dashboard?eventId=${DEMO_EVENT.id}`, { headers: authHeaders }),
  request(`/admin/registrations?eventId=${DEMO_EVENT.id}&q=${encodeURIComponent(attendeeName)}`, {
    headers: authHeaders,
  }),
  request(`/admin/orders?eventId=${DEMO_EVENT.id}&q=${encodeURIComponent(attendeeName)}`, {
    headers: authHeaders,
  }),
]);
assert(dashboard.metrics.checkedIn >= 1, '后台指标未反映核销记录');
assert(registrations.total === 1 && registrations.items.length === 1, '后台报名搜索未找到新参会人');
assert(orders.total === 1 && orders.items.length === 1, '后台订单搜索未找到新订单');

const { pool } = createDatabase(databaseUrl);
try {
  const invariantRows = await pool.query(
    `select
       (select count(*)::int from registrations where id = $1) as registrations,
       (select count(*)::int from orders where registration_id = $1) as orders,
       (select count(*)::int from tickets where registration_id = $1) as tickets,
       (select count(*)::int from checkin_records where ticket_id = $2) as checkins`,
    [firstCheckout.registration.id, firstPayment.ticket.id],
  );
  const invariants = invariantRows.rows[0];
  assert(invariants.registrations === 1, '数据库中的报名数量异常');
  assert(invariants.orders === 1, '数据库中的订单数量异常');
  assert(invariants.tickets === 1, '数据库中的电子票数量异常');
  assert(invariants.checkins === 1, '数据库中的成功核销数量异常');
  const idempotencyRows = await pool.query(
    `select scope, response_body
     from idempotency_keys
     where (scope = 'registration:create' and key = $1)
        or (scope = 'payment:confirm' and key = $2)`,
    [registrationKey, paymentKey],
  );
  assert(idempotencyRows.rows.length === 2, '报名或支付幂等记录缺失');
  assert(
    idempotencyRows.rows.every(
      (row) =>
        !JSON.stringify(row.response_body).includes('accessToken') &&
        !JSON.stringify(row.response_body).includes('orderAccessToken'),
    ),
    '幂等响应中仍保留可直接使用的明文访问凭证',
  );

  const deadline = Date.now() + 10_000;
  let published = [];
  while (Date.now() < deadline) {
    const result = await pool.query(
      `select event_type, published_at
       from outbox_events
       where correlation_id in ($1, $2)
          or payload->>'ticketId' = $3`,
      [registrationKey, paymentKey, firstPayment.ticket.id],
    );
    published = result.rows;
    if (published.length >= 4 && published.every((row) => row.published_at)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(published.length >= 4, 'Outbox 未写入完整的报名、支付、票证与核销事件');
  assert(
    published.every((row) => row.published_at),
    'Worker 未在时限内投递全部 Outbox 事件',
  );

  console.info(
    JSON.stringify(
      {
        health: health.database,
        registrationId: firstCheckout.registration.id,
        orderId: firstCheckout.order.id,
        ticketCode: firstPayment.ticket.code,
        invoice: {
          id: firstPayment.invoice.id,
          status: attendeeInvoice.status,
          downloadVerified: true,
          exportMode: invoiceExportMode,
        },
        templateAsset: {
          uploadVerified: true,
          deletionVerified: true,
        },
        idempotency: 'pass',
        registrationRetries: checkoutRetries.length,
        paymentRetries: paymentRetries.length,
        firstCheckIn: firstCheckIn.result,
        repeatedCheckIn: repeatedCheckIn.result,
        databaseInvariants: invariants,
        outbox: published.map((row) => ({
          eventType: row.event_type,
          published: Boolean(row.published_at),
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
