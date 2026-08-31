import { describe, expect, it } from 'vitest';
import { enumerateLinkedFlowSteps } from './flow-stepper-actions';

describe('enumerateLinkedFlowSteps', () => {
  it('keeps actionable steps on both sides of the active ticket step', () => {
    const steps = enumerateLinkedFlowSteps([
      { title: '完善参会名片', to: '/showcase' },
      { title: '获取电子票' },
      { title: '提交参会需求', to: '/needs' },
    ]);

    expect(steps).toEqual([
      { title: '完善参会名片', to: '/showcase', number: 1 },
      { title: '提交参会需求', to: '/needs', number: 3 },
    ]);
  });
});
