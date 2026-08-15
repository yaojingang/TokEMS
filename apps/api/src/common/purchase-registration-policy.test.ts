import { describe, expect, it } from 'vitest';
import { resolvePublishedRegistrationSettings } from './purchase-registration-policy.js';

describe('published registration settings', () => {
  it('keeps draft edits out of purchase context until a new release is activated', () => {
    const firstRelease = {
      event: {
        settings: {
          registration: {
            additionalPurchaseEnabled: false,
            maxActiveSeatsPerPurchaser: 2,
          },
        },
      },
    };
    const eventSettings = {
      currentReleaseId: 'release-1',
      registration: {
        additionalPurchaseEnabled: true,
        maxActiveSeatsPerPurchaser: 9,
      },
    };

    expect(resolvePublishedRegistrationSettings(eventSettings, firstRelease)).toMatchObject({
      additionalPurchaseEnabled: false,
      maxActiveSeatsPerPurchaser: 2,
    });
    expect(
      resolvePublishedRegistrationSettings(
        {
          ...eventSettings,
          registration: {
            additionalPurchaseEnabled: true,
            maxActiveSeatsPerPurchaser: 12,
          },
        },
        firstRelease,
      ),
    ).toMatchObject({
      additionalPurchaseEnabled: false,
      maxActiveSeatsPerPurchaser: 2,
    });
    expect(
      resolvePublishedRegistrationSettings(
        { ...eventSettings, currentReleaseId: 'release-2' },
        {
          event: {
            settings: {
              registration: {
                additionalPurchaseEnabled: true,
                maxActiveSeatsPerPurchaser: 7,
              },
            },
          },
        },
      ),
    ).toMatchObject({
      additionalPurchaseEnabled: true,
      maxActiveSeatsPerPurchaser: 7,
    });
  });

  it('uses the live settings only for a legacy event without a current release', () => {
    expect(
      resolvePublishedRegistrationSettings({
        registration: {
          additionalPurchaseEnabled: true,
          maxActiveSeatsPerPurchaser: 4,
        },
      }),
    ).toMatchObject({
      additionalPurchaseEnabled: true,
      maxActiveSeatsPerPurchaser: 4,
    });
  });
});
