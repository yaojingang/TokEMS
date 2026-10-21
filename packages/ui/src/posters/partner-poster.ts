import { PARTNER_POSTER_DEFAULT_COPY, type PartnerPosterProfileView } from '@conference/contracts';
import type { PersonalPosterContent } from './personal-event-poster.js';

export function resolvePartnerPosterCopy(profile: PartnerPosterProfileView) {
  return {
    invitation: profile.posterCopy?.invitation || PARTNER_POSTER_DEFAULT_COPY.invitation,
    introduction: profile.posterCopy?.introduction || PARTNER_POSTER_DEFAULT_COPY.introduction,
    callToAction: profile.posterCopy?.callToAction || PARTNER_POSTER_DEFAULT_COPY.callToAction,
    scanHint: profile.posterCopy?.scanHint || PARTNER_POSTER_DEFAULT_COPY.scanHint,
  };
}

export function resolvePartnerPosterContent(
  profile: PartnerPosterProfileView,
): PersonalPosterContent {
  const allowed = (field: keyof PartnerPosterProfileView['posterFields']) =>
    profile.visibleFields[field] && profile.posterFields[field];
  return {
    invitation: profile.posterCopy?.invitation || null,
    callToAction: profile.posterCopy?.callToAction || null,
    scanHint: profile.posterCopy?.scanHint || null,
    displayName: allowed('displayName') ? profile.displayName.trim() || null : null,
    company: allowed('company') ? profile.company.trim() || null : null,
    title: allowed('title') ? profile.title.trim() || null : null,
    industryLabel: allowed('industry') ? profile.industry.trim() || null : null,
    businessIntro:
      profile.posterCopy?.introduction?.trim() ||
      (allowed('businessIntro') ? profile.businessIntro.trim() || null : null),
    avatarUrl: allowed('avatar') ? profile.avatarUrl : null,
  };
}

export function partnerPosterFilename(publicName: string | null, eventName: string) {
  const safe = (value: string) => value.replace(/[\\/?%*:|"<>]/gu, '-').trim();
  return `${safe(publicName || '大会合作伙伴')}-${safe(eventName) || '大会'}-推广海报.png`;
}

export function resolvePartnerPosterOptions(
  partner: { eventName: string },
  content: PersonalPosterContent,
  event: { shortName: string; startsAt: string; timezone: string; city: string } | null,
) {
  const eventLine = event?.startsAt
    ? [
        new Intl.DateTimeFormat('zh-CN', {
          timeZone: event.timezone,
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }).format(new Date(event.startsAt)),
        event.city,
      ]
        .filter(Boolean)
        .join(' · ')
    : event?.city || '大会现场';
  return {
    variant: 'partner' as const,
    eventName: partner.eventName,
    eventMark: event?.shortName?.trim() || partner.eventName,
    eventLine,
    location: event?.city?.trim() || '大会现场',
    content,
  };
}
