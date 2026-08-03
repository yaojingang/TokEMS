import { describe, expect, it } from 'vitest';
import { EventContextOptionSchema } from './index.js';

describe('administrator event context option contract', () => {
  it('accepts the compact event identity used by entry resolution and switching', () => {
    expect(
      EventContextOptionSchema.parse({
        id: 101,
        slug: 'shenzhen-2026',
        name: '深圳大会 2026',
        shortName: '深圳大会',
        status: 'registration_open',
        startsAt: '2026-08-18T01:00:00.000Z',
        endsAt: '2026-08-20T10:00:00.000Z',
        city: '深圳',
        registrationCount: 317,
      }),
    ).toEqual({
      id: 101,
      slug: 'shenzhen-2026',
      name: '深圳大会 2026',
      shortName: '深圳大会',
      status: 'registration_open',
      startsAt: '2026-08-18T01:00:00.000Z',
      endsAt: '2026-08-20T10:00:00.000Z',
      city: '深圳',
      registrationCount: 317,
    });
  });

  it('rejects invalid event identifiers and registration counts', () => {
    const input = {
      id: 100,
      slug: 'shenzhen-2026',
      name: '深圳大会 2026',
      shortName: '深圳大会',
      status: 'registration_open',
      startsAt: '2026-08-18T01:00:00.000Z',
      endsAt: '2026-08-20T10:00:00.000Z',
      city: '深圳',
      registrationCount: -1,
    };

    expect(EventContextOptionSchema.safeParse(input).success).toBe(false);
  });
});
