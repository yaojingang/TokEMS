import { randomUUID } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import type { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_IDS } from '@conference/contracts';
import {
  auditLogs,
  memberships,
  organizationInvitations,
  organizations,
  outboxEvents,
  users,
} from '@conference/database';
import { and, eq, inArray, like, or } from 'drizzle-orm';
import { AuthService } from '../modules/auth.module.js';
import { AuthGuard } from './auth.guard.js';
import { DatabaseService } from './database.service.js';
import { OrganizationAdminService } from './organization-admin.service.js';
import { staffAccountEmail } from './staff-account.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;
const originalAdminEmail = process.env.ADMIN_EMAIL;
const originalAdminUserId = process.env.ADMIN_USER_ID;

describePersistent('direct administrator persistence and login', () => {
  const database = new DatabaseService();
  const service = new OrganizationAdminService(database);
  const actorId = randomUUID();
  const lookalikeActorId = randomUUID();
  const organizationId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const organizationSlug = `direct-admin-${suffix}`;
  const actorEmail = `direct-admin-actor-${suffix}@tokems.test`;
  const username = `direct_${suffix}`;
  const casefoldUsername = `casefold_${suffix}`;
  const casefoldUserId = randomUUID();
  const password = 'safe-password-123';
  const renamedUsername = `renamed_${suffix}`;
  const roundTripUsername = `roundtrip_${suffix}`;
  const replacementPassword = 'replacement-password-123';
  const passwordOnlyReplacement = 'password-only-replacement-123';
  const disabledUsername = `disabled_${suffix}`;
  let createdUserId = '';
  let disabledUserId = '';
  const createdMembershipIds: string[] = [];
  const createdInvitationIds: string[] = [];

  beforeAll(async () => {
    process.env.ADMIN_EMAIL = actorEmail;
    process.env.ADMIN_USER_ID = actorId;
    const db = database.db!;
    await db.insert(organizations).values({
      id: organizationId,
      slug: organizationSlug,
      name: '直接管理员集成测试组织',
    });
    await db.insert(users).values([
      {
        id: actorId,
        email: actorEmail,
        name: '直接管理员测试执行者',
      },
      {
        id: lookalikeActorId,
        email: actorEmail.toUpperCase(),
        name: '大小写相似邮箱账号',
      },
      {
        id: casefoldUserId,
        email: staffAccountEmail(casefoldUsername).toUpperCase(),
        name: '历史大写用户名账号',
        passwordHash: await hash(password, 4),
      },
    ]);
    await db.insert(memberships).values([
      {
        organizationId: DEMO_IDS.organization,
        userId: actorId,
        role: 'organization_admin',
        grants: ['*'],
        status: 'active',
      },
      {
        organizationId,
        userId: actorId,
        role: 'organization_admin',
        grants: ['*'],
        status: 'active',
      },
      {
        organizationId: DEMO_IDS.organization,
        userId: lookalikeActorId,
        role: 'organization_admin',
        grants: ['*'],
        status: 'active',
      },
    ]);
  });

  afterAll(async () => {
    const db = database.db!;
    await db.delete(auditLogs).where(eq(auditLogs.actorId, actorId));
    if (createdMembershipIds.length) {
      await db.delete(outboxEvents).where(
        or(
          inArray(
            outboxEvents.correlationId,
            createdMembershipIds.map((id) => `organization-administrator:${id}`),
          ),
          ...createdMembershipIds.map((id) =>
            like(outboxEvents.correlationId, `organization-administrator-credentials:${id}:%`),
          ),
        ),
      );
    }
    if (createdInvitationIds.length) {
      await db.delete(outboxEvents).where(
        inArray(
          outboxEvents.correlationId,
          createdInvitationIds.map((id) => `organization-invitation:${id}`),
        ),
      );
      await db
        .delete(organizationInvitations)
        .where(inArray(organizationInvitations.id, createdInvitationIds));
    }
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    if (disabledUserId) await db.delete(users).where(eq(users.id, disabledUserId));
    if (createdUserId) await db.delete(users).where(eq(users.id, createdUserId));
    await db.delete(users).where(eq(users.id, casefoldUserId));
    await db.delete(users).where(eq(users.id, lookalikeActorId));
    await db.delete(users).where(eq(users.id, actorId));
    if (originalAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = originalAdminEmail;
    if (originalAdminUserId === undefined) delete process.env.ADMIN_USER_ID;
    else process.env.ADMIN_USER_ID = originalAdminUserId;
  });

  it('lets the super administrator create, edit, authenticate, reuse, and remove an administrator', async () => {
    await expect(service.getCurrentIdentity(DEMO_IDS.organization, actorId)).resolves.toMatchObject(
      { membership: { isSuperAdministrator: true } },
    );
    await expect(
      service.getCurrentIdentity(DEMO_IDS.organization, lookalikeActorId),
    ).resolves.toMatchObject({ membership: { isSuperAdministrator: false } });
    await expect(
      service.createAdministrator(DEMO_IDS.organization, lookalikeActorId, {
        username: `blocked_${suffix}`,
        password,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const casefoldAdministrator = await service.createAdministrator(
      DEMO_IDS.organization,
      actorId,
      { username: casefoldUsername, password },
    );
    createdMembershipIds.push(casefoldAdministrator.id);
    const [casefoldMembership] = await database
      .db!.select({ userId: memberships.userId })
      .from(memberships)
      .where(eq(memberships.id, casefoldAdministrator.id))
      .limit(1);
    expect(casefoldMembership?.userId).toBe(casefoldUserId);

    const first = await service.createAdministrator(DEMO_IDS.organization, actorId, {
      username,
      password,
    });
    createdMembershipIds.push(first.id);
    expect(first).toMatchObject({
      username,
      email: null,
      role: 'organization_admin',
      grants: ['*'],
      status: 'active',
      isSuperAdministrator: false,
    });

    const [storedUser] = await database
      .db!.select()
      .from(users)
      .where(eq(users.email, staffAccountEmail(username)))
      .limit(1);
    createdUserId = storedUser!.id;
    expect(await compare(password, storedUser!.passwordHash!)).toBe(true);

    const jwt = new JwtService({ secret: 'integration-test-secret' });
    const auth = new AuthService(jwt, database);
    const guard = new AuthGuard(
      jwt,
      { getAllAndOverride: () => [] } as unknown as Reflector,
      database,
    );
    const guardContext = (accessToken: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ headers: { authorization: `Bearer ${accessToken}` } }),
        }),
        getHandler: () => guardContext,
        getClass: () => AuthGuard,
      }) as unknown as ExecutionContext;
    const originalLogin = await auth.login({ username, password });
    await expect(auth.login({ username: casefoldUsername, password })).resolves.toMatchObject({
      user: { username: casefoldUsername },
    });

    await expect(
      service.updateAdministratorCredentials(DEMO_IDS.organization, first.id, createdUserId, {
        username: renamedUsername,
      }),
    ).rejects.toMatchObject({ status: 403 });

    const invitationBeforeRename = await service.createInvitation(organizationId, actorId, {
      email: staffAccountEmail(username),
      role: 'organization_admin',
      grants: ['*'],
    });
    createdInvitationIds.push(invitationBeforeRename.invitation.id);

    const renamed = await service.updateAdministratorCredentials(
      DEMO_IDS.organization,
      first.id,
      actorId,
      { username: renamedUsername, password: replacementPassword },
    );
    expect(renamed).toMatchObject({
      id: first.id,
      userId: first.userId,
      username: renamedUsername,
      email: null,
    });
    const [renamedUser] = await database
      .db!.select()
      .from(users)
      .where(eq(users.email, staffAccountEmail(renamedUsername)))
      .limit(1);
    expect(renamedUser?.id).toBe(createdUserId);
    expect(await compare(replacementPassword, renamedUser!.passwordHash!)).toBe(true);
    await expect(guard.canActivate(guardContext(originalLogin.accessToken))).rejects.toMatchObject({
      status: 401,
    });
    await expect(auth.login({ username, password })).rejects.toMatchObject({ status: 401 });
    await expect(
      service.acceptInvitation({
        token: invitationBeforeRename.acceptanceToken,
        name: '旧邀请持有人',
        password,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const renamedLogin = await auth.login({
      username: renamedUsername,
      password: replacementPassword,
    });
    expect(renamedLogin).toMatchObject({
      user: {
        id: first.userId,
        username: renamedUsername,
        email: null,
        role: 'organization_admin',
      },
    });
    await expect(guard.canActivate(guardContext(renamedLogin.accessToken))).resolves.toBe(true);

    await Promise.all([
      service.updateAdministratorCredentials(DEMO_IDS.organization, first.id, actorId, {
        username: roundTripUsername,
      }),
      service.updateMember(DEMO_IDS.organization, first.id, actorId, {
        name: '并发修改管理员',
        mobile: null,
        role: 'organization_admin',
        grants: ['*'],
        profile: { company: null, title: null, city: null, bio: null, tags: [] },
      }),
    ]);
    await service.updateAdministratorCredentials(DEMO_IDS.organization, first.id, actorId, {
      username: renamedUsername,
    });
    await expect(guard.canActivate(guardContext(renamedLogin.accessToken))).rejects.toMatchObject({
      status: 401,
    });
    const currentRenamedLogin = await auth.login({
      username: renamedUsername,
      password: replacementPassword,
    });
    await expect(guard.canActivate(guardContext(currentRenamedLogin.accessToken))).resolves.toBe(
      true,
    );

    await expect(
      service.createAdministrator(organizationId, actorId, {
        username: renamedUsername,
        password: 'wrong-password',
      }),
    ).rejects.toMatchObject({ status: 401 });

    const second = await service.createAdministrator(organizationId, actorId, {
      username: renamedUsername,
      password: replacementPassword,
    });
    createdMembershipIds.push(second.id);
    expect(second.userId).toBe(first.userId);

    await service.updateAdministratorCredentials(DEMO_IDS.organization, first.id, actorId, {
      password: passwordOnlyReplacement,
    });
    await expect(
      guard.canActivate(guardContext(currentRenamedLogin.accessToken)),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      auth.login({ username: renamedUsername, password: replacementPassword }),
    ).rejects.toMatchObject({ status: 401 });
    const organizationLogin = await auth.login({
      username: renamedUsername,
      password: passwordOnlyReplacement,
      organizationSlug,
    });
    expect(organizationLogin).toMatchObject({
      user: {
        id: first.userId,
        username: renamedUsername,
        email: null,
        role: 'organization_admin',
      },
    });

    const credentialAudits = await database
      .db!.select({ organizationId: auditLogs.organizationId, resourceId: auditLogs.resourceId })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'organization.administrator.credentials.update'),
          inArray(auditLogs.resourceId, [first.id, second.id]),
        ),
      );
    expect(new Set(credentialAudits.map((item) => item.organizationId))).toEqual(
      new Set([DEMO_IDS.organization, organizationId]),
    );

    const invitationBeforeDirectCreate = await service.createInvitation(
      DEMO_IDS.organization,
      actorId,
      {
        email: staffAccountEmail(disabledUsername),
        role: 'organization_admin',
        grants: ['*'],
      },
    );
    createdInvitationIds.push(invitationBeforeDirectCreate.invitation.id);
    const disabled = await service.createAdministrator(DEMO_IDS.organization, actorId, {
      username: disabledUsername,
      password,
    });
    createdMembershipIds.push(disabled.id);
    const [disabledUser] = await database
      .db!.select({ id: users.id })
      .from(users)
      .where(eq(users.email, staffAccountEmail(disabledUsername)))
      .limit(1);
    disabledUserId = disabledUser!.id;
    await expect(
      service.acceptInvitation({
        token: invitationBeforeDirectCreate.acceptanceToken,
        name: '旧邀请持有人',
        password,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const disabledLogin = await auth.login({ username: disabledUsername, password });
    await service.updateMemberStatus(DEMO_IDS.organization, disabled.id, actorId, {
      status: 'disabled',
    });
    await expect(guard.canActivate(guardContext(disabledLogin.accessToken))).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      service.updateMemberStatus(DEMO_IDS.organization, disabled.id, createdUserId, {
        status: 'active',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.removeMember(DEMO_IDS.organization, disabled.id, createdUserId),
    ).rejects.toMatchObject({ status: 403 });
    await service.updateMemberStatus(DEMO_IDS.organization, disabled.id, actorId, {
      status: 'active',
    });
    await expect(guard.canActivate(guardContext(disabledLogin.accessToken))).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      service.removeAdministrator(DEMO_IDS.organization, disabled.id, actorId),
    ).resolves.toEqual({ deleted: true });

    await expect(
      service.removeAdministrator(organizationId, second.id, createdUserId),
    ).rejects.toMatchObject({ status: 403 });
    await expect(service.removeAdministrator(organizationId, second.id, actorId)).resolves.toEqual({
      deleted: true,
    });
    const recreated = await service.createAdministrator(organizationId, actorId, {
      username: renamedUsername,
      password: passwordOnlyReplacement,
    });
    createdMembershipIds.push(recreated.id);
    await expect(
      guard.canActivate(guardContext(organizationLogin.accessToken)),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.removeAdministrator(organizationId, recreated.id, actorId),
    ).resolves.toEqual({ deleted: true });
    await expect(
      auth.login({
        username: renamedUsername,
        password: passwordOnlyReplacement,
        organizationSlug,
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      auth.login({ username: renamedUsername, password: passwordOnlyReplacement }),
    ).resolves.toMatchObject({ user: { id: first.userId } });
  }, 30_000);
});
