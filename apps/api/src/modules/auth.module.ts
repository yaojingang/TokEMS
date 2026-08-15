import { compare } from 'bcryptjs';
import { HttpStatus, Inject, Injectable, Module } from '@nestjs/common';
import { Body, Controller, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AcceptOrganizationInvitationSchema,
  API_ERROR_CODES,
  DEMO_IDS,
  LoginSchema,
  UpdateAccountProfileSchema,
  UpdateAdminPreferencesSchema,
  type LoginResult,
  type OrganizationRole,
} from '@conference/contracts';
import {
  memberProfiles,
  memberships,
  organizations,
  publicUserIds,
  users,
} from '@conference/database';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AuthGuard, type AuthenticatedUser } from '../common/auth.guard.js';
import { adminLoginThrottleLimit } from '../common/auth-throttle.js';
import { DatabaseService } from '../common/database.service.js';
import { DomainError } from '../common/domain-error.js';
import { OrganizationAdminService } from '../common/organization-admin.service.js';
import {
  configuredSuperAdministratorId,
  normalizeStaffAccountEmail,
  staffAccountEmail,
  staffAccountPublicEmail,
  staffAccountUsername,
  staffCredentialRevision,
  staffCredentialVersion,
} from '../common/staff-account.js';

@Injectable()
export class AuthService {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async login(payload: unknown): Promise<LoginResult> {
    const parsed = LoginSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '请输入用户名和密码',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }

    const db = this.database.db;
    let identity: {
      uuid: string;
      publicId: number;
      email: string;
      username: string | null;
      name: string;
      role: OrganizationRole;
      organizationId: string;
      grants: string[];
      credentialVersion?: string;
      membershipId?: string;
      membershipVersion?: string;
    } = {
      uuid: configuredSuperAdministratorId(),
      publicId: 101,
      email: normalizeStaffAccountEmail(process.env.ADMIN_EMAIL ?? 'admin@tokems.local'),
      username: process.env.ADMIN_USERNAME ?? 'admin',
      name: '组织管理员',
      role: 'organization_admin',
      organizationId: DEMO_IDS.organization,
      grants: ['*'],
    };
    const adminUsername = (process.env.ADMIN_USERNAME ?? 'admin').trim().toLowerCase();
    const submittedUsername = parsed.data.username.trim().toLowerCase();
    const lookupEmail = submittedUsername.includes('@')
      ? submittedUsername
      : staffAccountEmail(submittedUsername);
    let valid =
      process.env.NODE_ENV !== 'production' &&
      (submittedUsername === adminUsername || submittedUsername === identity.email.toLowerCase()) &&
      parsed.data.password === (process.env.ADMIN_PASSWORD ?? 'admin');

    if (db) {
      const findUserRow = async (email: string) => {
        const rows = await db
          .select({ user: users, publicId: publicUserIds.publicId })
          .from(users)
          .innerJoin(
            publicUserIds,
            and(
              eq(publicUserIds.subjectType, 'staff'),
              eq(publicUserIds.subjectUuid, users.id),
              isNull(publicUserIds.retiredAt),
            ),
          )
          .where(sql`lower(${users.email}) = ${normalizeStaffAccountEmail(email)}`)
          .limit(2);
        return rows.length === 1 ? rows[0] : undefined;
      };
      let userRow = await findUserRow(lookupEmail);
      if (!userRow && submittedUsername === adminUsername && lookupEmail !== identity.email) {
        userRow = await findUserRow(identity.email);
      }
      const user = userRow?.user;
      if (user?.passwordHash) {
        const [membership] = await db
          .select({
            id: memberships.id,
            organizationId: memberships.organizationId,
            role: memberships.role,
            grants: memberships.grants,
            status: memberships.status,
            updatedAt: memberships.updatedAt,
            preferences: memberProfiles.preferences,
          })
          .from(memberships)
          .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
          .leftJoin(
            memberProfiles,
            and(
              eq(memberProfiles.organizationId, memberships.organizationId),
              eq(memberProfiles.userId, memberships.userId),
            ),
          )
          .where(
            and(
              eq(memberships.userId, user.id),
              parsed.data.organizationSlug
                ? eq(organizations.slug, parsed.data.organizationSlug)
                : undefined,
              eq(memberships.status, 'active'),
            ),
          )
          .orderBy(asc(memberships.createdAt))
          .limit(1);
        const passwordValid = await compare(parsed.data.password, user.passwordHash);
        valid = Boolean(membership) && passwordValid;
        if (membership) {
          identity = {
            uuid: user.id,
            publicId: userRow!.publicId,
            email: user.email,
            username: staffAccountUsername(user.email),
            name: user.name,
            role: membership.role,
            organizationId: membership.organizationId,
            grants: membership.grants,
            credentialVersion: staffCredentialVersion(
              user,
              staffCredentialRevision(membership.preferences),
            ),
            membershipId: membership.id,
            membershipVersion: membership.updatedAt.toISOString(),
          };
        }
      } else {
        valid = false;
      }
    }

