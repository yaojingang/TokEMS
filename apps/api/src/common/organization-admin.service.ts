import { createHash, randomBytes } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
  AccountProfile,
  AcceptOrganizationInvitation,
  AdminPreferences,
  AuthMe,
  CreateOrganizationAdministrator,
  CreateOrganizationInvitation,
  CreateOrganizationInvitationResult,
  EventId,
  IntegrationStatus,
  OrganizationHomepageEvent,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationSettings,
  OrganizationSettingsResult,
  PublicSiteConfiguration,
  UpdateAccountProfile,
  UpdateAdminPreferences,
  UpdateMembershipStatus,
  UpdateOrganizationAdministrator,
  UpdateOrganizationMember,
  UpdateOrganizationSettings,
} from '@conference/contracts';
import {
  AnalyticsSettingsSchema,
  AdminPreferencesSchema,
  API_ERROR_CODES,
  DEMO_IDS,
  isPublicEventStatus,
  OrganizationSettingsSchema,
  WebsiteSettingsSchema,
} from '@conference/contracts';
import {
  auditLogs,
  eventBlueprints,
  eventReleases,
  events,
  memberProfiles,
  memberships,
  organizationInvitations,
  organizationIntegrations,
  organizationHomepageEvents,
  organizations,
  outboxEvents,
  publicUserIds,
  users,
} from '@conference/database';
import { readAliyunSmsConfiguration } from '@conference/integrations';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { requirePublicUserId } from './public-user-id.js';
import { grantAllows } from './auth.guard.js';
import {
  configuredSuperAdministratorId,
  normalizeStaffAccountEmail,
  staffAccountEmail,
  staffAccountPublicEmail,
  staffAccountUsername,
} from './staff-account.js';

type Database = NonNullable<DatabaseService['db']>;

const DEFAULT_ORGANIZATION_SETTINGS: OrganizationSettings = {
  brandName: '大会管理中心',
  defaultTimezone: 'Asia/Shanghai',
  defaultCurrency: 'CNY',
  defaultBlueprintId: null,
  defaultTemplateId: null,
  customerAccounts: {
    defaultAccountMode: 'mobile_otp_required',
    termsUrl: '',
    termsVersion: '',
    privacyUrl: '',
    privacyVersion: '',
  },
  website: {
    siteName: '大会报名中心',
    seoTitle: '大会报名中心',
    seoDescription: '',
    faviconUrl: '',
    footerText: '',
    icpNumber: '',
    supportEmail: '',
  },
  analytics: {
    enabled: false,
    provider: 'baidu',
    trackingId: '',
    scriptUrl: '',
    siteId: '',
  },
};

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeAdminPreferences(value: unknown): AdminPreferences {
  const preferences = recordValue(value);
  const admin = recordValue(preferences.admin);
  const parsed = AdminPreferencesSchema.safeParse({ lastEventId: admin.lastEventId ?? null });
  return parsed.success ? parsed.data : { lastEventId: null };
}

function normalizeOrganizationSettings(
  organizationName: string,
  value: Partial<OrganizationSettings> & Record<string, unknown>,
): OrganizationSettings {
  const website = WebsiteSettingsSchema.safeParse({
    ...DEFAULT_ORGANIZATION_SETTINGS.website,
    ...recordValue(value.website),
  });
  const analytics = AnalyticsSettingsSchema.safeParse({
    ...DEFAULT_ORGANIZATION_SETTINGS.analytics,
    ...recordValue(value.analytics),
  });
  const customerAccounts = recordValue(value.customerAccounts);
  const normalizedCustomerAccounts = OrganizationSettingsSchema.shape.customerAccounts.safeParse({
    ...DEFAULT_ORGANIZATION_SETTINGS.customerAccounts,
    ...customerAccounts,
  });
  return {
    brandName:
      typeof value.brandName === 'string'
        ? value.brandName
        : typeof value.brand === 'string'
          ? value.brand
          : organizationName,
    defaultTimezone:
      typeof value.defaultTimezone === 'string'
        ? value.defaultTimezone
        : DEFAULT_ORGANIZATION_SETTINGS.defaultTimezone,
    defaultCurrency: 'CNY',
    defaultBlueprintId:
      typeof value.defaultBlueprintId === 'string' ? value.defaultBlueprintId : null,
    defaultTemplateId: typeof value.defaultTemplateId === 'string' ? value.defaultTemplateId : null,
    customerAccounts: normalizedCustomerAccounts.success
      ? normalizedCustomerAccounts.data
      : DEFAULT_ORGANIZATION_SETTINGS.customerAccounts,
    website: website.success
      ? website.data
      : {
          ...DEFAULT_ORGANIZATION_SETTINGS.website,
          siteName: organizationName,
          seoTitle: organizationName,
        },
    analytics: analytics.success ? analytics.data : DEFAULT_ORGANIZATION_SETTINGS.analytics,
  };
}

function validatesGrants(grants: string[]) {
  return grants.every(
    (grant) => !grant.includes(' ') && !grant.startsWith('.') && !grant.endsWith('.'),
  );
}

function allowsGrant(grants: string[], required: string) {
  return grants.some(
    (grant) =>
      grant === '*' ||
      grant === required ||
      (grant.endsWith('.*') && required.startsWith(`${grant.slice(0, -2)}.`)),
  );
}

function sameGrants(left: string[], right: string[]) {
  return [...new Set(left)].sort().join('\n') === [...new Set(right)].sort().join('\n');
}

function isOrganizationAdministrator(member: {
  role: string;
  grants: string[];
  status: 'active' | 'disabled';
}) {
  return member.status === 'active' && allowsGrant(member.grants, 'org.member.manage');
}

function hasPrivilegedAdministratorRole(member: { role: string; grants: string[] }) {
  return member.role === 'organization_admin' && member.grants.includes('*');
}

function staffIdentityEmailLockKey(email: string) {
  return `staff-identity-email:${normalizeStaffAccountEmail(email)}`;
}

function staffIdentityEmailMatches(email: string) {
  return sql`lower(${users.email}) = ${normalizeStaffAccountEmail(email)}`;
}

function organizationInvitationEmailMatches(email: string) {
  return sql`lower(${organizationInvitations.email}) = ${normalizeStaffAccountEmail(email)}`;
}

function staffIdentityUserLockKey(userId: string) {
  return `staff-identity-user:${userId}`;
}

function staffMembershipLockKey(membershipId: string) {
  return `staff-membership:${membershipId}`;
}

function staffMembershipSetLockKey(organizationId: string) {
  return `staff-membership-set:${organizationId}`;
}

function isConfiguredSuperAdministrator(
  user: { id: string },
  member: { role: string; grants: string[]; status: 'active' | 'disabled' },
) {
  return (
    user.id === configuredSuperAdministratorId() &&
    member.status === 'active' &&
    hasPrivilegedAdministratorRole(member)
  );
}

function assertConfiguredSuperAdministrator(
  user: { id: string },
  member: { role: string; grants: string[]; status: 'active' | 'disabled' },
) {
  if (isConfiguredSuperAdministrator(user, member)) return;
  throw new DomainError(
    API_ERROR_CODES.FORBIDDEN,
    '只有超级管理员可以管理其他管理员账号',
    HttpStatus.FORBIDDEN,
  );
}

