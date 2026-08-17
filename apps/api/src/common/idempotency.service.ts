import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { API_ERROR_CODES } from '@conference/contracts';
import { idempotencyKeys } from '@conference/database';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';

type JsonObject = Record<string, unknown>;
type IdempotencyExecutionOptions = {
  ttlMs?: number;
  allowLeaseTakeover?: boolean;
};
const PENDING_RESPONSE = { __tokemsIdempotencyPending: true } as const;
const PENDING_LEASE_MS = 2 * 60_000;
const PENDING_HEARTBEAT_MS = 30_000;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function idempotencyRequestHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

@Injectable()
export class IdempotencyService {
  private readonly inFlight = new Map<
    string,
    { requestHash: string; promise: Promise<JsonObject> }
  >();
  private readonly memoryCompleted = new Map<
    string,
    { requestHash: string; response: JsonObject; expiresAt: number }
  >();

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async execute<T extends JsonObject>(
    scope: string,
    key: string,
    request: unknown,
    operation: () => Promise<T>,
    ttlOrOptions: number | IdempotencyExecutionOptions = 24 * 60 * 60_000,
  ): Promise<T> {
    const ttlMs =
      typeof ttlOrOptions === 'number' ? ttlOrOptions : (ttlOrOptions.ttlMs ?? 24 * 60 * 60_000);
    const allowLeaseTakeover =
      typeof ttlOrOptions === 'object' && ttlOrOptions.allowLeaseTakeover === true;
    const requestHash = idempotencyRequestHash(request);
    const lockKey = `${scope}:${key}`;
    if (!this.database.db) {
      const completed = this.memoryCompleted.get(lockKey);
      if (completed && completed.expiresAt > Date.now()) {
        if (completed.requestHash !== requestHash) this.conflict();
        return completed.response as T;
      }
      if (completed) this.memoryCompleted.delete(lockKey);
      const runningMemory = this.inFlight.get(lockKey);
      if (runningMemory) {
        if (runningMemory.requestHash !== requestHash) this.conflict();
        return (await runningMemory.promise) as T;
      }
      const memoryJob = operation().then((response) => {
        this.memoryCompleted.set(lockKey, {
          requestHash,
          response,
          expiresAt: Date.now() + ttlMs,
        });
        return response;
      });
      this.inFlight.set(lockKey, { requestHash, promise: memoryJob });
      try {
        return await memoryJob;
      } finally {
        this.inFlight.delete(lockKey);
      }
    }
    const running = this.inFlight.get(lockKey);
    if (running) {
      if (running.requestHash !== requestHash) this.conflict();
      return (await running.promise) as T;
    }

    const job = this.run(scope, key, requestHash, operation, ttlMs, allowLeaseTakeover);
    this.inFlight.set(lockKey, { requestHash, promise: job });
    try {
      return (await job) as T;
    } finally {
      this.inFlight.delete(lockKey);
    }
  }

  private async run<T extends JsonObject>(
    scope: string,
    key: string,
    requestHash: string,
    operation: () => Promise<T>,
    ttlMs: number,
    allowLeaseTakeover: boolean,
  ): Promise<JsonObject> {
    const db = this.database.db!;
    const claim = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`idempotency:${scope}:${key}`}, 0))`,
      );
      const [cached] = await tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
        .limit(1);
      const now = new Date();
      if (cached && cached.expiresAt > now) {
        if (cached.requestHash !== requestHash) this.conflict();
        if (cached.responseBody.__tokemsIdempotencyPending !== true) {
          return { kind: 'cached', response: cached.responseBody } as const;
        }
        if (!allowLeaseTakeover || (cached.leaseExpiresAt && cached.leaseExpiresAt > now)) {
          return { kind: 'pending' } as const;
        }
      }
      if (cached) {
        await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.id, cached.id));
      }

      const [claimed] = await tx
        .insert(idempotencyKeys)
        .values({
          scope,
          key,
          requestHash,
          responseCode: HttpStatus.ACCEPTED,
          responseBody: PENDING_RESPONSE,
          leaseExpiresAt: new Date(Date.now() + PENDING_LEASE_MS),
          expiresAt: new Date(Date.now() + ttlMs),
        })
        .returning({ id: idempotencyKeys.id });
      return { kind: 'claimed', id: claimed!.id } as const;
    });
    if (claim.kind === 'cached') return claim.response;
    if (claim.kind === 'pending') {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '相同请求正在处理中，请稍后重试',
        HttpStatus.CONFLICT,
      );
    }

    const heartbeat = setInterval(() => {
      void db
        .update(idempotencyKeys)
        .set({ leaseExpiresAt: new Date(Date.now() + PENDING_LEASE_MS) })
        .where(
          and(
            eq(idempotencyKeys.id, claim.id),
            eq(idempotencyKeys.responseCode, HttpStatus.ACCEPTED),
          ),
        )
        .catch(() => undefined);
    }, PENDING_HEARTBEAT_MS);
    heartbeat.unref();

    let response: T;
    try {
      response = await operation();
    } catch (error) {
      clearInterval(heartbeat);
      await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, claim.id));
      throw error;
    }
    clearInterval(heartbeat);
    await db
      .update(idempotencyKeys)
      .set({
        responseCode: HttpStatus.OK,
        responseBody: response,
        leaseExpiresAt: null,
        expiresAt: new Date(Date.now() + ttlMs),
      })
      .where(eq(idempotencyKeys.id, claim.id));
    return response;
  }

  private conflict(): never {
    throw new DomainError(
      API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      '同一 Idempotency-Key 已用于不同请求',
      HttpStatus.CONFLICT,
    );
  }
}
