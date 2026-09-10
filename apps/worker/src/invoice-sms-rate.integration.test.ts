import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { createInvoiceSmsRateGate } from './invoice-sms-notification.worker.js';
const integration = process.env.INVOICE_SMS_TEST_REDIS_URL ? describe : describe.skip;
integration('invoice SMS Redis rate gate (isolated Redis)', () => {
  it.each([100, 1000])(
    'delays a burst of %s without blocking an unrelated organization',
    async (count) => {
      const url = new URL(process.env.INVOICE_SMS_TEST_REDIS_URL!);
      const queue = new Queue(`invoice-rate-test-${randomUUID()}`, {
        connection: { host: url.hostname, port: Number(url.port || 6379) },
      });
      try {
        const gate = createInvoiceSmsRateGate(await queue.getBackend().client),
          org = randomUUID();
        const started = Date.now();
        const results = await Promise.all(Array.from({ length: count }, () => gate(org)));
        expect(results.filter((value) => value === 0).length).toBeGreaterThanOrEqual(1);
        expect(results.filter((value) => value === 0).length).toBeLessThanOrEqual(
          Math.ceil((Date.now() - started) / 1000) + 1,
        );
        expect(results.some((value) => value > 0)).toBe(true);
        expect(results.every((value) => value >= 0 && value <= 1000)).toBe(true);
        expect(await gate(randomUUID())).toBe(0);
      } finally {
        await queue.close();
      }
    },
  );
});
