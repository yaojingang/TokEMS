import { AGENT_INPUT_SCHEMAS } from './agent-input-contracts.js';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_CODES,
  isPublicEventStatus,
  AgentOperationApprovalSchema,
  AgentOperationConfirmSchema,
  AgentOperationPrepareSchema,
  AgentOperationVerificationSchema,
  type AgentOperationStatus,
  type AgentRisk,
} from '@conference/contracts';
import { agentConnections, agentOperations, auditLogs, memberships, users, memberProfiles, events, organizations, templateHtmlImports, notificationDeliveries, organizationHomepageEvents } from '@conference/database';
import {
  createAgentStateObservation,
  decodeAgentAccessSecret,
  openSecret,
  sealSecret,
  sha256,
  stableCanonicalJson,
  verifyAgentStateObservation,
} from '@conference/security';
import { and, count, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { verifyAgentPublicDelivery, verifyAgentHomepageDelivery, type AgentPublicExpectation, type AgentHomepageExpectation } from './agent-public-verification.js';
import { staffCredentialRevision, staffCredentialVersion } from './staff-account.js';
import { captureAgentResourceState } from './agent-resource-state.js';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import { AGENT_ACTION_MAP } from './agent-operation-catalog.js';
import { AgentPolicyService } from './agent-policy.service.js';
import type { AgentPrincipal } from './agent-principal.service.js';
import type { AuthenticatedUser } from './auth.guard.js';
import { AgentAuthorizationService } from './agent-authorization.service.js';

const PREPARED_TTL_MS = 15 * 60 * 1000;
const APPROVAL_EXECUTION_TTL_MS = 5 * 60 * 1000;
const ONE_TIME_SECRET_ESCROW_TTL_MS = 60 * 60 * 1000;
const MAX_ACTIVE_OPERATIONS_PER_CONNECTION = 50;
const TARGET_FINGERPRINT_KEY = '__agentTargetFingerprint';
const PRECONDITION_MODE_KEY = '__agentPreconditionMode';
const SENSITIVE_TARGET_KEY = /(email|mobile|phone|name|address|identity|search|query|^q$)/iu;
const APPROVAL_SECRET_KEY =
  /(authorization|token|secret|password|credential|private.?key|dpop|cookie|mobile|phone|email|address|identity|id.?card|tax.?id|bank|recipient|real.?name|nickname)/iu;
const APPROVAL_SECRET_CONTAINERS = new Set(['answers', 'attendee', 'formanswers']);

function approvalProjection(value: unknown, key = '', depth = 0, forceRedact = false): unknown {
  if (depth > 8) return '[depth-limited]';
  if (forceRedact || APPROVAL_SECRET_KEY.test(key)) return '[redacted]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => approvalProjection(entry, key, depth + 1));
  }
  if (value && typeof value === 'object') {
    const maskChildren = APPROVAL_SECRET_CONTAINERS.has(
      key.replace(/[^a-z0-9]/giu, '').toLowerCase(),
    );
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 200)
        .map(([entryKey, entryValue]) => [
          entryKey,
          approvalProjection(entryValue, entryKey, depth + 1, maskChildren),
        ]),
    );
  }
  return typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

export function agentApprovalProjection(body: Record<string, unknown>) {
  return { proposed: approvalProjection(body) as Record<string, unknown> };
}

function finiteCount(value: unknown) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? Math.min(count, 1_000_000) : undefined;
}

export function deriveAgentImpactSummary(body: Record<string, unknown>) {
  const itemArrays = ['items', 'ids', 'recipients', 'registrations', 'documents']
    .map((key) => body[key])
    .filter(Array.isArray);
  const batchCount = itemArrays.length
    ? Math.max(...itemArrays.map((items) => items.length))
    : undefined;
  const audienceCount = finiteCount(body.audienceCount ?? body.recipientCount);
  return {
    ...(audienceCount !== undefined ? { audienceCount } : {}),
    ...(body.allAudience === true ? { allAudience: true } : {}),
    ...(batchCount !== undefined ? { batchCount } : {}),
  };
}

function normalizedTarget(target: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(target)
      .filter(([key, value]) => !key.startsWith('_') && value !== undefined && value !== null)
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? value.map(String).join(',') : String(value),
      ]),
  );
}

function storedTarget(actionPath: string, target: Record<string, unknown>): Record<string, string> {
  const normalized = normalizedTarget(target);
  const required = actionPath
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1));
  if (required.some((key) => !normalized[key])) {
    throw new DomainError(
      API_ERROR_CODES.VALIDATION_ERROR,
      'Agent operation target is missing required route parameters',
      HttpStatus.BAD_REQUEST,
    );
  }
  return {
    ...Object.fromEntries(
      Object.entries(normalized).map(([key, value]) => [
        key,
        SENSITIVE_TARGET_KEY.test(key) ? '[redacted]' : value,
      ]),
    ),
    [TARGET_FINGERPRINT_KEY]: sha256(stableCanonicalJson(normalized)),
  };
}

function requiredPathParameters(path: string) {
  return path
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1));
}

function requiresStateObservation(actionId: string, target: Record<string, unknown>) {
  const action = AGENT_ACTION_MAP.get(actionId);
  if (!action?.verifyActionId) return false;
  const verifier = AGENT_ACTION_MAP.get(action.verifyActionId);
  return Boolean(
    verifier && requiredPathParameters(verifier.path).every((key) => target[key] !== undefined),
  );
}

