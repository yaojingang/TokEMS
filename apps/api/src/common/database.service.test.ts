import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from './database.service.js';

describe('canonical database identity proof', () => {
  it('binds a challenge to the current PostgreSQL process and refreshes after restart', async () => {
    const service = new DatabaseService();
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            systemIdentifier: 'cluster-1',
            databaseName: 'conference',
            databaseOid: '16384',
            startedAt: '1787932800.000000',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            systemIdentifier: 'cluster-1',
            databaseName: 'conference',
            databaseOid: '16384',
            startedAt: '1787936400.000000',
          },
        ],
      });
    Object.defineProperty(service, 'pool', { value: { query } });
    const challenge = 'a'.repeat(64);

    await expect(service.canonicalIdentityProof(challenge)).resolves.toBe(
      createHash('sha256')
        .update(`${challenge}\ncluster-1\nconference\n16384\n1787932800.000000`)
        .digest('hex'),
    );
    await expect(service.canonicalIdentityProof(challenge)).resolves.not.toBe(
      createHash('sha256')
        .update(`${challenge}\ncluster-1\nconference\n16384\n1787932800.000000`)
        .digest('hex'),
    );
    expect(query).toHaveBeenCalledTimes(2);
  });
});
