import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { API_ERROR_CODES, AgentOperationExecuteHeadersSchema } from '@conference/contracts';
import { sha256, stableCanonicalJson } from '@conference/security';
import { catchError, from, map, mergeMap, throwError } from 'rxjs';
import { DomainError } from './domain-error.js';
import { agentRequestTarget } from './agent-operation-catalog.js';
import { AgentPolicyService } from './agent-policy.service.js';
import { AgentOperationService } from './agent-operation.service.js';
import type { AgentPrincipal } from './agent-principal.service.js';
import type { AuthenticatedUser } from './auth.guard.js';

type AgentRequest = FastifyRequest & {
  user?: AuthenticatedUser;
  agentPrincipal?: AgentPrincipal;
};

function safeResult(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { completed: true };
  const record = value as Record<string, unknown>;
  const allow = ['id', 'status', 'version', 'revision', 'queued', 'createdAt', 'updatedAt'];
  return Object.fromEntries(allow.filter((key) => key in record).map((key) => [key, record[key]]));
}

function safeTarget(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('__')));
}

const AGENT_MASKED_PII_KEYS = new Set([
  'address',
  'attendee',
  'attendeecompany',
  'attendeeemail',
  'attendeemobile',
  'attendeename',
  'bankaccount',
  'bankname',
  'buyername',
  'company',
  'companyname',
  'contact',
  'contactname',
  'email',
  'displaycompany',
  'displayname',
  'fullname',
  'idcard',
  'invoicetitle',
  'mobile',
  'name',
  'nickname',
  'phone',
  'realname',
  'recipient',
  'recipientname',
  'taxid',
  'taxnumber',
  'title',
]);
const AGENT_MASKED_PII_CONTAINERS = new Set(['answers', 'attendee', 'formanswers']);

function maskPiiScalar(key: string, value: unknown, forceMask = false) {
  if (value === null || value === undefined || value === '') return value;
  const normalizedKey = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
  if (normalizedKey.startsWith('masked')) return value;
  if (
    !AGENT_MASKED_PII_KEYS.has(normalizedKey) &&
    !normalizedKey.includes('mobile') &&
    !normalizedKey.includes('phone') &&
    !normalizedKey.includes('email') &&
    !normalizedKey.includes('address') &&
    !forceMask
  ) {
    return value;
  }
  if (typeof value !== 'string') return '[masked]';
  if (normalizedKey.includes('mobile') || normalizedKey.includes('phone')) {
    const suffix = value.replace(/\D/gu, '').slice(-4);
    return suffix ? `***${suffix}` : '[masked]';
  }
  if (normalizedKey.includes('email')) {
    const at = value.indexOf('@');
    return at > 0 ? `${value.slice(0, 1)}***${value.slice(at)}` : '[masked]';
  }
  if (
    normalizedKey === 'name' ||
    normalizedKey.endsWith('name') ||
    normalizedKey === 'title' ||
    normalizedKey === 'invoicetitle'
  ) {
    return `${Array.from(value)[0] ?? ''}**`;
  }
  return '[masked]';
}

function sanitizePiiRead(value: unknown, key = '', forceMask = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizePiiRead(entry, key, forceMask));
  if (!value || typeof value !== 'object') return maskPiiScalar(key, value, forceMask);
  const normalizedKey = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
  const maskChildren = forceMask || AGENT_MASKED_PII_CONTAINERS.has(normalizedKey);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizePiiRead(entryValue, entryKey, maskChildren),
    ]),
  );
}

const ASYNC_OPERATION_STATUSES = new Set([
  'accepted',
  'claimed',
  'pending',
  'processing',
  'queued',
  'retrying',
  'sending',
]);

function executionOutcome(action: { idempotencyStrategy?: string | undefined }, result: unknown) {
  if (!result || typeof result !== 'object') return 'succeeded' as const;
  const record = result as Record<string, unknown>;
  if (record.queued === true) return 'queued' as const;
  return action.idempotencyStrategy === 'outbox-job' &&
    ASYNC_OPERATION_STATUSES.has(String(record.status ?? '').toLowerCase())
    ? ('queued' as const)
    : ('succeeded' as const);
}

