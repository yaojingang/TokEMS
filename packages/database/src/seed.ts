import { hash } from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { isLoopbackHostname } from '@conference/security';
import {
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  DEMO_EVENT,
  DEMO_EVENT_EXPERIENCE,
  DEMO_IDS,
} from '@conference/contracts';
import { createDatabase } from './index.js';
import {
  aiPrompts,
  checkinDevices,
  checkinLists,
  conferenceTemplateDrafts,
  conferenceTemplates,
  conferenceTemplateVersions,
  customerProfiles,
  customerUsers,
  eventBlueprints,
  eventIdAllocators,
  eventReleases,
  eventTemplateBindings,
  events,
  memberProfiles,
  memberships,
  notificationTemplates,
  organizationHomepageEvents,
  organizations,
  publicUserIds,
  registrationForms,
  registrations,
  sessions,
  speakers,
  templatePackages,
  ticketQuotas,
  ticketTypes,
  userIdAllocators,
  users,
} from './schema.js';

const BLUEPRINT_ID = '77777777-7777-4777-8777-777777777777';
const RELEASE_ID = '88888888-8888-4888-8888-888888888888';
const FORM_ID = '99999999-9999-4999-8999-999999999999';
const DEVICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONFERENCE_TEMPLATE_ID = DEMO_IDS.template.root;
const CONFERENCE_TEMPLATE_VERSION_ID = DEMO_IDS.template.version;
const EDITORIAL_RENDERER_ID = '12121212-1212-4121-8121-121212121212';
const HTML_RENDERER_ID = '17171717-1717-4171-8171-171717171717';
const isLocalDemoSeed = process.env.DEPLOYMENT_MODE === 'local';
const publicOrganizationSlug = process.env.PUBLIC_ORGANIZATION_SLUG ?? 'tokems-demo';

const DEMO_CUSTOMERS = [
  {
    publicId: 102,
    id: 'c0000102-0000-4000-8000-000000000102',
    mobile: '+8613800000102',
    realName: '张晴',
    company: '深圳星河智创科技有限公司',
    title: '创始人',
    city: '深圳',
    status: 'active' as const,
    registrationStatus: 'confirmed' as const,
  },
  {
    publicId: 103,
    id: 'c0000103-0000-4000-8000-000000000103',
    mobile: '+8613800000103',
    realName: '李慧',
    company: '极光数字咨询',
    title: '大会运营顾问',
    city: '广州',
    status: 'active' as const,
    registrationStatus: 'checked_in' as const,
  },
  {
    publicId: 104,
    id: 'c0000104-0000-4000-8000-000000000104',
    mobile: '+8613800000104',
    realName: '王博',
    company: '未来商业实验室',
    title: '产品总监',
    city: '杭州',
    status: 'active' as const,
    registrationStatus: 'completed' as const,
  },
  {
    publicId: 105,
    id: 'c0000105-0000-4000-8000-000000000105',
    mobile: '+8613800000105',
    realName: '赵雅文',
    company: '智序品牌管理',
    title: '市场负责人',
    city: '上海',
    status: 'active' as const,
    registrationStatus: 'pending_review' as const,
  },
  {
    publicId: 106,
    id: 'c0000106-0000-4000-8000-000000000106',
    mobile: '+8613800000106',
    realName: '陈默',
    company: '灵犀 AI',
    title: '技术合伙人',
    city: '北京',
    status: 'active' as const,
    registrationStatus: 'pending_payment' as const,
  },
  {
    publicId: 107,
    id: 'c0000107-0000-4000-8000-000000000107',
    mobile: '+8613800000107',
    realName: '刘晓雯',
    company: '南方增长学院',
    title: '运营总监',
    city: '厦门',
    status: 'active' as const,
    registrationStatus: 'cancelled' as const,
  },
  {
    publicId: 108,
    id: 'c0000108-0000-4000-8000-000000000108',
    mobile: '+8613800000108',
    realName: '周然',
    company: '启航内容科技',
    title: '内容策略负责人',
    city: '成都',
    status: 'active' as const,
  },
  {
    publicId: 109,
    id: 'c0000109-0000-4000-8000-000000000109',
    mobile: '+8613800000109',
    realName: '孙宁',
    company: '元点数据',
    title: '数据分析师',
    city: '武汉',
    status: 'active' as const,
  },
  {
    publicId: 110,
    id: 'c0000110-0000-4000-8000-000000000110',
    mobile: '+8613800000110',
    realName: '许程',
    company: '智联会展服务',
    title: '项目经理',
    city: '南京',
    status: 'blocked' as const,
  },
  {
    publicId: 111,
    id: 'c0000111-0000-4000-8000-000000000111',
    mobile: '+8613800000111',
    realName: '高琳',
    company: '创见传媒',
    title: '品牌总监',
    city: '青岛',
    status: 'closed' as const,
  },
] as const;

