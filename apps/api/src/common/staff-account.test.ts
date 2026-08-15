import { describe, expect, it } from 'vitest';
import {
  configuredSuperAdministratorId,
  normalizeStaffAccountEmail,
  staffAccountEmail,
  staffAccountPublicEmail,
  staffAccountUsername,
  staffCredentialRevision,
  staffCredentialVersion,
} from './staff-account.js';

describe('staff username account identifiers', () => {
  it('validates the immutable super-administrator identity', () => {
    expect(configuredSuperAdministratorId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toBe(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(() => configuredSuperAdministratorId('admin')).toThrow(/valid UUID/);
  });

  it('normalizes email identities before lookup and locking', () => {
    expect(normalizeStaffAccountEmail(' Admin@Example.COM ')).toBe('admin@example.com');
  });

  it('round-trips the reserved internal email used for username login', () => {
    const email = staffAccountEmail('Operations_01');
    expect(email).toBe('operations_01@staff.tokems.invalid');
    expect(staffAccountUsername(email)).toBe('operations_01');
    expect(staffAccountPublicEmail(email)).toBeNull();
    expect(staffAccountUsername('admin@example.com')).toBeNull();
    expect(staffAccountPublicEmail('admin@example.com')).toBe('admin@example.com');
  });

  it('changes the credential version when the login identity or password changes', () => {
    const current = staffCredentialVersion({ email: 'admin@example.com', passwordHash: 'hash-a' });
    expect(staffCredentialVersion({ email: 'admin@example.com', passwordHash: 'hash-a' })).toBe(
      current,
    );
    expect(
      staffCredentialVersion({ email: 'renamed@example.com', passwordHash: 'hash-a' }),
    ).not.toBe(current);
    expect(staffCredentialVersion({ email: 'admin@example.com', passwordHash: 'hash-b' })).not.toBe(
      current,
    );
    const renamed = staffCredentialVersion(
      { email: 'renamed@example.com', passwordHash: 'hash-a' },
      'revision-1',
    );
    expect(
      staffCredentialVersion({ email: 'admin@example.com', passwordHash: 'hash-a' }, 'revision-2'),
    ).not.toBe(current);
    expect(
      staffCredentialVersion(
        { email: 'renamed@example.com', passwordHash: 'hash-a' },
        'revision-2',
      ),
    ).not.toBe(renamed);
  });

  it('reads only the internal credential revision from profile preferences', () => {
    expect(staffCredentialRevision({ security: { staffCredentialVersion: 'revision-1' } })).toBe(
      'revision-1',
    );
    expect(staffCredentialRevision({ security: { staffCredentialVersion: '' } })).toBeNull();
    expect(staffCredentialRevision({ security: 'invalid' })).toBeNull();
  });
});
