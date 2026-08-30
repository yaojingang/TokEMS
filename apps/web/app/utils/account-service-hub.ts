import type {
  CustomerPurchasedOrder,
  CustomerRegistrationSummary,
  CustomerServiceHubItem,
} from '@conference/contracts';

export function selectFeaturedRegistration(
  registrations: CustomerRegistrationSummary[],
  requestedEventSlug: string | null,
  now = new Date(),
) {
  const requested = requestedEventSlug
    ? registrations.find((item) => item.eventSlug === requestedEventSlug)
    : undefined;
  if (requested) return requested;

  const actionRequired = registrations.find((item) =>
    ['pending_payment', 'pending_review'].includes(item.registrationStatus),
  );
  if (actionRequired) return actionRequired;

  const nowTime = now.getTime();
  const ongoing = registrations
    .filter(
      (item) =>
        new Date(item.startsAt).getTime() <= nowTime && new Date(item.endsAt).getTime() >= nowTime,
    )
    .sort((left, right) => new Date(left.endsAt).getTime() - new Date(right.endsAt).getTime())[0];
  if (ongoing) return ongoing;

  const upcoming = registrations
    .filter((item) => new Date(item.startsAt).getTime() > nowTime)
    .sort(
      (left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime(),
    )[0];
  if (upcoming) return upcoming;

  return (
    [...registrations].sort(
      (left, right) => new Date(right.endsAt).getTime() - new Date(left.endsAt).getTime(),
    )[0] ?? null
  );
}

export function selectFeaturedAccountContext(
  registrations: CustomerRegistrationSummary[],
  orders: CustomerPurchasedOrder[],
  requestedEventSlug: string | null,
  now = new Date(),
) {
  const requestedExists = Boolean(
    requestedEventSlug &&
      (registrations.some((item) => item.eventSlug === requestedEventSlug) ||
        orders.some((item) => item.eventSlug === requestedEventSlug)),
  );
  if (requestedExists) {
    return {
      registration:
        registrations.find((item) => item.eventSlug === requestedEventSlug) ?? null,
      order: orders.find((item) => item.eventSlug === requestedEventSlug) ?? null,
    };
  }
  return {
    registration: selectFeaturedRegistration(registrations, null, now),
    order:
      orders.find((item) =>
        ['pending_review', 'pending_payment', 'processing'].includes(item.status),
      ) ??
      orders[0] ??
      null,
  };
}

export function visibleServiceHubItems(
  items: CustomerServiceHubItem[],
  canManageOrder: boolean,
) {
  return canManageOrder ? items : items.filter((item) => item.code !== 'invoice');
}
