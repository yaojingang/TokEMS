import {
  ConferenceTemplateDefinitionSchema,
  normalizeConferenceTemplateDefinition,
  type ConferenceTemplateDefinition,
  type TemplateSurface,
} from '@conference/contracts';

type SurfaceOverrideDocument = Record<string, unknown>;
type ExperienceOverrides = Partial<Record<TemplateSurface, SurfaceOverrideDocument>>;

function overridePatch(
  document: SurfaceOverrideDocument,
  key: string,
): Record<string, unknown> | undefined {
  const value = document[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mergeNode<T extends { nodeKey: string }>(
  node: T,
  patch: Record<string, unknown> | undefined,
) {
  if (!patch) return node;
  const baseRecord = node as unknown as Record<string, unknown>;
  const baseContent =
    baseRecord.content && typeof baseRecord.content === 'object'
      ? (baseRecord.content as Record<string, unknown>)
      : undefined;
  const patchContent =
    patch.content && typeof patch.content === 'object'
      ? (patch.content as Record<string, unknown>)
      : undefined;
  return {
    ...node,
    ...patch,
    ...(baseContent || patchContent
      ? { content: { ...(baseContent ?? {}), ...(patchContent ?? {}) } }
      : {}),
    nodeKey: node.nodeKey,
  } as T;
}

export function mergeTemplateDefinition(
  definition: ConferenceTemplateDefinition,
  overrides: ExperienceOverrides,
): ConferenceTemplateDefinition {
  const normalized = normalizeConferenceTemplateDefinition(definition);
  const homeOverrides = overrides.home ?? {};
  const faqOverrides = overrides.faq ?? {};
  const flowOverrides = overrides.registration_flow ?? {};
  const homePage = overridePatch(homeOverrides, '$page') ?? {};
  const faqPage = overridePatch(faqOverrides, '$page') ?? {};
  const flowPage = overridePatch(flowOverrides, '$page') ?? {};
  const faqAdditions = Array.isArray(faqOverrides.$additions)
    ? (faqOverrides.$additions as ConferenceTemplateDefinition['faq']['items'])
    : [];
  const presentation =
    normalized.presentation.kind === 'structured'
      ? {
          ...normalized.presentation,
          home: {
            ...normalized.presentation.home,
            ...homePage,
            seo: {
              ...normalized.presentation.home.seo,
              ...(homePage.seo && typeof homePage.seo === 'object'
                ? (homePage.seo as Record<string, unknown>)
                : {}),
            },
            blocks: normalized.presentation.home.blocks.map((node) =>
              mergeNode(node, overridePatch(homeOverrides, node.nodeKey)),
            ),
          },
        }
      : normalized.presentation;
  const merged = {
    ...normalized,
    presentation,
    faq: {
      ...normalized.faq,
      ...faqPage,
      items: [
        ...normalized.faq.items.map((node) =>
          mergeNode(node, overridePatch(faqOverrides, node.nodeKey)),
        ),
        ...faqAdditions.filter(
          (addition) => !normalized.faq.items.some((item) => item.nodeKey === addition.nodeKey),
        ),
      ],
    },
    registrationFlow: {
      ...normalized.registrationFlow,
      ...flowPage,
      branches: {
        ...normalized.registrationFlow.branches,
        ...(flowPage.branches && typeof flowPage.branches === 'object'
          ? (flowPage.branches as Record<string, unknown>)
          : {}),
      },
      steps: normalized.registrationFlow.steps.map((node) =>
        mergeNode(node, overridePatch(flowOverrides, node.nodeKey)),
      ),
    },
  };
  return ConferenceTemplateDefinitionSchema.parse(merged);
}
