import { describe, expect, it, vi } from 'vitest';
import { sealSecret } from '@conference/security';
import {
  consumeAttendeeClaimInvitation,
  type AttendeeClaimDeliveryInput,
  type AttendeeClaimInvitationDependencies,
  type AttendeeClaimNotificationInput,
} from './attendee-claim-invitation.worker.js';

const encryptionSecret = 'worker-attendee-claim-test-secret-at-least-32-chars';
const rawClaimToken = 'claim-token-that-is-long-enough-for-a-one-time-secret';

function eventPayload() {
  return {
    registrationId: '11111111-1111-4111-8111-111111111111',
    recipientRole: 'attendee',
    recipient: 'attendee@example.com',
    sealedAttendeeClaimToken: sealSecret(rawClaimToken, encryptionSecret),
  };
}

function dependencies() {
  const ensureDelivery = vi.fn(async (input: AttendeeClaimDeliveryInput) => input.id);
  const deliverNotification = vi.fn(async (_input: AttendeeClaimNotificationInput) => undefined);
  const findActiveClaim = vi.fn<AttendeeClaimInvitationDependencies['findActiveClaim']>(
    async () => ({
      organizationId: '22222222-2222-4222-8222-222222222222',
      eventId: 101,
      eventName: 'GEO 大会',
      eventSlug: 'geo-2026',
      eventTimezone: 'Asia/Shanghai',
      attendeeName: '陈星河',
      recipient: 'attendee@example.com',
      expiresAt: new Date('2026-09-15T08:00:00.000Z'),
    }),
  );
  return {
    encryptionSecret,
    publicSiteUrl: 'https://conference.example.com',
    ensureDelivery,
    deliverNotification,
    findActiveClaim,
  };
}

describe('attendee claim invitation worker', () => {
  it('opens the sealed secret and sends a registration-only attendee claim URL', async () => {
    const deps = dependencies();

    await consumeAttendeeClaimInvitation(
      {
        payload: eventPayload(),
        correlationId: 'attendee-claim:registration-1',
        jobId: 'job-1',
      },
      deps,
    );

    expect(deps.findActiveClaim).toHaveBeenCalledWith(
      eventPayload().registrationId,
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(deps.ensureDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationId: eventPayload().registrationId,
        recipient: 'attendee@example.com',
        subject: 'GEO 大会 参会名额认领',
      }),
    );
    const delivery = deps.deliverNotification.mock.calls[0]?.[0];
    expect(delivery?.body).toContain('/account/attendee-claim?event=geo-2026#');
    expect(delivery?.body).toContain(encodeURIComponent(rawClaimToken));
    expect(delivery?.body).not.toContain('/order/');
    expect(delivery?.body).not.toMatch(/金额|发票|支付/);
    expect(delivery?.smsContext).toMatchObject({
      templateKey: 'registrationSubmitted',
      parameters: expect.objectContaining({
        eventName: 'GEO 大会',
        url: expect.stringContaining('/account/attendee-claim?event=geo-2026#'),
      }),
    });
    expect(JSON.stringify(deps.ensureDelivery.mock.calls[0]?.[0])).not.toContain(rawClaimToken);
  });

  it('uses a deterministic delivery id so retries remain idempotent', async () => {
    const deps = dependencies();
    const event = {
      payload: eventPayload(),
      correlationId: 'attendee-claim:registration-1',
      jobId: 'job-1',
    };

    await consumeAttendeeClaimInvitation(event, deps);
    await consumeAttendeeClaimInvitation({ ...event, jobId: 'job-retry' }, deps);

    expect(deps.ensureDelivery.mock.calls[0]?.[0]).toMatchObject({
      id: deps.ensureDelivery.mock.calls[1]?.[0]?.id,
    });
    expect(deps.deliverNotification.mock.calls[0]?.[0]).toMatchObject({
      deliveryId: deps.deliverNotification.mock.calls[1]?.[0]?.deliveryId,
    });
  });

  it('drops a revoked invitation after an order restoration rotates its claim token', async () => {
    const deps = dependencies();
    deps.findActiveClaim.mockResolvedValueOnce(null);

    await expect(
      consumeAttendeeClaimInvitation(
        {
          payload: eventPayload(),
          correlationId: 'attendee-claim:stale-before-restore',
        },
        deps,
      ),
    ).resolves.toEqual({ status: 'stale' });
    expect(deps.ensureDelivery).not.toHaveBeenCalled();
    expect(deps.deliverNotification).not.toHaveBeenCalled();
  });

  it('rejects legacy raw claim secrets and never routes them to an order notification', async () => {
    const deps = dependencies();

    await expect(
      consumeAttendeeClaimInvitation(
        {
          payload: {
            registrationId: eventPayload().registrationId,
            recipientRole: 'attendee',
            recipient: 'attendee@example.com',
            attendeeClaimToken: rawClaimToken,
          },
          correlationId: 'legacy-raw-token',
        },
        deps,
      ),
    ).rejects.toThrow('sealedAttendeeClaimToken');
    expect(deps.ensureDelivery).not.toHaveBeenCalled();
    expect(deps.deliverNotification).not.toHaveBeenCalled();
  });
});
