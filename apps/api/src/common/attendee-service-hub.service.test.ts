import { describe, expect, it, vi } from 'vitest';
import type { CustomerRegistrationDetail } from '@conference/contracts';
import {
  deriveServiceHubInvoiceItem,
  deriveServiceHubTicketItem,
  serviceHubActionRequiredCount,
} from './attendee-service-hub.service.js';
import { TemplateOperationsService } from './template-operations.service.js';

function registration(patch: Partial<CustomerRegistrationDetail> = {}): CustomerRegistrationDetail {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    eventId: 101,
    eventName: '大会',
    eventSlug: 'tokems26',
    startsAt: '2026-11-21T01:00:00.000Z',
    endsAt: '2026-11-22T09:00:00.000Z',
    registrationCode: 'TOK-R-001',
    registrationStatus: 'confirmed',
    attendeeName: '参会者',
    ticketTypeName: '大会通票',
    ticketCode: 'TOK-T-001',
    ticketStatus: 'valid',
    createdAt: '2026-08-30T01:00:00.000Z',
    canManageOrder: true,
    orderId: '20000000-0000-4000-8000-000000000001',
    orderNo: 'ORDER-001',
    orderStatus: 'paid',
    amount: 199900,
    currency: 'CNY',
    invoiceId: null,
    invoiceStatus: null,
    attendee: {
      name: '参会者',
      mobile: '138****0000',
      email: '',
      company: '示例公司',
      title: '市场负责人',
      city: '上海',
    },
    ...patch,
  } as CustomerRegistrationDetail;
}

describe('attendee service hub state derivation', () => {
  it('marks paid tickets complete and payment-required tickets as attention', () => {
    expect(deriveServiceHubTicketItem(registration()).state).toBe('complete');
    expect(
      deriveServiceHubTicketItem(
        registration({
          registrationStatus: 'pending_payment',
          ticketCode: null,
          ticketStatus: null,
        }),
      ).state,
    ).toBe('attention');
  });

  it('distinguishes failed and processing payment attempts', () => {
    const pending = registration({
      registrationStatus: 'pending_payment',
      ticketCode: null,
      ticketStatus: null,
    });
    expect(deriveServiceHubTicketItem(pending, 'failed')).toMatchObject({
      state: 'attention',
      label: '上一笔支付未完成',
    });
    expect(deriveServiceHubTicketItem(pending, 'processing')).toMatchObject({
      state: 'available',
      label: '支付结果确认中',
    });
  });

  it('keeps cancelled tickets unavailable and non-purchaser invoices private', () => {
    expect(
      deriveServiceHubTicketItem(
        registration({ registrationStatus: 'cancelled', ticketStatus: 'cancelled' }),
      ).state,
    ).toBe('unavailable');
    expect(
      deriveServiceHubInvoiceItem(
        registration({
          canManageOrder: false,
          orderId: null,
          orderNo: null,
          orderStatus: null,
          amount: null,
          currency: null,
          invoiceId: null,
          invoiceStatus: null,
        }),
      ),
    ).toMatchObject({ state: 'unavailable', label: '由购票人管理' });
  });

  it('excludes poster and invoice states from the fixed completion count', () => {
    expect(
      serviceHubActionRequiredCount([
        { code: 'ticket', state: 'attention', label: '待支付', description: '完成支付' },
        { code: 'poster', state: 'attention', label: '海报失效', description: '仍可查看' },
        { code: 'showcase', state: 'pending', label: '待完善', description: '完善名片' },
        { code: 'invoice', state: 'attention', label: '待补资料', description: '补充资料' },
      ]),
    ).toBe(2);
  });
});

describe('organizer QR asset isolation', () => {
  it('returns not found when the generic public query excludes a private-purpose asset', async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const database = {
      db: {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({ limit })),
          })),
        })),
      },
    };
    const templates = new TemplateOperationsService(database as never);

    await expect(
      templates.publicAssetUrl('30000000-0000-4000-8000-000000000001'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
