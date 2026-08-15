type NotificationSecretEnvironment = Partial<
  Record<
    'NODE_ENV' | 'DEPLOYMENT_MODE' | 'NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET' | 'JWT_SECRET',
    string
  >
>;

export function notificationPayloadEncryptionSecret(
  environment: NotificationSecretEnvironment = process.env,
) {
  const dedicated = environment.NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET;
  const production =
    environment.NODE_ENV === 'production' || environment.DEPLOYMENT_MODE === 'production';
  if (
    production &&
    (!dedicated ||
      dedicated.length < 32 ||
      [
        'conference-local-notification-payload-secret-2026',
        'replace-with-at-least-32-random-characters',
      ].includes(dedicated))
  ) {
    throw new Error(
      'NOTIFICATION_PAYLOAD_ENCRYPTION_SECRET with at least 32 characters is required in production',
    );
  }
  return (
    dedicated ?? environment.JWT_SECRET ?? 'conference-notification-payload-development-secret'
  );
}
