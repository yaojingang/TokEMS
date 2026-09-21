import { PARTNER_POSTER_DEFAULT_COPY, type PartnerProfileView } from '@conference/contracts';
import type { PersonalPosterContent } from './personal-event-poster';

export function resolvePartnerPosterCopy(profile: PartnerProfileView) {
  return {
    invitation: profile.posterCopy?.invitation || PARTNER_POSTER_DEFAULT_COPY.invitation,
    introduction: profile.posterCopy?.introduction || PARTNER_POSTER_DEFAULT_COPY.introduction,
    callToAction: profile.posterCopy?.callToAction || PARTNER_POSTER_DEFAULT_COPY.callToAction,
    scanHint: profile.posterCopy?.scanHint || PARTNER_POSTER_DEFAULT_COPY.scanHint,
  };
}

export function resolvePartnerPosterContent(profile: PartnerProfileView): PersonalPosterContent {
  const allowed = (field: keyof PartnerProfileView['posterFields']) =>
    profile.visibleFields[field] && profile.posterFields[field];
  return {
    invitation: profile.posterCopy?.invitation || null,
    callToAction: profile.posterCopy?.callToAction || null,
    scanHint: profile.posterCopy?.scanHint || null,
    displayName: allowed('displayName') ? profile.displayName.trim() || null : null,
    company: allowed('company') ? profile.company.trim() || null : null,
    title: allowed('title') ? profile.title.trim() || null : null,
    industryLabel: allowed('industry') ? profile.industry.trim() || null : null,
    businessIntro: profile.posterCopy?.introduction?.trim() || (allowed('businessIntro') ? profile.businessIntro.trim() || null : null),
    avatarUrl: allowed('avatar') ? profile.avatarUrl : null,
  };
}

export function partnerPosterFilename(publicName: string | null, eventName: string) {
  const safe = (value: string) => value.replace(/[\\/?%*:|"<>]/gu, '-').trim();
  return `${safe(publicName || '大会合作伙伴')}-${safe(eventName) || '大会'}-推广海报.png`;
}
