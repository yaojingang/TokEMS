import { UpdateAttendeeShowcaseSchema } from '@conference/contracts';

const attendeeShowcaseFields = {
  displayName: { label: '姓名', targetId: 'showcase-display-name' },
  industryCode: { label: '主行业', targetId: 'showcase-industry-code' },
  company: { label: '公司 / 组织', targetId: 'showcase-company' },
  title: { label: '职位', targetId: 'showcase-title' },
  businessIntro: { label: '业务介绍', targetId: 'showcase-business-intro' },
  businessUrl: {
    label: '公司或项目网址',
    targetId: 'showcase-business-url',
    invalidMessage: '请输入有效的 HTTP 或 HTTPS 网址',
  },
  contactPhone: { label: '联系电话', targetId: 'showcase-contact-phone' },
  contactEmail: {
    label: '联系邮箱',
    targetId: 'showcase-contact-email',
    invalidMessage: '请输入有效的邮箱地址',
  },
  wechatId: { label: '微信号', targetId: 'showcase-wechat-id' },
  isPublic: { label: '主页展示授权', targetId: 'showcase-is-public' },
} as const;

export type AttendeeShowcaseValidationField = keyof typeof attendeeShowcaseFields;

export type AttendeeShowcaseValidationIssue = {
  field: AttendeeShowcaseValidationField;
  label: string;
  message: string;
  targetId: string;
};

type ValidationIssueLike = {
  path?: unknown;
  message?: unknown;
};

function isAttendeeShowcaseField(value: unknown): value is AttendeeShowcaseValidationField {
  return typeof value === 'string' && value in attendeeShowcaseFields;
}

export function attendeeShowcaseApiValidationIssues(
  issues: unknown,
): AttendeeShowcaseValidationIssue[] {
  if (!Array.isArray(issues)) return [];
  const resolved: AttendeeShowcaseValidationIssue[] = [];
  const seen = new Set<AttendeeShowcaseValidationField>();
  for (const candidate of issues as ValidationIssueLike[]) {
    const field = Array.isArray(candidate.path) ? candidate.path[0] : undefined;
    if (!isAttendeeShowcaseField(field) || seen.has(field)) continue;
    const metadata = attendeeShowcaseFields[field];
    const candidateMessage = typeof candidate.message === 'string' ? candidate.message.trim() : '';
    const localizedMessage =
      'invalidMessage' in metadata && /^[a-z]/iu.test(candidateMessage)
        ? metadata.invalidMessage
        : candidateMessage;
    seen.add(field);
    resolved.push({
      field,
      label: metadata.label,
      message: localizedMessage || `请检查${metadata.label}`,
      targetId: metadata.targetId,
    });
  }
  return resolved;
}

export function attendeeShowcaseValidationIssues(
  input: unknown,
): AttendeeShowcaseValidationIssue[] {
  const parsed = UpdateAttendeeShowcaseSchema.safeParse(input);
  return parsed.success ? [] : attendeeShowcaseApiValidationIssues(parsed.error.issues);
}
