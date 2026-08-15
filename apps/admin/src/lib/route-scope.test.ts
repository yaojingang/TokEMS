import { describe, expect, it } from 'vitest';
import { parseEventId, routeEventId } from './route-scope.js';

describe('routeEventId', () => {
  it('finds an event below the Docker admin base path', () => {
    expect(routeEventId('/admin/events/101/overview', '/admin/')).toBe(101);
  });

  it('keeps source-development root routing compatible', () => {
    expect(routeEventId('/events/999/orders', '/')).toBe(999);
    expect(routeEventId('/events/1000/orders', '/')).toBe(1000);
    expect(routeEventId('/events/2147483647/orders', '/')).toBe(2_147_483_647);
  });

  it('accepts numeric IDs retained by named route resolution', () => {
    expect(parseEventId(101)).toBe(101);
    expect(parseEventId(2_147_483_647)).toBe(2_147_483_647);
    expect(parseEventId(100)).toBeUndefined();
  });

  it('does not infer an event from an unrelated route', () => {
    expect(routeEventId('/admin/manage/events', '/admin/')).toBeUndefined();
  });

  it('rejects legacy UUID and out-of-range event IDs', () => {
    expect(
      routeEventId('/admin/events/22222222-2222-4222-8222-222222222222/overview', '/admin/'),
    ).toBeUndefined();
    expect(routeEventId('/admin/events/100/overview', '/admin/')).toBeUndefined();
    expect(routeEventId('/admin/events/2147483648/overview', '/admin/')).toBeUndefined();
  });
});