@Injectable()
export class AgentOperationInterceptor implements NestInterceptor {
  constructor(
    @Inject(AgentPolicyService) private readonly policy: AgentPolicyService,
    @Inject(AgentOperationService) private readonly operations: AgentOperationService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<AgentRequest>();
    if (!request.agentPrincipal || !request.user) return next.handle();
    const path = String(request.url).split('?')[0] ?? '/';
    if (path.startsWith('/api/v1/agent/') || path === '/api/v1/oauth/revoke') {
      return next.handle();
    }
    const action = this.policy.actionForRequest(request);
    this.policy.authorize({
      action,
      principal: request.agentPrincipal,
      grants: request.user.grants,
    });
    if (action.method === 'GET' && action.confirmation === 'none') {
      const response = context.switchToHttp().getResponse<FastifyReply>();
      const purposeHeader = request.headers['x-agent-purpose'];
      const purpose = Array.isArray(purposeHeader) ? purposeHeader[0] : purposeHeader;
      if (action.riskBase === 'sensitive-read' && (!purpose || purpose.trim().length < 8)) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Sensitive Agent reads require an explicit task purpose',
          HttpStatus.BAD_REQUEST,
        );
      }
      return next.handle().pipe(
        mergeMap((result) => {
          response.header(
            'X-Agent-State-Token',
            this.operations.createStateObservation({
              principal: request.agentPrincipal!,
              actionId: action.actionId,
              target: agentRequestTarget(action, String(request.url)),
              state: result,
            }),
          );
          const agentResult =
            action.dataClass === 'pii' && action.riskBase === 'read'
              ? sanitizePiiRead(result)
              : result;
          return from(
            this.operations.recordRead({
              actionId: action.actionId,
              organizationId: request.agentPrincipal!.organizationId,
              connectionId: request.agentPrincipal!.connectionId,
              delegatedUserId: request.agentPrincipal!.delegatedUserId,
              dataClass: action.dataClass,
              risk: action.riskBase,
              ...(purpose ? { purpose: purpose.trim() } : {}),
              traceId: String(request.id),
            }),
          ).pipe(map(() => agentResult));
        }),
      );
    }
    const operationId = String(request.headers['x-agent-operation-id'] ?? '');
    const requestHash = String(request.headers['x-agent-request-hash'] ?? '');
    const beforeFingerprint = String(request.headers['x-agent-before-fingerprint'] ?? '');
    const currentStateTokenHeader = request.headers['x-agent-current-state-token'];
    const currentStateToken = Array.isArray(currentStateTokenHeader)
      ? currentStateTokenHeader[0]
      : currentStateTokenHeader;
    const parsedHeaders = AgentOperationExecuteHeadersSchema.safeParse({
      operationId,
      requestHash,
      beforeFingerprint,
      currentStateToken,
    });
    if (!parsedHeaders.success) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_APPROVAL_REQUIRED,
        'Agent writes require a valid prepared operation and bound fingerprints',
        HttpStatus.FORBIDDEN,
      );
    }
    const actualRequestHash = sha256(stableCanonicalJson(request.body ?? {}));
    if (requestHash !== actualRequestHash) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_OPERATION_STALE,
        'Agent request body does not match the prepared operation',
        HttpStatus.CONFLICT,
      );
    }
    const begin = this.operations.beginExecution({
      id: parsedHeaders.data.operationId,
      principal: request.agentPrincipal,
      actionId: action.actionId,
      requestHash: parsedHeaders.data.requestHash,
      beforeFingerprint: parsedHeaders.data.beforeFingerprint,
      ...(parsedHeaders.data.currentStateToken
        ? { currentStateToken: parsedHeaders.data.currentStateToken }
        : {}),
      currentTarget: agentRequestTarget(action, String(request.url)),
      requestBody:
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {},
    });
    return from(begin).pipe(
      mergeMap((operation) =>
        next.handle().pipe(
          mergeMap((result) =>
            from(
              this.operations.finishExecution(operation.id, {
                status: executionOutcome(action, result),
                responseStatus: 200,
                redactedResult: safeResult(result),
                actionId: action.actionId,
                connectionId: request.agentPrincipal!.connectionId,
                organizationId: request.agentPrincipal!.organizationId,
                delegatedUserId: request.agentPrincipal!.delegatedUserId,
                traceId: String(request.id),
                target: safeTarget(operation.targetSummary),
                ...(action.idempotencyStrategy === 'one-time-secret'
                  ? { oneTimeSecretResult: result }
                  : {}),
              }),
            ).pipe(map(() => result)),
          ),
          catchError((error: unknown) => {
            const status =
              error && typeof error === 'object' && 'getStatus' in error
                ? Number((error as { getStatus(): number }).getStatus())
                : 500;
            return from(
              this.operations.finishExecution(operation.id, {
                status: status >= 500 ? 'unknown' : 'failed',
                responseStatus: status,
                redactedResult: {
                  code: error instanceof DomainError ? error.code : 'REQUEST_FAILED',
                },
                actionId: action.actionId,
                connectionId: request.agentPrincipal!.connectionId,
                organizationId: request.agentPrincipal!.organizationId,
                delegatedUserId: request.agentPrincipal!.delegatedUserId,
                traceId: String(request.id),
                target: safeTarget(operation.targetSummary),
              }),
            ).pipe(mergeMap(() => throwError(() => error)));
          }),
        ),
      ),
    );
  }
}
