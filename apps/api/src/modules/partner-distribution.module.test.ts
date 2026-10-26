import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { grantAllows } from '../common/auth.guard.js';
import { AdminPartnerController } from './partner-distribution.module.js';

const REQUIRED_GRANTS_METADATA = 'conference.required_grants';
const REQUIRED_ALL_GRANTS_METADATA = 'conference.required_all_grants';

describe('partner distribution administration permissions', () => {
  it('protects read-only promotion materials without financial grants and prevents caching', async () => {
    for (const handler of ['promotion', 'promotionAvatar'] as const) {
      expect(Reflect.getMetadata(REQUIRED_GRANTS_METADATA, AdminPartnerController.prototype[handler])).toEqual(['event.partner.read', 'event.partner.manage']);
    }
    const partners = { adminPromotion: vi.fn().mockResolvedValue({ id: 'partner' }), adminPromotionAvatarScope: vi.fn().mockResolvedValue({ organizationId: 'org', customerUserId: 'customer', assetId: 'avatar' }) };
    const showcase = { partnerMediaContent: vi.fn().mockResolvedValue(Buffer.from('image')) };
    const controller = new AdminPartnerController(partners as never, {} as never, showcase as never);
    const request = { user: { organizationId: 'org' } } as never;
    const reply = { header: vi.fn(), send: vi.fn() }; reply.header.mockReturnValue(reply);
    await controller.promotion(request, 101, 'partner', reply as never);
    await controller.promotionAvatar(request, 101, 'partner', 3, reply as never);
    expect(partners.adminPromotion).toHaveBeenCalledWith('org', 101, 'partner');
    expect(partners.adminPromotionAvatarScope).toHaveBeenCalledWith('org', 101, 'partner', 3);
    expect(showcase.partnerMediaContent).toHaveBeenCalledWith('org', 'customer', 'avatar');
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });
  it('scopes staff avatar upload, confirmation and status to the target partner with manage permission', async () => {
    for (const name of ['preparePartnerMedia', 'confirmPartnerMedia', 'partnerMediaStatus'] as const) {
      expect(Reflect.getMetadata(REQUIRED_GRANTS_METADATA, AdminPartnerController.prototype[name])).toEqual(['event.partner.manage']);
    }
    const scope = { organizationId: 'org', customerUserId: 'target' };
    const partners = { adminPartnerMediaScope: vi.fn().mockResolvedValue(scope), adminPartnerMediaStatus: vi.fn().mockResolvedValue({ status: 'ready' }) };
    const showcase = { preparePartnerMediaUpload: vi.fn().mockResolvedValue({ uploadToken: 'token' }), confirmPartnerMedia: vi.fn().mockResolvedValue({ status: 'processing' }) };
    const controller = new AdminPartnerController(partners as never, {} as never, showcase as never);
    const request = { user: { organizationId: 'org', sub: 'staff' } } as never;
    const input = { kind: 'avatar', fileName: 'avatar.png', mediaType: 'image/png', size: 12, contentDigest: '0'.repeat(64) };
    const reply = { header: vi.fn() }; reply.header.mockReturnValue(reply);
    await controller.preparePartnerMedia(request, 101, 'partner', input, reply as never);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    reply.header.mockClear();
    const confirmation = { uploadToken: '00000000-0000-4000-8000-000000000001', contentDigest: input.contentDigest };
    await controller.confirmPartnerMedia(request, 101, 'partner', confirmation, reply as never);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    reply.header.mockClear();
    await controller.partnerMediaStatus(request, 101, 'partner', confirmation.uploadToken, reply as never);
    expect(partners.adminPartnerMediaScope).toHaveBeenCalledWith('org', 101, 'partner', confirmation.uploadToken);
    expect(showcase.preparePartnerMediaUpload).toHaveBeenCalledWith(scope, 101, input, { actorId: 'staff', partnerId: 'partner' });
    expect(showcase.confirmPartnerMedia).toHaveBeenCalledWith(scope, 101, confirmation, { actorId: 'staff', partnerId: 'partner' });
    expect(partners.adminPartnerMediaStatus).toHaveBeenCalledWith('org', 101, 'partner', confirmation.uploadToken);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    await expect(controller.preparePartnerMedia(request, 101, 'partner', { ...input, kind: 'gallery' }, reply as never)).rejects.toThrow();
  });

  it('requires an explicit financial grant and prevents caching of recipient details', async () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_GRANTS_METADATA,
        AdminPartnerController.prototype.recipientDetails,
      ),
    ).toEqual(['event.payout.review', 'event.payout.execute']);
    for (const grants of [['event.*'], ['event.partner.manage'], ['event.commission.read']]) {
      expect(
        ['event.payout.review', 'event.payout.execute'].some((grant) => grantAllows(grants, grant)),
      ).toBe(false);
    }
    const partners = { recipientDetails: vi.fn().mockResolvedValue({ id: 'recipient' }) };
    const controller = new AdminPartnerController(partners as never, {} as never, {} as never);
    const reply = { header: vi.fn() };
    reply.header.mockReturnValue(reply);
    await controller.recipientDetails(
      { user: { organizationId: 'org', sub: 'reviewer' } } as never,
      42,
      'recipient',
      reply as never,
    );
    expect(partners.recipientDetails).toHaveBeenCalledWith('org', 42, 'recipient', 'reviewer');
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(reply.header).toHaveBeenCalledWith('Pragma', 'no-cache');
  });

  it('keeps payout review, execution, and export as explicit financial grants', () => {
    expect(grantAllows(['event.*'], 'event.partner.manage')).toBe(true);
    expect(grantAllows(['event.*'], 'event.commission.read')).toBe(true);
    expect(grantAllows(['event.*'], 'event.commission.manage')).toBe(false);
    expect(grantAllows(['event.*'], 'event.payout.review')).toBe(false);
    expect(grantAllows(['event.*'], 'event.payout.execute')).toBe(false);
    expect(grantAllows(['event.*'], 'event.payout.export')).toBe(false);
    expect(grantAllows(['event.payout.execute'], 'event.payout.execute')).toBe(true);
  });

  it('requires both payout review and execution to create a batch', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_ALL_GRANTS_METADATA,
        AdminPartnerController.prototype.createBatch,
      ),
    ).toEqual(['event.payout.review', 'event.payout.execute']);
  });

  it('protects transfer execution and reconciliation exports independently', () => {
    expect(
      Reflect.getMetadata(REQUIRED_GRANTS_METADATA, AdminPartnerController.prototype.payouts),
    ).toEqual(['event.payout.review']);
    expect(
      Reflect.getMetadata(REQUIRED_GRANTS_METADATA, AdminPartnerController.prototype.executeBatch),
    ).toEqual(['event.payout.execute']);
    expect(
      Reflect.getMetadata(REQUIRED_GRANTS_METADATA, AdminPartnerController.prototype.exportPayouts),
    ).toEqual(['event.payout.export']);
    expect(
      Reflect.getMetadata(
        REQUIRED_GRANTS_METADATA,
        AdminPartnerController.prototype.adjustCommission,
      ),
    ).toEqual(['event.commission.manage']);
    expect(
      Reflect.getMetadata(
        REQUIRED_GRANTS_METADATA,
        AdminPartnerController.prototype.createReconciliation,
      ),
    ).toEqual(['event.payout.execute']);
  });

  it('forwards the route event scope to every resource-specific payout operation', async () => {
    const partners = {
      approvePayoutBatch: vi.fn().mockResolvedValue({}),
      exportPayouts: vi.fn().mockResolvedValue([]),
      verifyRecipient: vi.fn().mockResolvedValue({}),
    };
    const transfers = {
      executeBatch: vi.fn().mockResolvedValue({}),
      queryExecution: vi.fn().mockResolvedValue({}),
    };
    const controller = new AdminPartnerController(partners as never, transfers as never, {} as never);
    const request = { user: { organizationId: 'organization-1', sub: 'staff-1' } } as never;
    const batchId = '00000000-0000-4000-8000-000000000001';
    const executionId = '00000000-0000-4000-8000-000000000002';
    const recipientId = '00000000-0000-4000-8000-000000000003';

    await controller.reviewBatch(request, 42, batchId, {
      expectedVersion: 1,
      decision: 'approve',
      reason: '复核信息完整，同意执行',
    });
    await controller.executeBatch(request, 42, batchId, { expectedVersion: 2 });
    await controller.queryExecution(request, 42, executionId, { expectedVersion: 3 });
    await controller.verifyRecipient(request, 42, recipientId);
    const reply = {
      header: vi.fn(),
      send: vi.fn(),
    };
    reply.header.mockReturnValue(reply);
    await controller.exportPayouts(request, 42, reply as never);

    expect(partners.approvePayoutBatch).toHaveBeenCalledWith(
      'organization-1',
      42,
      batchId,
      'staff-1',
      expect.objectContaining({ expectedVersion: 1 }),
    );
    expect(transfers.executeBatch).toHaveBeenCalledWith(
      'organization-1',
      42,
      batchId,
      'staff-1',
      2,
    );
    expect(transfers.queryExecution).toHaveBeenCalledWith('organization-1', 42, executionId, 3);
    expect(partners.verifyRecipient).toHaveBeenCalledWith(
      'organization-1',
      42,
      recipientId,
      'staff-1',
    );
    expect(partners.exportPayouts).toHaveBeenCalledWith('organization-1', 42, 'staff-1');
  });
});
