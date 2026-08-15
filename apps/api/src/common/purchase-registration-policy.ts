import type { PublicEvent } from '@conference/contracts';

type RegistrationSettings = PublicEvent['registration'];

export interface EventRegistrationSettingsSource {
  currentReleaseId?: string;
  registration?: Partial<RegistrationSettings>;
}

export interface RegistrationReleaseSnapshot {
  event?: {
    settings?: {
      registration?: Partial<RegistrationSettings>;
    };
  };
}

export function normalizeRegistrationSettings(value: unknown): RegistrationSettings {
  const settings =
    value && typeof value === 'object' ? (value as Partial<RegistrationSettings>) : {};
  return {
    paymentMode: settings.paymentMode === 'free' ? 'free' : 'ticketed',
    currency: 'CNY',
    registrationOpen: settings.registrationOpen !== false,
    accountMode: 'mobile_otp_required',
    additionalPurchaseEnabled: settings.additionalPurchaseEnabled === true,
    maxActiveSeatsPerPurchaser:
      typeof settings.maxActiveSeatsPerPurchaser === 'number' &&
      Number.isInteger(settings.maxActiveSeatsPerPurchaser) &&
      settings.maxActiveSeatsPerPurchaser >= 1 &&
      settings.maxActiveSeatsPerPurchaser <= 20
        ? settings.maxActiveSeatsPerPurchaser
        : 5,
  };
}

export function resolvePublishedRegistrationSettings(
  eventSettings: EventRegistrationSettingsSource,
  releaseSnapshot?: RegistrationReleaseSnapshot,
): RegistrationSettings {
  return normalizeRegistrationSettings(
    eventSettings.currentReleaseId
      ? releaseSnapshot?.event?.settings?.registration
      : eventSettings.registration,
  );
}
