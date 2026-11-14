import type { AgentAction, AgentFeatureFlags } from '@conference/contracts';

// Writes are released individually after their transaction and verifier contracts are tested.
export const AGENT_READY_WRITES = new Set<string>([
  'templates.create',
  'templates.update',
  'templates.duplicate',
  'templates.archive',
  'templates.restore',
  'templates.draft.update',
  'templates.publish',
  'templates.event-binding.update',
  'templates.html-bindings.update',
  'templates.html-preview.create',
  'templates.preview.create',
  'templates.assets.upload.prepare',
  'templates.assets.create',
  'templates.assets.delete',
  'templates.html-imports.prepare',
  'templates.html-imports.scan',
  'templates.html-imports.retry',
  'templates.html-imports.cancel',
  'templates.html-imports.commit',
  'events.create',
  'events.update',
  'events.public-url.update',
  'events.releases.publish',
  'events.releases.rollback',
  'events.experience.update',
  'events.experience.validate',
  'events.experience.preview',
  'organization.homepage.update',
  'organization.homepage-event.update',
  'content.speakers.create',
  'content.speakers.update',
  'content.speakers.delete',
  'content.speakers.order',
  'content.sessions.create',
  'content.sessions.update',
  'content.sessions.delete',
  'content.registration-forms.publish',
  'content.ticket-types.create',
  'content.ticket-types.update',
  'content.ticket-types.delete',
  'content.ticket-types.restore',
]);

export function agentActionAvailability(action: AgentAction, features: AgentFeatureFlags) {
  if (!features.access) return { enabled: false, reason: 'AGENT_ACCESS_DISABLED' };
  if (action.method === 'GET' && action.confirmation === 'none') return { enabled: true };
  if (!features.writes) return { enabled: false, reason: 'AGENT_WRITES_DISABLED' };
  if (!AGENT_READY_WRITES.has(action.actionId) || !action.inputSchema) {
    return { enabled: false, reason: 'AGENT_ACTION_NOT_READY' };
  }
  if (action.riskBase === 'critical' && !features.criticalActions) {
    return { enabled: false, reason: 'AGENT_CRITICAL_ACTIONS_DISABLED' };
  }
  return { enabled: true };
}
