#!/usr/bin/env node
import { SKILL_VERSION } from './lib/version.mjs';
import { pullTemplate, candidateTemplate, previewTemplate } from './lib/template-workflow.mjs';
import {
  inspectInstance,
  connect,
  listConnections,
  loadProfile,
  revokeConnection,
  selectConnection,
  activeConnectionId,
  authenticatedFetch,
} from './lib/auth.mjs';
import { actionDefinition, inspectAction, readParams, syncCapabilities } from './lib/catalog.mjs';
import { prepareAsset, uploadPreparedFile } from './lib/uploads.mjs';
import { credentialStoreAvailable, credentialStoreKind } from './lib/credentials.mjs';
import {
  cancelOperation,
  confirmOperation,
  downloadArtifact,
  executeOperation,
  operationStatus,
  operationVerification,
  prepareOperation,
  reconcileOperation,
} from './lib/operations.mjs';
import { redact, safeError } from './lib/redaction.mjs';
import { prepareTemplatePatch } from './lib/template-patch.mjs';

const HELP = `TokEMS Admin Skill connector ${SKILL_VERSION}

Usage:
  tokems-admin.js instance inspect --origin <https-origin>
  tokems-admin.js auth connect --origin <https-origin> --name <display-name> [--profile read|content|full] [--scope "tokems:read"]
  tokems-admin.js connection list|use|status|revoke [--connection <id>]
  tokems-admin.js capabilities sync [--connection <id>]
  tokems-admin.js action inspect --action <id> --params-file <path> [--purpose-file <path>] [--connection <id>]
  tokems-admin.js action prepare --action <id> --params-file <path> --input-file <path> --reason-file <path> [--secret-file <path>]
  tokems-admin.js template pull --template <id> --output <absolute-path>
  tokems-admin.js template diff --template <id> --patch-file <path>
  tokems-admin.js template preview --template <id> --event <id> --reason-file <path> [--patch-file <path>]
  tokems-admin.js template patch --template <id> --patch-file <path> --reason-file <path> [--connection <id>]
  tokems-admin.js action confirm|execute --operation <id> [--connection <id>]
  tokems-admin.js artifact download --operation <id> --output <absolute-path> [--connection <id>]
  tokems-admin.js operation status|reconcile|cancel --operation <id> [--connection <id>]
  tokems-admin.js asset prepare --file <path> --media-type <type> --alt-text <text> --reason-file <path>
  tokems-admin.js asset upload --operation <id> --file <path> --reason-file <path>
  tokems-admin.js doctor

All successful operational commands write one redacted JSON object to stdout.
Authorization progress and browser URLs are written to stderr.`;

