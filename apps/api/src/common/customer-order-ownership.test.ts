import { describe, expect, it } from 'vitest';
import {
  customerCanManageOrder,
  purchaserCanAccessTicket,
} from './customer-order-ownership.js';

describe('customer order ownership', () => {
  it('uses the explicit purchaser and blocks a different claimed attendee', () => {
    expect(customerCanManageOrder('buyer', 'intent-id', 'attendee', 'buyer')).toBe(true);
    expect(customerCanManageOrder('buyer', 'intent-id', 'attendee', 'attendee')).toBe(false);
  });

  it('falls back to the attendee only for a legacy order without a purchaser or intent', () => {
    expect(customerCanManageOrder(null, null, 'legacy-attendee', 'legacy-attendee')).toBe(true);
    expect(customerCanManageOrder(null, null, 'legacy-attendee', 'other')).toBe(false);
  });

  it('keeps a modern proxy order finance-blind after the purchaser account is deleted', () => {
    expect(
      customerCanManageOrder(null, 'modern-intent', 'claimed-attendee', 'claimed-attendee'),
    ).toBe(false);
  });

  it('keeps attendee tickets private from proxy purchasers before and after claim', () => {
    expect(purchaserCanAccessTicket('buyer', 'intent-id', 'buyer', 'self')).toBe(true);
    expect(purchaserCanAccessTicket('buyer', 'intent-id', null, 'other')).toBe(false);
    expect(purchaserCanAccessTicket('buyer', 'intent-id', 'attendee', 'other')).toBe(false);
    expect(purchaserCanAccessTicket(null, null, 'legacy-attendee', undefined)).toBe(true);
  });
});
