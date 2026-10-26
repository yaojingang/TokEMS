import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createDatabase,
  customerMediaAssets,
  customerUsers,
  organizations,
  type ConferenceDatabase,
} from '@conference/database';
import { eq } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupExpiredCustomerAvatarSources } from './customer-avatar-cleanup.worker.js';

type MediaAsset = typeof customerMediaAssets.$inferSelect;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: randomUUID(),
    organizationId: randomUUID(),
    customerUserId: randomUUID(),
    kind: 'partner_avatar',
    status: 'ready',
    sourceStorageKey: 'customers/org/customer/partner-avatars/asset/avatar.webp',
    outputStorageKey: 'customers/org/customer/partner-avatars/asset/avatar.webp',
    mediaType: 'image/webp',
    size: 100,
    width: 512,
    height: 512,
    contentDigest: '0'.repeat(64),
    confirmedAt: new Date(),
    sourceDeletedAt: null,
    failureReason: null,
    createdAt: new Date(Date.now() - 48 * 60 * 60_000),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fixture(row: MediaAsset, claimed = true) {
  const select = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([row]),
  };
  const set = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(claimed ? [{ id: row.id }] : []),
    }),
  });
  const db = {
    select: () => select,
    update: vi.fn().mockReturnValue({ set }),
  };
  const storageUrl = vi.fn((key: string) => `https://storage.example.test/${key}`);
  return { db: db as unknown as ConferenceDatabase, set, storageUrl };
}

