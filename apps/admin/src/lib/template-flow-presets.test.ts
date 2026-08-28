import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFERENCE_TEMPLATE_DEFINITION } from '@conference/contracts';
import { applyTemplateFlowPreset } from './template-flow-presets';

describe('template flow presets', () => {
  it.each(['standard', 'quick', 'free'] as const)(
    'preserves post-registration extension steps when applying the %s preset',
    (preset) => {
      const existing = structuredClone(
        DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.registrationFlow.steps,
      );

      const result = applyTemplateFlowPreset(existing, preset);

      expect(result.map((step) => step.nodeKey)).toContain('flow.member-profile');
      expect(result.map((step) => step.nodeKey)).toContain('flow.attendee-needs');
      expect(result.find((step) => step.nodeKey === 'flow.attendee-needs')).toMatchObject({
        enabled: false,
        variant: 'focused-question',
      });
    },
  );

  it('deduplicates core steps that use a legacy custom node key', () => {
    const existing = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.registrationFlow.steps);
    const attendeeForm = existing.find((step) => step.type === 'attendee-form')!;
    attendeeForm.nodeKey = 'flow.legacy-attendee-form';

    const result = applyTemplateFlowPreset(existing, 'standard');

    expect(result.filter((step) => step.type === 'attendee-form')).toHaveLength(1);
  });

  it('rejects a preset switch that cannot preserve every extension within the contract limit', () => {
    const defaults = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.registrationFlow.steps);
    const existing = defaults.filter((step) =>
      ['attendee-form', 'success-ticket', 'attendee-needs'].includes(step.type),
    );
    while (existing.length < 9) {
      const index = existing.length;
      existing.push({
        nodeKey: `flow.extension-${index}`,
        type: 'member-profile',
        title: `扩展步骤 ${index}`,
        helpText: '',
        variant: 'default',
        enabled: false,
      });
    }

    expect(() => applyTemplateFlowPreset(existing, 'standard')).toThrow('最多支持 9 个');
    expect(existing).toHaveLength(9);
  });
});
