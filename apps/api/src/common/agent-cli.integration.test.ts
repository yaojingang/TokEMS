import 'reflect-metadata';
import { randomBytes, randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import { RequestMethod } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  createDatabase,
  eventTemplateBindings,
  conferenceTemplateVersions,
  auditLogs,
  agentConnections,
  agentOperations,
  events,
  templateAssets,
} from '@conference/database';
import {
  AGENT_SCOPES,
  TOKEMS_AGENT_CLIENT_ID,
  TOKEMS_AGENT_SKILL_VERSION,
  PublicEventSchema,
  type ConferenceTemplateDraft,
} from '@conference/contracts';
import {
  decodeAgentAccessSecret,
  verifyAgentStateObservation,
  dpopJwkThumbprint,
  sha256,
  sha256Base64Url,
  stableCanonicalJson,
} from '@conference/security';
import { HttpExceptionFilter } from './http-exception.filter.js';
import { AgentOperationService } from './agent-operation.service.js';
import { AGENT_ACTION_MAP } from './agent-operation-catalog.js';
import { TemplateOperationsService } from './template-operations.service.js';
import { DatabaseService } from './database.service.js';
import { TemplateCandidatePreviewService } from './template-candidate-preview.service.js';
import { RedisService } from './redis.service.js';

const run = promisify(execFile);
const integration = process.env.TOKEMS_AGENT_TEST_DATABASE_URL ? describe : describe.skip;
type Json = Record<string, unknown>;
integration('TokEMS real CLI discovery, authorization and atomic template workflow', () => {
  let app: NestFastifyApplication;
  let connection: ReturnType<typeof createDatabase>;
  let origin: string;
  let humanToken: string;
  let accessToken: string;
  let refreshToken: string;
  let connectionId: string;
  let organizationId: string;
  let templateId: string;
  let eventId: number;
  let uploadedAssetId: string;
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = keys.publicKey.export({ format: 'jwk' });
  const password = 'cli-test-password';
  const root = fileURLToPath(new URL('../../../../', import.meta.url));

  function proof(method: string, path: string, token?: string) {
    const header = Buffer.from(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({
        htm: method,
        htu: `${origin}${path.split('?')[0]}`,
        iat: Math.floor(Date.now() / 1000),
        jti: randomUUID(),
        ...(token ? { ath: sha256Base64Url(token) } : {}),
      }),
    ).toString('base64url');
    return `${header}.${payload}.${sign('sha256', Buffer.from(`${header}.${payload}`), {
      key: keys.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')}`;
  }
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    identity = 'agent',
    extra: Record<string, string> = {},
  ) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (identity === 'human') headers.Authorization = `Bearer ${humanToken}`;
    if (identity === 'agent') {
      headers.Authorization = `DPoP ${accessToken}`;
      headers.DPoP = proof(method, path, accessToken);
    }
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await response.json()) as Json;
    return { response, data };
  }
  async function ok(
    path: string,
    method = 'GET',
    body?: unknown,
    identity = 'agent',
    extra: Record<string, string> = {},
  ) {
    const result = await request(path, method, body, identity, extra);
    if (!result.response.ok)
      throw new Error(
        `Agent test request ${path.split('?')[0]} failed: ${result.response.status} ${result.data.message}`,
      );
    return result;
  }
  async function draftRead() {
    const result = await ok(`/api/v1/admin/templates/${templateId}/draft`);
    return {
      draft: result.data as unknown as ConferenceTemplateDraft,
      token: result.response.headers.get('x-agent-state-token')!,
    };
  }
  async function prepareDraft(title: string) {
    const { draft, token } = await draftRead();
    if (draft.definition.presentation.kind !== 'structured')
      throw new Error('Structured template required');
    const definition = structuredClone(draft.definition);
    if (definition.presentation.kind !== 'structured')
      throw new Error('Structured template required');
    definition.presentation.home.seo.title = title;
    const body = { definition, revision: draft.revision };
    const prepared = (
      await ok('/api/v1/agent/operations', 'POST', {
        actionId: 'templates.draft.update',
        target: { templateId },
        reason: 'Validate the authorized template workflow.',
        requestBody: body,
        requestHash: sha256(stableCanonicalJson(body)),
        beforeStateToken: token,
        idempotencyKey: randomUUID(),
      })
    ).data;
    expect(prepared.status).toBe('approval_required');
    await ok(
      `/api/v1/admin/agent-operations/${prepared.id}/approve`,
      'POST',
      { requestHash: prepared.requestHash, beforeFingerprint: prepared.beforeFingerprint },
      'human',
    );
    return { body, prepared, token };
  }
  async function executeDraft(prepared: Json, body: Json, token: string) {
    return request(`/api/v1/admin/templates/${templateId}/draft`, 'PUT', body, 'agent', {
      'Idempotency-Key': prepared.idempotencyKey as string,
      'X-Agent-Operation-Id': prepared.id as string,
      'X-Agent-Request-Hash': prepared.requestHash as string,
      'X-Agent-Before-Fingerprint': prepared.beforeFingerprint as string,
      'X-Agent-Current-State-Token': token,
    });
  }

  async function perform(actionId: string, target: Record<string, string>, body: Json) {
    const action = AGENT_ACTION_MAP.get(actionId)!;
    let stateToken: string | undefined;
    if (action.verifyActionId) {
      const verifier = AGENT_ACTION_MAP.get(action.verifyActionId)!;
      let path = verifier.path;
      for (const [key, value] of Object.entries(target)) path = path.replace(`:${key}`, value);
      if (!path.includes(':')) {
        const read = await ok(path, 'GET', undefined, 'agent', {
          'X-Agent-Purpose': 'Validate operation state in isolated integration tests.',
        });
        stateToken = read.response.headers.get('x-agent-state-token') || undefined;
        // GET targets include additional route identifiers as query parameters in the connector.
        const extras = Object.entries(target).filter(([key]) => !verifier.path.includes(`:${key}`));
        if (extras.length) {
          const readWithTarget = await ok(
            `${path}?${new URLSearchParams(extras)}`,
            'GET',
            undefined,
            'agent',
            { 'X-Agent-Purpose': 'Validate operation state in isolated integration tests.' },
          );
          stateToken = readWithTarget.response.headers.get('x-agent-state-token') || undefined;
        }
      }
    }
    const prepared = (
      await ok('/api/v1/agent/operations', 'POST', {
        actionId,
        target,
        requestBody: body,
        requestHash: sha256(stableCanonicalJson(body)),
        reason: 'Validate the approved operation in an isolated test.',
        idempotencyKey: randomUUID(),
        ...(stateToken ? { beforeStateToken: stateToken } : {}),
      })
    ).data;
    if (prepared.status === 'approval_required') {
      await ok(
        `/api/v1/admin/agent-operations/${prepared.id}/approve`,
        'POST',
        {
          requestHash: prepared.requestHash,
          beforeFingerprint: prepared.beforeFingerprint,
        },
        'human',
      );
    } else
      await ok(`/api/v1/agent/operations/${prepared.id}/confirm`, 'POST', {
        requestHash: prepared.requestHash,
        beforeFingerprint: prepared.beforeFingerprint,
      });
    let path = action.path;
    for (const [key, value] of Object.entries(target)) path = path.replace(`:${key}`, value);
    const result = await ok(
      path,
      action.method,
      action.method === 'DELETE' ? undefined : body,
      'agent',
      {
        'Idempotency-Key': prepared.idempotencyKey as string,
        'X-Agent-Operation-Id': prepared.id as string,
        'X-Agent-Request-Hash': prepared.requestHash as string,
        'X-Agent-Before-Fingerprint': prepared.beforeFingerprint as string,
        ...(stateToken ? { 'X-Agent-Current-State-Token': stateToken } : {}),
      },
    );
    return { ...result, operationId: prepared.id as string };
  }

  beforeAll(async () => {
    // The harness accepts only an explicitly supplied disposable database.
    const url = new URL(process.env.TOKEMS_AGENT_TEST_DATABASE_URL!);
    if (!url.pathname.endsWith('/tokems_cli'))
      throw new Error('Use the dedicated tokems_cli test database');
    const env = {
      NODE_ENV: 'test',
      DEPLOYMENT_MODE: 'local',
      DATABASE_URL: url.toString(),
      REDIS_URL: process.env.TOKEMS_AGENT_TEST_REDIS_URL || 'redis://127.0.0.1:26379',
      JWT_SECRET: 'cli-integration-jwt-secret-at-least-32-characters',
      AGENT_ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64'),
      TOKEMS_AGENT_ACCESS_ENABLED: 'true',
      TOKEMS_AGENT_WRITES_ENABLED: 'true',
      TOKEMS_AGENT_CRITICAL_ACTIONS_ENABLED: 'true',
      PUBLIC_ORIGIN: 'http://localhost:3000',
      ADMIN_ORIGIN: 'http://localhost:3000',
      PUBLIC_WEB_URL: 'http://localhost:3000',
      ADMIN_WEB_URL: 'http://localhost:3000',
      CUSTOMER_OTP_MODE: 'provider',
      ADMIN_USERNAME: 'cli-test-admin',
      ADMIN_PASSWORD: password,
      ADMIN_EMAIL: 'cli-test-admin@tokems.local',
      S3_ENDPOINT: process.env.S3_ENDPOINT || 'http://127.0.0.1:29000',
      S3_PUBLIC_ENDPOINT: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:29000',
      S3_ACCESS_KEY: process.env.S3_ACCESS_KEY || 'cli-test-access',
      S3_SECRET_KEY: process.env.S3_SECRET_KEY || 'cli-test-storage-secret',
      S3_BUCKET: process.env.S3_BUCKET || 'cli-test-assets',
      S3_REGION: 'us-east-1',
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    connection = createDatabase(url.toString());
    const { AppModule } = await import('../app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.setGlobalPrefix('api/v1', {
      exclude: [
        { path: '.well-known/tokems-agent', method: RequestMethod.GET },
        { path: '.well-known/oauth-authorization-server', method: RequestMethod.GET },
      ],
    });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
    vi.stubEnv('PUBLIC_ORIGIN', origin);
    vi.stubEnv('ADMIN_ORIGIN', origin);
    humanToken = (
      await ok('/api/v1/auth/login', 'POST', { username: 'cli-test-admin', password }, 'none')
    ).data.accessToken as string;
    const [binding] = await connection.db
      .select({
        templateId: conferenceTemplateVersions.templateId,
        eventId: eventTemplateBindings.eventId,
      })
      .from(eventTemplateBindings)
      .innerJoin(
        conferenceTemplateVersions,
        eq(conferenceTemplateVersions.id, eventTemplateBindings.templateVersionId),
      )
      .limit(1);
    templateId = binding!.templateId;
    eventId = binding!.eventId;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await connection?.pool.end();
    vi.unstubAllEnvs();
  });

  it('runs the real CLI against discovery without credentials', async () => {
    const { stdout } = await run(
      process.execPath,
      ['skills/tokems-admin/scripts/tokems-admin.js', 'instance', 'inspect', '--origin', origin],
      { cwd: root },
    );
    const result = JSON.parse(stdout);
    expect(result.ok).toBe(true);
    expect(result.data.features.access).toBe(true);
    expect(result.data.catalogVersion).toBe('2.0.0');
  });

  it('authorizes with browser step-up and obtains a DPoP-bound connection', async () => {
    const authorization = (
      await ok(
        '/api/v1/oauth/device_authorization',
        'POST',
        {
          client_id: TOKEMS_AGENT_CLIENT_ID,
          resource: `${origin}/api/v1`,
          scope: 'tokems:*',
          dpop_jkt: dpopJwkThumbprint(jwk),
          client_name: 'CLI integration test',
          skill_version: TOKEMS_AGENT_SKILL_VERSION,
        },
        'none',
      )
    ).data;
    expect(new URL(authorization.verification_uri as string).pathname).toBe(
      '/admin/agent-authorizations',
    );
    const detail = (
      await ok(
        `/api/v1/admin/agent-authorizations?userCode=${authorization.user_code}`,
        'GET',
        undefined,
        'human',
      )
    ).data;
    const requestHash = sha256(
      stableCanonicalJson({
        authorizationId: detail.id,
        scopes: [...AGENT_SCOPES].sort(),
        approvalPolicy: 'controlled-and-critical',
        userCode: authorization.user_code,
      }),
    );
    const stepUp = (
      await ok(
        '/api/v1/auth/step-up',
        'POST',
        { password, purpose: 'agent-authorization', targetId: detail.id, requestHash },
        'human',
      )
    ).data;
    await ok(
      `/api/v1/admin/agent-authorizations/${detail.id}/approve`,
      'POST',
      {
        scopes: AGENT_SCOPES,
        approvalPolicy: 'controlled-and-critical',
        userCode: authorization.user_code,
        requestHash,
        stepUpToken: stepUp.stepUpToken,
      },
      'human',
    );
    const token = (
      await ok(
        '/api/v1/oauth/token',
        'POST',
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: authorization.device_code,
          client_id: TOKEMS_AGENT_CLIENT_ID,
        },
        'none',
        { DPoP: proof('POST', '/api/v1/oauth/token') },
      )
    ).data;
    accessToken = token.access_token as string;
    refreshToken = token.refresh_token as string;
    connectionId = token.connection_id as string;
    const capabilities = (await ok('/api/v1/agent/capabilities')).data;
    organizationId = capabilities.organizationId as string;
    const actions = capabilities.actions as Array<{
      actionId: string;
      availability: { enabled: boolean; reason?: string };
    }>;
    expect(actions.find((a) => a.actionId === 'templates.draft.update')?.availability.enabled).toBe(
      true,
    );
    expect(
      actions.find((a) => a.actionId === 'integrations.wechat-pay.update')?.availability.reason,
    ).toBe('AGENT_ACTION_NOT_READY');
  });

  it('commits the template and its domain audit with one operation', async () => {
    const { body, prepared, token } = await prepareDraft('CLI atomic template acceptance');
    const result = await executeDraft(prepared, body, token);
    expect(result.response.status, String(result.data.message)).toBe(200);
    expect(
      (result.data.definition as ConferenceTemplateDraft['definition']).presentation.kind,
    ).toBe('structured');
    const operation = (await ok(`/api/v1/agent/operations/${prepared.id}`)).data;
    expect(operation.status).toBe('succeeded');
    const ids = operation.domainAuditIds as string[];
    const audits = await connection.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, organizationId), inArray(auditLogs.id, ids)));
    expect(
      audits.some(
        (audit) => audit.action === 'template.draft.update' && audit.actorType === 'agent',
      ),
    ).toBe(true);
    expect(audits.some((audit) => audit.before?.agentOperationId === prepared.id)).toBe(true);
    const duplicate = await executeDraft(prepared, body, token);
    expect(duplicate.response.status).toBe(409);
  });

  it('binds the response and state token to the same snapshot during a human edit', async () => {
    const [before] = await connection.db.select().from(events).where(eq(events.id, eventId));
    try {
      const observed = await app.get(AgentOperationService).observeRead(
        {
          principal: { connectionId, organizationId } as never,
          actionId: 'events.get',
          target: { eventId: String(eventId) },
        },
        async () => {
          const rows = await app
            .get(DatabaseService)
            .db!.select()
            .from(events)
            .where(eq(events.id, eventId));
          await connection.db
            .update(events)
            .set({ name: 'Concurrent human event edit' })
            .where(eq(events.id, eventId));
          return rows;
        },
      );
      const token = verifyAgentStateObservation(observed.token, [
        decodeAgentAccessSecret(process.env.AGENT_ACCESS_TOKEN_SECRET, 'AGENT_ACCESS_TOKEN_SECRET'),
      ]);
      expect(token.stateFingerprint).toBe(sha256(stableCanonicalJson(observed.result)));
      const current = await connection.db.select().from(events).where(eq(events.id, eventId));
      expect(token.stateFingerprint).not.toBe(sha256(stableCanonicalJson(current)));
    } finally {
      await connection.db.update(events).set({ name: before!.name }).where(eq(events.id, eventId));
    }
  });

  it('rejects an HTTP idempotency key that differs from the approved operation', async () => {
    const { body, prepared, token } = await prepareDraft('Must require the bound idempotency key');
    const result = await request(
      `/api/v1/admin/templates/${templateId}/draft`,
      'PUT',
      body,
      'agent',
      {
        'Idempotency-Key': randomUUID(),
        'X-Agent-Operation-Id': prepared.id as string,
        'X-Agent-Request-Hash': prepared.requestHash as string,
        'X-Agent-Before-Fingerprint': prepared.beforeFingerprint as string,
        'X-Agent-Current-State-Token': token,
      },
    );
    expect(result.response.status).toBe(409);
    expect(result.data.code).toBe('AGENT_OPERATION_STALE');
  });

  it('keeps a committed operation intact when an older status read expires', async () => {
    const { body, prepared, token } = await prepareDraft('Concurrent expiry must preserve commit');
    const expiresAt = new Date(Date.now() + 60_000);
    await connection.db
      .update(agentOperations)
      .set({ status: 'approval_required', expiresAt })
      .where(eq(agentOperations.id, prepared.id as string));
    const service = app.get(AgentOperationService);
    const db = app.get(DatabaseService).db!;
    let captured!: () => void;
    let resume!: () => void;
    const snapshotReady = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const mayResume = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const query = db
      .select()
      .from(agentOperations)
      .where(eq(agentOperations.id, prepared.id as string));
    const read = vi.spyOn(service as unknown as { db: () => typeof db }, 'db').mockReturnValueOnce({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              const rows = await query.limit(1);
              captured();
              await mayResume;
              return rows;
            },
          }),
        }),
      }),
    } as unknown as typeof db);
    const pending = service.get(prepared.id as string, { connectionId, organizationId } as never);
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await snapshotReady;
      await ok(
        `/api/v1/admin/agent-operations/${prepared.id}/approve`,
        'POST',
        {
          requestHash: prepared.requestHash,
          beforeFingerprint: prepared.beforeFingerprint,
        },
        'human',
      );
      expect((await executeDraft(prepared, body, token)).response.status).toBe(200);
      clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt.getTime() + 1);
      resume();
      expect((await pending).status).toBe('succeeded');
      const [current] = await connection.db
        .select()
        .from(agentOperations)
        .where(eq(agentOperations.id, prepared.id as string));
      expect(current?.status).toBe('succeeded');
      expect(current?.domainAuditIds.length).toBeGreaterThan(0);
    } finally {
      clock?.mockRestore();
      resume();
      await pending;
      read.mockRestore();
    }
  });

  it('rejects a concurrent human edit even when the client reuses a valid old observation', async () => {
    const { body, prepared, token } = await prepareDraft('CLI stale candidate');
    const changed = structuredClone(body);
    if (changed.definition.presentation.kind === 'structured')
      changed.definition.presentation.home.seo.title = 'Human concurrent edit';
    await ok(`/api/v1/admin/templates/${templateId}/draft`, 'PUT', changed, 'human');
    const result = await executeDraft(prepared, body, token);
    expect(result.response.status).toBe(409);
    expect(result.data.code).toBe('AGENT_OPERATION_STALE');
    const current = await draftRead();
    expect(
      current.draft.definition.presentation.kind === 'structured' &&
        current.draft.definition.presentation.home.seo.title,
    ).toBe('Human concurrent edit');
  });

  it('rolls back domain changes if operation finalization fails', async () => {
    const { body, prepared, token } = await prepareDraft('Must roll back');
    const before = await draftRead();
    const finalize = vi
      .spyOn(app.get(AgentOperationService), 'finishExecution')
      .mockRejectedValueOnce(new Error('Injected finalization failure'));
    try {
      const result = await executeDraft(prepared, body, token);
      expect(result.response.status).toBe(500);
      const after = await draftRead();
      expect(after.draft.revision).toBe(before.draft.revision);
      expect(after.draft.definition).toEqual(before.draft.definition);
    } finally {
      finalize.mockRestore();
    }
  });

  it('previews a candidate without changing the draft or public binding', async () => {
    const before = await draftRead();
    const body = {
      eventId,
      revision: before.draft.revision,
      definition: structuredClone(before.draft.definition),
    };
    if (body.definition.presentation.kind !== 'structured')
      throw new Error('Structured preview required');
    body.definition.presentation.home.seo.title = 'Unapplied preview candidate';
    const preview = await app.get(TemplateOperationsService).binding(organizationId, eventId);
    // Browser preview is exercised through its authenticated HTTP endpoint.
    const result = await ok(`/api/v1/admin/templates/${templateId}/preview`, 'POST', body, 'human');
    const previewUrl = new URL(result.data.previewUrl as string, origin);
    const rendered = await ok(
      `/api/v1/previews/events/${eventId}?token=${previewUrl.searchParams.get('token')}`,
      'GET',
      undefined,
      'none',
    );
    expect(JSON.stringify(rendered.data)).toContain('Unapplied preview candidate');
    expect(PublicEventSchema.safeParse(rendered.data).success).toBe(true);
    expect(rendered.response.headers.get('cache-control')).toContain('no-store');
    expect((await draftRead()).draft.revision).toBe(before.draft.revision);
    expect(await app.get(TemplateOperationsService).binding(organizationId, eventId)).toEqual(
      preview,
    );
  });

  it('rejects replayed DPoP proofs and immediately enforces reduced scopes', async () => {
    const reused = proof('GET', '/api/v1/agent/capabilities', accessToken);
    expect(
      (
        await request('/api/v1/agent/capabilities', 'GET', undefined, 'none', {
          Authorization: `DPoP ${accessToken}`,
          DPoP: reused,
        })
      ).response.status,
    ).toBe(200);
    expect(
      (
        await request('/api/v1/agent/capabilities', 'GET', undefined, 'none', {
          Authorization: `DPoP ${accessToken}`,
          DPoP: reused,
        })
      ).response.status,
    ).toBe(401);
    await connection.db
      .update(agentConnections)
      .set({ scopes: ['tokems:read'] })
      .where(eq(agentConnections.id, connectionId));
    try {
      const result = await request(`/api/v1/admin/templates/${templateId}/draft`, 'PUT', {});
      expect(result.response.status).toBe(403);
    } finally {
      await connection.db
        .update(agentConnections)
        .set({ scopes: [...AGENT_SCOPES] })
        .where(eq(agentConnections.id, connectionId));
    }
  });

  it('uploads and validates an image through an approved one-time reservation', async () => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzWQAAAAASUVORK5CYII=',
      'base64',
    );
    const input = {
      fileName: 'cli-acceptance.png',
      mediaType: 'image/png',
      size: bytes.length,
      contentDigest: createHash('sha256').update(bytes).digest('hex'),
      altText: 'CLI acceptance image',
    };
    const reservation = await perform('templates.assets.upload.prepare', {}, input);
    const upload = reservation.data;
    expect(new URL(upload.uploadUrl as string).origin).toBe(process.env.S3_PUBLIC_ENDPOINT);
    const sent = await fetch(upload.uploadUrl as string, {
      method: 'PUT',
      headers: upload.headers as Record<string, string>,
      body: bytes,
      redirect: 'error',
    });
    expect(sent.ok).toBe(true);
    const created = await perform(
      'templates.assets.create',
      {},
      {
        storageKey: upload.storageKey,
        mediaType: input.mediaType,
        size: input.size,
        contentDigest: input.contentDigest,
        altText: input.altText,
      },
    );
    const [asset] = await connection.db
      .select()
      .from(templateAssets)
      .where(eq(templateAssets.id, created.data.id as string));
    expect(asset?.contentDigest).toBe(input.contentDigest);
    expect(asset?.organizationId).toBe(organizationId);
    uploadedAssetId = asset!.id;
  });

  it('scans and imports HTML, then previews it against the selected real event', async () => {
    const source = Buffer.from(
      `<!doctype html><html><head><title>CLI import</title></head><body><h1>Event title</h1><img src="/api/v1/assets/templates/${uploadedAssetId}" alt="Preview asset"><a href="/register">Register</a></body></html>`,
    );
    const reservation = await perform(
      'templates.html-imports.prepare',
      {},
      {
        fileName: 'cli-preview.html',
        size: source.length,
        sourceDigest: createHash('sha256').update(source).digest('hex'),
        mode: 'create',
      },
    );
    const upload = reservation.data.upload as Json;
    const importId = (reservation.data.import as Json).id as string;
    expect(
      (
        await fetch(upload.uploadUrl as string, {
          method: 'PUT',
          headers: upload.headers as Record<string, string>,
          body: source,
        })
      ).ok,
    ).toBe(true);
    const scan = await perform('templates.html-imports.scan', { importId }, {});
    expect((await ok(`/api/v1/agent/operations/${scan.operationId}`)).data.status).toBe('queued');
    // Invoke the real scanner in its own worker runtime, using the disposable storage/database.
    await run(
      'pnpm',
      [
        '--filter',
        '@conference/worker',
        'exec',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { createDatabase } from '@conference/database';
      import { processHtmlTemplateImportScan } from './src/html-template-import.worker.ts';
      const connection = createDatabase(process.env.DATABASE_URL);
      try { await processHtmlTemplateImportScan(connection.db, {importId:process.argv[1]}, {attemptsMade:0,opts:{attempts:1}}); }
      finally { await connection.pool.end(); }
    `,
        importId,
      ],
      { cwd: root, env: process.env },
    );
    const scanned = (await ok(`/api/v1/admin/template-html-imports/${importId}`)).data;
    expect(['ready', 'needs_review']).toContain(scanned.status);
    expect(
      (await ok(`/api/v1/agent/operations/${scan.operationId}/reconcile`, 'POST', {})).data
        .verificationStatus,
    ).toBe('verified');
    const heading = (
      scanned.nodeManifest as Array<{ id: string; nodeId?: string; tagName: string }>
    ).find((node) => node.tagName === 'h1')!;
    const imported = await perform(
      'templates.html-imports.commit',
      { importId },
      {
        name: 'CLI real HTML acceptance',
        confirmWarnings: true,
        bindings: {
          version: 1,
          bindings: [
            {
              id: 'event-heading',
              kind: 'text',
              nodeId: heading.nodeId ?? heading.id,
              missingPolicy: 'error',
              segments: [{ kind: 'variable', path: 'event.name' }],
            },
          ],
        },
      },
    );
    const id = imported.data.templateId as string;
    const draft = (await ok(`/api/v1/admin/templates/${id}/draft`)).data;
    const preview = await perform(
      'templates.preview.create',
      { templateId: id },
      { eventId, revision: draft.revision },
    );
    const page = await fetch(new URL(preview.data.previewUrl as string, origin));
    const html = await page.text();
    const [event] = await connection.db.select().from(events).where(eq(events.id, eventId));
    expect(html).toContain(event!.name);
    expect(html).toMatch(/<body[^>]*inert/iu);
    expect(html).toContain('候选模板预览');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'none'");
    expect(page.headers.get('content-security-policy')).toContain(
      `img-src 'self' ${process.env.S3_PUBLIC_ENDPOINT}`,
    );
    expect(page.headers.get('content-security-policy')).toContain(
      `font-src 'self' ${process.env.S3_PUBLIC_ENDPOINT}`,
    );
    const browserCheck = await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { chromium } from 'playwright-core';
      import { mkdir } from 'node:fs/promises';
      const browser = await chromium.launch({ headless:true,
        executablePath: process.env.CHROMIUM_PATH || (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
        args:['--no-proxy-server'] });
      try {
        const page = await browser.newPage();
        await page.goto(process.env.TOKEMS_TEST_PREVIEW_URL, {waitUntil:'domcontentloaded'});
        await page.waitForFunction(() => {
          const images = [...document.images];
          return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0);
        }, null, {timeout:10000});
        const images = await page.locator('img').count();
        await mkdir('.codex-artifacts/tokems-cli-test', {recursive:true});
        await page.screenshot({path:'.codex-artifacts/tokems-cli-test/html-preview.png'});
        process.stdout.write(JSON.stringify({images}));
      } catch { throw new Error('Candidate preview asset browser check failed'); }
      finally { await browser.close(); }
    `,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          TOKEMS_TEST_PREVIEW_URL: new URL(preview.data.previewUrl as string, origin).toString(),
        },
      },
    );
    expect(JSON.parse(browserCheck.stdout).images).toBeGreaterThan(0);
    expect((await ok(`/api/v1/admin/templates/${id}/draft`)).data.revision).toBe(draft.revision);
  }, 30_000);

  it('publishes, applies and rolls back an immutable template version', async () => {
    const [event] = await connection.db.select().from(events).where(eq(events.id, eventId));
    const previousReleaseId = event!.settings.currentReleaseId as string;
    const binding = await app.get(TemplateOperationsService).binding(organizationId, eventId);
    let current = await draftRead();
    const definition = structuredClone(current.draft.definition);
    if (definition.presentation.kind !== 'structured')
      throw new Error('Structured template required');
    definition.presentation.home.seo.description = `Publish acceptance ${randomUUID()}`;
    await ok(
      `/api/v1/admin/templates/${templateId}/draft`,
      'PUT',
      { definition, revision: current.draft.revision },
      'human',
    );
    current = await draftRead();
    const published = await perform(
      'templates.publish',
      { templateId },
      {
        revision: current.draft.revision,
        changeSummary: `CLI acceptance ${randomUUID()}`,
      },
    );
    expect(typeof published.data.id).toBe('string');
    await perform(
      'templates.event-binding.update',
      { eventId: String(eventId) },
      {
        templateVersionId: published.data.id,
        revision: binding.revision,
      },
    );
    const changed = await app.get(TemplateOperationsService).binding(organizationId, eventId);
    expect(changed.templateVersionId).toBe(published.data.id);
    const publicEvent = (await ok(`/api/v1/events/${event!.slug}`, 'GET', undefined, 'none')).data;
    expect(publicEvent.releaseId).not.toBe(previousReleaseId);
    const rolled = await perform(
      'events.releases.rollback',
      { eventId: String(eventId), releaseId: previousReleaseId },
      {},
    );
    expect(rolled.response.ok).toBe(true);
    const after = (await ok(`/api/v1/events/${event!.slug}`, 'GET', undefined, 'none')).data;
    expect(after.releaseId).toBe(previousReleaseId);
  });

  it('bounds concurrent preview retention per organization and preserves existing links', async () => {
    const service = app.get(TemplateCandidatePreviewService);
    const { draft } = await draftRead();
    const results = await Promise.allSettled(
      Array.from({ length: 60 }, () =>
        service.create(organizationId, randomUUID(), templateId, {
          eventId,
          revision: draft.revision,
        }),
      ),
    );
    const created = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(created.length).toBeGreaterThan(0);
    expect(created.length).toBeLessThanOrEqual(50);
    expect(rejected.length).toBeGreaterThan(0);
    for (const result of rejected) expect(result.reason).toMatchObject({ status: 429 });
    expect(await service.read(created[0]!.value.snapshotId)).toHaveProperty(
      'preview.submissionsDisabled',
      true,
    );
  }, 30_000);

  it('enforces the preview byte budget independently and reclaims expired reservations', async () => {
    const service = app.get(TemplateCandidatePreviewService);
    const cache = service as unknown as {
      cacheSnapshot: (organizationId: string, id: string, body: string) => Promise<void>;
    };
    const redis = app.get(RedisService).getClient();
    const org = randomUUID();
    const ids: string[] = [];
    const body = JSON.stringify({ html: 'x'.repeat(4 * 1024 * 1024 - 100) });
    for (let index = 0; index < 16; index += 1) {
      const id = randomUUID();
      await cache.cacheSnapshot(org, id, body);
      ids.push(id);
    }
    const rejected = randomUUID();
    await expect(cache.cacheSnapshot(org, rejected, body)).rejects.toMatchObject({ status: 429 });
    expect(await redis.exists(`tokems:template-preview:${rejected}`)).toBe(0);
    expect(await redis.exists(`tokems:template-preview:${ids[0]}`)).toBe(1);
    await cache.cacheSnapshot(randomUUID(), randomUUID(), '{}');
    const indexKey = `tokems:template-preview:budget:${org}`;
    const members = await redis.zrange(indexKey, 0, '-1');
    await redis.del(...ids.map((id) => `tokems:template-preview:${id}`));
    for (const member of members) await redis.zadd(indexKey, String(Date.now() - 1000), member);
    await cache.cacheSnapshot(org, rejected, body);
    expect(await redis.exists(`tokems:template-preview:${rejected}`)).toBe(1);
    expect(await redis.zcard(indexKey)).toBe(1);
  }, 30_000);

  it('refreshes and revokes the delegation with immediate access rejection', async () => {
    const refreshed = (
      await ok(
        '/api/v1/oauth/token',
        'POST',
        {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: TOKEMS_AGENT_CLIENT_ID,
        },
        'none',
        { DPoP: proof('POST', '/api/v1/oauth/token') },
      )
    ).data;
    accessToken = refreshed.access_token as string;
    await ok(`/api/v1/admin/agent-connections/${connectionId}/revoke`, 'POST', {}, 'human');
    expect((await request('/api/v1/agent/capabilities')).response.status).toBe(401);
  });
});
