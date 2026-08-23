import { describe, expect, it } from 'vitest';
import { attendeeNeedsValidPage } from './attendee-needs';

describe('attendee needs page recovery', () => {
  it.each([
    [1, 1, 1],
    [2, 1, 1],
    [3, 2, 2],
    [2, 3, 2],
    [0, 3, 1],
  ])('maps requested page %i with %i total pages to %i', (requested, total, expected) => {
    expect(attendeeNeedsValidPage(requested, total)).toBe(expected);
  });
});
