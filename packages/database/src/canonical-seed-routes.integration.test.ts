import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { DEMO_IDS } from '@conference/contracts';
import { CANONICAL_HOMEPAGE_SNAPSHOT } from '@conference/contracts/canonical-homepage';
import { isLoopbackHostname } from '@conference/security';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('canonical seed speaker route retention', () => {
  const databaseName = `canonical_routes_${randomUUID().replaceAll('-', '')}`;
  const historicalSpeakerId = randomUUID();
  const currentRoute = CANONICAL_HOMEPAGE_SNAPSHOT.backend.speakerRoutes[0]!;
  const codes = new Set(
    CANONICAL_HOMEPAGE_SNAPSHOT.backend.speakerRoutes.map((route) => route.publicCode),
  );
  const historicalCode = ['zzzz', 'zzzy', 'zzzx'].find((code) => !codes.has(code))!;
  const replacementCode = ['zzzw', 'zzzv', 'zzzu'].find((code) => !codes.has(code))!;
  let admin: pg.Pool | undefined;
  let database: pg.Pool | undefined;
  let created = false;
  let childEnvironment: NodeJS.ProcessEnv;
  // The route test accepts asset uploads through an isolated local storage stub.
  const storage = createServer((request, response) => {
    request.resume();
    request.on('end', () => response.writeHead(200).end());
  });

  async function seed() {
    return execute(process.execPath, ['--import', 'tsx', 'src/seed.ts'], {
      env: childEnvironment,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  }

  beforeAll(async () => {
    const baseUrl = new URL(process.env.DATABASE_URL!);
    if (!isLoopbackHostname(baseUrl.hostname)) {
      throw new Error('Canonical seed integration tests require a loopback database');
    }
    admin = new pg.Pool({ connectionString: baseUrl.toString() });
    await admin.query(`create database "${databaseName}"`);
    created = true;
    baseUrl.pathname = `/${databaseName}`;
    database = new pg.Pool({ connectionString: baseUrl.toString() });
    await new Promise<void>((resolve) => storage.listen(0, '127.0.0.1', resolve));
    const address = storage.address();
    if (!address || typeof address === 'string') throw new Error('Storage stub did not start');
    childEnvironment = {
      ...process.env,
      DATABASE_URL: baseUrl.toString(),
      NODE_ENV: 'test',
      DEPLOYMENT_MODE: 'local',
      S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
      S3_ACCESS_KEY: 'route-test',
      S3_SECRET_KEY: 'route-test',
      S3_BUCKET: 'route-test',
    };
    await execute(process.execPath, ['--import', 'tsx', 'src/migrate.ts'], {
      env: childEnvironment,
      timeout: 60_000,
    });
    await seed();
  }, 120_000);

  afterAll(async () => {
    await database?.end();
    if (created) await admin!.query(`drop database "${databaseName}"`);
    await admin?.end();
    await new Promise<void>((resolve) => storage.close(() => resolve()));
  });

  it('preserves the independent production V153 when syncing a newer canonical release', async () => {
    // Production activated refund settings as V153 before the local logo update used V153.
    await database!.query(
      `insert into event_releases
        (event_id, version, template_key, template_version_id, status, snapshot,
         artifact_key, change_summary, change_scope, activation_kind)
       select event_id, 153, template_key, template_version_id, status,
         jsonb_set(snapshot, '{event,settings,refunds}',
           '{"enabled":true,"version":"seven-day-v1","windowDays":7}'::jsonb),
         artifact_key, 'Production V153: independent refund settings', 'event', 'save'
       from event_releases where event_id = $1 and version = $2
       on conflict (event_id, version) do update set
         snapshot = excluded.snapshot, change_summary = excluded.change_summary,
         change_scope = excluded.change_scope`,
      [DEMO_IDS.event, CANONICAL_HOMEPAGE_SNAPSHOT.release.version],
    );
    const historical = await database!.query(
      'select * from event_releases where event_id = $1 and version = 153',
      [DEMO_IDS.event],
    );
    expect(historical.rows).toHaveLength(1);
    await seed();
    const preserved = await database!.query(
      'select * from event_releases where event_id = $1 and version = 153',
      [DEMO_IDS.event],
    );
    expect(preserved.rows).toEqual(historical.rows);
    const active = await database!.query(
      `select r.version from events e join event_releases r
       on r.id::text = e.settings->>'currentReleaseId' where e.id = $1`,
      [DEMO_IDS.event],
    );
    expect(active.rows[0]?.version).toBe(CANONICAL_HOMEPAGE_SNAPSHOT.release.version);
    expect(active.rows[0]?.version).toBeGreaterThan(153);
  }, 60_000);

  it('keeps deleted speakers reserved when applying a snapshot of current speakers', async () => {
    await database!.query(
      'insert into speaker_public_routes (organization_id, event_id, speaker_id, public_code) values ($1, $2, $3, $4)',
      [DEMO_IDS.organization, DEMO_IDS.event, historicalSpeakerId, historicalCode],
    );
    await seed();
    const result = await database!.query(
      'select speaker_id, public_code from speaker_public_routes where event_id = $1',
      [DEMO_IDS.event],
    );
    expect(result.rows).toHaveLength(codes.size + 1);
    expect(result.rows).toContainEqual({
      speaker_id: historicalSpeakerId,
      public_code: historicalCode,
    });
    expect(result.rows).toContainEqual({
      speaker_id: currentRoute.speakerId,
      public_code: currentRoute.publicCode,
    });
  }, 60_000);

  it('rejects a historical short-code collision without replacing the existing mappings', async () => {
    await database!.query(
      'update speaker_public_routes set public_code = $1 where speaker_id = $2',
      [replacementCode, currentRoute.speakerId],
    );
    await database!.query(
      'insert into speaker_public_routes (organization_id, event_id, speaker_id, public_code) values ($1, $2, $3, $4) on conflict (organization_id, event_id, speaker_id) do update set public_code = excluded.public_code',
      [DEMO_IDS.organization, DEMO_IDS.event, historicalSpeakerId, currentRoute.publicCode],
    );
    await expect(seed()).rejects.toMatchObject({
      stderr: expect.stringContaining('speaker_public_routes_code_unique'),
    });
    const result = await database!.query(
      'select speaker_id, public_code from speaker_public_routes where event_id = $1',
      [DEMO_IDS.event],
    );
    expect(result.rows).toHaveLength(codes.size + 1);
    expect(result.rows).toContainEqual({
      speaker_id: historicalSpeakerId,
      public_code: currentRoute.publicCode,
    });
    expect(result.rows).toContainEqual({
      speaker_id: currentRoute.speakerId,
      public_code: replacementCode,
    });
  }, 60_000);
});
