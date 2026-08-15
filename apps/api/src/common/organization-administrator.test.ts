import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseService } from './database.service.js';
import { OrganizationAdminService } from './organization-admin.service.js';

const originalAdminUsername = process.env.ADMIN_USERNAME;

afterEach(() => {
  if (originalAdminUsername === undefined) delete process.env.ADMIN_USERNAME;
  else process.env.ADMIN_USERNAME = originalAdminUsername;
});

describe('direct administrator creation', () => {
  it('rejects the configured system administrator username before writing data', async () => {
    process.env.ADMIN_USERNAME = 'Root_Admin';
    const service = new OrganizationAdminService({ db: null } as unknown as DatabaseService);

    await expect(
      service.createAdministrator('org-a', 'actor-a', {
        username: 'root_admin',
        password: 'safe-password',
      }),
    ).rejects.toMatchObject({ status: 409, message: '该用户名已被系统管理员账号使用' });
  });
});
