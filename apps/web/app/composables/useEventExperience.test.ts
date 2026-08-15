import { describe, expect, it } from 'vitest';
import { DEMO_EVENT } from '@conference/contracts';
import { hasEnabledEventFlowStep, resolveEventExperience } from './useEventExperience';

describe('event experience compatibility', () => {
  it('keeps the legacy four-step flow when an old release has no experience snapshot', () => {
    const legacyEvent = { ...DEMO_EVENT, experience: undefined };

    expect(resolveEventExperience(legacyEvent).registrationFlow.steps).toHaveLength(4);
    expect(hasEnabledEventFlowStep(legacyEvent, 'member-profile')).toBe(false);
  });

  it('enables the member profile only when the published flow contains the enabled step', () => {
    expect(hasEnabledEventFlowStep(DEMO_EVENT, 'member-profile')).toBe(true);
    const disabledEvent = structuredClone(DEMO_EVENT);
    const memberStep = disabledEvent.experience?.registrationFlow.steps.find(
      (step) => step.type === 'member-profile',
    );
    if (memberStep) memberStep.enabled = false;

    expect(hasEnabledEventFlowStep(disabledEvent, 'member-profile')).toBe(false);
  });
});
