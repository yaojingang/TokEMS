export interface RegistrationNotificationHandlers {
  attendeeClaim(): Promise<unknown>;
  orderAccess(): Promise<unknown>;
}

export async function routeRegistrationNotification(
  eventType: unknown,
  handlers: RegistrationNotificationHandlers,
) {
  if (eventType === 'AttendeeClaimInvitationRequested') {
    await handlers.attendeeClaim();
    return true;
  }
  if (eventType === 'RegistrationSubmitted') {
    await handlers.orderAccess();
    return true;
  }
  return false;
}