function isLoopbackUrl(value: string | undefined) {
  if (!value) return false;
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

const allowInsecureLocalAuth =
  process.env.ALLOW_INSECURE_LOCAL_AUTH === 'true' &&
  process.env.DEPLOYMENT_MODE === 'local' &&
  (process.env.NODE_ENV !== 'production' ||
    (isLoopbackUrl(process.env.PUBLIC_WEB_URL) && isLoopbackUrl(process.env.ADMIN_WEB_URL)));
const adminPassword =
  process.env.ADMIN_PASSWORD ??
  (allowInsecureLocalAuth || process.env.NODE_ENV !== 'production' ? 'admin' : '');
if (
  process.env.NODE_ENV === 'production' &&
  !allowInsecureLocalAuth &&
  (adminPassword.length < 16 ||
    ['admin', 'Conference2026', 'replace-with-a-strong-random-password'].includes(adminPassword))
) {
  throw new Error(
    'ADMIN_PASSWORD with at least 16 non-default characters is required when seeding production data',
  );
}
const adminPasswordHash = await hash(adminPassword, 12);

const registrationFields = [
  {
    key: 'name',
    label: '姓名',
    type: 'text' as const,
    required: true,
    placeholder: '请输入真实姓名',
  },
  {
    key: 'mobile',
    label: '手机号码',
    type: 'tel' as const,
    required: true,
    placeholder: '用于接收参会通知',
  },
  {
    key: 'email',
    label: '电子邮箱',
    type: 'email' as const,
    required: true,
    placeholder: 'name@company.com',
  },
  { key: 'company', label: '公司/机构', type: 'text' as const, required: true },
  { key: 'title', label: '职位', type: 'text' as const, required: true },
  { key: 'city', label: '所在城市', type: 'text' as const, required: true },
];

const { db, pool } = createDatabase();

function sessionDate(day: number, time: string) {
  const date = day === 1 ? '2026-11-21' : '2026-11-22';
  return new Date(`${date}T${time}:00+08:00`);
}

try {
  await db.transaction(async (tx) => {
    await tx
      .insert(organizations)
      .values({
        id: DEMO_IDS.organization,
        slug: publicOrganizationSlug,
        name: 'TokEMS Demo Team',
        settings: {
          brandName: 'TokEMS 运营台',
          defaultTimezone: 'Asia/Shanghai',
          defaultCurrency: 'CNY',
          defaultBlueprintId: BLUEPRINT_ID,
          defaultTemplateId: CONFERENCE_TEMPLATE_ID,
        },
      })
      .onConflictDoUpdate({
        target: organizations.id,
        set: {
          slug: publicOrganizationSlug,
          updatedAt: new Date(),
        },
      });

    await tx
      .insert(users)
      .values({
        id: DEMO_IDS.adminUser,
        email: process.env.ADMIN_EMAIL ?? 'admin@tokems.local',
        name: '组织管理员',
        passwordHash: adminPasswordHash,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email: process.env.ADMIN_EMAIL ?? 'admin@tokems.local',
          passwordHash: adminPasswordHash,
          updatedAt: new Date(),
        },
      });

    await tx
      .insert(memberships)
      .values({
        organizationId: DEMO_IDS.organization,
        userId: DEMO_IDS.adminUser,
        role: 'organization_admin',
        grants: ['*'],
      })
      .onConflictDoUpdate({
        target: [memberships.organizationId, memberships.userId],
        set: {
          role: 'organization_admin',
          grants: ['*'],
          updatedAt: new Date(),
        },
      });

    await tx
      .insert(memberProfiles)
      .values({
        organizationId: DEMO_IDS.organization,
        userId: DEMO_IDS.adminUser,
        company: 'TokEMS Demo Team',
        title: '大会运营负责人',
        city: '深圳',
        bio: '负责大会站点、报名、支付、通知与现场核销运营。',
        tags: ['大会运营', 'TokEMS'],
        preferences: { locale: 'zh-CN', timezone: 'Asia/Shanghai' },
      })
      .onConflictDoNothing();

    await tx
      .insert(events)
      .values({
        id: DEMO_EVENT.id,
        organizationId: DEMO_EVENT.organizationId,
        slug: DEMO_EVENT.slug,
        name: DEMO_EVENT.name,
        shortName: DEMO_EVENT.shortName,
        tagline: DEMO_EVENT.tagline,
        description: DEMO_EVENT.description,
        status: DEMO_EVENT.status,
        startsAt: new Date(DEMO_EVENT.startsAt),
        endsAt: new Date(DEMO_EVENT.endsAt),
        timezone: DEMO_EVENT.timezone,
        venue: DEMO_EVENT.venue,
        city: DEMO_EVENT.city,
        address: DEMO_EVENT.address,
        settings: {
          stats: DEMO_EVENT.stats,
          faqs: DEMO_EVENT.faqs,
          registration: DEMO_EVENT.registration,
          locale: 'zh-CN',
          templateKey: 'editorial-blue',
          templateVersionId: CONFERENCE_TEMPLATE_VERSION_ID,
          currentReleaseId: RELEASE_ID,
        },
      })
      .onConflictDoUpdate({
        target: events.id,
        set: {
          name: DEMO_EVENT.name,
          shortName: DEMO_EVENT.shortName,
          tagline: DEMO_EVENT.tagline,
          description: DEMO_EVENT.description,
          status: DEMO_EVENT.status,
          startsAt: new Date(DEMO_EVENT.startsAt),
          endsAt: new Date(DEMO_EVENT.endsAt),
          timezone: DEMO_EVENT.timezone,
          venue: DEMO_EVENT.venue,
          city: DEMO_EVENT.city,
          address: DEMO_EVENT.address,
          settings: {
            stats: DEMO_EVENT.stats,
            faqs: DEMO_EVENT.faqs,
            registration: DEMO_EVENT.registration,
            locale: 'zh-CN',
            templateKey: 'editorial-blue',
            templateVersionId: CONFERENCE_TEMPLATE_VERSION_ID,
            currentReleaseId: RELEASE_ID,
          },
          updatedAt: new Date(),
        },
      });

    await tx
      .insert(eventIdAllocators)
      .values({
        scope: 'global',
        lastId: DEMO_IDS.event,
      })
      .onConflictDoUpdate({
        target: eventIdAllocators.scope,
        set: {
          lastId: sql`greatest(${eventIdAllocators.lastId}, ${DEMO_IDS.event})`,
        },
      });

    await tx
      .insert(organizationHomepageEvents)
      .values({
        organizationId: DEMO_IDS.organization,
        eventId: DEMO_IDS.event,
        updatedBy: DEMO_IDS.adminUser,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: organizationHomepageEvents.organizationId,
        set: {
          eventId: DEMO_IDS.event,
          updatedBy: DEMO_IDS.adminUser,
          updatedAt: new Date(),
        },
      });

    await tx.execute(sql`
      update ${events}
      set settings = settings || ${JSON.stringify({
        templateKey: 'editorial-blue',
        templateVersionId: CONFERENCE_TEMPLATE_VERSION_ID,
        currentReleaseId: RELEASE_ID,
      })}::jsonb
      where id = ${DEMO_IDS.event}
        and not (settings ? 'currentReleaseId')
    `);

    await tx
      .insert(templatePackages)
      .values([
        {
          id: '12121212-1212-4121-8121-121212121212',
          key: 'editorial-blue',
          name: 'TokEMS 编辑蓝',
          version: 1,
          status: 'published',
          description: '复刻大会首页详情页的深蓝编辑式视觉与内容节奏。',
          manifest: {
            entry: 'tokems-demo',
            theme: 'conference-blue',
            supports: ['site', 'registration', 'ticket'],
            schemaVersions: [1, 2],
          },
        },
        {
          id: '13131313-1313-4131-8131-131313131313',
          key: 'executive-classic',
          name: '企业经典',
          version: 1,
          status: 'published',
          description: '适合行业峰会与企业客户大会的稳重版式。',
          manifest: {
            entry: 'executive',
            theme: 'executive-classic',
            supports: ['site', 'registration'],
            schemaVersions: [1, 2],
          },
        },
        {
          id: HTML_RENDERER_ID,
          key: 'html-liquid-v1',
          name: 'HTML 智能模板',
          version: 1,
          status: 'published',
          description: '安全导入静态 HTML，通过受控变量清单生成大会首页。',
          manifest: {
            entry: 'html-document',
            theme: 'imported',
            supports: ['site'],
            schemaVersions: [2],
            compilerVersion: 1,
          },
        },
      ])
      .onConflictDoNothing();

    const templateDefinition = {
      ...DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
      presentation: {
        kind: 'structured' as const,
        home: DEMO_EVENT_EXPERIENCE.home!,
      },
      faq: DEMO_EVENT_EXPERIENCE.faq,
      registrationFlow: DEMO_EVENT_EXPERIENCE.registrationFlow,
      initialization: {
        ...DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.initialization,
        ticketTypes: DEMO_EVENT.tickets.map((ticket) => ({
          code: 'CONFERENCE_PASS',
          name: ticket.name,
          description: ticket.description,
          price: ticket.price,
          currency: ticket.currency,
          capacity: 500,
          recommended: ticket.recommended,
          benefits: ticket.benefits,
        })),
        registrationFields,
      },
    };

    await tx
      .insert(conferenceTemplates)
      .values({
        id: CONFERENCE_TEMPLATE_ID,
        organizationId: DEMO_IDS.organization,
        code: 'tokems-editorial-standard',
        name: '中国第二届 GEO & AI 营销大会',
        description:
          'GEO 大会白底编辑式官网，包含 AI 答案首屏、完整两日议程、嘉宾、FAQ 与单一通票报名。',
        tags: ['GEO', 'AI 营销', '收费报名'],
        status: 'active',
        createdBy: DEMO_IDS.adminUser,
        updatedBy: DEMO_IDS.adminUser,
      })
      .onConflictDoUpdate({
        target: conferenceTemplates.id,
        set: {
          name: '中国第二届 GEO & AI 营销大会',
          description:
            'GEO 大会白底编辑式官网，包含 AI 答案首屏、完整两日议程、嘉宾、FAQ 与单一通票报名。',
          tags: ['GEO', 'AI 营销', '收费报名'],
          status: 'active',
          updatedBy: DEMO_IDS.adminUser,
          updatedAt: new Date(),
        },
      });

    await tx
      .insert(conferenceTemplateVersions)
      .values({
        id: CONFERENCE_TEMPLATE_VERSION_ID,
        templateId: CONFERENCE_TEMPLATE_ID,
        version: 1,
        rendererPackageId: EDITORIAL_RENDERER_ID,
        schemaVersion: 2,
        definition: templateDefinition,
        contentDigest: 'seed-geo-2026-reference-template-v2',
        previewAssetKey: 'template-previews/tokems-editorial-standard-v1.webp',
        changeSummary:
          '同步 GEO 大会 2026 原型文案、完整议程、嘉宾、FAQ、单一通票与标准四步报名流程。',
        createdBy: DEMO_IDS.adminUser,
        publishedAt: new Date('2026-07-16T08:30:00+08:00'),
      })
      .onConflictDoUpdate({
        target: conferenceTemplateVersions.id,
        set: {
          schemaVersion: 2,
          definition: templateDefinition,
          contentDigest: 'seed-geo-2026-reference-template-v2',
          changeSummary:
            '同步 GEO 大会 2026 原型文案、完整议程、嘉宾、FAQ、单一通票与标准四步报名流程。',
        },
      });

    await tx
      .update(conferenceTemplates)
      .set({
        currentPublishedVersionId: CONFERENCE_TEMPLATE_VERSION_ID,
        updatedBy: DEMO_IDS.adminUser,
        updatedAt: new Date(),
      })
      .where(sql`${conferenceTemplates.id} = ${CONFERENCE_TEMPLATE_ID}`);

    await tx
      .insert(conferenceTemplateDrafts)
      .values({
        templateId: CONFERENCE_TEMPLATE_ID,
        rendererPackageId: EDITORIAL_RENDERER_ID,
        schemaVersion: 2,
        definition: templateDefinition,
        revision: 1,
        contentDigest: 'seed-geo-2026-reference-template-v2',
        updatedBy: DEMO_IDS.adminUser,
      })
      .onConflictDoUpdate({
        target: conferenceTemplateDrafts.templateId,
        set: {
          schemaVersion: 2,
          definition: templateDefinition,
          rendererPackageId: EDITORIAL_RENDERER_ID,
          contentDigest: 'seed-geo-2026-reference-template-v2',
          updatedBy: DEMO_IDS.adminUser,
          updatedAt: new Date(),
        },
      });

    await tx
      .insert(eventTemplateBindings)
      .values({
        eventId: DEMO_IDS.event,
        templateVersionId: CONFERENCE_TEMPLATE_VERSION_ID,
        updatePolicy: 'manual',
        revision: 1,
        updatedBy: DEMO_IDS.adminUser,
      })
      .onConflictDoUpdate({
        target: eventTemplateBindings.eventId,
        set: {
          templateVersionId: CONFERENCE_TEMPLATE_VERSION_ID,
          revision: 1,
          updatedBy: DEMO_IDS.adminUser,
          updatedAt: new Date(),
        },
      });

    await tx
      .insert(eventBlueprints)
      .values({
        id: BLUEPRINT_ID,
        organizationId: DEMO_IDS.organization,
        name: 'TokEMS 大会标准蓝图',
        version: 1,
        status: 'published',
        snapshot: {
          modules: ['site', 'registration', 'orders', 'notifications', 'checkin'],
          event: {
            tagline: DEMO_EVENT.tagline,
            description: DEMO_EVENT.description,
            timezone: 'Asia/Shanghai',
            locale: 'zh-CN',
          },
          templateKey: 'editorial-blue',
          ticketTypes: DEMO_EVENT.tickets.map((ticket) => ({
            code: 'CONFERENCE_PASS',
            name: ticket.name,
            description: ticket.description,
            price: ticket.price,
            currency: ticket.currency,
            capacity: 500,
            recommended: ticket.recommended,
            benefits: ticket.benefits,
          })),
          registrationForm: {
            name: '标准参会报名表',
            fields: registrationFields,
            termsVersion: '2026-07-16',
            termsContent: '提交报名即表示参会人同意大会报名服务条款与个人信息处理说明。',
          },
        },
        clonePolicy: {
          pages: 'COPY',
          ticketTypes: 'COPY',
          registrations: 'EXCLUDE',
          orders: 'EXCLUDE',
          members: 'REFERENCE',
        },
      })
      .onConflictDoUpdate({
        target: eventBlueprints.id,
        set: {
          version: 1,
          status: 'published',
          snapshot: {
            modules: ['site', 'registration', 'orders', 'notifications', 'checkin'],
            event: {
              tagline: DEMO_EVENT.tagline,
              description: DEMO_EVENT.description,
              timezone: 'Asia/Shanghai',
              locale: 'zh-CN',
            },
            templateKey: 'editorial-blue',
            ticketTypes: DEMO_EVENT.tickets.map((ticket) => ({
              code: 'CONFERENCE_PASS',
              name: ticket.name,
              description: ticket.description,
              price: ticket.price,
              currency: ticket.currency,
              capacity: 500,
              recommended: ticket.recommended,
              benefits: ticket.benefits,
            })),
            registrationForm: {
              name: '标准参会报名表',
              fields: registrationFields,
              termsVersion: '2026-07-16',
              termsContent: '提交报名即表示参会人同意大会报名服务条款与个人信息处理说明。',
            },
          },
        },
      });

    await tx
      .insert(ticketTypes)
      .values(
        DEMO_EVENT.tickets.map((ticket) => ({
          id: ticket.id,
          organizationId: DEMO_IDS.organization,
          eventId: DEMO_IDS.event,
          code: 'CONFERENCE_PASS',
          name: ticket.name,
          description: ticket.description,
          price: ticket.price,
          currency: ticket.currency,
          capacity: 500,
          sold: 0,
          recommended: ticket.recommended,
          benefits: ticket.benefits,
        })),
      )
      .onConflictDoUpdate({
        target: ticketTypes.id,
        set: {
          code: 'CONFERENCE_PASS',
          name: DEMO_EVENT.tickets[0]!.name,
          description: DEMO_EVENT.tickets[0]!.description,
          price: DEMO_EVENT.tickets[0]!.price,
          currency: DEMO_EVENT.tickets[0]!.currency,
          capacity: 500,
          sold: 0,
          recommended: true,
          benefits: DEMO_EVENT.tickets[0]!.benefits,
          updatedAt: new Date(),
        },
      });

    if (isLocalDemoSeed) {
      await tx
        .insert(publicUserIds)
        .values(
          DEMO_CUSTOMERS.map((customer) => ({
            publicId: customer.publicId,
            subjectType: 'customer' as const,
            subjectUuid: customer.id,
            createdAt: new Date(
              `2026-07-${String(8 + customer.publicId - 100).padStart(2, '0')}T09:00:00+08:00`,
            ),
          })),
        )
        .onConflictDoUpdate({
          target: [publicUserIds.subjectType, publicUserIds.subjectUuid],
          set: { retiredAt: null },
        });

      await tx
        .insert(userIdAllocators)
        .values({ scope: 'global', lastId: 111 })
        .onConflictDoUpdate({
          target: userIdAllocators.scope,
          set: { lastId: sql`greatest(${userIdAllocators.lastId}, 111)` },
        });

      await tx
        .insert(customerUsers)
        .values(
          DEMO_CUSTOMERS.map((customer) => {
            const createdAt = new Date(
              `2026-07-${String(8 + customer.publicId - 100).padStart(2, '0')}T09:00:00+08:00`,
            );
            const registrationIndex = customer.publicId - 102;
            const lastRegistrationAt =
              registrationIndex < 6
                ? new Date(
                    `2026-07-${String(20 + registrationIndex).padStart(2, '0')}T10:30:00+08:00`,
                  )
                : null;
            return {
              id: customer.id,
              organizationId: DEMO_IDS.organization,
              mobileE164: customer.mobile,
              status: customer.status,
              verifiedAt: createdAt,
              lastLoginAt: createdAt,
              lastRegistrationAt,
              internalNote: '本地演示数据',
              tags: ['demo-seed'],
              createdAt,
              updatedAt: lastRegistrationAt ?? createdAt,
            };
          }),
        )
        .onConflictDoUpdate({
          target: customerUsers.id,
          set: {
            organizationId: sql`excluded.organization_id`,
            mobileE164: sql`excluded.mobile_e164`,
            status: sql`excluded.status`,
            verifiedAt: sql`excluded.verified_at`,
            lastLoginAt: sql`excluded.last_login_at`,
            lastRegistrationAt: sql`excluded.last_registration_at`,
            internalNote: '本地演示数据',
            tags: ['demo-seed'],
            updatedAt: sql`excluded.updated_at`,
          },
        });

      await tx
        .insert(customerProfiles)
        .values(
          DEMO_CUSTOMERS.map((customer) => ({
            customerUserId: customer.id,
            nickname: customer.realName,
            realName: customer.realName,
            email: `demo${customer.publicId}@tokems.local`,
            company: customer.company,
            title: customer.title,
            city: customer.city,
            version: 1,
          })),
        )
        .onConflictDoUpdate({
          target: customerProfiles.customerUserId,
          set: {
            nickname: sql`excluded.nickname`,
            realName: sql`excluded.real_name`,
            email: sql`excluded.email`,
            company: sql`excluded.company`,
            title: sql`excluded.title`,
            city: sql`excluded.city`,
            updatedAt: new Date(),
          },
        });

      await tx
        .insert(registrations)
        .values(
          DEMO_CUSTOMERS.slice(0, 6).map((customer, index) => {
            if (!('registrationStatus' in customer)) {
              throw new Error(`Demo customer ${customer.publicId} is missing registration status`);
            }
            const createdAt = new Date(
              `2026-07-${String(20 + index).padStart(2, '0')}T10:30:00+08:00`,
            );
            return {
              id: `d0000${customer.publicId}-0000-4000-8000-000000000${customer.publicId}`,
              organizationId: DEMO_IDS.organization,
              eventId: DEMO_IDS.event,
              ticketTypeId: DEMO_IDS.tickets.earlyBird,
              customerUserId: customer.id,
              registrationCode: `TOKEMS-DEMO-${customer.publicId}`,
              status: customer.registrationStatus,
              attendee: {
                name: customer.realName,
                mobile: customer.mobile,
                email: `demo${customer.publicId}@tokems.local`,
                company: customer.company,
                title: customer.title,
                city: customer.city,
              },
              attendeeMobileE164: customer.mobile,
              attendeeEmailNormalized: `demo${customer.publicId}@tokems.local`,
              formAnswers: {},
              consentSnapshot: { source: 'local-demo-seed' },
              marketingConsent: index % 2 === 0,
              createdAt,
              updatedAt: createdAt,
            };
          }),
        )
        .onConflictDoUpdate({
          target: registrations.id,
          set: {
            customerUserId: sql`excluded.customer_user_id`,
            status: sql`excluded.status`,
            attendee: sql`excluded.attendee`,
            attendeeMobileE164: sql`excluded.attendee_mobile_e164`,
            attendeeEmailNormalized: sql`excluded.attendee_email_normalized`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }

    await tx
      .insert(ticketQuotas)
      .values({
        id: '17171717-1717-4171-8171-171717171717',
        eventId: DEMO_IDS.event,
        name: '大会总票额',
        capacity: 500,
        sold: 0,
        ticketTypeIds: [DEMO_IDS.tickets.earlyBird],
      })
      .onConflictDoUpdate({
        target: ticketQuotas.id,
        set: {
          capacity: 500,
          sold: 0,
          ticketTypeIds: [DEMO_IDS.tickets.earlyBird],
          updatedAt: new Date(),
        },
      });

    await tx
      .insert(registrationForms)
      .values({
        id: FORM_ID,
        eventId: DEMO_IDS.event,
        name: '标准参会报名表',
        version: 1,
        status: 'published',
        fields: registrationFields,
        termsVersion: '2026-07-16',
        termsContent: '提交报名即表示参会人同意大会报名服务条款与个人信息处理说明。',
        publishedAt: new Date('2026-07-16T08:00:00+08:00'),
      })
      .onConflictDoNothing();

    await tx
      .insert(speakers)
      .values(
        DEMO_EVENT.speakers.map((speaker, sortOrder) => ({
          ...speaker,
          organizationId: DEMO_IDS.organization,
          eventId: DEMO_IDS.event,
          sortOrder,
        })),
      )
      .onConflictDoUpdate({
        target: speakers.id,
        set: {
          name: sql`excluded.name`,
          role: sql`excluded.role`,
          topic: sql`excluded.topic`,
          initials: sql`excluded.initials`,
          accentFrom: sql`excluded.accent_from`,
          accentTo: sql`excluded.accent_to`,
          tags: sql`excluded.tags`,
          sortOrder: sql`excluded.sort_order`,
          updatedAt: new Date(),
        },
      });

    await tx
      .insert(sessions)
      .values(
        DEMO_EVENT.sessions.map((session, sortOrder) => ({
          id: session.id,
          eventId: DEMO_IDS.event,
          day: session.day,
          startsAt: sessionDate(session.day, session.startsAt),
          endsAt: sessionDate(session.day, session.endsAt),
          title: session.title,
          summary: session.summary,
          speaker: session.speaker,
          kind: session.kind,
          sortOrder,
        })),
      )
      .onConflictDoUpdate({
        target: sessions.id,
        set: {
          day: sql`excluded.day`,
          startsAt: sql`excluded.starts_at`,
          endsAt: sql`excluded.ends_at`,
          title: sql`excluded.title`,
          summary: sql`excluded.summary`,
          speaker: sql`excluded.speaker`,
          kind: sql`excluded.kind`,
          sortOrder: sql`excluded.sort_order`,
          updatedAt: new Date(),
        },
      });

    await tx
      .insert(checkinLists)
      .values({
        id: DEMO_IDS.checkinList,
        eventId: DEMO_IDS.event,
        code: 'main-entrance',
        name: '大会主入口',
        rules: { maxEntries: 1, ticketTypes: 'all', offlineAllowed: true },
      })
      .onConflictDoNothing();

    await tx
      .insert(checkinDevices)
      .values({
        id: DEVICE_ID,
        organizationId: DEMO_IDS.organization,
        eventId: DEMO_IDS.event,
        deviceCode: 'GATE-A-01',
        name: '主入口核销机 A01',
        tokenHash: 'demo-device-token-sha256-placeholder',
        capabilities: ['checkin', 'offline_sync'],
      })
      .onConflictDoNothing();

    await tx
      .insert(eventReleases)
      .values({
        id: RELEASE_ID,
        eventId: DEMO_IDS.event,
        version: 1,
        templateKey: 'editorial-blue',
        templateVersionId: CONFERENCE_TEMPLATE_VERSION_ID,
        status: 'published',
        snapshot: {
          event: {
            name: DEMO_EVENT.name,
            tagline: DEMO_EVENT.tagline,
            description: DEMO_EVENT.description,
          },
          tickets: DEMO_EVENT.tickets,
          speakers: DEMO_EVENT.speakers,
          sessions: DEMO_EVENT.sessions,
          faqs: DEMO_EVENT.faqs,
          registrationForm: { version: 1, termsVersion: '2026-07-16', fields: registrationFields },
          experience: DEMO_EVENT_EXPERIENCE,
        },
        artifactKey: `releases/${DEMO_IDS.event}/v1/index.json`,
        createdBy: DEMO_IDS.adminUser,
        publishedAt: new Date('2026-07-16T09:00:00+08:00'),
      })
      .onConflictDoUpdate({
        target: eventReleases.id,
        set: {
          templateVersionId: CONFERENCE_TEMPLATE_VERSION_ID,
          status: 'published',
          snapshot: {
            event: {
              name: DEMO_EVENT.name,
              tagline: DEMO_EVENT.tagline,
              description: DEMO_EVENT.description,
            },
            tickets: DEMO_EVENT.tickets,
            speakers: DEMO_EVENT.speakers,
            sessions: DEMO_EVENT.sessions,
            faqs: DEMO_EVENT.faqs,
            registrationForm: {
              version: 1,
              termsVersion: '2026-07-16',
              fields: registrationFields,
            },
            experience: DEMO_EVENT_EXPERIENCE,
          },
        },
      });

    await tx
      .insert(notificationTemplates)
      .values([
        {
          id: '14141414-1414-4141-8141-141414141414',
          organizationId: DEMO_IDS.organization,
          code: 'registration-confirmed',
          name: '报名成功通知',
          channel: 'email',
          subject: '{{eventName}} 报名成功',
          body: '{{attendeeName}}，您已成功报名 {{eventName}}。电子票号：{{ticketCode}}。',
        },
        {
          id: '15151515-1515-4151-8151-151515151515',
          organizationId: DEMO_IDS.organization,
          code: 'event-reminder',
          name: '会前提醒',
          channel: 'email',
          subject: '{{eventName}} 参会提醒',
          body: '大会将于 {{startsAt}} 在 {{venue}} 举行，请携带电子票提前到场。',
        },
      ])
      .onConflictDoNothing();

    await tx
      .insert(aiPrompts)
      .values({
        id: '16161616-1616-4161-8161-161616161616',
        organizationId: DEMO_IDS.organization,
        code: 'conference-copywriter',
        name: '大会运营文案助手',
        version: 1,
        systemPrompt:
          '依据当前组织与大会资料生成准确、克制、可审核的中文运营文案。不得编造嘉宾、时间、地点或权益。',
      })
      .onConflictDoNothing();
  });

  console.info('Conference seed data is ready');
} finally {
  await pool.end();
}
