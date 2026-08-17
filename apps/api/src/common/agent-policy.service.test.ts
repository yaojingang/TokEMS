import { describe, expect, it } from 'vitest';
import type { AgentAction } from '@conference/contracts';
import { resolveDynamicAgentRisk } from './agent-policy.service.js';

function action(riskBase: AgentAction['riskBase'], dynamicRiskPolicy?: string): AgentAction {
  return {
    actionId: 'content.example.update',
    method: 'PATCH',
    routeName: 'content.example.update',
    path: '/api/v1/admin/example/:id',
    requiredGrants: ['event.manage'],
    agentScopes: ['tokems:write'],
    dataClass: 'internal',
    riskBase,
    dynamicRiskPolicy,
    confirmation: 'intent',
    idempotencyStrategy: 'transactional-command',
    retryPolicy: 'query-before-retry',
    targetResolver: 'path-params',
    rollback: 'manual',
    minClientVersion: '0.1.0',
    description: 'Test action.',
  };
}

describe('resolveDynamicAgentRisk', () => {
  it.each(['published-event-upgrade', 'published-template-upgrade', 'published-site-upgrade'])(
    'keeps %s inside controlled approval even without a client hint',
    (policy) => {
      expect(resolveDynamicAgentRisk(action('routine-write', policy), {})).toBe('controlled');
    },
  );

  it('raises broad notification audiences and large batches to critical', () => {
    const notification = action('critical', 'notification-audience-upgrade');
    expect(resolveDynamicAgentRisk(notification, {})).toBe('critical');
    expect(resolveDynamicAgentRisk(notification, { audienceCount: 101 })).toBe('critical');
    expect(resolveDynamicAgentRisk(notification, { allAudience: true })).toBe('critical');
    expect(resolveDynamicAgentRisk(action('routine-write'), { batchCount: 21 })).toBe('critical');
  });
});
