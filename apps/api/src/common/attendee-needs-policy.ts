import { attendeeShowcaseQualification } from './attendee-showcase-policy.js';

export const ATTENDEE_NEEDS_PUBLIC_PAGE_SIZE = 10 as const;

type AttendeeNeedsExperience = {
  registrationFlow?: {
    steps?: Array<{ nodeKey?: string; type?: string; enabled?: boolean }>;
  };
  home?: { blocks?: Array<{ nodeKey?: string; type?: string; enabled?: boolean }> };
};

function attendeeNeedsExperience(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return ('experience' in record ? record.experience : record) as AttendeeNeedsExperience | null;
}

export function attendeeNeedsFlowEnabled(snapshot: unknown) {
  const experience = attendeeNeedsExperience(snapshot);
  return Boolean(
    experience?.registrationFlow?.steps?.some(
      (step) =>
        step.nodeKey === 'flow.attendee-needs' && step.type === 'attendee-needs' && step.enabled,
    ),
  );
}

export function attendeeNeedsHomeEnabled(snapshotOrExperience: unknown) {
  const experience = attendeeNeedsExperience(snapshotOrExperience);
  return Boolean(
    experience?.home?.blocks?.some(
      (block) =>
        block.nodeKey === 'home.attendee-needs' && block.type === 'attendee-needs' && block.enabled,
    ),
  );
}

export function attendeeNeedsCanCreate(submissionExists: boolean, snapshot: unknown) {
  return submissionExists || attendeeNeedsFlowEnabled(snapshot);
}

export function attendeeNeedsTotalPages(total: number) {
  return Math.max(1, Math.ceil(Math.max(0, total) / ATTENDEE_NEEDS_PUBLIC_PAGE_SIZE));
}

export function attendeeNeedsSnapshotCutoff(requested: string | undefined, now: Date) {
  if (!requested) return now;
  const candidate = new Date(requested);
  return candidate.getTime() <= now.getTime() ? candidate : now;
}

export function attendeeNeedsVersionMatches(
  clientVersion: number,
  storedVersion: number,
  createdForThisUpdate: boolean,
) {
  return clientVersion === storedVersion || (createdForThisUpdate && clientVersion === 0);
}

export function attendeeNeedsConsentMetadata(input: {
  nextIsPublic: boolean;
  currentIsPublic: boolean;
  currentVersion: string | null;
  currentConsentAt: Date | null;
  requiredVersion: string;
  now: Date;
}) {
  const requiresAcceptance =
    input.nextIsPublic &&
    (!input.currentIsPublic ||
      input.currentVersion !== input.requiredVersion ||
      !input.currentConsentAt);
  return {
    consentVersion: requiresAcceptance ? input.requiredVersion : input.currentVersion,
    consentAt: requiresAcceptance ? input.now : input.currentConsentAt,
  };
}

export function attendeeNeedAdminEditMetadata(input: {
  currentContent: string;
  currentTagCodes: string[];
  currentEditedAt: Date | null;
  currentEditReason: string | null;
  nextContent: string;
  nextTagCodes: string[];
}) {
  const contentChanged = input.currentContent !== input.nextContent;
  const currentTags = [...input.currentTagCodes].sort();
  const nextTags = [...input.nextTagCodes].sort();
  const tagsChanged =
    currentTags.length !== nextTags.length ||
    currentTags.some((code, index) => code !== nextTags[index]);
  return contentChanged || tagsChanged
    ? { adminEditedAt: null, adminEditReason: null }
    : { adminEditedAt: input.currentEditedAt, adminEditReason: input.currentEditReason };
}

