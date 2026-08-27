import { readFile } from 'node:fs/promises';
import { actionDefinition, actionPath } from './catalog.mjs';
import { authenticatedFetch, loadProfile } from './auth.mjs';
import { sha256, stableStringify } from './crypto.mjs';
import { fetchBound } from './http.mjs';
import {
  deletePending,
  downloadPendingArtifact,
  readPending,
  savePending,
  savePendingArtifact,
} from './files.mjs';
import { redact } from './redaction.mjs';

async function readJsonFile(path, fallback = {}) {
  if (!path) return fallback;
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Structured input file must contain one JSON object');
  }
  return value;
}

async function readReason(path) {
  if (!path) throw new Error('Agent writes require --reason-file');
  const value = (await readFile(path, 'utf8')).trim();
  if (value.length < 8 || value.length > 1_000) {
    throw new Error('Operation reason must contain 8 to 1000 characters');
  }
  return value;
}

async function readSecretHeaders(actionId, path) {
  if (!path) return {};
  if (actionId !== 'checkin.sync') {
    const error = new Error('--secret-file is unavailable for this catalog action');
    error.code = 'SECRET_FILE_UNSUPPORTED';
    throw error;
  }
  const raw = (await readFile(path, 'utf8')).trim();
  let token = raw;
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw);
    token = parsed.token || parsed.deviceToken || '';
  }
  if (typeof token !== 'string' || token.length < 32 || token.length > 512) {
    const error = new Error('Check-in device secret file is invalid');
    error.code = 'SECRET_FILE_INVALID';
    throw error;
  }
  return { 'X-Device-Token': token };
}

async function inspectPreState(action, params, connectionId) {
  const verifyId = action.verifyActionId || action.reconcileActionId;
  if (!verifyId) {
    return {
      value: { unavailable: true, reason: 'missing verify action' },
      stateToken: undefined,
    };
  }
  try {
    const { action: verifyAction } = await actionDefinition(verifyId, connectionId);
    const response = await authenticatedFetch(connectionId, actionPath(verifyAction, params), {
      headers:
        verifyAction.riskBase === 'sensitive-read'
          ? { 'X-Agent-Purpose': 'Verify approved Agent operation pre-state.' }
          : undefined,
    });
    return {
      value: response.value,
      stateToken: response.response.headers.get('x-agent-state-token') || undefined,
    };
  } catch {
    return {
      value: { unavailable: true, reason: 'verify action unavailable before execution' },
      stateToken: undefined,
    };
  }
}

const PUBLIC_EVENT_ACTIONS = new Set([
  'attendee-needs.moderate',
  'attendee-needs.update',
  'content.registration-forms.publish',
  'events.public-url.update',
  'events.releases.publish',
  'events.releases.rollback',
  'templates.event-binding.update',
]);

export function validateOperationInput(actionId, params, body) {
  if (['attendee-needs.update', 'attendee-needs.moderate'].includes(actionId)) {
    if (!Number.isInteger(body.version) || body.version < 1) {
      const error = new Error('Attendee-needs writes require a positive version');
      error.code = 'ATTENDEE_NEEDS_VERSION_REQUIRED';
      throw error;
    }
    if (typeof body.reason !== 'string' || body.reason.trim().length < 1) {
      const error = new Error('Attendee-needs writes require a reason in the request body');
      error.code = 'ATTENDEE_NEEDS_REASON_REQUIRED';
      throw error;
    }
  }
  if (actionId === 'attendee-needs.export') {
    const variant = params.variant ?? 'speaker';
    const forceAnonymous = params.forceAnonymous ?? true;
    if (
      variant === 'speaker' &&
      forceAnonymous !== true &&
      String(forceAnonymous).toLowerCase() !== 'true'
    ) {
      const error = new Error('Speaker attendee-needs exports must set forceAnonymous=true');
      error.code = 'ATTENDEE_NEEDS_SPEAKER_EXPORT_REQUIRES_ANONYMITY';
      throw error;
    }
  }
}

function requiresPublicDeliveryVerification(action, pending) {
  if (
    ['organization.homepage-event.update', 'organization.settings.update'].includes(action.actionId)
  ) {
    return 'homepage';
  }
  if (!pending.params?.eventId) return undefined;
  if (PUBLIC_EVENT_ACTIONS.has(action.actionId)) return 'event';
  if (
    action.dynamicRiskPolicy === 'published-event-upgrade' &&
    ['controlled', 'critical'].includes(pending.operationRisk)
  ) {
    return 'event';
  }
  return undefined;
}

