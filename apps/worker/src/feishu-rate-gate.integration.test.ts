import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { createFeishuRateGate, type FeishuRateGate } from './feishu-digest.worker.js';

const persistent = process.env.REDIS_URL ? describe : describe.skip;
persistent('Feishu shared Redis send-rate gate', () => {
  let queue: Queue;
  let gate: FeishuRateGate;
  beforeAll(async () => {
    const url = new URL(process.env.REDIS_URL!);
    queue = new Queue(`feishu-rate-test-${randomUUID()}`, {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
        db: Number(url.pathname.slice(1) || 0),
        maxRetriesPerRequest: 1,
      },
    });
    gate = createFeishuRateGate(await queue.getBackend().client);
  });
  afterAll(async () => {
    await queue.close();
  });
  it('allows only one of concurrent requests for the same chat', async () => {
    const app = randomUUID();
    const chat = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => gate(app, chat)));
    expect(results.filter((delay) => delay === 0)).toHaveLength(1);
    expect(results.filter((delay) => delay > 0)).toHaveLength(4);
  });
  it('shares the app budget across groups without blocking another app', async () => {
    const app = randomUUID();
    const results = await Promise.all(Array.from({ length: 12 }, () => gate(app, randomUUID())));
    expect(results.filter((delay) => delay === 0)).toHaveLength(10);
    expect(await gate(randomUUID(), randomUUID())).toBe(0);
  });
});