    if (!valid) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '用户名或密码不正确',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const accessToken = await this.jwt.signAsync({
      sub: identity.uuid,
      email: identity.email,
      username: identity.username,
      name: identity.name,
      role: identity.role,
      organizationId: identity.organizationId,
      grants: identity.grants,
      credentialVersion: identity.credentialVersion,
      membershipId: identity.membershipId,
      membershipVersion: identity.membershipVersion,
    });
    return {
      accessToken,
      user: {
        id: identity.publicId,
        email: staffAccountPublicEmail(identity.email),
        username: identity.username,
        name: identity.name,
        role: identity.role,
      },
    };
  }
}

@ApiTags('auth')
@Controller('auth')
class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(OrganizationAdminService)
    private readonly organizationAdmin: OrganizationAdminService,
  ) {}

  @Post('login')
  @Throttle({ default: { limit: adminLoginThrottleLimit(process.env), ttl: 60_000 } })
  login(@Body() body: unknown) {
    return this.auth.login(body);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() request: FastifyRequest & { user: AuthenticatedUser }) {
    return this.organizationAdmin.getCurrentIdentity(
      request.user.organizationId,
      request.user.sub,
      {
        email: request.user.email,
        name: request.user.name,
        role: request.user.role,
        grants: request.user.grants,
      },
    );
  }

  @Get('profile')
  @UseGuards(AuthGuard)
  profile(@Req() request: FastifyRequest & { user: AuthenticatedUser }) {
    return this.organizationAdmin.getAccountProfile(request.user.organizationId, request.user.sub, {
      email: request.user.email,
      name: request.user.name,
      role: request.user.role,
      grants: request.user.grants,
    });
  }

  @Patch('profile')
  @UseGuards(AuthGuard)
  updateProfile(
    @Body() body: unknown,
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
  ) {
    const parsed = UpdateAccountProfileSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '个人资料校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.organizationAdmin.updateAccountProfile(
      request.user.organizationId,
      request.user.sub,
      parsed.data,
    );
  }

  @Patch('preferences/admin')
  @UseGuards(AuthGuard)
  updateAdminPreferences(
    @Body() body: unknown,
    @Req() request: FastifyRequest & { user: AuthenticatedUser },
  ) {
    const parsed = UpdateAdminPreferencesSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '管理员偏好校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.organizationAdmin.updateAdminPreferences(
      request.user.organizationId,
      request.user.sub,
      parsed.data,
      request.user.grants,
    );
  }

  @Post('invitations/accept')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  acceptInvitation(@Body() body: unknown) {
    const parsed = AcceptOrganizationInvitationSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '邀请接受信息校验失败',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    return this.organizationAdmin.acceptInvitation(parsed.data);
  }
}

@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
