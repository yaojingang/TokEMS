import type { AttendeeShowcaseVisibleFields } from '@conference/contracts';

export type AttendeePosterSource = {
  displayName: string;
  company: string;
  title: string;
  industryCode: string;
  businessIntro: string;
  avatarUrl: string | null;
  visibleFields: AttendeeShowcaseVisibleFields;
};

export function attendeeAvatarInitial(displayName: string | null | undefined) {
  return Array.from(displayName?.trim() || '会员')[0] ?? '会';
}

export function resolveAttendeePosterContent(source: AttendeePosterSource) {
  return {
    displayName: source.visibleFields.displayName ? source.displayName.trim() || null : null,
    company: source.visibleFields.company ? source.company.trim() || null : null,
    title: source.visibleFields.title ? source.title.trim() || null : null,
    industryCode: source.visibleFields.industry ? source.industryCode || null : null,
    businessIntro: source.visibleFields.businessIntro ? source.businessIntro.trim() || null : null,
    avatarUrl: source.visibleFields.avatar ? source.avatarUrl : null,
  };
}

export function attendeePosterFilename(
  publicDisplayName: string | null,
  eventName: string,
  sequence: number,
) {
  const safe = (value: string) => value.replace(/[\\/?%*:|"<>]/gu, '-').trim();
  const identity = publicDisplayName?.trim() || `报名会员-${String(sequence).padStart(3, '0')}`;
  return `${safe(identity)}-${safe(eventName) || '大会'}-报名海报.png`;
}
