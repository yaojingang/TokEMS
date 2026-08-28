#!/usr/bin/env node
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
import { cleanupExpiredPending } from './lib/files.mjs';
import { credentialStoreAvailable, credentialStoreKind } from './lib/credentials.mjs';
import {
  cancelOperation,
  confirmOperation,
  downloadArtifact,
  executeOperation,
  operationStatus,
  prepareOperation,
  reconcileOperation,
} from './lib/operations.mjs';
import { redact, safeError } from './lib/redaction.mjs';
import { prepareTemplatePatch } from './lib/template-patch.mjs';

const HELP = `TokEMS Admin Skill connector 0.2.0

Usage:
  tokems-admin.js instance inspect --origin <https-origin>
  tokems-admin.js auth connect --origin <https-origin> --name <display-name> [--scope "tokems:*"]
  tokems-admin.js connection list|use|status|revoke [--connection <id>]
  tokems-admin.js capabilities sync [--connection <id>]
  tokems-admin.js action inspect --action <id> --params-file <path> [--purpose-file <path>] [--connection <id>]
  tokems-admin.js action prepare --action <id> --params-file <path> --input-file <path> --reason-file <path> [--secret-file <path>]
  tokems-admin.js template patch --template <id> --patch-file <path> --reason-file <path> [--connection <id>]
  tokems-admin.js action confirm|execute --operation <id> [--connection <id>]
  tokems-admin.js artifact download --operation <id> --output <absolute-path> [--connection <id>]
  tokems-admin.js operation status|reconcile|cancel --operation <id> [--connection <id>]
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
    if (name === 'help') {
      options.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Option requires a value: --${name}`);
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
    verification: data?.verification ?? { status: 'unverified' },
    artifact: data?.artifact,
    warnings: context.warnings ?? [],
    rollback: context.rollback,
    traceId: operation?.traceId,
  });
}

async function main() {
  const { positionals, options } = parseArguments(process.argv.slice(2));
  if (options.help || !positionals.length) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const [group, command] = positionals;

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
    const cleanup = await cleanupExpiredPending();
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
              expiredPendingDeleted: cleanup.deleted,
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
