import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { idempotencyKeys } from '@conference/database';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { IdempotencyService, idempotencyRequestHash } from './idempotency.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('persistent idempotency execution', () => {
  const database = new DatabaseService();
  const leftService = new IdempotencyService(database);
  const rightService = new IdempotencyService(database);
  const scope = `integration:idempotency:${randomUUID()}`;
  const key = `request-${randomUUID()}`;

  afterAll(async () => {
    await database.db!.delete(idempotencyKeys).where(eq(idempotencyKeys.scope, scope));
    await database.onModuleDestroy();
  });

  it('releases the claim transaction before work and prevents a second instance from duplicating it', async () => {
    let startOperation!: () => void;
    let finishOperation!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      startOperation = resolve;
    });
    const operationMayFinish = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    let executions = 0;

    const first = leftService.execute(scope, key, { templateId: 'template-1' }, async () => {
      executions += 1;
      startOperation();
      await operationMayFinish;
      return { templateId: 'created-template' };
    });
    await operationStarted;

    const [pending] = await database
      .db!.select({ responseBody: idempotencyKeys.responseBody })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
      .limit(1);
    expect(pending?.responseBody).toEqual({ __tokemsIdempotencyPending: true });

    await expect(
      rightService.execute(scope, key, { templateId: 'template-1' }, async () => {
        executions += 1;
        return { templateId: 'duplicate-template' };
      }),
    ).rejects.toMatchObject({ status: 409 });

    finishOperation();
    await expect(first).resolves.toEqual({ templateId: 'created-template' });
    await expect(
      rightService.execute(scope, key, { templateId: 'template-1' }, async () => {
        executions += 1;
        return { templateId: 'duplicate-template' };
      }),
    ).resolves.toEqual({ templateId: 'created-template' });
    expect(executions).toBe(1);
  });

  it('takes over an abandoned pending claim after its lease expires', async () => {
    const abandonedKey = `abandoned-${randomUUID()}`;
    const request = { templateId: 'template-abandoned' };
    await database.db!.insert(idempotencyKeys).values({
      scope,
      key: abandonedKey,
      requestHash: idempotencyRequestHash(request),
      responseCode: 202,
      responseBody: { __tokemsIdempotencyPending: true },
      leaseExpiresAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 60_000),
    });
    let executions = 0;

    await expect(
      rightService.execute(
        scope,
        abandonedKey,
        request,
        async () => {
          executions += 1;
          return { templateId: 'recovered-template' };
        },
        { allowLeaseTakeover: true },
      ),
    ).resolves.toEqual({ templateId: 'recovered-template' });
    expect(executions).toBe(1);

    const [recovered] = await database
      .db!.select({ responseCode: idempotencyKeys.responseCode })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, abandonedKey)))
      .limit(1);
    expect(recovered?.responseCode).toBe(200);
  });

  it('keeps an abandoned claim fenced when the business command is not recoverable', async () => {
    const unsafeKey = `unsafe-${randomUUID()}`;
    const request = { invoiceId: 'invoice-unsafe' };
    await database.db!.insert(idempotencyKeys).values({
      scope,
      key: unsafeKey,
      requestHash: idempotencyRequestHash(request),
      responseCode: 202,
      responseBody: { __tokemsIdempotencyPending: true },
      leaseExpiresAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 60_000),
    });
    let executions = 0;

    await expect(
      rightService.execute(scope, unsafeKey, request, async () => {
        executions += 1;
        return { invoiceId: 'duplicate-invoice' };
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(executions).toBe(0);
  });

  it('keeps Agent results protected and separates their in-flight promises from browser requests', async () => {
    const agentId = randomUUID();
    const protectedKey = `protected-${randomUUID()}`;
    await database.withAgentTransaction({ operationId: agentId, connectionId: randomUUID(),
      delegatedUserId: randomUUID(), traceId: randomUUID() }, async () => {
      expect(await leftService.execute(scope, protectedKey, {}, async () => ({ uploadUrl: 'https://private/signed' })))
        .toEqual({ uploadUrl: 'https://private/signed' });
    });
    const [stored] = await database.db!.select().from(idempotencyKeys).where(and(
      eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, protectedKey)));
    expect(stored?.responseBody).toEqual({ __tokemsAgentOperationId: agentId });
    await expect(rightService.execute(scope, protectedKey, {}, async () => ({}))).rejects.toMatchObject({ status: 409 });

    const concurrentKey = `concurrent-${randomUUID()}`;
    let started!: () => void;
    let release!: () => void;
    const operationStarted = new Promise<void>((resolve) => { started = resolve; });
    const mayComplete = new Promise<void>((resolve) => { release = resolve; });
    const aborted = database.withAgentTransaction({ operationId: randomUUID(), connectionId: randomUUID(),
      delegatedUserId: randomUUID(), traceId: randomUUID() }, async () => {
      await leftService.execute(scope, concurrentKey, {}, async () => {
        started();
        await mayComplete;
        return { source: 'uncommitted Agent' };
      });
      throw new Error('Roll back Agent operation');
    });
    const rejected = expect(aborted).rejects.toThrow('Roll back Agent operation');
    await operationStarted;
    let browserExecutions = 0;
    const browser = leftService.execute(scope, concurrentKey, {}, async () => {
      browserExecutions += 1;
      return { source: 'browser committed' };
    });
    release();
    await rejected;
    expect(await browser).toEqual({ source: 'browser committed' });
    expect(browserExecutions).toBe(1);
  });
});
