import { describe, expect, it } from 'vitest';
import { agentApprovalHash } from './agent-approval';

describe('Agent approval hash', () => {
  it('is stable across object key order and changes with the approval scope', async () => {
    const first = await agentApprovalHash({ scopes: ['tokems:read'], id: 'authorization-1' });
    const reordered = await agentApprovalHash({ id: 'authorization-1', scopes: ['tokems:read'] });
    const changed = await agentApprovalHash({ id: 'authorization-1', scopes: ['tokems:write'] });
    expect(first).toBe(reordered);
    expect(changed).not.toBe(first);
  });
});