function parseArguments(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
    const name = item.slice(2);
    if (name === 'help' || name === 'version') {
      options[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Option requires a value: --${name}`);
    if (Object.hasOwn(options, name)) throw Object.assign(new Error(`Duplicate option: --${name}`), { code: 'CLI_OPTION_UNSUPPORTED' });
    options[name] = value;
    index += 1;
  }
  return { positionals, options };
}

function required(options, name) {
  const value = options[name];
  if (!value) {
    const error = new Error(`Required option is missing: --${name}`);
    error.code = 'CLI_ARGUMENT_REQUIRED';
    throw error;
  }
  return value;
}

function connectionId(options) {
  return options.connection || activeConnectionId();
}

function envelope(data, context = {}) {
  const operation = data?.operation;
  return redact({
    ok: true,
    action: context.action || operation?.actionId,
    connectionId: context.connectionId,
    organizationId: context.organizationId,
    risk: operation?.risk || context.risk,
    operationId: operation?.id,
    status: operation?.status || context.status || 'succeeded',
    data: data?.data ?? data,
    verification: operationVerification(operation, data?.verification),
    artifact: data?.artifact,
    warnings: context.warnings ?? [],
    rollback: context.rollback,
    traceId: operation?.traceId,
  });
}

async function main() {
  const { positionals, options } = parseArguments(process.argv.slice(2));
  if (options.version) { process.stdout.write(`${SKILL_VERSION}\n`); return; }
  if (options.help || !positionals.length) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const [group, command] = positionals;
  const commandOptions = {"instance inspect": "origin", "auth connect": "origin name scope profile", "connection list": "", "connection use": "connection", "connection status": "connection", "connection revoke": "connection", "capabilities sync": "connection", "action inspect": "action params-file purpose-file connection", "action prepare": "action params-file input-file reason-file secret-file connection", "action confirm": "operation connection", "action execute": "operation connection", "template patch": "template patch-file reason-file connection", "template pull": "template output connection", "template diff": "template patch-file connection", "template preview": "template event patch-file reason-file connection", "asset prepare": "file media-type alt-text reason-file connection", "asset upload": "file operation reason-file connection", "artifact download": "operation output connection", "operation status": "operation connection", "operation reconcile": "operation connection", "operation cancel": "operation connection", "doctor": ""};
  const commandKey = positionals.join(' ');
  if (!Object.hasOwn(commandOptions, commandKey)) throw Object.assign(new Error('Unsupported CLI command'), { code: 'CLI_COMMAND_UNSUPPORTED' });
  const allowedOptions = commandOptions[commandKey].split(' ');
  for (const key of Object.keys(options)) {
    if (!allowedOptions.includes(key)) throw Object.assign(new Error(`Unsupported option: --${key}`), { code: 'CLI_OPTION_UNSUPPORTED' });
  }

  if (group === 'template' && ['pull', 'diff', 'preview'].includes(command)) {
    const id = connectionId(options);
    const templateId = required(options, 'template');
    let data;
    if (command === 'pull') data = await pullTemplate(templateId, required(options, 'output'), id);
    else if (command === 'diff') {
      const candidate = await candidateTemplate(templateId, required(options, 'patch-file'), id);
      data = { templateId, revision: candidate.draft.revision, changes: candidate.difference };
    } else data = await previewTemplate({ templateId, eventId: required(options, 'event'),
      patchFile: options['patch-file'], reasonFile: required(options, 'reason-file'), connectionId: id });
    console.log(JSON.stringify(envelope(data, { connectionId: id, status: command === 'preview' ? 'prepared' : 'inspected' })));
    return;
  }
  if (group === 'asset' && ['prepare', 'upload'].includes(command)) {
    const id = connectionId(options);
    const args = { file: required(options, 'file'), reasonFile: required(options, 'reason-file'), connectionId: id };
    const data = command === 'prepare'
      ? await prepareAsset({ ...args, mediaType: required(options, 'media-type'), altText: required(options, 'alt-text') })
      : await uploadPreparedFile({ ...args, operationId: required(options, 'operation') });
    console.log(JSON.stringify(envelope(data, { connectionId: id, status: 'prepared' })));
    return;
  }
  if (group === 'instance' && command === 'inspect') {
    const data = await inspectInstance(required(options, 'origin'));
    console.log(JSON.stringify(envelope(data, { status: 'inspected' })));
    return;
  }
  if (group === 'auth' && command === 'connect') {
    const data = await connect({
      origin: required(options, 'origin'),
      name: options.name,
      scope: options.scope,
      profile: options.profile,
    });
    console.log(
      JSON.stringify(
        envelope(data, {
          connectionId: data.connectionId,
          status: 'connected',
        }),
      ),
    );
    return;
  }
  if (group === 'connection' && command === 'list') {
    console.log(JSON.stringify(envelope({ data: listConnections() }, { status: 'listed' })));
    return;
  }
  if (group === 'connection' && command === 'use') {
    const selected = selectConnection(required(options, 'connection'));
    console.log(
      JSON.stringify(envelope(selected, { connectionId: selected.id, status: 'selected' })),
    );
    return;
  }
  if (group === 'connection' && command === 'status') {
    const id = connectionId(options);
    const profile = loadProfile(id);
    const catalog = await syncCapabilities(id);
    console.log(
      JSON.stringify(
        envelope(
          {
            data: {
              name: profile.name,
              origin: profile.origin,
              scopes: catalog.scopes,
              features: catalog.features,
              catalogVersion: catalog.catalogVersion,
            },
          },
          {
            connectionId: profile.connectionId,
            organizationId: profile.organizationId,
            status: 'active',
          },
        ),
      ),
    );
    return;
  }
  if (group === 'connection' && command === 'revoke') {
    const id = connectionId(options);
    const data = await revokeConnection(id);
    console.log(
      JSON.stringify(envelope(data, { connectionId: data.connectionId, status: 'revoked' })),
    );
    return;
  }
  if (group === 'capabilities' && command === 'sync') {
    const id = connectionId(options);
    const profile = loadProfile(id);
    const catalog = await syncCapabilities(id);
    console.log(
      JSON.stringify(
        envelope(
          { data: catalog },
          {
            connectionId: profile.connectionId,
            organizationId: profile.organizationId,
            status: 'synchronized',
          },
        ),
      ),
    );
    return;
  }
  if (group === 'action' && command === 'inspect') {
    const id = connectionId(options);
    const actionId = required(options, 'action');
    const profile = loadProfile(id);
    const params = await readParams(options['params-file']);
    const result = await inspectAction(actionId, params, id, options['purpose-file']);
    console.log(
      JSON.stringify(
        envelope(result, {
          action: actionId,
          connectionId: profile.connectionId,
          organizationId: profile.organizationId,
          risk: result.action.riskBase,
          rollback: result.action.rollback,
          status: 'inspected',
        }),
      ),
    );
    return;
  }
  if (group === 'action' && command === 'prepare') {
    const id = connectionId(options);
    const actionId = required(options, 'action');
    const profile = loadProfile(id);
    const params = await readParams(required(options, 'params-file'));
    const { action } = await actionDefinition(actionId, id);
    const result = await prepareOperation({
      actionId,
      params,
      inputFile: options['input-file'],
      reasonFile: required(options, 'reason-file'),
      secretFile: options['secret-file'],
      connectionId: id,
    });
    console.log(
      JSON.stringify(
        envelope(
          { ...result, data: { approvalUrl: result.approvalUrl } },
          {
            action: actionId,
            connectionId: profile.connectionId,
            organizationId: profile.organizationId,
            rollback: action.rollback,
          },
        ),
      ),
    );
    return;
  }
  if (group === 'template' && command === 'patch') {
    const id = connectionId(options);
    const profile = loadProfile(id);
    const result = await prepareTemplatePatch({
      templateId: required(options, 'template'),
      patchFile: required(options, 'patch-file'),
      reasonFile: required(options, 'reason-file'),
      connectionId: id,
    });
    console.log(
      JSON.stringify(
        envelope(
          {
            ...result,
            data: {
              approvalUrl: result.approvalUrl,
              templatePatch: result.templatePatch,
            },
          },
          {
            action: 'templates.draft.update',
            connectionId: profile.connectionId,
            organizationId: profile.organizationId,
            rollback: 'restore-prior-revision',
          },
        ),
      ),
    );
    return;
  }
  if (group === 'action' && ['confirm', 'execute'].includes(command)) {
    const id = connectionId(options);
    const operationId = required(options, 'operation');
    const profile = loadProfile(id);
    const result =
      command === 'confirm'
        ? await confirmOperation(operationId, id)
        : await executeOperation(operationId, id);
    console.log(
      JSON.stringify(
        envelope(result, {
          connectionId: profile.connectionId,
          organizationId: profile.organizationId,
        }),
      ),
    );
    return;
  }
  if (group === 'operation' && ['status', 'reconcile', 'cancel'].includes(command)) {
    const id = connectionId(options);
    const operationId = required(options, 'operation');
    const profile = loadProfile(id);
    const data =
      command === 'status'
        ? { operation: await operationStatus(operationId, id) }
        : command === 'reconcile'
          ? await reconcileOperation(operationId, id)
          : { operation: await cancelOperation(operationId, id) };
    console.log(
      JSON.stringify(
        envelope(data, {
          connectionId: profile.connectionId,
          organizationId: profile.organizationId,
        }),
      ),
    );
    return;
  }
  if (group === 'artifact' && command === 'download') {
    const id = connectionId(options);
    const profile = loadProfile(id);
    const operationId = required(options, 'operation');
    const artifact = await downloadArtifact(
      operationId,
      required(options, 'output'),
      profile.connectionId,
    );
    console.log(
      JSON.stringify(
        envelope(
          { artifact },
          {
            connectionId: profile.connectionId,
            organizationId: profile.organizationId,
            status: 'downloaded',
          },
        ),
      ),
    );
    return;
  }
  if (group === 'doctor') {

    let live = 'not-checked';
    const id = activeConnectionId();
    if (id) {
      await authenticatedFetch(id, '/api/v1/agent/capabilities');
      live = 'ok';
    }
    console.log(
      JSON.stringify(
        envelope(
          {
            data: {
              node: process.version,
              platform: process.platform,
              credentialStore: credentialStoreKind(),
              credentialStoreAvailable: credentialStoreAvailable(),
              activeConnectionId: id,
              live,
            },
          },
          { connectionId: id, status: 'healthy' },
        ),
      ),
    );
    return;
  }

  const error = new Error(`Unsupported TokEMS Admin command: ${positionals.join(' ')}`);
  error.code = 'CLI_COMMAND_UNSUPPORTED';
  throw error;
}

main().catch((error) => {
  console.log(JSON.stringify(safeError(error)));
  process.exitCode = 1;
});
