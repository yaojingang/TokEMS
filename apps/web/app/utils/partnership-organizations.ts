import {
  type PublicEventMemberItem,
  type Speaker,
  type TemplatePartnershipOrganizationGroup,
} from '@conference/contracts';

export type PartnershipOrganizationGroupKey = 'speaker' | 'media' | 'member';

export type PartnershipOrganizationGroup = {
  key: PartnershipOrganizationGroupKey;
  index: string;
  label: string;
  meta: string;
  organizations: string[];
};

const NON_ORGANIZATION_ROLE_PATTERN = /(?:专家|主持人|自媒体人|作者|顾问|讲师|学者)/u;
const ORGANIZATION_TITLE_SUFFIX_PATTERN =
  /\s*(?:联合创始人|创始人|首席产品官|首席[^·|｜]{1,16}|CEO|COO|CPO|CTO|CMO|CFO|副总(?:经理)?|总经理|负责人)(?:\s.*)?$/iu;
const GENERIC_ORGANIZATION_PATTERN = /^(?:AI\s*)?出海公司$/iu;
const MEDIA_ORGANIZATION_PATTERN = /(?:媒体|媒介|传媒|日报|报社|新闻|电视|广播|每经)/u;

function organizationKey(value: string) {
  return value.replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

function uniqueOrganizations(values: Array<string | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const name = value?.trim();
    if (!name) return;
    const key = organizationKey(name);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(name);
  });
  return result;
}

function configuredOrganizationGroups(
  value: unknown,
): TemplatePartnershipOrganizationGroup[] | undefined {
  if (!Array.isArray(value) || value.length > 3) return undefined;
  const keys = new Set<PartnershipOrganizationGroupKey>();
  const groups: TemplatePartnershipOrganizationGroup[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const source = item as Record<string, unknown>;
    const key = source.key;
    const label = typeof source.label === 'string' ? source.label.trim() : '';
    const meta = typeof source.meta === 'string' ? source.meta.trim() : '';
    if (
      (key !== 'speaker' && key !== 'media' && key !== 'member') ||
      keys.has(key) ||
      !label ||
      label.length > 80 ||
      !meta ||
      meta.length > 80 ||
      !Array.isArray(source.organizations) ||
      source.organizations.length > 100
    ) {
      return undefined;
    }
    const organizations: string[] = [];
    for (const organization of source.organizations) {
      const name = typeof organization === 'string' ? organization.trim() : '';
      if (name.length < 2 || name.length > 120) return undefined;
      organizations.push(name);
    }
    keys.add(key);
    groups.push({ key, label, meta, organizations });
  }
  return groups;
}

export function speakerOrganizationNames(role: string) {
  return uniqueOrganizations(
    role.split(/\s*[·|｜]\s*/u).map((segment) => {
      const source = segment.trim();
      if (!source || NON_ORGANIZATION_ROLE_PATTERN.test(source)) return undefined;
      const name = source.replace(ORGANIZATION_TITLE_SUFFIX_PATTERN, '').trim();
      if (name.length < 2 || GENERIC_ORGANIZATION_PATTERN.test(name)) return undefined;
      return name;
    }),
  );
}

export function buildPartnershipOrganizationGroups(
  speakers: Speaker[],
  members: PublicEventMemberItem[],
  configuredGroups?: unknown,
): PartnershipOrganizationGroup[] {
  const speakerOrganizations = uniqueOrganizations(
    speakers.flatMap((speaker) => speakerOrganizationNames(speaker.role)),
  );
  const mediaOrganizations = speakerOrganizations.filter((name) =>
    MEDIA_ORGANIZATION_PATTERN.test(name),
  );
  const guestOrganizations = speakerOrganizations.filter(
    (name) => !MEDIA_ORGANIZATION_PATTERN.test(name),
  );
  const speakerOrganizationKeys = new Set(speakerOrganizations.map(organizationKey));
  const memberOrganizations = uniqueOrganizations(members.map((member) => member.company)).filter(
    (name) => !speakerOrganizationKeys.has(organizationKey(name)),
  );

  const derivedGroups: Array<TemplatePartnershipOrganizationGroup> = [
    {
      key: 'speaker',
      label: '嘉宾所属机构',
      meta: 'SPEAKER NETWORK',
      organizations: guestOrganizations,
    },
    {
      key: 'media',
      label: '媒体机构',
      meta: 'MEDIA NETWORK',
      organizations: mediaOrganizations,
    },
    {
      key: 'member',
      label: '参会会员机构',
      meta: 'ATTENDEE NETWORK',
      organizations: memberOrganizations,
    },
  ];
  const configured = configuredOrganizationGroups(configuredGroups);
  const configuredKeys = new Set<PartnershipOrganizationGroupKey>();
  const orderedGroups: Array<TemplatePartnershipOrganizationGroup> = [];
  if (configured) {
    configured.forEach((group) => {
      configuredKeys.add(group.key);
      orderedGroups.push(group);
    });
  }
  derivedGroups.forEach((group) => {
    if (!configuredKeys.has(group.key)) orderedGroups.push(group);
  });

  const seenOrganizations = new Set<string>();
  return orderedGroups
    .map((group) => ({
      ...group,
      organizations: uniqueOrganizations(group.organizations).filter((name) => {
        const key = organizationKey(name);
        if (seenOrganizations.has(key)) return false;
        seenOrganizations.add(key);
        return true;
      }),
    }))
    .filter((group) => group.organizations.length > 0)
    .map((group, index) => ({
      ...group,
      index: String(index + 1).padStart(2, '0'),
    }));
}
