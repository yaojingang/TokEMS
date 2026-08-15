import { describe, expect, it } from 'vitest';
import { legacyContentWorkspaceRoute } from './legacy-content-route';

describe('legacy content workspace redirects', () => {
  it('preserves event scope, query, and explicit hashes', () => {
    expect(
      legacyContentWorkspaceRoute(
        { eventId: '00000000-0000-4000-8000-000000000001' },
        { source: 'bookmark' },
        '#ai-copy',
      ),
    ).toEqual({
      name: 'event-settings-general',
      params: { eventId: '00000000-0000-4000-8000-000000000001' },
      query: { source: 'bookmark' },
      hash: '#ai-copy',
    });
  });

  it('lands removed content pages in the public-page settings section by default', () => {
    expect(legacyContentWorkspaceRoute({ eventId: 'event-1' }, {}, '')).toMatchObject({
      name: 'event-settings-general',
      hash: '#public-page',
    });
  });
});
