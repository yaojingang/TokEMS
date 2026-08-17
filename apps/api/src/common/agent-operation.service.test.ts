import { describe, expect, it } from 'vitest';
import { agentApprovalProjection, deriveAgentImpactSummary } from './agent-operation.service.js';

describe('Agent operation server-authored approval summary', () => {
  it('redacts secret and PII values while retaining the proposed permission change', () => {
    expect(
      agentApprovalProjection({
        grants: ['*'],
        status: 'active',
        password: 'never-store-me',
        profile: { email: 'private@example.com' },
        formAnswers: { customQuestion: 'private free-form answer' },
      }),
    ).toEqual({
      proposed: {
        grants: ['*'],
        status: 'active',
        password: '[redacted]',
        profile: { email: '[redacted]' },
        formAnswers: { customQuestion: '[redacted]' },
      },
    });
  });

  it('derives batch and audience impact from the actual request body', () => {
    expect(
      deriveAgentImpactSummary({
        items: [{ id: 1 }, { id: 2 }],
        audienceCount: 120,
        allAudience: true,
      }),
    ).toEqual({ batchCount: 2, audienceCount: 120, allAudience: true });
  });
});
