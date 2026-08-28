import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EventId } from '@conference/contracts';
import {
  feishuManualDeliveryDedupKey,
  feishuStatusAfterVerificationFailure,
} from './feishu-digest.service.js';

describe('Feishu digest manual delivery idempotency', () => {
  const base = {
    kind: 'test' as const,
    organizationId: randomUUID(),
    eventId: 101 as EventId,
    actorId: randomUUID(),
    attemptId: 'same-client-idempotency-key',
    request: { chatId: 'oc_first', dataVisibilityConfirmed: true },
  };

  it('keeps exact retries stable without persisting the raw client key', () => {
    const first = feishuManualDeliveryDedupKey(base);

    expect(feishuManualDeliveryDedupKey({ ...base })).toBe(first);
    expect(first).not.toContain(base.attemptId);
    expect(first.length).toBeLessThanOrEqual(240);
  });

  it('separates different actors and requests after the API cache expires', () => {
    expect(feishuManualDeliveryDedupKey({ ...base, actorId: randomUUID() })).not.toBe(
      feishuManualDeliveryDedupKey(base),
    );
    expect(
      feishuManualDeliveryDedupKey({
        ...base,
        request: { chatId: 'oc_second', dataVisibilityConfirmed: true },
      }),
    ).not.toBe(feishuManualDeliveryDedupKey(base));
  });
});

describe('Feishu configuration verification state', () => {
  it('preserves a verified configuration after a transient provider failure', () => {
    expect(feishuStatusAfterVerificationFailure('verified', true)).toBe('verified');
    expect(feishuStatusAfterVerificationFailure('configured', true)).toBe('configured');
  });

  it('marks a configuration as errored after a permanent provider rejection', () => {
    expect(feishuStatusAfterVerificationFailure('verified', false)).toBe('error');
  });
});
