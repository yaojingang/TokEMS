import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARTNER_POSTER_FIELDS, DEFAULT_PARTNER_VISIBLE_FIELDS } from '@conference/contracts';
import { customerUsers, eventPartnerProfileVersions, eventPartnerProgramVersions, eventPartners, events } from '@conference/database';
import type { AuthenticatedCustomer } from './customer-auth.service.js';
import type { DatabaseService } from './database.service.js';
import { PartnerDistributionService } from './partner-distribution.service.js';
import type { RedisService } from './redis.service.js';

function fixture(options: { interposeList?: boolean; advanceWriteResponse?: boolean } = {}) {
  const original = {
    id: 'partner', organizationId: 'organization', eventId: 101, customerUserId: 'customer',
    qualificationStatus: 'paused', attributionEnabled: false, settlementHold: false, publicSlug: 'partner-slug',
    currentProgramVersionId: null, acceptedProgramVersionId: null, personalRateBps: null,
    sortOrder: 1, internalNote: '原备注', profileVersion: 1, version: 1,
  };
  const updated = { ...original, sortOrder: 29, internalNote: '同事保存的新备注', profileVersion: 2, version: 2 };
  let current = original;
  const event = { id: 101, organizationId: 'organization', slug: 'conference', name: '测试大会' };
  const user = { id: 'customer', mobileE164: '+8613800138000', status: 'active' };
  const profile = (version: number) => ({
    version, displayName: version === 1 ? '原姓名' : '同事保存的新姓名', company: '', title: '', industry: '',
    businessIntro: '', businessUrl: '', contactPhone: '', contactEmail: '', wechatId: '', avatarAssetId: null,
    gallery: [], publicStatus: 'draft', searchIndexingEnabled: false,
    visibleFields: DEFAULT_PARTNER_VISIBLE_FIELDS, posterFields: DEFAULT_PARTNER_POSTER_FIELDS,
    posterCopy: { invitation: '', introduction: '' },
  });
  function query(transaction: boolean, selection?: Record<string, unknown>) {
    let table: unknown;
    const read = () => {
      if (table === events) return [event];
      if (transaction && table === eventPartnerProgramVersions) return [{ id: 'program' }];
      if (transaction && table === customerUsers) return [{ user, profile: null }];
      if (transaction && table === eventPartnerProfileVersions) return [profile(original.profileVersion)];
      if (table !== eventPartners) return [];
      if (transaction) return [{ ...original }];
      if (selection?.partner) {
        return [{ partner: { ...current }, event, profile: profile(current.profileVersion), loginMobile: user.mobileE164 }];
      }
      const listed = [{ id: current.id, customerUserId: current.customerUserId,
        loginMobile: user.mobileE164, sortOrder: current.sortOrder, internalNote: current.internalNote }];
      if (options.interposeList) current = updated;
      return listed;
    };
    const chain = {
      from(value: unknown) { table = value; return chain; },
      innerJoin() { return chain; }, leftJoin() { return chain; }, where() { return chain; },
      orderBy() { return chain; }, for() { return chain; }, groupBy() { return chain; },
      limit: async () => read(),
      then<TResult1 = unknown[], TResult2 = never>(
        resolve?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
        reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) { return Promise.resolve(read()).then(resolve, reject); },
    };
    return chain;
  }
  const write = {
    set() { return write; }, where() { return write; },
    returning: async () => [{ ...updated }],
  };
  const tx = {
    execute: vi.fn().mockResolvedValue(undefined), select: (selection?: Record<string, unknown>) => query(true, selection),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })), update: vi.fn(() => write),
  };
  const db = {
    select: (selection?: Record<string, unknown>) => query(false, selection),
    transaction: async (callback: (value: typeof tx) => Promise<unknown>) => {
      const result = await callback(tx);
      // A colleague commits after enable's duplicate lookup and before the relationship read.
      current = options.advanceWriteResponse ? { ...updated, version: 3, profileVersion: 3 } : updated;
      return result;
    },
  };
  const service = new PartnerDistributionService({ db } as unknown as DatabaseService, {} as RedisService);
  return { service, tx, updated };
}

describe('partner administrative response snapshots', () => {
  it('returns duplicate-enable metadata from the same row snapshot as version and profile', async () => {
    const { service, tx, updated } = fixture();
    const result = await service.enablePartner('organization', 101, 'staff', {
      customerUserId: 'customer', personalRateBps: null, sortOrder: 0, internalNote: '不得覆盖', sendInvitation: false,
    });
    expect(result).toMatchObject({ created: false, version: updated.version, sortOrder: updated.sortOrder,
      internalNote: updated.internalNote, qualificationStatus: 'paused', attributionEnabled: false,
      profile: { version: updated.profileVersion, displayName: '同事保存的新姓名' } });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('returns list metadata from the same row snapshot after a concurrent details save', async () => {
    const { service, updated } = fixture({ interposeList: true });
    const result = await service.adminPartners('organization', 101);
    expect(result.items).toEqual([expect.objectContaining({ version: updated.version, sortOrder: updated.sortOrder,
      internalNote: updated.internalNote, profile: expect.objectContaining({ version: updated.profileVersion }) })]);
  });

  it('keeps administrative metadata absent from customer relationship responses', async () => {
    const { service } = fixture();
    const result = await service.accountPartnership({ organizationId: 'organization', customerUserId: 'customer' } as AuthenticatedCustomer, 101);
    for (const field of ['loginMobile', 'sortOrder', 'internalNote']) expect(result).not.toHaveProperty(field);
  });

  it('rejects an admin status update response after a second transaction advances its saved version', async () => {
    const { service } = fixture({ advanceWriteResponse: true });
    await expect(service.updatePartner('organization', 101, 'partner', 'staff', {
      expectedVersion: 1, internalNote: '本次修改',
    })).rejects.toMatchObject({ message: expect.stringContaining('请刷新后重试') });
  });

  it('rejects a details response after a second transaction advances its saved version', async () => {
    const { service } = fixture({ advanceWriteResponse: true });
    await expect(service.updatePartnerDetails('organization', 101, 'partner', 'staff', {
      expectedVersion: 1, displayName: '本次修改姓名', company: '', title: '', industry: '', businessIntro: '', businessUrl: '',
      personalRateBps: null, sortOrder: 2, internalNote: '本次修改',
    })).rejects.toMatchObject({ message: expect.stringContaining('请刷新后重试') });
  });

  it('also guards the original version when a no-op details save is followed by a concurrent edit', async () => {
    const { service } = fixture();
    await expect(service.updatePartnerDetails('organization', 101, 'partner', 'staff', {
      expectedVersion: 1, displayName: '原姓名', company: '', title: '', industry: '', businessIntro: '', businessUrl: '',
      personalRateBps: null, sortOrder: 1, internalNote: '原备注',
    })).rejects.toMatchObject({ message: expect.stringContaining('请刷新后重试') });
  });

  it('returns the saved admin version when no later transaction has advanced it', async () => {
    const { service } = fixture();
    const result = await service.updatePartner('organization', 101, 'partner', 'staff', { expectedVersion: 1, internalNote: '本次修改' });
    expect(result.version).toBe(2);
  });

});
