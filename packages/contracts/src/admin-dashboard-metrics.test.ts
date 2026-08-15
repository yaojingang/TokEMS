import { describe, expect, it } from 'vitest';
import { AdminDashboardSchema } from './index.js';

describe('admin dashboard metric contract', () => {
  it('keeps order, seat, attendee, purchaser, and net-revenue metrics distinct', () => {
    const dashboard = AdminDashboardSchema.parse({
      eventId: 101,
      eventName: '指标口径大会',
      updatedAt: '2026-08-15T00:00:00.000Z',
      metrics: {
        registrations: 8,
        paidOrders: 3,
        paidSeats: 2,
        confirmedAttendees: 4,
        purchasers: 2,
        revenue: 59_800,
        checkedIn: 1,
        conversionRate: 25,
        pendingReview: 2,
      },
      registrationTrend: [],
      ticketBreakdown: [],
    });

    expect(dashboard.metrics).toMatchObject({
      paidOrders: 3,
      paidSeats: 2,
      confirmedAttendees: 4,
      purchasers: 2,
      revenue: 59_800,
    });
  });
});
