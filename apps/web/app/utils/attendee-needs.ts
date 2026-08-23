import type { AttendeeNeedsProfile, PublicAttendeeNeedList } from '@conference/contracts';

export type AttendeeNeedsAccountState = {
  label: string;
  canEdit: boolean;
  canRetry: boolean;
  hasMaterial: boolean;
};

export function attendeeNeedsRequestIsCurrent(requestedEventSlug: string, currentEventSlug: string) {
  return requestedEventSlug === currentEventSlug;
}

export function attendeeNeedsShouldResetSerializedState(isClient: boolean, isHydrating: boolean) {
  return isClient && !isHydrating;
}

export function attendeeNeedsBlockIsEnabled(
  block: { nodeKey?: string; type?: string; enabled?: boolean } | null | undefined,
) {
  return Boolean(
    block?.nodeKey === 'home.attendee-needs' && block.type === 'attendee-needs' && block.enabled,
  );
}

export function resolveAttendeeNeedsAccountState(
  profile: AttendeeNeedsProfile | undefined,
  failed: boolean,
): AttendeeNeedsAccountState {
  if (!profile) {
    return {
      label: failed ? '读取失败' : '正在读取',
      canEdit: false,
      canRetry: failed,
      hasMaterial: false,
    };
  }
  const common = {
    canEdit: Boolean(profile.id || profile.canCreate),
    canRetry: false,
    hasMaterial: Boolean(profile.id),
  };
  if (!profile.id && !profile.featureEnabled) return { ...common, label: '暂未开放' };
  if (!profile.id) return { ...common, label: '未提交' };
  if (!profile.qualified && profile.isPublic) return { ...common, label: '资格失效' };
  if (
    profile.adminRemovedCount > 0 ||
    profile.questions.some((question) => question.adminHidden || question.deletedByAdmin)
  ) {
    return { ...common, label: '部分内容已隐藏' };
  }
  if (!profile.isPublic) return { ...common, label: '仅自己可见' };
  if (!profile.effectivePublic) return { ...common, label: '已允许公开，暂未展示' };
  return { ...common, label: profile.isAnonymous ? '匿名公开' : '实名公开' };
}

export function attendeeNeedsValidPage(requestedPage: number, totalPages: number) {
  const upperBound = Math.max(1, Math.trunc(totalPages));
  return Math.min(Math.max(1, Math.trunc(requestedPage)), upperBound);
}

export type AttendeeNeedsLastSuccess = {
  eventSlug: string;
  page: number;
  result: PublicAttendeeNeedList;
};

export function resolveAttendeeNeedsFallback(
  lastSuccess: AttendeeNeedsLastSuccess | null,
  eventSlug: string,
  page: number,
): PublicAttendeeNeedList {
  if (lastSuccess?.eventSlug === eventSlug && lastSuccess.page === page) {
    return lastSuccess.result;
  }
  return {
    items: [],
    total: 0,
    page,
    pageSize: 10,
    totalPages: 1,
    snapshotAt: new Date().toISOString(),
  };
}

export function resolveAttendeeNeedsSectionState(input: {
  blockEnabled: boolean;
  total: number;
  pending: boolean;
  hasError: boolean;
}) {
  if (!input.blockEnabled) return { visible: false, status: 'hidden' as const };
  if (input.hasError) return { visible: true, status: 'error' as const };
  if (input.pending) return { visible: true, status: 'loading' as const };
  if (input.total > 0) return { visible: true, status: 'ready' as const };
  return { visible: true, status: 'empty' as const };
}
