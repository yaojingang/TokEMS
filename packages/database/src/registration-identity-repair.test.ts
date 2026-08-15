import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  planRegistrationIdentityRepairs,
  repairRegistrationIdentities,
  type RegistrationIdentityCandidate,
} from './registration-identity-repair.js';

afterEach(() => vi.restoreAllMocks());

function candidate(
  id: string,
  overrides: Partial<RegistrationIdentityCandidate> = {},
): RegistrationIdentityCandidate {
  return {
    id,
    organizationId: '11111111-1111-4111-8111-111111111111',
    eventId: 101,
    registrationCode: `TOK-${id}`,
    status: 'cancelled',
    customerUserId: '22222222-2222-4222-8222-222222222222',
    attendeeMobileE164: '+8613900139000',
    createdAt: new Date(`2026-08-04T0${id}:00:00.000Z`),
    orderId: `33333333-3333-4333-8333-33333333333${id}`,
    orderStatus: 'closed',
    paymentCount: 0,
    refundCount: 0,
    invoiceCount: 0,
    ticketCount: 0,
    checkinCount: 0,
    ...overrides,
  };
}

describe('planRegistrationIdentityRepairs', () => {
  it('returns no work when registration identities are unique', () => {
    const plan = planRegistrationIdentityRepairs([
      candidate('1'),
      candidate('2', {
        customerUserId: '22222222-2222-4222-8222-222222222223',
        attendeeMobileE164: '+8613900139001',
      }),
    ]);

    expect(plan.groups).toEqual([]);
    expect(plan.blocked).toBe(false);
  });

  it('keeps the earliest record when every duplicate is closed and fact-free', () => {
    const plan = planRegistrationIdentityRepairs([candidate('1'), candidate('2')]);

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({
      canonicalId: '1',
      supersededIds: ['2'],
      blockedReasons: [],
    });
  });

  it('keeps the single open record ahead of closed fact-free duplicates', () => {
    const plan = planRegistrationIdentityRepairs([
      candidate('1'),
      candidate('2', { status: 'pending_payment', orderStatus: 'pending_payment' }),
    ]);

    expect(plan.groups[0]).toMatchObject({
      canonicalId: '2',
      supersededIds: ['1'],
      blockedReasons: [],
    });
  });

  it('keeps the single record with business facts', () => {
    const plan = planRegistrationIdentityRepairs([
      candidate('1'),
      candidate('2', { paymentCount: 1, orderStatus: 'paid', status: 'confirmed' }),
    ]);

    expect(plan.groups[0]).toMatchObject({
      canonicalId: '2',
      supersededIds: ['1'],
      blockedReasons: [],
    });
  });

  it('blocks groups with facts on multiple records', () => {
    const plan = planRegistrationIdentityRepairs([
      candidate('1', { paymentCount: 1 }),
      candidate('2', { invoiceCount: 1 }),
    ]);

    expect(plan.blocked).toBe(true);
    expect(plan.groups[0]?.blockedReasons).toContain('MULTIPLE_RECORDS_WITH_BUSINESS_FACTS');
  });

  it('treats attendee showcase content as a retained business fact', () => {
    const plan = planRegistrationIdentityRepairs([
      candidate('1'),
      candidate('2', { showcaseCount: 1 }),
    ]);

    expect(plan.groups[0]).toMatchObject({
      canonicalId: '2',
      supersededIds: ['1'],
      blockedReasons: [],
    });
  });

  it('blocks groups with multiple open orders', () => {
    const plan = planRegistrationIdentityRepairs([
      candidate('1', { status: 'pending_payment', orderStatus: 'pending_payment' }),
      candidate('2', { status: 'pending_review', orderStatus: 'pending_review' }),
    ]);

    expect(plan.blocked).toBe(true);
    expect(plan.groups[0]?.blockedReasons).toContain('MULTIPLE_OPEN_ORDERS');
  });

  it('blocks groups containing a registration without its required order', () => {
    const plan = planRegistrationIdentityRepairs([
      candidate('1', { orderId: null, orderStatus: null }),
      candidate('2'),
    ]);

    expect(plan.blocked).toBe(true);
    expect(plan.groups[0]?.blockedReasons).toContain('MISSING_ORDER');
  });

  it('blocks connected duplicates whose customer and mobile identities cross', () => {
    const plan = planRegistrationIdentityRepairs([
      candidate('1'),
      candidate('2', { attendeeMobileE164: '+8613900139001' }),
      candidate('3', {
        customerUserId: '22222222-2222-4222-8222-222222222223',
        attendeeMobileE164: '+8613900139001',
      }),
    ]);

    expect(plan.blocked).toBe(true);
    expect(plan.groups[0]?.blockedReasons).toContain('CROSS_IDENTITY_CONFLICT');
  });
});

describe('repairRegistrationIdentities', () => {
  it('rolls the whole apply transaction back when a write fails', async () => {
    const rows = [candidate('1'), candidate('2')];
    const query = vi.fn().mockImplementation(async (statement: string) => {
      if (statement.includes('select\n    r.id')) return { rows };
      if (statement.trimStart().startsWith('update registrations')) {
        throw new Error('simulated write failure');
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await expect(
      repairRegistrationIdentities(pool as never, true),
    ).rejects.toThrow('simulated write failure');
    expect(query).toHaveBeenCalledWith('rollback');
    expect(query).not.toHaveBeenCalledWith('commit');
    expect(release).toHaveBeenCalledOnce();
  });
});
