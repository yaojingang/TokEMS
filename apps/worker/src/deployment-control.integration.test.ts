import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { DeploymentControl } from '@conference/database';
import { describe, expect, it, vi } from 'vitest';
import { activateDeploymentConsumers } from './deployment-consumers.js';

const redis = process.env.TOKEMS_BLUEGREEN_TEST_REDIS_URL;

describe.skipIf(!redis)('deployment control with real BullMQ consumers', () => {
  it('standby → drain → activate → drain → resume processes each queued job once', async () => {
    const url = new URL(redis!);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Test Redis must be loopback');
    const connection = { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
    const name = `tokems-bluegreen-test-${randomUUID()}`;
    const queue = new Queue(name, { connection });
    const processed: string[] = [];
    const worker = new Worker(name, async (job) => { processed.push(job.id!); }, { connection, autorun: false });
    const control = new DeploymentControl(true);
    control.register({ pause: () => worker.pause(), resume: () => activateDeploymentConsumers([worker]) });
    try {
      await worker.waitUntilReady();
      await queue.add('first', {}, { jobId: 'first' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(processed).toEqual([]);
      await control.command('drain');
      await vi.waitFor(() => expect(control.status().phase).toBe('drained'));
      await control.command('activate');
      await vi.waitFor(() => expect(processed).toEqual(['first']));
      await control.command('drain');
      await vi.waitFor(() => expect(control.status().phase).toBe('drained'));
      await queue.add('second', {}, { jobId: 'second' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(processed).toEqual(['first']);
      await control.command('resume');
      await vi.waitFor(() => expect(processed).toEqual(['first', 'second']));
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }, 10_000);
});
