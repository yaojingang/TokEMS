import { readFile } from 'node:fs/promises';
import { inspectAction } from './catalog.mjs';
import { prepareOperation } from './operations.mjs';

export const TEMPLATE_PATCH_CONTRACT = Object.freeze({
  topLevelFields: [
    'faqItems',
    'flowSteps',
    'homeBlocks',
    'homeOrder',
    'organizationGroups',
    'seo',
  ],
  homeBlockFields: ['content', 'enabled', 'label', 'nodeKey', 'variant'],
  flowStepFields: ['enabled', 'helpText', 'nodeKey', 'title', 'variant'],
  faqItemFields: ['answer', 'category', 'enabled', 'nodeKey', 'operation', 'question'],
  contentNullSemantics: 'delete-key',
  orderingSemantics: 'complete-unique-node-key-list',
});

const TOP_LEVEL_KEYS = new Set(TEMPLATE_PATCH_CONTRACT.topLevelFields);
const HOME_BLOCK_KEYS = new Set(TEMPLATE_PATCH_CONTRACT.homeBlockFields);
const FLOW_STEP_KEYS = new Set(TEMPLATE_PATCH_CONTRACT.flowStepFields);
const FAQ_ITEM_KEYS = new Set(TEMPLATE_PATCH_CONTRACT.faqItemFields);
const SEO_KEYS = new Set(['title', 'description', 'shareAssetId', 'indexable']);
const ORGANIZATION_GROUP_KEYS = new Set(['speaker', 'media', 'member']);
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function fail(message, code = 'TEMPLATE_PATCH_INVALID') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be one JSON object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`${label} contains unsupported fields: ${unknown.join(', ')}`);
}

function assertSafeObjectKeys(value, label, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      fail(`${label} contains unsafe object key: ${key}`, 'TEMPLATE_PATCH_UNSAFE_KEY');
    }
    assertSafeObjectKeys(item, `${label}.${key}`, seen);
  }
}

function boundedString(value, label, minimum, maximum) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < minimum || trimmed.length > maximum) {
    fail(`${label} must contain ${minimum} to ${maximum} characters`);
  }
  return trimmed;
}

function optionalString(value, label, minimum, maximum) {
  return value === undefined ? undefined : boundedString(value, label, minimum, maximum);
}

