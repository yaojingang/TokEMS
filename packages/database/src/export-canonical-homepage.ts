import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sanitizeHtmlTemplate, sha256Digest } from '@conference/html-template';

const { Client } = pg;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshotPath = resolve(
  repositoryRoot,
  'packages/contracts/src/canonical-homepage.snapshot.json',
);
const publicSnapshotPath = resolve(
  repositoryRoot,
  'packages/contracts/src/canonical-homepage.public.json',
);
const canonicalApiBaseUrl = (
  process.env.CANONICAL_API_BASE_URL ?? 'http://127.0.0.1:8088/api/v1'
).replace(/\/$/u, '');
const localHomepageUrl = `${canonicalApiBaseUrl}/homepage`;
const localDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://conference:conference@127.0.0.1:15432/conference';
const trustedComposeInternalExport =
  process.env.CANONICAL_EXPORT_TRUSTED_COMPOSE_INTERNAL === 'true';
const canonicalOrganizationSlug = 'geo-conference';
const canonicalEventSlug = 'tokems26';
const canonicalBlueprintId = '77777777-7777-4777-8777-777777777777';
const maxCanonicalAssetCount = 500;
const maxCanonicalAssetBytes = 8 * 1024 * 1024;
const maxCanonicalAssetTotalBytes = 16 * 1024 * 1024;
const maxCanonicalSnapshotBytes = 24 * 1024 * 1024;
const sensitiveKeyPattern =
  /(admin(?:istrator)?|authorization|cookie|credential|encrypted|password|private.?key|secret|token|api.?(?:key|url)|access.?key|endpoint|integration|webhook|created.?by|updated.?by|owner.?id|user.?id|member.?id)/iu;
