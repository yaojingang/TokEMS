import { describe, expect, it } from 'vitest';
import { AdminDashboardQuerySchema } from './index';

describe('AdminDashboardQuerySchema', () => {
  it('coerces supported preset day counts from query strings', () => {
    expect(AdminDashboardQuerySchema.parse({ days: '30' })).toEqual({ days: 30 });
    expect(AdminDashboardQuerySchema.safeParse({ days: '0' }).success).toBe(false);
    expect(AdminDashboardQuerySchema.safeParse({ days: '367' }).success).toBe(false);
  });

  it('accepts complete dashboard trend ranges', () => {
    expect(AdminDashboardQuerySchema.parse({ from: '2026-07-06', to: '2026-08-04' })).toEqual({
      from: '2026-07-06',
      to: '2026-08-04',
    });
  });

  it('requires both custom range boundaries in chronological order', () => {
    expect(AdminDashboardQuerySchema.safeParse({ from: '2026-07-06' }).success).toBe(false);
    expect(
      AdminDashboardQuerySchema.safeParse({ from: '2026-08-04', to: '2026-07-06' }).success,
    ).toBe(false);
  });

  it('limits a single trend query to 366 inclusive days', () => {
    expect(
      AdminDashboardQuerySchema.safeParse({ from: '2025-08-04', to: '2026-08-04' }).success,
    ).toBe(true);
    expect(
      AdminDashboardQuerySchema.safeParse({ from: '2025-08-03', to: '2026-08-04' }).success,
    ).toBe(false);
  });

  it('does not mix a preset day count with a custom range', () => {
    expect(
      AdminDashboardQuerySchema.safeParse({
        days: '30',
        from: '2026-07-06',
        to: '2026-08-04',
      }).success,
    ).toBe(false);
  });

  it('rejects year zero before the range reaches PostgreSQL', () => {
    expect(
      AdminDashboardQuerySchema.safeParse({ from: '0000-01-01', to: '0000-01-02' }).success,
    ).toBe(false);
  });
});
