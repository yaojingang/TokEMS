import { describe, expect, it } from 'vitest';
import { sha256 } from '@conference/security';
import { agentApprovalRequestHash, agentVersionAtLeast } from './agent-authorization.service.js';

describe('Agent authorization bindings', () => {
  it('uses a stable canonical approval hash', () => {
    expect(agentApprovalRequestHash({ scopes: ['tokems:read'], id: 'authorization-1' })).toBe(
      agentApprovalRequestHash({ id: 'authorization-1', scopes: ['tokems:read'] }),
    );
    expect(agentApprovalRequestHash({ a: 1, b: 2 })).toBe(sha256('{"a":1,"b":2}'));
  });

  it('enforces the minimum stable connector version', () => {
    expect(agentVersionAtLeast('0.1.1', '0.1.1')).toBe(true);
    expect(agentVersionAtLeast('0.2.0', '0.1.1')).toBe(true);
    expect(agentVersionAtLeast('0.1.1-beta.1', '0.1.1')).toBe(false);
    expect(agentVersionAtLeast('0.1.0', '0.1.1')).toBe(false);
  });
});
