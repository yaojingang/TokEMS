import { compare } from 'bcryptjs';
import { createHmac, randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  AGENT_SCOPES,
  API_ERROR_CODES,
  AgentAuthorizationDecisionSchema,
  AgentDeviceAuthorizationRequestSchema,
  AgentRefreshTokenRequestSchema,
  AgentStepUpRequestSchema,
  TOKEMS_AGENT_CATALOG_VERSION,
  TOKEMS_AGENT_CLIENT_ID,
  TOKEMS_AGENT_MIN_CLIENT_VERSION,
  type AgentScope,
} from '@conference/contracts';
import {
  AGENT_ACCESS_TOKEN_TTL_SECONDS,
  AGENT_CONNECTION_TTL_SECONDS,
  AGENT_DEVICE_CODE_TTL_SECONDS,
  AGENT_DPOP_REPLAY_TTL_SECONDS,
  AGENT_REFRESH_TOKEN_TTL_SECONDS,
  AGENT_STEP_UP_TTL_SECONDS,
  agentAccessKeyId,
  decodeAgentAccessSecret,
  openSecret,
  resolveAgentAccessFeatures,
  resolveAgentResource,
  sha256,
  sealSecret,
  stableCanonicalJson,
  verifyDpopProof,
} from '@conference/security';
import {
  agentConnections,
  agentDeviceAuthorizations,
  agentOperations,
  agentRefreshTokens,
  auditLogs,
  memberProfiles,
  memberships,
  users,
} from '@conference/database';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { RedisService } from './redis.service.js';
import {
  configuredSuperAdministratorId,
  staffCredentialRevision,
  staffCredentialVersion,
} from './staff-account.js';
import type { AuthenticatedUser } from './auth.guard.js';

const DEVICE_POLL_INTERVAL_SECONDS = 5;

function oauthError(code: string, message: string, status = HttpStatus.BAD_REQUEST) {
  return new DomainError(code, message, status, { error: code, retryable: code === 'slow_down' });
}

function expiry(seconds: number) {
  return new Date(Date.now() + seconds * 1000);
}

function opaqueToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function displayUserCode() {
  const alphabet = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
  const bytes = randomBytes(8);
  const value = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function requestedScopes(scope: string) {
  const values = scope.trim().split(/\s+/u).filter(Boolean);
  const expanded = values.includes('tokems:*') ? [...AGENT_SCOPES] : values;
  return [...new Set(expanded)] as AgentScope[];
}

function versionParts(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/u.exec(version);
  return match ? { parts: match.slice(1, 4).map(Number), suffix: match[4] ?? '' } : undefined;
}

export function agentVersionAtLeast(version: string, minimum: string) {
  const actual = versionParts(version);
  const required = versionParts(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < required.parts.length; index += 1) {
    if (actual.parts[index]! > required.parts[index]!) return true;
    if (actual.parts[index]! < required.parts[index]!) return false;
  }
  return !actual.suffix.startsWith('-') || required.suffix.startsWith('-');
}

export function agentApprovalRequestHash(value: unknown) {
  return sha256(stableCanonicalJson(value));
}

interface StepUpClaims {
  token_use: 'human-step-up';
  sub: string;
  organization_id: string;
  purpose: string;
  target_id: string;
  request_hash: string;
  jti: string;
}

@Injectable()
export class AgentAuthorizationService {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  private db() {
    if (!resolveAgentAccessFeatures().access) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_ACCESS_DISABLED,
        'Agent Access is disabled',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_ACCESS_DISABLED,
        'Agent Access requires PostgreSQL',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  assertGovernanceActor(actor: AuthenticatedUser) {
    if (actor.sub !== configuredSuperAdministratorId() || !actor.membershipId) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        'Only the configured super administrator can govern Agent access',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private hmacUserCode(code: string) {
    const secret = decodeAgentAccessSecret(
      process.env.AGENT_ACCESS_TOKEN_SECRET,
      'AGENT_ACCESS_TOKEN_SECRET',
    );
    return createHmac('sha256', secret)
      .update(`tokems-device-user-code:${code.replace(/-/gu, '').toUpperCase()}`)
      .digest('hex');
  }

  private refreshReplaySecrets() {
    const current = process.env.AGENT_ACCESS_TOKEN_SECRET?.trim();
    if (!current) {
      decodeAgentAccessSecret(current, 'AGENT_ACCESS_TOKEN_SECRET');
    }
    const previous = process.env.AGENT_ACCESS_TOKEN_PREVIOUS_SECRET?.trim();
    return previous ? [current!, previous] : [current!];
  }

  private openRefreshReplay(ciphertext: string) {
    for (const secret of this.refreshReplaySecrets()) {
      try {
        return openSecret(ciphertext, secret);
      } catch {
        // Continue through the configured key-rotation window.
      }
    }
    return undefined;
  }

  async createDeviceAuthorization(payload: unknown) {
    const parsed = AgentDeviceAuthorizationRequestSchema.safeParse(payload);
    if (!parsed.success)
      throw oauthError('invalid_request', 'Device authorization request is invalid');
    const resource = resolveAgentResource();
    if (parsed.data.resource !== resource)
      throw oauthError('invalid_target', 'OAuth resource does not match this TokEMS instance');
    const scopes = requestedScopes(parsed.data.scope);
    if (!scopes.length || scopes.some((scope) => !AGENT_SCOPES.includes(scope))) {
      throw oauthError('invalid_scope', 'Requested TokEMS Agent scope is invalid');
    }
    if (!agentVersionAtLeast(parsed.data.skill_version, TOKEMS_AGENT_MIN_CLIENT_VERSION)) {
      throw oauthError(
        'invalid_client',
        `TokEMS Admin Skill ${TOKEMS_AGENT_MIN_CLIENT_VERSION} or newer is required`,
      );
    }
    const db = this.db();
    const deviceCode = opaqueToken();
    const userCode = displayUserCode();
    await db.insert(agentDeviceAuthorizations).values({
      deviceCodeHash: sha256(deviceCode),
      userCodeHmac: this.hmacUserCode(userCode),
      clientId: TOKEMS_AGENT_CLIENT_ID,
      clientName: parsed.data.client_name,
      skillVersion: parsed.data.skill_version,
      resource,
      requestedScopes: scopes,
      dpopThumbprint: parsed.data.dpop_jkt,
      pollingIntervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
      expiresAt: expiry(AGENT_DEVICE_CODE_TTL_SECONDS),
    });
    const adminOrigin = process.env.ADMIN_ORIGIN ?? new URL(resource).origin;
    const verificationUri = `${adminOrigin.replace(/\/+$/u, '')}/agent-authorizations`;
    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
      expires_in: AGENT_DEVICE_CODE_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    };
  }

  async stepUp(payload: unknown, actor: AuthenticatedUser) {
    const parsed = AgentStepUpRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Step-up request is invalid',
        HttpStatus.BAD_REQUEST,
      );
    }
    this.assertGovernanceActor(actor);
    const db = this.db();
    const [row] = await db
      .select({ user: users, membership: memberships })
      .from(users)
      .innerJoin(
        memberships,
        and(eq(memberships.userId, users.id), eq(memberships.id, actor.membershipId!)),
      )
      .where(
        and(
          eq(users.id, actor.sub),
          eq(memberships.organizationId, actor.organizationId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    const valid =
      Boolean(row?.user.passwordHash) &&
      (await compare(parsed.data.password, row!.user.passwordHash!));
    if (!valid) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        'Step-up verification failed',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const jti = crypto.randomUUID();
    const claims: StepUpClaims = {
      token_use: 'human-step-up',
      sub: actor.sub,
      organization_id: actor.organizationId,
      purpose: parsed.data.purpose,
      target_id: parsed.data.targetId,
      request_hash: parsed.data.requestHash,
      jti,
    };
    await this.redis
      .getClient()
      .set(`tokems:agent:step-up:${jti}`, 'issued', 'EX', AGENT_STEP_UP_TTL_SECONDS);
    await db.insert(auditLogs).values({
      organizationId: actor.organizationId,
      actorId: actor.sub,
      actorType: 'staff',
      action: 'agent.step-up.issued',
      resourceType: 'agent-governance',
      resourceId: parsed.data.targetId.slice(0, 120),
      after: { purpose: parsed.data.purpose },
      traceId: `agent-step-up:${jti}`,
    });
    return {
      stepUpToken: await this.jwt.signAsync(claims, {
        expiresIn: AGENT_STEP_UP_TTL_SECONDS,
        header: { alg: 'HS256', typ: 'step-up+jwt' },
      }),
      expiresIn: AGENT_STEP_UP_TTL_SECONDS,
    };
  }

  async consumeStepUp(input: {
    token: string;
    actor: AuthenticatedUser;
    purpose: StepUpClaims['purpose'];
    targetId: string;
    requestHash: string;
  }) {
    let claims: StepUpClaims;
    try {
      claims = await this.jwt.verifyAsync<StepUpClaims>(input.token);
    } catch {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        'Step-up token is invalid or expired',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (
      claims.token_use !== 'human-step-up' ||
      claims.sub !== input.actor.sub ||
      claims.organization_id !== input.actor.organizationId ||
      claims.purpose !== input.purpose ||
      claims.target_id !== input.targetId ||
      claims.request_hash !== input.requestHash
    ) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        'Step-up token binding does not match',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const state = await this.redis.getClient().getdel(`tokems:agent:step-up:${claims.jti}`);
    if (state !== 'issued') {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        'Step-up token has already been used',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return claims;
  }

  async getAuthorization(id: string, actor: AuthenticatedUser) {
    this.assertGovernanceActor(actor);
    const [row] = await this.db()
      .select({
        id: agentDeviceAuthorizations.id,
        clientId: agentDeviceAuthorizations.clientId,
        clientName: agentDeviceAuthorizations.clientName,
        skillVersion: agentDeviceAuthorizations.skillVersion,
        resource: agentDeviceAuthorizations.resource,
        requestedScopes: agentDeviceAuthorizations.requestedScopes,
        dpopThumbprint: agentDeviceAuthorizations.dpopThumbprint,
        status: agentDeviceAuthorizations.status,
        expiresAt: agentDeviceAuthorizations.expiresAt,
      })
      .from(agentDeviceAuthorizations)
      .where(eq(agentDeviceAuthorizations.id, id))
      .limit(1);
    if (!row)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        'Agent authorization was not found',
        HttpStatus.NOT_FOUND,
      );
    return row;
  }

  async resolveAuthorization(userCode: string, actor: AuthenticatedUser) {
    this.assertGovernanceActor(actor);
    const normalized = userCode.replace(/\s/gu, '').toUpperCase();
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u.test(normalized)) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Device authorization code is invalid',
        HttpStatus.BAD_REQUEST,
      );
    }
    const [row] = await this.db()
      .select({ id: agentDeviceAuthorizations.id })
      .from(agentDeviceAuthorizations)
      .where(
        and(
          eq(agentDeviceAuthorizations.userCodeHmac, this.hmacUserCode(normalized)),
          inArray(agentDeviceAuthorizations.status, ['pending', 'approved']),
          gte(agentDeviceAuthorizations.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        'Device authorization code was not found or has expired',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.getAuthorization(row.id, actor);
  }

  async approveAuthorization(id: string, payload: unknown, actor: AuthenticatedUser) {
    const parsed = AgentAuthorizationDecisionSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Agent authorization decision is invalid',
        HttpStatus.BAD_REQUEST,
      );
    }
    this.assertGovernanceActor(actor);
    const scopes = [...new Set(parsed.data.scopes)].sort();
    const normalizedUserCode = parsed.data.userCode.toUpperCase();
    const expectedRequestHash = agentApprovalRequestHash({
      authorizationId: id,
      scopes,
      approvalPolicy: parsed.data.approvalPolicy,
      userCode: normalizedUserCode,
    });
    if (parsed.data.requestHash !== expectedRequestHash) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent authorization approval summary does not match the submitted decision',
        HttpStatus.CONFLICT,
      );
    }
    const db = this.db();
    const [authorization] = await db
      .select()
      .from(agentDeviceAuthorizations)
      .where(
        and(eq(agentDeviceAuthorizations.id, id), eq(agentDeviceAuthorizations.status, 'pending')),
      )
      .limit(1);
    if (!authorization || authorization.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        'Agent authorization is no longer pending',
        HttpStatus.NOT_FOUND,
      );
    }
    if (scopes.some((scope) => !authorization.requestedScopes.includes(scope))) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        'Approved scopes must be a subset of requested scopes',
        HttpStatus.FORBIDDEN,
      );
    }
    if (authorization.userCodeHmac !== this.hmacUserCode(normalizedUserCode)) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        'Device authorization code does not match this request',
        HttpStatus.FORBIDDEN,
      );
    }
    await this.consumeStepUp({
      token: parsed.data.stepUpToken,
      actor,
      purpose: 'agent-authorization',
      targetId: id,
      requestHash: parsed.data.requestHash,
    });
    const [approved] = await db
      .update(agentDeviceAuthorizations)
      .set({
        organizationId: actor.organizationId,
        membershipId: actor.membershipId,
        approvedBy: actor.sub,
        approvedScopes: scopes,
        approvalPolicy: parsed.data.approvalPolicy,
        status: 'approved',
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(agentDeviceAuthorizations.id, id), eq(agentDeviceAuthorizations.status, 'pending')),
      )
      .returning({ id: agentDeviceAuthorizations.id });
    if (!approved) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent authorization was decided concurrently',
        HttpStatus.CONFLICT,
      );
    }
    await db.insert(auditLogs).values({
      organizationId: actor.organizationId,
      actorId: actor.sub,
      actorType: 'staff',
      action: 'agent.authorization.approved',
      resourceType: 'agent-device-authorization',
      resourceId: id,
      after: { scopes, approvalPolicy: parsed.data.approvalPolicy },
      traceId: crypto.randomUUID(),
    });
    return { id, status: 'approved' as const, expiresAt: authorization.expiresAt };
  }

  async denyAuthorization(id: string, actor: AuthenticatedUser) {
    this.assertGovernanceActor(actor);
    const db = this.db();
    const [row] = await db
      .update(agentDeviceAuthorizations)
      .set({ status: 'denied', deniedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(agentDeviceAuthorizations.id, id), eq(agentDeviceAuthorizations.status, 'pending')),
      )
      .returning({ id: agentDeviceAuthorizations.id });
    if (!row)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        'Agent authorization is no longer pending',
        HttpStatus.NOT_FOUND,
      );
    await db.insert(auditLogs).values({
      organizationId: actor.organizationId,
      actorId: actor.sub,
      actorType: 'staff',
      action: 'agent.authorization.denied',
      resourceType: 'agent-device-authorization',
      resourceId: id,
      after: { status: 'denied' },
      traceId: crypto.randomUUID(),
    });
    return { id, status: 'denied' as const };
  }

  private async verifyTokenDpop(input: {
    proof: string | undefined;
    method: string;
    url: string;
    expectedJkt: string;
  }) {
    if (!input.proof)
      throw oauthError('invalid_dpop_proof', 'DPoP proof is required', HttpStatus.UNAUTHORIZED);
    let verified;
    try {
      verified = verifyDpopProof({ proof: input.proof, method: input.method, url: input.url });
    } catch (error) {
      throw oauthError(
        'invalid_dpop_proof',
        error instanceof Error ? error.message : 'DPoP proof is invalid',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (verified.jkt !== input.expectedJkt) {
      throw oauthError(
        'invalid_dpop_proof',
        'DPoP key does not match the authorization',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const accepted = await this.redis
      .getClient()
      .set(
        `tokems:agent:dpop:${verified.jkt}:${verified.jti}`,
        '1',
        'EX',
        AGENT_DPOP_REPLAY_TTL_SECONDS,
        'NX',
      );
    if (accepted !== 'OK')
      throw oauthError('invalid_dpop_proof', 'DPoP proof was replayed', HttpStatus.UNAUTHORIZED);
  }

  private async signAccessToken(input: {
    connectionId: string;
    organizationId: string;
    userId: string;
    scopes: AgentScope[];
    dpopThumbprint: string;
    credentialVersion: string;
    membershipVersion: string;
  }) {
    const secret = decodeAgentAccessSecret(
      process.env.AGENT_ACCESS_TOKEN_SECRET,
      'AGENT_ACCESS_TOKEN_SECRET',
    );
    const resource = resolveAgentResource();
    return this.jwt.signAsync(
      {
        sub: input.userId,
        token_use: 'agent',
        client_id: TOKEMS_AGENT_CLIENT_ID,
        connection_id: input.connectionId,
        organization_id: input.organizationId,
        scopes: input.scopes,
        credential_version: input.credentialVersion,
        membership_version: input.membershipVersion,
        cnf: { jkt: input.dpopThumbprint },
      },
      {
        secret,
        algorithm: 'HS256',
        expiresIn: AGENT_ACCESS_TOKEN_TTL_SECONDS,
        issuer: new URL(resource).origin,
        audience: resource,
        header: { alg: 'HS256', typ: 'at+jwt', kid: agentAccessKeyId(secret) },
      },
    );
  }

  async exchangeDeviceCode(input: {
    payload: unknown;
    proof: string | undefined;
    method: string;
    url: string;
  }) {
    const payload = input.payload as Record<string, unknown>;
    if (payload.grant_type === 'refresh_token') return this.refresh(input);
    const deviceCode = typeof payload.device_code === 'string' ? payload.device_code : '';
    if (payload.client_id !== TOKEMS_AGENT_CLIENT_ID || !deviceCode) {
      throw oauthError('invalid_request', 'Device token request is invalid');
    }
    const db = this.db();
    const [authorization] = await db
      .select()
      .from(agentDeviceAuthorizations)
      .where(eq(agentDeviceAuthorizations.deviceCodeHash, sha256(deviceCode)))
      .limit(1);
    if (!authorization || authorization.expiresAt.getTime() <= Date.now()) {
      throw oauthError('expired_token', 'Device authorization expired');
    }
    await this.verifyTokenDpop({
      proof: input.proof,
      method: input.method,
      url: input.url,
      expectedJkt: authorization.dpopThumbprint,
    });
    const now = new Date();
    if (
      authorization.lastPolledAt &&
      now.getTime() - authorization.lastPolledAt.getTime() <
        authorization.pollingIntervalSeconds * 1000
    ) {
      await db
        .update(agentDeviceAuthorizations)
        .set({
          pollingIntervalSeconds: Math.min(60, authorization.pollingIntervalSeconds + 5),
          lastPolledAt: now,
          updatedAt: now,
        })
        .where(eq(agentDeviceAuthorizations.id, authorization.id));
      throw oauthError('slow_down', 'Device token polling is too frequent');
    }
    await db
      .update(agentDeviceAuthorizations)
      .set({ lastPolledAt: now, updatedAt: now })
      .where(eq(agentDeviceAuthorizations.id, authorization.id));
    if (authorization.status === 'pending')
      throw oauthError('authorization_pending', 'Authorization is pending');
    if (authorization.status === 'denied')
      throw oauthError('access_denied', 'Authorization was denied');
    if (
      authorization.status !== 'approved' ||
      !authorization.membershipId ||
      !authorization.organizationId
    ) {
      throw oauthError('invalid_grant', 'Device authorization was already consumed');
    }

    const [identity] = await db
      .select({ membership: memberships, user: users, preferences: memberProfiles.preferences })
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
          eq(memberships.id, authorization.membershipId),
          eq(memberships.organizationId, authorization.organizationId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (!identity || identity.user.id !== configuredSuperAdministratorId()) {
      throw oauthError('access_denied', 'Delegated administrator is no longer eligible');
    }
    const credentialVersion = staffCredentialVersion(
      identity.user,
      staffCredentialRevision(identity.preferences),
    );
    const membershipVersion = identity.membership.updatedAt.toISOString();
    const refreshToken = opaqueToken();
    const familyId = crypto.randomUUID();
    const result = await db.transaction(async (tx) => {
      const [consumed] = await tx
        .update(agentDeviceAuthorizations)
        .set({ status: 'consumed', consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(agentDeviceAuthorizations.id, authorization.id),
            eq(agentDeviceAuthorizations.status, 'approved'),
          ),
        )
        .returning({ id: agentDeviceAuthorizations.id });
      if (!consumed) throw oauthError('invalid_grant', 'Device authorization was already consumed');
      const [connection] = await tx
        .insert(agentConnections)
        .values({
          organizationId: authorization.organizationId!,
          delegatedUserId: identity.user.id,
          membershipId: identity.membership.id,
          authorizedBy: authorization.approvedBy!,
          name: authorization.clientName,
          clientId: authorization.clientId,
          dpopThumbprint: authorization.dpopThumbprint,
          scopes: authorization.approvedScopes ?? [],
          approvalPolicy: authorization.approvalPolicy ?? 'controlled-and-critical',
          delegatedCredentialVersion: credentialVersion,
          delegatedMembershipVersion: membershipVersion,
          catalogVersion: TOKEMS_AGENT_CATALOG_VERSION,
          expiresAt: expiry(AGENT_CONNECTION_TTL_SECONDS),
        })
        .returning();
      await tx.insert(agentRefreshTokens).values({
        connectionId: connection!.id,
        tokenHash: sha256(refreshToken),
        familyId,
        sequence: 0,
        expiresAt: expiry(AGENT_REFRESH_TOKEN_TTL_SECONDS),
      });
      await tx.insert(auditLogs).values({
        organizationId: connection!.organizationId,
        actorId: connection!.id,
        actorType: 'agent',
        action: 'agent.connection.created',
        resourceType: 'agent-connection',
        resourceId: connection!.id,
        after: {
          authorizedBy: connection!.authorizedBy,
          scopes: connection!.scopes,
          approvalPolicy: connection!.approvalPolicy,
        },
        traceId: crypto.randomUUID(),
      });
      return connection!;
    });
    return {
      access_token: await this.signAccessToken({
        connectionId: result.id,
        organizationId: result.organizationId,
        userId: result.delegatedUserId,
        scopes: result.scopes,
        dpopThumbprint: result.dpopThumbprint,
        credentialVersion,
        membershipVersion,
      }),
      token_type: 'DPoP' as const,
      expires_in: AGENT_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: result.scopes.join(' '),
      connection_id: result.id,
    };
  }

  private async refresh(input: {
    payload: unknown;
    proof: string | undefined;
    method: string;
    url: string;
  }) {
    const parsed = AgentRefreshTokenRequestSchema.safeParse(input.payload);
    if (!parsed.success) throw oauthError('invalid_request', 'Refresh token request is invalid');
    const db = this.db();
    const [row] = await db
      .select({
        token: agentRefreshTokens,
        connection: agentConnections,
        membership: memberships,
        user: users,
        preferences: memberProfiles.preferences,
      })
      .from(agentRefreshTokens)
      .innerJoin(agentConnections, eq(agentConnections.id, agentRefreshTokens.connectionId))
      .innerJoin(memberships, eq(memberships.id, agentConnections.membershipId))
      .innerJoin(users, eq(users.id, agentConnections.delegatedUserId))
      .leftJoin(
        memberProfiles,
        and(
          eq(memberProfiles.organizationId, memberships.organizationId),
          eq(memberProfiles.userId, memberships.userId),
        ),
      )
      .where(eq(agentRefreshTokens.tokenHash, sha256(parsed.data.refresh_token)))
      .limit(1);
    if (!row) throw oauthError('invalid_grant', 'Refresh token is invalid');
    await this.verifyTokenDpop({
      proof: input.proof,
      method: input.method,
      url: input.url,
      expectedJkt: row.connection.dpopThumbprint,
    });
    const now = new Date();
    const credentialVersion = staffCredentialVersion(
      row.user,
      staffCredentialRevision(row.preferences),
    );
    const membershipVersion = row.membership.updatedAt.toISOString();
    const connectionUsable =
      row.token.expiresAt > now &&
      !row.token.revokedAt &&
      row.connection.status === 'active' &&
      row.connection.expiresAt > now &&
      row.membership.status === 'active' &&
      row.membership.organizationId === row.connection.organizationId &&
      row.membership.userId === row.connection.delegatedUserId &&
      row.user.id === configuredSuperAdministratorId() &&
      row.connection.catalogVersion === TOKEMS_AGENT_CATALOG_VERSION &&
      credentialVersion === row.connection.delegatedCredentialVersion &&
      membershipVersion === row.connection.delegatedMembershipVersion;
    if (row.token.usedAt) {
      const replayedReplacement =
        connectionUsable &&
        row.token.replayExpiresAt &&
        row.token.replayExpiresAt > now &&
        row.token.replacementTokenCiphertext
          ? this.openRefreshReplay(row.token.replacementTokenCiphertext)
          : undefined;
      if (replayedReplacement) {
        return {
          access_token: await this.signAccessToken({
            connectionId: row.connection.id,
            organizationId: row.connection.organizationId,
            userId: row.connection.delegatedUserId,
            scopes: row.connection.scopes,
            dpopThumbprint: row.connection.dpopThumbprint,
            credentialVersion,
            membershipVersion,
          }),
          token_type: 'DPoP' as const,
          expires_in: AGENT_ACCESS_TOKEN_TTL_SECONDS,
          refresh_token: replayedReplacement,
          scope: row.connection.scopes.join(' '),
          connection_id: row.connection.id,
        };
      }
      const revokedAt = new Date();
      await db.transaction(async (tx) => {
        await tx
          .update(agentRefreshTokens)
          .set({ revokedAt, revocationReason: 'refresh-token-reuse' })
          .where(eq(agentRefreshTokens.familyId, row.token.familyId));
        await tx
          .update(agentConnections)
          .set({
            status: 'revoked',
            revokedAt,
            revocationReason: 'refresh-token-reuse',
            updatedAt: revokedAt,
          })
          .where(eq(agentConnections.id, row.connection.id));
        await tx.insert(auditLogs).values({
          organizationId: row.connection.organizationId,
          actorId: row.connection.id,
          actorType: 'agent',
          action: 'agent.connection.refresh-reuse-revoked',
          resourceType: 'agent-connection',
          resourceId: row.connection.id,
          after: { reason: 'refresh-token-reuse' },
          traceId: crypto.randomUUID(),
        });
      });
      throw oauthError('invalid_grant', 'Refresh token reuse revoked the connection');
    }
    if (!connectionUsable) {
      throw oauthError('invalid_grant', 'Refresh token or connection expired');
    }
    const replacement = opaqueToken();
    const rotated = await db.transaction(async (tx) => {
      const [consumed] = await tx
        .update(agentRefreshTokens)
        .set({ usedAt: now })
        .where(and(eq(agentRefreshTokens.id, row.token.id), isNull(agentRefreshTokens.usedAt)))
        .returning({ id: agentRefreshTokens.id });
      if (!consumed) return false;
      const [next] = await tx
        .insert(agentRefreshTokens)
        .values({
          connectionId: row.connection.id,
          tokenHash: sha256(replacement),
          familyId: row.token.familyId,
          sequence: row.token.sequence + 1,
          expiresAt: expiry(AGENT_REFRESH_TOKEN_TTL_SECONDS),
        })
        .returning({ id: agentRefreshTokens.id });
      await tx
        .update(agentRefreshTokens)
        .set({
          replacedById: next!.id,
          replacementTokenCiphertext: sealSecret(replacement, this.refreshReplaySecrets()[0]!),
          replayExpiresAt: new Date(now.getTime() + 2 * 60_000),
        })
        .where(eq(agentRefreshTokens.id, row.token.id));
      return true;
    });
    if (!rotated) {
      const revokedAt = new Date();
      await db.transaction(async (tx) => {
        await tx
          .update(agentRefreshTokens)
          .set({ revokedAt, revocationReason: 'concurrent-refresh-token-reuse' })
          .where(eq(agentRefreshTokens.familyId, row.token.familyId));
        await tx
          .update(agentConnections)
          .set({
            status: 'revoked',
            revokedAt,
            revocationReason: 'concurrent-refresh-token-reuse',
            updatedAt: revokedAt,
          })
          .where(eq(agentConnections.id, row.connection.id));
        await tx.insert(auditLogs).values({
          organizationId: row.connection.organizationId,
          actorId: row.connection.id,
          actorType: 'agent',
          action: 'agent.connection.concurrent-refresh-reuse-revoked',
          resourceType: 'agent-connection',
          resourceId: row.connection.id,
          after: { reason: 'concurrent-refresh-token-reuse' },
          traceId: crypto.randomUUID(),
        });
      });
      throw oauthError('invalid_grant', 'Concurrent refresh token reuse revoked the connection');
    }
    return {
      access_token: await this.signAccessToken({
        connectionId: row.connection.id,
        organizationId: row.connection.organizationId,
        userId: row.connection.delegatedUserId,
        scopes: row.connection.scopes,
        dpopThumbprint: row.connection.dpopThumbprint,
        credentialVersion,
        membershipVersion,
      }),
      token_type: 'DPoP' as const,
      expires_in: AGENT_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: replacement,
      scope: row.connection.scopes.join(' '),
      connection_id: row.connection.id,
    };
  }

  async listConnections(actor: AuthenticatedUser) {
    this.assertGovernanceActor(actor);
    return this.db()
      .select({
        id: agentConnections.id,
        name: agentConnections.name,
        clientId: agentConnections.clientId,
        scopes: agentConnections.scopes,
        approvalPolicy: agentConnections.approvalPolicy,
        status: agentConnections.status,
        dpopThumbprint: agentConnections.dpopThumbprint,
        catalogVersion: agentConnections.catalogVersion,
        lastUsedAt: agentConnections.lastUsedAt,
        expiresAt: agentConnections.expiresAt,
        revokedAt: agentConnections.revokedAt,
        createdAt: agentConnections.createdAt,
      })
      .from(agentConnections)
      .where(eq(agentConnections.organizationId, actor.organizationId))
      .orderBy(desc(agentConnections.createdAt));
  }

  async securityMetrics(actor: AuthenticatedUser) {
    this.assertGovernanceActor(actor);
    const db = this.db();
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const [connectionRows, authorizationRows, operationRows, revocationRows] = await Promise.all([
      db
        .select({ status: agentConnections.status, count: sql<number>`count(*)::int` })
        .from(agentConnections)
        .where(eq(agentConnections.organizationId, actor.organizationId))
        .groupBy(agentConnections.status),
      db
        .select({ status: agentDeviceAuthorizations.status, count: sql<number>`count(*)::int` })
        .from(agentDeviceAuthorizations)
        .where(
          and(
            inArray(agentDeviceAuthorizations.status, ['pending', 'approved']),
            gte(agentDeviceAuthorizations.expiresAt, new Date()),
          ),
        )
        .groupBy(agentDeviceAuthorizations.status),
      db
        .select({ status: agentOperations.status, count: sql<number>`count(*)::int` })
        .from(agentOperations)
        .where(
          and(
            eq(agentOperations.organizationId, actor.organizationId),
            gte(agentOperations.createdAt, since),
          ),
        )
        .groupBy(agentOperations.status),
      db
        .select({
          reason: agentConnections.revocationReason,
          count: sql<number>`count(*)::int`,
        })
        .from(agentConnections)
        .where(
          and(
            eq(agentConnections.organizationId, actor.organizationId),
            gte(agentConnections.revokedAt, since),
          ),
        )
        .groupBy(agentConnections.revocationReason),
    ]);
    const connections = Object.fromEntries(
      connectionRows.map(({ status, count }) => [status, Number(count)]),
    );
    const authorizations = Object.fromEntries(
      authorizationRows.map(({ status, count }) => [status, Number(count)]),
    );
    const operations = Object.fromEntries(
      operationRows.map(({ status, count }) => [status, Number(count)]),
    );
    const refreshReuseRevocations = revocationRows
      .filter(({ reason }) => reason?.includes('refresh-token-reuse'))
      .reduce((sum, { count }) => sum + Number(count), 0);
    const alerts = [
      ...(refreshReuseRevocations
        ? [{ code: 'REFRESH_TOKEN_REUSE', severity: 'critical', count: refreshReuseRevocations }]
        : []),
      ...(Number(operations.unknown ?? 0)
        ? [
            {
              code: 'AGENT_RESULTS_UNKNOWN',
              severity: 'warning',
              count: Number(operations.unknown),
            },
          ]
        : []),
    ];
    return {
      generatedAt: new Date().toISOString(),
      window: '24h',
      connections,
      authorizations,
      operations,
      refreshReuseRevocations,
      alerts,
    };
  }

  async revokeConnection(id: string, actor: AuthenticatedUser, reason = 'administrator-revoked') {
    this.assertGovernanceActor(actor);
    const now = new Date();
    const [row] = await this.db()
      .update(agentConnections)
      .set({
        status: 'revoked',
        revokedAt: now,
        revokedBy: actor.sub,
        revocationReason: reason,
        updatedAt: now,
      })
      .where(
        and(eq(agentConnections.id, id), eq(agentConnections.organizationId, actor.organizationId)),
      )
      .returning({ id: agentConnections.id });
    if (!row)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        'Agent connection was not found',
        HttpStatus.NOT_FOUND,
      );
    await this.db()
      .update(agentRefreshTokens)
      .set({ revokedAt: now, revocationReason: reason })
      .where(and(eq(agentRefreshTokens.connectionId, id), isNull(agentRefreshTokens.revokedAt)));
    await this.db().insert(auditLogs).values({
      organizationId: actor.organizationId,
      actorId: actor.sub,
      actorType: 'staff',
      action: 'agent.connection.revoked',
      resourceType: 'agent-connection',
      resourceId: id,
      after: { reason },
      traceId: crypto.randomUUID(),
    });
    return { id, status: 'revoked' as const };
  }

  async updateConnectionPolicy(
    id: string,
    payload: { approvalPolicy?: unknown; stepUpToken?: unknown; requestHash?: unknown },
    actor: AuthenticatedUser,
  ) {
    this.assertGovernanceActor(actor);
    if (
      !['controlled-and-critical', 'critical-only'].includes(String(payload.approvalPolicy)) ||
      typeof payload.stepUpToken !== 'string' ||
      typeof payload.requestHash !== 'string'
    ) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Connection policy change is invalid',
        HttpStatus.BAD_REQUEST,
      );
    }
    const expectedRequestHash = agentApprovalRequestHash({
      connectionId: id,
      approvalPolicy: payload.approvalPolicy,
    });
    if (payload.requestHash !== expectedRequestHash) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Connection policy approval summary does not match the submitted decision',
        HttpStatus.CONFLICT,
      );
    }
    await this.consumeStepUp({
      token: payload.stepUpToken,
      actor,
      purpose: 'agent-policy',
      targetId: id,
      requestHash: payload.requestHash,
    });
    const [row] = await this.db()
      .update(agentConnections)
      .set({
        approvalPolicy: payload.approvalPolicy as 'controlled-and-critical' | 'critical-only',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentConnections.id, id),
          eq(agentConnections.organizationId, actor.organizationId),
          eq(agentConnections.status, 'active'),
        ),
      )
      .returning({ id: agentConnections.id, approvalPolicy: agentConnections.approvalPolicy });
    if (!row) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        'Active Agent connection was not found',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.db()
      .insert(auditLogs)
      .values({
        organizationId: actor.organizationId,
        actorId: actor.sub,
        actorType: 'staff',
        action: 'agent.connection.policy.updated',
        resourceType: 'agent-connection',
        resourceId: id,
        after: { approvalPolicy: row.approvalPolicy },
        traceId: crypto.randomUUID(),
      });
    return row;
  }

  async revokeAll(
    payload: { stepUpToken?: string; requestHash?: string },
    actor: AuthenticatedUser,
  ) {
    this.assertGovernanceActor(actor);
    if (!payload.stepUpToken || !payload.requestHash) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Step-up token and request hash are required',
        HttpStatus.BAD_REQUEST,
      );
    }
    const expectedRequestHash = agentApprovalRequestHash({
      organizationId: actor.organizationId,
      action: 'revoke-all',
    });
    if (payload.requestHash !== expectedRequestHash) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Emergency revocation summary does not match this organization',
        HttpStatus.CONFLICT,
      );
    }
    await this.consumeStepUp({
      token: payload.stepUpToken,
      actor,
      purpose: 'agent-revoke-all',
      targetId: actor.organizationId,
      requestHash: payload.requestHash,
    });
    const now = new Date();
    const rows = await this.db().transaction(async (tx) => {
      const revoked = await tx
        .update(agentConnections)
        .set({
          status: 'revoked',
          revokedAt: now,
          revokedBy: actor.sub,
          revocationReason: 'emergency-revoke-all',
          updatedAt: now,
        })
        .where(
          and(
            eq(agentConnections.organizationId, actor.organizationId),
            eq(agentConnections.status, 'active'),
          ),
        )
        .returning({ id: agentConnections.id });
      if (revoked.length) {
        await tx
          .update(agentRefreshTokens)
          .set({ revokedAt: now, revocationReason: 'emergency-revoke-all' })
          .where(
            inArray(
              agentRefreshTokens.connectionId,
              revoked.map((entry) => entry.id),
            ),
          );
      }
      await tx.insert(auditLogs).values({
        organizationId: actor.organizationId,
        actorId: actor.sub,
        actorType: 'staff',
        action: 'agent.connection.emergency-revoke-all',
        resourceType: 'agent-connection-set',
        resourceId: actor.organizationId,
        after: { revokedCount: revoked.length },
        traceId: crypto.randomUUID(),
      });
      return revoked;
    });
    return { revoked: rows.length };
  }

  async revokeByRefreshToken(rawToken: string) {
    const db = this.db();
    const [row] = await db
      .select({
        connectionId: agentRefreshTokens.connectionId,
        organizationId: agentConnections.organizationId,
      })
      .from(agentRefreshTokens)
      .innerJoin(agentConnections, eq(agentConnections.id, agentRefreshTokens.connectionId))
      .where(eq(agentRefreshTokens.tokenHash, sha256(rawToken)))
      .limit(1);
    if (!row) return { revoked: true };
    const now = new Date();
    await db
      .update(agentConnections)
      .set({
        status: 'revoked',
        revokedAt: now,
        revocationReason: 'client-revoked',
        updatedAt: now,
      })
      .where(eq(agentConnections.id, row.connectionId));
    await db
      .update(agentRefreshTokens)
      .set({ revokedAt: now, revocationReason: 'client-revoked' })
      .where(eq(agentRefreshTokens.connectionId, row.connectionId));
    await db.insert(auditLogs).values({
      organizationId: row.organizationId,
      actorId: row.connectionId,
      actorType: 'agent',
      action: 'agent.connection.client-revoked',
      resourceType: 'agent-connection',
      resourceId: row.connectionId,
      after: { reason: 'client-revoked' },
      traceId: crypto.randomUUID(),
    });
    return { revoked: true };
  }
}
