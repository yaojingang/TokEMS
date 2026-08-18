import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../drizzle/0053_mute_vulcan.sql', import.meta.url);

describe('speaker public route migration', () => {
  it('keeps a durable mapping and backfills live and released speakers', async () => {
    const migration = await readFile(fileURLToPath(migrationUrl), 'utf8');

    expect(migration).toContain('CREATE TABLE "speaker_public_routes"');
    expect(migration).toContain('GENERATED ALWAYS AS IDENTITY');
    expect(migration).toContain('"public_code" varchar(4) NOT NULL');
    expect(migration).toContain('speaker_public_routes_code_unique');
    expect(migration).toContain("'^[a-z]{4}$'");
    expect(migration).toContain('FROM "speakers"');
    expect(migration).toContain('FROM "event_releases"');
    expect(migration).toContain("'speakers'");
    expect(migration).not.toMatch(/\bdrop\s+(?:table|column)\b/iu);
  });
});
