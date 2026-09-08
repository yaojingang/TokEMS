import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_EVENT } from '@conference/contracts';
import { useConferenceApi } from './useConferenceApi';

describe('public event speaker images', () => {
  beforeEach(() => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      apiInternalBase: 'http://api:4100/api/v1',
      public: { apiBase: '/api/v1', organizationSlug: 'geo-conference' },
    }));
    vi.stubGlobal('useState', (_key: string, initialize: () => unknown) => ({
      value: initialize(),
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(['getHomepageEvent', 'getEvent'] as const)(
    '%s resolves uploaded speaker images against the public API',
    async (method) => {
      const event = structuredClone(DEMO_EVENT);
      event.speakers = [
        { ...event.speakers[0]!, avatarUrl: '/assets/templates/speaker-avatar' },
        { ...event.speakers[1]!, avatarUrl: 'https://images.example.com/speaker.jpg' },
        { ...event.speakers[2]!, avatarUrl: undefined },
      ];
      vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(event));
      const api = useConferenceApi();

      const result = await api[method]();

      expect(result.speakers.map((speaker) => speaker.avatarUrl)).toEqual([
        '/api/v1/assets/templates/speaker-avatar',
        'https://images.example.com/speaker.jpg',
        undefined,
      ]);
      expect(api.readEvent()?.speakers[0]?.avatarUrl).toBe(
        '/api/v1/assets/templates/speaker-avatar',
      );
    },
  );
});
