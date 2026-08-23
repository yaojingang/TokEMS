export function attendeeNeedsValidPage(requestedPage: number, totalPages: number) {
  const upperBound = Math.max(1, Math.trunc(totalPages));
  return Math.min(Math.max(1, Math.trunc(requestedPage)), upperBound);
}
