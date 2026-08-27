import { describe, expect, it } from 'vitest';
import {
  AGENT_ACTIONS,
  AGENT_ACTION_MAP,
  agentRequestTarget,
  findAgentAction,
} from './agent-operation-catalog.js';

describe('Agent operation catalog', () => {
  it('has unique identifiers and classifies every released route', () => {
    expect(AGENT_ACTIONS).toHaveLength(87);
    expect(AGENT_ACTION_MAP.size).toBe(AGENT_ACTIONS.length);
    for (const action of AGENT_ACTIONS) {
      const concretePath = action.path
        .replace(/:eventId/gu, '101')
        .replace(/:userId/gu, '101')
        .replace(/:[^/]+/gu, '4d46d6b7-f7b4-4f6f-8cd4-66e5e5f44c01');
      expect(findAgentAction(action.method, concretePath)?.actionId).toBe(action.actionId);
    }
  });

  it('keeps unknown and wrong-method management routes denied', () => {
    expect(findAgentAction('POST', '/api/v1/admin/unknown')).toBeUndefined();
    expect(findAgentAction('DELETE', '/api/v1/admin/events')).toBeUndefined();
    expect(findAgentAction('PATCH', '/api/v1/admin/orders/order-101')).toBeUndefined();
    expect(findAgentAction('POST', '/api/v1/admin/orders/order-101/payment')).toBeUndefined();
    expect(
      findAgentAction('GET', '/api/v1/admin/events/101/invoices/pending-count'),
    ).toBeUndefined();
    expect(findAgentAction('GET', '/api/v1/admin/events/101/invoices/export.csv')).toBeUndefined();
  });

  it('derives an exact execution target from path and query parameters', () => {
    const action = AGENT_ACTION_MAP.get('registrations.list')!;
    expect(
      agentRequestTarget(
        action,
        '/api/v1/admin/events/101/registrations?status=paid&status=confirmed&page=2',
      ),
    ).toEqual({ eventId: '101', status: 'paid,confirmed', page: '2' });
  });

  it('defines an execution strategy for every write action', () => {
    expect(
      AGENT_ACTIONS.filter((action) => action.method !== 'GET' && !action.idempotencyStrategy),
    ).toEqual([]);
  });

  it('requires the dangerous scope for every critical action', () => {
    expect(
      AGENT_ACTIONS.filter(
        (action) =>
          action.riskBase === 'critical' && !action.agentScopes.includes('tokems:dangerous'),
      ),
    ).toEqual([]);
  });

  it('keeps notification delivery inside critical browser step-up', () => {
    expect(AGENT_ACTION_MAP.get('communications.notifications.queue')).toMatchObject({
      riskBase: 'critical',
      confirmation: 'step-up',
    });
  });

  it('keeps administrator status changes inside critical browser step-up', () => {
    expect(AGENT_ACTION_MAP.get('organization.members.status')).toMatchObject({
      riskBase: 'critical',
      confirmation: 'step-up',
      agentScopes: expect.arrayContaining(['tokems:dangerous']),
    });
  });

  it('requires super-administrator delegation for administrator lifecycle actions', () => {
    for (const actionId of [
      'organization.administrators.create',
      'organization.administrators.update',
      'organization.administrators.delete',
    ]) {
      expect(AGENT_ACTION_MAP.get(actionId)?.requiredGrants).toEqual(['*']);
    }
  });

  it('requires PII purpose and scope for member and audit reads', () => {
    for (const actionId of ['organization.members.list', 'audit.list']) {
      expect(AGENT_ACTION_MAP.get(actionId)).toMatchObject({
        dataClass: 'pii',
        riskBase: 'sensitive-read',
        agentScopes: expect.arrayContaining(['tokems:pii']),
      });
    }
  });

  it('classifies website analytics changes as critical', () => {
    expect(AGENT_ACTION_MAP.get('organization.analytics.update')).toMatchObject({
      method: 'PUT',
      path: '/api/v1/admin/organization/analytics',
      requiredGrants: ['org.analytics.manage'],
      riskBase: 'critical',
      confirmation: 'step-up',
    });
  });

  it('classifies attendee needs reads, writes, moderation and exports', () => {
    expect(AGENT_ACTION_MAP.get('attendee-needs.list')).toMatchObject({
      dataClass: 'pii',
      riskBase: 'sensitive-read',
      agentScopes: expect.arrayContaining(['tokems:pii']),
    });
    for (const actionId of ['attendee-needs.update', 'attendee-needs.moderate']) {
      expect(AGENT_ACTION_MAP.get(actionId)).toMatchObject({
        riskBase: 'controlled',
        confirmation: 'browser',
        verifyActionId: 'attendee-needs.list',
      });
    }
    expect(AGENT_ACTION_MAP.get('attendee-needs.export')).toMatchObject({
      requiredGrants: ['event.registration.read', 'event.registration.export'],
      riskBase: 'critical',
      confirmation: 'step-up',
      idempotencyStrategy: 'outbox-job',
      agentScopes: expect.arrayContaining(['tokems:pii', 'tokems:export', 'tokems:dangerous']),
    });
  });

  it('releases five Feishu reads and keeps delivery writes outside the catalog', () => {
    expect(
      AGENT_ACTIONS.filter((action) =>
        ['integrations.feishu.', 'communications.feishu-digest.'].some((prefix) =>
          action.actionId.startsWith(prefix),
        ),
      ),
    ).toHaveLength(5);
    expect(AGENT_ACTION_MAP.get('communications.feishu-digest.preview')).toMatchObject({
      requiredGrants: ['org.settings.read', 'event.dashboard.read'],
      riskBase: 'sensitive-read',
      agentScopes: expect.arrayContaining(['tokems:finance']),
    });
    expect(findAgentAction('PATCH', '/api/v1/admin/integrations/feishu-bot')).toBeUndefined();
    expect(
      findAgentAction('POST', '/api/v1/admin/events/101/feishu-digest/send-test'),
    ).toBeUndefined();
    expect(
      findAgentAction(
        'POST',
        '/api/v1/admin/events/101/feishu-digest/deliveries/4d46d6b7-f7b4-4f6f-8cd4-66e5e5f44c01/resend',
      ),
    ).toBeUndefined();
  });

  it('keeps payment facts and direct order amount mutation outside the Agent surface', () => {
    expect(
      AGENT_ACTIONS.filter((action) =>
        /(?:payment|amount|transaction)/iu.test(`${action.actionId} ${action.path}`),
      ),
    ).toEqual([]);
  });
});
