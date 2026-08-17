import { HttpStatus, Injectable } from '@nestjs/common';
import { API_ERROR_CODES, type AgentAction, type AgentRisk } from '@conference/contracts';
import { resolveAgentAccessFeatures } from '@conference/security';
import type { FastifyRequest } from 'fastify';
import { DomainError } from './domain-error.js';
import { findAgentAction } from './agent-operation-catalog.js';
import type { AgentPrincipal } from './agent-principal.service.js';
import { grantsAllowAll } from './auth.guard.js';

const riskOrder: AgentRisk[] = [
  'read',
  'sensitive-read',
  'routine-write',
  'controlled',
  'critical',
];

export function maxAgentRisk(left: AgentRisk, right: AgentRisk) {
  return riskOrder.indexOf(left) >= riskOrder.indexOf(right) ? left : right;
}

export function resolveDynamicAgentRisk(
  action: AgentAction,
  impact: Record<string, unknown>,
): AgentRisk {
  let risk = action.riskBase;
  if (
    action.dynamicRiskPolicy === 'published-event-upgrade' ||
    action.dynamicRiskPolicy === 'published-template-upgrade' ||
    action.dynamicRiskPolicy === 'published-site-upgrade'
  ) {
    // Public-state detection is a client hint during prepare. Keep every action
    // that can affect a published surface inside the browser-approval boundary.
    risk = maxAgentRisk(risk, 'controlled');
  }
  if (action.dynamicRiskPolicy === 'notification-audience-upgrade') {
    const audienceCount = Number(impact.audienceCount ?? 0);
    risk = maxAgentRisk(
      risk,
      audienceCount > 100 || impact.allAudience === true ? 'critical' : 'controlled',
    );
  }
  const batchCount = Number(impact.batchCount ?? 0);
  if (batchCount > 20) risk = maxAgentRisk(risk, 'critical');
  return risk;
}

@Injectable()
export class AgentPolicyService {
  actionForRequest(request: FastifyRequest) {
    const path = String(request.url).split('?')[0] ?? '/';
    const action = findAgentAction(request.method, path);
    if (!action) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_ACTION_NOT_CLASSIFIED,
        'This administration route is not released to Agent Access',
        HttpStatus.FORBIDDEN,
        { retryable: false, next: 'Use the human TokEMS administration console.' },
      );
    }
    return action;
  }

  authorize(input: {
    action: AgentAction;
    principal: AgentPrincipal;
    grants: string[];
    impact?: Record<string, unknown>;
  }) {
    const features = resolveAgentAccessFeatures();
    const risk = resolveDynamicAgentRisk(input.action, input.impact ?? {});
    if (input.action.method !== 'GET' && !features.writes) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_ACCESS_DISABLED,
        'TokEMS Agent writes are disabled',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (risk === 'critical' && !features.criticalActions) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_ACCESS_DISABLED,
        'TokEMS Agent critical actions are disabled',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const missingScopes = input.action.agentScopes.filter(
      (scope) => !input.principal.scopes.includes(scope),
    );
    if (missingScopes.length) {
      throw new DomainError(
        API_ERROR_CODES.AGENT_SCOPE_REQUIRED,
        'The Agent connection lacks required scopes',
        HttpStatus.FORBIDDEN,
        { requiredScopes: missingScopes },
      );
    }
    if (!grantsAllowAll(input.grants, input.action.requiredGrants)) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        'The delegated administrator lacks required grants',
        HttpStatus.FORBIDDEN,
      );
    }
    return risk;
  }
}
