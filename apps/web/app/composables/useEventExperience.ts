import {
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  type ConferenceTemplateDefinition,
  type PublicEvent,
  type TemplateFlowStep,
} from '@conference/contracts';

type StructuredPresentation = Extract<
  ConferenceTemplateDefinition['presentation'],
  { kind: 'structured' }
>;

export interface ResolvedStructuredExperience {
  home: StructuredPresentation['home'];
  faq: ConferenceTemplateDefinition['faq'];
  registrationFlow: ConferenceTemplateDefinition['registrationFlow'];
  initialization: ConferenceTemplateDefinition['initialization'];
}

function legacyStaticHome(home: StructuredPresentation['home']) {
  return {
    ...home,
    blocks: home.blocks.map((block) =>
      block.nodeKey === 'home.stats' ? { ...block, variant: 'inline' } : block,
    ),
  };
}

export function resolveEventExperience(event: PublicEvent): ResolvedStructuredExperience {
  const fallback = DEFAULT_CONFERENCE_TEMPLATE_DEFINITION;
  if (fallback.presentation.kind !== 'structured') {
    throw new Error('默认大会模板必须使用结构化首页');
  }
  return {
    home: event.experience?.home ?? legacyStaticHome(fallback.presentation.home),
    faq: event.experience?.faq ?? {
      ...fallback.faq,
      items: event.faqs.map((item, index) => ({
        nodeKey: `faq.legacy-${index + 1}`,
        category: '常见问题',
        question: item.question,
        answer: item.answer,
        enabled: true,
      })),
    },
    registrationFlow: event.experience?.registrationFlow ?? {
      ...fallback.registrationFlow,
      steps: fallback.registrationFlow.steps.filter((step) => step.type !== 'member-profile'),
    },
    initialization: fallback.initialization,
  };
}

export function hasEnabledEventFlowStep(event: PublicEvent, type: TemplateFlowStep['type']) {
  return Boolean(
    event.experience?.registrationFlow.steps.some((step) => step.type === type && step.enabled),
  );
}

export function enabledFlowSteps(
  event: PublicEvent,
  options: { paymentRequired: boolean; invoiceRequired?: boolean },
): TemplateFlowStep[] {
  const definition = resolveEventExperience(event);
  const steps = definition.registrationFlow.steps.filter((step) => {
    if (!step.enabled) return false;
    if (step.type === 'review-payment' && !options.paymentRequired) return false;
    if (step.type === 'invoice-details' && !options.invoiceRequired) return false;
    if (step.type === 'waitlist' || step.type === 'manual-review') return false;
    return true;
  });

  if (
    options.invoiceRequired &&
    definition.registrationFlow.branches.invoiceAfterPayment &&
    !steps.some((step) => step.type === 'invoice-details')
  ) {
    const successIndex = steps.findIndex((step) => step.type === 'success-ticket');
    const invoiceStep: TemplateFlowStep = {
      nodeKey: 'flow.invoice-details',
      type: 'invoice-details',
      title: '填写发票信息',
      helpText: '补充发票抬头与接收方式。',
      variant: 'form',
      enabled: true,
    };
    steps.splice(successIndex < 0 ? steps.length : successIndex, 0, invoiceStep);
  }

  return steps;
}

export function activeFlowStep(steps: TemplateFlowStep[], type: TemplateFlowStep['type']): number {
  const index = steps.findIndex((step) => step.type === type);
  return index < 0 ? 1 : index + 1;
}
