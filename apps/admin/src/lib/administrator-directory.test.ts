import { describe, expect, it } from 'vitest';
import type { OrganizationInvitation, OrganizationMember } from '@conference/contracts';
import {
  administratorDirectoryInvitations,
  administratorDirectoryMembers,
} from './administrator-directory.js';

const member = (overrides: Partial<OrganizationMember>): OrganizationMember => ({
  id: 'membership-1',
  userId: 101,
  email: 'admin@example.com',
  name: '管理员',
  mobile: null,
  role: 'organization_admin',
  grants: ['*'],
  status: 'active',
  isSuperAdministrator: false,
  profile: null,
  ...overrides,
});

const invitation = (overrides: Partial<OrganizationInvitation>): OrganizationInvitation => ({
  id: 'invitation-1',
  email: 'admin@example.com',
  role: 'organization_admin',
  grants: ['*'],
  status: 'pending',
  invitedBy: 'actor-1',
  expiresAt: '2026-08-05T00:00:00.000Z',
  acceptedAt: null,
  createdAt: '2026-08-04T00:00:00.000Z',
  ...overrides,
});

describe('administrator directory projection', () => {
  it('keeps only full organization administrators in the administrator directory', () => {
    expect(
      administratorDirectoryMembers([
        member({ id: 'root' }),
        member({ id: 'operator', role: 'operator', grants: ['event.read'] }),
        member({ id: 'inconsistent', grants: ['org.member.manage'] }),
      ]).map((item) => item.id),
    ).toEqual(['root']);
  });

  it('keeps only full administrator invitations in the pending administrator list', () => {
    expect(
      administratorDirectoryInvitations([
        invitation({ id: 'admin-invitation' }),
        invitation({ id: 'operator-invitation', role: 'operator', grants: ['event.read'] }),
      ]).map((item) => item.id),
    ).toEqual(['admin-invitation']);
  });
});
