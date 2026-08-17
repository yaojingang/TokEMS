import { readFile } from 'node:fs/promises';
import { authenticatedFetch, loadProfile } from './auth.mjs';
import { saveJson } from './files.mjs';

export async function syncCapabilities(connectionId) {
  const profile = loadProfile(connectionId);
  const { value } = await authenticatedFetch(profile.connectionId, '/api/v1/agent/capabilities');
  const clientMajor = 1;
  const apiMajor = Number(String(value.apiVersion || '0').split('.')[0]);
  if (apiMajor !== clientMajor) {
    const error = new Error('TokEMS Agent API major version is unsupported by this Skill');
    error.code = 'AGENT_VERSION_UNSUPPORTED';
    throw error;
  }
  await saveJson(`catalog-${profile.connectionId}.json`, value);
  return value;
}

export async function actionDefinition(actionId, connectionId) {
  const catalog = await syncCapabilities(connectionId);
  const action = catalog.actions.find((item) => item.actionId === actionId);
  if (!action) {
    const error = new Error(`Action is unavailable on this connection: ${actionId}`);
    error.code = 'AGENT_ACTION_NOT_CLASSIFIED';
    throw error;
  }
  return { catalog, action };
}

export async function readParams(path) {
  if (!path) return {};
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Action params file must contain one JSON object');
  }
  return value;
}

export function actionPath(action, params) {
  const consumed = new Set();
  const path = action.path.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, (_, name) => {
    const value = params[name];
    if (value === undefined || value === null || value === '') {
      const error = new Error(`Action parameter is required: ${name}`);
      error.code = 'ACTION_PARAMETER_REQUIRED';
      throw error;
    }
    consumed.add(name);
    return encodeURIComponent(String(value));
  });
  if (path !== action.path && path.includes(':'))
    throw new Error('Action route parameters are incomplete');
  const query = new URLSearchParams();
  if (action.method === 'GET') {
    for (const [key, value] of Object.entries(params)) {
      if (consumed.has(key) || key.startsWith('_') || value === undefined || value === null)
        continue;
      if (Array.isArray(value)) value.forEach((item) => query.append(key, String(item)));
      else query.set(key, String(value));
    }
  }
  return query.size ? `${path}?${query}` : path;
}

export async function inspectAction(actionId, params, connectionId, purposePath) {
  const { action } = await actionDefinition(actionId, connectionId);
  if (action.method !== 'GET') {
    return { action, target: params, requiresPrepare: true };
  }
  let purpose;
  if (action.riskBase === 'sensitive-read') {
    if (!purposePath) {
      const error = new Error('Sensitive Agent reads require --purpose-file');
      error.code = 'SENSITIVE_READ_PURPOSE_REQUIRED';
      throw error;
    }
    purpose = (await readFile(purposePath, 'utf8')).trim();
    if (purpose.length < 8 || purpose.length > 1_000) {
      const error = new Error('Sensitive read purpose must contain 8 to 1000 characters');
      error.code = 'SENSITIVE_READ_PURPOSE_INVALID';
      throw error;
    }
  }
  const { value } = await authenticatedFetch(connectionId, actionPath(action, params), {
    headers: purpose ? { 'X-Agent-Purpose': purpose } : undefined,
  });
  return { action, data: value };
}
