import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from './database.service.js';
import { EventOperationsService } from './event-operations.service.js';

describe('administrator event context options', () => {
  it('returns compact event identities with one database query', async () => {
    const rows = [
      {
        event: {
          id: 101,
          slug: 'shenzhen-2026',
          name: '深圳大会 2026',
          shortName: '深圳大会',
          status: 'registration_open',
          startsAt: new Date('2026-08-18T01:00:00.000Z'),
          endsAt: new Date('2026-08-20T10:00:00.000Z'),
          city: '深圳',
        },
        registrationCount: 317,
      },
    ];
    const query = {
      from: vi.fn(),
      leftJoin: vi.fn(),
      where: vi.fn(),
      groupBy: vi.fn(),
      orderBy: vi.fn(),
    };
    query.from.mockReturnValue(query);
    query.leftJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.groupBy.mockReturnValue(query);
    query.orderBy.mockResolvedValue(rows);
    const select = vi.fn().mockReturnValue(query);
    const service = new EventOperationsService({ db: { select } } as unknown as DatabaseService);

    await expect(service.listEventOptions('organization-1')).resolves.toEqual([
      {
        id: 101,
        slug: 'shenzhen-2026',
        name: '深圳大会 2026',
        shortName: '深圳大会',
        status: 'registration_open',
        startsAt: '2026-08-18T01:00:00.000Z',
        endsAt: '2026-08-20T10:00:00.000Z',
        city: '深圳',
        registrationCount: 317,
      },
    ]);
    expect(select).toHaveBeenCalledOnce();
  });
});