const sensitiveValuePatterns = [
  /postgres(?:ql)?:\/\//iu,
  /bearer\s+[a-z0-9._~-]+/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /X-Amz-Credential=/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bgh[pousr]_[0-9A-Za-z]{30,}\b/u,
  /\bsk-(?:proj-|live-)?[0-9A-Za-z_-]{20,}\b/u,
  /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/u,
  /\bglpat-[0-9A-Za-z_-]{20,}\b/u,
  /\bSG\.[0-9A-Za-z_-]{16,}\.[0-9A-Za-z_-]{16,}\b/u,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /(?:api.?key|access.?key|password|private.?key|secret|token)\s*[:=]\s*["']?[0-9A-Za-z+/_=-]{12,}/iu,
  /https?:\/\/(?:api\.|[^/\s]+\/api(?:\/|$))/iu,
];

type JsonRecord = Record<string, unknown>;
type CanonicalRenderer = {
  id: string;
  key: string;
  name: string;
  version: number;
  status: string;
  description: string;
  manifest: JsonRecord;
};
type CanonicalPublishedVersion = {
  id: string;
  templateId: string;
  version: number;
  rendererPackageId: string;
  schemaVersion: number;
  definition: JsonRecord;
  contentDigest: string;
  previewAssetKey: string | null;
  changeSummary: string;
};

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a string`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

function sortedJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortedJson(item)]),
  );
}

function serializedSnapshot(value: unknown) {
  return `${JSON.stringify(sortedJson(value), null, 2)}\n`;
}

function canonicalDatabaseProof(
  challenge: string,
  identity: {
    systemIdentifier: string;
    databaseName: string;
    databaseOid: string;
    startedAt: string;
  },
) {
  return createHash('sha256')
    .update(
      `${challenge}\n${identity.systemIdentifier}\n${identity.databaseName}\n${identity.databaseOid}\n${identity.startedAt}`,
    )
    .digest('hex');
}

export function validateCanonicalExportTopology(input: {
  databaseUrl: string;
  apiBaseUrl: string;
  trustedComposeInternal: boolean;
  deploymentMode?: string | undefined;
}) {
  const databaseUrl = new URL(input.databaseUrl);
  const apiUrl = new URL(input.apiBaseUrl);
  if (input.trustedComposeInternal) {
    const databaseOptions = databaseUrl.searchParams.getAll('options').join(' ');
    if (
      input.deploymentMode !== 'production' ||
      databaseUrl.hostname !== 'postgres' ||
      (databaseUrl.port || '5432') !== '5432' ||
      !/(?:^|\s)-c\s+default_transaction_read_only=on(?:\s|$)/u.test(databaseOptions) ||
      apiUrl.protocol !== 'http:' ||
      apiUrl.hostname !== 'api' ||
      (apiUrl.port || '80') !== '4100' ||
      apiUrl.pathname !== '/api/v1' ||
      apiUrl.search ||
      apiUrl.hash ||
      apiUrl.username ||
      apiUrl.password
    ) {
      throw new Error(
        'Trusted Compose canonical export requires the production read-only topology',
      );
    }
    return;
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(databaseUrl.hostname)) {
    throw new Error('Canonical export only accepts a loopback DATABASE_URL');
  }
}

function canonicalPublicSnapshot(snapshot: JsonRecord) {
  const source = record(snapshot.source, 'canonical snapshot source');
  const template = record(snapshot.template, 'canonical template');
  const root = record(template.root, 'canonical template root');
  const version = record(template.version, 'canonical template version');
  const release = record(snapshot.release, 'canonical release');
  const releaseSnapshot = record(release.snapshot, 'canonical release snapshot');
  const publishedVersions = array(
    template.publishedVersions,
    'canonical published template versions',
  ).map((item) => record(item, 'canonical published template version'));
  const publicTemplateVersion =
    publishedVersions.find((item) => item.id === release.templateVersionId) ?? version;
  return {
    schemaVersion: 1,
    source,
    publicEvent: snapshot.publicEvent,
    speakerProfiles: releaseSnapshot.speakers,
    template: {
      rootId: root.id,
      versionId: publicTemplateVersion.id,
      version: publicTemplateVersion.version,
      definition: publicTemplateVersion.definition,
    },
  };
}

function rendererFromRow(row: {
  rendererPackageId: string;
  rendererKey: string;
  rendererName: string;
  rendererVersion: number;
  rendererStatus: string;
  rendererDescription: string;
  rendererManifest: JsonRecord;
}): CanonicalRenderer {
  return {
    id: row.rendererPackageId,
    key: row.rendererKey,
    name: row.rendererName,
    version: row.rendererVersion,
    status: row.rendererStatus,
    description: row.rendererDescription,
    manifest: row.rendererManifest,
  };
}

function versionFromRow(row: {
  versionId: string;
  templateId: string;
  version: number;
  rendererPackageId: string;
  schemaVersion: number;
  definition: JsonRecord;
  contentDigest: string;
  previewAssetKey: string | null;
  changeSummary: string;
}): CanonicalPublishedVersion {
  return {
    id: row.versionId,
    templateId: row.templateId,
    version: row.version,
    rendererPackageId: row.rendererPackageId,
    schemaVersion: row.schemaVersion,
    definition: row.definition,
    contentDigest: row.contentDigest,
    previewAssetKey: row.previewAssetKey,
    changeSummary: row.changeSummary,
  };
}

async function writeAtomically(path: string, content: string) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function pick(source: JsonRecord, keys: readonly string[]) {
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
}

function sanitizeTicket(value: unknown) {
  return pick(record(value, 'release ticket'), [
    'id',
    'code',
    'name',
    'description',
    'price',
    'currency',
    'capacity',
    'active',
    'recommended',
    'benefits',
  ]);
}

function sanitizeSpeaker(value: unknown) {
  return pick(record(value, 'release speaker'), [
    'id',
    'name',
    'role',
    'topic',
    'initials',
    'accentFrom',
    'accentTo',
    'tags',
    'avatarAssetId',
    'bio',
    'topicAbstract',
    'websiteUrl',
    'socialLinks',
    'sortOrder',
  ]);
}

function sanitizeSession(value: unknown) {
  return pick(record(value, 'release session'), [
    'id',
    'day',
    'startsAt',
    'endsAt',
    'title',
    'summary',
    'speaker',
    'kind',
    'sortOrder',
  ]);
}

function sanitizeEvent(value: unknown) {
  const event = record(value, 'release event');
  const settings = { ...record(event.settings, 'release event settings') };
  delete settings.currentReleaseId;
  return {
    ...pick(event, [
      'id',
      'organizationId',
      'slug',
      'name',
      'shortName',
      'tagline',
      'description',
      'status',
      'startsAt',
      'endsAt',
      'timezone',
      'venue',
      'city',
      'address',
    ]),
    settings,
  };
}

function sanitizeExperience(value: unknown) {
  const experience = structuredClone(record(value, 'release experience'));
  delete experience.overrideRevisions;
  const template = record(experience.template, 'release experience template');
  delete template.bindingRevision;
  experience.template = template;
  const home = experience.home;
  if (home && typeof home === 'object' && !Array.isArray(home)) {
    const seo = (home as JsonRecord).seo;
    if (seo && typeof seo === 'object' && !Array.isArray(seo)) {
      delete (seo as JsonRecord).shareAssetUrl;
    }
  }
  return experience;
}

function sanitizeOrganizationSettings(value: unknown) {
  const settings = record(value, 'organization settings');
  return pick(settings, [
    'brand',
    'locale',
    'brandName',
    'defaultTimezone',
    'defaultCurrency',
    'defaultBlueprintId',
    'defaultTemplateId',
    'customerAccounts',
    'website',
  ]);
}

function referencedAssetIds(value: unknown, found = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const item of value) referencedAssetIds(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, item] of Object.entries(value as JsonRecord)) {
    if ((key === 'assetId' || key === 'avatarAssetId' || key === 'shareAssetId') && item) {
      found.add(string(item, key));
    }
    referencedAssetIds(item, found);
  }
  return found;
}

function referencedHtmlDocumentIds(
  value: unknown,
  templateId: string,
  found = new Map<string, string>(),
) {
  if (Array.isArray(value)) {
    for (const item of value) referencedHtmlDocumentIds(item, templateId, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const item = value as JsonRecord;
  if (item.kind === 'html' && typeof item.documentId === 'string') {
    const existingTemplateId = found.get(item.documentId);
    if (existingTemplateId && existingTemplateId !== templateId) {
      throw new Error(`HTML document ${item.documentId} is referenced across template roots`);
    }
    found.set(item.documentId, templateId);
  }
  for (const child of Object.values(item)) {
    referencedHtmlDocumentIds(child, templateId, found);
  }
  return found;
}

function assertNoSensitiveData(value: unknown, path = 'snapshot') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveData(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (
      typeof value === 'string' &&
      sensitiveValuePatterns.some((pattern) => pattern.test(value))
    ) {
      throw new Error(`Sensitive value detected at ${path}`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value as JsonRecord)) {
    if (sensitiveKeyPattern.test(key)) throw new Error(`Sensitive key detected at ${path}.${key}`);
    assertNoSensitiveData(item, `${path}.${key}`);
  }
}

export function validateCanonicalHtmlDocument(value: unknown) {
  const document = record(value, 'canonical HTML document');
  const sanitizedHtml = string(document.sanitizedHtml, 'canonical sanitized HTML');
  const sanitizedDigest = string(document.sanitizedDigest, 'canonical sanitized HTML digest');
  if (sha256Digest(sanitizedHtml) !== sanitizedDigest) {
    throw new Error('Canonical sanitized HTML digest does not match its content');
  }
  const rescanned = sanitizeHtmlTemplate(sanitizedHtml);
  if (rescanned.sanitizedHtml !== sanitizedHtml || rescanned.securityReport.blockers.length) {
    throw new Error('Canonical HTML document does not pass a clean sanitizer round trip');
  }
  return document;
}

function assertTicketHasNoRuntimeSales(value: unknown, label: string) {
  const ticket = record(value, label);
  if ('sold' in ticket) throw new Error(`${label} must not include sold inventory`);
}

function itemIds(value: unknown, label: string): unknown[] {
  return array(value, label).map((item, index) => record(item, `${label} ${index}`).id);
}

function assertCanonicalMatch(label: string, actual: unknown, expected: unknown) {
  if (serializedSnapshot(actual) !== serializedSnapshot(expected)) {
    throw new Error(`${label} does not match the active release and backend state`);
  }
}

function validatePublicProjection(snapshot: JsonRecord) {
  const source = record(snapshot.source, 'canonical snapshot source');
  const publicEvent = record(snapshot.publicEvent, 'canonical public event');
  const release = record(snapshot.release, 'canonical release');
  const releaseSnapshot = record(release.snapshot, 'canonical release snapshot');
  const releaseEvent = record(releaseSnapshot.event, 'canonical release event');
  const backend = record(snapshot.backend, 'canonical backend settings');
  const backendEvent = record(backend.event, 'canonical backend event');
  assertCanonicalMatch(
    'Canonical public event identity',
    pick(publicEvent, ['id', 'organizationId', 'slug']),
    {
      id: source.eventId,
      organizationId: source.organizationId,
      slug: source.eventSlug,
    },
  );
  assertCanonicalMatch(
    'Canonical public event content',
    pick(publicEvent, [
      'name',
      'shortName',
      'tagline',
      'description',
      'startsAt',
      'endsAt',
      'timezone',
      'venue',
      'city',
      'address',
    ]),
    pick(releaseEvent, [
      'name',
      'shortName',
      'tagline',
      'description',
      'startsAt',
      'endsAt',
      'timezone',
      'venue',
      'city',
      'address',
    ]),
  );
  assertCanonicalMatch('Canonical public event status', publicEvent.status, backendEvent.status);
  const releaseEventSettings = record(releaseEvent.settings, 'canonical release event settings');
  assertCanonicalMatch(
    'Canonical public event stats',
    publicEvent.stats,
    releaseEventSettings.stats,
  );
  const storedRegistration = record(
    releaseEventSettings.registration,
    'canonical release registration settings',
  );
  assertCanonicalMatch('Canonical public registration settings', publicEvent.registration, {
    ...storedRegistration,
    registrationOpen:
      backendEvent.status === 'registration_open' && storedRegistration.registrationOpen !== false,
  });

  const releaseTickets = array(releaseSnapshot.tickets, 'canonical release tickets');
  const backendTickets = array(backend.ticketTypes, 'canonical backend ticket types');
  assertCanonicalMatch(
    'Canonical public ticket identities',
    itemIds(publicEvent.tickets, 'canonical public tickets'),
    itemIds(releaseTickets, 'canonical release tickets'),
  );
  const ticketCapacityById = new Map(
    backendTickets.map((item, index) => {
      const ticket = record(item, `canonical backend ticket ${index}`);
      return [ticket.id, ticket.capacity] as const;
    }),
  );
  array(publicEvent.tickets, 'canonical public tickets').forEach((item, index) => {
    const ticket = record(item, `canonical public ticket ${index}`);
    const released = record(releaseTickets[index], `canonical release ticket ${index}`);
    const live = backendTickets
      .map((backendTicket, backendIndex) =>
        record(backendTicket, `canonical backend ticket ${backendIndex}`),
      )
      .find((backendTicket) => backendTicket.id === ticket.id);
    assertCanonicalMatch(
      `Canonical public ticket ${String(ticket.id)} content`,
      pick(ticket, ['name', 'description', 'price', 'currency', 'benefits', 'recommended']),
      {
        name: released.name ?? live?.name ?? '大会门票',
        description: released.description ?? live?.description ?? '',
        price: released.price ?? live?.price ?? 0,
        currency: released.currency ?? live?.currency ?? 'CNY',
        benefits: released.benefits ?? live?.benefits ?? [],
        recommended: released.recommended ?? live?.recommended ?? false,
      },
    );
    const expectedCapacity = released.capacity ?? ticketCapacityById.get(ticket.id) ?? 0;
    assertCanonicalMatch(
      `Canonical public ticket ${String(ticket.id)} inventory`,
      ticket.remaining,
      expectedCapacity,
    );
  });

  const releaseSpeakers = array(releaseSnapshot.speakers, 'canonical release speakers');
  const expectedSpeakers = releaseSpeakers.length
    ? releaseSpeakers
    : array(backend.speakers, 'canonical backend speakers');
  assertCanonicalMatch(
    'Canonical public speaker identities',
    itemIds(publicEvent.speakers, 'canonical public speakers'),
    itemIds(expectedSpeakers, 'canonical expected speakers'),
  );
  const publicSpeakers = array(publicEvent.speakers, 'canonical public speakers');
  publicSpeakers.forEach((item, index) => {
    const speaker = record(item, `canonical public speaker ${index}`);
    const expected = record(expectedSpeakers[index], `canonical expected speaker ${index}`);
    assertCanonicalMatch(
      `Canonical public speaker ${String(speaker.id)} content`,
      pick(speaker, ['name', 'role', 'topic', 'initials', 'accentFrom', 'accentTo', 'tags']),
      pick(expected, ['name', 'role', 'topic', 'initials', 'accentFrom', 'accentTo', 'tags']),
    );
  });
  const releaseSessions = array(releaseSnapshot.sessions, 'canonical release sessions');
  const expectedSessions = releaseSessions.length
    ? releaseSessions
    : array(backend.sessions, 'canonical backend sessions');
  assertCanonicalMatch(
    'Canonical public session identities',
    itemIds(publicEvent.sessions, 'canonical public sessions'),
    itemIds(expectedSessions, 'canonical expected sessions'),
  );
  const publicSessions = array(publicEvent.sessions, 'canonical public sessions');
  publicSessions.forEach((item, index) => {
    const session = record(item, `canonical public session ${index}`);
    const expected = record(expectedSessions[index], `canonical expected session ${index}`);
    assertCanonicalMatch(
      `Canonical public session ${String(session.id)} content`,
      pick(session, ['day', 'title', 'summary', 'speaker', 'kind']),
      pick(expected, ['day', 'title', 'summary', 'speaker', 'kind']),
    );
  });
  const releaseExperience = releaseSnapshot.experience
    ? record(releaseSnapshot.experience, 'canonical release experience')
    : null;
  const experienceFaq = releaseExperience?.faq
    ? record(releaseExperience.faq, 'canonical release experience FAQ')
    : null;
  const expectedFaqs = experienceFaq
    ? array(experienceFaq.items, 'canonical release FAQ items')
        .map((item, index) => record(item, `canonical release FAQ item ${index}`))
        .filter((item) => item.enabled === true)
        .map((item) => ({ question: item.question, answer: item.answer }))
    : (releaseSnapshot.faqs ?? releaseEventSettings.faqs);
  assertCanonicalMatch('Canonical public FAQ content', publicEvent.faqs, expectedFaqs);
  assertCanonicalMatch(
    'Canonical public registration form',
    pick(record(publicEvent.registrationForm, 'canonical public registration form'), [
      'id',
      'name',
      'version',
      'fields',
      'termsVersion',
      'termsContent',
    ]),
    pick(record(releaseSnapshot.registrationForm, 'canonical release registration form'), [
      'id',
      'name',
      'version',
      'fields',
      'termsVersion',
      'termsContent',
    ]),
  );
  if (releaseSnapshot.experience !== undefined) {
    assertCanonicalMatch(
      'Canonical public experience',
      publicEvent.experience,
      releaseSnapshot.experience,
    );
    if (release.templateVersionId) {
      const publicTemplate = record(
        record(publicEvent.experience, 'canonical public experience').template,
        'canonical public experience template',
      );
      assertCanonicalMatch(
        'Canonical public template version',
        publicTemplate.versionId,
        release.templateVersionId,
      );
      const template = record(snapshot.template, 'canonical template');
      const releaseTemplateVersion = array(
        template.publishedVersions,
        'canonical published template versions',
      )
        .map((item) => record(item, 'canonical published template version'))
        .find((item) => item.id === release.templateVersionId);
      if (!releaseTemplateVersion) {
        throw new Error('Canonical public template version is not reproducible');
      }
      assertCanonicalMatch(
        'Canonical public template root and version',
        pick(publicTemplate, ['id', 'version']),
        {
          id: releaseTemplateVersion.templateId,
          version: releaseTemplateVersion.version,
        },
      );
    }
  }
}

export function validateCanonicalHomepageSnapshot(
  value: unknown,
  purpose: 'snapshot' | 'observation' = 'snapshot',
) {
  const snapshot = record(value, 'canonical snapshot');
  if (snapshot.schemaVersion !== 1) throw new Error('canonical snapshot schemaVersion must be 1');
  const source = record(snapshot.source, 'canonical snapshot source');
  if (source.organizationSlug !== canonicalOrganizationSlug) {
    throw new Error(`canonical organization must be ${canonicalOrganizationSlug}`);
  }
  if (source.eventSlug !== canonicalEventSlug) {
    throw new Error(`canonical event must be ${canonicalEventSlug}`);
  }
  const publicEvent = record(snapshot.publicEvent, 'canonical public event');
  if (publicEvent.slug !== canonicalEventSlug || publicEvent.id !== source.eventId) {
    throw new Error('canonical public event identity does not match its source');
  }
  const release = record(snapshot.release, 'canonical release');
  const releaseSnapshot = record(release.snapshot, 'canonical release snapshot');
  const backend = record(snapshot.backend, 'canonical backend settings');
  const backendTicketTypes = array(backend.ticketTypes, 'canonical backend ticket types');
  if (
    !backendTicketTypes.length ||
    !backendTicketTypes.some((ticket) => record(ticket, 'canonical backend ticket').active === true)
  ) {
    throw new Error('canonical backend requires at least one active ticket type');
  }
  const backendSpeakers = array(backend.speakers, 'canonical backend speakers').map(
    (speaker, index) => record(speaker, `canonical backend speaker ${index}`),
  );
  const backendSpeakerIds = new Set(backendSpeakers.map((speaker) => speaker.id));
  const speakerRouteIds = new Set<string>();
  for (const [index, routeValue] of array(
    backend.speakerRoutes,
    'canonical backend speaker routes',
  ).entries()) {
    const route = record(routeValue, `canonical backend speaker route ${index}`);
    const speakerId = string(route.speakerId, `canonical backend speaker route ${index} id`);
    if (!backendSpeakerIds.has(speakerId) || speakerRouteIds.has(speakerId)) {
      throw new Error('Canonical backend speaker routes do not match the speaker collection');
    }
    speakerRouteIds.add(speakerId);
  }
  if (speakerRouteIds.size !== backendSpeakerIds.size) {
    throw new Error('Every canonical backend speaker must have one public route');
  }
  const backendForm = record(backend.registrationForm, 'canonical backend registration form');
  if (!array(releaseSnapshot.tickets, 'canonical release tickets').length) {
    throw new Error('canonical release requires at least one ticket');
  }
  array(releaseSnapshot.speakers, 'canonical release speakers');
  const activeForm = record(
    releaseSnapshot.registrationForm,
    'canonical release registration form',
  );
  if (purpose === 'snapshot') {
    const formKeys = ['id', 'version', 'name', 'fields', 'termsVersion', 'termsContent'];
    assertCanonicalMatch(
      'Canonical registration form must match the active form',
      pick(backendForm, formKeys),
      pick(activeForm, formKeys),
    );
  }
  const template = record(snapshot.template, 'canonical template');
  const templateRoot = record(template.root, 'canonical template root');
  const templateVersion = record(template.version, 'canonical bound template version');
  const publishedVersions = array(
    template.publishedVersions,
    'canonical published template versions',
  ).map((version, index) => record(version, `canonical published template version ${index}`));
  const publishedVersionIds = new Set(publishedVersions.map((version) => version.id));
  const releaseRoot = template.releaseRoot
    ? record(template.releaseRoot, 'canonical release template root')
    : null;
  const templateRootIds = new Set([templateRoot.id, releaseRoot?.id].filter(Boolean));
  if (publishedVersions.some((version) => !templateRootIds.has(version.templateId))) {
    throw new Error('Canonical published template version references a missing template root');
  }
  const organization = record(snapshot.organization, 'canonical organization');
  const organizationSettings = record(organization.settings, 'canonical organization settings');
  if (
    organizationSettings.defaultTemplateId &&
    !templateRootIds.has(organizationSettings.defaultTemplateId)
  ) {
    throw new Error(
      'Canonical default template must be the homepage binding or active release template',
    );
  }
  if (!publishedVersionIds.has(templateVersion.id)) {
    throw new Error('Canonical bound template version is missing from publishedVersions');
  }
  if (
    templateRoot.currentPublishedVersionId &&
    !publishedVersionIds.has(templateRoot.currentPublishedVersionId)
  ) {
    throw new Error(
      'Canonical current published template version is missing from publishedVersions',
    );
  }
  if (release.templateVersionId !== null && !publishedVersionIds.has(release.templateVersionId)) {
    throw new Error('Canonical release template version is missing from publishedVersions');
  }
  const renderers = array(template.renderers, 'canonical template renderers').map(
    (renderer, index) => record(renderer, `canonical template renderer ${index}`),
  );
  const rendererIds = new Set(renderers.map((renderer) => renderer.id));
  const templateDraft = record(template.draft, 'canonical template draft');
  if (
    publishedVersions.some((version) => !rendererIds.has(version.rendererPackageId)) ||
    !rendererIds.has(templateDraft.rendererPackageId)
  ) {
    throw new Error('Canonical template version references a renderer missing from the snapshot');
  }
  const htmlDocumentReferences = new Map<string, string>();
  for (const version of publishedVersions) {
    referencedHtmlDocumentIds(
      version.definition,
      string(version.templateId, 'template root id'),
      htmlDocumentReferences,
    );
  }
  referencedHtmlDocumentIds(
    templateDraft.definition,
    string(templateRoot.id, 'template root id'),
    htmlDocumentReferences,
  );
  if (release.templateVersionId) {
    const releaseVersion = publishedVersions.find(
      (version) => version.id === release.templateVersionId,
    );
    if (!releaseVersion) throw new Error('Canonical release template version is not reproducible');
    referencedHtmlDocumentIds(
      releaseSnapshot,
      string(releaseVersion.templateId, 'release template root id'),
      htmlDocumentReferences,
    );
  }
  const htmlDocuments = array(template.htmlDocuments, 'canonical HTML documents').map(
    (document, index) =>
      validateCanonicalHtmlDocument(record(document, `canonical HTML document ${index}`)),
  );
  const capturedDocumentIds = new Set<string>();
  for (const document of htmlDocuments) {
    const documentId = string(document.id, 'canonical HTML document id');
    const templateId = string(document.templateId, 'canonical HTML document template id');
    if (capturedDocumentIds.has(documentId)) {
      throw new Error(`Canonical HTML document ${documentId} is duplicated`);
    }
    capturedDocumentIds.add(documentId);
    if (htmlDocumentReferences.get(documentId) !== templateId) {
      throw new Error(`Canonical HTML document ${documentId} does not match its template root`);
    }
  }
  if (
    capturedDocumentIds.size !== htmlDocumentReferences.size ||
    [...htmlDocumentReferences.keys()].some((documentId) => !capturedDocumentIds.has(documentId))
  ) {
    throw new Error('Canonical HTML template definitions are not fully reproducible');
  }
  const canonicalAssets = array(snapshot.assets, 'canonical assets');
  if (canonicalAssets.length > maxCanonicalAssetCount) {
    throw new Error(`Canonical template references more than ${maxCanonicalAssetCount} assets`);
  }
  let totalAssetBytes = 0;
  canonicalAssets.forEach((assetValue, index) => {
    const asset = record(assetValue, `canonical asset ${index}`);
    const content = Buffer.from(
      string(asset.contentBase64, `canonical asset ${index} content`),
      'base64',
    );
    const expectedSize = number(asset.size, `canonical asset ${index} size`);
    const expectedDigest = string(asset.contentDigest, `canonical asset ${index} digest`);
    const mediaType = string(asset.mediaType, `canonical asset ${index} media type`);
    if (
      content.byteLength !== expectedSize ||
      createHash('sha256').update(content).digest('hex') !== expectedDigest
    ) {
      throw new Error(`Canonical asset ${index} content does not match its metadata`);
    }
    if (content.byteLength > maxCanonicalAssetBytes) {
      throw new Error(`Canonical asset ${index} exceeds the per-file size limit`);
    }
    if (/^(?:text\/|application\/(?:json|javascript|xml)|image\/svg\+xml)/iu.test(mediaType)) {
      assertNoSensitiveData(content.toString('utf8'), `canonical asset ${index} content`);
    }
    totalAssetBytes += content.byteLength;
  });
  if (totalAssetBytes > maxCanonicalAssetTotalBytes) {
    throw new Error('Canonical template assets exceed the repository size limit');
  }
  array(backend.ticketTypes, 'canonical backend ticket types').forEach((ticket, index) =>
    assertTicketHasNoRuntimeSales(ticket, `canonical backend ticket ${index}`),
  );
  array(releaseSnapshot.tickets, 'canonical release tickets').forEach((ticket, index) =>
    assertTicketHasNoRuntimeSales(ticket, `canonical release ticket ${index}`),
  );
  array(snapshot.ticketQuotas, 'canonical ticket quotas').forEach((quota, index) => {
    const row = record(quota, `canonical ticket quota ${index}`);
    if ('sold' in row) throw new Error(`canonical ticket quota ${index} must not include sold`);
  });
  const blueprintIds = new Set(
    array(snapshot.blueprints, 'canonical blueprints').map(
      (blueprint, index) => record(blueprint, `canonical blueprint ${index}`).id,
    ),
  );
  if (
    organizationSettings.defaultBlueprintId &&
    !blueprintIds.has(organizationSettings.defaultBlueprintId)
  ) {
    throw new Error('Canonical default blueprint is missing from the snapshot');
  }
  validatePublicProjection(snapshot);
  assertNoSensitiveData(snapshot);
  if (Buffer.byteLength(serializedSnapshot(snapshot), 'utf8') > maxCanonicalSnapshotBytes) {
    throw new Error('Canonical homepage snapshot exceeds the Git repository file-size limit');
  }
  return snapshot;
}

function validateCanonicalPublicSnapshot(value: unknown, fullSnapshot: JsonRecord) {
  const publicSnapshot = record(value, 'canonical public snapshot');
  if (
    serializedSnapshot(publicSnapshot) !== serializedSnapshot(canonicalPublicSnapshot(fullSnapshot))
  ) {
    throw new Error('Canonical public snapshot does not match the full canonical snapshot');
  }
  return publicSnapshot;
}

async function downloadAsset(assetId: string, expectedDigest: string, expectedSize: number) {
  if (expectedSize > maxCanonicalAssetBytes) {
    throw new Error(`Template asset ${assetId} exceeds the canonical per-file size limit`);
  }
  const response = await fetch(
    `${canonicalApiBaseUrl}/assets/templates/${encodeURIComponent(assetId)}`,
    { redirect: 'follow', signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) throw new Error(`Template asset ${assetId} returned HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maxCanonicalAssetBytes) {
    throw new Error(`Template asset ${assetId} exceeds the canonical per-file size limit`);
  }
  if (!response.body) throw new Error(`Template asset ${assetId} returned an empty body`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedSize += value.byteLength;
    if (receivedSize > maxCanonicalAssetBytes) {
      await reader.cancel();
      throw new Error(`Template asset ${assetId} exceeds the canonical per-file size limit`);
    }
    chunks.push(value);
  }
  const content = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (content.byteLength !== expectedSize) {
    throw new Error(`Template asset ${assetId} size mismatch`);
  }
  const digest = createHash('sha256').update(content).digest('hex');
  if (digest !== expectedDigest) {
    throw new Error(`Template asset ${assetId} digest mismatch`);
  }
  return content.toString('base64');
}