export function attendeeNeedAdminEditAuditFacts(input: {
  contentChanged: boolean;
  tagCodesChanged: boolean;
  wasAdminEdited: boolean;
  wasAnonymous: boolean;
  nextAnonymous: boolean;
  reason: string;
}) {
  return {
    before: {
      edited: input.wasAdminEdited,
      isAnonymous: input.wasAnonymous,
    },
    after: {
      contentChanged: input.contentChanged,
      tagCodesChanged: input.tagCodesChanged,
      forcedAnonymous: input.contentChanged || input.tagCodesChanged,
      isAnonymous: input.nextAnonymous,
      reason: input.reason,
    },
  };
}

export function attendeeNeedsForcedAnonymityFromAudit(
  rows: Array<{ after: Record<string, unknown> | null }>,
) {
  const latest = rows.find((row) => row.after?.forcedAnonymous === true);
  return {
    forced: Boolean(latest),
    reason: typeof latest?.after?.reason === 'string' ? latest.after.reason : null,
  };
}

export function resolveAttendeeNeedPublicationIdentity(input: {
  requestedAnonymous: boolean;
  requestedAttributionName: string | null;
  canonicalAttributionName: string | null;
  adminForcedAnonymous: boolean;
}) {
  if (input.adminForcedAnonymous || input.requestedAnonymous) {
    return { isAnonymous: true, attributionName: null, validationError: null };
  }
  const requested = input.requestedAttributionName?.trim() ?? '';
  const canonical = input.canonicalAttributionName?.trim() ?? '';
  if (!canonical || requested !== canonical) {
    return {
      isAnonymous: false,
      attributionName: null,
      validationError: '实名公开署名必须使用当前报名姓名',
    };
  }
  return { isAnonymous: false, attributionName: canonical, validationError: null };
}

export function attendeeNeedsReplacementRequiresReview(
  governedContents: string[],
  nextQuestions: Array<{ id?: string | undefined; content: string }>,
) {
  return governedContents.length > 0 && nextQuestions.some((question) => !question.id);
}

export function attendeeNeedGovernanceRequiresReview(input: {
  adminHiddenAt: Date | null;
  deletedAt: Date | null;
  deletedByType: 'customer' | 'admin' | null;
}) {
  return Boolean(
    (input.adminHiddenAt && !input.deletedAt) ||
      (input.deletedAt && input.deletedByType === 'admin'),
  );
}

export function attendeeNeedsQualification(input: {
  eventStatus: string;
  customerStatus: string;
  registrationStatus: string;
  orderStatus: string;
  paymentSatisfied: boolean;
  ticketStatus: string | null;
  isPublic: boolean;
}) {
  const result = attendeeShowcaseQualification({ ...input, adminHiddenAt: null });
  if (result.reason === '尚未开启大会主页展示') {
    return { qualified: false, reason: '尚未公开参会需求' };
  }
  return result;
}

export function attendeeNeedQuestionIsVisible(input: {
  qualified: boolean;
  publicationEnabled: boolean;
  consentVersionCurrent: boolean;
  firstPublishedAt: Date | null;
  adminHiddenAt: Date | null;
  deletedAt: Date | null;
}) {
  return Boolean(
    input.qualified &&
    input.publicationEnabled &&
    input.consentVersionCurrent &&
    input.firstPublishedAt &&
    !input.adminHiddenAt &&
    !input.deletedAt,
  );
}

export function attendeeNeedModerationStateError(input: {
  action: 'hide' | 'restore' | 'delete' | 'restore-delete' | 'anonymize';
  adminHiddenAt: Date | null;
  deletedAt: Date | null;
  deletedByType: string | null;
}) {
  if (['hide', 'restore', 'delete'].includes(input.action) && input.deletedAt) {
    return '已删除的问题需要按原删除来源处理';
  }
  if (input.action === 'hide' && input.adminHiddenAt) return '问题已经处于隐藏状态';
  if (input.action === 'restore' && !input.adminHiddenAt) return '问题当前未被隐藏';
  if (input.action === 'restore-delete' && (!input.deletedAt || input.deletedByType !== 'admin')) {
    return '只能恢复由管理员删除的问题';
  }
  return null;
}
