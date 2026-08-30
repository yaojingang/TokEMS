import { createHash, createHmac } from 'node:crypto';
import { hash } from 'bcryptjs';
import { and, count, eq, gt, isNull, notInArray, sql, sum } from 'drizzle-orm';
import { isLoopbackHostname } from '@conference/security';
import { sha256Digest } from '@conference/html-template';
import {
  ATTENDEE_SHOWCASE_CONSENT_VERSION,
  DEFAULT_ANALYTICS_SETTINGS,
  DEMO_IDS,
} from '@conference/contracts';
import { CANONICAL_HOMEPAGE_SNAPSHOT } from '@conference/contracts/canonical-homepage';
import { createDatabase } from './index.js';
import { activeInventoryReservationAt } from './inventory-reservation-policy.js';
import { remapCanonicalReferences } from './canonical-homepage-remap.js';
import {
  validateCanonicalHomepageSnapshot,
  validateCanonicalHtmlDocument,
} from './export-canonical-homepage.js';
import {
  aiPrompts,
  attendeeShowcaseProfiles,
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
  inventoryReservations,
  memberships,
  notificationTemplates,
  orders,
  organizationHomepageEvents,
  organizations,
  publicUserIds,
  payments,
  registrationForms,
  registrations,
  sessions,
  speakerPublicRoutes,
  speakers,
  templatePackages,
  templateAssets,
  templateHtmlDocuments,
  ticketQuotas,
  ticketTypes,
  tickets,
  userIdAllocators,
  users,
  waitlistEntries,
} from './schema.js';

const BLUEPRINT_ID = '77777777-7777-4777-8777-777777777777';
const HTML_RENDERER_ID = '17171717-1717-4171-8171-171717171717';
const isLocalDemoSeed = process.env.DEPLOYMENT_MODE === 'local';
const publicOrganizationSlug = process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference';
const canonicalOrganizationSettings = {
  ...CANONICAL_HOMEPAGE_SNAPSHOT.organization.settings,
  analytics: DEFAULT_ANALYTICS_SETTINGS,
} as const;
const canonicalBackend = CANONICAL_HOMEPAGE_SNAPSHOT.backend;
const canonicalTemplate = CANONICAL_HOMEPAGE_SNAPSHOT.template;
const canonicalRelease = CANONICAL_HOMEPAGE_SNAPSHOT.release;
const CONFERENCE_TEMPLATE_ID = canonicalTemplate.root.id;

function stableCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableCanonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableCanonicalJson(item)}`)
    .join(',')}}`;
}

function assertCanonicalValue(label: string, actual: unknown, expected: unknown) {
  if (stableCanonicalJson(actual) !== stableCanonicalJson(expected)) {
    throw new Error(`${label} already exists with different immutable content`);
  }
}

function canonicalAssetUrl(
  storageKey: string,
  method: 'GET' | 'PUT',
  mediaType?: string,
  contentLength?: number,
) {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;
  const bucket = process.env.S3_BUCKET;
  if (!endpoint || !accessKey || !secretKey || !bucket) return null;
  const region = process.env.S3_REGION ?? 'us-east-1';
  const now = new Date();
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const endpointUrl = new URL(endpoint);
  const encodePath = (value: string) =>
    value
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  const canonicalUri = `${endpointUrl.pathname.replace(/\/$/, '')}/${encodePath(bucket)}/${encodePath(storageKey)}`;
  const credential = `${accessKey}/${day}/${region}/s3/aws4_request`;
  const signedHeaders = mediaType
    ? method === 'PUT'
      ? 'content-length;content-type;host;if-none-match'
      : 'content-type;host'
    : method === 'PUT'
      ? 'host;if-none-match'
      : 'host';
  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': date,
    'X-Amz-Expires': '600',
    'X-Amz-SignedHeaders': signedHeaders,
  });
  params.sort();
  const canonicalHeaders = `${contentLength ? `content-length:${contentLength}\n` : ''}${mediaType ? `content-type:${mediaType}\n` : ''}host:${endpointUrl.host}\n${method === 'PUT' ? 'if-none-match:*\n' : ''}`;
  const canonicalRequest = [
    method,
    canonicalUri,
    params.toString(),
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date,
    `${day}/${region}/s3/aws4_request`,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const hmac = (key: Buffer | string, value: string) =>
    createHmac('sha256', key).update(value).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), 's3'), 'aws4_request');
  params.set(
    'X-Amz-Signature',
    createHmac('sha256', signingKey).update(stringToSign).digest('hex'),
  );
  return `${endpointUrl.origin}${canonicalUri}?${params.toString()}`;
}

async function ensureCanonicalAssetObject(asset: {
  storageKey: string;
  mediaType: string;
  size: number;
  contentDigest: string;
  contentBase64: string;
}) {
  const content = Buffer.from(asset.contentBase64, 'base64');
  if (content.byteLength !== asset.size)
    throw new Error(`Canonical asset ${asset.storageKey} size mismatch`);
  const digest = createHash('sha256').update(content).digest('hex');
  if (digest !== asset.contentDigest)
    throw new Error(`Canonical asset ${asset.storageKey} digest mismatch`);
  const putUrl = canonicalAssetUrl(asset.storageKey, 'PUT', asset.mediaType, content.byteLength);
  if (!putUrl) throw new Error('S3 configuration is required to seed canonical template assets');
  const response = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(content.byteLength),
      'Content-Type': asset.mediaType,
      'If-None-Match': '*',
    },
    body: content,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return;
  if (response.status !== 409 && response.status !== 412) {
    throw new Error(`Canonical asset upload failed with HTTP ${response.status}`);
  }
  const getUrl = canonicalAssetUrl(asset.storageKey, 'GET');
  if (!getUrl) throw new Error('S3 configuration is required to verify canonical template assets');
  const existing = await fetch(getUrl, { signal: AbortSignal.timeout(15_000) });
  if (!existing.ok)
    throw new Error(`Canonical asset verification failed with HTTP ${existing.status}`);
  const declaredLength = Number(existing.headers.get('content-length') ?? 0);
  if (declaredLength > asset.size) {
    throw new Error(`Canonical asset ${asset.storageKey} existing object exceeds expected size`);
  }
  if (!existing.body) throw new Error(`Canonical asset ${asset.storageKey} has no response body`);
  const digestHash = createHash('sha256');
  let existingSize = 0;
  for await (const chunk of existing.body) {
    const bytes = Buffer.from(chunk);
    existingSize += bytes.byteLength;
    if (existingSize > asset.size) {
      throw new Error(`Canonical asset ${asset.storageKey} existing object exceeds expected size`);
    }
    digestHash.update(bytes);
  }
  if (existingSize !== asset.size) {
    throw new Error(`Canonical asset ${asset.storageKey} existing object size mismatch`);
  }
  const existingDigest = digestHash.digest('hex');
  if (existingDigest !== asset.contentDigest) {
    throw new Error(`Canonical asset ${asset.storageKey} conflicts with an existing object`);
  }
}

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
const adminEmail = (process.env.ADMIN_EMAIL ?? 'admin@tokems.local').trim().toLowerCase();
const adminName = (process.env.ADMIN_USERNAME ?? 'admin').trim();
const adminUserId = (process.env.ADMIN_USER_ID ?? DEMO_IDS.adminUser).trim().toLowerCase();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(adminUserId)) {
  throw new Error('ADMIN_USER_ID must be a valid UUID');
}
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

