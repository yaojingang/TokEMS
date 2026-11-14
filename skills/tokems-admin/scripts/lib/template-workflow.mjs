import { readFile } from 'node:fs/promises';
import { inspectAction } from './catalog.mjs';
import { applyTemplatePatch } from './template-patch.mjs';
import { prepareOperation } from './operations.mjs';
import { writeArtifact } from './files.mjs';
import { stableStringify } from './crypto.mjs';

export function templateDifference(before, after, path = '') {
  if (stableStringify(before) === stableStringify(after)) return [];
  if (before && after && !Array.isArray(before) && !Array.isArray(after) &&
    typeof before === 'object' && typeof after === 'object') {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
      .flatMap((key) => templateDifference(before[key], after[key], `${path}/${key.replaceAll('~','~0').replaceAll('/','~1')}`));
  }
  return [{ path: path || '/', before: before ?? null, after: after ?? null }];
}

export async function pullTemplate(templateId, output, connectionId) {
  const draft = (await inspectAction('templates.draft.get', { templateId }, connectionId)).data;
  const binding = await inspectAction('templates.usages.list', { templateId }, connectionId);
  return { templateId, revision: draft.revision, artifact: await writeArtifact(output,
    Buffer.from(JSON.stringify({ ...draft, usages: binding.data }, null, 2))) };
}

export async function candidateTemplate(templateId, patchFile, connectionId) {
  const draft = (await inspectAction('templates.draft.get', { templateId }, connectionId)).data;
  const definition = patchFile ? applyTemplatePatch(draft.definition,
    JSON.parse(await readFile(patchFile, 'utf8'))) : draft.definition;
  return { draft, definition, difference: templateDifference(draft.definition, definition) };
}

export async function previewTemplate({ templateId, eventId, patchFile, reasonFile, connectionId }) {
  if (!Number.isSafeInteger(Number(eventId)) || Number(eventId) < 1) throw new Error('A valid event ID is required');
  const candidate = await candidateTemplate(templateId, patchFile, connectionId);
  return { ...(await prepareOperation({ actionId: 'templates.preview.create', params: { templateId },
    input: { eventId: Number(eventId), revision: candidate.draft.revision, definition: candidate.definition },
    reasonFile, connectionId })), templatePreview: { templateId, eventId, revision: candidate.draft.revision,
      changes: candidate.difference, submissionsDisabled: true } };
}