function responseDigest(response) {
  const bytes =
    response.value instanceof ArrayBuffer
      ? Buffer.from(response.value)
      : Buffer.from(stableStringify(response.value), 'utf8');
  return {
    status: response.response.status,
    contentType: response.response.headers.get('content-type') ?? undefined,
    etag: response.response.headers.get('etag') ?? undefined,
    sha256: sha256(bytes),
    size: bytes.byteLength,
  };
}

async function publicDeliveryVerification(action, pending, connectionId) {
  const kind = requiresPublicDeliveryVerification(action, pending);
  if (!kind) return { status: 'not-applicable' };
  const profile = loadProfile(connectionId);
  try {
    const { action: settingsAction } = await actionDefinition(
      'organization.settings.get',
      profile.connectionId,
    );
    const { value: organization } = await authenticatedFetch(
      profile.connectionId,
      actionPath(settingsAction, {}),
    );
    if (!organization?.slug) throw new Error('Organization slug is unavailable');
    const headers = { 'X-Organization-Slug': String(organization.slug) };
    if (kind === 'homepage') {
      const [api, document] = await Promise.all([
        fetchBound(profile.origin, '/api/v1/homepage', { headers }),
        fetchBound(profile.origin, '/api/v1/homepage/home-document', { headers }),
      ]);
      return {
        status: 'verified',
        kind: 'public-page',
        route: '/api/v1/homepage',
        api: responseDigest(api),
        document: responseDigest(document),
      };
    }
    const { action: eventAction } = await actionDefinition('events.get', profile.connectionId);
    const { value: event } = await authenticatedFetch(
      profile.connectionId,
      actionPath(eventAction, { eventId: pending.params.eventId }),
    );
    if (!event?.slug) throw new Error('Event slug is unavailable');
    const eventPath = `/api/v1/events/${encodeURIComponent(String(event.slug))}`;
    const attendeeNeedsPath = `${eventPath}/attendee-needs?page=1`;
    const [api, document, attendeeNeeds] = await Promise.all([
      fetchBound(profile.origin, eventPath, { headers }),
      fetchBound(profile.origin, `${eventPath}/home-document`, { headers }),
      ['attendee-needs.update', 'attendee-needs.moderate'].includes(action.actionId)
        ? fetchBound(profile.origin, attendeeNeedsPath, { headers })
        : undefined,
    ]);
    return {
      status: 'verified',
      kind: 'public-page',
      route: eventPath,
      api: responseDigest(api),
      document: responseDigest(document),
      ...(attendeeNeeds ? { attendeeNeeds: responseDigest(attendeeNeeds) } : {}),
    };
  } catch (error) {
    return {
      status: 'unverified',
      kind: 'public-page',
      code: error?.code || 'PUBLIC_DELIVERY_VERIFY_FAILED',
    };
  }
}

export async function prepareOperation({
  actionId,
  params,
  inputFile,
  input,
  reasonFile,
  secretFile,
  connectionId,
}) {
  const profile = loadProfile(connectionId);
  const { action } = await actionDefinition(actionId, profile.connectionId);
  if (action.method === 'GET' && action.confirmation === 'none') {
    throw new Error('Read-only actions use action inspect and do not create operations');
  }
  if (inputFile && input !== undefined) {
    throw new Error('Use either inputFile or input for an operation, not both');
  }
  const body = input === undefined ? await readJsonFile(inputFile, {}) : input;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Structured operation input must contain one JSON object');
  }
  validateOperationInput(actionId, params, body);
  const reason = await readReason(reasonFile);
  const secretHeaders = await readSecretHeaders(actionId, secretFile);
  const beforeObservation = await inspectPreState(action, params, profile.connectionId);
  const requestHash = sha256(stableStringify(body));
  const idempotencyKey = `agent-${crypto.randomUUID()}`;
  const { value: operation } = await authenticatedFetch(
    profile.connectionId,
    '/api/v1/agent/operations',
    {
      method: 'POST',
      body: JSON.stringify({
        actionId,
        target: Object.fromEntries(
          Object.entries(params)
            .filter(
              ([key, value]) =>
                !key.startsWith('_') &&
                value !== undefined &&
                value !== null &&
                (Array.isArray(value) || ['string', 'number', 'boolean'].includes(typeof value)),
            )
            .map(([key, value]) => [
              key,
              Array.isArray(value) ? value.map(String).join(',') : String(value),
            ]),
        ),
        reason,
        requestHash,
        requestBody: body,
        beforeStateToken: beforeObservation.stateToken,
        idempotencyKey,
      }),
    },
  );
  await savePending(
    operation.id,
    profile.connectionId,
    {
      actionId,
      params,
      body,
      requestHash,
      beforeFingerprint: operation.beforeFingerprint,
      idempotencyKey,
      secretHeaders,
      operationRisk: operation.risk,
      expiresAt: operation.expiresAt,
    },
    profile.dataKey,
  );
  return {
    operation,
    approvalUrl:
      operation.status === 'approval_required'
        ? `${profile.adminOrigin.replace(/\/+$/u, '')}/agent-operations/${operation.id}`
        : undefined,
  };
}

