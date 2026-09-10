import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  invoiceDocumentAccessLinks,
  invoiceTokenHash,
  newInvoiceFileToken,
  organizationIntegrations,
  invoiceSmsFingerprint,
  notificationDeliveries,
  invoiceFileIdentity,
  invoiceSmsScope,
  invalidateInvoiceFileAccess,
  queueInvoiceSms,
  prepareInvoiceFileLink,
} from '@conference/database';
import { encryptIntegrationCredentials, redactInvoiceFilePath } from '@conference/security';
import { readAliyunSmsConfiguration } from '@conference/integrations';
import { UpdateAliyunSmsConfigurationSchema } from '@conference/contracts';
import { InvoiceFileController } from '../modules/invoice-file.module.js';
import { InvoiceFileService, invoiceSamplePdf } from './invoice-file.service.js';
import { DatabaseService } from './database.service.js';
import { AliyunSmsService } from './aliyun-sms.service.js';
import { InvoiceOperationsService } from './invoice-operations.service.js';
import { OrganizationAdminService } from './organization-admin.service.js';
import type { CreateInvoiceDocument } from '@conference/contracts';

const integration = process.env.INVOICE_SMS_TEST_DATABASE_URL ? describe : describe.skip;
integration('invoice SMS settings and anonymous PDF HTTP contract', () => {
  let admin: ReturnType<typeof createDatabase>,
    connection: ReturnType<typeof createDatabase>,
    app: NestFastifyApplication,
    service: AliyunSmsService;
  const name = `invoice_api_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  beforeAll(async () => {
    vi.stubEnv('PUBLIC_ORIGIN', 'http://localhost:8088');
    vi.stubEnv('NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET', 'invoice-tests-only-32-characters-secret');
    vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    for (const key of ['NOTIFICATION_WEBHOOK_URL', 'SMTP_URL', 'RESEND_API_KEY'])
      vi.stubEnv(key, '');
    for (const [key, value] of Object.entries({
      S3_ENDPOINT: 'http://storage.invalid',
      S3_ACCESS_KEY: 'test-key',
      S3_SECRET_KEY: 'test-secret',
      S3_BUCKET: 'private-test',
    }))
      vi.stubEnv(key, value);
    admin = createDatabase(process.env.INVOICE_SMS_TEST_DATABASE_URL!);
    await admin.pool.query(`create database "${name}"`);
    created = true;
    const url = new URL(process.env.INVOICE_SMS_TEST_DATABASE_URL!);
    url.pathname = `/${name}`;
    connection = createDatabase(url.toString());
    for (const migration of readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL('../../../../packages/database/drizzle', import.meta.url),
      ),
    })) {
      const client = await connection.pool.connect();
      await client.query('BEGIN');
      try {
        for (const statement of migration.sql) if (statement.trim()) await client.query(statement);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    const module = await Test.createTestingModule({
      controllers: [InvoiceFileController],
      providers: [
        InvoiceFileService,
        AliyunSmsService,
        { provide: DatabaseService, useValue: { db: connection.db } },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    service = module.get(AliyunSmsService);
  }, 90_000);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await app?.close();
    await connection?.pool.end();
    if (created) await admin.pool.query(`drop database "${name}"`);
    await admin?.pool.end();
    vi.unstubAllEnvs();
  });
  async function fixture(sample = false) {
    const org = randomUUID(),
      actor = randomUUID(),
      customer = randomUUID(),
      order = randomUUID(),
      invoice = randomUUID(),
      doc = randomUUID();
    const event = 10000 + Math.floor(Math.random() * 100000000),
      pool = connection.pool,
      db = connection.db;
    await pool.query(
      "insert into organizations(id,slug,name) values($1::uuid,$1::text,'Invoice test')",
      [org],
    );
    await pool.query("insert into users(id,email,name) values($1::uuid,$1::text,'Test admin')", [
      actor,
    ]);
    const token = newInvoiceFileToken(),
      bytes = invoiceSamplePdf();
    if (!sample) {
      await pool.query(
        `insert into events(id,organization_id,slug,name,short_name,tagline,description,starts_at,ends_at,timezone,venue,city,address)
        values($1,$2,'invoice-test','测试大会','测试','','',now(),now(),'UTC','','','')`,
        [event, org],
      );
      await pool.query(
        "insert into customer_users(id,organization_id,mobile_e164) values($1,$2,'+8613800138000')",
        [customer, org],
      );
      const ticketType = randomUUID();
      await pool.query(
        "insert into ticket_types(id,organization_id,event_id,code,name,description,price,capacity) values($1,$2,$3,'test','Test','',50,100)",
        [ticketType, org, event],
      );
      const seed = await pool.connect();
      await seed.query('BEGIN');
      try {
        await seed.query(
          `insert into orders(id,organization_id,event_id,registration_id,order_no,amount,currency,pricing_snapshot,expires_at,purchaser_customer_user_id,purchaser_snapshot,status,model_version,quantity,purchase_intent_id)
        values($1::uuid,$2,$3,null,$1::text,100,'CNY','{}',now(),$4,$5,'paid',2,2,gen_random_uuid())`,
          [
            order,
            org,
            event,
            customer,
            JSON.stringify({ customerUserId: customer, mobile: '+8613800138000' }),
          ],
        );
        for (let position = 1; position <= 2; position++) {
          const registration = randomUUID();
          await seed.query(
            "insert into registrations(id,organization_id,event_id,ticket_type_id,registration_code,attendee) values($1::uuid,$2,$3,$4,$1::text,'{}')",
            [registration, org, event, ticketType],
          );
          await seed.query(
            "insert into order_items(order_id,registration_id,organization_id,event_id,client_id,position,ticket_type_id,unit_price,allocated_amount,pricing_snapshot) values($1,$2,$3,$4,gen_random_uuid(),$5,$6,50,50,'{}')",
            [order, registration, org, event, position, ticketType],
          );
        }
        await seed.query('COMMIT');
      } catch (error) {
        await seed.query('ROLLBACK');
        throw error;
      } finally {
        seed.release();
      }

      await pool.query(
        `insert into invoice_requests(id,request_no,organization_id,event_id,order_id,registration_id,amount,net_paid_amount,status)
        values($1::uuid,$1::text,$2,$3,$4,null,100,100,'issued')`,
        [invoice, org, event, order],
      );
      await pool.query(
        `insert into invoice_documents(id,invoice_request_id,invoice_number,storage_key,media_type,size,content_digest)
        values($1::uuid,$2,$1::text,$3,'application/pdf',$4,$5)`,
        [
          doc,
          invoice,
          `invoices/${org}/${invoice}/test.pdf`,
          bytes.length,
          createHash('sha256').update(bytes).digest('hex'),
        ],
      );
    }
    const identity = sample
      ? null
      : invoiceFileIdentity((await invoiceSmsScope(db, invoice)).document!);
    const [link] = await db
      .insert(invoiceDocumentAccessLinks)
      .values({
        organizationId: org,
        purpose: sample ? 'test' : 'invoice',
        recipientHash: invoiceTokenHash('+8613800138000'),
        tokenHash: invoiceTokenHash(token),
        expiresAt: new Date(Date.now() + 86400000),
        ...(sample
          ? {}
          : {
              eventId: event,
              orderId: order,
              invoiceRequestId: invoice,
              invoiceDocumentId: doc,
              documentIdentity: identity,
            }),
      })
      .returning();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: unknown, init?: RequestInit) => {
        const range = new Headers(init?.headers).get('Range');
        if (range) {
          const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
          const payload = bytes.subarray(Number(start), Number(end) + 1);
          return new Response(payload, {
            status: 206,
            headers: {
              'content-type': 'application/pdf',
              'content-length': String(payload.length),
              'content-range': `bytes ${start}-${end}/${bytes.length}`,
            },
          });
        }
        return new Response(bytes, {
          headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) },
        });
      }),
    );
    return {
      org,
      actor,
      customer,
      order,
      invoice,
      doc,
      db,
      pool,
      token,
      bytes,
      link: link!,
      url: `/api/v1/invoice-files/${token}`,
    };
  }
  async function enableSms(f: Awaited<ReturnType<typeof fixture>>) {
    const config = readAliyunSmsConfiguration({
      enabled: true,
      signName: '测试签名',
      templates: { invoiceReady: { enabled: true, templateCode: 'SMS_TEST' } },
    });
    config.invoiceSms.deliveryMode = 'direct_file_v1';
    config.invoiceSms.activationRevision = 1;
    const [row] = await f.db
      .insert(organizationIntegrations)
      .values({
        organizationId: f.org,
        provider: 'aliyun-sms',
        config,
        encryptedCredentials: encryptIntegrationCredentials(f.org, 'aliyun-sms', {
          accessKeyId: 'test-key',
          accessKeySecret: 'test-secret',
        }),
        keyVersion: 1,
      })
      .returning();
    const fingerprint = invoiceSmsFingerprint(row!);
    const [proof] = await f.db
      .insert(notificationDeliveries)
      .values({
        organizationId: f.org,
        channel: 'sms',
        recipient: '+8613800138000',
        subject: 'sample',
        body: 'sample',
        purpose: 'invoice_test',
        status: 'delivered',
        fileReachable: true,
        configurationFingerprint: fingerprint,
      })
      .returning();
    config.invoiceSms = {
      ...config.invoiceSms,
      verifiedFingerprint: fingerprint,
      verifiedOrigin: 'http://localhost:8088',
      testDeliveryId: proof!.id,
    };
    await f.db
      .update(organizationIntegrations)
      .set({ config })
      .where(eq(organizationIntegrations.id, row!.id));
  }
  it('only accepts the current organization test proof for the settings status endpoint', async () => {
    const f = await fixture(true);
    await enableSms(f);
    const current = await service.getConfiguration(f.org);
    expect(
      await service.invoiceTestStatus(f.org, current.invoiceSms.testDeliveryId!),
    ).toMatchObject({ ready: true, fileReachable: true, status: 'delivered' });
    await expect(
      service.invoiceTestStatus(randomUUID(), current.invoiceSms.testDeliveryId!),
    ).rejects.toThrow('不存在');
    await expect(service.invoiceTestStatus(f.org, 'invalid-id')).rejects.toThrow('不存在');
  });
  it('recognizes a valid invoice proof in read-only integration status while honoring the switch', async () => {
    const f = await fixture(true);
    await enableSms(f);
    await f.pool.query(
      "update organization_integrations set status='configured' where organization_id=$1 and provider='aliyun-sms'",
      [f.org],
    );
    const organization = new OrganizationAdminService({ db: f.db } as DatabaseService);
    expect((await service.getConfiguration(f.org)).status).toBe('verified');
    expect((await organization.getIntegrationStatus(f.org)).notification.configured).toBe(true);
    const row = (
      await f.db
        .select()
        .from(organizationIntegrations)
        .where(eq(organizationIntegrations.organizationId, f.org))
    )[0]!;
    expect(row.status).toBe('configured');
    const config = readAliyunSmsConfiguration(row.config);
    expect(config.templates.invoiceReady.status).toBe('unverified');
    config.templates.invoiceReady.enabled = false;
    await f.db
      .update(organizationIntegrations)
      .set({ config })
      .where(eq(organizationIntegrations.id, row.id));
    expect((await service.getConfiguration(f.org)).status).toBe('verified');
    expect((await organization.getIntegrationStatus(f.org)).notification.configured).toBe(false);
  });
  it('does not display invoice verification from incomplete or stale proof fields', async () => {
    const f = await fixture(true);
    await enableSms(f);
    await f.pool.query(
      "update organization_integrations set status='configured' where organization_id=$1 and provider='aliyun-sms'",
      [f.org],
    );
    const row = (
      await f.db
        .select()
        .from(organizationIntegrations)
        .where(eq(organizationIntegrations.organizationId, f.org))
    )[0]!;
    const proofId = readAliyunSmsConfiguration(row.config).invoiceSms.testDeliveryId!;
    const organization = new OrganizationAdminService({ db: f.db } as DatabaseService);
    for (const patch of [
      {
        status: 'accepted',
        fileReachable: true,
        configurationFingerprint: invoiceSmsFingerprint(row),
      },
      {
        status: 'delivered',
        fileReachable: false,
        configurationFingerprint: invoiceSmsFingerprint(row),
      },
      { status: 'delivered', fileReachable: true, configurationFingerprint: 'stale-proof' },
    ]) {
      await f.db
        .update(notificationDeliveries)
        .set(patch)
        .where(eq(notificationDeliveries.id, proofId));
      expect((await service.getConfiguration(f.org)).status).toBe('configured');
      expect((await organization.getIntegrationStatus(f.org)).notification.configured).toBe(false);
    }
    const legacyConfig = readAliyunSmsConfiguration(row.config);
    legacyConfig.templates.invoiceReady.status = 'verified';
    await f.db
      .update(organizationIntegrations)
      .set({ status: 'verified', config: legacyConfig })
      .where(eq(organizationIntegrations.id, row.id));
    expect((await organization.getIntegrationStatus(f.org)).notification.configured).toBe(false);
  });
  it('streams a 20 MiB file with backpressure and cancels the upstream when closed early', async () => {
    const f = await fixture(),
      bytes = Buffer.alloc(20 * 1024 * 1024, 32);
    bytes.write('%PDF-1.4');
    await f.pool.query('update invoice_documents set size=$1,content_digest=$2 where id=$3', [
      bytes.length,
      createHash('sha256').update(bytes).digest('hex'),
      f.doc,
    ]);
    const scope = await invoiceSmsScope(f.db, f.invoice);
    await f.db
      .update(invoiceDocumentAccessLinks)
      .set({ documentIdentity: invoiceFileIdentity(scope.document!) })
      .where(eq(invoiceDocumentAccessLinks.id, f.link.id));
    let offset = 0,
      cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                const end = Math.min(offset + 65536, bytes.length);
                controller.enqueue(bytes.subarray(offset, end));
                offset = end;
                if (offset === bytes.length) controller.close();
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'content-length': String(bytes.length) } },
          ),
      ),
    );
    const files = app.get(InvoiceFileService),
      source = await files.read(f.token, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(offset).toBeLessThan(bytes.length / 10);
    source.stream.destroy();
    await vi.waitFor(() => expect(cancelled).toBe(true));
    offset = 0;
    const complete = await files.read(f.token, new AbortController().signal);
    let read = 0;
    for await (const chunk of complete.stream) read += (chunk as Buffer).length;
    expect(read).toBe(bytes.length);
  });
  it('returns PDF without login, with no redirect, scripts, cookies or caching', async () => {
    const f = await fixture();
    const response = await app.inject({ method: 'GET', url: f.url });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(f.bytes)).toBe(true);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toContain('inline');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-robots-tag']).toContain('noindex');
    expect(response.headers['set-cookie']).toBeUndefined();
  });
  it('closes the upstream if recording access fails before handing the stream to HTTP', async () => {
    const f = await fixture();
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-length': String(f.bytes.length) } },
        ),
      ),
    );
    const files = app.get(InvoiceFileService);
    const read = vi.spyOn(files, 'read');
    vi.spyOn(files, 'recordAccess').mockRejectedValueOnce(new Error('Audit unavailable'));
    try {
      const response = await app.inject({ url: f.url });
      expect(response.statusCode).toBe(503);
      expect(read).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(cancelled).toBe(true));
    } finally {
      const source = await read.mock.results[0]?.value;
      source?.stream.destroy();
    }
  });
  it('serves byte ranges and HEAD metadata, rejecting multiple and unsatisfiable ranges', async () => {
    const f = await fixture();
    const range = await app.inject({ url: f.url, headers: { range: 'bytes=0-4' } });
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe('%PDF-');
    expect(
      new Headers((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers).get('Range'),
    ).toBe('bytes=0-4');
    const head = await app.inject({ method: 'HEAD', url: f.url });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(Number(head.headers['content-length'])).toBe(f.bytes.length);
    for (const value of ['bytes=0-2,4-6', 'bytes=999999-', 'bytes=-0']) {
      const response = await app.inject({ url: f.url, headers: { range: value } });
      expect(response.statusCode).toBe(416);
      expect(response.headers['content-range']).toBe(`bytes */${f.bytes.length}`);
    }
  });
  it('keeps an existing invoice accessible during review and pauses approved refund execution', async () => {
    const f = await fixture(),
      payment = randomUUID(),
      refund = randomUUID();
    await f.pool.query(
      "insert into payments(id,order_id,provider,status,amount,currency) values($1,$2,'test','succeeded',100,'CNY')",
      [payment, f.order],
    );
    await f.pool.query(
      "insert into refund_requests(id,organization_id,event_id,order_id,payment_id,source,amount,currency,reserved_amount,reason,policy_snapshot,business_snapshot,idempotency_key,request_hash) values($1::uuid,$2,$3,$4,$5,'customer',100,'CNY',100,'test','{}','{}',$1::text,$1::text)",
      [refund, f.org, f.link.eventId, f.order, payment],
    );
    expect((await app.inject({ url: f.url })).statusCode).toBe(200);
    await f.pool.query("update refund_requests set review_status='approved' where id=$1", [refund]);
    const paused = await app.inject({ url: f.url });
    expect(paused.statusCode).toBe(409);
    expect(paused.body).toContain('发票正在处理中');
    await f.pool.query(
      "update refund_requests set review_status='rejected',terminated_at=now() where id=$1",
      [refund],
    );
    expect((await app.inject({ url: f.url })).statusCode).toBe(200);
    const audit = await f.pool.query(
      "select after from audit_logs where resource_id=$1 and action='invoice.file.access'",
      [f.link.id],
    );
    expect(audit.rows.length).toBe(2);
    expect(JSON.stringify(audit.rows)).not.toContain(f.token);
  });
  it('rejects restoring a legacy voided invoice during pending refund review', async () => {
    const f = await fixture(),
      payment = randomUUID(),
      refund = randomUUID();
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('delete from order_items where order_id=$1 and position=2', [f.order]);
      await client.query(
        'update orders set model_version=1,quantity=1,registration_id=(select registration_id from order_items where order_id=$1 limit 1) where id=$1',
        [f.order],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await f.pool.query("update invoice_requests set status='voided' where id=$1", [f.invoice]);
    await f.pool.query('update invoice_documents set voided_at=now() where id=$1', [f.doc]);
    await f.pool.query(
      "insert into payments(id,order_id,provider,status,amount,currency) values($1,$2,'test','succeeded',100,'CNY')",
      [payment, f.order],
    );
    await f.pool.query(
      "insert into refund_requests(id,organization_id,event_id,order_id,payment_id,source,amount,currency,reserved_amount,reason,policy_snapshot,business_snapshot,idempotency_key,request_hash) values($1::uuid,$2,$3,$4,$5,'customer',100,'CNY',100,'test','{}','{}',$1::text,$1::text)",
      [refund, f.org, f.link.eventId, f.order, payment],
    );
    const operation = new InvoiceOperationsService({ db: f.db } as DatabaseService),
      scope = await invoiceSmsScope(f.db, f.invoice);
    await expect(
      operation.replaceDocumentFile(
        f.org,
        f.invoice,
        f.doc,
        f.actor,
        {
          expectedUpdatedAt: scope.invoice.updatedAt.toISOString(),
          reason: '恢复测试发票',
          storageKey: `invoices/${f.org}/${f.invoice}/restored.pdf`,
          mediaType: 'application/pdf',
          size: f.bytes.length,
          contentDigest: createHash('sha256').update(f.bytes).digest('hex'),
        },
        f.link.eventId!,
      ),
    ).rejects.toThrow('退款申请');
    expect((await invoiceSmsScope(f.db, f.invoice)).invoice.status).toBe('voided');
  });
  it('keeps the settled invoice amount when an extra successful payment is returned', async () => {
    const f = await fixture(),
      settled = randomUUID(),
      extra = randomUUID(),
      refund = randomUUID();
    await f.pool.query(
      "insert into payments(id,order_id,provider,status,amount,currency,succeeded_at) values($1,$3,'test','succeeded',100,'CNY',now()),($2,$3,'test','refunded',200,'CNY',now())",
      [settled, extra, f.order],
    );
    await f.pool.query('update orders set settled_payment_id=$1 where id=$2', [settled, f.order]);
    await f.pool.query(
      "insert into refunds(id,organization_id,event_id,order_id,payment_id,refund_no,amount,currency,status,reason,idempotency_key) values($1::uuid,$2,$3,$4,$5,$1::text,200,'CNY','succeeded','extra return',$1::text)",
      [refund, f.org, f.link.eventId, f.order, extra],
    );
    const operation = new InvoiceOperationsService({ db: f.db } as DatabaseService);
    const [row] = await operation.exportRows(f.org, {});
    expect(row).toMatchObject({ paidAmount: 100, refundedAmount: 0, invoiceAmount: 100 });
    const context = await operation.customerOrderInvoiceContext(f.org, f.customer, f.order);
    expect(context.eligibleAmount).toBe(100);
  });
  it('keeps preview robots from consuming a sample credential', async () => {
    const f = await fixture(true);
    for (let i = 0; i < 2; i++)
      expect((await app.inject({ method: 'HEAD', url: f.url })).statusCode).toBe(200);
    expect((await app.inject({ url: f.url })).rawPayload.equals(f.bytes)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects revoked, expired, guessed and replaced capabilities without exposing token paths', async () => {
    const f = await fixture();
    await f.db.transaction((tx) => invalidateInvoiceFileAccess(tx, f.invoice));
    const revoked = await app.inject({ url: f.url });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.body).not.toContain(f.token);
    expect(revoked.body).not.toContain('<script');
    const expired = await fixture(true);
    await expired.db
      .update(invoiceDocumentAccessLinks)
      .set({ expiresAt: new Date(0) })
      .where(eq(invoiceDocumentAccessLinks.id, expired.link.id));
    expect((await app.inject({ url: expired.url })).statusCode).toBe(404);
    const changed = await fixture();
    await changed.pool.query(
      "update invoice_documents set content_digest=repeat('f',64) where id=$1",
      [changed.doc],
    );
    expect((await app.inject({ url: changed.url })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/v1/invoice-files/123' })).statusCode).toBe(404);
    expect(redactInvoiceFilePath(f.url)).not.toContain(f.token);
  });
  it('rejects a cross-invoice link and mismatched stored bytes', async () => {
    const f = await fixture(),
      other = await fixture();
    await f.db
      .update(invoiceDocumentAccessLinks)
      .set({ invoiceDocumentId: other.doc })
      .where(eq(invoiceDocumentAccessLinks.id, f.link.id));
    expect((await app.inject({ url: f.url })).statusCode).toBe(404);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('corrupted', { headers: { 'content-length': '9' } })),
    );
    const failed = await app.inject({ url: other.url });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('storage');
  });
  it('saves disabled templates, rejects enabling without delivery proof, and enforces configuration versions', async () => {
    const f = await fixture(true),
      defaults = readAliyunSmsConfiguration({}).templates;
    for (const template of Object.values(defaults)) template.enabled = false;
    defaults.invoiceReady.templateCode = 'SMS_TEST';
    const input = UpdateAliyunSmsConfigurationSchema.parse({
      enabled: true,
      signName: '发票测试',
      accessKeyId: 'test-access-key-id',
      accessKeySecret: 'test-access-key-secret',
      templates: defaults,
      invoiceDeliveryMode: 'direct_file_v1',
      expectedUpdatedAt: null,
    });
    const saved = await service.updateConfiguration(f.org, f.actor, input);
    expect(saved.templates.invoiceReady.enabled).toBe(false);
    await expect(service.updateConfiguration(f.org, f.actor, input)).rejects.toThrow('已被更新');
    await expect(
      service.updateConfiguration(f.org, f.actor, {
        ...input,
        accessKeyId: undefined,
        accessKeySecret: undefined,
        expectedUpdatedAt: saved.updatedAt,
        templates: {
          ...saved.templates,
          invoiceReady: { ...saved.templates.invoiceReady, enabled: true },
        },
      }),
    ).rejects.toThrow('重新验证');
  });
  it.each([false, true])(
    'registers a file atomically with the expected notification state (enabled=%s)',
    async (enabled) => {
      const f = await fixture();
      if (enabled) await enableSms(f);
      const operation = new InvoiceOperationsService({ db: f.db } as DatabaseService);
      await f.pool.query('delete from invoice_document_access_links where id=$1', [f.link.id]);
      await f.pool.query('delete from invoice_documents where id=$1', [f.doc]);
      await f.pool.query("update invoice_requests set status='issuing' where id=$1", [f.invoice]);
      const input: CreateInvoiceDocument = {
        invoiceNumber: 'TEST-NEW',
        documentType: 'original',
        storageKey: `invoices/${f.org}/${f.invoice}/new.pdf`,
        mediaType: 'application/pdf',
        size: f.bytes.length,
        contentDigest: createHash('sha256').update(f.bytes).digest('hex'),
        invoiceCode: undefined,
        externalReference: undefined,
        replacesDocumentId: undefined,
      };
      await operation.addDocument(f.org, f.invoice, f.actor, input, f.link.eventId!);
      expect((await invoiceSmsScope(f.db, f.invoice)).invoice.status).toBe('issued');
      const result = await f.pool.query(
        'select status,purpose from notification_deliveries where invoice_request_id=$1',
        [f.invoice],
      );
      expect(result.rows).toEqual([
        { status: enabled ? 'queued' : 'not_sent', purpose: 'invoice_auto' },
      ]);
      const events = await f.pool.query(
        "select payload from outbox_events where organization_id=$1 and event_type='InvoiceSmsDeliveryRequested'",
        [f.org],
      );
      expect(events.rowCount).toBe(enabled ? 1 : 0);
      if (enabled) expect(Object.keys(events.rows[0].payload)).toEqual(['deliveryId']);
      await expect(
        operation.addDocument(f.org, f.invoice, f.actor, input, f.link.eventId!),
      ).rejects.toThrow();
      expect(
        (
          await f.pool.query('select id from invoice_documents where invoice_request_id=$1', [
            f.invoice,
          ])
        ).rowCount,
      ).toBe(1);
    },
  );
  it('rolls back revoke-and-resend when a previous send is still pending', async () => {
    const f = await fixture();
    await enableSms(f);
    const scope = await invoiceSmsScope(f.db, f.invoice);
    await f.db.insert(notificationDeliveries).values({
      organizationId: f.org,
      eventId: f.link.eventId,
      invoiceRequestId: f.invoice,
      invoiceDocumentId: f.doc,
      documentIdentity: invoiceFileIdentity(scope.document!),
      fileAccessLinkId: f.link.id,
      purpose: 'invoice_auto',
      activationRevision: 1,
      channel: 'sms',
      recipient: '+8613800138000',
      subject: 'invoice',
      body: 'redacted',
      status: 'accepted',
      createdAt: new Date(Date.now() - 31 * 60_000),
      attemptedAt: new Date(),
    });
    const operation = new InvoiceOperationsService({ db: f.db } as DatabaseService);
    await expect(
      operation.revokeAccess(
        f.org,
        f.invoice,
        f.actor,
        f.link.eventId!,
        {
          expectedUpdatedAt: scope.invoice.updatedAt.toISOString(),
          reason: '重发测试发票',
          resend: true,
        },
        'revoke-test',
      ),
    ).rejects.toThrow('前次短信');
    expect(
      (
        await f.db
          .select()
          .from(invoiceDocumentAccessLinks)
          .where(eq(invoiceDocumentAccessLinks.id, f.link.id))
      )[0]!.revokedAt,
    ).toBeNull();
  });
  it('rejects a stale revocation after a replacement link is generated', async () => {
    const f = await fixture();
    await enableSms(f);
    const operation = new InvoiceOperationsService({ db: f.db } as DatabaseService);
    const version = (await invoiceSmsScope(f.db, f.invoice)).invoice.updatedAt.toISOString();
    await operation.revokeAccess(
      f.org,
      f.invoice,
      f.actor,
      f.link.eventId!,
      {
        expectedUpdatedAt: version,
        reason: 'revoke old link',
        resend: false,
      },
      'first-revoke',
    );
    expect((await invoiceSmsScope(f.db, f.invoice)).invoice.updatedAt.getTime()).toBeGreaterThan(
      new Date(version).getTime(),
    );
    const queued = await f.db.transaction((tx) => queueInvoiceSms(tx, f.invoice, { manual: true }));
    const delivery = (
      await f.db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.id, queued.deliveryId))
    )[0]!;
    const replacement = await f.db.transaction((tx) => prepareInvoiceFileLink(tx, delivery));
    expect(replacement.link.revokedAt).toBeNull();
    // Replaying the old page with a fresh request key must reject the stale confirmation.
    await expect(
      operation.revokeAccess(
        f.org,
        f.invoice,
        f.actor,
        f.link.eventId!,
        {
          expectedUpdatedAt: version,
          reason: 'old page revoke',
          resend: false,
        },
        'second-revoke',
      ),
    ).rejects.toThrow('发票已更新');
  });
  it('rejects a stale revocation after a new recipient capability is generated', async () => {
    const f = await fixture();
    await enableSms(f);
    const operation = new InvoiceOperationsService({ db: f.db } as DatabaseService);
    const version = (await invoiceSmsScope(f.db, f.invoice)).invoice.updatedAt.toISOString();
    await f.pool.query("update customer_users set mobile_e164='+8613900139000' where id=$1", [
      f.customer,
    ]);
    const queued = await f.db.transaction((tx) => queueInvoiceSms(tx, f.invoice, { manual: true }));
    const delivery = (
      await f.db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.id, queued.deliveryId))
    )[0]!;
    const replacement = await f.db.transaction((tx) => prepareInvoiceFileLink(tx, delivery));
    expect(replacement.link.revokedAt).toBeNull();
    await expect(
      operation.revokeAccess(
        f.org,
        f.invoice,
        f.actor,
        f.link.eventId!,
        {
          expectedUpdatedAt: version,
          reason: 'old number link revoke',
          resend: false,
        },
        'stale-phone-revoke',
      ),
    ).rejects.toThrow('发票已更新');
  });
  it('keeps a verified fingerprint stable on toggle and invalidates it on template change', async () => {
    const f = await fixture(true),
      config = readAliyunSmsConfiguration({
        enabled: true,
        signName: '测试',
        templates: { invoiceReady: { enabled: false, templateCode: 'SMS_TEST' } },
      });
    config.invoiceSms.deliveryMode = 'direct_file_v1';
    const [row] = await f.db
      .insert(organizationIntegrations)
      .values({
        organizationId: f.org,
        provider: 'aliyun-sms',
        config,
        encryptedCredentials: encryptIntegrationCredentials(f.org, 'aliyun-sms', {
          accessKeyId: 'key',
          accessKeySecret: 'secret',
        }),
        keyVersion: 1,
      })
      .returning();
    const fingerprint = invoiceSmsFingerprint(row!);
    const [test] = await f.db
      .insert(notificationDeliveries)
      .values({
        organizationId: f.org,
        channel: 'sms',
        recipient: '+8613800138000',
        subject: 'test',
        body: 'test',
        purpose: 'invoice_test',
        status: 'delivered',
        fileReachable: true,
        configurationFingerprint: fingerprint,
      })
      .returning();
    config.invoiceSms = {
      ...config.invoiceSms,
      verifiedFingerprint: fingerprint,
      verifiedOrigin: 'http://localhost:8088',
      testDeliveryId: test!.id,
    };
    await f.db
      .update(organizationIntegrations)
      .set({ config })
      .where(eq(organizationIntegrations.id, row!.id));
    const saved = await service.getConfiguration(f.org);
    const enabled = await service.updateConfiguration(f.org, f.actor, {
      enabled: true,
      signName: '测试',
      expectedUpdatedAt: saved.updatedAt,
      templates: {
        ...saved.templates,
        invoiceReady: { ...saved.templates.invoiceReady, enabled: true },
      },
    });
    expect(enabled.templates.invoiceReady.enabled).toBe(true);
    expect(enabled.invoiceSms.verifiedFingerprint).toBe(fingerprint);
    const changed = await service.updateConfiguration(f.org, f.actor, {
      enabled: true,
      signName: '测试',
      expectedUpdatedAt: enabled.updatedAt,
      templates: {
        ...enabled.templates,
        invoiceReady: { ...enabled.templates.invoiceReady, templateCode: 'SMS_CHANGED' },
      },
    });
    expect(changed.templates.invoiceReady.enabled).toBe(false);
    expect(changed.invoiceSms.verifiedFingerprint).toBeNull();
  });
});