const { db, pool } = createDatabase();
const canonicalAssetStorageKeys = new Map<string, string>();
const canonicalStorageKeyMap = new Map<string, string>();

try {
  validateCanonicalHomepageSnapshot(CANONICAL_HOMEPAGE_SNAPSHOT);
  for (const asset of CANONICAL_HOMEPAGE_SNAPSHOT.assets) {
    const [existingAsset] = await db
      .select({ storageKey: templateAssets.storageKey })
      .from(templateAssets)
      .where(
        and(
          eq(templateAssets.organizationId, DEMO_IDS.organization),
          eq(templateAssets.contentDigest, asset.contentDigest),
          eq(templateAssets.purpose, 'template'),
        ),
      )
      .limit(1);
    const storageKey = existingAsset?.storageKey ?? asset.storageKey;
    await ensureCanonicalAssetObject({ ...asset, storageKey });
    canonicalAssetStorageKeys.set(asset.id, storageKey);
    canonicalStorageKeyMap.set(asset.storageKey, storageKey);
  }

  await db.transaction(
    async (tx) => {
      await tx
        .insert(organizations)
        .values({
          id: DEMO_IDS.organization,
          slug: publicOrganizationSlug,
          name: CANONICAL_HOMEPAGE_SNAPSHOT.organization.name,
          settings: canonicalOrganizationSettings,
        })
        .onConflictDoUpdate({
          target: organizations.id,
          set: {
            slug: publicOrganizationSlug,
            name: CANONICAL_HOMEPAGE_SNAPSHOT.organization.name,
            settings: sql`${organizations.settings} || ${JSON.stringify(
              CANONICAL_HOMEPAGE_SNAPSHOT.organization.settings,
            )}::jsonb`,
            updatedAt: new Date(),
          },
        });

      await tx
        .insert(users)
        .values({
          id: adminUserId,
          email: adminEmail,
          name: adminName,
          passwordHash: adminPasswordHash,
        })
        .onConflictDoUpdate({
          target: users.id,
          set: {
            email: adminEmail,
            name: adminName,
            passwordHash: adminPasswordHash,
            updatedAt: new Date(),
          },
        });

      await tx
        .insert(memberships)
        .values({
          organizationId: DEMO_IDS.organization,
          userId: adminUserId,
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

      const assetIdMap = new Map<string, string>();
      for (const asset of CANONICAL_HOMEPAGE_SNAPSHOT.assets) {
        const [seededAsset] = await tx
          .insert(templateAssets)
          .values({
            id: asset.id,
            organizationId: DEMO_IDS.organization,
            storageKey: canonicalAssetStorageKeys.get(asset.id) ?? asset.storageKey,
            mediaType: asset.mediaType,
            size: asset.size,
            width: typeof asset.width === 'number' ? asset.width : null,
            height: typeof asset.height === 'number' ? asset.height : null,
            contentDigest: asset.contentDigest,
            altText: typeof asset.altText === 'string' ? asset.altText : '',
            purpose: 'template',
            createdBy: adminUserId,
          })
          .onConflictDoUpdate({
            target: [
              templateAssets.organizationId,
              templateAssets.contentDigest,
              templateAssets.purpose,
            ],
            set: {
              mediaType: asset.mediaType,
              size: asset.size,
              width: typeof asset.width === 'number' ? asset.width : null,
              height: typeof asset.height === 'number' ? asset.height : null,
              altText: typeof asset.altText === 'string' ? asset.altText : '',
            },
          })
          .returning({ id: templateAssets.id, storageKey: templateAssets.storageKey });
        if (!seededAsset) throw new Error(`Canonical asset ${asset.id} could not be seeded`);
        if (seededAsset.storageKey !== canonicalAssetStorageKeys.get(asset.id)) {
          throw new Error(
            `Canonical asset ${asset.id} storage mapping changed during synchronization; retry`,
          );
        }
        assetIdMap.set(asset.id, seededAsset.id);
      }
      const assetReferenceMap = new Map([...assetIdMap, ...canonicalStorageKeyMap]);

      await tx
        .insert(events)
        .values({
          id: canonicalBackend.event.id,
          organizationId: canonicalBackend.event.organizationId,
          slug: canonicalBackend.event.slug,
          name: canonicalBackend.event.name,
          shortName: canonicalBackend.event.shortName,
          tagline: canonicalBackend.event.tagline,
          description: canonicalBackend.event.description,
          status: canonicalBackend.event.status,
          startsAt: new Date(canonicalBackend.event.startsAt),
          endsAt: new Date(canonicalBackend.event.endsAt),
          timezone: canonicalBackend.event.timezone,
          venue: canonicalBackend.event.venue,
          city: canonicalBackend.event.city,
          address: canonicalBackend.event.address,
          settings: canonicalBackend.event.settings,
        })
        .onConflictDoUpdate({
          target: events.id,
          set: {
            slug: canonicalBackend.event.slug,
            name: canonicalBackend.event.name,
            shortName: canonicalBackend.event.shortName,
            tagline: canonicalBackend.event.tagline,
            description: canonicalBackend.event.description,
            status: canonicalBackend.event.status,
            startsAt: new Date(canonicalBackend.event.startsAt),
            endsAt: new Date(canonicalBackend.event.endsAt),
            timezone: canonicalBackend.event.timezone,
            venue: canonicalBackend.event.venue,
            city: canonicalBackend.event.city,
            address: canonicalBackend.event.address,
            settings: canonicalBackend.event.settings,
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
          updatedBy: adminUserId,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: organizationHomepageEvents.organizationId,
          set: {
            eventId: DEMO_IDS.event,
            updatedBy: adminUserId,
            updatedAt: new Date(),
          },
        });

      const rendererPackagesToSeed = new Map(
        [
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
          ...canonicalTemplate.renderers,
        ].map((renderer) => [`${renderer.key}:${renderer.version}`, renderer] as const),
      );
      const seededRendererPackages = await tx
        .insert(templatePackages)
        .values([...rendererPackagesToSeed.values()])
        .onConflictDoUpdate({
          target: [templatePackages.key, templatePackages.version],
          set: {
            name: sql`excluded.name`,
            status: sql`excluded.status`,
            description: sql`excluded.description`,
            manifest: sql`excluded.manifest`,
            updatedAt: new Date(),
          },
        })
        .returning({
          id: templatePackages.id,
          key: templatePackages.key,
          version: templatePackages.version,
        });
      const rendererIdMap = new Map(
        seededRendererPackages.map((renderer) => {
          const canonicalRenderer = rendererPackagesToSeed.get(
            `${renderer.key}:${renderer.version}`,
          );
          if (!canonicalRenderer)
            throw new Error('Seeded renderer package has no canonical source');
          return [canonicalRenderer.id, renderer.id] as const;
        }),
      );

      const templateDraftDefinition = remapCanonicalReferences(
        canonicalTemplate.draft.definition,
        assetReferenceMap,
      ) as typeof canonicalTemplate.draft.definition;
      const templateDraftDigest =
        stableCanonicalJson(templateDraftDefinition) ===
        stableCanonicalJson(canonicalTemplate.draft.definition)
          ? canonicalTemplate.draft.contentDigest
          : createHash('sha256').update(JSON.stringify(templateDraftDefinition)).digest('hex');

      await tx
        .insert(conferenceTemplates)
        .values({
          id: CONFERENCE_TEMPLATE_ID,
          organizationId: DEMO_IDS.organization,
          code: canonicalTemplate.root.code,
          name: canonicalTemplate.root.name,
          description: canonicalTemplate.root.description,
          tags: canonicalTemplate.root.tags,
          status: canonicalTemplate.root.status as 'active' | 'archived',
          createdBy: adminUserId,
          updatedBy: adminUserId,
        })
        .onConflictDoUpdate({
          target: conferenceTemplates.id,
          set: {
            code: canonicalTemplate.root.code,
            name: canonicalTemplate.root.name,
            description: canonicalTemplate.root.description,
            tags: canonicalTemplate.root.tags,
            status: canonicalTemplate.root.status as 'active' | 'archived',
            updatedBy: adminUserId,
            updatedAt: new Date(),
          },
        });

      if (canonicalTemplate.releaseRoot) {
        await tx
          .insert(conferenceTemplates)
          .values({
            id: canonicalTemplate.releaseRoot.id,
            organizationId: DEMO_IDS.organization,
            code: canonicalTemplate.releaseRoot.code,
            name: canonicalTemplate.releaseRoot.name,
            description: canonicalTemplate.releaseRoot.description,
            tags: canonicalTemplate.releaseRoot.tags,
            status: canonicalTemplate.releaseRoot.status as 'active' | 'archived',
            createdBy: adminUserId,
            updatedBy: adminUserId,
          })
          .onConflictDoUpdate({
            target: conferenceTemplates.id,
            set: {
              code: canonicalTemplate.releaseRoot.code,
              name: canonicalTemplate.releaseRoot.name,
              description: canonicalTemplate.releaseRoot.description,
              tags: canonicalTemplate.releaseRoot.tags,
              status: canonicalTemplate.releaseRoot.status as 'active' | 'archived',
              updatedBy: adminUserId,
              updatedAt: new Date(),
            },
          });
      }

      const templateVersionIdMap = new Map<string, string>();
      for (const canonicalVersion of canonicalTemplate.publishedVersions) {
        const definition = remapCanonicalReferences(
          canonicalVersion.definition,
          assetReferenceMap,
        ) as typeof canonicalVersion.definition;
        const rendererPackageId =
          rendererIdMap.get(canonicalVersion.rendererPackageId) ??
          canonicalVersion.rendererPackageId;
        const contentDigest =
          stableCanonicalJson(definition) === stableCanonicalJson(canonicalVersion.definition)
            ? canonicalVersion.contentDigest
            : createHash('sha256').update(JSON.stringify(definition)).digest('hex');
        const previewAssetKey = canonicalVersion.previewAssetKey
          ? (canonicalStorageKeyMap.get(canonicalVersion.previewAssetKey) ??
            canonicalVersion.previewAssetKey)
          : null;
        const [insertedVersion] = await tx
          .insert(conferenceTemplateVersions)
          .values({
            id: canonicalVersion.id,
            templateId: canonicalVersion.templateId,
            version: canonicalVersion.version,
            rendererPackageId,
            schemaVersion: canonicalVersion.schemaVersion,
            definition,
            contentDigest,
            previewAssetKey,
            changeSummary: canonicalVersion.changeSummary,
            createdBy: adminUserId,
          })
          .onConflictDoNothing({
            target: [conferenceTemplateVersions.templateId, conferenceTemplateVersions.version],
          })
          .returning();
        const [seededVersion] = insertedVersion
          ? [insertedVersion]
          : await tx
              .select()
              .from(conferenceTemplateVersions)
              .where(
                and(
                  eq(conferenceTemplateVersions.templateId, canonicalVersion.templateId),
                  eq(conferenceTemplateVersions.version, canonicalVersion.version),
                ),
              );
        if (!seededVersion) throw new Error('Canonical template version could not be seeded');
        assertCanonicalValue(
          `Template version ${canonicalVersion.version}`,
          {
            rendererPackageId: seededVersion.rendererPackageId,
            schemaVersion: seededVersion.schemaVersion,
            definition: seededVersion.definition,
            contentDigest: seededVersion.contentDigest,
            previewAssetKey: seededVersion.previewAssetKey,
            changeSummary: seededVersion.changeSummary,
          },
          {
            rendererPackageId,
            schemaVersion: canonicalVersion.schemaVersion,
            definition,
            contentDigest,
            previewAssetKey,
            changeSummary: canonicalVersion.changeSummary,
          },
        );
        templateVersionIdMap.set(canonicalVersion.id, seededVersion.id);
      }
      const seededTemplateVersionId = templateVersionIdMap.get(canonicalTemplate.version.id);
      const seededCurrentTemplateVersionId = templateVersionIdMap.get(
        canonicalTemplate.root.currentPublishedVersionId ?? canonicalTemplate.version.id,
      );
      if (!seededTemplateVersionId || !seededCurrentTemplateVersionId) {
        throw new Error('Canonical template pointers could not be resolved');
      }

      for (const canonicalHtmlDocument of canonicalTemplate.htmlDocuments) {
        const remappedHtmlDocument = remapCanonicalReferences(
          canonicalHtmlDocument,
          assetReferenceMap,
        ) as Record<string, unknown>;
        if (remappedHtmlDocument.sanitizedHtml !== canonicalHtmlDocument.sanitizedHtml) {
          remappedHtmlDocument.sanitizedDigest = sha256Digest(
            String(remappedHtmlDocument.sanitizedHtml),
          );
        }
        const htmlDocument = validateCanonicalHtmlDocument(remappedHtmlDocument);
        const templateId =
          typeof htmlDocument.templateId === 'string'
            ? htmlDocument.templateId
            : CONFERENCE_TEMPLATE_ID;
        await tx
          .insert(templateHtmlDocuments)
          .values({
            id: String(htmlDocument.id),
            organizationId: DEMO_IDS.organization,
            templateId,
            originalFilename: String(htmlDocument.originalFilename),
            sourceStorageKey: String(htmlDocument.sourceStorageKey),
            sourceDigest: String(htmlDocument.sourceDigest),
            sourceSize: Number(htmlDocument.sourceSize),
            sanitizedHtml: String(htmlDocument.sanitizedHtml),
            sanitizedDigest: String(htmlDocument.sanitizedDigest),
            nodeManifest: htmlDocument.nodeManifest as Array<Record<string, unknown>>,
            assetManifest: htmlDocument.assetManifest as Array<Record<string, unknown>>,
            securityReport: htmlDocument.securityReport as Record<string, unknown>,
            metadata: htmlDocument.metadata as Record<string, unknown>,
            compilerVersion: Number(htmlDocument.compilerVersion),
            createdBy: adminUserId,
          })
          .onConflictDoUpdate({
            target: templateHtmlDocuments.id,
            set: {
              templateId,
              originalFilename: String(htmlDocument.originalFilename),
              sourceStorageKey: String(htmlDocument.sourceStorageKey),
              sourceDigest: String(htmlDocument.sourceDigest),
              sourceSize: Number(htmlDocument.sourceSize),
              sanitizedHtml: String(htmlDocument.sanitizedHtml),
              sanitizedDigest: String(htmlDocument.sanitizedDigest),
              nodeManifest: htmlDocument.nodeManifest as Array<Record<string, unknown>>,
              assetManifest: htmlDocument.assetManifest as Array<Record<string, unknown>>,
              securityReport: htmlDocument.securityReport as Record<string, unknown>,
              metadata: htmlDocument.metadata as Record<string, unknown>,
              compilerVersion: Number(htmlDocument.compilerVersion),
            },
          });
      }

      await tx
        .update(conferenceTemplates)
        .set({
          currentPublishedVersionId: seededCurrentTemplateVersionId,
          updatedBy: adminUserId,
          updatedAt: new Date(),
        })
        .where(sql`${conferenceTemplates.id} = ${CONFERENCE_TEMPLATE_ID}`);

      await tx
        .insert(conferenceTemplateDrafts)
        .values({
          templateId: CONFERENCE_TEMPLATE_ID,
          rendererPackageId:
            rendererIdMap.get(canonicalTemplate.draft.rendererPackageId) ??
            canonicalTemplate.draft.rendererPackageId,
          schemaVersion: canonicalTemplate.draft.schemaVersion,
          definition: templateDraftDefinition,
          revision: canonicalTemplate.draft.revision,
          contentDigest: templateDraftDigest,
          updatedBy: adminUserId,
        })
        .onConflictDoUpdate({
          target: conferenceTemplateDrafts.templateId,
          set: {
            schemaVersion: canonicalTemplate.draft.schemaVersion,
            definition: templateDraftDefinition,
            revision: canonicalTemplate.draft.revision,
            rendererPackageId:
              rendererIdMap.get(canonicalTemplate.draft.rendererPackageId) ??
              canonicalTemplate.draft.rendererPackageId,
            contentDigest: templateDraftDigest,
            updatedBy: adminUserId,
            updatedAt: new Date(),
          },
        });

      await tx
        .insert(eventTemplateBindings)
        .values({
          eventId: DEMO_IDS.event,
          templateVersionId: seededTemplateVersionId,
          updatePolicy: canonicalTemplate.binding.updatePolicy,
          revision: canonicalTemplate.binding.revision,
          updatedBy: adminUserId,
        })
        .onConflictDoUpdate({
          target: eventTemplateBindings.eventId,
          set: {
            templateVersionId: seededTemplateVersionId,
            updatePolicy: canonicalTemplate.binding.updatePolicy,
            revision: canonicalTemplate.binding.revision,
            updatedBy: adminUserId,
            updatedAt: new Date(),
          },
        });

      const canonicalBlueprints = CANONICAL_HOMEPAGE_SNAPSHOT.blueprints.length
        ? CANONICAL_HOMEPAGE_SNAPSHOT.blueprints
        : CANONICAL_HOMEPAGE_SNAPSHOT.blueprint
          ? [CANONICAL_HOMEPAGE_SNAPSHOT.blueprint]
          : [];
      for (const blueprint of canonicalBlueprints) {
        const blueprintSnapshot = remapCanonicalReferences(
          blueprint.snapshot ?? {},
          assetReferenceMap,
        ) as Record<string, unknown>;
        await tx
          .insert(eventBlueprints)
          .values({
            id: String(blueprint.id ?? BLUEPRINT_ID),
            organizationId: DEMO_IDS.organization,
            name: String(blueprint.name ?? 'TokEMS 大会标准蓝图'),
            version: Number(blueprint.version ?? 1),
            status: String(blueprint.status ?? 'published'),
            snapshot: blueprintSnapshot,
            clonePolicy: (blueprint.clonePolicy ?? {}) as Record<
              string,
              'COPY' | 'RESET' | 'REFERENCE' | 'EXCLUDE'
            >,
          })
          .onConflictDoUpdate({
            target: eventBlueprints.id,
            set: {
              name: String(blueprint.name ?? 'TokEMS 大会标准蓝图'),
              version: Number(blueprint.version ?? 1),
              status: String(blueprint.status ?? 'published'),
              snapshot: blueprintSnapshot,
              clonePolicy: (blueprint.clonePolicy ?? {}) as Record<
                string,
                'COPY' | 'RESET' | 'REFERENCE' | 'EXCLUDE'
              >,
            },
          });
      }

      const existingTicketRows = await tx
        .select({
          id: ticketTypes.id,
          code: ticketTypes.code,
          sold: ticketTypes.sold,
        })
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, DEMO_IDS.event))
        .for('update');
      const existingTicketById = new Map(existingTicketRows.map((ticket) => [ticket.id, ticket]));
      const existingTicketByCode = new Map(
        existingTicketRows.map((ticket) => [ticket.code, ticket]),
      );
      const claimedTicketIds = new Set<string>();
      const minimumCapacityByTicketId = new Map<string, number>();
      const ticketTargets = canonicalBackend.ticketTypes.map((ticket) => {
        const stableIdMatch = existingTicketById.get(ticket.id);
        const codeMatch = existingTicketByCode.get(ticket.code);
        const existing =
          stableIdMatch ??
          (codeMatch && !claimedTicketIds.has(codeMatch.id) ? codeMatch : undefined);
        const targetId = existing?.id ?? ticket.id;
        if (claimedTicketIds.has(targetId)) {
          throw new Error(`Canonical ticket ${ticket.code} resolves to a duplicate production row`);
        }
        claimedTicketIds.add(targetId);
        return { canonical: ticket, existing, targetId };
      });
      const ticketTargetById = new Map(ticketTargets.map((target) => [target.targetId, target]));
      const canonicalTicketCodes = new Set(
        canonicalBackend.ticketTypes.map((ticket) => ticket.code),
      );
      for (const [index, existing] of existingTicketRows.entries()) {
        const target = ticketTargetById.get(existing.id);
        if (
          (target && target.canonical.code !== existing.code) ||
          (!target && canonicalTicketCodes.has(existing.code))
        ) {
          await tx
            .update(ticketTypes)
            .set({
              code: `canonical-tmp-${index}-${existing.id.slice(0, 8)}`,
              updatedAt: new Date(),
            })
            .where(eq(ticketTypes.id, existing.id));
        }
      }

      const ticketIdMap = new Map<string, string>();
      for (const target of ticketTargets) {
        const ticket = target.canonical;
        if (target.existing) {
          const [held] = await tx
            .select({ quantity: sum(inventoryReservations.quantity) })
            .from(inventoryReservations)
            .where(
              and(
                eq(inventoryReservations.ticketTypeId, target.targetId),
                isNull(inventoryReservations.convertedAt),
                isNull(inventoryReservations.releasedAt),
                activeInventoryReservationAt(new Date()),
              ),
            );
          const [waitlistHeld] = await tx
            .select({ quantity: count() })
            .from(waitlistEntries)
            .where(
              and(
                eq(waitlistEntries.ticketTypeId, target.targetId),
                eq(waitlistEntries.status, 'invited'),
                gt(waitlistEntries.expiresAt, new Date()),
              ),
            );
          const minimumCapacity =
            target.existing.sold +
            Number(held?.quantity ?? 0) +
            Number(waitlistHeld?.quantity ?? 0);
          minimumCapacityByTicketId.set(target.targetId, minimumCapacity);
          if (ticket.capacity < minimumCapacity) {
            throw new Error(
              `Canonical ticket ${ticket.code} capacity ${ticket.capacity} is below production sold and held inventory ${minimumCapacity}`,
            );
          }
          await tx
            .update(ticketTypes)
            .set({
              code: ticket.code,
              name: ticket.name,
              description: ticket.description,
              price: ticket.price,
              currency: ticket.currency,
              capacity: ticket.capacity,
              active: ticket.active,
              recommended: ticket.recommended,
              benefits: ticket.benefits,
              updatedAt: new Date(),
            })
            .where(eq(ticketTypes.id, target.targetId));
        } else {
          minimumCapacityByTicketId.set(target.targetId, 0);
          await tx.insert(ticketTypes).values({
            id: target.targetId,
            organizationId: DEMO_IDS.organization,
            eventId: DEMO_IDS.event,
            code: ticket.code,
            name: ticket.name,
            description: ticket.description,
            price: ticket.price,
            currency: ticket.currency,
            capacity: ticket.capacity,
            sold: 0,
            active: ticket.active,
            recommended: ticket.recommended,
            benefits: ticket.benefits,
          });
        }
        ticketIdMap.set(ticket.id, target.targetId);
      }
      await tx
        .update(ticketTypes)
        .set({ active: false, updatedAt: new Date() })
        .where(
          and(
            eq(ticketTypes.eventId, DEMO_IDS.event),
            notInArray(ticketTypes.id, [...ticketIdMap.values()]),
          ),
        );
      const canonicalDemoTicket =
        canonicalBackend.ticketTypes.find(
          (ticket) => ticket.id === DEMO_IDS.tickets.earlyBird && ticket.active,
        ) ?? canonicalBackend.ticketTypes.find((ticket) => ticket.active);
      const demoTicketTypeId = canonicalDemoTicket
        ? ticketIdMap.get(canonicalDemoTicket.id)
        : undefined;
      if (isLocalDemoSeed && !demoTicketTypeId) {
        throw new Error('Canonical local demo ticket type could not be resolved');
      }

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
                throw new Error(
                  `Canonical customer ${customer.publicId} is missing registration status`,
                );
              }
              const createdAt = new Date(
                `2026-07-${String(20 + index).padStart(2, '0')}T10:30:00+08:00`,
              );
              return {
                id: `d0000${customer.publicId}-0000-4000-8000-000000000${customer.publicId}`,
                organizationId: DEMO_IDS.organization,
                eventId: DEMO_IDS.event,
                ticketTypeId: demoTicketTypeId!,
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
              ticketTypeId: sql`excluded.ticket_type_id`,
              status: sql`excluded.status`,
              attendee: sql`excluded.attendee`,
              attendeeMobileE164: sql`excluded.attendee_mobile_e164`,
              attendeeEmailNormalized: sql`excluded.attendee_email_normalized`,
              updatedAt: sql`excluded.updated_at`,
            },
          });

        const publicDemoCustomers = DEMO_CUSTOMERS.slice(0, 3);
        await tx
          .insert(orders)
          .values(
            publicDemoCustomers.map((customer, index) => {
              const createdAt = new Date(
                `2026-07-${String(20 + index).padStart(2, '0')}T10:35:00+08:00`,
              );
              return {
                id: `e0000${customer.publicId}-0000-4000-8000-000000000${customer.publicId}`,
                organizationId: DEMO_IDS.organization,
                eventId: DEMO_IDS.event,
                registrationId: `d0000${customer.publicId}-0000-4000-8000-000000000${customer.publicId}`,
                orderNo: `TOKEMSDEMO${customer.publicId}`,
                status: 'paid' as const,
                amount: canonicalDemoTicket!.price,
                currency: canonicalDemoTicket!.currency,
                pricingSnapshot: {
                  source: 'local-demo-seed',
                  ticketName: canonicalDemoTicket!.name,
                },
                expiresAt: new Date(createdAt.getTime() + 15 * 60_000),
                createdAt,
                updatedAt: createdAt,
              };
            }),
          )
          .onConflictDoUpdate({
            target: orders.id,
            set: {
              status: 'paid',
              amount: sql`excluded.amount`,
              currency: sql`excluded.currency`,
              pricingSnapshot: sql`excluded.pricing_snapshot`,
              updatedAt: sql`excluded.updated_at`,
            },
          });

        await tx
          .insert(payments)
          .values(
            publicDemoCustomers.map((customer, index) => {
              const succeededAt = new Date(
                `2026-07-${String(20 + index).padStart(2, '0')}T10:36:00+08:00`,
              );
              return {
                id: `a0000${customer.publicId}-0000-4000-8000-000000000${customer.publicId}`,
                orderId: `e0000${customer.publicId}-0000-4000-8000-000000000${customer.publicId}`,
                provider: 'wechat',
                channel: 'native' as const,
                outTradeNo: `TOKDEMO${customer.publicId}`,
                externalId: `DEMO-WECHAT-${customer.publicId}`,
                status: 'succeeded' as const,
                amount: canonicalDemoTicket!.price,
                currency: canonicalDemoTicket!.currency,
                succeededAt,
                payload: { source: 'local-demo-seed' },
                createdAt: succeededAt,
                updatedAt: succeededAt,
              };
            }),
          )
          .onConflictDoUpdate({
            target: payments.id,
            set: {
              status: 'succeeded',
              amount: sql`excluded.amount`,
              currency: sql`excluded.currency`,
              succeededAt: sql`excluded.succeeded_at`,
              updatedAt: sql`excluded.updated_at`,
            },
          });

        await tx
          .insert(tickets)
          .values(
            publicDemoCustomers.map((customer, index) => {
              const issuedAt = new Date(
                `2026-07-${String(20 + index).padStart(2, '0')}T10:36:30+08:00`,
              );
              return {
                id: `f0000${customer.publicId}-0000-4000-8000-000000000${customer.publicId}`,
                eventId: DEMO_IDS.event,
                registrationId: `d0000${customer.publicId}-0000-4000-8000-000000000${customer.publicId}`,
                ticketTypeId: demoTicketTypeId!,
                code: `TOKEMS-DEMO-TICKET-${customer.publicId}`,
                status: index === 0 ? ('valid' as const) : ('used' as const),
                issuedAt,
                createdAt: issuedAt,
                updatedAt: issuedAt,
              };
            }),
          )
          .onConflictDoUpdate({
            target: tickets.id,
            set: {
              ticketTypeId: sql`excluded.ticket_type_id`,
              status: sql`excluded.status`,
              updatedAt: sql`excluded.updated_at`,
            },
          });

        const demoIndustries = ['ai', 'brand-marketing-geo', 'internet-software-it'] as const;
        await tx
          .insert(attendeeShowcaseProfiles)
          .values(
            publicDemoCustomers.map((customer, index) => {
              const qualifiedAt = new Date(
                `2026-07-${String(20 + index).padStart(2, '0')}T10:36:00+08:00`,
              );
              return {
                id: `91000${customer.publicId}-0000-4000-8000-000000000${customer.publicId}`,
                organizationId: DEMO_IDS.organization,
                eventId: DEMO_IDS.event,
                registrationId: `d0000${customer.publicId}-0000-4000-8000-000000000${customer.publicId}`,
                customerUserId: customer.id,
                publicSlug: `demo-member-${customer.publicId}`,
                qualifiedAt,
                sequence: index + 1,
                displayName: customer.realName,
                company: customer.company,
                title: customer.title,
                industryCode: demoIndustries[index]!,
                businessIntro: [
                  '关注 AI 产品商业化与企业增长，希望认识品牌市场和产品方向的同行。',
                  '为企业大会和行业活动提供内容策划与运营咨询，期待交流高质量活动增长。',
                  '正在研究 AI 搜索场景下的新产品机会，希望连接数据、内容与品牌团队。',
                ][index]!,
                businessUrl: 'https://example.com',
                contactPhone: customer.mobile,
                contactEmail: `demo${customer.publicId}@tokems.local`,
                isPublic: true,
                visibleFields: {
                  avatar: true,
                  displayName: true,
                  company: true,
                  title: true,
                  industry: true,
                  businessIntro: true,
                  businessUrl: true,
                  contactPhone: false,
                  contactEmail: false,
                  wechatId: false,
                },
                consentVersion: ATTENDEE_SHOWCASE_CONSENT_VERSION,
                consentAt: qualifiedAt,
                createdAt: qualifiedAt,
                updatedAt: qualifiedAt,
              };
            }),
          )
          .onConflictDoUpdate({
            target: attendeeShowcaseProfiles.id,
            set: {
              displayName: sql`excluded.display_name`,
              company: sql`excluded.company`,
              title: sql`excluded.title`,
              industryCode: sql`excluded.industry_code`,
              businessIntro: sql`excluded.business_intro`,
              isPublic: true,
              visibleFields: sql`excluded.visible_fields`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      }

      if (CANONICAL_HOMEPAGE_SNAPSHOT.ticketQuotas.length) {
        const existingQuotaRows = await tx
          .select({ id: ticketQuotas.id, sold: ticketQuotas.sold })
          .from(ticketQuotas)
          .where(eq(ticketQuotas.eventId, DEMO_IDS.event))
          .for('update');
        const existingQuotaById = new Map(existingQuotaRows.map((quota) => [quota.id, quota]));
        for (const quota of CANONICAL_HOMEPAGE_SNAPSHOT.ticketQuotas) {
          const existing = existingQuotaById.get(String(quota.id));
          if (existing && Number(quota.capacity) < existing.sold) {
            throw new Error(
              `Canonical quota ${String(quota.id)} capacity ${Number(quota.capacity)} is below production sold inventory ${existing.sold}`,
            );
          }
        }
        await tx
          .insert(ticketQuotas)
          .values(
            CANONICAL_HOMEPAGE_SNAPSHOT.ticketQuotas.map((quota) => ({
              id: String(quota.id),
              eventId: DEMO_IDS.event,
              name: String(quota.name),
              capacity: Number(quota.capacity),
              sold: 0,
              ticketTypeIds: (quota.ticketTypeIds as string[]).map(
                (ticketId) => ticketIdMap.get(ticketId) ?? ticketId,
              ),
            })),
          )
          .onConflictDoUpdate({
            target: ticketQuotas.id,
            set: {
              name: sql`excluded.name`,
              capacity: sql`excluded.capacity`,
              ticketTypeIds: sql`excluded.ticket_type_ids`,
              updatedAt: new Date(),
            },
          });
      }
      // Extra quota rows are retained because their sold counters are production business facts.

      const canonicalReleaseForm = canonicalRelease.snapshot.registrationForm as {
        id: string;
        name: string;
        version: number;
        fields: typeof canonicalBackend.registrationForm.fields;
        termsVersion: string;
        termsContent: string;
      };
      const canonicalForms = [
        ...(canonicalReleaseForm.version === canonicalBackend.registrationForm.version
          ? []
          : [{ ...canonicalReleaseForm, status: 'archived' }]),
        { ...canonicalBackend.registrationForm, status: 'published' },
      ];
      const formIdMap = new Map<string, string>();
      for (const form of canonicalForms) {
        const desiredForm = {
          id: form.id,
          eventId: DEMO_IDS.event,
          name: form.name,
          version: form.version,
          status: form.status,
          fields: form.fields as (typeof registrationForms.$inferInsert)['fields'],
          termsVersion: form.termsVersion,
          termsContent: form.termsContent,
          ...(form.status === 'published' ? { publishedAt: new Date() } : {}),
        };
        const [insertedForm] = await tx
          .insert(registrationForms)
          .values(desiredForm)
          .onConflictDoNothing({
            target: [registrationForms.eventId, registrationForms.version],
          })
          .returning();
        const [seededForm] = insertedForm
          ? [insertedForm]
          : await tx
              .select()
              .from(registrationForms)
              .where(
                and(
                  eq(registrationForms.eventId, DEMO_IDS.event),
                  eq(registrationForms.version, form.version),
                ),
              );
        if (!seededForm) throw new Error(`Registration form V${form.version} could not be seeded`);
        assertCanonicalValue(
          `Registration form V${form.version}`,
          {
            name: seededForm.name,
            fields: seededForm.fields,
            termsVersion: seededForm.termsVersion,
            termsContent: seededForm.termsContent,
          },
          {
            name: form.name,
            fields: form.fields,
            termsVersion: form.termsVersion,
            termsContent: form.termsContent,
          },
        );
        await tx
          .update(registrationForms)
          .set({
            status: form.status,
            ...(form.status === 'published' && !seededForm.publishedAt
              ? { publishedAt: new Date() }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(registrationForms.id, seededForm.id));
        formIdMap.set(form.id, seededForm.id);
        if (form.version === canonicalReleaseForm.version) {
          formIdMap.set(canonicalReleaseForm.id, seededForm.id);
        }
        if (form.version === canonicalBackend.registrationForm.version) {
          formIdMap.set(canonicalBackend.registrationForm.id, seededForm.id);
        }
      }
      await tx.execute(sql`
      update ${registrationForms}
      set status = 'archived', updated_at = now()
      where event_id = ${DEMO_IDS.event}
        and version <> ${canonicalBackend.registrationForm.version}
        and status = 'published'
    `);

      const demoSpeakerRows = canonicalBackend.speakers.map((speaker, sortOrder) => ({
        id: String(speaker.id),
        organizationId: DEMO_IDS.organization,
        eventId: DEMO_IDS.event,
        name: String(speaker.name),
        role: String(speaker.role),
        topic: String(speaker.topic),
        initials: String(speaker.initials),
        accentFrom: String(speaker.accentFrom),
        accentTo: String(speaker.accentTo),
        tags: speaker.tags as string[],
        avatarAssetId:
          typeof speaker.avatarAssetId === 'string'
            ? (assetIdMap.get(speaker.avatarAssetId) ?? speaker.avatarAssetId)
            : null,
        bio: typeof speaker.bio === 'string' ? speaker.bio : null,
        topicAbstract: typeof speaker.topicAbstract === 'string' ? speaker.topicAbstract : null,
        websiteUrl: typeof speaker.websiteUrl === 'string' ? speaker.websiteUrl : null,
        socialLinks: (speaker.socialLinks ?? []) as (typeof speakers.$inferInsert)['socialLinks'],
        sortOrder: Number(speaker.sortOrder ?? sortOrder),
      }));

      const canonicalSpeakerIds = demoSpeakerRows.map((speaker) => speaker.id);
      await tx.delete(speakerPublicRoutes).where(eq(speakerPublicRoutes.eventId, DEMO_IDS.event));
      await tx
        .delete(speakers)
        .where(
          canonicalSpeakerIds.length
            ? and(
                eq(speakers.eventId, DEMO_IDS.event),
                notInArray(speakers.id, canonicalSpeakerIds),
              )
            : eq(speakers.eventId, DEMO_IDS.event),
        );
      if (demoSpeakerRows.length) {
        await tx
          .insert(speakers)
          .values(demoSpeakerRows)
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
              avatarAssetId: sql`excluded.avatar_asset_id`,
              bio: sql`excluded.bio`,
              topicAbstract: sql`excluded.topic_abstract`,
              websiteUrl: sql`excluded.website_url`,
              socialLinks: sql`excluded.social_links`,
              sortOrder: sql`excluded.sort_order`,
              updatedAt: new Date(),
            },
          });
      }

      const canonicalSpeakerRoutes = canonicalBackend.speakerRoutes.map((route) => ({
        organizationId: DEMO_IDS.organization,
        eventId: DEMO_IDS.event,
        speakerId: String(route.speakerId),
        publicCode: String(route.publicCode),
      }));
      if (canonicalSpeakerRoutes.length) {
        await tx
          .insert(speakerPublicRoutes)
          .values(canonicalSpeakerRoutes)
          .onConflictDoUpdate({
            target: [
              speakerPublicRoutes.organizationId,
              speakerPublicRoutes.eventId,
              speakerPublicRoutes.speakerId,
            ],
            set: { publicCode: sql`excluded.public_code` },
          });
      }

      const canonicalSessionRows = canonicalBackend.sessions.map((session, sortOrder) => ({
        id: String(session.id),
        eventId: DEMO_IDS.event,
        day: Number(session.day),
        startsAt: new Date(String(session.startsAt)),
        endsAt: new Date(String(session.endsAt)),
        title: String(session.title),
        summary: typeof session.summary === 'string' ? session.summary : null,
        speaker: typeof session.speaker === 'string' ? session.speaker : null,
        kind: String(session.kind),
        sortOrder: Number(session.sortOrder ?? sortOrder),
      }));
      const canonicalSessionIds = canonicalSessionRows.map((session) => session.id);
      await tx
        .delete(sessions)
        .where(
          canonicalSessionIds.length
            ? and(
                eq(sessions.eventId, DEMO_IDS.event),
                notInArray(sessions.id, canonicalSessionIds),
              )
            : eq(sessions.eventId, DEMO_IDS.event),
        );
      if (canonicalSessionRows.length) {
        await tx
          .insert(sessions)
          .values(canonicalSessionRows)
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
      }

      if (CANONICAL_HOMEPAGE_SNAPSHOT.checkinLists.length) {
        await tx
          .insert(checkinLists)
          .values(
            CANONICAL_HOMEPAGE_SNAPSHOT.checkinLists.map((list) => ({
              id: String(list.id),
              eventId: DEMO_IDS.event,
              code: String(list.code),
              name: String(list.name),
              rules: list.rules as Record<string, unknown>,
            })),
          )
          .onConflictDoUpdate({
            target: [checkinLists.eventId, checkinLists.code],
            set: {
              name: sql`excluded.name`,
              rules: sql`excluded.rules`,
              updatedAt: new Date(),
            },
          });
      }
      // Extra check-in lists are retained because check-in records reference them as history.

      const releaseIdMap = new Map([
        ...assetReferenceMap,
        ...ticketIdMap,
        ...templateVersionIdMap,
        ...formIdMap,
      ]);
      const seededReleaseTemplateVersionId = canonicalRelease.templateVersionId
        ? templateVersionIdMap.get(canonicalRelease.templateVersionId)
        : null;
      if (canonicalRelease.templateVersionId && !seededReleaseTemplateVersionId) {
        throw new Error('Canonical release template version could not be resolved');
      }
      const releaseSnapshot = remapCanonicalReferences(
        canonicalRelease.snapshot,
        releaseIdMap,
      ) as Record<string, unknown>;
      for (const ticketValue of (releaseSnapshot.tickets ?? []) as Array<Record<string, unknown>>) {
        if (typeof ticketValue.id !== 'string' || typeof ticketValue.capacity !== 'number') {
          continue;
        }
        const minimumCapacity = minimumCapacityByTicketId.get(ticketValue.id) ?? 0;
        if (ticketValue.capacity < minimumCapacity) {
          throw new Error(
            `Canonical release ticket ${String(ticketValue.code ?? ticketValue.id)} capacity ${ticketValue.capacity} is below production sold and held inventory ${minimumCapacity}`,
          );
        }
      }
      const [seededRelease] = await tx
        .insert(eventReleases)
        .values({
          id: canonicalRelease.id,
          eventId: DEMO_IDS.event,
          version: canonicalRelease.version,
          templateKey: canonicalRelease.templateKey,
          templateVersionId: seededReleaseTemplateVersionId,
          status: 'published',
          snapshot: releaseSnapshot,
          artifactKey: `releases/${DEMO_IDS.event}/v${canonicalRelease.version}/index.json`,
          changeSummary: canonicalRelease.changeSummary,
          changeScope: canonicalRelease.changeScope as
            | 'site'
            | 'event'
            | 'experience'
            | 'registration'
            | 'ticket'
            | 'content'
            | 'form'
            | 'lifecycle',
          activationKind: canonicalRelease.activationKind as 'initial' | 'save' | 'manual',
          createdBy: adminUserId,
        })
        .onConflictDoNothing({
          target: [eventReleases.eventId, eventReleases.version],
        })
        .returning();

      const [resolvedRelease] = seededRelease
        ? [seededRelease]
        : await tx
            .select()
            .from(eventReleases)
            .where(
              and(
                eq(eventReleases.eventId, DEMO_IDS.event),
                eq(eventReleases.version, canonicalRelease.version),
              ),
            );
      if (!resolvedRelease) {
        throw new Error('Canonical event release could not be seeded');
      }
      assertCanonicalValue(
        `Event release V${canonicalRelease.version}`,
        {
          templateKey: resolvedRelease.templateKey,
          templateVersionId: resolvedRelease.templateVersionId,
          status: resolvedRelease.status,
          snapshot: resolvedRelease.snapshot,
          changeSummary: resolvedRelease.changeSummary,
          changeScope: resolvedRelease.changeScope,
          activationKind: resolvedRelease.activationKind,
        },
        {
          templateKey: canonicalRelease.templateKey,
          templateVersionId: seededReleaseTemplateVersionId,
          status: 'published',
          snapshot: releaseSnapshot,
          changeSummary: canonicalRelease.changeSummary,
          changeScope: canonicalRelease.changeScope,
          activationKind: canonicalRelease.activationKind,
        },
      );
      await tx.execute(sql`
      update ${events}
      set settings = (settings - 'templateVersionId') || jsonb_build_object(
        'currentReleaseId', ${resolvedRelease.id}::text,
        'templateKey', ${canonicalRelease.templateKey}::text
      ) || case
        when ${seededReleaseTemplateVersionId}::text is null then '{}'::jsonb
        else jsonb_build_object('templateVersionId', ${seededReleaseTemplateVersionId}::text)
      end
      where id = ${DEMO_IDS.event}
    `);

      const canonicalNotificationRows = CANONICAL_HOMEPAGE_SNAPSHOT.notificationTemplates.map(
        (template) => ({
          id: String(template.id),
          organizationId: DEMO_IDS.organization,
          code: String(template.code),
          name: String(template.name),
          channel: String(template.channel),
          subject: String(template.subject),
          body: String(template.body),
          status: String(template.status),
          version: Number(template.version),
        }),
      );
      const canonicalNotificationKeys = new Set(
        canonicalNotificationRows.map((template) => `${template.code}:${template.version}`),
      );
      const activeNotifications = await tx
        .select({
          id: notificationTemplates.id,
          code: notificationTemplates.code,
          version: notificationTemplates.version,
        })
        .from(notificationTemplates)
        .where(
          and(
            eq(notificationTemplates.organizationId, DEMO_IDS.organization),
            eq(notificationTemplates.status, 'active'),
          ),
        );
      for (const template of activeNotifications) {
        if (canonicalNotificationKeys.has(`${template.code}:${template.version}`)) continue;
        await tx
          .update(notificationTemplates)
          .set({ status: 'archived', updatedAt: new Date() })
          .where(eq(notificationTemplates.id, template.id));
      }
      if (canonicalNotificationRows.length) {
        await tx
          .insert(notificationTemplates)
          .values(canonicalNotificationRows)
          .onConflictDoUpdate({
            target: [
              notificationTemplates.organizationId,
              notificationTemplates.code,
              notificationTemplates.version,
            ],
            set: {
              name: sql`excluded.name`,
              channel: sql`excluded.channel`,
              subject: sql`excluded.subject`,
              body: sql`excluded.body`,
              status: sql`excluded.status`,
              updatedAt: new Date(),
            },
          });
      }

      const canonicalPromptRows = CANONICAL_HOMEPAGE_SNAPSHOT.aiPrompts.map((prompt) => ({
        id: String(prompt.id),
        organizationId: DEMO_IDS.organization,
        code: String(prompt.code),
        name: String(prompt.name),
        version: Number(prompt.version),
        status: String(prompt.status),
        systemPrompt: String(prompt.systemPrompt),
      }));
      const canonicalPromptKeys = new Set(
        canonicalPromptRows.map((prompt) => `${prompt.code}:${prompt.version}`),
      );
      const activePrompts = await tx
        .select({ id: aiPrompts.id, code: aiPrompts.code, version: aiPrompts.version })
        .from(aiPrompts)
        .where(
          and(eq(aiPrompts.organizationId, DEMO_IDS.organization), eq(aiPrompts.status, 'active')),
        );
      for (const prompt of activePrompts) {
        if (canonicalPromptKeys.has(`${prompt.code}:${prompt.version}`)) continue;
        await tx
          .update(aiPrompts)
          .set({ status: 'archived', updatedAt: new Date() })
          .where(eq(aiPrompts.id, prompt.id));
      }
      if (canonicalPromptRows.length) {
        await tx
          .insert(aiPrompts)
          .values(canonicalPromptRows)
          .onConflictDoUpdate({
            target: [aiPrompts.organizationId, aiPrompts.code, aiPrompts.version],
            set: {
              name: sql`excluded.name`,
              status: sql`excluded.status`,
              systemPrompt: sql`excluded.system_prompt`,
              updatedAt: new Date(),
            },
          });
      }
    },
    { isolationLevel: 'serializable' },
  );

  console.info('Conference seed data is ready');
} finally {
  await pool.end();
}