function optionalBoolean(value, label) {
  if (value !== undefined && typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function uniqueNodePatches(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const keys = new Set();
  value.forEach((item, index) => {
    const source = object(item, `${label}[${index}]`);
    const nodeKey = boundedString(source.nodeKey, `${label}[${index}].nodeKey`, 3, 100);
    if (keys.has(nodeKey)) {
      fail(`${label} contains duplicate nodeKey: ${nodeKey}`, 'TEMPLATE_PATCH_DUPLICATE_NODE');
    }
    keys.add(nodeKey);
  });
  return value;
}

function patchSeo(home, patch) {
  const seo = object(patch, 'seo');
  exactKeys(seo, SEO_KEYS, 'seo');
  const next = { ...home.seo };
  if (seo.title !== undefined) next.title = boundedString(seo.title, 'seo.title', 0, 120);
  if (seo.description !== undefined) {
    next.description = boundedString(seo.description, 'seo.description', 0, 300);
  }
  if (seo.shareAssetId !== undefined) {
    if (seo.shareAssetId !== null && typeof seo.shareAssetId !== 'string') {
      fail('seo.shareAssetId must be a string or null');
    }
    next.shareAssetId = seo.shareAssetId;
  }
  if (seo.indexable !== undefined) {
    next.indexable = optionalBoolean(seo.indexable, 'seo.indexable');
  }
  home.seo = next;
}

function patchHomeBlocks(home, patches) {
  uniqueNodePatches(patches, 'homeBlocks').forEach((item, index) => {
    const source = object(item, `homeBlocks[${index}]`);
    exactKeys(source, HOME_BLOCK_KEYS, `homeBlocks[${index}]`);
    const nodeKey = String(source.nodeKey);
    const block = home.blocks.find((candidate) => candidate.nodeKey === nodeKey);
    if (!block) fail(`Unknown home block nodeKey: ${nodeKey}`, 'TEMPLATE_PATCH_UNKNOWN_NODE');
    const label = optionalString(source.label, `${nodeKey}.label`, 1, 80);
    const variant = optionalString(source.variant, `${nodeKey}.variant`, 1, 80);
    const enabled = optionalBoolean(source.enabled, `${nodeKey}.enabled`);
    if (label !== undefined) block.label = label;
    if (variant !== undefined) block.variant = variant;
    if (enabled !== undefined) block.enabled = enabled;
    if (source.content !== undefined) {
      const contentPatch = object(source.content, `${nodeKey}.content`);
      const content = { ...block.content };
      Object.entries(contentPatch).forEach(([key, value]) => {
        if (value === null) delete content[key];
        else content[key] = value;
      });
      block.content = content;
    }
  });
}

function patchHomeOrder(home, order) {
  if (!Array.isArray(order) || order.some((item) => typeof item !== 'string')) {
    fail('homeOrder must be an array of nodeKey strings');
  }
  const currentKeys = home.blocks.map((block) => block.nodeKey);
  const requestedKeys = order.map((key) => key.trim());
  if (new Set(requestedKeys).size !== requestedKeys.length) {
    fail('homeOrder contains duplicate nodes', 'TEMPLATE_PATCH_DUPLICATE_NODE');
  }
  if (
    requestedKeys.length !== currentKeys.length ||
    requestedKeys.some((key) => !currentKeys.includes(key))
  ) {
    fail(
      'homeOrder must contain every current home block exactly once',
      'TEMPLATE_PATCH_INCOMPLETE_ORDER',
    );
  }
  const blocks = new Map(home.blocks.map((block) => [block.nodeKey, block]));
  home.blocks = requestedKeys.map((key) => blocks.get(key));
}

function patchFlowSteps(registrationFlow, patches) {
  uniqueNodePatches(patches, 'flowSteps').forEach((item, index) => {
    const source = object(item, `flowSteps[${index}]`);
    exactKeys(source, FLOW_STEP_KEYS, `flowSteps[${index}]`);
    const nodeKey = String(source.nodeKey);
    const step = registrationFlow.steps.find((candidate) => candidate.nodeKey === nodeKey);
    if (!step) fail(`Unknown flow step nodeKey: ${nodeKey}`, 'TEMPLATE_PATCH_UNKNOWN_NODE');
    const title = optionalString(source.title, `${nodeKey}.title`, 1, 80);
    const helpText = optionalString(source.helpText, `${nodeKey}.helpText`, 0, 500);
    const variant = optionalString(source.variant, `${nodeKey}.variant`, 1, 80);
    const enabled = optionalBoolean(source.enabled, `${nodeKey}.enabled`);
    if (title !== undefined) step.title = title;
    if (helpText !== undefined) step.helpText = helpText;
    if (variant !== undefined) step.variant = variant;
    if (enabled !== undefined) step.enabled = enabled;
  });
}

function patchFaqItems(faq, patches) {
  uniqueNodePatches(patches, 'faqItems').forEach((item, index) => {
    const source = object(item, `faqItems[${index}]`);
    exactKeys(source, FAQ_ITEM_KEYS, `faqItems[${index}]`);
    const nodeKey = String(source.nodeKey);
    if (!/^faq\.[a-z0-9-]+$/u.test(nodeKey)) fail(`Invalid FAQ nodeKey: ${nodeKey}`);
    const existingIndex = faq.items.findIndex((candidate) => candidate.nodeKey === nodeKey);
    const operation = source.operation ?? 'upsert';
    if (operation !== 'upsert' && operation !== 'remove') {
      fail(`${nodeKey}.operation must be upsert or remove`);
    }
    if (operation === 'remove') {
      if (existingIndex < 0) fail(`Unknown FAQ nodeKey: ${nodeKey}`, 'TEMPLATE_PATCH_UNKNOWN_NODE');
      faq.items.splice(existingIndex, 1);
      return;
    }
    const existing = existingIndex >= 0 ? faq.items[existingIndex] : undefined;
    if (!existing) {
      for (const field of ['category', 'question', 'answer', 'enabled']) {
        if (source[field] === undefined) fail(`New FAQ ${nodeKey} requires ${field}`);
      }
    }
    const next = existing ? { ...existing } : { nodeKey };
    const category = optionalString(source.category, `${nodeKey}.category`, 1, 80);
    const question = optionalString(source.question, `${nodeKey}.question`, 1, 240);
    const answer = optionalString(source.answer, `${nodeKey}.answer`, 1, 4000);
    const enabled = optionalBoolean(source.enabled, `${nodeKey}.enabled`);
    if (category !== undefined) next.category = category;
    if (question !== undefined) next.question = question;
    if (answer !== undefined) next.answer = answer;
    if (enabled !== undefined) next.enabled = enabled;
    if (existingIndex >= 0) faq.items[existingIndex] = next;
    else faq.items.push(next);
  });
}

function patchOrganizationGroups(home, value) {
  if (!Array.isArray(value) || value.length > 3) {
    fail('organizationGroups must be an array with no more than three groups');
  }
  const seen = new Set();
  const groups = value.map((item, index) => {
    const source = object(item, `organizationGroups[${index}]`);
    exactKeys(
      source,
      new Set(['key', 'label', 'meta', 'organizations']),
      `organizationGroups[${index}]`,
    );
    if (!ORGANIZATION_GROUP_KEYS.has(source.key) || seen.has(source.key)) {
      fail(`Invalid or duplicate organization group key: ${String(source.key)}`);
    }
    seen.add(source.key);
    if (!Array.isArray(source.organizations) || source.organizations.length > 100) {
      fail(`organizationGroups[${index}].organizations must contain at most 100 names`);
    }
    return {
      key: source.key,
      label: boundedString(source.label, `organizationGroups[${index}].label`, 1, 80),
      meta: boundedString(source.meta, `organizationGroups[${index}].meta`, 1, 80),
      organizations: source.organizations.map((name, organizationIndex) =>
        boundedString(
          name,
          `organizationGroups[${index}].organizations[${organizationIndex}]`,
          2,
          120,
        ),
      ),
    };
  });
  const cooperation = home.blocks.find((block) => block.nodeKey === 'home.cooperation');
  if (!cooperation) {
    fail('Template has no home.cooperation block', 'TEMPLATE_PATCH_UNKNOWN_NODE');
  }
  cooperation.content = { ...cooperation.content, organizationGroups: groups };
}

export function applyTemplatePatch(definition, patch) {
  const sourceDefinition = object(definition, 'template definition');
  const sourcePatch = object(patch, 'template patch');
  assertSafeObjectKeys(sourcePatch, 'template patch');
  exactKeys(sourcePatch, TOP_LEVEL_KEYS, 'template patch');
  if (!Object.keys(sourcePatch).length) fail('Template patch must contain at least one change');
  if (sourceDefinition.presentation?.kind !== 'structured') {
    fail('Template patch supports structured templates only', 'TEMPLATE_PATCH_KIND_UNSUPPORTED');
  }
  const next = structuredClone(sourceDefinition);
  const home = next.presentation.home;
  if (sourcePatch.seo !== undefined) patchSeo(home, sourcePatch.seo);
  if (sourcePatch.homeBlocks !== undefined) patchHomeBlocks(home, sourcePatch.homeBlocks);
  if (sourcePatch.homeOrder !== undefined) patchHomeOrder(home, sourcePatch.homeOrder);
  if (sourcePatch.flowSteps !== undefined) {
    patchFlowSteps(next.registrationFlow, sourcePatch.flowSteps);
  }
  if (sourcePatch.faqItems !== undefined) patchFaqItems(next.faq, sourcePatch.faqItems);
  if (sourcePatch.organizationGroups !== undefined) {
    patchOrganizationGroups(home, sourcePatch.organizationGroups);
  }
  return next;
}

export async function prepareTemplatePatch({ templateId, patchFile, reasonFile, connectionId }) {
  const patch = JSON.parse(await readFile(patchFile, 'utf8'));
  const draftResult = await inspectAction('templates.draft.get', { templateId }, connectionId);
  const draft = object(draftResult.data, 'live template draft');
  if (!Number.isInteger(draft.revision) || !draft.definition) {
    fail('Live template draft is missing its definition or revision');
  }
  const definition = applyTemplatePatch(draft.definition, patch);
  const prepared = await prepareOperation({
    actionId: 'templates.draft.update',
    params: { templateId },
    input: { definition, revision: draft.revision },
    reasonFile,
    connectionId,
  });
  return {
    ...prepared,
    templatePatch: {
      templateId,
      sourceRevision: draft.revision,
      changedSections: Object.keys(patch),
    },
  };
}