function needsBrowserApproval(risk: AgentRisk) {
  return (
    risk === 'critical' ||
    risk === 'controlled'
  );
}

function publicOperation(row: typeof agentOperations.$inferSelect) {
  const target = Object.fromEntries(
    Object.entries(row.targetSummary).filter(([key]) => !key.startsWith('__')),
  );
  return {
    id: row.id,
    actionId: row.actionId,
    routeName: row.routeName,
    target,
    dataClass: row.dataClass,
    risk: row.risk,
    reason: row.reason,
    requestHash: row.requestHash,
    beforeFingerprint: row.beforeFingerprint,
    redactedDiff: row.redactedDiff,
    impactSummary: row.impactSummary,
    idempotencyKey: row.idempotencyKey,
    executionStrategy: row.executionStrategy,
    status: row.status,
    verificationStatus: row.verificationStatus,
    oneTimeSecretAvailable: Boolean(
      row.oneTimeSecretCiphertext &&
      !row.oneTimeSecretClaimedAt &&
      row.oneTimeSecretExpiresAt &&
      row.oneTimeSecretExpiresAt.getTime() > Date.now(),
    ),
    domainAuditIds: row.domainAuditIds,
    traceId: row.traceId,
    approvedAt: row.approvedAt,
    approvalExpiresAt: row.approvalExpiresAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class AgentOperationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AgentPolicyService) private readonly policy: AgentPolicyService,
    @Inject(AgentAuthorizationService)
    private readonly authorization: AgentAuthorizationService,
  ) {}

  private db() {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_ACCESS_DISABLED,
        'Agent operations require PostgreSQL',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  private stateObservationSecrets() {
    const current = decodeAgentAccessSecret(
      process.env.AGENT_ACCESS_TOKEN_SECRET,
      'AGENT_ACCESS_TOKEN_SECRET',
    );
    const previousValue = process.env.AGENT_ACCESS_TOKEN_PREVIOUS_SECRET?.trim();
    return previousValue
      ? [current, decodeAgentAccessSecret(previousValue, 'AGENT_ACCESS_TOKEN_PREVIOUS_SECRET')]
      : [current];
  }

  private escrowSecrets() {
    const current = process.env.AGENT_ACCESS_TOKEN_SECRET?.trim();
    if (!current) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_ACCESS_DISABLED,
        'Agent one-time secret escrow requires AGENT_ACCESS_TOKEN_SECRET',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const previous = process.env.AGENT_ACCESS_TOKEN_PREVIOUS_SECRET?.trim();
    return previous ? [current, previous] : [current];
  }

  private openEscrowSecret(ciphertext: string) {
    for (const secret of this.escrowSecrets()) {
      try {
        return openSecret(ciphertext, secret);
      } catch {
        // Continue through the configured key-rotation window.
      }
    }
    throw new DomainError(
      API_ERROR_CODES.AGENT_OPERATION_STALE,
      'Agent one-time secret escrow cannot be decrypted',
      HttpStatus.GONE,
    );
  }

  async observeRead<T>(input: {
    principal: AgentPrincipal;
    actionId: string;
    target: Record<string, string>;
  }, read: () => Promise<T>) {
    return this.database.withAgentReadTransaction(async () => {
      const result = await read();
      const token = await this.createStateObservation({ ...input, state: result });
      return { result, token };
    });
  }

  async createStateObservation(input: {
    principal: AgentPrincipal;
    actionId: string;
    target: Record<string, string>;
    state: unknown;
  }) {
    return createAgentStateObservation(
      {
        connectionId: input.principal.connectionId,
        organizationId: input.principal.organizationId,
        actionId: input.actionId,
        targetFingerprint: sha256(stableCanonicalJson(normalizedTarget(input.target))),
        stateFingerprint: sha256(stableCanonicalJson(
          await captureAgentResourceState(this.db(), input.actionId,
            input.principal.organizationId, input.target) ?? input.state)),
      },
      this.stateObservationSecrets()[0]!,
    );
  }

  private verifiedStateObservation(input: {
    token: string | undefined;
    principal: AgentPrincipal;
    expectedActionId: string;
    expectedTargetFingerprint: string;
  }) {
    if (!input.token) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'A fresh server state observation is required for this Agent action',
        HttpStatus.CONFLICT,
      );
    }
    let observation;
    try {
      observation = verifyAgentStateObservation(input.token, this.stateObservationSecrets());
    } catch (error) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        error instanceof Error ? error.message : 'Agent state observation is invalid',
        HttpStatus.CONFLICT,
      );
    }
    if (
      observation.connectionId !== input.principal.connectionId ||
      observation.organizationId !== input.principal.organizationId ||
      observation.actionId !== input.expectedActionId ||
      observation.targetFingerprint !== input.expectedTargetFingerprint
    ) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent state observation does not match this connection, action, or target',
        HttpStatus.CONFLICT,
      );
    }
    return observation;
  }

  async prepare(
    payload: unknown,
    principal: AgentPrincipal,
    user: AuthenticatedUser,
    traceId: string,
  ) {
    const parsed = AgentOperationPrepareSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Agent operation preparation is invalid',
        HttpStatus.BAD_REQUEST,
        { issues: parsed.error.issues },
      );
    }
    const action = AGENT_ACTION_MAP.get(parsed.data.actionId);
    if (!action || (action.method === 'GET' && action.confirmation === 'none')) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_ACTION_NOT_CLASSIFIED,
        'The requested write action is not in the capability catalog',
        HttpStatus.FORBIDDEN,
      );
    }
    const inputContract = AGENT_INPUT_SCHEMAS[action.actionId];
    if (inputContract) {
      const validation = inputContract.safeParse(parsed.data.requestBody);
      if (!validation.success) throw new DomainError(API_ERROR_CODES.VALIDATION_ERROR,
        'Agent request does not match the action input contract', HttpStatus.BAD_REQUEST,
        { issues: validation.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
    }
    const actualRequestHash = sha256(stableCanonicalJson(parsed.data.requestBody));
    if (actualRequestHash !== parsed.data.requestHash) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent request body does not match its preparation hash',
        HttpStatus.CONFLICT,
      );
    }
    const impactSummary = deriveAgentImpactSummary(parsed.data.requestBody);
    const risk = this.policy.authorize({
      action,
      principal,
      grants: user.grants,
      impact: impactSummary,
    });
    if (!parsed.data.idempotencyKey) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'This Agent action requires an idempotency key',
        HttpStatus.BAD_REQUEST,
      );
    }
    const status: AgentOperationStatus = needsBrowserApproval(risk)
      ? 'approval_required'
      : 'prepared';
    const targetSummary = storedTarget(action.path, parsed.data.target);
    const expectedTargetFingerprint = String(targetSummary[TARGET_FINGERPRINT_KEY]);
    const observationRequired = requiresStateObservation(action.actionId, parsed.data.target);
    const observation = observationRequired
      ? this.verifiedStateObservation({
          token: parsed.data.beforeStateToken,
          principal,
          expectedActionId: action.verifyActionId!,
          expectedTargetFingerprint,
        })
      : undefined;
    const beforeFingerprint =
      observation?.stateFingerprint ??
      sha256(stableCanonicalJson({ actionId: action.actionId, mode: 'not-applicable' }));
    targetSummary[PRECONDITION_MODE_KEY] = observation ? 'server-observed' : 'not-applicable';
    const redactedDiff = agentApprovalProjection(parsed.data.requestBody);
    if (parsed.data.idempotencyKey) {
      const [existing] = await this.db()
        .select()
        .from(agentOperations)
        .where(
          and(
            eq(agentOperations.connectionId, principal.connectionId),
            eq(agentOperations.idempotencyKey, parsed.data.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (
          existing.actionId === action.actionId &&
          existing.requestHash === parsed.data.requestHash &&
          existing.targetSummary[TARGET_FINGERPRINT_KEY] === targetSummary[TARGET_FINGERPRINT_KEY]
        ) {
          return publicOperation(existing);
        }
        throw new DomainError(
          API_ERROR_CODES.AGENT_IDEMPOTENCY_CONFLICT,
          'Agent idempotency key was already used for a different request',
          HttpStatus.CONFLICT,
        );
      }
    }
    const [active] = await this.db()
      .select({ value: count() })
      .from(agentOperations)
      .where(
        and(
          eq(agentOperations.connectionId, principal.connectionId),
          inArray(agentOperations.status, [
            'prepared',
            'approval_required',
            'approved',
            'executing',
            'queued',
            'unknown',
          ]),
        ),
      );
    if (Number(active?.value ?? 0) >= MAX_ACTIVE_OPERATIONS_PER_CONNECTION) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_LIMIT,
        'This Agent connection has too many unfinished operations',
        HttpStatus.TOO_MANY_REQUESTS,
        { limit: MAX_ACTIVE_OPERATIONS_PER_CONNECTION },
      );
    }
    const [row] = await this.db()
      .insert(agentOperations)
      .values({
        organizationId: principal.organizationId,
        connectionId: principal.connectionId,
        delegatedUserId: principal.delegatedUserId,
        actionId: action.actionId,
        routeName: action.routeName,
        targetSummary,
        dataClass: action.dataClass,
        risk,
        reason: parsed.data.reason,
        requestHash: parsed.data.requestHash,
        beforeFingerprint,
        redactedDiff,
        impactSummary: {
          ...impactSummary,
          precondition: observation ? 'server-observed' : 'not-applicable',
        },
        idempotencyKey: parsed.data.idempotencyKey,
        executionStrategy: action.idempotencyStrategy,
        status,
        traceId,
        expiresAt: new Date(Date.now() + PREPARED_TTL_MS),
      })
      .onConflictDoNothing({
        target: [agentOperations.connectionId, agentOperations.idempotencyKey],
      })
      .returning();
    if (row) return publicOperation(row);
    const [existing] = await this.db()
      .select()
      .from(agentOperations)
      .where(
        and(
          eq(agentOperations.connectionId, principal.connectionId),
          eq(agentOperations.idempotencyKey, parsed.data.idempotencyKey!),
        ),
      )
      .limit(1);
    if (
      existing &&
      existing.actionId === action.actionId &&
      existing.requestHash === parsed.data.requestHash &&
      existing.targetSummary[TARGET_FINGERPRINT_KEY] === targetSummary[TARGET_FINGERPRINT_KEY]
    ) {
      return publicOperation(existing);
    }
    throw new DomainError(
      API_ERROR_CODES.AGENT_IDEMPOTENCY_CONFLICT,
      'Agent idempotency key was already used for a different request',
      HttpStatus.CONFLICT,
    );
  }

  async get(id: string, principal: AgentPrincipal): Promise<ReturnType<typeof publicOperation>> {
    const [row] = await this.db()
      .select()
      .from(agentOperations)
      .where(
        and(
          eq(agentOperations.id, id),
          eq(agentOperations.connectionId, principal.connectionId),
          eq(agentOperations.organizationId, principal.organizationId),
        ),
      )
      .limit(1);
    if (!row)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        'Agent operation was not found',
        HttpStatus.NOT_FOUND,
      );
    if (
      row.expiresAt.getTime() <= Date.now() &&
      ['prepared', 'approval_required'].includes(row.status)
    ) {
      const [expired] = await this.db()
        .update(agentOperations)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(and(eq(agentOperations.id, row.id),
          inArray(agentOperations.status, ['prepared', 'approval_required']),
          lte(agentOperations.expiresAt, new Date(Date.now()))))
        .returning();
      return expired ? publicOperation(expired) : this.get(id, principal);
    }
    return publicOperation(row);
  }

  async getForHuman(id: string, actor: AuthenticatedUser) {
    this.authorization.assertGovernanceActor(actor);
    const [row] = await this.db()
      .select()
      .from(agentOperations)
      .where(
        and(eq(agentOperations.id, id), eq(agentOperations.organizationId, actor.organizationId)),
      )
      .limit(1);
    if (!row) {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        'Agent operation was not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return publicOperation(row);
  }

  async confirm(id: string, payload: unknown, principal: AgentPrincipal) {
    const parsed = AgentOperationConfirmSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Agent confirmation is invalid',
        HttpStatus.BAD_REQUEST,
      );
    }
    const [row] = await this.db()
      .select()
      .from(agentOperations)
      .where(
        and(
          eq(agentOperations.id, id),
          eq(agentOperations.connectionId, principal.connectionId),
          eq(agentOperations.organizationId, principal.organizationId),
        ),
      )
      .limit(1);
    if (!row)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        'Agent operation was not found',
        HttpStatus.NOT_FOUND,
      );
    if (
      row.requestHash !== parsed.data.requestHash ||
      row.beforeFingerprint !== parsed.data.beforeFingerprint
    ) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent operation confirmation does not match the prepared state',
        HttpStatus.CONFLICT,
      );
    }
    if (row.status === 'approval_required') {
      throw new DomainError(
        API_ERROR_CODES.AGENT_APPROVAL_REQUIRED,
        'This operation requires browser approval',
        HttpStatus.FORBIDDEN,
      );
    }
    if (row.status !== 'prepared' || row.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent operation is no longer confirmable',
        HttpStatus.CONFLICT,
      );
    }
    const [confirmed] = await this.db()
      .update(agentOperations)
      .set({
        status: 'approved',
        approvalExpiresAt: new Date(Date.now() + APPROVAL_EXECUTION_TTL_MS),
        updatedAt: new Date(),
      })
      .where(and(eq(agentOperations.id, id), eq(agentOperations.status, 'prepared')))
      .returning();
    if (!confirmed) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent operation was confirmed concurrently',
        HttpStatus.CONFLICT,
      );
    }
    return publicOperation(confirmed);
  }

  async approve(id: string, payload: unknown, actor: AuthenticatedUser) {
    this.authorization.assertGovernanceActor(actor);
    const parsed = AgentOperationApprovalSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Agent operation approval is invalid',
        HttpStatus.BAD_REQUEST,
      );
    }
    const [row] = await this.db()
      .select()
      .from(agentOperations)
      .where(
        and(eq(agentOperations.id, id), eq(agentOperations.organizationId, actor.organizationId)),
      )
      .limit(1);
    if (!row)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        'Agent operation was not found',
        HttpStatus.NOT_FOUND,
      );
    if (row.status !== 'approval_required' || row.expiresAt.getTime() <= Date.now()) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent operation is no longer approvable',
        HttpStatus.CONFLICT,
      );
    }
    if (
      row.requestHash !== parsed.data.requestHash ||
      row.beforeFingerprint !== parsed.data.beforeFingerprint
    ) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Approval summary does not match the prepared operation',
        HttpStatus.CONFLICT,
      );
    }
    if (row.risk === 'critical') {
      if (!parsed.data.stepUpToken) {
        throw new DomainError(
          API_ERROR_CODES.AGENT_APPROVAL_REQUIRED,
          'Critical operation approval requires step-up',
          HttpStatus.FORBIDDEN,
        );
      }
      await this.authorization.consumeStepUp({
        token: parsed.data.stepUpToken,
        actor,
        purpose: 'agent-critical-operation',
        targetId: id,
        requestHash: parsed.data.requestHash,
      });
    }
    const [approved] = await this.db()
      .update(agentOperations)
      .set({
        status: 'approved',
        approvedBy: actor.sub,
        approvedAt: new Date(),
        approvalExpiresAt: new Date(Date.now() + APPROVAL_EXECUTION_TTL_MS),
        updatedAt: new Date(),
      })
      .where(and(eq(agentOperations.id, id), eq(agentOperations.status, 'approval_required')))
      .returning();
    if (!approved) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent operation was approved concurrently',
        HttpStatus.CONFLICT,
      );
    }
    return publicOperation(approved);
  }

  async deny(id: string, actor: AuthenticatedUser) {
    this.authorization.assertGovernanceActor(actor);
    const [row] = await this.db()
      .update(agentOperations)
      .set({
        status: 'denied',
        approvedBy: actor.sub,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentOperations.id, id),
          eq(agentOperations.organizationId, actor.organizationId),
          inArray(agentOperations.status, ['prepared', 'approval_required', 'approved']),
        ),
      )
      .returning();
    if (!row)
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        'Agent operation was not found or cannot be denied',
        HttpStatus.NOT_FOUND,
      );
    return publicOperation(row);
  }

  async cancel(id: string, principal: AgentPrincipal) {
    const [row] = await this.db()
      .update(agentOperations)
      .set({ status: 'cancelled', completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(agentOperations.id, id),
          eq(agentOperations.connectionId, principal.connectionId),
          eq(agentOperations.organizationId, principal.organizationId),
          inArray(agentOperations.status, ['prepared', 'approval_required', 'approved']),
        ),
      )
      .returning();
    if (!row)
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent operation cannot be cancelled',
        HttpStatus.CONFLICT,
      );
    return publicOperation(row);
  }

  async verify(id: string, payload: unknown, principal: AgentPrincipal, traceId: string) {
    const parsed = AgentOperationVerificationSchema.safeParse(payload);
    if (!parsed.success) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Agent operation verification is invalid',
        HttpStatus.BAD_REQUEST,
      );
    }
    const [row] = await this.db()
      .select()
      .from(agentOperations)
      .where(
        and(
          eq(agentOperations.id, id),
          eq(agentOperations.connectionId, principal.connectionId),
          eq(agentOperations.organizationId, principal.organizationId),
        ),
      )
      .limit(1);
    if (!row || !['succeeded', 'queued', 'unknown'].includes(row.status)) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent operation is not ready for verification',
        HttpStatus.CONFLICT,
      );
    }
    const clientReportedStatus = parsed.data.verificationStatus;
    const updated = await this.db().transaction(async (tx) => {
      const [verificationAudit] = await tx
        .insert(auditLogs)
        .values({
          organizationId: principal.organizationId,
          actorId: principal.connectionId,
          actorType: 'agent',
          action: `${row.actionId}.verify`,
          resourceType: 'agent-operation-verification',
          resourceId: row.id,
          before: { verificationStatus: row.verificationStatus },
          after: {
            verificationStatus: 'unverified',
            clientReportedStatus,
            evidenceHash: parsed.data.evidenceHash,
            evidenceKind: parsed.data.evidenceKind,
          },
          traceId,
        })
        .returning({ id: auditLogs.id });
      const [recorded] = await tx
        .update(agentOperations)
        .set({
          verificationStatus: sql`case when ${agentOperations.verificationStatus} = 'verified' then 'verified' else 'unverified' end`,
          domainAuditIds: [
            ...row.domainAuditIds,
            ...(verificationAudit ? [verificationAudit.id] : []),
          ],
          redactedResult: {
            ...(row.redactedResult ?? {}),
            verification: {
              attestation: 'client-reported',
              reportedStatus: clientReportedStatus,
              evidenceHash: parsed.data.evidenceHash,
              evidenceKind: parsed.data.evidenceKind,
            },
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentOperations.id, row.id),
            eq(agentOperations.verificationStatus, row.verificationStatus),
          ),
        )
        .returning();
      if (!recorded) {
        throw new DomainError(
          API_ERROR_CODES.AGENT_OPERATION_STALE,
          'Agent verification was recorded concurrently',
          HttpStatus.CONFLICT,
        );
      }
      return recorded;
    });
    return publicOperation(updated);
  }

  async reconcile(id: string, principal: AgentPrincipal) {
    await this.get(id, principal);
    const [row] = await this.db().select().from(agentOperations).where(eq(agentOperations.id, id)).limit(1);
    if (!row || row.verificationStatus === 'verified') return row ? publicOperation(row) : this.get(id, principal);
    let terminal: { status: 'succeeded' | 'failed'; verificationStatus: 'verified' | 'failed' } | undefined;
    let evidence: Record<string, unknown> | undefined;
    const resultId = row.redactedResult?.id;
    if (row.status === 'queued' && typeof resultId === 'string') {
      if (['templates.html-imports.scan', 'templates.html-imports.retry'].includes(row.actionId)) {
        const [job] = await this.db().select().from(templateHtmlImports).where(and(
          eq(templateHtmlImports.id, resultId), eq(templateHtmlImports.organizationId, row.organizationId))).limit(1);
        if (job && ['ready', 'needs_review', 'committed'].includes(job.status)) terminal = { status: 'succeeded', verificationStatus: 'verified' };
        if (job && ['failed', 'cancelled', 'expired'].includes(job.status)) terminal = { status: 'failed', verificationStatus: 'failed' };
      }
      if (row.actionId === 'communications.notifications.queue') {
        const [job] = await this.db().select().from(notificationDeliveries).where(and(
          eq(notificationDeliveries.id, resultId), eq(notificationDeliveries.organizationId, row.organizationId))).limit(1);
        if (job?.status === 'sent') terminal = { status: 'succeeded', verificationStatus: 'verified' };
        if (job?.status === 'failed') terminal = { status: 'failed', verificationStatus: 'failed' };
      }
    }
    const homepage = row.redactedResult?.expectedHomepage as AgentHomepageExpectation | undefined;
    const expected = (row.redactedResult?.expectedPublic ?? homepage?.event) as AgentPublicExpectation | undefined;
    if (row.status === 'succeeded' && (expected || homepage)) {
      const verified = homepage
        ? await verifyAgentHomepageDelivery(homepage, process.env.PUBLIC_ORIGIN ?? process.env.PUBLIC_WEB_URL ?? '')
        : await verifyAgentPublicDelivery(expected!, process.env.PUBLIC_ORIGIN ?? process.env.PUBLIC_WEB_URL ?? '');
      evidence = verified;
      if (verified.verified) terminal = { status: 'succeeded', verificationStatus: 'verified' };
    }
    if (!terminal) return { ...publicOperation(row), reconciliation: evidence ?? { verified: false, reason: 'AWAITING_DOMAIN_RESULT' } };
    const resolved = terminal;
    await this.db().transaction(async (tx) => {
      const [current] = await tx.select().from(agentOperations).where(eq(agentOperations.id, id)).for('update').limit(1);
      if (!current || current.status !== row.status || current.verificationStatus === 'verified') return;
      if (homepage) {
        const [organization] = await tx.select().from(organizations).where(eq(organizations.id, row.organizationId)).for('update').limit(1);
        const [binding] = await tx.select().from(organizationHomepageEvents).where(eq(organizationHomepageEvents.organizationId, row.organizationId)).for('update').limit(1);
        const settings = organization?.settings.homepage;
        if ((settings?.mode ?? (binding ? 'event' : 'empty')) !== homepage.mode ||
          (settings?.revision ?? 0) !== homepage.revision || (binding?.eventId ?? null) !== homepage.eventId) return;
      }
      if (expected) {
        const [event] = await tx.select().from(events).where(and(eq(events.id, expected.eventId),
          eq(events.organizationId, row.organizationId))).for('update').limit(1);
        if (event?.settings.currentReleaseId !== expected.releaseId) return;
        if (isPublicEventStatus(event.status) !== (expected.public !== false)) return;
      }
      await tx.update(agentOperations).set({ ...resolved, completedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentOperations.id, id));
      await tx.insert(auditLogs).values({ organizationId: row.organizationId, actorId: row.connectionId,
        actorType: 'agent', action: 'agent.operation.server-reconciled', resourceType: 'agent-operation',
        resourceId: id, before: { status: row.status, verificationStatus: row.verificationStatus },
        after: { ...resolved, ...(evidence ? { evidence } : {}) }, traceId: row.traceId });
    });
    return this.get(id, principal);
  }

  async readOneTimeSecret(id: string, principal: AgentPrincipal) {
    const [row] = await this.db()
      .select()
      .from(agentOperations)
      .where(
        and(
          eq(agentOperations.id, id),
          eq(agentOperations.connectionId, principal.connectionId),
          eq(agentOperations.organizationId, principal.organizationId),
        ),
      )
      .limit(1);
    if (
      !row ||
      row.status !== 'succeeded' ||
      row.executionStrategy !== 'one-time-secret' ||
      row.oneTimeSecretClaimedAt ||
      !row.oneTimeSecretCiphertext ||
      !row.oneTimeSecretExpiresAt ||
      row.oneTimeSecretExpiresAt.getTime() <= Date.now()
    ) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent one-time secret is unavailable, expired, or already acknowledged',
        HttpStatus.GONE,
      );
    }
    try {
      return JSON.parse(this.openEscrowSecret(row.oneTimeSecretCiphertext)) as unknown;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent one-time secret escrow payload is invalid',
        HttpStatus.GONE,
      );
    }
  }

  async acknowledgeOneTimeSecret(id: string, principal: AgentPrincipal) {
    const [row] = await this.db()
      .select({
        id: agentOperations.id,
        claimedAt: agentOperations.oneTimeSecretClaimedAt,
        strategy: agentOperations.executionStrategy,
      })
      .from(agentOperations)
      .where(
        and(
          eq(agentOperations.id, id),
          eq(agentOperations.connectionId, principal.connectionId),
          eq(agentOperations.organizationId, principal.organizationId),
        ),
      )
      .limit(1);
    if (!row || row.strategy !== 'one-time-secret') {
      throw new DomainError(
        API_ERROR_CODES.NOT_FOUND,
        'Agent one-time secret operation was not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (row.claimedAt) return { acknowledged: true, claimedAt: row.claimedAt };
    const now = new Date();
    const [acknowledged] = await this.db()
      .update(agentOperations)
      .set({
        oneTimeSecretCiphertext: null,
        oneTimeSecretClaimedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentOperations.id, id),
          eq(agentOperations.connectionId, principal.connectionId),
          eq(agentOperations.organizationId, principal.organizationId),
          eq(agentOperations.executionStrategy, 'one-time-secret'),
          isNull(agentOperations.oneTimeSecretClaimedAt),
        ),
      )
      .returning({ claimedAt: agentOperations.oneTimeSecretClaimedAt });
    if (!acknowledged) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent one-time secret acknowledgement changed concurrently',
        HttpStatus.CONFLICT,
      );
    }
    return { acknowledged: true, claimedAt: acknowledged.claimedAt };
  }

  async runAtomically<T>(input: {
    operationId: string; principal: AgentPrincipal; actor: AuthenticatedUser; traceId: string;
  }, work: () => Promise<T>): Promise<T> {
    return this.database.withAgentTransaction({
      operationId: input.operationId, connectionId: input.principal.connectionId,
      delegatedUserId: input.principal.delegatedUserId, traceId: input.traceId,
    }, async () => {
      const [connection] = await this.db().select().from(agentConnections)
        .where(and(eq(agentConnections.id, input.principal.connectionId),
          eq(agentConnections.organizationId, input.principal.organizationId)))
        .for('update').limit(1);
      if (!connection || connection.status !== 'active' || connection.expiresAt <= new Date() ||
        !input.principal.scopes.every((scope) => connection.scopes.includes(scope))) {
        throw new DomainError(API_ERROR_CODES.AGENT_CONNECTION_REVOKED,
          'Agent delegation changed before execution', HttpStatus.FORBIDDEN);
      }
      const [membership] = await this.db().select().from(memberships)
        .where(eq(memberships.id, connection.membershipId)).for('update').limit(1);
      const [user] = await this.db().select().from(users)
        .where(eq(users.id, connection.delegatedUserId)).for('update').limit(1);
      const [profile] = await this.db().select().from(memberProfiles)
        .where(and(eq(memberProfiles.userId, connection.delegatedUserId),
          eq(memberProfiles.organizationId, connection.organizationId))).for('update').limit(1);
      if (!membership || !user || membership.status !== 'active' ||
        membership.updatedAt.toISOString() !== connection.delegatedMembershipVersion ||
        staffCredentialVersion(user, staffCredentialRevision(profile?.preferences)) !== connection.delegatedCredentialVersion ||
        input.actor.credentialVersion !== connection.delegatedCredentialVersion) {
        throw new DomainError(API_ERROR_CODES.AGENT_CONNECTION_REVOKED,
          'Administrator authorization changed before execution', HttpStatus.FORBIDDEN);
      }
      return work();
    }).catch((error: unknown) => {
      if (error instanceof DomainError) throw error;
      const failure = error as { code?: string; cause?: { code?: string } };
      if (['40001', '40P01'].includes(failure.code ?? failure.cause?.code ?? '')) {
        throw new DomainError(API_ERROR_CODES.AGENT_OPERATION_STALE,
          'Concurrent changes prevented this operation; prepare it again', HttpStatus.CONFLICT);
      }
      throw new DomainError('AGENT_EXECUTION_FAILED',
        'Agent operation could not be committed', HttpStatus.INTERNAL_SERVER_ERROR,
        { retryable: false, next: 'Inspect the operation status before continuing.' });
    });
  }

  async beginExecution(input: {
    id: string;
    principal: AgentPrincipal;
    actionId: string;
    requestHash: string;
    beforeFingerprint: string;
    currentStateToken?: string;
    currentTarget: Record<string, string>;
    requestBody: Record<string, unknown>;
    grants: string[];
    idempotencyKey: string;
  }) {
    const now = new Date();
    const [row] = await this.db()
      .select()
      .from(agentOperations)
      .where(
        and(
          eq(agentOperations.id, input.id),
          eq(agentOperations.connectionId, input.principal.connectionId),
          eq(agentOperations.organizationId, input.principal.organizationId),
        ),
      )
      .limit(1);
    if (!row || row.actionId !== input.actionId) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent operation does not match this action',
        HttpStatus.CONFLICT,
      );
    }
    const targetFingerprint = sha256(stableCanonicalJson(normalizedTarget(input.currentTarget)));
    const preconditionMode = row.targetSummary[PRECONDITION_MODE_KEY];
    const currentObservation =
      preconditionMode === 'server-observed'
        ? this.verifiedStateObservation({
            token: input.currentStateToken,
            principal: input.principal,
            expectedActionId: AGENT_ACTION_MAP.get(row.actionId)!.verifyActionId!,
            expectedTargetFingerprint: targetFingerprint,
          })
        : undefined;
    if (currentObservation) {
      const action = AGENT_ACTION_MAP.get(row.actionId)!;
      const current = await captureAgentResourceState(this.db(), action.verifyActionId!,
        input.principal.organizationId, input.currentTarget, true);
      if (current === undefined || sha256(stableCanonicalJson(current)) !== row.beforeFingerprint) {
        throw new DomainError(API_ERROR_CODES.AGENT_OPERATION_STALE,
          'The resource changed after approval; prepare a new operation', HttpStatus.CONFLICT);
      }
    }
    this.policy.authorize({ action: AGENT_ACTION_MAP.get(row.actionId)!, principal: input.principal,
      grants: input.grants, impact: deriveAgentImpactSummary(input.requestBody) });
    const expectedImpact = {
      ...deriveAgentImpactSummary(input.requestBody),
      precondition: currentObservation ? 'server-observed' : 'not-applicable',
    };
    if (
      row.status !== 'approved' ||
      !row.approvalExpiresAt ||
      row.approvalExpiresAt < now ||
      row.requestHash !== input.requestHash ||
      row.idempotencyKey !== input.idempotencyKey ||
      row.beforeFingerprint !== input.beforeFingerprint ||
      (currentObservation && row.beforeFingerprint !== currentObservation.stateFingerprint) ||
      row.targetSummary[TARGET_FINGERPRINT_KEY] !== targetFingerprint ||
      stableCanonicalJson(row.redactedDiff) !==
        stableCanonicalJson(agentApprovalProjection(input.requestBody)) ||
      stableCanonicalJson(row.impactSummary) !== stableCanonicalJson(expectedImpact)
    ) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent operation is stale or its approval expired',
        HttpStatus.CONFLICT,
      );
    }
    const [started] = await this.db()
      .update(agentOperations)
      .set({ status: 'executing', executionStartedAt: now, updatedAt: now })
      .where(and(eq(agentOperations.id, row.id), eq(agentOperations.status, 'approved')))
      .returning();
    if (!started) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_IDEMPOTENCY_CONFLICT,
        'Agent operation is already executing',
        HttpStatus.CONFLICT,
      );
    }
    return started;
  }

  async finishExecution(
    id: string,
    input: {
      status: 'succeeded' | 'failed' | 'unknown' | 'queued';
      responseStatus?: number;
      redactedResult?: Record<string, unknown>;
      verificationStatus?: 'pending' | 'verified' | 'unverified' | 'failed';
      actionId: string;
      connectionId: string;
      organizationId: string;
      delegatedUserId: string;
      traceId: string;
      target: Record<string, unknown>;
      oneTimeSecretResult?: unknown;
    },
  ) {
    const now = new Date();
    const escrowCiphertext =
      input.oneTimeSecretResult === undefined
        ? undefined
        : sealSecret(JSON.stringify(input.oneTimeSecretResult ?? null), this.escrowSecrets()[0]!);
    let expectedPublic: AgentPublicExpectation | undefined;
    let expectedHomepage: AgentHomepageExpectation | undefined;
    let eventId = Number(input.target.eventId);
    if (input.status === 'succeeded' && input.actionId.startsWith('organization.homepage')) {
      const [organization] = await this.db().select().from(organizations).where(eq(organizations.id, input.organizationId)).limit(1);
      const [binding] = await this.db().select().from(organizationHomepageEvents).where(eq(organizationHomepageEvents.organizationId, input.organizationId)).limit(1);
      if (organization) {
        const settings = organization.settings.homepage;
        expectedHomepage = { organizationId: input.organizationId, organizationSlug: organization.slug,
          mode: settings?.mode ?? (binding ? 'event' : 'empty'), revision: settings?.revision ?? 0, eventId: binding?.eventId ?? null };
        eventId = binding?.eventId ?? 0;
      }
    }
    if (input.status === 'succeeded' && Number.isSafeInteger(eventId) && eventId > 0) {
      const [scope] = await this.db().select({ event: events, organizationSlug: organizations.slug })
        .from(events).innerJoin(organizations, eq(organizations.id, events.organizationId))
        .where(and(eq(events.id, eventId), eq(events.organizationId, input.organizationId))).limit(1);
      const releaseId = scope?.event.settings.currentReleaseId;
      if (typeof releaseId === 'string') expectedPublic = { eventId, organizationId: input.organizationId,
        organizationSlug: scope!.organizationSlug, eventSlug: scope!.event.slug, releaseId,
        public: isPublicEventStatus(scope!.event.status) };
    }
    if (expectedHomepage && expectedPublic && expectedHomepage.mode === 'event') expectedHomepage.event = expectedPublic;
    const serverVerified = input.status === 'succeeded' && !expectedPublic && !expectedHomepage;
    await this.db().transaction(async (tx) => {
      const [audit] = await tx
        .insert(auditLogs)
        .values({
          organizationId: input.organizationId,
          actorId: input.connectionId,
          actorType: 'agent',
          action: input.actionId,
          resourceType: 'agent-operation',
          resourceId: id,
          before: { delegatedUserId: input.delegatedUserId },
          after: { status: input.status, target: input.target },
          traceId: input.traceId,
        })
        .returning({ id: auditLogs.id });
      const [updated] = await tx
        .update(agentOperations)
        .set({
          status: input.status,
          responseStatus: input.responseStatus,
          redactedResult: { ...input.redactedResult, ...(expectedHomepage ? { expectedHomepage } : expectedPublic ? { expectedPublic } : {}) },
          oneTimeSecretCiphertext: escrowCiphertext,
          oneTimeSecretExpiresAt: escrowCiphertext
            ? new Date(now.getTime() + ONE_TIME_SECRET_ESCROW_TTL_MS)
            : undefined,
          verificationStatus:
            input.verificationStatus ?? (serverVerified ? 'verified' : 'pending'),
          completedAt: ['succeeded', 'failed'].includes(input.status) ? now : undefined,
          domainAuditIds: [...(this.database.agentAuditIds ?? []), ...(audit ? [audit.id] : [])],
          updatedAt: now,
        })
        .where(
          and(
            eq(agentOperations.id, id),
            eq(agentOperations.connectionId, input.connectionId),
            eq(agentOperations.organizationId, input.organizationId),
            eq(agentOperations.status, 'executing'),
          ),
        )
        .returning({ id: agentOperations.id });
      if (!updated) {
        throw new DomainError(
          API_ERROR_CODES.AGENT_OPERATION_STALE,
          'Agent operation execution state changed concurrently',
          HttpStatus.CONFLICT,
        );
      }
    });
  }

  async recordRead(input: {
    actionId: string;
    organizationId: string;
    connectionId: string;
    delegatedUserId: string;
    dataClass: string;
    risk: string;
    purpose?: string;
    traceId: string;
  }) {
    await this.db()
      .insert(auditLogs)
      .values({
        organizationId: input.organizationId,
        actorId: input.connectionId,
        actorType: 'agent',
        action: input.actionId,
        resourceType: 'agent-read',
        resourceId: input.actionId,
        before: { delegatedUserId: input.delegatedUserId },
        after: {
          dataClass: input.dataClass,
          risk: input.risk,
          purpose: input.purpose ?? null,
        },
        traceId: input.traceId,
      });
  }
}
