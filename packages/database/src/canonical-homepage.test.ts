import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCanonicalHomepageSnapshot } from './export-canonical-homepage.js';

async function snapshot() {
  return JSON.parse(
    await readFile(
      resolve(process.cwd(), '../contracts/src/canonical-homepage.snapshot.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

describe('canonical homepage snapshot', () => {
  it('contains the current public release and sanitized backend defaults', async () => {
    const value = validateCanonicalHomepageSnapshot(await snapshot());
    const backend = value.backend as {
      registrationForm: { version: number };
      ticketTypes: Array<Record<string, unknown>>;
    };
    const release = value.release as {
      snapshot: { registrationForm: { version: number }; tickets: unknown[] };
    };

    expect((value.source as { eventSlug: string }).eventSlug).toBe('tokems26');
    expect(release.snapshot.tickets.length).toBeGreaterThan(0);
    expect(backend.ticketTypes.length).toBeGreaterThanOrEqual(release.snapshot.tickets.length);
    expect(backend.registrationForm.version).toBeGreaterThanOrEqual(
      release.snapshot.registrationForm.version,
    );
    expect(backend.ticketTypes.every((ticket) => !('sold' in ticket))).toBe(true);
    expect((value.publicEvent as { publicMetrics: Record<string, unknown> }).publicMetrics).toEqual(
      {
        pageViews: 0,
        trackingStartedAt: null,
        confirmedAttendees: 0,
        organizationCount: 0,
        cityCount: 0,
      },
    );
  });

  it('rejects credentials before they can be committed', async () => {
    const value = await snapshot();
    (value.organization as Record<string, unknown>).password = 'should-never-be-committed';

    expect(() => validateCanonicalHomepageSnapshot(value)).toThrow(/Sensitive key/u);
  });

  it('rejects provider credentials hidden in generic content', async () => {
    const value = await snapshot();
    value.notes = 'token=placeholder-credential-value';

    expect(() => validateCanonicalHomepageSnapshot(value)).toThrow(/Sensitive value/u);
  });

  it('rejects administrator identity fields', async () => {
    const value = await snapshot();
    value.metadata = { administratorUsername: 'should-never-be-committed' };

    expect(() => validateCanonicalHomepageSnapshot(value)).toThrow(/Sensitive key/u);
  });

  it('rejects tampered HTML even when its digest was recomputed', async () => {
    const value = await snapshot();
    const html =
      '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=/admin"></head><body><main>unsafe</main></body></html>';
    const template = value.template as Record<string, unknown>;
    template.htmlDocuments = [
      {
        id: randomUUID(),
        templateId: (template.root as { id: string }).id,
        sanitizedHtml: html,
        sanitizedDigest: `sha256:${createHash('sha256').update(html).digest('hex')}`,
      },
    ];

    expect(() => validateCanonicalHomepageSnapshot(value)).toThrow(/sanitizer round trip/u);
  });

  it('rejects a different homepage identity', async () => {
    const value = await snapshot();
    (value.source as Record<string, unknown>).eventSlug = 'another-event';

    expect(() => validateCanonicalHomepageSnapshot(value)).toThrow(/canonical event/u);
  });

  it('accepts a published homepage with no speakers', async () => {
    const value = await snapshot();
    (value.publicEvent as Record<string, unknown>).speakers = [];
    const backend = value.backend as Record<string, unknown>;
    backend.speakers = [];
    backend.speakerRoutes = [];
    const release = value.release as { snapshot: Record<string, unknown> };
    release.snapshot.speakers = [];

    expect(() => validateCanonicalHomepageSnapshot(value)).not.toThrow();
  });

  it('requires the active release template version to be reproducible', async () => {
    const value = await snapshot();
    (value.release as Record<string, unknown>).templateVersionId = randomUUID();

    expect(() => validateCanonicalHomepageSnapshot(value)).toThrow(
      /release template version is missing/u,
    );
  });

  it('requires every referenced HTML document to be captured', async () => {
    const value = await snapshot();
    const template = value.template as {
      publishedVersions: Array<{ definition: Record<string, unknown> }>;
    };
    template.publishedVersions[0]!.definition.presentation = {
      kind: 'html',
      documentId: randomUUID(),
    };

    expect(() => validateCanonicalHomepageSnapshot(value)).toThrow(/fully reproducible/u);
  });

  it('rejects a public projection from another local database', async () => {
    const value = await snapshot();
    const publicEvent = value.publicEvent as { experience: { home: { blocks: unknown[] } } };
    publicEvent.experience.home.blocks = [];

    expect(() => validateCanonicalHomepageSnapshot(value)).toThrow(/public experience/u);
  });

  it('rejects runtime inventory copied into the repository default', async () => {
    const value = await snapshot();
    const publicEvent = value.publicEvent as { tickets: Array<{ remaining: number }> };
    publicEvent.tickets[0]!.remaining -= 1;

    expect(() => validateCanonicalHomepageSnapshot(value)).toThrow(/inventory/u);
  });

  it('represents a release rolled back across template roots', async () => {
    const value = await snapshot();
    const rootId = randomUUID();
    const versionId = randomUUID();
    const template = value.template as {
      releaseRoot: Record<string, unknown> | null;
      publishedVersions: Array<Record<string, unknown>>;
    };
    template.releaseRoot = {
      id: rootId,
      code: 'previous-homepage-template',
      name: 'Previous homepage template',
      description: 'Rollback source',
      tags: [],
      status: 'active',
    };
    template.publishedVersions.push({
      ...template.publishedVersions[0],
      id: versionId,
      templateId: rootId,
    });
    const release = value.release as {
      templateVersionId: string;
      snapshot: { experience: { template: { id: string; versionId: string } } };
    };
    release.templateVersionId = versionId;
    release.snapshot.experience.template.id = rootId;
    release.snapshot.experience.template.versionId = versionId;
    const publicEvent = value.publicEvent as {
      experience: { template: { id: string; versionId: string } };
    };
    publicEvent.experience.template.id = rootId;
    publicEvent.experience.template.versionId = versionId;

    expect(() => validateCanonicalHomepageSnapshot(value)).not.toThrow();
  });
});
