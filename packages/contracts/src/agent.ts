import { z } from 'zod';

export const TOKEMS_AGENT_CLIENT_ID = 'tokems-admin-skill' as const;
export const TOKEMS_AGENT_API_VERSION = '1.0.0' as const;
export const TOKEMS_AGENT_CATALOG_VERSION = '1.2.0' as const;
export const TOKEMS_AGENT_SKILL_VERSION = '0.2.0' as const;
export const TOKEMS_AGENT_MIN_CLIENT_VERSION = '0.2.0' as const;

export const AgentScopeSchema = z.enum([
  'tokems:read',
  'tokems:pii',
  'tokems:write',
  'tokems:finance',
  'tokems:communications',
  'tokems:export',
  'tokems:security',
  'tokems:dangerous',
]);

export const AGENT_SCOPES = AgentScopeSchema.options;

export const AgentDataClassSchema = z.enum(['public', 'internal', 'pii', 'secret']);
export const AgentRiskSchema = z.enum([
  'read',
  'sensitive-read',
  'routine-write',
  'controlled',
  'critical',
]);
export const AgentApprovalPolicySchema = z.enum(['controlled-and-critical', 'critical-only']);
export const AgentIdempotencyStrategySchema = z.enum([
  'domain-key',
  'transactional-command',
  'outbox-job',
  'one-time-secret',
]);
export const AgentOperationStatusSchema = z.enum([
  'prepared',
  'approval_required',
  'approved',
  'executing',
  'queued',
  'succeeded',
  'failed',
  'unknown',
  'denied',
  'cancelled',
  'expired',
]);

export const AgentActionSchema = z.object({
  actionId: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  routeName: z.string().min(3).max(120),
  path: z.string().startsWith('/api/v1/'),
  requiredGrants: z.array(z.string().min(1)).min(1),
  agentScopes: z.array(AgentScopeSchema).min(1),
  dataClass: AgentDataClassSchema,
  riskBase: AgentRiskSchema,
  dynamicRiskPolicy: z.string().min(1).optional(),
  confirmation: z.enum(['none', 'intent', 'browser', 'step-up']),
  idempotencyStrategy: AgentIdempotencyStrategySchema.optional(),
  retryPolicy: z.enum(['safe', 'query-before-retry', 'never']).default('safe'),
  targetResolver: z.string().min(1),
  verifyActionId: z.string().min(1).optional(),
  reconcileActionId: z.string().min(1).optional(),
  rollback: z.string().min(1),
  minClientVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  description: z.string().min(1).max(500),
});

export const AgentFeatureFlagsSchema = z.object({
  access: z.boolean(),
  writes: z.boolean(),
  criticalActions: z.boolean(),
});

export const AgentCapabilityCatalogSchema = z.object({
  apiVersion: z.string(),
  catalogVersion: z.string(),
  skillPackageVersion: z.string(),
  minClientVersion: z.string(),
  resource: z.url(),
  adminOrigin: z.url(),
  organizationId: z.uuid(),
  connectionId: z.uuid(),
  features: AgentFeatureFlagsSchema,
  scopes: z.array(AgentScopeSchema),
  actions: z.array(AgentActionSchema),
});

export const AgentDeviceAuthorizationRequestSchema = z.object({
  client_id: z.literal(TOKEMS_AGENT_CLIENT_ID),
  resource: z.url(),
  scope: z.string().min(1),
  dpop_jkt: z.string().min(32).max(160),
  client_name: z.string().trim().min(1).max(120),
  skill_version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u),
});

export const AgentDeviceAuthorizationResponseSchema = z.object({
  device_code: z.string().min(32),
  user_code: z.string().min(8),
  verification_uri: z.url(),
  verification_uri_complete: z.url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});

export const AgentDeviceTokenRequestSchema = z.object({
  grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
  device_code: z.string().min(32),
  client_id: z.literal(TOKEMS_AGENT_CLIENT_ID),
});

export const AgentRefreshTokenRequestSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(32),
  client_id: z.literal(TOKEMS_AGENT_CLIENT_ID),
});

export const AgentTokenRequestSchema = z.discriminatedUnion('grant_type', [
  AgentDeviceTokenRequestSchema,
  AgentRefreshTokenRequestSchema,
]);

export const AgentTokenResponseSchema = z.object({
  access_token: z.string().min(32),
  token_type: z.literal('DPoP'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(32),
  scope: z.string(),
  connection_id: z.uuid(),
});

export const AgentStepUpRequestSchema = z.object({
  password: z.string().min(1).max(1024),
  purpose: z.enum([
    'agent-authorization',
    'agent-policy',
    'agent-critical-operation',
    'agent-revoke-all',
  ]),
  targetId: z.string().min(1).max(160),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const AgentAuthorizationDecisionSchema = z.object({
  scopes: z.array(AgentScopeSchema).min(1),
  approvalPolicy: AgentApprovalPolicySchema.default('controlled-and-critical'),
  userCode: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u),
  stepUpToken: z.string().min(32),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const AgentOperationPrepareSchema = z.object({
  actionId: AgentActionSchema.shape.actionId,
  target: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  reason: z.string().trim().min(8).max(1000),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  requestBody: z.record(z.string(), z.unknown()),
  beforeStateToken: z.string().min(32).max(4096).optional(),
  idempotencyKey: z.string().min(8).max(160).optional(),
});

export const AgentOperationConfirmSchema = z.object({
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  beforeFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const AgentOperationApprovalSchema = z.object({
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  beforeFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  stepUpToken: z.string().min(32).optional(),
});

export const AgentOperationVerificationSchema = z.object({
  verificationStatus: z.enum(['verified', 'unverified', 'failed']),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  evidenceKind: z.enum(['admin-api', 'public-page', 'job-status', 'audit-record']),
});

export const AgentOperationExecuteHeadersSchema = z.object({
  operationId: z.uuid(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  beforeFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  currentStateToken: z.string().min(32).max(4096).optional(),
});

export type AgentScope = z.infer<typeof AgentScopeSchema>;
export type AgentDataClass = z.infer<typeof AgentDataClassSchema>;
export type AgentRisk = z.infer<typeof AgentRiskSchema>;
export type AgentApprovalPolicy = z.infer<typeof AgentApprovalPolicySchema>;
export type AgentIdempotencyStrategy = z.infer<typeof AgentIdempotencyStrategySchema>;
export type AgentOperationStatus = z.infer<typeof AgentOperationStatusSchema>;
export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentFeatureFlags = z.infer<typeof AgentFeatureFlagsSchema>;
export type AgentCapabilityCatalog = z.infer<typeof AgentCapabilityCatalogSchema>;
