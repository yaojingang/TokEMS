import { describe, expect, it } from 'vitest';
import { agentActionAvailability } from './agent-action-availability.js';
import { AGENT_ACTION_MAP } from './agent-operation-catalog.js';

describe('Agent per-action release gates', () => {
  const all = { access: true, writes: true, criticalActions: true };
  it('keeps unaccepted writes denied even with every global flag enabled', () => {
    expect(agentActionAvailability(AGENT_ACTION_MAP.get('integrations.wechat-pay.update')!, all))
      .toEqual({ enabled: false, reason: 'AGENT_ACTION_NOT_READY' });
  });
  it('reports disabled access separately from action readiness', () => {
    expect(agentActionAvailability(AGENT_ACTION_MAP.get('events.list')!, { ...all, access: false }))
      .toEqual({ enabled: false, reason: 'AGENT_ACCESS_DISABLED' });
    expect(agentActionAvailability(AGENT_ACTION_MAP.get('events.list')!, all)).toEqual({ enabled: true });
  });
});
