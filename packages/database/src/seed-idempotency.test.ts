import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('canonical seed release identity', () => {
  it('reuses the event/version release and stores its actual id on the event', async () => {
    const seedSource = await readFile(resolve(process.cwd(), 'src/seed.ts'), 'utf8');

    expect(seedSource).toContain('target: [eventReleases.eventId, eventReleases.version]');
    expect(seedSource).toContain('.onConflictDoNothing({');
    expect(seedSource).toContain("'currentReleaseId', ${resolvedRelease.id}::text");
    expect(seedSource).not.toContain('currentReleaseId: RELEASE_ID');
    expect(seedSource).not.toContain('target: eventReleases.id');
    expect(seedSource).toContain('snapshot: releaseSnapshot');
    expect(seedSource).toContain('already exists with different immutable content');
    expect(seedSource).toContain('seededReleaseTemplateVersionId');
    expect(seedSource).toContain('...templateVersionIdMap');
    expect(seedSource).toContain('...formIdMap');
  });

  it('seeds the homepage binding and an optional rollback template root', async () => {
    const seedSource = await readFile(resolve(process.cwd(), 'src/seed.ts'), 'utf8');

    expect(seedSource).toContain(
      "const publicOrganizationSlug = process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference'",
    );
    expect(seedSource).toContain('CANONICAL_HOMEPAGE_SNAPSHOT.organization.name');
    expect(seedSource).toContain('canonicalTemplate.root.code');
    expect(seedSource).toContain('canonicalTemplate.root.name');
    expect(seedSource).toContain('canonicalBackend.ticketTypes.map');
    expect(seedSource).toContain('canonicalRelease.snapshot');
    expect(seedSource.match(/\.insert\(conferenceTemplates\)/gu)).toHaveLength(2);
  });

  it('preserves production inventory invariants during canonical reconciliation', async () => {
    const seedSource = await readFile(resolve(process.cwd(), 'src/seed.ts'), 'utf8');

    expect(seedSource).toContain('below production sold and held inventory');
    expect(seedSource).toContain('below production sold inventory');
    expect(seedSource).toContain('inventoryReservations');
    expect(seedSource).toContain('waitlistEntries');
    expect(seedSource).toContain('ticketIdMap.get(canonicalDemoTicket.id)');
    expect(seedSource).toContain('minimumCapacityByTicketId.get(ticketValue.id)');
    expect(seedSource).toContain('ticket.id === DEMO_IDS.tickets.earlyBird && ticket.active');
  });

  it('remaps deduplicated template assets in HTML and storage-key references', async () => {
    const seedSource = await readFile(resolve(process.cwd(), 'src/seed.ts'), 'utf8');

    expect(seedSource).toContain('const assetReferenceMap = new Map');
    expect(seedSource).toContain('...canonicalStorageKeyMap');
    expect(seedSource).toContain('remapCanonicalReferences(');
    expect(seedSource).toContain('remappedHtmlDocument.sanitizedDigest = sha256Digest');
    expect(seedSource).toContain(
      'for (const canonicalHtmlDocument of canonicalTemplate.htmlDocuments)',
    );
  });
});
