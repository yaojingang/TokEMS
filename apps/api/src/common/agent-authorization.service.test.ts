import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_IDS } from '@conference/contracts';
import { sha256 } from '@conference/security';
import {
  AgentAuthorizationService,
  agentApprovalRequestHash,
  agentVersionAtLeast,
} from './agent-authorization.service.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Agent authorization bindings', () => {
  it('uses a stable canonical approval hash', () => {
    expect(agentApprovalRequestHash({ scopes: ['tokems:read'], id: 'authorization-1' })).toBe(
      agentApprovalRequestHash({ id: 'authorization-1', scopes: ['tokems:read'] }),
    );
    expect(agentApprovalRequestHash({ a: 1, b: 2 })).toBe(sha256('{"a":1,"b":2}'));
  });

  it('enforces the minimum stable connector version', () => {
    expect(agentVersionAtLeast('0.2.0', '0.2.0')).toBe(true);
    expect(agentVersionAtLeast('0.3.0', '0.2.0')).toBe(true);
    expect(agentVersionAtLeast('0.2.0-beta.1', '0.2.0')).toBe(false);
    expect(agentVersionAtLeast('0.1.1', '0.2.0')).toBe(false);
  });

  it('keeps human governance reads available while Agent Access is disabled', async () => {
    vi.stubEnv('TOKEMS_AGENT_ACCESS_ENABLED', 'false');
    const orderBy = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const service = new AgentAuthorizationService(
      {} as never,
      { db: { select } } as never,
      {} as never,
    );

    await expect(
      service.listConnections({
        sub: DEMO_IDS.adminUser,
        organizationId: DEMO_IDS.organization,
        membershipId: 'membership-1',
      } as never),
    ).resolves.toEqual([]);
    expect(select).toHaveBeenCalledOnce();
  });
});
