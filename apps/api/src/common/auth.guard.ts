import type { FastifyRequest } from 'fastify';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { OrganizationRole } from '@conference/contracts';
import { memberProfiles, memberships, users } from '@conference/database';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { staffCredentialRevision, staffCredentialVersion } from './staff-account.js';

const REQUIRED_GRANTS = 'conference.required_grants';
const REQUIRED_ALL_GRANTS = 'conference.required_all_grants';

export const RequireGrant = (...grants: string[]) => SetMetadata(REQUIRED_GRANTS, grants);
export const RequireAllGrants = (...grants: string[]) => SetMetadata(REQUIRED_ALL_GRANTS, grants);

export interface AuthenticatedUser {
  sub: string;
  email: string;
  username?: string | null;
  name: string;
  role: OrganizationRole;
  organizationId: string;
  grants: string[];
  credentialVersion?: string;
  membershipId?: string;
  membershipVersion?: string;
}

export function grantAllows(grants: string[], required: string) {
  return grants.some(
    (grant) =>
      grant === '*' ||
      grant === required ||
      (grant.endsWith('.*') && required.startsWith(`${grant.slice(0, -2)}.`)),
  );
}

export function grantsAllowAll(grants: string[], required: string[]) {
  return required.every((grant) => grantAllows(grants, grant));
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private allows(grants: string[], required: string) {
    return grantAllows(grants, required);
  }

  async canActivate(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;

    if (!token) {
      throw new UnauthorizedException('请先登录运营后台');
    }

    let claims: AuthenticatedUser;
    try {
      claims = await this.jwt.verifyAsync<AuthenticatedUser>(token);
    } catch {
      throw new UnauthorizedException('登录状态已失效，请重新登录');
    }
    let user: AuthenticatedUser = { ...claims, grants: claims.grants ?? [] };
    if (this.database.db) {
      if (!claims.membershipId || !claims.membershipVersion) {
        throw new UnauthorizedException('登录状态已失效，请重新登录');
      }
      const [membership] = await this.database.db
        .select({
          id: memberships.id,
          role: memberships.role,
          grants: memberships.grants,
          status: memberships.status,
          updatedAt: memberships.updatedAt,
          email: users.email,
          passwordHash: users.passwordHash,
          preferences: memberProfiles.preferences,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .leftJoin(
          memberProfiles,
          and(
            eq(memberProfiles.organizationId, memberships.organizationId),
            eq(memberProfiles.userId, memberships.userId),
          ),
        )
        .where(
          and(
            eq(memberships.id, claims.membershipId),
            eq(memberships.userId, claims.sub),
            eq(memberships.organizationId, claims.organizationId),
            eq(memberships.status, 'active'),
          ),
        )
        .limit(1);
      if (!membership) throw new UnauthorizedException('组织成员身份已失效');
      if (
        !claims.credentialVersion ||
        claims.credentialVersion !==
          staffCredentialVersion(membership, staffCredentialRevision(membership.preferences)) ||
        claims.membershipVersion !== membership.updatedAt.toISOString()
      ) {
        throw new UnauthorizedException('登录凭据已更新，请重新登录');
      }
      user = { ...claims, role: membership.role, grants: membership.grants };
    }
    const required =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_GRANTS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const requiredAll =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_ALL_GRANTS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (required.length && !required.some((grant) => this.allows(user.grants, grant))) {
      throw new ForbiddenException('当前角色缺少执行此操作所需的权限');
    }
    if (requiredAll.length && !grantsAllowAll(user.grants, requiredAll)) {
      throw new ForbiddenException('当前角色缺少执行此组合操作所需的全部权限');
    }
    request.user = user;
    return true;
  }
}
