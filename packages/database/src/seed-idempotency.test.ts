import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('demo seed release identity', () => {
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
});
