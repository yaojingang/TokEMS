import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  organizationIntegrations,
  notificationDeliveries,
  invoiceDocumentAccessLinks,
  invoiceSmsFingerprint,
  invoiceSmsPolicy,
  invoiceSmsIntegration,
  queueInvoiceSms,
  invoiceSmsSummary,
  invalidateInvoiceFileAccess,
  prepareInvoiceFileLink,
  invoiceFileIdentity,
  invoiceSmsScope,
  refreshInvoiceSmsVerification,
} from '@conference/database';
import { readAliyunSmsConfiguration } from '@conference/integrations';
import {
  deliverInvoiceSms,
  maintainInvoiceSms,
  finalizeInvoiceSmsFailure,
  synchronizeInvoiceSmsStatus,
} from './invoice-sms-notification.worker.js';

const integration = process.env.INVOICE_SMS_TEST_DATABASE_URL ? describe : describe.skip;
integration('invoice SMS durable delivery (isolated PostgreSQL)', () => {
  let admin: ReturnType<typeof createDatabase>, connection: ReturnType<typeof createDatabase>;
  const name = `invoice_sms_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  beforeAll(async () => {
    vi.stubEnv('PUBLIC_ORIGIN', 'http://localhost:8088');
    vi.stubEnv('NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET', 'invoice-tests-only-32-characters-secret');
    admin = createDatabase(process.env.INVOICE_SMS_TEST_DATABASE_URL!);
    await admin.pool.query(`create database "${name}"`);
    created = true;
    const url = new URL(process.env.INVOICE_SMS_TEST_DATABASE_URL!);
    url.pathname = `/${name}`;
    connection = createDatabase(url.toString());
    for (const migration of readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL('../../../packages/database/drizzle', import.meta.url),
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
  }, 90_000);
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await connection?.pool.end();
    if (created) await admin.pool.query(`drop database "${name}"`);
    await admin?.pool.end();
  });
  async function fixture(enabled = true) {
    const org = randomUUID(),
      customer = randomUUID(),
      order = randomUUID(),
      invoice = randomUUID(),
      doc = randomUUID();
    const event = 10000 + Math.floor(Math.random() * 100000000);
    const pool = connection.pool,
      db = connection.db;
    await pool.query(
      "insert into organizations(id,slug,name) values($1::uuid,$1::text,'Invoice test')",
      [org],
    );
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
      values($1::uuid,$2,$1::text,$3,'application/pdf',100,repeat('a',64))`,
      [doc, invoice, `invoices/${org}/${invoice}/test.pdf`],
    );
    const config = readAliyunSmsConfiguration({
      enabled: true,
      signName: '发票测试',
      templates: { invoiceReady: { enabled, templateCode: 'SMS_TEST' } },
    });
    config.invoiceSms = {
      ...config.invoiceSms,
      deliveryMode: 'direct_file_v1',
      activationRevision: 1,
    };
    const [row] = await db
      .insert(organizationIntegrations)
      .values({
        organizationId: org,
        provider: 'aliyun-sms',
        config,
        encryptedCredentials: 'encrypted-test-only',
        keyVersion: 1,
      })
      .returning();
    const fingerprint = invoiceSmsFingerprint(row!);
    const [proof] = await db
      .insert(notificationDeliveries)
      .values({
        organizationId: org,
        channel: 'sms',
        recipient: '+8613800138000',
        subject: 'test',
        body: 'sample',
        purpose: 'invoice_test',
        status: 'delivered',
        fileReachable: true,
        configurationFingerprint: fingerprint,
      })
      .returning();
    await db
      .update(organizationIntegrations)
      .set({
        config: {
          ...config,
          invoiceSms: {
            ...config.invoiceSms,
            testDeliveryId: proof!.id,
            verifiedOrigin: 'http://localhost:8088',
            verifiedFingerprint: fingerprint,
          },
        },
      })
      .where(eq(organizationIntegrations.id, row!.id));
    const send = vi.fn().mockResolvedValue({
      accepted: true,
      code: 'OK',
      message: 'ok',
      requestId: 'request',
      bizId: 'biz',
    });
    return {
      org,
      customer,
      order,
      invoice,
      doc,
      send,
      db,
      pool,
      queue: () => db.transaction((tx) => queueInvoiceSms(tx, invoice)),
      process: (id: string) => deliverInvoiceSms(db, id, () => ({ send })),
      delivery: async (id: string) =>
        (
          await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id))
        )[0]!,
    };
  }
  it('keeps disabled upload durable without a send event or public credential', async () => {
    const f = await fixture(false),
      queued = await f.queue();
    expect(queued.queued).toBe(false);
    expect((await f.delivery(queued.deliveryId)).status).toBe('not_sent');
    expect(
      (
        await f.db
          .select()
          .from(invoiceDocumentAccessLinks)
          .where(eq(invoiceDocumentAccessLinks.invoiceRequestId, f.invoice))
      ).length,
    ).toBe(0);
    expect(await f.queue()).toMatchObject({ alreadyQueued: true, deliveryId: queued.deliveryId });
  });
  it('sends one SMS for concurrent registration events, with a 30-day capability and purchaser recipient', async () => {
    const f = await fixture();
    const queued = await Promise.all([f.queue(), f.queue()]);
    expect(queued[0]!.deliveryId).toBe(queued[1]!.deliveryId);
    await Promise.all([f.process(queued[0]!.deliveryId), f.process(queued[0]!.deliveryId)]);
    expect(f.send).toHaveBeenCalledTimes(1);
    const argument = f.send.mock.calls[0]![0];
    expect(argument.phoneNumber).toBe('+8613800138000');
    expect(argument.templateParameters.fileToken).toMatch(/^[A-Za-z][A-Za-z0-9]{23}$/);
    expect(argument.templateParameters.url).toBeUndefined();
    expect((await f.delivery(queued[0]!.deliveryId)).status).toBe('accepted');
    const [link] = await f.db
      .select()
      .from(invoiceDocumentAccessLinks)
      .where(eq(invoiceDocumentAccessLinks.invoiceRequestId, f.invoice));
    expect(link!.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86400000);
    expect(link!.tokenHash).not.toContain(argument.templateParameters.fileToken);
  });
  it('does not resend uncertain network submissions on job retry', async () => {
    const f = await fixture();
    f.send.mockRejectedValue(new Error('timeout contains secret token'));
    const queued = await f.queue();
    await f.process(queued.deliveryId);
    await f.process(queued.deliveryId);
    expect(f.send).toHaveBeenCalledTimes(1);
    const result = await f.delivery(queued.deliveryId);
    expect(result.status).toBe('unknown');
    expect(result.error).not.toContain('secret');
    expect((await invoiceSmsSummary(f.db, f.invoice)).canForceSend).toBe(false);
    await f.pool.query(
      "update notification_deliveries set created_at=now()-interval '31 minutes',attempted_at=now()-interval '31 minutes' where id=$1",
      [queued.deliveryId],
    );
    expect((await invoiceSmsSummary(f.db, f.invoice)).canForceSend).toBe(true);
  });
  it('measures uncertain waiting from the actual attempt after a long queue delay', async () => {
    const f = await fixture(),
      queued = await f.queue();
    await f.pool.query(
      "update notification_deliveries set created_at=now()-interval '2 hours' where id=$1",
      [queued.deliveryId],
    );
    await f.process(queued.deliveryId);
    expect((await invoiceSmsSummary(f.db, f.invoice)).canForceSend).toBe(false);
  });
  it('finalizes exhausted pre-send failures, without overwriting uncertain submissions', async () => {
    const f = await fixture(),
      queued = await f.queue();
    await expect(
      deliverInvoiceSms(f.db, queued.deliveryId, () => {
        throw new Error('bad credentials');
      }),
    ).rejects.toThrow();
    expect((await f.delivery(queued.deliveryId)).status).toBe('queued');
    await finalizeInvoiceSmsFailure(f.db, queued.deliveryId);
    expect((await f.delivery(queued.deliveryId)).status).toBe('failed');
    expect((await invoiceSmsScope(f.db, f.invoice)).invoice.deliveryStatus).toBe('failed');
    expect(f.send).not.toHaveBeenCalled();
    await f.pool.query("update notification_deliveries set status='unknown' where id=$1", [
      queued.deliveryId,
    ]);
    await finalizeInvoiceSmsFailure(f.db, queued.deliveryId);
    expect((await f.delivery(queued.deliveryId)).status).toBe('unknown');
  });
  it('does not let an old delivery receipt replace the current notification state', async () => {
    const f = await fixture(),
      first = await f.queue();
    await f.process(first.deliveryId);
    await f.pool.query(
      "update notification_deliveries set status='delivered',created_at=now()-interval '11 minutes' where id=$1",
      [first.deliveryId],
    );
    const second = await f.db.transaction((tx) => queueInvoiceSms(tx, f.invoice, { manual: true }));
    await synchronizeInvoiceSmsStatus(f.db, first.deliveryId);
    expect((await invoiceSmsScope(f.db, f.invoice)).invoice.deliveryStatus).toBe('queued');
    expect((await f.delivery(second.deliveryId)).status).toBe('queued');
  });
  it('rechecks retry timing after a duplicate waits for the order lock', async () => {
    const f = await fixture(),
      queued = await f.queue();
    let enter!: () => void, release!: (result: Awaited<ReturnType<typeof f.send>>) => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    f.send.mockImplementationOnce(() => {
      enter();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const first = f.process(queued.deliveryId);
    await entered;
    const locker = await f.pool.connect();
    let second: Promise<void> | undefined;
    await locker.query('BEGIN');
    try {
      await locker.query('select id from orders where id=$1 for update', [f.order]);
      second = f.process(queued.deliveryId);
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await f.pool.query(
          "select count(*) as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'",
        );
        if (Number(result.rows[0].n) > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      release({ accepted: false, code: 'isp.SYSTEM_ERROR', bizId: '', message: 'temporary' });
      let retrying = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        if ((await f.delivery(queued.deliveryId)).status === 'retrying') {
          retrying = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(retrying).toBe(true);
      expect(
        (await f.delivery(queued.deliveryId)).scheduledAt.getTime() - Date.now(),
      ).toBeGreaterThan(28000);
    } finally {
      release({ accepted: false, code: 'isp.SYSTEM_ERROR', bizId: '', message: 'temporary' });
      await locker.query('ROLLBACK');
      locker.release();
      await Promise.all([first, ...(second ? [second] : [])]);
    }
    expect(f.send).toHaveBeenCalledTimes(1);
    expect((await f.delivery(queued.deliveryId)).status).toBe('retrying');
  }, 10000);
  it('retains a prepared credential on known rejection retries', async () => {
    const f = await fixture();
    f.send.mockResolvedValueOnce({
      accepted: false,
      code: 'isp.SYSTEM_ERROR',
      bizId: '',
      message: 'temporary',
    });
    const queued = await f.queue();
    await f.process(queued.deliveryId);
    expect((await f.delivery(queued.deliveryId)).status).toBe('retrying');
    await f.pool.query(
      "update notification_deliveries set attempted_at=now()-interval '2 seconds',scheduled_at=now() where id=$1",
      [queued.deliveryId],
    );
    await f.process(queued.deliveryId);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[0]![0].templateParameters.fileToken).toBe(
      f.send.mock.calls[1]![0].templateParameters.fileToken,
    );
  });
  it('keeps a definitive rejection retryable when a receipt poll marked the attempt unknown', async () => {
    const f = await fixture(),
      queued = await f.queue();
    f.send.mockImplementationOnce(async () => {
      await f.pool.query("update notification_deliveries set status='unknown' where id=$1", [
        queued.deliveryId,
      ]);
      return { accepted: false, code: 'isv.BUSINESS_LIMIT_CONTROL', bizId: '', message: 'retry' };
    });
    await f.process(queued.deliveryId);
    const result = await f.delivery(queued.deliveryId);
    expect(result.status).toBe('retrying');
    expect(result.scheduledAt!.getTime() - Date.now()).toBeGreaterThan(28000);
    await f.process(queued.deliveryId);
    expect(f.send).toHaveBeenCalledTimes(1);
    await f.pool.query('update notification_deliveries set scheduled_at=now() where id=$1', [
      queued.deliveryId,
    ]);
    await f.process(queued.deliveryId);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('cancels a queued job after off/on revision changes', async () => {
    const f = await fixture(),
      queued = await f.queue();
    const row = await invoiceSmsIntegration(f.db, f.org);
    await f.db
      .update(organizationIntegrations)
      .set({
        config: { ...row!.config, invoiceSms: { ...invoiceSmsPolicy(row), activationRevision: 3 } },
      })
      .where(eq(organizationIntegrations.id, row!.id));
    await f.process(queued.deliveryId);
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.delivery(queued.deliveryId)).status).toBe('cancelled');
  });
  it('cancels queued delivery when purchaser mobile changes', async () => {
    const f = await fixture(),
      queued = await f.queue();
    await f.pool.query("update customer_users set mobile_e164='+8613900139000' where id=$1", [
      f.customer,
    ]);
    await f.process(queued.deliveryId);
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.delivery(queued.deliveryId)).error).toContain('手机号');
  });
  it('revokes old links and cancels queued tasks on replacement', async () => {
    const f = await fixture(),
      queued = await f.queue();
    await f.process(queued.deliveryId);
    await f.db.transaction((tx) => invalidateInvoiceFileAccess(tx, f.invoice));
    const [link] = await f.db
      .select()
      .from(invoiceDocumentAccessLinks)
      .where(eq(invoiceDocumentAccessLinks.invoiceRequestId, f.invoice));
    expect(link!.revokedAt).toBeInstanceOf(Date);
    expect(link!.sealedToken).toBeNull();
    expect((await invoiceSmsSummary(f.db, f.invoice)).canRevoke).toBe(false);
  });
  it('shares an active token across manual deliveries and preserves it when the switch closes', async () => {
    const f = await fixture(),
      queued = await f.queue();
    await f.process(queued.deliveryId);
    await f.pool.query(
      "update notification_deliveries set status='delivered',created_at=now()-interval '11 minutes' where id=$1",
      [queued.deliveryId],
    );
    const manual = await f.db.transaction((tx) => queueInvoiceSms(tx, f.invoice, { manual: true }));
    const link = await f.db.transaction(async (tx) =>
      prepareInvoiceFileLink(tx, await f.delivery(manual.deliveryId)),
    );
    expect(link.token).toBe(f.send.mock.calls[0]![0].templateParameters.fileToken);
    const row = await invoiceSmsIntegration(f.db, f.org),
      config = readAliyunSmsConfiguration(row!.config);
    config.templates.invoiceReady.enabled = false;
    await f.db
      .update(organizationIntegrations)
      .set({ config })
      .where(eq(organizationIntegrations.id, row!.id));
    expect(
      (
        await f.db
          .select()
          .from(invoiceDocumentAccessLinks)
          .where(eq(invoiceDocumentAccessLinks.id, link.link.id))
      )[0]!.revokedAt,
    ).toBeNull();
    await expect(
      f.db.transaction((tx) => queueInvoiceSms(tx, f.invoice, { manual: true })),
    ).rejects.toThrow('关闭');
  });
  it('keeps active-link revocation available when a later delivery has not prepared its own link', async () => {
    const f = await fixture(),
      first = await f.queue();
    await f.process(first.deliveryId);
    await f.pool.query(
      "update notification_deliveries set status='delivered',created_at=now()-interval '11 minutes' where id=$1",
      [first.deliveryId],
    );
    const before = await invoiceSmsSummary(f.db, f.invoice);
    const second = await f.db.transaction((tx) => queueInvoiceSms(tx, f.invoice, { manual: true }));
    for (const status of ['queued', 'cancelled', 'failed']) {
      await f.pool.query('update notification_deliveries set status=$2 where id=$1', [
        second.deliveryId,
        status,
      ]);
      expect(await invoiceSmsSummary(f.db, f.invoice)).toMatchObject({
        status,
        canRevoke: true,
        expiresAt: before.expiresAt,
      });
    }
  });
  it('distinguishes the prior delivery recipient from the purchaser currently eligible for a resend', async () => {
    const f = await fixture(),
      first = await f.queue();
    await f.process(first.deliveryId);
    await f.pool.query(
      "update notification_deliveries set status='delivered',created_at=now()-interval '11 minutes' where id=$1",
      [first.deliveryId],
    );
    await f.pool.query("update customer_users set mobile_e164='+8613900139000' where id=$1", [
      f.customer,
    ]);
    expect(await invoiceSmsSummary(f.db, f.invoice)).toMatchObject({
      status: 'delivered',
      maskedRecipient: '+86138****8000',
      nextMaskedRecipient: '+86139****9000',
    });
    const second = await f.db.transaction((tx) => queueInvoiceSms(tx, f.invoice, { manual: true }));
    expect(second.maskedRecipient).toBe('+86139****9000');
    expect((await f.delivery(second.deliveryId)).recipient).toBe('+8613900139000');
  });
  it('advances the invoice access version only for a newly allocated formal capability', async () => {
    const f = await fixture(),
      first = await f.queue();
    const before = (await invoiceSmsScope(f.db, f.invoice)).invoice.updatedAt;
    await f.process(first.deliveryId);
    const allocated = (await invoiceSmsScope(f.db, f.invoice)).invoice.updatedAt;
    expect(allocated.getTime()).toBeGreaterThan(before.getTime());
    await f.pool.query(
      "update notification_deliveries set status='delivered',created_at=now()-interval '11 minutes' where id=$1",
      [first.deliveryId],
    );
    const second = await f.db.transaction((tx) => queueInvoiceSms(tx, f.invoice, { manual: true }));
    await f.process(second.deliveryId);
    expect(f.send.mock.calls[0]![0].templateParameters.fileToken).toBe(
      f.send.mock.calls[1]![0].templateParameters.fileToken,
    );
    expect((await invoiceSmsScope(f.db, f.invoice)).invoice.updatedAt.getTime()).toBe(
      allocated.getTime(),
    );
    await synchronizeInvoiceSmsStatus(f.db, second.deliveryId);
    expect((await invoiceSmsScope(f.db, f.invoice)).invoice.updatedAt.getTime()).toBe(
      allocated.getTime(),
    );
  });
  it('expires automatic work after 24 hours and does not create a link', async () => {
    const f = await fixture(),
      queued = await f.queue();
    await f.pool.query(
      "update notification_deliveries set created_at=now()-interval '25 hours' where id=$1",
      [queued.deliveryId],
    );
    await f.process(queued.deliveryId);
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.delivery(queued.deliveryId)).fileAccessLinkId).toBeNull();
  });
  it('closes the persisted switch on origin drift and clears expired plaintext recovery material', async () => {
    const f = await fixture();
    vi.stubEnv('PUBLIC_ORIGIN', 'http://changed.example');
    await maintainInvoiceSms(f.db);
    const row = await invoiceSmsIntegration(f.db, f.org);
    expect(readAliyunSmsConfiguration(row!.config).templates.invoiceReady.enabled).toBe(false);
    expect(invoiceSmsPolicy(row).activationRevision).toBe(2);
    vi.stubEnv('PUBLIC_ORIGIN', 'http://localhost:8088');
  });
  it('merges a late test proof without enabling the business switch', async () => {
    const f = await fixture(false);
    const row = await invoiceSmsIntegration(f.db, f.org),
      config = readAliyunSmsConfiguration(row!.config);
    config.invoiceSms.verifiedFingerprint = null;
    config.invoiceSms.verifiedOrigin = null;
    await f.db
      .update(organizationIntegrations)
      .set({ config })
      .where(eq(organizationIntegrations.id, row!.id));
    await refreshInvoiceSmsVerification(f.db, f.org);
    const current = await invoiceSmsIntegration(f.db, f.org);
    expect(invoiceSmsPolicy(current).verifiedFingerprint).toBe(invoiceSmsFingerprint(current!));
    expect(readAliyunSmsConfiguration(current!.config).templates.invoiceReady.enabled).toBe(false);
  });
  it('checks HEAD and GET on a sample before submitting a test SMS while the invoice switch is off', async () => {
    const f = await fixture(false),
      current = await invoiceSmsIntegration(f.db, f.org);
    const [test] = await f.db
      .insert(notificationDeliveries)
      .values({
        organizationId: f.org,
        purpose: 'invoice_test',
        channel: 'sms',
        recipient: '+8613800138000',
        subject: 'test',
        body: 'sample',
        status: 'queued',
        configurationFingerprint: invoiceSmsFingerprint(current!),
      })
      .returning();
    await f.db
      .update(organizationIntegrations)
      .set({
        config: {
          ...current!.config,
          invoiceSms: {
            ...invoiceSmsPolicy(current),
            testDeliveryId: test!.id,
            verifiedFingerprint: null,
          },
        },
      })
      .where(eq(organizationIntegrations.id, current!.id));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async (_url: unknown, init?: RequestInit) =>
          new Response(init?.method === 'HEAD' ? null : '%PDF-sample', {
            headers: { 'content-type': 'application/pdf', 'content-length': '11' },
          }),
      ),
    );
    await f.process(test!.id);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect((await f.delivery(test!.id)).fileReachable).toBe(true);
    expect(vi.mocked(fetch).mock.calls.map((call) => call[1]?.method ?? 'GET')).toEqual([
      'HEAD',
      'GET',
    ]);
    const [link] = await f.db
      .select()
      .from(invoiceDocumentAccessLinks)
      .where(eq(invoiceDocumentAccessLinks.id, (await f.delivery(test!.id)).fileAccessLinkId!));
    expect(link!.purpose).toBe('test');
    expect(link!.invoiceRequestId).toBeNull();
    expect(link!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(86400000);
    expect(
      invoiceSmsPolicy(await invoiceSmsIntegration(f.db, f.org)).verifiedFingerprint,
    ).toBeNull();
    vi.unstubAllGlobals();
  });
  it('binds document identity to storage key, digest and issued timestamp', async () => {
    const f = await fixture(),
      scope = await invoiceSmsScope(f.db, f.invoice),
      identity = invoiceFileIdentity(scope.document!);
    expect(invoiceFileIdentity({ ...scope.document!, storageKey: 'different' })).not.toBe(identity);
    expect(invoiceFileIdentity({ ...scope.document!, issuedAt: new Date(0) })).not.toBe(identity);
  });
  it('keeps manual resend cooldown across a disabled replacement and reactivation', async () => {
    const f = await fixture();
    const first = await f.db.transaction((tx) => queueInvoiceSms(tx, f.invoice, { manual: true }));
    await f.pool.query(
      "update notification_deliveries set status='delivered',created_at=now()-interval '2 minutes' where id=$1",
      [first.deliveryId],
    );
    await f.pool.query(
      "update organization_integrations set config=jsonb_set(config,'{templates,invoiceReady,enabled}','false') where organization_id=$1",
      [f.org],
    );
    await f.pool.query(
      "update invoice_documents set storage_key=storage_key||'.replacement',issued_at=now() where id=$1",
      [f.doc],
    );
    const replacement = await f.queue();
    expect((await f.delivery(replacement.deliveryId)).status).toBe('not_sent');
    await f.pool.query(
      "update organization_integrations set config=jsonb_set(config,'{templates,invoiceReady,enabled}','true') where organization_id=$1",
      [f.org],
    );
    const summary = await invoiceSmsSummary(f.db, f.invoice);
    expect(summary.status).toBe('not_sent');
    expect(summary.canSend).toBe(false);
    expect(summary.retryAfterSeconds).toBeGreaterThan(450);
    expect(summary.retryAfterSeconds).toBeLessThanOrEqual(480);
    await expect(
      f.db.transaction((tx) => queueInvoiceSms(tx, f.invoice, { manual: true })),
    ).rejects.toMatchObject({ status: 429 });
    await f.pool.query(
      "update notification_deliveries set created_at=now()-interval '11 minutes' where id=$1",
      [first.deliveryId],
    );
    expect((await invoiceSmsSummary(f.db, f.invoice)).canSend).toBe(true);
    await expect(
      f.db.transaction((tx) => queueInvoiceSms(tx, f.invoice, { manual: true })),
    ).resolves.toMatchObject({ queued: true, alreadyQueued: false });
  });
  it('still queues a new automatic file version during the prior manual cooldown', async () => {
    const f = await fixture();
    const first = await f.db.transaction((tx) => queueInvoiceSms(tx, f.invoice, { manual: true }));
    await f.pool.query(
      "update notification_deliveries set status='delivered',created_at=now()-interval '2 minutes' where id=$1",
      [first.deliveryId],
    );
    await f.pool.query(
      "update invoice_documents set storage_key=storage_key||'.replacement',issued_at=now() where id=$1",
      [f.doc],
    );
    await expect(f.queue()).resolves.toMatchObject({ queued: true, alreadyQueued: false });
  });
});