function assertRoleGrantConsistency(role: string, grants: string[]) {
  const privilegedRole = role === 'organization_admin';
  const privilegedGrants = grants.includes('*');
  if (privilegedRole !== privilegedGrants) {
    throw new DomainError(
      API_ERROR_CODES.VALIDATION_ERROR,
      '组织管理员角色需要使用完整权限，其他角色不能持有完整权限',
      HttpStatus.BAD_REQUEST,
    );
  }
  if (grants.some((grant) => grant.startsWith('event.')) && !allowsGrant(grants, 'event.read')) {
    throw new DomainError(
      API_ERROR_CODES.VALIDATION_ERROR,
      '大会级角色需要同时具备大会基础访问权限',
      HttpStatus.BAD_REQUEST,
    );
  }
}

function assertCanDelegate(
  actor: { role: string; grants: string[]; status: 'active' | 'disabled' },
  role: string,
  grants: string[],
) {
  assertRoleGrantConsistency(role, grants);
  if (actor.status === 'active' && hasPrivilegedAdministratorRole(actor)) return;
  if (role === 'organization_admin' || grants.some((grant) => !allowsGrant(actor.grants, grant))) {
    throw new DomainError(
      API_ERROR_CODES.FORBIDDEN,
      '不能分配超出当前账号范围的角色或权限',
      HttpStatus.FORBIDDEN,
    );
  }
}

@Injectable()
export class OrganizationAdminService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private db(): Database {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '此管理能力需要 PostgreSQL 持久化模式',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private tokenHash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private invitationFromRow(
    row: typeof organizationInvitations.$inferSelect,
    now = new Date(),
  ): OrganizationInvitation {
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      grants: row.grants,
      status: row.status === 'pending' && row.expiresAt <= now ? 'expired' : row.status,
      invitedBy: row.invitedBy,
      expiresAt: row.expiresAt.toISOString(),
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private memberFromRows(
    membership: typeof memberships.$inferSelect,
    user: typeof users.$inferSelect,
    profile: typeof memberProfiles.$inferSelect | null,
    publicUserId: number,
  ): OrganizationMember {
    return {
      id: membership.id,
      userId: publicUserId,
      email: staffAccountPublicEmail(user.email),
      username: staffAccountUsername(user.email),
      name: user.name,
      mobile: user.mobile,
      role: membership.role,
      grants: membership.grants,
      status: membership.status,
      isSuperAdministrator: isConfiguredSuperAdministrator(user, membership),
      profile: profile
        ? {
            company: profile.company,
            title: profile.title,
            city: profile.city,
            bio: profile.bio,
            tags: profile.tags,
          }
        : null,
    };
  }

  private accountProfileFromRows(
    membership: typeof memberships.$inferSelect,
    user: typeof users.$inferSelect,
    organization: typeof organizations.$inferSelect,
    profile: typeof memberProfiles.$inferSelect | null,
    publicUserId: number,
  ): AccountProfile {
    return {
      user: {
        id: publicUserId,
        email: staffAccountPublicEmail(user.email),
        username: staffAccountUsername(user.email),
        name: user.name,
        mobile: user.mobile,
      },
      organization: {
        id: organization.id,
        slug: organization.slug,
        name: organization.name,
      },
      membership: {
        id: membership.id,
        role: membership.role,
        grants: membership.grants,
        status: membership.status,
      },
      profile: profile
        ? {
            company: profile.company,
            title: profile.title,
            city: profile.city,
            bio: profile.bio,
            tags: profile.tags,
          }
        : null,
    };
  }

  async getCurrentIdentity(
    organizationId: string,
    userId: string,
    fallback?: {
      email: string;
      name: string;
      role: AuthMe['membership']['role'];
      grants: string[];
    },
  ): Promise<AuthMe> {
    if (!this.database.db && fallback) {
      return {
        user: {
          id: 101,
          email: staffAccountPublicEmail(fallback.email),
          username: staffAccountUsername(fallback.email),
          name: fallback.name,
        },
        organization: {
          id: organizationId,
          slug: process.env.PUBLIC_ORGANIZATION_SLUG ?? 'tokems-demo',
          name: 'TokEMS Demo Team',
          settings: {
            ...DEFAULT_ORGANIZATION_SETTINGS,
            brandName: 'TokEMS Demo',
          },
        },
        membership: {
          id: `demo-membership:${userId}`,
          role: fallback.role,
          grants: fallback.grants,
          status: 'active',
          isSuperAdministrator: isConfiguredSuperAdministrator(
            { id: userId },
            { role: fallback.role, grants: fallback.grants, status: 'active' },
          ),
        },
        adminPreferences: { lastEventId: null },
      };
    }
    const [row] = await this.db()
      .select({
        membership: memberships,
        user: users,
        organization: organizations,
        profile: memberProfiles,
        publicUserId: publicUserIds.publicId,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .innerJoin(
        publicUserIds,
        and(
          eq(publicUserIds.subjectType, 'staff'),
          eq(publicUserIds.subjectUuid, users.id),
          isNull(publicUserIds.retiredAt),
        ),
      )
      .leftJoin(
        memberProfiles,
        and(
          eq(memberProfiles.userId, memberships.userId),
          eq(memberProfiles.organizationId, memberships.organizationId),
        ),
      )
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (!row) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '组织成员身份已失效',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return {
      user: {
        id: row.publicUserId,
        email: staffAccountPublicEmail(row.user.email),
        username: staffAccountUsername(row.user.email),
        name: row.user.name,
      },
      organization: {
        id: row.organization.id,
        slug: row.organization.slug,
        name: row.organization.name,
        settings: normalizeOrganizationSettings(row.organization.name, row.organization.settings),
      },
      membership: {
        id: row.membership.id,
        role: row.membership.role,
        grants: row.membership.grants,
        status: row.membership.status,
        isSuperAdministrator: isConfiguredSuperAdministrator(row.user, row.membership),
      },
      adminPreferences: normalizeAdminPreferences(row.profile?.preferences),
    };
  }

  async updateAdminPreferences(
    organizationId: string,
    userId: string,
    input: UpdateAdminPreferences,
    fallbackGrants: string[] = [],
  ): Promise<AdminPreferences> {
    if (!this.database.db) {
      if (input.lastEventId && !grantAllows(fallbackGrants, 'event.read')) {
        throw new DomainError(
          API_ERROR_CODES.FORBIDDEN,
          '当前角色没有大会读取权限',
          HttpStatus.FORBIDDEN,
        );
      }
      if (input.lastEventId && input.lastEventId !== DEMO_IDS.event) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      return input;
    }

    return this.db().transaction(async (tx) => {
      const [membership] = await tx
        .select({ grants: memberships.grants })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.userId, userId),
            eq(memberships.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      if (!membership) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '组织成员身份已失效',
          HttpStatus.UNAUTHORIZED,
        );
      }

      if (input.lastEventId) {
        if (!grantAllows(membership.grants, 'event.read')) {
          throw new DomainError(
            API_ERROR_CODES.FORBIDDEN,
            '当前角色没有大会读取权限',
            HttpStatus.FORBIDDEN,
          );
        }
        const [event] = await tx
          .select({ status: events.status })
          .from(events)
          .where(and(eq(events.organizationId, organizationId), eq(events.id, input.lastEventId)))
          .limit(1);
        if (!event) {
          throw new DomainError(
            API_ERROR_CODES.NOT_FOUND,
            '大会不存在或无权访问',
            HttpStatus.NOT_FOUND,
          );
        }
        if (event.status === 'archived') {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '已归档大会不能设为最近大会',
            HttpStatus.CONFLICT,
          );
        }
      }

      const initialPreferences = input.lastEventId
        ? { admin: { lastEventId: input.lastEventId } }
        : {};
      const existingAdminPreferences = sql`case
        when jsonb_typeof(${memberProfiles.preferences}->'admin') = 'object'
        then ${memberProfiles.preferences}->'admin'
        else '{}'::jsonb
      end`;
      const existingPreferences = sql`case
        when jsonb_typeof(${memberProfiles.preferences}) = 'object'
        then ${memberProfiles.preferences}
        else '{}'::jsonb
      end`;
      const adminPreferenceValue = input.lastEventId
        ? sql`${existingAdminPreferences} || jsonb_build_object('lastEventId', cast(${input.lastEventId} as integer))`
        : sql`${existingAdminPreferences} - 'lastEventId'`;
      await tx
        .insert(memberProfiles)
        .values({ organizationId, userId, preferences: initialPreferences })
        .onConflictDoUpdate({
          target: [memberProfiles.organizationId, memberProfiles.userId],
          set: {
            preferences: sql`${existingPreferences} || jsonb_build_object('admin', ${adminPreferenceValue})`,
            updatedAt: new Date(),
          },
        });

      return input;
    });
  }

