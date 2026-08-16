import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('canonical seed release identity', () => {
  it('reuses the event/version release and stores its actual id on the event', async () => {
    const seedSource = await readFile(resolve(process.cwd(), 'src/seed.ts'), 'utf8');

    expect(seedSource).toContain(
      'target: [eventReleases.eventId, eventReleases.version]',
    );
    expect(seedSource).toContain('.returning({ id: eventReleases.id })');
    expect(seedSource).toContain(
      "jsonb_build_object('currentReleaseId', ${seededRelease.id}::text)",
    );
    expect(seedSource).not.toContain('currentReleaseId: RELEASE_ID');
    expect(seedSource).not.toContain('target: eventReleases.id');
    expect(seedSource.match(/slug: DEMO_EVENT\.slug/gu)).toHaveLength(2);
  });

  it('keeps tokems26 as the only canonical seeded conference template', async () => {
    const seedSource = await readFile(resolve(process.cwd(), 'src/seed.ts'), 'utf8');

    expect(seedSource).toContain(
      "const publicOrganizationSlug = process.env.PUBLIC_ORGANIZATION_SLUG ?? 'geo-conference'",
    );
    expect(seedSource).toContain("name: '中国GEO大会组委会'");
    expect(seedSource).toContain("code: 'geo-editorial-standard'");
    expect(seedSource).toContain("name: '中国第二届 GEO & AI 营销大会'");
    expect(seedSource).toContain("entry: 'tokems26'");
    expect(seedSource.match(/\.insert\(conferenceTemplates\)/gu)).toHaveLength(1);
  });
});
