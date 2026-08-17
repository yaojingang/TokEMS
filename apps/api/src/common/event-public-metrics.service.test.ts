import { describe, expect, it, vi } from 'vitest';
import { DEMO_EVENT } from '@conference/contracts';
import type { ConferenceRepository } from './conference.repository.js';
import { EventPublicMetricsService, isKnownBotUserAgent } from './event-public-metrics.service.js';
import type { RedisService } from './redis.service.js';

const pageView = { pageViewId: '8ab2e19d-7204-4a03-b6db-66239a80364c' };

function setup(redisResult: 'OK' | null | Error = 'OK') {
  const current = {
    pageViews: 12,
    trackingStartedAt: '2026-08-17T03:12:00.000Z',
    updatedAt: '2026-08-17T03:13:00.000Z',
  };
  const repository = {
    getPublicEvent: vi
      .fn()
      .mockResolvedValue({ ...DEMO_EVENT, publicMetrics: DEMO_EVENT.publicMetrics }),
    getPublicEventViewResult: vi.fn().mockResolvedValue(current),
    recordPublicEventView: vi.fn().mockResolvedValue({ ...current, pageViews: 13 }),
  };
  const set =
    redisResult instanceof Error
      ? vi.fn().mockRejectedValue(redisResult)
      : vi.fn().mockResolvedValue(redisResult);
  const redis = { getClient: () => ({ set }) };
  return {
    service: new EventPublicMetricsService(
      repository as unknown as ConferenceRepository,
      redis as unknown as RedisService,
    ),
    repository,
    set,
  };
}

describe('EventPublicMetricsService', () => {
  it('records an accepted browser view once', async () => {
    const { service, repository, set } = setup();

    await expect(
      service.recordView(DEMO_EVENT.slug, 'geo-conference', pageView, 'Mozilla/5.0 Safari/605.1'),
    ).resolves.toMatchObject({ pageViews: 13 });

    expect(set).toHaveBeenCalledWith(
      `public-metrics:view:${DEMO_EVENT.id}:${pageView.pageViewId}`,
      '1',
      'EX',
      600,
      'NX',
    );
    expect(repository.recordPublicEventView).toHaveBeenCalledTimes(1);
  });

  it('returns the current value for a duplicate pageViewId', async () => {
    const { service, repository } = setup(null);

    await expect(
      service.recordView(DEMO_EVENT.slug, 'geo-conference', pageView, 'Mozilla/5.0'),
    ).resolves.toMatchObject({ pageViews: 12 });

    expect(repository.recordPublicEventView).not.toHaveBeenCalled();
    expect(repository.getPublicEventViewResult).toHaveBeenCalledTimes(1);
  });

  it('does not count known robots', async () => {
    const { service, repository, set } = setup();

    await expect(
      service.recordView(DEMO_EVENT.slug, 'geo-conference', pageView, 'Googlebot/2.1'),
    ).resolves.toMatchObject({ pageViews: 12 });

    expect(set).not.toHaveBeenCalled();
    expect(repository.recordPublicEventView).not.toHaveBeenCalled();
    expect(isKnownBotUserAgent('Mozilla/5.0 HeadlessChrome Lighthouse')).toBe(true);
    expect(isKnownBotUserAgent('Mozilla/5.0 Safari/605.1')).toBe(false);
  });

  it('falls back to the atomic database increment when Redis is unavailable', async () => {
    const { service, repository } = setup(new Error('redis unavailable'));

    await expect(
      service.recordView(DEMO_EVENT.slug, 'geo-conference', pageView, 'Mozilla/5.0'),
    ).resolves.toMatchObject({ pageViews: 13 });
    expect(repository.recordPublicEventView).toHaveBeenCalledTimes(1);
  });

  it('propagates the unpublished event rejection before idempotency work', async () => {
    const { service, repository, set } = setup();
    repository.getPublicEvent.mockRejectedValueOnce(new Error('大会不存在或尚未发布'));

    await expect(
      service.recordView('draft-event', 'geo-conference', pageView, 'Mozilla/5.0'),
    ).rejects.toThrow('大会不存在或尚未发布');
    expect(set).not.toHaveBeenCalled();
  });
});
