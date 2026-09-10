import { describe, expect, it } from 'vitest';
import type { Order } from '@conference/contracts';
import { ADMIN_EVENT_READ_GRANTS, assertEventUpdateGrants } from './admin.module.js';

describe('admin event read permissions', () => {
  it('allows the public-site reader to load the event workspace shell', () => {
    expect(ADMIN_EVENT_READ_GRANTS).toContain('event.site.read');
  });

  it('allows refund reviewers to open refund settings in the event workspace', () => {
    expect(ADMIN_EVENT_READ_GRANTS).toContain('event.order.refund');
  });
});

describe('admin event update permissions', () => {
  const refunds = {
    settings: {
      refunds: { enabled: true, version: 'seven-day-v1' as const, windowDays: 7 as const },
    },
  };
  const registration = { settings: { registration: { registrationOpen: false } } };

  it('lets refund reviewers change only the refund policy', () => {
    expect(() => assertEventUpdateGrants(['event.order.refund'], refunds)).not.toThrow();
    expect(() => assertEventUpdateGrants(['event.order.refund'], registration)).toThrow(
      '报名设置需要大会管理或报名运营权限',
    );
  });

  it('keeps refund policy changes unavailable to registration-only managers', () => {
    expect(() =>
      assertEventUpdateGrants(['event.registration.manage'], registration),
    ).not.toThrow();
    expect(() => assertEventUpdateGrants(['event.registration.manage'], refunds)).toThrow(
      '退款规则需要大会管理或财务退款权限',
    );
  });
});

// Exercise the real controller handler without bypassing its combined permission check.
describe('admin unpaid-order closure endpoint', () => {
  const orderId = '11111111-1111-4111-8111-111111111111';
  const input = { reason: '用户申请重新报名', expectedExpiresAt: '2026-09-10T12:00:00.000Z' };
  async function controller() {
    const { AdminModule } = await import('./admin.module.js');
    const [AdminController] = Reflect.getMetadata('controllers', AdminModule);
    const closeUnpaidOrder = async (...args: unknown[]) => args;
    return {
      close: AdminController.prototype.closeUnpaidOrder.bind({ wechat: { closeUnpaidOrder } }),
      request: (grants: string[]) => ({
        user: { sub: 'actor', organizationId: 'organization', grants },
      }),
    };
  }
  it.each([
    { grants: [] },
    { grants: ['event.registration.manage'] },
    { grants: ['event.order.read'] },
  ])('requires both permissions ($grants)', async ({ grants }) => {
    const c = await controller();
    expect(() => c.close(101, orderId, input, c.request(grants))).toThrow(
      '关闭订单需要报名管理和订单查看权限',
    );
  });
  it('passes only the authenticated organization and actor with validated input', async () => {
    const c = await controller();
    await expect(
      c.close(101, orderId, input, c.request(['event.registration.manage', 'event.order.read'])),
    ).resolves.toEqual([
      orderId,
      101,
      'organization',
      'actor',
      input.reason,
      input.expectedExpiresAt,
    ]);
    expect(() =>
      c.close(101, orderId, { ...input, organizationId: 'injected' }, c.request(['*'])),
    ).toThrow();
    expect(() => c.close(101, 'invalid-id', input, c.request(['*']))).toThrow();
    expect(() => c.close(101, orderId, { ...input, reason: '' }, c.request(['*']))).toThrow();
  });
});

describe('registration endpoints keep batch finances behind order-read permission', () => {
  const order: Order = {
    id: '11111111-1111-4111-8111-111111111111',
    orderNo: 'TOK-BATCH-REVIEW',
    registrationId: null,
    modelVersion: 2,
    quantity: 5,
    version: 3,
    status: 'paid',
    amount: 199500,
    currency: 'CNY',
    paymentMethod: 'wechat',
    expiresAt: '2026-09-10T12:00:00.000Z',
    createdAt: '2026-09-10T11:45:00.000Z',
  };
  const row = {
    id: '22222222-2222-4222-8222-222222222222',
    attendee: { name: '第五位参会人' },
    paidAmount: 39900,
    refundedAmount: 10000,
    order,
  };

  async function controller(grants: string[]) {
    const { AdminModule } = await import('./admin.module.js');
    const [AdminController] = Reflect.getMetadata('controllers', AdminModule);
    const repository = {
      getRegistrationDetail: async () => ({ ...row }),
      listRegistrations: async () => ({ items: [{ ...row }], total: 1, page: 1, pageSize: 10 }),
    };
    const request = { user: { organizationId: 'organization', grants } };
    return {
      detail: () =>
        AdminController.prototype.registrationDetail.call({ repository }, 101, row.id, request),
      list: () =>
        AdminController.prototype.registrations.call({ repository }, 101, 101, request, {}),
    };
  }

  it.each([
    { grants: ['event.registration.read'] },
    { grants: ['event.registration.read', 'event.registration.manage'] },
  ])(
    'omits the whole batch order from detail and list without order-read ($grants)',
    async ({ grants }) => {
      const handlers = await controller(grants);
      const detail = await handlers.detail();
      const list = await handlers.list();
      for (const result of [detail, list.items[0]]) {
        expect(result).not.toHaveProperty('order');
        expect(result).toMatchObject({
          id: row.id,
          attendee: row.attendee,
          paidAmount: 39900,
          refundedAmount: 10000,
        });
      }
      expect(list).toMatchObject({ total: 1, page: 1, pageSize: 10 });
      expect(row.order).toEqual(order);
    },
  );

  it.each([{ grants: ['event.registration.read', 'event.order.read'] }, { grants: ['*'] }])(
    'preserves the batch order for authorized finance readers ($grants)',
    async ({ grants }) => {
      const handlers = await controller(grants);
      expect((await handlers.detail()).order).toEqual(order);
      expect((await handlers.list()).items[0].order).toEqual(order);
    },
  );
});
