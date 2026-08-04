import { describe, expect, it } from 'vitest';
import { AdminOrderListQuerySchema, AdminOrderListSchema } from './index.js';

describe('admin order list contracts', () => {
  it('uses fixed 20-item pages and validates order filters', () => {
    expect(AdminOrderListQuerySchema.parse({})).toEqual({ page: 1 });
    expect(
      AdminOrderListQuerySchema.parse({ page: '3', q: '13800002101', status: 'paid' }),
    ).toEqual({ page: 3, q: '13800002101', status: 'paid' });
    expect(AdminOrderListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(AdminOrderListQuerySchema.safeParse({ status: 'unknown' }).success).toBe(false);
    expect(
      AdminOrderListSchema.safeParse({ items: [], total: 0, page: 1, pageSize: 20 }).success,
    ).toBe(true);
    expect(
      AdminOrderListSchema.safeParse({ items: [], total: 0, page: 1, pageSize: 50 }).success,
    ).toBe(false);
  });
});