describe('customer avatar source cleanup', () => {
  it.each(['avatar', 'partner_avatar', 'partner_gallery'])(
    'preserves a %s whose source is also its display image',
    async (kind) => {
      const deps = fixture(asset({ kind }));

      await cleanupExpiredCustomerAvatarSources(deps.db, deps.storageUrl);

      expect(deps.storageUrl).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(deps.set).not.toHaveBeenCalled();
    },
  );

  it.each(['processing', 'failed'])(
    'preserves a shared display image in an expired %s record',
    async (status) => {
      const deps = fixture(asset({ status, confirmedAt: null }));

      await cleanupExpiredCustomerAvatarSources(deps.db, deps.storageUrl);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(deps.set).not.toHaveBeenCalled();
    },
  );

  it.each([null, ''])(
    'keeps a ready source when its display key is %j',
    async (outputStorageKey) => {
      const deps = fixture(asset({ outputStorageKey }));

      await cleanupExpiredCustomerAvatarSources(deps.db, deps.storageUrl);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(deps.set).not.toHaveBeenCalled();
    },
  );

  it('deletes a separate processed original and records successful cleanup', async () => {
    const row = asset({ sourceStorageKey: 'customers/org/customer/avatars/asset/original' });
    const deps = fixture(row);

    await cleanupExpiredCustomerAvatarSources(deps.db, deps.storageUrl);

    expect(deps.storageUrl).toHaveBeenCalledExactlyOnceWith(row.sourceStorageKey, 'DELETE');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `https://storage.example.test/${row.sourceStorageKey}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(deps.set).toHaveBeenCalledExactlyOnceWith({
      sourceDeletedAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
  });

  it('still claims and cleans expired unconfirmed uploads without a display image', async () => {
    const deps = fixture(
      asset({ status: 'processing', confirmedAt: null, outputStorageKey: null }),
    );

    await cleanupExpiredCustomerAvatarSources(deps.db, deps.storageUrl);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(deps.set.mock.calls.map(([patch]) => patch)).toEqual([
      expect.objectContaining({
        status: 'failed',
        failureReason: expect.stringContaining('[cleanup-claimed]'),
      }),
      expect.objectContaining({
        sourceDeletedAt: expect.any(Date),
        failureReason: expect.stringContaining('[source-cleaned]'),
      }),
    ]);
  });

  it('keeps an expired upload when another process already claimed it', async () => {
    const deps = fixture(
      asset({ status: 'processing', confirmedAt: null, outputStorageKey: null }),
      false,
    );

    await cleanupExpiredCustomerAvatarSources(deps.db, deps.storageUrl);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.set).toHaveBeenCalledOnce();
  });

  it.each([204, 404, 503])(
    'records cleanup only when storage returns success or absence (%i)',
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status }));
      const deps = fixture(
        asset({ sourceStorageKey: 'customers/org/customer/avatars/asset/original' }),
      );

      await cleanupExpiredCustomerAvatarSources(deps.db, deps.storageUrl);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(deps.set).toHaveBeenCalledTimes(status === 503 ? 0 : 1);
    },
  );
});

const testDatabaseUrl =
  process.env.CUSTOMER_AVATAR_TEST_DATABASE_URL ?? process.env.PARTNER_TEST_DATABASE_URL;
const persistent = testDatabaseUrl ? describe : describe.skip;
persistent('customer avatar cleanup PostgreSQL batch selection', () => {
  let admin: ReturnType<typeof createDatabase>;
  let connection: ReturnType<typeof createDatabase>;
  const databaseName = `avatar_cleanup_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  const organizationId = randomUUID();
  const customerUserId = randomUUID();

  beforeAll(async () => {
    admin = createDatabase(testDatabaseUrl);
    await admin.pool.query(`create database "${databaseName}"`);
    created = true;
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    connection = createDatabase(url.toString());
    for (const migration of readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL('../../../packages/database/drizzle', import.meta.url),
      ),
    })) {
      const client = await connection.pool.connect();
      await client.query('BEGIN');
      try {
        for (const statement of migration.sql) if (statement.trim()) await client.query(statement);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    await connection.db.insert(organizations).values({
      id: organizationId,
      slug: `avatar-cleanup-${organizationId}`,
      name: '头像清理测试',
    });
    await connection.db
      .insert(customerUsers)
      .values({ id: customerUserId, organizationId, mobileE164: '+8613900000011' });
  }, 90_000);
  afterAll(async () => {
    await connection?.pool.end();
    if (created) await admin.pool.query(`drop database "${databaseName}"`);
    await admin?.pool.end();
  });

  it('excludes protected images before the batch limit so temporary originals still get cleaned', async () => {
    const protectedImages = Array.from({ length: 100 }, (_, index) => ({
      ...asset({
        kind: ['avatar', 'partner_avatar', 'partner_gallery'][index % 3]!,
        status: ['ready', 'processing', 'failed'][index % 3]!,
        confirmedAt: null,
      }),
      organizationId,
      customerUserId,
    }));
    const original = {
      ...asset({
        sourceStorageKey: 'customers/org/customer/avatars/later/original',
        outputStorageKey: 'customers/org/customer/avatars/later/avatar.webp',
        createdAt: new Date(),
      }),
      organizationId,
      customerUserId,
    };
    const expired = {
      ...asset({
        status: 'processing',
        confirmedAt: null,
        sourceStorageKey: 'customers/org/customer/avatars/expired/original',
        outputStorageKey: null,
      }),
      organizationId,
      customerUserId,
    };
    const recent = {
      ...asset({
        status: 'processing',
        confirmedAt: null,
        outputStorageKey: null,
        createdAt: new Date(),
      }),
      organizationId,
      customerUserId,
    };
    const confirmed = {
      ...asset({ status: 'processing', outputStorageKey: null }),
      organizationId,
      customerUserId,
    };
    await connection.db
      .insert(customerMediaAssets)
      .values([...protectedImages, original, expired, recent, confirmed]);
    const storageUrl = vi.fn((key: string) => `https://storage.example.test/${key}`);

    await cleanupExpiredCustomerAvatarSources(connection.db, storageUrl);

    expect(storageUrl.mock.calls).toEqual([
      [expired.sourceStorageKey, 'DELETE'],
      [original.sourceStorageKey, 'DELETE'],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const rows = await connection.db
      .select()
      .from(customerMediaAssets)
      .where(eq(customerMediaAssets.organizationId, organizationId));
    expect(
      rows
        .filter((row) => row.sourceDeletedAt)
        .map((row) => row.id)
        .sort(),
    ).toEqual([original.id, expired.id].sort());
    expect(rows.filter((row) => !row.sourceDeletedAt)).toHaveLength(102);
  });

  it('excludes empty display keys before the batch limit across repeated runs', async () => {
    const missingDisplayImages = Array.from({ length: 100 }, (_, index) => ({
      ...asset({
        sourceStorageKey: `customers/org/customer/avatars/missing-${index}/original`,
        outputStorageKey: '',
      }),
      organizationId,
      customerUserId,
    }));
    const original = {
      ...asset({
        sourceStorageKey: 'customers/org/customer/avatars/valid/original',
        outputStorageKey: 'customers/org/customer/avatars/valid/avatar.webp',
        createdAt: new Date(),
      }),
      organizationId,
      customerUserId,
    };
    await connection.db.insert(customerMediaAssets).values([...missingDisplayImages, original]);
    const storageUrl = vi.fn((key: string) => `https://storage.example.test/${key}`);

    await cleanupExpiredCustomerAvatarSources(connection.db, storageUrl);
    await cleanupExpiredCustomerAvatarSources(connection.db, storageUrl);

    expect(storageUrl).toHaveBeenCalledExactlyOnceWith(original.sourceStorageKey, 'DELETE');
    expect(fetchMock).toHaveBeenCalledOnce();
    const rows = await connection.db
      .select()
      .from(customerMediaAssets)
      .where(eq(customerMediaAssets.organizationId, organizationId));
    expect(rows.filter((row) => row.outputStorageKey === '')).toHaveLength(100);
    expect(
      rows
        .filter((row) => row.outputStorageKey === '')
        .every((row) => row.sourceDeletedAt === null),
    ).toBe(true);
    expect(rows.find((row) => row.id === original.id)?.sourceDeletedAt).toEqual(expect.any(Date));
  });
});
