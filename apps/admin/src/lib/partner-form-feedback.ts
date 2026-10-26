export interface PartnerFieldIssue {
  field: string;
  message: string;
}

const fieldMessages: Record<string, string> = {
  mobile: '合作伙伴手机号：请输入有效的 11 位中国大陆手机号。',
  displayName: '姓名 / 展示名称：请填写名称，最多 80 个字符。',
  company: '公司：最多填写 160 个字符。',
  title: '职务：最多填写 100 个字符。',
  industry: '行业：最多填写 80 个字符。',
  businessIntro: '个人 / 业务介绍：最多填写 2000 个字符。',
  businessUrl:
    '业务链接：请填写以 http:// 或 https:// 开头的完整地址，最多 500 个字符，也可以留空。',
  personalRateBps: '个人佣金比例：请填写 0 至 100 之间的数字，或留空继承大会规则。',
  sortOrder: '展示顺序：请填写 -1000000 至 1000000 之间的整数。',
  internalNote: '内部备注：最多填写 2000 个字符。',
  posterCopy: '海报文案：请检查字数限制，避免使用不支持的字符。',
  posterFields: '海报展示内容：只能使用已获公开授权的字段。',
  avatarAssetId: '合作伙伴头像：请等待图片处理完成，或重新上传。',
};

/** Turn local and server validation paths into the same actionable field messages. */
export function partnerFieldIssues(issues: unknown): PartnerFieldIssue[] {
  if (!Array.isArray(issues)) return [];
  const fields = new Set<string>();
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object' || !Array.isArray(issue.path)) continue;
    const field = issue.path[0];
    if (typeof field === 'string' && Object.hasOwn(fieldMessages, field)) fields.add(field);
  }
  return [...fields].map((field) => ({ field, message: fieldMessages[field]! }));
}

export function partnerServerFieldIssues(error: unknown): PartnerFieldIssue[] {
  if (!error || typeof error !== 'object' || !('details' in error)) return [];
  const details = error.details;
  return details && typeof details === 'object' && 'issues' in details
    ? partnerFieldIssues(details.issues)
    : [];
}
