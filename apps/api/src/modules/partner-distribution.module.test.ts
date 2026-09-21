import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { grantAllows } from '../common/auth.guard.js';
import { AdminPartnerController } from './partner-distribution.module.js';

const REQUIRED_GRANTS_METADATA = 'conference.required_grants';
const REQUIRED_ALL_GRANTS_METADATA = 'conference.required_all_grants';

describe('partner distribution administration permissions', () => {
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
    const controller = new AdminPartnerController(partners as never, {} as never);
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
    const controller = new AdminPartnerController(partners as never, transfers as never);
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
