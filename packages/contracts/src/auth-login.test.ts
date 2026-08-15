import { describe, expect, it } from 'vitest';
import {
  AcceptOrganizationInvitationSchema,
  AuthMeSchema,
  CreateOrganizationAdministratorSchema,
  LoginResultSchema,
  LoginSchema,
  OrganizationMemberSchema,
  UpdateOrganizationAdministratorSchema,
} from './index.js';

describe('administrator username and password login contract', () => {
  it('accepts administrator username credentials', () => {
    expect(LoginSchema.parse({ username: 'admin', password: 'admin' })).toEqual({
      username: 'admin',
      password: 'admin',
    });
  });

  it('keeps legacy email payloads compatible with automation clients', () => {
    expect(
      LoginSchema.parse({
        email: 'admin@tokems.local',
        password: 'admin',
      }),
    ).toEqual({
      username: 'admin@tokems.local',
      password: 'admin',
    });
  });

  it('rejects login passwords that bcrypt would silently truncate', () => {
    expect(LoginSchema.safeParse({ username: 'admin', password: 'a'.repeat(72) }).success).toBe(
      true,
    );
    expect(LoginSchema.safeParse({ username: 'admin', password: 'a'.repeat(73) }).success).toBe(
      false,
    );
    expect(LoginSchema.safeParse({ username: 'admin', password: '密'.repeat(25) }).success).toBe(
      false,
    );
  });

  it('normalizes direct-created administrator usernames and protects the password boundary', () => {
    expect(
      CreateOrganizationAdministratorSchema.parse({
        username: ' Operations_01 ',
        password: 'safe-pass-123',
      }),
    ).toEqual({ username: 'operations_01', password: 'safe-pass-123' });
    expect(
      CreateOrganizationAdministratorSchema.safeParse({
        username: '中文管理员',
        password: 'safe-pass-123',
      }).success,
    ).toBe(false);
    expect(
      CreateOrganizationAdministratorSchema.safeParse({
        username: 'operator',
        password: 'short',
      }).success,
    ).toBe(false);
    expect(
      CreateOrganizationAdministratorSchema.safeParse({
        username: 'operator',
        password: '密'.repeat(25),
      }).success,
    ).toBe(false);
  });

  it('supports administrator username changes and optional password resets', () => {
    expect(
      UpdateOrganizationAdministratorSchema.parse({
        username: ' Operations_02 ',
        password: 'replacement-pass-123',
      }),
    ).toEqual({ username: 'operations_02', password: 'replacement-pass-123' });
    expect(UpdateOrganizationAdministratorSchema.parse({ username: 'operations_02' })).toEqual({
      username: 'operations_02',
    });
    expect(
      UpdateOrganizationAdministratorSchema.parse({ password: 'replacement-pass-456' }),
    ).toEqual({ password: 'replacement-pass-456' });
    expect(UpdateOrganizationAdministratorSchema.safeParse({}).success).toBe(false);
    expect(
      UpdateOrganizationAdministratorSchema.safeParse({
        username: 'operations_02',
        password: '密'.repeat(25),
      }).success,
    ).toBe(false);
  });

  it('applies the bcrypt byte boundary to invitation-created administrator passwords', () => {
    const token = 'a'.repeat(32);
    expect(
      AcceptOrganizationInvitationSchema.safeParse({
        token,
        name: '邀请管理员',
        password: 'safe-pass-123',
      }).success,
    ).toBe(true);
    expect(
      AcceptOrganizationInvitationSchema.safeParse({
        token,
        name: '邀请管理员',
        password: '密'.repeat(25),
      }).success,
    ).toBe(false);
  });

  it('keeps super-administrator flags backward compatible in public identity contracts', () => {
    expect(
      OrganizationMemberSchema.parse({
        id: 'membership-1',
        userId: 101,
        email: 'admin@tokems.local',
        name: '组织管理员',
        mobile: null,
        role: 'organization_admin',
        grants: ['*'],
        status: 'active',
        profile: null,
      }).isSuperAdministrator,
    ).toBe(false);
    expect(
      AuthMeSchema.parse({
        user: { id: 101, email: 'admin@tokems.local', name: '组织管理员' },
        organization: {
          id: 'organization-1',
          slug: 'tokems-demo',
          name: 'TokEMS Demo Team',
          settings: { brandName: 'TokEMS' },
        },
        membership: {
          id: 'membership-1',
          role: 'organization_admin',
          grants: ['*'],
          status: 'active',
        },
      }).membership.isSuperAdministrator,
    ).toBe(false);
  });

  it('publishes a compact numeric administrator ID', () => {
    const result = {
      accessToken: 'token',
      user: {
        id: 101,
        email: 'admin@tokems.local',
        name: '组织管理员',
        role: 'organization_admin',
      },
    };
    expect(LoginResultSchema.parse(result).user.id).toBe(101);
    expect(
      LoginResultSchema.safeParse({
        ...result,
        user: { ...result.user, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      }).success,
    ).toBe(false);
  });
});
