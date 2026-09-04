import { describe, expect, it } from 'vitest';
import {
  CreateEventSchema,
  EventShortSlugSchema,
  EventSlugSchema,
  isPublicEventStatus,
  publicEventHomePath,
  publicEventSlugFromPathSegment,
  publicEventScopedPath,
} from './index.js';

describe('public event routing contracts', () => {
  it('builds canonical home and event-scoped flow paths', () => {
    expect(publicEventHomePath('geo-ai-2027')).toBe('/geo-ai-2027');
    expect(
      publicEventScopedPath('/register', 'geo-ai-2027', {
        ticket: 'ticket 1',
        offer: 'secret/token',
      }),
    ).toBe('/register/geo-ai-2027?ticket=ticket+1&offer=secret%2Ftoken');
  });

  it('safely rejects malformed encoded path segments', () => {
    expect(publicEventSlugFromPathSegment('geo-ai-2027')).toBe('geo-ai-2027');
    expect(publicEventSlugFromPathSegment('%67eo-ai-2027')).toBe('geo-ai-2027');
    expect(publicEventSlugFromPathSegment('%E0%A4%A')).toBeUndefined();
  });

  it.each(['register', 'account', 'api', 'healthz'])('rejects the reserved slug %s', (slug) => {
    expect(EventSlugSchema.safeParse(slug).success).toBe(false);
  });

  it('uses the shared slug rules when creating an event', () => {
    const result = CreateEventSchema.safeParse({
      name: '大会名称',
      shortName: '大会简称',
      slug: 'faq',
      startsAt: '2027-06-18T01:00:00.000Z',
      endsAt: '2027-06-19T10:00:00.000Z',
      venue: '大会场馆',
      city: '深圳',
      address: '大会详细地址',
      templateVersionId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.success).toBe(false);
  });

  it('keeps custom event URLs short and allows server-generated defaults', () => {
    expect(EventShortSlugSchema.safeParse('geo26').success).toBe(true);
    expect(EventShortSlugSchema.safeParse('a'.repeat(24)).success).toBe(true);
    expect(EventShortSlugSchema.safeParse('a'.repeat(25)).success).toBe(false);

    const result = CreateEventSchema.safeParse({
      name: '大会名称',
      shortName: '大会简称',
      startsAt: '2027-06-18T01:00:00.000Z',
      endsAt: '2027-06-19T10:00:00.000Z',
      venue: '大会场馆',
      city: '深圳',
      address: '大会详细地址',
      templateVersionId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.slug).toBeUndefined();
  });

  it('recognizes every lifecycle state that can be served publicly', () => {
    expect(isPublicEventStatus('prepublished')).toBe(true);
    expect(isPublicEventStatus('registration_open')).toBe(true);
    expect(isPublicEventStatus('in_progress')).toBe(true);
    expect(isPublicEventStatus('ended')).toBe(true);
    expect(isPublicEventStatus('configuring')).toBe(false);
    expect(isPublicEventStatus('archived')).toBe(false);
  });

  it('rejects external or pre-queried scoped paths', () => {
    expect(() => publicEventScopedPath('https://example.com/register', 'geo-ai-2027')).toThrow();
    expect(() => publicEventScopedPath('/register?ticket=1', 'geo-ai-2027')).toThrow();
  });
});
