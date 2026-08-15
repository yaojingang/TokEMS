import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, organizations } from '@conference/database';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { withPostgresTransactionRetry } from './transaction-retry.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('commerce transaction retry barriers', () => {
  const database = new DatabaseService();
  const organizationId = randomUUID();

  beforeAll(async () => {
    await database.db!.insert(organizations).values({
      id: organizationId,
      slug: `transaction-retry-${organizationId.slice(0, 8)}`,
      name: '交易重试屏障验收组织',
    });
  });

  afterAll(async () => {
    await database.db!.delete(organizations).where(eq(organizations.id, organizationId));
    await database.onModuleDestroy();
  });

  async function exerciseReversedLockGraph(input: {
    action: string;
    firstLock: number;
    secondLock: number;
  }) {
    let arrivals = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const attempts: Record<0 | 1, number> = { 0: 0, 1: 0 };
    const operation = (index: 0 | 1, lockOrder: [number, number]) =>
      withPostgresTransactionRetry(
        () =>
          database.db!.transaction(async (tx) => {
            attempts[index] += 1;
            await tx.execute(sql`select pg_advisory_xact_lock(${lockOrder[0]})`);
            if (attempts[index] === 1) {
              arrivals += 1;
              if (arrivals === 2) releaseBarrier?.();
              await barrier;
            }
            await tx.execute(sql`select pg_advisory_xact_lock(${lockOrder[1]})`);
            await tx.insert(auditLogs).values({
              organizationId,
              action: input.action,
              resourceType: 'transaction_retry_barrier',
              resourceId: `${index}`,
              after: { index, attempt: attempts[index] },
              traceId: randomUUID(),
            });
          }),
        { maxAttempts: 3, baseDelayMs: 1 },
      );

    const results = await Promise.allSettled([
      operation(0, [input.firstLock, input.secondLock]),
      operation(1, [input.secondLock, input.firstLock]),
    ]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(attempts[0] + attempts[1]).toBeGreaterThanOrEqual(3);
    const committed = await database
      .db!.select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.action, input.action)));
    expect(committed).toHaveLength(2);
  }

  it('recovers the checkout ticket-type/order versus full-refund order/ticket-type cycle', async () => {
    await exerciseReversedLockGraph({
      action: 'test.retry.checkout-vs-refund',
      firstLock: 72_001,
      secondLock: 72_002,
    });
  });

  it('recovers the customer-delete order versus checkout-resume customer/order cycle', async () => {
    await exerciseReversedLockGraph({
      action: 'test.retry.delete-vs-resume',
      firstLock: 72_003,
      secondLock: 72_004,
    });
  });
});
