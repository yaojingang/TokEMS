import type { FastifyRequest } from 'fastify';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  API_ERROR_CODES,
  TOKEMS_AGENT_CATALOG_VERSION,
  type AgentApprovalPolicy,
  type AgentScope,
} from '@conference/contracts';
import {
  AGENT_DPOP_REPLAY_TTL_SECONDS,
  agentAccessKeyId,
  decodeAgentAccessSecret,
  resolveAgentAccessFeatures,
  resolveAgentResource,
  verifyDpopProof,
} from '@conference/security';
import { agentConnections, memberProfiles, memberships, users } from '@conference/database';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { RedisService } from './redis.service.js';
import {
  configuredSuperAdministratorId,
  staffCredentialRevision,
  staffCredentialVersion,
} from './staff-account.js';
import type { AuthenticatedUser } from './auth.guard.js';

export interface AgentPrincipal {
  connectionId: string;
  organizationId: string;
  delegatedUserId: string;
  scopes: AgentScope[];
  approvalPolicy: AgentApprovalPolicy;
  dpopThumbprint: string;
  catalogVersion: string;
}

interface AgentAccessClaims {
  sub: string;
  token_use: 'agent';
  client_id: string;
  connection_id: string;
  organization_id: string;
  scopes: AgentScope[];
  credential_version: string;
  membership_version: string;
  cnf: { jkt: string };
  iss: string;
  aud: string;
}

function accessTokenSecrets() {
  const current = decodeAgentAccessSecret(
    process.env.AGENT_ACCESS_TOKEN_SECRET,
    'AGENT_ACCESS_TOKEN_SECRET',
  );
  const previousValue = process.env.AGENT_ACCESS_TOKEN_PREVIOUS_SECRET?.trim();
  const previous = previousValue
    ? decodeAgentAccessSecret(previousValue, 'AGENT_ACCESS_TOKEN_PREVIOUS_SECRET')
    : undefined;
  return { current, previous };
}

@Injectable()
export class AgentPrincipalService {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  private unauthorized(code: string, message: string) {
    return new DomainError(code, message, HttpStatus.UNAUTHORIZED, {
      retryable: false,
      next: 'Reconnect the TokEMS Admin Skill in the administrator browser.',
    });
  }

  async authenticate(
    request: FastifyRequest,
    token: string,
  ): Promise<{ user: AuthenticatedUser; principal: AgentPrincipal }> {
    if (!resolveAgentAccessFeatures().access) {
      throw this.unauthorized(API_ERROR_CODES.AGENT_ACCESS_DISABLED, 'Agent Access is disabled');
    }
    const db = this.database.db;
    if (!db)
      throw this.unauthorized(
        API_ERROR_CODES.AGENT_ACCESS_DISABLED,
        'Agent Access requires PostgreSQL',
      );
    const decoded = this.jwt.decode(token, { complete: true });
    const kid =
      decoded && typeof decoded === 'object' && 'header' in decoded
        ? String((decoded.header as Record<string, unknown>).kid ?? '')
        : '';
    const secrets = accessTokenSecrets();
    const key =
      agentAccessKeyId(secrets.current) === kid
        ? secrets.current
        : secrets.previous && agentAccessKeyId(secrets.previous) === kid
          ? secrets.previous
          : undefined;
    if (!key)
      throw this.unauthorized(API_ERROR_CODES.UNAUTHORIZED, 'Agent access token key is unknown');
    let claims: AgentAccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AgentAccessClaims>(token, {
        secret: key,
        algorithms: ['HS256'],
        issuer: new URL(resolveAgentResource()).origin,
        audience: resolveAgentResource(),
      });
    } catch {
      throw this.unauthorized(
        API_ERROR_CODES.UNAUTHORIZED,
        'Agent access token is invalid or expired',
      );
    }
    if (claims.token_use !== 'agent' || claims.cnf?.jkt === undefined) {
      throw this.unauthorized(API_ERROR_CODES.UNAUTHORIZED, 'Agent access token type is invalid');
    }
    const proofHeader = request.headers.dpop;
    const proof = Array.isArray(proofHeader) ? proofHeader[0] : proofHeader;
    if (!proof) throw this.unauthorized(API_ERROR_CODES.UNAUTHORIZED, 'DPoP proof is required');
    const path = String(request.url).split('?')[0] ?? '/';
    let verifiedProof;
    try {
      verifiedProof = verifyDpopProof({
        proof,
        method: request.method,
        url: `${new URL(resolveAgentResource()).origin}${path}`,
        accessToken: token,
      });
    } catch (error) {
      throw this.unauthorized(
        API_ERROR_CODES.UNAUTHORIZED,
        error instanceof Error ? error.message : 'DPoP proof is invalid',
      );
    }
    if (verifiedProof.jkt !== claims.cnf.jkt) {
      throw this.unauthorized(API_ERROR_CODES.UNAUTHORIZED, 'DPoP key does not match the token');
    }
    const replayAccepted = await this.redis
      .getClient()
      .set(
        `tokems:agent:dpop:${verifiedProof.jkt}:${verifiedProof.jti}`,
        '1',
        'EX',
        AGENT_DPOP_REPLAY_TTL_SECONDS,
        'NX',
      );
    if (replayAccepted !== 'OK') {
      throw this.unauthorized(
        API_ERROR_CODES.AGENT_DPOP_REPLAY,
        'DPoP proof has already been used',
      );
    }

