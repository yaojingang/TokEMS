import { describe, expect, it, vi } from 'vitest';
import { routeRegistrationNotification } from './registration-notification-router.js';

describe('registration notification routing', () => {
  it('keeps legacy purchaser submissions on the order-access notification path', async () => {
    const attendeeClaim = vi.fn(async () => undefined);
    const orderAccess = vi.fn(async () => undefined);

    await expect(
      routeRegistrationNotification('RegistrationSubmitted', { attendeeClaim, orderAccess }),
    ).resolves.toBe(true);
    expect(orderAccess).toHaveBeenCalledOnce();
    expect(attendeeClaim).not.toHaveBeenCalled();
  });

  it('routes attendee invitations only to the dedicated claim consumer', async () => {
    const attendeeClaim = vi.fn(async () => undefined);
    const orderAccess = vi.fn(async () => undefined);

    await expect(
      routeRegistrationNotification('AttendeeClaimInvitationRequested', {
        attendeeClaim,
        orderAccess,
      }),
    ).resolves.toBe(true);
    expect(attendeeClaim).toHaveBeenCalledOnce();
    expect(orderAccess).not.toHaveBeenCalled();
  });
});