export async function confirmOperation(operationId, connectionId) {
  const profile = loadProfile(connectionId);
  const pending = await readPending(operationId, profile.connectionId, profile.dataKey);
  try {
    const { value } = await authenticatedFetch(
      profile.connectionId,
      `/api/v1/agent/operations/${encodeURIComponent(operationId)}/confirm`,
      {
        method: 'POST',
        body: JSON.stringify({
          requestHash: pending.requestHash,
          beforeFingerprint: pending.beforeFingerprint,
        }),
      },
    );
    return { operation: value };
  } catch (error) {
    if (error.code !== 'AGENT_APPROVAL_REQUIRED') throw error;
    return {
      operation: await operationStatus(operationId, profile.connectionId),
      approvalRequired: true,
      approvalUrl: `${profile.adminOrigin.replace(/\/+$/u, '')}/agent-operations/${operationId}`,
    };
  }
}

export async function operationStatus(operationId, connectionId) {
  const { value } = await authenticatedFetch(
    connectionId,
    `/api/v1/agent/operations/${encodeURIComponent(operationId)}`,
  );
  if (['failed', 'cancelled', 'denied', 'expired'].includes(value.status)) {
    await deletePending(operationId);
  }
  return value;
}

export async function executeOperation(operationId, connectionId) {
  const profile = loadProfile(connectionId);
  const pending = await readPending(operationId, profile.connectionId, profile.dataKey);
  const { action } = await actionDefinition(pending.actionId, profile.connectionId);
  const path = actionPath(action, pending.params);
  const currentObservation = await inspectPreState(action, pending.params, profile.connectionId);
  let response;
  let executionError;
  try {
    response = await authenticatedFetch(profile.connectionId, path, {
      method: action.method,
      headers: {
        'Idempotency-Key': pending.idempotencyKey,
        'X-Agent-Operation-Id': operationId,
        'X-Agent-Request-Hash': pending.requestHash,
        'X-Agent-Before-Fingerprint': pending.beforeFingerprint,
        ...(currentObservation.stateToken
          ? { 'X-Agent-Current-State-Token': currentObservation.stateToken }
          : {}),
        ...(pending.secretHeaders ?? {}),
      },
      ...(['GET', 'DELETE'].includes(action.method) ? {} : { body: JSON.stringify(pending.body) }),
      timeout: 60_000,
    });
  } catch (error) {
    executionError = { code: error.code, message: error.message };
  }
  let operation = await operationStatus(operationId, profile.connectionId).catch(() => ({
    id: operationId,
    status: 'unknown',
    verificationStatus: 'unverified',
  }));
  if (
    !response &&
    !(action.idempotencyStrategy === 'one-time-secret' && operation.status === 'succeeded')
  ) {
    return { operation, error: executionError };
  }
  let artifact;
  let escrowAcknowledgement;
  if (action.idempotencyStrategy === 'one-time-secret') {
    try {
      const { value: escrow } = await authenticatedFetch(
        profile.connectionId,
        `/api/v1/agent/operations/${encodeURIComponent(operationId)}/one-time-secret`,
      );
      artifact = await savePendingArtifact(
        operationId,
        profile.connectionId,
        Buffer.from(JSON.stringify(escrow, null, 2), 'utf8'),
        profile.dataKey,
        'application/json; charset=utf-8',
      );
      try {
        await authenticatedFetch(
          profile.connectionId,
          `/api/v1/agent/operations/${encodeURIComponent(operationId)}/one-time-secret/acknowledge`,
          { method: 'POST', body: JSON.stringify({}) },
        );
        escrowAcknowledgement = 'acknowledged';
      } catch (error) {
        escrowAcknowledgement = `artifact saved; acknowledgement pending (${error.code || 'ACK_FAILED'})`;
      }
    } catch (error) {
      return {
        operation,
        error: {
          code: error.code || 'ONE_TIME_SECRET_RECOVERY_FAILED',
          message: error.message,
        },
      };
    }
  } else if (response?.value instanceof ArrayBuffer) {
    artifact = await savePendingArtifact(
      operationId,
      profile.connectionId,
      Buffer.from(response.value),
      profile.dataKey,
      response.response.headers.get('content-type'),
    );
  }
  operation = await operationStatus(operationId, profile.connectionId);
  let verification = { status: operation.verificationStatus || 'unverified' };
  if (operation.status === 'succeeded' && action.verifyActionId) {
    const afterObservation = await inspectPreState(
      action,
      pending.params,
      profile.connectionId,
    ).catch(() => undefined);
    const after = afterObservation?.value;
    const adminVerified = Boolean(after && !after.unavailable && afterObservation?.stateToken);
    const publicDelivery = await publicDeliveryVerification(action, pending, profile.connectionId);
    const publicVerified = ['verified', 'not-applicable'].includes(publicDelivery.status);
    const verificationStatus = adminVerified && publicVerified ? 'verified' : 'unverified';
    const evidence = {
      adminApi: {
        status: adminVerified ? 'verified' : 'unverified',
        sha256: sha256(stableStringify(after ?? { unavailable: true })),
      },
      publicDelivery,
    };
    verification = {
      status: verificationStatus,
      persistent: true,
      evidence,
    };
    try {
      const { value: verifiedOperation } = await authenticatedFetch(
        profile.connectionId,
        `/api/v1/agent/operations/${encodeURIComponent(operationId)}/verify`,
        {
          method: 'POST',
          body: JSON.stringify({
            verificationStatus,
            evidenceHash: sha256(stableStringify(evidence)),
            evidenceKind: publicDelivery.status === 'not-applicable' ? 'admin-api' : 'public-page',
          }),
        },
      );
      operation = verifiedOperation;
      if (operation.verificationStatus !== 'verified') {
        verification = {
          status: 'unverified',
          reportedStatus: verificationStatus,
          persistent: true,
          evidence,
          warning: 'Verification evidence is client-reported and awaits a server verifier.',
        };
      }
    } catch (error) {
      verification = {
        status: 'unverified',
        warning: `Verification evidence could not be recorded (${error.code || 'VERIFY_FAILED'})`,
      };
    }
  }
  if (
    ['failed', 'cancelled', 'denied', 'expired'].includes(operation.status) ||
    (operation.status === 'succeeded' &&
      (!action.verifyActionId || operation.verificationStatus === 'verified'))
  ) {
    await deletePending(operationId);
  }
  return {
    operation,
    verification,
    artifact,
    ...(escrowAcknowledgement ? { escrowAcknowledgement } : {}),
    ...(executionError ? { executionWarning: executionError } : {}),
    data:
      action.idempotencyStrategy === 'one-time-secret'
        ? { protectedArtifact: true }
        : redact(response?.value),
  };
}

export async function downloadArtifact(operationId, outputPath, connectionId) {
  const profile = loadProfile(connectionId);
  return downloadPendingArtifact(operationId, profile.connectionId, outputPath, profile.dataKey);
}

export async function reconcileOperation(operationId, connectionId) {
  const profile = loadProfile(connectionId);
  const operation = await operationStatus(operationId, profile.connectionId);
  if (operation.status !== 'unknown') return { operation, reconciliation: 'not-required' };
  const pending = await readPending(operationId, profile.connectionId, profile.dataKey);
  const { action } = await actionDefinition(pending.actionId, profile.connectionId);
  if (!action.reconcileActionId) {
    return { operation, reconciliation: 'missing evidence' };
  }
  const evidence = await inspectPreState(action, pending.params, profile.connectionId);
  return { operation, reconciliation: 'query-only', evidence: redact(evidence) };
}

export async function cancelOperation(operationId, connectionId) {
  const { value } = await authenticatedFetch(
    connectionId,
    `/api/v1/agent/operations/${encodeURIComponent(operationId)}/cancel`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  await deletePending(operationId);
  return value;
}