    const [row] = await db
      .select({
        connection: agentConnections,
        membership: memberships,
        user: users,
        preferences: memberProfiles.preferences,
      })
      .from(agentConnections)
      .innerJoin(memberships, eq(memberships.id, agentConnections.membershipId))
      .innerJoin(users, eq(users.id, agentConnections.delegatedUserId))
      .leftJoin(
        memberProfiles,
        and(
          eq(memberProfiles.organizationId, memberships.organizationId),
          eq(memberProfiles.userId, memberships.userId),
        ),
      )
      .where(
        and(
          eq(agentConnections.id, claims.connection_id),
          eq(agentConnections.organizationId, claims.organization_id),
        ),
      )
      .limit(1);
    const catalogMismatch = Boolean(
      row && row.connection.catalogVersion !== TOKEMS_AGENT_CATALOG_VERSION,
    );
    if (
      !row ||
      row.connection.status !== 'active' ||
      row.connection.expiresAt.getTime() <= Date.now() ||
      row.membership.status !== 'active' ||
      row.membership.organizationId !== row.connection.organizationId ||
      row.membership.userId !== row.connection.delegatedUserId ||
      row.connection.delegatedUserId !== configuredSuperAdministratorId() ||
      row.connection.dpopThumbprint !== verifiedProof.jkt ||
      row.connection.catalogVersion !== TOKEMS_AGENT_CATALOG_VERSION
    ) {
      throw this.unauthorized(
        catalogMismatch
          ? API_ERROR_CODES.AGENT_VERSION_UNSUPPORTED
          : API_ERROR_CODES.AGENT_CONNECTION_REVOKED,
        catalogMismatch
          ? 'Agent catalog version changed; reconnect with the current Skill'
          : 'Agent connection is revoked or expired',
      );
    }
    const credentialVersion = staffCredentialVersion(
      row.user,
      staffCredentialRevision(row.preferences),
    );
    const membershipVersion = row.membership.updatedAt.toISOString();
    if (
      credentialVersion !== claims.credential_version ||
      membershipVersion !== claims.membership_version ||
      credentialVersion !== row.connection.delegatedCredentialVersion ||
      membershipVersion !== row.connection.delegatedMembershipVersion
    ) {
      throw this.unauthorized(
        API_ERROR_CODES.AGENT_CONNECTION_REVOKED,
        'Delegated administrator credentials changed',
      );
    }
    const effectiveScopes = row.connection.scopes.filter((scope) => claims.scopes.includes(scope));
    await db
      .update(agentConnections)
      .set({ lastUsedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentConnections.id, row.connection.id));
    return {
      user: {
        sub: row.user.id,
        email: row.user.email,
        name: row.user.name,
        role: row.membership.role,
        organizationId: row.membership.organizationId,
        grants: row.membership.grants,
        credentialVersion,
        membershipId: row.membership.id,
        membershipVersion,
      },
      principal: {
        connectionId: row.connection.id,
        organizationId: row.connection.organizationId,
        delegatedUserId: row.connection.delegatedUserId,
        scopes: effectiveScopes,
        approvalPolicy: row.connection.approvalPolicy,
        dpopThumbprint: row.connection.dpopThumbprint,
        catalogVersion: row.connection.catalogVersion,
      },
    };
  }
}
