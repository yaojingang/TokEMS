import type { TemplateFlowPreset, TemplateFlowStep } from '@conference/contracts';

const CORE_FLOW_NODE_KEYS = new Set([
  'flow.ticket-selection',
  'flow.attendee-form',
  'flow.review-payment',
  'flow.success-ticket',
]);
const CORE_FLOW_TYPES = new Set([
  'ticket-selection',
  'attendee-form',
  'review-payment',
  'success-ticket',
]);
const TEMPLATE_FLOW_STEP_LIMIT = 9;

const common = {
  helpText: '',
  variant: 'default',
  enabled: true,
} as const;

export function applyTemplateFlowPreset(
  existingSteps: TemplateFlowStep[],
  preset: TemplateFlowPreset,
): TemplateFlowStep[] {
  const presetSteps: TemplateFlowStep[] =
    preset === 'standard'
      ? [
          {
            ...common,
            nodeKey: 'flow.ticket-selection',
            type: 'ticket-selection',
            title: '选择票种',
          },
          { ...common, nodeKey: 'flow.attendee-form', type: 'attendee-form', title: '填写资料' },
          {
            ...common,
            nodeKey: 'flow.review-payment',
            type: 'review-payment',
            title: '确认并支付',
          },
          { ...common, nodeKey: 'flow.success-ticket', type: 'success-ticket', title: '报名成功' },
        ]
      : preset === 'quick'
        ? [
            {
              ...common,
              nodeKey: 'flow.attendee-form',
              type: 'attendee-form',
              title: '票种与资料',
            },
            {
              ...common,
              nodeKey: 'flow.review-payment',
              type: 'review-payment',
              title: '确认并支付',
            },
            {
              ...common,
              nodeKey: 'flow.success-ticket',
              type: 'success-ticket',
              title: '报名成功',
            },
          ]
        : [
            { ...common, nodeKey: 'flow.attendee-form', type: 'attendee-form', title: '填写资料' },
            {
              ...common,
              nodeKey: 'flow.success-ticket',
              type: 'success-ticket',
              title: '报名成功',
            },
          ];
  const extensionSteps = existingSteps.filter(
    (step) => !CORE_FLOW_NODE_KEYS.has(step.nodeKey) && !CORE_FLOW_TYPES.has(step.type),
  );
  const result = [...presetSteps, ...extensionSteps];
  if (result.length > TEMPLATE_FLOW_STEP_LIMIT) {
    throw new RangeError(
      `报名流程最多支持 ${TEMPLATE_FLOW_STEP_LIMIT} 个步骤；请先移除不再需要的扩展步骤`,
    );
  }
  return result;
}
