import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { sha256, stableCanonicalJson } from '@conference/security';
import { AgentOperationInterceptor } from './agent-operation.interceptor.js';

function contextFor(body: unknown, requestHash: string, headers: Record<string, string> = {}) {
  const request = {
    id: 'trace-1',
    url: '/api/v1/admin/events/101',
    headers: {
      'x-agent-operation-id': '4d46d6b7-f7b4-4f6f-8cd4-66e5e5f44c01',
      'x-agent-request-hash': requestHash,
      'x-agent-before-fingerprint': 'b'.repeat(64),
      'x-agent-current-state-token': 'state-token-'.padEnd(40, 'x'),
      ...headers,
    },
    body,
    agentPrincipal: {
      connectionId: 'connection-1',
      organizationId: 'organization-1',
      delegatedUserId: 'admin-1',
    },
    user: { grants: ['event.manage'] },
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header: vi.fn() }),
    }),
  } as never;
}

function harness(actionOverrides: Record<string, unknown> = {}) {
  const action = {
    actionId: 'events.update',
    method: 'PATCH',
    path: '/api/v1/admin/events/:eventId',
    confirmation: 'intent',
    dataClass: 'internal',
    riskBase: 'routine-write',
    ...actionOverrides,
  };
  const policy = {
    actionForRequest: vi.fn(() => action),
    authorize: vi.fn(),
  };
  const operations = {
    beginExecution: vi.fn(async () => ({ id: 'operation-1', targetSummary: {} })),
    finishExecution: vi.fn(async () => undefined),
    recordRead: vi.fn(async () => undefined),
    createStateObservation: vi.fn(() => 'signed-state-observation'),
  };
  return {
    interceptor: new AgentOperationInterceptor(policy as never, operations as never),
    operations,
  };
}

describe('AgentOperationInterceptor request binding', () => {
  it('rejects a body that differs from the prepared request hash before domain execution', () => {
    const { interceptor, operations } = harness();
    const preparedHash = sha256(stableCanonicalJson({ title: 'Prepared title' }));
    expect(() =>
      interceptor.intercept(contextFor({ title: 'Changed title' }, preparedHash), {
        handle: () => of({ id: 'event-1' }),
      }),
    ).toThrowError(/does not match the prepared operation/u);
    expect(operations.beginExecution).not.toHaveBeenCalled();
  });

  it('executes and records a body with the exact canonical hash', async () => {
    const { interceptor, operations } = harness();
    const body = { title: 'Bound title', settings: { live: true } };
    const result = await firstValueFrom(
      interceptor.intercept(contextFor(body, sha256(stableCanonicalJson(body))), {
        handle: () => of({ id: 'event-1', status: 'draft' }),
      }),
    );
    expect(result).toEqual({ id: 'event-1', status: 'draft' });
    expect(operations.beginExecution).toHaveBeenCalledOnce();
    expect(operations.beginExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeFingerprint: 'b'.repeat(64),
        currentStateToken: 'state-token-'.padEnd(40, 'x'),
        requestBody: body,
      }),
    );
    expect(operations.finishExecution).toHaveBeenCalledWith(
      'operation-1',
      expect.objectContaining({ status: 'succeeded' }),
    );
  });

  it('requires and audits a purpose for sensitive reads', async () => {
    const { interceptor, operations } = harness({
      actionId: 'customers.get',
      method: 'GET',
      confirmation: 'none',
      dataClass: 'pii',
      riskBase: 'sensitive-read',
    });
    expect(() =>
      interceptor.intercept(contextFor(undefined, '', {}), {
        handle: () => of({ id: 101 }),
      }),
    ).toThrowError(/explicit task purpose/u);

    const result = await firstValueFrom(
      interceptor.intercept(
        contextFor(undefined, '', { 'x-agent-purpose': 'Review customer support request.' }),
        { handle: () => of({ id: 101 }) },
      ),
    );
    expect(result).toEqual({ id: 101 });
    expect(operations.recordRead).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'customers.get',
        purpose: 'Review customer support request.',
      }),
    );
  });

  it('masks PII list fields on the server before returning them to an Agent', async () => {
    const { interceptor, operations } = harness({
      actionId: 'customers.list',
      method: 'GET',
      confirmation: 'none',
      dataClass: 'pii',
      riskBase: 'read',
    });
    const result = await firstValueFrom(
      interceptor.intercept(contextFor(undefined, ''), {
        handle: () =>
          of({
            items: [
              {
                id: 101,
                realName: '张三',
                mobile: '13800138000',
                email: 'zhangsan@example.com',
                displayName: '张三先生',
                eventName: '年度大会',
                formAnswers: { dietary: '过敏史', wechat: 'wx-private' },
              },
            ],
          }),
      }),
    );
    expect(result).toEqual({
      items: [
        {
          id: 101,
          realName: '张**',
          mobile: '***8000',
          email: 'z***@example.com',
          displayName: '张**',
          eventName: '年度大会',
          formAnswers: { dietary: '[masked]', wechat: '[masked]' },
        },
      ],
    });
    expect(operations.recordRead).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'customers.list', dataClass: 'pii', risk: 'read' }),
    );
  });

  it('keeps outbox responses queued until their domain job reaches a terminal state', async () => {
    const { interceptor, operations } = harness({ idempotencyStrategy: 'outbox-job' });
    const body = { recipient: 'masked@example.com' };
    await firstValueFrom(
      interceptor.intercept(contextFor(body, sha256(stableCanonicalJson(body))), {
        handle: () => of({ id: 'delivery-1', status: 'queued' }),
      }),
    );
    expect(operations.finishExecution).toHaveBeenCalledWith(
      'operation-1',
      expect.objectContaining({ status: 'queued' }),
    );
  });

  it('hands one-time results to encrypted server escrow before returning the response', async () => {
    const { interceptor, operations } = harness({ idempotencyStrategy: 'one-time-secret' });
    const body = { name: 'Gate device' };
    const secretResult = { id: 'device-1', token: 'secret-once' };
    await firstValueFrom(
      interceptor.intercept(contextFor(body, sha256(stableCanonicalJson(body))), {
        handle: () => of(secretResult),
      }),
    );
    expect(operations.finishExecution).toHaveBeenCalledWith(
      'operation-1',
      expect.objectContaining({
        status: 'succeeded',
        oneTimeSecretResult: secretResult,
      }),
    );
  });
});
