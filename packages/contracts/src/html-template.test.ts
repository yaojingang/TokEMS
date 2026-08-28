import { describe, expect, it } from 'vitest';
import {
  ConferenceTemplateDefinitionSchema,
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  HtmlTemplateBindingManifestSchema,
  HtmlTemplatePresentationSchema,
  normalizeConferenceTemplateDefinition,
} from './index.js';

describe('HTML template contracts', () => {
  it('normalizes the legacy definition into a structured V2 presentation', () => {
    const legacy = {
      home: DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation.home,
      faq: DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.faq,
      registrationFlow: DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.registrationFlow,
      initialization: DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.initialization,
    };

    const result = normalizeConferenceTemplateDefinition(legacy);

    expect(result.presentation.kind).toBe('structured');
    if (result.presentation.kind === 'structured') {
      expect(result.presentation.home.blocks[0]?.nodeKey).toBe('home.navigation');
    }
    expect(ConferenceTemplateDefinitionSchema.parse(result)).toEqual(result);
  });

  it('accepts a controlled text and href binding manifest', () => {
    const manifest = HtmlTemplateBindingManifestSchema.parse({
      version: 1,
      bindings: [
        {
          id: 'hero-title',
          kind: 'text',
          nodeId: 'tok-hero-title',
          missingPolicy: 'fallback',
          segments: [
            { kind: 'static', value: '欢迎参加 ' },
            { kind: 'variable', path: 'event.name', fallback: '大会' },
          ],
        },
        {
          id: 'register-link',
          kind: 'attribute',
          nodeId: 'tok-register-link',
          attributeName: 'href',
          variablePath: 'routes.registration',
          missingPolicy: 'error',
        },
        {
          id: 'cooperation-link',
          kind: 'attribute',
          nodeId: 'tok-cooperation-link',
          attributeName: 'href',
          variablePath: 'routes.cooperation',
          missingPolicy: 'error',
        },
      ],
    });

    expect(manifest.bindings).toHaveLength(3);
  });

  it('rejects duplicate binding targets', () => {
    const result = HtmlTemplateBindingManifestSchema.safeParse({
      version: 1,
      bindings: [
        {
          id: 'first',
          kind: 'text',
          nodeId: 'tok-title',
          missingPolicy: 'empty',
          segments: [{ kind: 'variable', path: 'event.name' }],
        },
        {
          id: 'second',
          kind: 'text',
          nodeId: 'tok-title',
          missingPolicy: 'empty',
          segments: [{ kind: 'variable', path: 'event.shortName' }],
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes('目标重复'))).toBe(true);
  });

  it('requires matching document and binding evidence for an HTML presentation', () => {
    const result = HtmlTemplatePresentationSchema.safeParse({
      kind: 'html',
      documentId: '19191919-1919-4191-8191-191919191919',
      engine: 'liquid-v1',
      catalogVersion: 1,
      bindings: { version: 1, bindings: [] },
      bindingDigest: 'sha256:binding',
      sanitizedDigest: 'sha256:document',
      sourceDigest: 'sha256:source',
      compilerVersion: 1,
      usedVariables: [],
      requiredVariables: [],
      actions: [],
      securityReportDigest: 'sha256:report',
    });

    expect(result.success).toBe(true);
  });

  it('adds the disabled attendee-needs flow node to existing HTML templates', () => {
    const definition = structuredClone(DEFAULT_CONFERENCE_TEMPLATE_DEFINITION);
    definition.presentation = HtmlTemplatePresentationSchema.parse({
      kind: 'html',
      documentId: '19191919-1919-4191-8191-191919191919',
      engine: 'liquid-v1',
      catalogVersion: 1,
      bindings: { version: 1, bindings: [] },
      bindingDigest: 'sha256:binding',
      sanitizedDigest: 'sha256:document',
      sourceDigest: 'sha256:source',
      compilerVersion: 1,
      usedVariables: [],
      requiredVariables: [],
      actions: [],
      securityReportDigest: 'sha256:report',
    });
    definition.registrationFlow.steps = definition.registrationFlow.steps.filter(
      (step) => step.nodeKey !== 'flow.attendee-needs',
    );

    const normalized = normalizeConferenceTemplateDefinition(definition);

    expect(
      normalized.registrationFlow.steps.find((step) => step.nodeKey === 'flow.attendee-needs'),
    ).toMatchObject({ type: 'attendee-needs', enabled: false });
  });
});
