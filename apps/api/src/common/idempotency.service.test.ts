import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from './database.service.js';
import { IdempotencyService, idempotencyRequestHash } from './idempotency.service.js';

describe('idempotency request hashing', () => {
  it('treats reordered object keys as the same request and changed values as a conflict', () => {
    const first = idempotencyRequestHash({
      invoiceId: 'invoice-1',
      action: { reason: '资料完整', code: 'A-01' },
    });
    const reordered = idempotencyRequestHash({
      action: { code: 'A-01', reason: '资料完整' },
      invoiceId: 'invoice-1',
    });
    const changed = idempotencyRequestHash({
      invoiceId: 'invoice-1',
      action: { reason: '资料需修改', code: 'A-01' },
    });

    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });
});

describe('in-memory idempotency', () => {
  it('replays a successful response and rejects reuse with different input', async () => {
    const service = new IdempotencyService({ db: undefined } as unknown as DatabaseService);
    const operation = vi.fn(async () => ({ requestNo: 'COOP-20260817-ABC234' }));

    const first = await service.execute(
      'cooperation',
      'request-key-01',
      { company: '甲公司' },
      operation,
    );
    const repeated = await service.execute(
      'cooperation',
      'request-key-01',
      { company: '甲公司' },
      operation,
    );

    expect(repeated).toEqual(first);
    expect(operation).toHaveBeenCalledTimes(1);
    await expect(
      service.execute('cooperation', 'request-key-01', { company: '乙公司' }, operation),
    ).rejects.toMatchObject({ status: 409 });
  });
});