  async getAccountProfile(
    organizationId: string,
    userId: string,
    fallback?: {
      email: string;
      name: string;
      role: AccountProfile['membership']['role'];
      grants: string[];
    },
  ): Promise<AccountProfile> {
    if (!this.database.db && fallback) {
      return {
        user: {
          id: 101,
          email: staffAccountPublicEmail(fallback.email),
          username: staffAccountUsername(fallback.email),
          name: fallback.name,
          mobile: null,
        },
        organization: {
          id: organizationId,
          slug: process.env.PUBLIC_ORGANIZATION_SLUG ?? 'tokems-demo',
          name: 'TokEMS Demo Team',
        },
        membership: {
          id: `demo-membership:${userId}`,
          role: fallback.role,
          grants: fallback.grants,
          status: 'active',
        },
        profile: null,
      };
    }
    const [row] = await this.db()
      .select({
        membership: memberships,
        user: users,
        organization: organizations,
        profile: memberProfiles,
        publicUserId: publicUserIds.publicId,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .innerJoin(
        publicUserIds,
        and(
          eq(publicUserIds.subjectType, 'staff'),
          eq(publicUserIds.subjectUuid, users.id),
          isNull(publicUserIds.retiredAt),
        ),
      )
      .leftJoin(
        memberProfiles,
        and(
          eq(memberProfiles.userId, memberships.userId),
          eq(memberProfiles.organizationId, memberships.organizationId),
        ),
      )
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (!row) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '组织成员身份已失效',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.accountProfileFromRows(
      row.membership,
      row.user,
      row.organization,
      row.profile,
      row.publicUserId,
    );
  }

  async updateAccountProfile(
    organizationId: string,
    userId: string,
    input: UpdateAccountProfile,
  ): Promise<AccountProfile> {
    const db = this.db();
    const publicUserId = await requirePublicUserId(db, 'staff', userId);
    const [membershipSnapshot] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)))
      .limit(1);
    await db.transaction(async (tx) => {
      const lockKeys = [
        staffIdentityUserLockKey(userId),
        ...(membershipSnapshot ? [staffMembershipLockKey(membershipSnapshot.id)] : []),
      ].sort();
      for (const lockKey of lockKeys) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      }
      const [row] = await tx
        .select({ membership: memberships, user: users })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.userId, userId),
            eq(memberships.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      if (!row) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '组织成员身份已失效',
          HttpStatus.UNAUTHORIZED,
        );
      }
      const [profile] = await tx
        .select()
        .from(memberProfiles)
        .where(
          and(eq(memberProfiles.organizationId, organizationId), eq(memberProfiles.userId, userId)),
        )
        .limit(1);

      await tx
        .update(users)
        .set({ name: input.name, mobile: input.mobile, updatedAt: new Date() })
        .where(eq(users.id, userId));
      await tx
        .insert(memberProfiles)
        .values({
          organizationId,
          userId,
          ...input.profile,
        })
        .onConflictDoUpdate({
          target: [memberProfiles.organizationId, memberProfiles.userId],
          set: { ...input.profile, updatedAt: new Date() },
        });
      await tx.insert(auditLogs).values({
        organizationId,
        actorId: userId,
        action: 'account.profile.update',
        resourceType: 'user',
        resourceId: String(publicUserId),
        before: {
          name: row.user.name,
          mobile: row.user.mobile,
          profile: profile
            ? {
                company: profile.company,
                title: profile.title,
                city: profile.city,
                bio: profile.bio,
                tags: profile.tags,
              }
            : null,
        },
        after: {
          name: input.name,
          mobile: input.mobile,
          profile: input.profile,
        },
        traceId: crypto.randomUUID(),
      });
    });
    return this.getAccountProfile(organizationId, userId);
  }

  async listMembers(organizationId: string): Promise<OrganizationMember[]> {
    const rows = await this.db()
      .select({
        membership: memberships,
        user: users,
        profile: memberProfiles,
        publicUserId: publicUserIds.publicId,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(
        publicUserIds,
        and(
          eq(publicUserIds.subjectType, 'staff'),
          eq(publicUserIds.subjectUuid, users.id),
          isNull(publicUserIds.retiredAt),
        ),
      )
      .leftJoin(
        memberProfiles,
        and(
          eq(memberProfiles.userId, memberships.userId),
          eq(memberProfiles.organizationId, memberships.organizationId),
        ),
      )
      .where(eq(memberships.organizationId, organizationId))
      .orderBy(asc(users.name));
    return rows.map(({ membership, user, profile, publicUserId }) =>
      this.memberFromRows(membership, user, profile, publicUserId),
    );
  }

  async updateMember(
    organizationId: string,
    membershipId: string,
    actorId: string,
    input: UpdateOrganizationMember,
  ): Promise<OrganizationMember> {
    if (!validatesGrants(input.grants)) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '权限标识格式不正确',
        HttpStatus.BAD_REQUEST,
      );
    }
    const db = this.db();
    const [targetSnapshot, actorSnapshot] = await Promise.all([
      db
        .select({ id: memberships.id, userId: memberships.userId })
        .from(memberships)
        .where(
          and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)),
        )
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, actorId)))
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    const result = await db.transaction(async (tx) => {
      const lockKeys = [
        staffMembershipSetLockKey(organizationId),
        ...(targetSnapshot
          ? [
              staffIdentityUserLockKey(targetSnapshot.userId),
              staffMembershipLockKey(targetSnapshot.id),
            ]
          : []),
        ...(actorSnapshot ? [staffMembershipLockKey(actorSnapshot.id)] : []),
      ].sort();
      for (const lockKey of new Set(lockKeys)) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      }
      const [membership] = await tx
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)),
        )
        .for('update')
        .limit(1);
      if (!membership) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '组织成员不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      const [actor] = await tx
        .select({
          membership: memberships,
          user: users,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.userId, actorId),
            eq(memberships.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      if (!actor) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '组织成员身份已失效',
          HttpStatus.UNAUTHORIZED,
        );
      }
      const changesOwnAccess =
        membership.userId === actorId &&
        (membership.role !== input.role || !sameGrants(membership.grants, input.grants));
      if (changesOwnAccess) {
        throw new DomainError(
          API_ERROR_CODES.FORBIDDEN,
          '当前账号不能修改自己的角色或权限',
          HttpStatus.FORBIDDEN,
        );
      }
      assertCanDelegate(actor.membership, input.role, input.grants);
      if (hasPrivilegedAdministratorRole(membership) || input.role === 'organization_admin') {
        assertConfiguredSuperAdministrator(actor.user, actor.membership);
      }
      const activeRows = await tx
        .select({ role: memberships.role, grants: memberships.grants, status: memberships.status })
        .from(memberships)
        .where(eq(memberships.organizationId, organizationId))
        .for('update');
      const removesAdministratorAccess =
        isOrganizationAdministrator(membership) &&
        !isOrganizationAdministrator({
          role: input.role,
          grants: input.grants,
          status: membership.status,
        });
      if (
        removesAdministratorAccess &&
        activeRows.filter(isOrganizationAdministrator).length <= 1
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '组织需要保留至少一名可管理成员与权限的管理员',
          HttpStatus.CONFLICT,
        );
      }
      const [user] = await tx
        .update(users)
        .set({ name: input.name, mobile: input.mobile, updatedAt: new Date() })
        .where(eq(users.id, membership.userId))
        .returning();
      const [updatedMembership] = await tx
        .update(memberships)
        .set({
          role: input.role,
          grants: input.grants,
          updatedAt: sql`greatest(clock_timestamp(), ${memberships.updatedAt} + interval '1 millisecond')`,
        })
        .where(eq(memberships.id, membership.id))
        .returning();
      const [profile] = await tx
        .insert(memberProfiles)
        .values({
          organizationId,
          userId: membership.userId,
          ...input.profile,
        })
        .onConflictDoUpdate({
          target: [memberProfiles.organizationId, memberProfiles.userId],
          set: { ...input.profile, updatedAt: new Date() },
        })
        .returning();
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'organization.member.update',
        resourceType: 'membership',
        resourceId: membership.id,
        before: { role: membership.role, grants: membership.grants },
        after: { role: updatedMembership!.role, grants: updatedMembership!.grants },
        traceId: crypto.randomUUID(),
      });
      return { user: user!, membership: updatedMembership!, profile: profile! };
    });
    const publicUserId = await requirePublicUserId(this.db(), 'staff', result.user.id);
    return this.memberFromRows(result.membership, result.user, result.profile, publicUserId);
  }

  async updateMemberStatus(
    organizationId: string,
    membershipId: string,
    actorId: string,
    input: UpdateMembershipStatus,
  ): Promise<OrganizationMember> {
    const db = this.db();
    const [targetSnapshot, actorSnapshot] = await Promise.all([
      db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)),
        )
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, actorId)))
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    const result = await db.transaction(async (tx) => {
      const lockKeys = [
        staffMembershipSetLockKey(organizationId),
        ...(targetSnapshot ? [staffMembershipLockKey(targetSnapshot.id)] : []),
        ...(actorSnapshot ? [staffMembershipLockKey(actorSnapshot.id)] : []),
      ].sort();
      for (const lockKey of new Set(lockKeys)) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      }
      const [membership] = await tx
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)),
        )
        .for('update')
        .limit(1);
      if (!membership) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '组织成员不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      const [actor] = await tx
        .select({
          membership: memberships,
          user: users,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.userId, actorId),
            eq(memberships.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      if (!actor) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '组织成员身份已失效',
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (hasPrivilegedAdministratorRole(membership)) {
        assertConfiguredSuperAdministrator(actor.user, actor.membership);
      }
      const [user] = await tx.select().from(users).where(eq(users.id, membership.userId)).limit(1);
      const [profile] = await tx
        .select()
        .from(memberProfiles)
        .where(
          and(
            eq(memberProfiles.userId, membership.userId),
            eq(memberProfiles.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (membership.userId === actorId && input.status === 'disabled') {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前账号不能停用自己',
          HttpStatus.CONFLICT,
        );
      }
      const activeRows = await tx
        .select({ role: memberships.role, grants: memberships.grants, status: memberships.status })
        .from(memberships)
        .where(eq(memberships.organizationId, organizationId))
        .for('update');
      if (
        input.status === 'disabled' &&
        isOrganizationAdministrator(membership) &&
        activeRows.filter(isOrganizationAdministrator).length <= 1
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '组织需要保留至少一名可管理成员与权限的管理员',
          HttpStatus.CONFLICT,
        );
      }
      const [updated] = await tx
        .update(memberships)
        .set({
          status: input.status,
          updatedAt: sql`greatest(clock_timestamp(), ${memberships.updatedAt} + interval '1 millisecond')`,
        })
        .where(eq(memberships.id, membershipId))
        .returning();
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: `organization.member.${input.status === 'active' ? 'enable' : 'disable'}`,
        resourceType: 'membership',
        resourceId: membershipId,
        before: { status: membership.status },
        after: { status: updated!.status },
        traceId: crypto.randomUUID(),
      });
      return { membership: updated!, user: user!, profile: profile ?? null };
    });
    const publicUserId = await requirePublicUserId(this.db(), 'staff', result.user.id);
    return this.memberFromRows(result.membership, result.user, result.profile, publicUserId);
  }

  async removeMember(organizationId: string, membershipId: string, actorId: string) {
    return this.removeMemberWithPolicy(organizationId, membershipId, actorId, false);
  }

  async removeAdministrator(organizationId: string, membershipId: string, actorId: string) {
    return this.removeMemberWithPolicy(organizationId, membershipId, actorId, true);
  }

  private async removeMemberWithPolicy(
    organizationId: string,
    membershipId: string,
    actorId: string,
    superAdministratorOnly: boolean,
  ) {
    const db = this.db();
    const [targetSnapshot, actorSnapshot] = await Promise.all([
      db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)),
        )
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, actorId)))
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    return db.transaction(async (tx) => {
      const lockKeys = [
        staffMembershipSetLockKey(organizationId),
        ...(targetSnapshot ? [staffMembershipLockKey(targetSnapshot.id)] : []),
        ...(actorSnapshot ? [staffMembershipLockKey(actorSnapshot.id)] : []),
      ].sort();
      for (const lockKey of new Set(lockKeys)) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      }
      const [membership] = await tx
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)),
        )
        .for('update')
        .limit(1);
      if (!membership) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '组织成员不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      if (superAdministratorOnly && !hasPrivilegedAdministratorRole(membership)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '目标账号不是组织管理员',
          HttpStatus.CONFLICT,
        );
      }
      const [actor] = await tx
        .select({
          membership: memberships,
          user: users,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.userId, actorId),
            eq(memberships.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      if (!actor) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '组织成员身份已失效',
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (superAdministratorOnly || hasPrivilegedAdministratorRole(membership)) {
        assertConfiguredSuperAdministrator(actor.user, actor.membership);
      }
      if (membership.userId === actorId) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前账号不能移除自己',
          HttpStatus.CONFLICT,
        );
      }
      const activeRows = await tx
        .select({ role: memberships.role, grants: memberships.grants, status: memberships.status })
        .from(memberships)
        .where(eq(memberships.organizationId, organizationId))
        .for('update');
      if (
        isOrganizationAdministrator(membership) &&
        activeRows.filter(isOrganizationAdministrator).length <= 1
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '组织需要保留至少一名可管理成员与权限的管理员',
          HttpStatus.CONFLICT,
        );
      }
      await tx
        .delete(memberProfiles)
        .where(
          and(
            eq(memberProfiles.organizationId, organizationId),
            eq(memberProfiles.userId, membership.userId),
          ),
        );
      await tx.delete(memberships).where(eq(memberships.id, membershipId));
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'organization.member.remove',
        resourceType: 'membership',
        resourceId: membershipId,
        before: {
          userId: membership.userId,
          role: membership.role,
          grants: membership.grants,
          status: membership.status,
        },
        traceId: crypto.randomUUID(),
      });
      return { deleted: true };
    });
  }

  async listInvitations(organizationId: string): Promise<OrganizationInvitation[]> {
    const rows = await this.db()
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.organizationId, organizationId))
      .orderBy(desc(organizationInvitations.createdAt));
    return rows.map((row) => this.invitationFromRow(row));
  }

  async createAdministrator(
    organizationId: string,
    actorId: string,
    input: CreateOrganizationAdministrator,
  ): Promise<OrganizationMember> {
    const username = input.username.trim().toLowerCase();
    const reservedUsername = (process.env.ADMIN_USERNAME ?? 'admin').trim().toLowerCase();
    if (username === reservedUsername) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '该用户名已被系统管理员账号使用',
        HttpStatus.CONFLICT,
      );
    }
    const email = staffAccountEmail(username);
    const db = this.db();
    const [authorizedActor] = await db
      .select({
        membership: memberships,
        user: users,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, actorId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (!authorizedActor) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '组织成员身份已失效',
        HttpStatus.UNAUTHORIZED,
      );
    }
    assertConfiguredSuperAdministrator(authorizedActor.user, authorizedActor.membership);
    const knownUsers = await db
      .select()
      .from(users)
      .where(staffIdentityEmailMatches(email))
      .limit(2);
    if (knownUsers.length > 1) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '该用户名关联了多个历史账号，请先合并重复账号',
        HttpStatus.CONFLICT,
      );
    }
    const [knownUser] = knownUsers;
    const newPasswordHash = knownUser ? null : await hash(input.password, 12);
    return db.transaction(async (tx) => {
      const lockKeys = [
        staffIdentityEmailLockKey(email),
        staffMembershipLockKey(authorizedActor.membership.id),
        ...(knownUser ? [staffIdentityUserLockKey(knownUser.id)] : []),
      ].sort();
      for (const lockKey of new Set(lockKeys)) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      }
      const [actor] = await tx
        .select({
          membership: memberships,
          user: users,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.userId, actorId),
            eq(memberships.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      if (!actor) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '组织成员身份已失效',
          HttpStatus.UNAUTHORIZED,
        );
      }
      assertConfiguredSuperAdministrator(actor.user, actor.membership);
      const existingUsers = await tx
        .select()
        .from(users)
        .where(staffIdentityEmailMatches(email))
        .limit(2);
      if (existingUsers.length > 1) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该用户名关联了多个历史账号，请先合并重复账号',
          HttpStatus.CONFLICT,
        );
      }
      const [existingUser] = existingUsers;
      if (existingUser) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${staffIdentityUserLockKey(existingUser.id)}, 0))`,
        );
      }
      if (
        existingUser &&
        (!existingUser.passwordHash || !(await compare(input.password, existingUser.passwordHash)))
      ) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '该用户名已被使用，请输入该账号的现有密码',
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (existingUser) {
        const [existingMembership] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.organizationId, organizationId),
              eq(memberships.userId, existingUser.id),
            ),
          )
          .limit(1);
        if (existingMembership) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '该用户名已经是本组织管理员',
            HttpStatus.CONFLICT,
          );
        }
      }
      let user = existingUser;
      if (!user) {
        [user] = await tx
          .insert(users)
          .values({
            email,
            name: username,
            passwordHash: newPasswordHash ?? (await hash(input.password, 12)),
          })
          .returning();
      }
      if (!user) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '管理员账号创建失败',
          HttpStatus.CONFLICT,
        );
      }
      const cancelledInvitations = await tx
        .update(organizationInvitations)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(
          and(
            eq(organizationInvitations.organizationId, organizationId),
            organizationInvitationEmailMatches(email),
            eq(organizationInvitations.status, 'pending'),
          ),
        )
        .returning({ id: organizationInvitations.id });
      const [membership] = await tx
        .insert(memberships)
        .values({
          organizationId,
          userId: user!.id,
          role: 'organization_admin',
          grants: ['*'],
          status: 'active',
        })
        .returning();
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'organization.administrator.create',
        resourceType: 'membership',
        resourceId: membership!.id,
        after: {
          userId: user!.id,
          username,
          role: membership!.role,
          grants: membership!.grants,
          status: membership!.status,
        },
        traceId: crypto.randomUUID(),
      });
      if (cancelledInvitations.length) {
        await tx.insert(auditLogs).values(
          cancelledInvitations.map((invitation) => ({
            organizationId,
            actorId,
            action: 'organization.invitation.cancel',
            resourceType: 'organization_invitation',
            resourceId: invitation.id,
            before: { status: 'pending', email },
            after: { status: 'cancelled', reason: 'administrator_created_directly' },
            traceId: crypto.randomUUID(),
          })),
        );
      }
      await tx.insert(outboxEvents).values({
        organizationId,
        eventType: 'OrganizationAdministratorCreated',
        correlationId: `organization-administrator:${membership!.id}`,
        payload: {
          membershipId: membership!.id,
          userId: user!.id,
          username,
          createdUser: !existingUser,
        },
      });
      const [publicIdRow] = await tx
        .select({ publicId: publicUserIds.publicId })
        .from(publicUserIds)
        .where(
          and(
            eq(publicUserIds.subjectType, 'staff'),
            eq(publicUserIds.subjectUuid, user!.id),
            isNull(publicUserIds.retiredAt),
          ),
        )
        .limit(1);
      if (!publicIdRow) throw new Error('新管理员缺少数字用户 ID');
      return this.memberFromRows(membership!, user!, null, publicIdRow.publicId);
    });
  }

  async updateAdministratorCredentials(
    organizationId: string,
    membershipId: string,
    actorId: string,
    input: UpdateOrganizationAdministrator,
  ): Promise<OrganizationMember> {
    const username = input.username?.trim().toLowerCase();
    const reservedUsername = (process.env.ADMIN_USERNAME ?? 'admin').trim().toLowerCase();
    if (username && username === reservedUsername) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '该用户名已被系统管理员账号使用',
        HttpStatus.CONFLICT,
      );
    }
    const requestedEmail = username ? staffAccountEmail(username) : undefined;
    const db = this.db();
    const [authorizedActor] = await db
      .select({ membership: memberships, user: users })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, actorId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (!authorizedActor) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '组织成员身份已失效',
        HttpStatus.UNAUTHORIZED,
      );
    }
    assertConfiguredSuperAdministrator(authorizedActor.user, authorizedActor.membership);
    const [target] = await db
      .select({ membership: memberships, user: users })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)))
      .limit(1);
    if (!target) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '管理员不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!hasPrivilegedAdministratorRole(target.membership)) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '目标账号不是组织管理员',
        HttpStatus.CONFLICT,
      );
    }
    if (
      target.user.id === actorId ||
      isConfiguredSuperAdministrator(target.user, target.membership)
    ) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '超级管理员不能在这里修改自己的登录凭据',
        HttpStatus.CONFLICT,
      );
    }
    if ((!requestedEmail || target.user.email === requestedEmail) && !input.password) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '用户名或密码至少需要修改一项',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (requestedEmail && target.user.email !== requestedEmail) {
      const conflicts = await db
        .select({ id: users.id })
        .from(users)
        .where(staffIdentityEmailMatches(requestedEmail))
        .limit(2);
      if (conflicts.some((conflict) => conflict.id !== target.user.id)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该用户名已被其他管理员使用',
          HttpStatus.CONFLICT,
        );
      }
    }
    const replacementPasswordHash = input.password ? await hash(input.password, 12) : undefined;

    return db.transaction(async (tx) => {
      const lockKeys = [
        staffIdentityUserLockKey(target.user.id),
        staffIdentityEmailLockKey(target.user.email),
        staffMembershipLockKey(authorizedActor.membership.id),
        staffMembershipLockKey(target.membership.id),
        ...(requestedEmail ? [staffIdentityEmailLockKey(requestedEmail)] : []),
      ].sort();
      for (const lockKey of new Set(lockKeys)) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      }
      const [actor] = await tx
        .select({ membership: memberships, user: users })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.userId, actorId),
            eq(memberships.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      if (!actor) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '组织成员身份已失效',
          HttpStatus.UNAUTHORIZED,
        );
      }
      assertConfiguredSuperAdministrator(actor.user, actor.membership);
      const [current] = await tx
        .select({ membership: memberships, user: users })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)),
        )
        .for('update')
        .limit(1);
      if (!current) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '管理员不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      if (!hasPrivilegedAdministratorRole(current.membership)) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '目标账号不是组织管理员',
          HttpStatus.CONFLICT,
        );
      }
      if (
        current.user.id === actorId ||
        isConfiguredSuperAdministrator(current.user, current.membership)
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '超级管理员不能在这里修改自己的登录凭据',
          HttpStatus.CONFLICT,
        );
      }
      const nextEmail = requestedEmail ?? current.user.email;
      if (current.user.email === nextEmail && !replacementPasswordHash) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '用户名或密码至少需要修改一项',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (current.user.email !== nextEmail) {
        const conflicts = await tx
          .select({ id: users.id })
          .from(users)
          .where(staffIdentityEmailMatches(nextEmail))
          .limit(2);
        if (conflicts.some((conflict) => conflict.id !== current.user.id)) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '该用户名已被其他管理员使用',
            HttpStatus.CONFLICT,
          );
        }
      }
      const previousUsername = staffAccountUsername(current.user.email);
      const nextUsername = staffAccountUsername(nextEmail);
      const [updatedUser] = await tx
        .update(users)
        .set({
          email: nextEmail,
          name:
            previousUsername && nextUsername && current.user.name === previousUsername
              ? nextUsername
              : current.user.name,
          ...(replacementPasswordHash ? { passwordHash: replacementPasswordHash } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, current.user.id))
        .returning();
      const identityChanged =
        normalizeStaffAccountEmail(current.user.email) !== normalizeStaffAccountEmail(nextEmail);
      const cancelledInvitations = identityChanged
        ? await tx
            .update(organizationInvitations)
            .set({ status: 'cancelled', updatedAt: new Date() })
            .where(
              and(
                organizationInvitationEmailMatches(current.user.email),
                eq(organizationInvitations.status, 'pending'),
              ),
            )
            .returning({
              id: organizationInvitations.id,
              organizationId: organizationInvitations.organizationId,
            })
        : [];
      const affectedMemberships = await tx
        .select({ id: memberships.id, organizationId: memberships.organizationId })
        .from(memberships)
        .where(eq(memberships.userId, current.user.id))
        .for('update');
      const credentialRevision = crypto.randomUUID();
      const existingPreferences = sql`case
        when jsonb_typeof(${memberProfiles.preferences}) = 'object'
        then ${memberProfiles.preferences}
        else '{}'::jsonb
      end`;
      const existingSecurityPreferences = sql`case
        when jsonb_typeof(${memberProfiles.preferences}->'security') = 'object'
        then ${memberProfiles.preferences}->'security'
        else '{}'::jsonb
      end`;
      await tx
        .insert(memberProfiles)
        .values(
          affectedMemberships.map((affected) => ({
            organizationId: affected.organizationId,
            userId: current.user.id,
            preferences: { security: { staffCredentialVersion: credentialRevision } },
          })),
        )
        .onConflictDoUpdate({
          target: [memberProfiles.organizationId, memberProfiles.userId],
          set: {
            preferences: sql`${existingPreferences} || jsonb_build_object(
              'security',
              ${existingSecurityPreferences} || jsonb_build_object(
                'staffCredentialVersion',
                cast(${credentialRevision} as text)
              )
            )`,
            updatedAt: new Date(),
          },
        });
      await tx.insert(auditLogs).values(
        affectedMemberships.map((affected) => ({
          organizationId: affected.organizationId,
          actorId,
          action: 'organization.administrator.credentials.update',
          resourceType: 'membership',
          resourceId: affected.id,
          before: {
            username: previousUsername,
            email: staffAccountPublicEmail(current.user.email),
          },
          after: {
            username: nextUsername,
            passwordChanged: Boolean(replacementPasswordHash),
            sourceOrganizationId: organizationId,
          },
          traceId: crypto.randomUUID(),
        })),
      );
      await tx.insert(outboxEvents).values(
        affectedMemberships.map((affected) => ({
          organizationId: affected.organizationId,
          eventType: 'OrganizationAdministratorCredentialsUpdated',
          correlationId: `organization-administrator-credentials:${affected.id}:${crypto.randomUUID()}`,
          payload: {
            membershipId: affected.id,
            userId: current.user.id,
            username: nextUsername,
            passwordChanged: Boolean(replacementPasswordHash),
            sourceOrganizationId: organizationId,
          },
        })),
      );
      if (cancelledInvitations.length) {
        await tx.insert(auditLogs).values(
          cancelledInvitations.map((invitation) => ({
            organizationId: invitation.organizationId,
            actorId,
            action: 'organization.invitation.cancel',
            resourceType: 'organization_invitation',
            resourceId: invitation.id,
            before: { status: 'pending', email: current.user.email },
            after: {
              status: 'cancelled',
              reason: 'staff_identity_changed',
              sourceOrganizationId: organizationId,
            },
            traceId: crypto.randomUUID(),
          })),
        );
      }
      const [profile] = await tx
        .select()
        .from(memberProfiles)
        .where(
          and(
            eq(memberProfiles.organizationId, organizationId),
            eq(memberProfiles.userId, current.user.id),
          ),
        )
        .limit(1);
      const [publicIdRow] = await tx
        .select({ publicId: publicUserIds.publicId })
        .from(publicUserIds)
        .where(
          and(
            eq(publicUserIds.subjectType, 'staff'),
            eq(publicUserIds.subjectUuid, current.user.id),
            isNull(publicUserIds.retiredAt),
          ),
        )
        .limit(1);
      if (!publicIdRow) throw new Error('管理员缺少数字用户 ID');
      return this.memberFromRows(
        current.membership,
        updatedUser!,
        profile ?? null,
        publicIdRow.publicId,
      );
    });
  }

  async createInvitation(
    organizationId: string,
    actorId: string,
    input: CreateOrganizationInvitation,
  ): Promise<CreateOrganizationInvitationResult> {
    if (!validatesGrants(input.grants)) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '权限标识格式不正确',
        HttpStatus.BAD_REQUEST,
      );
    }
    const email = input.email.trim().toLowerCase();
    const acceptanceToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60_000);
    const invitation = await this.db().transaction(async (tx) => {
      const [actorSnapshot] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, actorId)))
        .limit(1);
      const lockKeys = [
        staffIdentityEmailLockKey(email),
        ...(actorSnapshot ? [staffMembershipLockKey(actorSnapshot.id)] : []),
      ].sort();
      for (const lockKey of lockKeys) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`organization-invitation:${organizationId}:${email}`}, 0))`,
      );
      const [actor] = await tx
        .select({
          membership: memberships,
          user: users,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.userId, actorId),
            eq(memberships.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      if (!actor) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '组织成员身份已失效',
          HttpStatus.UNAUTHORIZED,
        );
      }
      assertCanDelegate(actor.membership, input.role, input.grants);
      if (input.role === 'organization_admin') {
        assertConfiguredSuperAdministrator(actor.user, actor.membership);
      }
      const [existingMember] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(eq(memberships.organizationId, organizationId), staffIdentityEmailMatches(email)),
        )
        .limit(1);
      if (existingMember) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该邮箱已经是组织成员',
          HttpStatus.CONFLICT,
        );
      }
      await tx
        .update(organizationInvitations)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(
          and(
            eq(organizationInvitations.organizationId, organizationId),
            organizationInvitationEmailMatches(email),
            eq(organizationInvitations.status, 'pending'),
          ),
        );
      const [created] = await tx
        .insert(organizationInvitations)
        .values({
          organizationId,
          email,
          role: input.role,
          grants: input.grants,
          tokenHash: this.tokenHash(acceptanceToken),
          invitedBy: actorId,
          expiresAt,
        })
        .returning();
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'organization.invitation.create',
        resourceType: 'organization_invitation',
        resourceId: created!.id,
        after: {
          email,
          role: input.role,
          grants: input.grants,
          expiresAt: expiresAt.toISOString(),
        },
        traceId: crypto.randomUUID(),
      });
      await tx.insert(outboxEvents).values({
        organizationId,
        eventType: 'OrganizationInvitationCreated',
        correlationId: `organization-invitation:${created!.id}`,
        payload: {
          invitationId: created!.id,
          email,
          expiresAt: expiresAt.toISOString(),
          delivery: 'admin_copy_link',
        },
      });
      return created!;
    });
    return {
      invitation: this.invitationFromRow(invitation),
      acceptanceToken,
    };
  }

  async cancelInvitation(organizationId: string, invitationId: string, actorId: string) {
    return this.db().transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.id, invitationId),
            eq(organizationInvitations.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!candidate) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '待接受邀请不存在或已经结束',
          HttpStatus.NOT_FOUND,
        );
      }
      const [actorSnapshot] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, actorId)))
        .limit(1);
      const lockKeys = [
        staffIdentityEmailLockKey(candidate.email),
        ...(actorSnapshot ? [staffMembershipLockKey(actorSnapshot.id)] : []),
      ].sort();
      for (const lockKey of lockKeys) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      }
      const [invitation] = await tx
        .select()
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.id, invitationId),
            eq(organizationInvitations.organizationId, organizationId),
            eq(organizationInvitations.status, 'pending'),
          ),
        )
        .for('update')
        .limit(1);
      if (!invitation) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '待接受邀请不存在或已经结束',
          HttpStatus.NOT_FOUND,
        );
      }
      if (invitation.role === 'organization_admin') {
        const [actor] = await tx
          .select({ membership: memberships, user: users })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.organizationId, organizationId),
              eq(memberships.userId, actorId),
              eq(memberships.status, 'active'),
            ),
          )
          .for('update')
          .limit(1);
        if (!actor) {
          throw new DomainError(
            API_ERROR_CODES.UNAUTHORIZED,
            '组织成员身份已失效',
            HttpStatus.UNAUTHORIZED,
          );
        }
        assertConfiguredSuperAdministrator(actor.user, actor.membership);
      }
      await tx
        .update(organizationInvitations)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(organizationInvitations.id, invitationId));
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'organization.invitation.cancel',
        resourceType: 'organization_invitation',
        resourceId: invitationId,
        before: { status: 'pending' },
        after: { status: 'cancelled' },
        traceId: crypto.randomUUID(),
      });
      return { cancelled: true };
    });
  }

  async acceptInvitation(input: AcceptOrganizationInvitation): Promise<OrganizationMember> {
    const db = this.db();
    return db.transaction(async (tx) => {
      const tokenHash = this.tokenHash(input.token);
      const [candidate] = await tx
        .select()
        .from(organizationInvitations)
        .where(eq(organizationInvitations.tokenHash, tokenHash))
        .limit(1);
      if (!candidate) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '邀请链接无效或已经过期',
          HttpStatus.CONFLICT,
        );
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${staffIdentityEmailLockKey(candidate.email)}, 0))`,
      );
      const [invitation] = await tx
        .select()
        .from(organizationInvitations)
        .where(eq(organizationInvitations.tokenHash, tokenHash))
        .for('update')
        .limit(1);
      if (!invitation || invitation.status !== 'pending' || invitation.expiresAt <= new Date()) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '邀请链接无效或已经过期',
          HttpStatus.CONFLICT,
        );
      }
      const existingUsers = await tx
        .select()
        .from(users)
        .where(staffIdentityEmailMatches(invitation.email))
        .limit(2);
      if (existingUsers.length > 1) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该邮箱关联了多个历史账号，请先联系管理员合并重复账号',
          HttpStatus.CONFLICT,
        );
      }
      const [existingUser] = existingUsers;
      let user = existingUser;
      if (existingUser) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${staffIdentityUserLockKey(existingUser.id)}, 0))`,
        );
        if (
          !existingUser.passwordHash ||
          !(await compare(input.password, existingUser.passwordHash))
        ) {
          throw new DomainError(
            API_ERROR_CODES.UNAUTHORIZED,
            '该邮箱已有账号，请输入现有账号密码',
            HttpStatus.UNAUTHORIZED,
          );
        }
      } else {
        [user] = await tx
          .insert(users)
          .values({
            email: invitation.email,
            name: input.name,
            passwordHash: await hash(input.password, 12),
          })
          .returning();
      }
      const [existingMembership] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, invitation.organizationId),
            eq(memberships.userId, user!.id),
          ),
        )
        .limit(1);
      if (existingMembership) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '该账号已经加入组织',
          HttpStatus.CONFLICT,
        );
      }
      const [membership] = await tx
        .insert(memberships)
        .values({
          organizationId: invitation.organizationId,
          userId: user!.id,
          role: invitation.role,
          grants: invitation.grants,
          status: 'active',
        })
        .returning();
      const [accepted] = await tx
        .update(organizationInvitations)
        .set({ status: 'accepted', acceptedAt: new Date(), updatedAt: new Date() })
        .where(eq(organizationInvitations.id, invitation.id))
        .returning();
      await tx.insert(auditLogs).values({
        organizationId: invitation.organizationId,
        actorId: user!.id,
        action: 'organization.invitation.accept',
        resourceType: 'organization_invitation',
        resourceId: invitation.id,
        before: { status: invitation.status },
        after: { status: accepted!.status, membershipId: membership!.id },
        traceId: crypto.randomUUID(),
      });
      await tx.insert(outboxEvents).values({
        organizationId: invitation.organizationId,
        eventType: 'OrganizationInvitationAccepted',
        correlationId: `organization-invitation:accepted:${invitation.id}`,
        payload: {
          invitationId: invitation.id,
          membershipId: membership!.id,
          userId: user!.id,
        },
      });
      const [publicIdRow] = await tx
        .select({ publicId: publicUserIds.publicId })
        .from(publicUserIds)
        .where(
          and(
            eq(publicUserIds.subjectType, 'staff'),
            eq(publicUserIds.subjectUuid, user!.id),
            isNull(publicUserIds.retiredAt),
          ),
        )
        .limit(1);
      if (!publicIdRow) throw new Error('新成员缺少数字用户 ID');
      return this.memberFromRows(membership!, user!, null, publicIdRow.publicId);
    });
  }

  async getSettings(organizationId: string): Promise<OrganizationSettingsResult> {
    const [organization] = await this.db()
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!organization) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        '组织不存在或无权访问',
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      settings: normalizeOrganizationSettings(organization.name, organization.settings),
    };
  }

  async updateSettings(
    organizationId: string,
    actorId: string,
    input: UpdateOrganizationSettings,
  ): Promise<OrganizationSettingsResult> {
    const db = this.db();
    const row = await db.transaction(async (tx) => {
      const [organization] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for('update')
        .limit(1);
      if (!organization) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '组织不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      if (input.settings?.defaultBlueprintId) {
        const [blueprint] = await tx
          .select({ id: eventBlueprints.id })
          .from(eventBlueprints)
          .where(
            and(
              eq(eventBlueprints.id, input.settings.defaultBlueprintId),
              eq(eventBlueprints.organizationId, organizationId),
            ),
          )
          .limit(1);
        if (!blueprint) {
          throw new DomainError(
            API_ERROR_CODES.NOT_FOUND,
            '默认大会蓝图不存在或无权访问',
            HttpStatus.NOT_FOUND,
          );
        }
      }
      const before = normalizeOrganizationSettings(organization.name, organization.settings);
      const settingsPatch = Object.fromEntries(
        Object.entries(input.settings ?? {}).filter(([, value]) => value !== undefined),
      ) as Partial<OrganizationSettings>;
      const settings: OrganizationSettings = {
        ...before,
        ...settingsPatch,
        defaultCurrency: 'CNY',
      };
      const [updated] = await tx
        .update(organizations)
        .set({
          ...(input.name ? { name: input.name } : {}),
          settings: { ...organization.settings, ...settings },
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, organizationId))
        .returning();
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'organization.settings.update',
        resourceType: 'organization',
        resourceId: organizationId,
        before: { name: organization.name, settings: before },
        after: { name: updated!.name, settings },
        traceId: crypto.randomUUID(),
      });
      return updated!;
    });
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      settings: normalizeOrganizationSettings(row.name, row.settings),
    };
  }

  async setHomepageEvent(
    organizationId: string,
    actorId: string,
    eventId: EventId,
  ): Promise<OrganizationHomepageEvent> {
    return this.db().transaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for('update')
        .limit(1);
      if (!organization) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '组织不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }

      const [event] = await tx
        .select({
          id: events.id,
          slug: events.slug,
          name: events.name,
          status: events.status,
          settings: events.settings,
        })
        .from(events)
        .where(and(eq(events.id, eventId), eq(events.organizationId, organizationId)))
        .for('update')
        .limit(1);
      if (!event) {
        throw new DomainError(
          API_ERROR_CODES.NOT_FOUND,
          '大会不存在或无权访问',
          HttpStatus.NOT_FOUND,
        );
      }
      const currentReleaseId = (event.settings as { currentReleaseId?: string }).currentReleaseId;
      if (!isPublicEventStatus(event.status) || !currentReleaseId) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '只有已发布且前台可访问的大会可以设为首页',
          HttpStatus.CONFLICT,
        );
      }
      const [release] = await tx
        .select({ id: eventReleases.id })
        .from(eventReleases)
        .where(and(eq(eventReleases.id, currentReleaseId), eq(eventReleases.eventId, event.id)))
        .limit(1);
      if (!release) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '大会当前发布版本不可用，请重新发布后再设为首页',
          HttpStatus.CONFLICT,
        );
      }

      const [current] = await tx
        .select()
        .from(organizationHomepageEvents)
        .where(eq(organizationHomepageEvents.organizationId, organizationId))
        .limit(1);
      if (current?.eventId === event.id) {
        return {
          organizationId,
          eventId: event.id,
          slug: event.slug,
          name: event.name,
          updatedAt: current.updatedAt.toISOString(),
        };
      }

      const now = new Date();
      const [updated] = await tx
        .insert(organizationHomepageEvents)
        .values({ organizationId, eventId: event.id, updatedBy: actorId, updatedAt: now })
        .onConflictDoUpdate({
          target: organizationHomepageEvents.organizationId,
          set: { eventId: event.id, updatedBy: actorId, updatedAt: now },
        })
        .returning();
      await tx.insert(auditLogs).values({
        organizationId,
        eventId: event.id,
        actorId,
        action: 'organization.homepage_event.update',
        resourceType: 'organization',
        resourceId: organizationId,
        before: { eventId: current?.eventId ?? null },
        after: { eventId: event.id, slug: event.slug },
        traceId: crypto.randomUUID(),
      });
      return {
        organizationId,
        eventId: event.id,
        slug: event.slug,
        name: event.name,
        updatedAt: updated!.updatedAt.toISOString(),
      };
    });
  }

  async getIntegrationStatus(organizationId: string): Promise<IntegrationStatus> {
    const configured = (value: boolean) => ({
      configured: value,
      status: value ? ('configured' as const) : ('unconfigured' as const),
    });
    const [payment] = await this.db()
      .select({ status: organizationIntegrations.status })
      .from(organizationIntegrations)
      .where(
        and(
          eq(organizationIntegrations.organizationId, organizationId),
          eq(organizationIntegrations.provider, 'wechatpay'),
        ),
      )
      .limit(1);
    const [aliyunSms] = await this.db()
      .select({
        status: organizationIntegrations.status,
        config: organizationIntegrations.config,
      })
      .from(organizationIntegrations)
      .where(
        and(
          eq(organizationIntegrations.organizationId, organizationId),
          eq(organizationIntegrations.provider, 'aliyun-sms'),
        ),
      )
      .limit(1);
    const hasPayment = payment?.status === 'verified' || payment?.status === 'configured';
    const smsConfig = aliyunSms ? readAliyunSmsConfiguration(aliyunSms.config) : undefined;
    const hasNotification = Boolean(
      (aliyunSms?.status === 'verified' &&
        smsConfig?.enabled &&
        Object.values(smsConfig.templates).some(
          (template) => template.enabled && template.status === 'verified',
        )) ||
        process.env.NOTIFICATION_WEBHOOK_URL ||
        process.env.SMTP_URL ||
        process.env.RESEND_API_KEY,
    );
    const hasAi = Boolean(process.env.AI_API_KEY || process.env.OPENAI_API_KEY);
    const hasStorage = Boolean(
      process.env.S3_ENDPOINT &&
        process.env.S3_ACCESS_KEY &&
        process.env.S3_SECRET_KEY &&
        process.env.S3_BUCKET,
    );
    return {
      payment: configured(hasPayment),
      notification: configured(hasNotification),
      ai: configured(hasAi),
      objectStorage: configured(hasStorage),
    };
  }

  async getPublicSiteConfiguration(organizationSlug: string): Promise<PublicSiteConfiguration> {
    const [organization] = await this.db()
      .select()
      .from(organizations)
      .where(eq(organizations.slug, organizationSlug))
      .limit(1);
    if (!organization) {
      throw new DomainError(API_ERROR_CODES.NOT_FOUND, '站点不存在', HttpStatus.NOT_FOUND);
    }
    const settings = normalizeOrganizationSettings(organization.name, organization.settings);
    return {
      website: settings.website,
      analytics: settings.analytics,
      customerAccounts: {
        termsUrl: settings.customerAccounts.termsUrl,
        termsVersion: settings.customerAccounts.termsVersion,
        privacyUrl: settings.customerAccounts.privacyUrl,
        privacyVersion: settings.customerAccounts.privacyVersion,
      },
    };
  }
}
