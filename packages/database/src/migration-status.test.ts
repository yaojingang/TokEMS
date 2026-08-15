import { describe, expect, it, vi } from 'vitest';
import { assertDatabaseMigrationCurrent, readDatabaseMigrationStatus } from './migration-status.js';

const expected = 'a'.repeat(64);
const applied = 'b'.repeat(64);

describe('readDatabaseMigrationStatus', () => {
  it('reports an exact applied migration hash as healthy', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ hash: expected }] }) };

    await expect(readDatabaseMigrationStatus(pool, expected)).resolves.toEqual({
      ok: true,
      expected,
      applied: expected,
    });
  });

  it('reports a different applied migration hash as degraded', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ hash: applied }] }) };

    await expect(readDatabaseMigrationStatus(pool, expected)).resolves.toEqual({
      ok: false,
      expected,
      applied,
    });
  });

  it('rejects worker startup when the migration hashes differ', () => {
    expect(() =>
      assertDatabaseMigrationCurrent({ ok: false, expected, applied }),
    ).toThrow(/Database migration hash mismatch/u);
  });
});