async function buildSnapshot() {
  validateCanonicalExportTopology({
    databaseUrl: localDatabaseUrl,
    apiBaseUrl: canonicalApiBaseUrl,
    trustedComposeInternal: trustedComposeInternalExport,
    deploymentMode: process.env.DEPLOYMENT_MODE,
  });

  const client = new Client({ connectionString: localDatabaseUrl });
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query('begin isolation level repeatable read');
    transactionOpen = true;
    await client.query(`set local lock_timeout = '5s'`);
    await client.query(`
      lock table
        organizations,
        organization_homepage_events,
        events,
        event_releases,
        event_template_bindings,
        conference_templates,
        conference_template_versions,
        conference_template_drafts,
        template_packages,
        registration_forms,
        event_blueprints,
        ticket_quotas,
        notification_templates,
        ai_prompts,
        checkin_lists,
        ticket_types,
        speakers,
        speaker_public_routes,
        sessions,
        template_html_documents,
        template_assets
      in share mode
    `);
    const databaseIdentityResult = await client.query<{
      systemIdentifier: string;
      databaseName: string;
      databaseOid: string;
      startedAt: string;
    }>(
      `select system_identifier::text as "systemIdentifier",
              current_database() as "databaseName",
              (select oid::text from pg_database where datname = current_database()) as "databaseOid",
              extract(epoch from pg_postmaster_start_time())::text as "startedAt"
       from pg_control_system()`,
    );
    const databaseIdentity = databaseIdentityResult.rows[0];
    if (!databaseIdentity) throw new Error('Could not identify the canonical database instance');
    const identityResult = await client.query<{
      organizationId: string;
      organizationSlug: string;
      organizationName: string;
      organizationSettings: JsonRecord;
      eventId: number;
      eventSlug: string;
      releaseId: string;
      releaseVersion: number;
      releaseTemplateKey: string;
      releaseTemplateVersionId: string | null;
      releaseSnapshot: JsonRecord;
      releaseChangeSummary: string;
      releaseChangeScope: string;
      releaseActivationKind: string;
    }>(
      `select
         o.id as "organizationId",
         o.slug as "organizationSlug",
         o.name as "organizationName",
         o.settings as "organizationSettings",
         e.id as "eventId",
         e.slug as "eventSlug",
         r.id as "releaseId",
         r.version as "releaseVersion",
         r.template_key as "releaseTemplateKey",
         r.template_version_id as "releaseTemplateVersionId",
         r.snapshot as "releaseSnapshot",
         r.change_summary as "releaseChangeSummary",
         r.change_scope as "releaseChangeScope",
         r.activation_kind as "releaseActivationKind"
       from organization_homepage_events h
       join organizations o on o.id = h.organization_id
       join events e on e.id = h.event_id and e.organization_id = o.id
       join event_releases r
         on r.id::text = e.settings->>'currentReleaseId' and r.event_id = e.id
       where o.slug = $1`,
      [canonicalOrganizationSlug],
    );
    const identity = identityResult.rows[0];
    if (!identity) throw new Error('Canonical homepage event or active release was not found');
    if (identity.eventSlug !== canonicalEventSlug) {
      throw new Error(`Canonical homepage must point to ${canonicalEventSlug}`);
    }

    const templateResult = await client.query<{
      templateId: string;
      templateCode: string;
      templateName: string;
      templateDescription: string;
      templateTags: string[];
      templateStatus: string;
      currentPublishedVersionId: string | null;
      versionId: string;
      version: number;
      rendererPackageId: string;
      schemaVersion: number;
      definition: JsonRecord;
      contentDigest: string;
      previewAssetKey: string | null;
      changeSummary: string;
      draftSchemaVersion: number;
      draftRendererPackageId: string;
      draftDefinition: JsonRecord;
      draftRevision: number;
      draftContentDigest: string;
      bindingUpdatePolicy: string;
      bindingRevision: number;
      rendererKey: string;
      rendererName: string;
      rendererVersion: number;
      rendererStatus: string;
      rendererDescription: string;
      rendererManifest: JsonRecord;
    }>(
      `select
         t.id as "templateId",
         t.code as "templateCode",
         t.name as "templateName",
         t.description as "templateDescription",
         t.tags as "templateTags",
         t.status as "templateStatus",
         t.current_published_version_id as "currentPublishedVersionId",
         v.id as "versionId",
         v.version as "version",
         v.renderer_package_id as "rendererPackageId",
         v.schema_version as "schemaVersion",
         v.definition as "definition",
         v.content_digest as "contentDigest",
         v.preview_asset_key as "previewAssetKey",
         v.change_summary as "changeSummary",
         d.schema_version as "draftSchemaVersion",
         d.renderer_package_id as "draftRendererPackageId",
         d.definition as "draftDefinition",
         d.revision as "draftRevision",
         d.content_digest as "draftContentDigest",
         b.update_policy as "bindingUpdatePolicy",
         b.revision as "bindingRevision",
         p.key as "rendererKey",
         p.name as "rendererName",
         p.version as "rendererVersion",
         p.status as "rendererStatus",
         p.description as "rendererDescription",
         p.manifest as "rendererManifest"
       from event_template_bindings b
       join conference_template_versions v on v.id = b.template_version_id
       join conference_templates t on t.id = v.template_id
       join conference_template_drafts d on d.template_id = t.id
       join template_packages p on p.id = v.renderer_package_id
       where b.event_id = $1`,
      [identity.eventId],
    );
    const template = templateResult.rows[0];
    if (!template) throw new Error('Canonical template binding was not found');

    const publishedVersions = [versionFromRow(template)];
    const rendererMap = new Map<string, CanonicalRenderer>([
      [template.rendererPackageId, rendererFromRow(template)],
    ]);
    const additionalPublishedVersionIds = new Set(
      [template.currentPublishedVersionId].filter((versionId): versionId is string =>
        Boolean(versionId && versionId !== template.versionId),
      ),
    );
    for (const publishedVersionId of additionalPublishedVersionIds) {
      const currentVersionResult = await client.query<{
        versionId: string;
        templateId: string;
        version: number;
        rendererPackageId: string;
        schemaVersion: number;
        definition: JsonRecord;
        contentDigest: string;
        previewAssetKey: string | null;
        changeSummary: string;
        rendererKey: string;
        rendererName: string;
        rendererVersion: number;
        rendererStatus: string;
        rendererDescription: string;
        rendererManifest: JsonRecord;
      }>(
        `select v.id as "versionId", v.template_id as "templateId", v.version,
                v.renderer_package_id as "rendererPackageId",
                v.schema_version as "schemaVersion", v.definition, v.content_digest as "contentDigest",
                v.preview_asset_key as "previewAssetKey", v.change_summary as "changeSummary",
                p.key as "rendererKey", p.name as "rendererName", p.version as "rendererVersion",
                p.status as "rendererStatus", p.description as "rendererDescription",
                p.manifest as "rendererManifest"
         from conference_template_versions v
         join template_packages p on p.id = v.renderer_package_id
         where v.id = $1 and v.template_id = $2`,
        [publishedVersionId, template.templateId],
      );
      const currentVersion = currentVersionResult.rows[0];
      if (!currentVersion)
        throw new Error(`Canonical published template version ${publishedVersionId} was not found`);
      publishedVersions.push(versionFromRow(currentVersion));
      rendererMap.set(currentVersion.rendererPackageId, rendererFromRow(currentVersion));
    }
    let releaseRoot: JsonRecord | null = null;
    if (
      identity.releaseTemplateVersionId &&
      !publishedVersions.some((version) => version.id === identity.releaseTemplateVersionId)
    ) {
      const releaseVersionResult = await client.query<{
        versionId: string;
        templateId: string;
        version: number;
        rendererPackageId: string;
        schemaVersion: number;
        definition: JsonRecord;
        contentDigest: string;
        previewAssetKey: string | null;
        changeSummary: string;
        rendererKey: string;
        rendererName: string;
        rendererVersion: number;
        rendererStatus: string;
        rendererDescription: string;
        rendererManifest: JsonRecord;
        templateCode: string;
        templateName: string;
        templateDescription: string;
        templateTags: string[];
        templateStatus: string;
      }>(
        `select v.id as "versionId", v.template_id as "templateId", v.version,
                v.renderer_package_id as "rendererPackageId",
                v.schema_version as "schemaVersion", v.definition,
                v.content_digest as "contentDigest", v.preview_asset_key as "previewAssetKey",
                v.change_summary as "changeSummary", p.key as "rendererKey",
                p.name as "rendererName", p.version as "rendererVersion",
                p.status as "rendererStatus", p.description as "rendererDescription",
                p.manifest as "rendererManifest", t.code as "templateCode",
                t.name as "templateName", t.description as "templateDescription",
                t.tags as "templateTags", t.status as "templateStatus"
         from conference_template_versions v
         join conference_templates t on t.id = v.template_id
         join template_packages p on p.id = v.renderer_package_id
         where v.id = $1 and t.organization_id = $2`,
        [identity.releaseTemplateVersionId, identity.organizationId],
      );
      const releaseVersion = releaseVersionResult.rows[0];
      if (!releaseVersion) {
        throw new Error(
          `Canonical release template version ${identity.releaseTemplateVersionId} was not found`,
        );
      }
      publishedVersions.push(versionFromRow(releaseVersion));
      rendererMap.set(releaseVersion.rendererPackageId, rendererFromRow(releaseVersion));
      releaseRoot = {
        id: releaseVersion.templateId,
        code: releaseVersion.templateCode,
        name: releaseVersion.templateName,
        description: releaseVersion.templateDescription,
        tags: releaseVersion.templateTags,
        status: releaseVersion.templateStatus,
      };
    }
    if (!rendererMap.has(template.draftRendererPackageId)) {
      const draftRendererResult = await client.query<CanonicalRenderer>(
        `select id, key, name, version, status, description, manifest
         from template_packages where id = $1`,
        [template.draftRendererPackageId],
      );
      const draftRenderer = draftRendererResult.rows[0];
      if (!draftRenderer) throw new Error('Canonical draft renderer package was not found');
      rendererMap.set(draftRenderer.id, draftRenderer);
    }

    const releaseSnapshot = { ...identity.releaseSnapshot };
    releaseSnapshot.event = sanitizeEvent(releaseSnapshot.event);
    releaseSnapshot.tickets = array(releaseSnapshot.tickets, 'release tickets').map(sanitizeTicket);
    releaseSnapshot.speakers = array(releaseSnapshot.speakers, 'release speakers').map(
      sanitizeSpeaker,
    );
    releaseSnapshot.sessions = array(releaseSnapshot.sessions, 'release sessions').map(
      sanitizeSession,
    );
    releaseSnapshot.experience = sanitizeExperience(releaseSnapshot.experience);

    const releasedFormVersion = number(
      record(releaseSnapshot.registrationForm, 'release registration form').version,
      'release registration form version',
    );
    const formResult = await client.query<{
      id: string;
      name: string;
      version: number;
      status: string;
      fields: unknown[];
      termsVersion: string;
      termsContent: string;
    }>(
      `select id, name, version, status, fields,
              terms_version as "termsVersion", terms_content as "termsContent"
       from registration_forms
       where event_id = $1 and version = $2`,
      [identity.eventId, releasedFormVersion],
    );
    const form = formResult.rows[0];
    if (!form) throw new Error(`Registration form V${releasedFormVersion} was not found`);
    releaseSnapshot.registrationForm = { ...form, status: 'published' };

    const defaultBlueprintId =
      typeof identity.organizationSettings.defaultBlueprintId === 'string'
        ? identity.organizationSettings.defaultBlueprintId
        : null;
    const blueprintIds = [...new Set([canonicalBlueprintId, defaultBlueprintId].filter(Boolean))];
    const blueprintResult = await client.query<{
      id: string;
      name: string;
      version: number;
      status: string;
      snapshot: JsonRecord;
      clonePolicy: JsonRecord;
    }>(
      `select id, name, version, status, snapshot, clone_policy as "clonePolicy"
           from event_blueprints
           where organization_id = $1 and id = any($2::uuid[])
           order by id`,
      [identity.organizationId, blueprintIds],
    );
    const quotaResult = await client.query<{
      id: string;
      name: string;
      capacity: number;
      ticketTypeIds: string[];
    }>(
      `select id, name, capacity, ticket_type_ids as "ticketTypeIds"
           from ticket_quotas where event_id = $1 order by id`,
      [identity.eventId],
    );
    const notificationResult = await client.query<{
      id: string;
      code: string;
      name: string;
      channel: string;
      subject: string;
      body: string;
      status: string;
      version: number;
    }>(
      `select distinct on (code) id, code, name, channel, subject, body, status, version
           from notification_templates
           where organization_id = $1 and status = 'active'
           order by code, version desc, id`,
      [identity.organizationId],
    );
    const promptResult = await client.query<{
      id: string;
      code: string;
      name: string;
      version: number;
      status: string;
      systemPrompt: string;
    }>(
      `select distinct on (code) id, code, name, version, status,
              system_prompt as "systemPrompt"
           from ai_prompts
           where organization_id = $1 and status = 'active'
           order by code, version desc, id`,
      [identity.organizationId],
    );
    const checkinResult = await client.query<{
      id: string;
      code: string;
      name: string;
      rules: JsonRecord;
    }>(
      `select id, code, name, rules
           from checkin_lists where event_id = $1 order by code, id`,
      [identity.eventId],
    );
    const liveEventResult = await client.query<JsonRecord>(
      `select id, organization_id as "organizationId", slug, name,
              short_name as "shortName", tagline, description, status,
              starts_at as "startsAt", ends_at as "endsAt", timezone,
              venue, city, address, settings
       from events where id = $1 and organization_id = $2`,
      [identity.eventId, identity.organizationId],
    );
    const liveTicketResult = await client.query<JsonRecord>(
      `select id, code, name, description, price, currency, capacity,
              active, recommended, benefits
       from ticket_types
       where event_id = $1
       order by active desc, price, id`,
      [identity.eventId],
    );
    const liveFormResult = await client.query<JsonRecord>(
      `select id, name, version, status, fields,
              terms_version as "termsVersion", terms_content as "termsContent"
       from registration_forms
       where event_id = $1 and status = 'published'
       order by version desc limit 1`,
      [identity.eventId],
    );
    const liveSpeakerResult = await client.query<JsonRecord>(
      `select id, name, role, topic, initials,
              accent_from as "accentFrom", accent_to as "accentTo", tags,
              avatar_asset_id as "avatarAssetId", bio,
              topic_abstract as "topicAbstract", website_url as "websiteUrl",
              social_links as "socialLinks", sort_order as "sortOrder"
       from speakers where event_id = $1 order by sort_order, id`,
      [identity.eventId],
    );
    const speakerRouteResult = await client.query<JsonRecord>(
      `select speaker_id as "speakerId", public_code as "publicCode"
       from speaker_public_routes
       where organization_id = $1 and event_id = $2
       order by public_code, speaker_id`,
      [identity.organizationId, identity.eventId],
    );
    const liveSessionResult = await client.query<JsonRecord>(
      `select id, day, starts_at as "startsAt", ends_at as "endsAt",
              title, summary, speaker, kind, sort_order as "sortOrder"
       from sessions where event_id = $1 order by day, sort_order, id`,
      [identity.eventId],
    );
    const liveEvent = liveEventResult.rows[0];
    const liveForm = liveFormResult.rows[0];
    if (!liveEvent || !liveForm) {
      throw new Error('Canonical live event or published registration form was not found');
    }
    const backend = {
      event: sanitizeEvent(liveEvent),
      ticketTypes: liveTicketResult.rows.map(sanitizeTicket),
      registrationForm: pick(liveForm, [
        'id',
        'name',
        'version',
        'status',
        'fields',
        'termsVersion',
        'termsContent',
      ]),
      speakers: liveSpeakerResult.rows.map(sanitizeSpeaker),
      speakerRoutes: speakerRouteResult.rows,
      sessions: liveSessionResult.rows.map(sanitizeSession),
    };

    const ticketIds = new Set(
      backend.ticketTypes.map((ticket) =>
        string(record(ticket, 'backend ticket').id, 'backend ticket id'),
      ),
    );
    const quotas = quotaResult.rows.filter((quota) =>
      quota.ticketTypeIds.some((ticketId) => ticketIds.has(ticketId)),
    );

    const htmlDocumentReferences = new Map<string, string>();
    for (const version of publishedVersions) {
      referencedHtmlDocumentIds(version.definition, version.templateId, htmlDocumentReferences);
    }
    referencedHtmlDocumentIds(
      template.draftDefinition,
      template.templateId,
      htmlDocumentReferences,
    );
    if (identity.releaseTemplateVersionId) {
      const releaseVersion = publishedVersions.find(
        (version) => version.id === identity.releaseTemplateVersionId,
      );
      if (!releaseVersion) throw new Error('Canonical release template version was not captured');
      referencedHtmlDocumentIds(releaseSnapshot, releaseVersion.templateId, htmlDocumentReferences);
    }
    let htmlDocuments: JsonRecord[] = [];
    if (htmlDocumentReferences.size) {
      const htmlResult = await client.query<{
        id: string;
        templateId: string;
        originalFilename: string;
        sourceStorageKey: string;
        sourceDigest: string;
        sourceSize: number;
        sanitizedHtml: string;
        sanitizedDigest: string;
        nodeManifest: unknown[];
        assetManifest: unknown[];
        securityReport: JsonRecord;
        metadata: JsonRecord;
        compilerVersion: number;
      }>(
        `select id, template_id as "templateId", original_filename as "originalFilename",
                source_storage_key as "sourceStorageKey", source_digest as "sourceDigest",
                source_size as "sourceSize", sanitized_html as "sanitizedHtml",
                sanitized_digest as "sanitizedDigest", node_manifest as "nodeManifest",
                asset_manifest as "assetManifest", security_report as "securityReport",
                metadata, compiler_version as "compilerVersion"
         from template_html_documents
         where id = any($1::uuid[]) and organization_id = $2
         order by id`,
        [[...htmlDocumentReferences.keys()], identity.organizationId],
      );
      if (htmlResult.rows.length !== htmlDocumentReferences.size) {
        throw new Error('One or more canonical HTML template documents were not found');
      }
      for (const document of htmlResult.rows) {
        if (htmlDocumentReferences.get(document.id) !== document.templateId) {
          throw new Error(`HTML document ${document.id} does not match its template root`);
        }
      }
      htmlDocuments = htmlResult.rows;
    }

    const assetIds = referencedAssetIds({
      releaseSnapshot,
      backend,
      templateDefinitions: publishedVersions.map((version) => version.definition),
      draftDefinition: template.draftDefinition,
      htmlDocuments,
    });
    if (assetIds.size > maxCanonicalAssetCount) {
      throw new Error(`Canonical template references more than ${maxCanonicalAssetCount} assets`);
    }
    const assets: JsonRecord[] = [];
    let totalAssetBytes = 0;
    for (const assetId of [...assetIds].sort()) {
      const assetResult = await client.query<{
        id: string;
        storageKey: string;
        mediaType: string;
        size: number;
        width: number | null;
        height: number | null;
        contentDigest: string;
        altText: string;
      }>(
        `select id, storage_key as "storageKey", media_type as "mediaType", size,
                width, height, content_digest as "contentDigest", alt_text as "altText"
         from template_assets
         where id = $1 and organization_id = $2 and purpose = 'template'`,
        [assetId, identity.organizationId],
      );
      const asset = assetResult.rows[0];
      if (!asset) throw new Error(`Referenced template asset ${assetId} was not found`);
      totalAssetBytes += asset.size;
      if (totalAssetBytes > maxCanonicalAssetTotalBytes) {
        throw new Error('Canonical template assets exceed the repository size limit');
      }
      assets.push({
        ...asset,
        contentBase64: await downloadAsset(asset.id, asset.contentDigest, asset.size),
      });
    }

    const databaseChallenge = randomBytes(32).toString('hex');
    const publicResponse = await fetch(localHomepageUrl, {
      headers: {
        'X-Organization-Slug': canonicalOrganizationSlug,
        'X-Canonical-Database-Challenge': databaseChallenge,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!publicResponse.ok) {
      throw new Error(`Local homepage API returned HTTP ${publicResponse.status}`);
    }
    if (
      publicResponse.headers.get('x-canonical-database-proof') !==
      canonicalDatabaseProof(databaseChallenge, databaseIdentity)
    ) {
      throw new Error('Local homepage API and DATABASE_URL do not use the same database instance');
    }
    const publicEvent = record(await publicResponse.json(), 'local homepage response');
    if (publicEvent.id !== identity.eventId || publicEvent.slug !== identity.eventSlug) {
      throw new Error('Local homepage API does not match the configured homepage event');
    }
    publicEvent.publicMetrics = {
      pageViews: 0,
      trackingStartedAt: null,
      confirmedAttendees: 0,
      organizationCount: 0,
      cityCount: 0,
    };
    publicEvent.tickets = array(publicEvent.tickets, 'public tickets').map((ticket) => {
      const row = record(ticket, 'public ticket');
      const released = array(releaseSnapshot.tickets, 'release tickets')
        .map((item) => record(item, 'release ticket'))
        .find((item) => item.id === row.id);
      const live = backend.ticketTypes
        .map((item) => record(item, 'backend ticket'))
        .find((item) => item.id === row.id);
      return { ...row, remaining: released?.capacity ?? live?.capacity ?? 0 };
    });
    if (publicEvent.experience) {
      publicEvent.experience = sanitizeExperience(publicEvent.experience);
    }

    const canonicalSnapshot = {
      schemaVersion: 1,
      source: {
        organizationId: identity.organizationId,
        organizationSlug: identity.organizationSlug,
        eventId: identity.eventId,
        eventSlug: identity.eventSlug,
      },
      organization: {
        id: identity.organizationId,
        slug: identity.organizationSlug,
        name: identity.organizationName,
        settings: sanitizeOrganizationSettings(identity.organizationSettings),
      },
      publicEvent,
      template: {
        root: {
          id: template.templateId,
          code: template.templateCode,
          name: template.templateName,
          description: template.templateDescription,
          tags: template.templateTags,
          status: template.templateStatus,
          currentPublishedVersionId: template.currentPublishedVersionId,
        },
        version: {
          id: template.versionId,
          version: template.version,
          rendererPackageId: template.rendererPackageId,
          schemaVersion: template.schemaVersion,
          definition: template.definition,
          contentDigest: template.contentDigest,
          previewAssetKey: template.previewAssetKey,
          changeSummary: template.changeSummary,
        },
        publishedVersions,
        releaseRoot,
        draft: {
          rendererPackageId: template.draftRendererPackageId,
          schemaVersion: template.draftSchemaVersion,
          definition: template.draftDefinition,
          revision: template.draftRevision,
          contentDigest: template.draftContentDigest,
        },
        binding: {
          updatePolicy: template.bindingUpdatePolicy,
          revision: template.bindingRevision,
        },
        renderer: {
          id: template.rendererPackageId,
          key: template.rendererKey,
          name: template.rendererName,
          version: template.rendererVersion,
          status: template.rendererStatus,
          description: template.rendererDescription,
          manifest: template.rendererManifest,
        },
        renderers: [...rendererMap.values()],
        htmlDocuments,
      },
      release: {
        id: identity.releaseId,
        version: identity.releaseVersion,
        templateKey: identity.releaseTemplateKey,
        templateVersionId: identity.releaseTemplateVersionId,
        snapshot: releaseSnapshot,
        changeSummary: identity.releaseChangeSummary,
        changeScope: identity.releaseChangeScope,
        activationKind: identity.releaseActivationKind,
      },
      backend,
      blueprint:
        blueprintResult.rows.find((blueprint) => blueprint.id === canonicalBlueprintId) ?? null,
      blueprints: blueprintResult.rows,
      ticketQuotas: quotas,
      checkinLists: checkinResult.rows,
      notificationTemplates: notificationResult.rows,
      aiPrompts: promptResult.rows,
      assets,
    };
    // Read-only production observations must describe drift so deployment can repair it.
    validateCanonicalHomepageSnapshot(canonicalSnapshot, 'observation');
    await client.query('commit');
    transactionOpen = false;
    return canonicalSnapshot;
  } catch (error) {
    if (transactionOpen) await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function buildStableSnapshot() {
  const first = await buildSnapshot();
  const second = await buildSnapshot();
  if (serializedSnapshot(first) !== serializedSnapshot(second)) {
    throw new Error('Canonical homepage changed during export; wait for edits to finish and retry');
  }
  return second;
}

async function verifyCommittedFile() {
  const committed = JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown;
  const fullSnapshot = validateCanonicalHomepageSnapshot(committed);
  const committedPublic = JSON.parse(await readFile(publicSnapshotPath, 'utf8')) as unknown;
  validateCanonicalPublicSnapshot(committedPublic, fullSnapshot);
  process.stdout.write(
    `Canonical homepage snapshots are valid: ${snapshotPath}, ${publicSnapshotPath}\n`,
  );
}

function normalizeSnapshotContent(content: string): string {
  try {
    return serializedSnapshot(JSON.parse(content) as unknown);
  } catch {
    return '';
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--verify-file') {
    await verifyCommittedFile();
    return;
  }
  if (mode !== '--write' && mode !== '--check' && mode !== '--stdout') {
    throw new Error(
      'Usage: export-canonical-homepage.ts --write | --check | --stdout | --verify-file',
    );
  }
  const snapshot = await buildStableSnapshot();
  const generated = serializedSnapshot(snapshot);
  const generatedPublic = serializedSnapshot(canonicalPublicSnapshot(snapshot));
  if (mode === '--stdout') {
    process.stdout.write(generated);
    return;
  }
  validateCanonicalHomepageSnapshot(snapshot);
  if (mode === '--write') {
    await writeAtomically(snapshotPath, generated);
    await writeAtomically(publicSnapshotPath, generatedPublic);
    process.stdout.write(
      `Canonical homepage snapshots updated: ${snapshotPath}, ${publicSnapshotPath}\n`,
    );
    return;
  }
  const committed = await readFile(snapshotPath, 'utf8').catch(() => '');
  const normalizedCommitted = normalizeSnapshotContent(committed);
  if (normalizedCommitted !== generated) {
    throw new Error('Canonical homepage snapshot is stale; run pnpm canonical:export');
  }
  const committedPublic = await readFile(publicSnapshotPath, 'utf8').catch(() => '');
  const normalizedCommittedPublic = normalizeSnapshotContent(committedPublic);
  if (normalizedCommittedPublic !== generatedPublic) {
    throw new Error('Canonical public homepage snapshot is stale; run pnpm canonical:export');
  }
  process.stdout.write('Canonical homepage snapshot matches the local homepage and admin state\n');
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
