import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  AdminAttendeeNeedExportQuerySchema,
  AdminAttendeeNeedListQuerySchema,
  CreateSpeakerSchema,
  DEFAULT_CONFERENCE_TEMPLATE_DEFINITION,
  ModerateAttendeeNeedQuestionSchema,
  TemplateFlowStepSchema,
  TemplateHomeBlockSchema,
  TemplatePartnershipOrganizationGroupKeySchema,
  TemplatePartnershipOrganizationGroupSchema,
  TOKEMS_AGENT_API_VERSION,
  TOKEMS_AGENT_CATALOG_VERSION,
  TOKEMS_AGENT_MIN_CLIENT_VERSION,
  TOKEMS_AGENT_SKILL_VERSION,
  UpdateAdminAttendeeNeedQuestionSchema,
  UpdateSpeakerSchema,
} from '../packages/contracts/src/index.js';
import { TEMPLATE_PATCH_CONTRACT } from '../skills/tokems-admin/scripts/lib/template-patch.mjs';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'skills/tokems-admin/references/system-contracts.json');
const requireFromApi = createRequire(resolve(root, 'apps/api/package.json'));
requireFromApi('reflect-metadata');
const { AppModule } = await import('../apps/api/src/app.module.js');
const { AGENT_ACTIONS, AGENT_EXCLUDED_METADATA, AGENT_SURFACE_METADATA, findAgentActionTemplate } =
  await import('../apps/api/src/common/agent-operation-catalog.js');

function schemaFields(schema: unknown) {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (!shape) throw new Error('Contract snapshot expected an object schema with a shape');
  return Object.keys(shape).sort();
}

function paths(value: string | string[] | undefined) {
  return Array.isArray(value) ? value : [value ?? ''];
}

function joinedRoute(controllerPath: string, handlerPath: string) {
  return `/api/v1/${controllerPath}/${handlerPath}`.replace(/\/{2,}/gu, '/').replace(/\/$/u, '');
}

const methodNames: Partial<Record<number, string>> = {
  0: 'GET',
  1: 'POST',
  2: 'PUT',
  3: 'DELETE',
  4: 'PATCH',
};
const REQUIRED_GRANTS_METADATA = 'conference.required_grants';
const REQUIRED_ALL_GRANTS_METADATA = 'conference.required_all_grants';

function applicationModules() {
  const found = new Set<object>();
  const visit = (candidate: unknown) => {
    const moduleType =
      candidate && typeof candidate === 'object' && 'module' in candidate
        ? (candidate as { module?: unknown }).module
        : candidate;
    if (typeof moduleType !== 'function' || found.has(moduleType)) return;
    found.add(moduleType);
    const imports = (Reflect.getMetadata('imports', moduleType) as unknown[]) ?? [];
    imports.forEach(visit);
  };
  visit(AppModule);
  return [...found] as Array<{
    name: string;
    prototype?: Record<string, object>;
  }>;
}

function adminSurface() {
  const handlers: Array<Record<string, unknown>> = [];
  for (const moduleType of applicationModules()) {
    const controllers =
      (Reflect.getMetadata('controllers', moduleType) as Array<{
        name: string;
        prototype: Record<string, object>;
      }>) ?? [];
    for (const controller of controllers) {
      const surfaceOptions = Reflect.getMetadata(AGENT_SURFACE_METADATA, controller) as
        { defaultExclusionReason?: string } | undefined;
      if (!surfaceOptions) continue;
      const controllerPaths = paths(
        Reflect.getMetadata('path', controller) as string | string[] | undefined,
      );
      for (const handlerName of Object.getOwnPropertyNames(controller.prototype)) {
        if (handlerName === 'constructor') continue;
        const handler = controller.prototype[handlerName];
        if (!handler) continue;
        const method = methodNames[Reflect.getMetadata('method', handler) as number];
        if (!method) continue;
        const handlerPaths = paths(
          Reflect.getMetadata('path', handler) as string | string[] | undefined,
        );
        for (const controllerPath of controllerPaths) {
          for (const handlerPath of handlerPaths) {
            const route = joinedRoute(controllerPath, handlerPath);
            const released = findAgentActionTemplate(method, route);
            handlers.push({
              method,
              path: route,
              handler: `${controller.name}.${handlerName}`,
              actionId: released?.actionId ?? null,
              exclusion: released?.actionId
                ? null
                : ((Reflect.getMetadata(AGENT_EXCLUDED_METADATA, handler) as string | undefined) ??
                  surfaceOptions.defaultExclusionReason ??
                  null),
              requiredAnyGrants:
                ((Reflect.getMetadata(REQUIRED_GRANTS_METADATA, handler) ??
                  Reflect.getMetadata(REQUIRED_GRANTS_METADATA, controller)) as
                  string[] | undefined) ?? [],
              requiredAllGrants:
                ((Reflect.getMetadata(REQUIRED_ALL_GRANTS_METADATA, handler) ??
                  Reflect.getMetadata(REQUIRED_ALL_GRANTS_METADATA, controller)) as
                  string[] | undefined) ?? [],
            });
          }
        }
      }
    }
  }
  return handlers.sort((left, right) =>
    `${left.method} ${left.path} ${left.handler}`.localeCompare(
      `${right.method} ${right.path} ${right.handler}`,
    ),
  );
}

const presentation = DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.presentation;
if (presentation.kind !== 'structured') {
  throw new Error('Default conference template must remain structured for the contract snapshot');
}

const discoveredAdminSurface = adminSurface();
const releasedHandlers = new Map<string, Array<Record<string, unknown>>>();
for (const handler of discoveredAdminSurface) {
  if (typeof handler.actionId !== 'string') continue;
  const matches = releasedHandlers.get(handler.actionId) ?? [];
  matches.push(handler);
  releasedHandlers.set(handler.actionId, matches);
}
for (const action of AGENT_ACTIONS) {
  const handlers = releasedHandlers.get(action.actionId) ?? [];
  if (handlers.length !== 1) {
    throw new Error(
      `Agent action ${action.actionId} must map to exactly one handler; found ${handlers.length}`,
    );
  }
  const handler = handlers[0]!;
  if (handler.method !== action.method || handler.path !== action.path) {
    throw new Error(`Agent action ${action.actionId} does not match its runtime handler route`);
  }
  const requiredAny = handler.requiredAnyGrants as string[];
  const requiredAll = handler.requiredAllGrants as string[];
  if (requiredAll.length) {
    if (
      JSON.stringify([...requiredAll].sort()) !== JSON.stringify([...action.requiredGrants].sort())
    ) {
      throw new Error(`Agent action ${action.actionId} grant contract differs from its handler`);
    }
  } else if (
    requiredAny.length &&
    (action.requiredGrants.length !== 1 || !requiredAny.includes(action.requiredGrants[0]!))
  ) {
    throw new Error(`Agent action ${action.actionId} grant contract differs from its handler`);
  }
}

const snapshot = {
  schemaVersion: '1.0.0',
  binding: {
    apiVersion: TOKEMS_AGENT_API_VERSION,
    catalogVersion: TOKEMS_AGENT_CATALOG_VERSION,
    skillVersion: TOKEMS_AGENT_SKILL_VERSION,
    minClientVersion: TOKEMS_AGENT_MIN_CLIENT_VERSION,
  },
  actionCount: AGENT_ACTIONS.length,
  actions: AGENT_ACTIONS.map((action) => ({
    actionId: action.actionId,
    method: action.method,
    path: action.path,
    requiredGrants: action.requiredGrants,
    agentScopes: action.agentScopes,
    dataClass: action.dataClass,
    riskBase: action.riskBase,
    confirmation: action.confirmation,
    idempotencyStrategy: action.idempotencyStrategy ?? null,
    verifyActionId: action.verifyActionId ?? null,
    rollback: action.rollback,
    minClientVersion: action.minClientVersion,
  })),
  adminSurface: discoveredAdminSurface,
  templates: {
    homeBlockTypes: TemplateHomeBlockSchema.shape.type.options,
    flowStepTypes: TemplateFlowStepSchema.shape.type.options,
    stableNodeKeys: {
      home: presentation.home.blocks.map((block) => block.nodeKey),
      faq: DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.faq.items.map((item) => item.nodeKey),
      registrationFlow: DEFAULT_CONFERENCE_TEMPLATE_DEFINITION.registrationFlow.steps.map(
        (step) => step.nodeKey,
      ),
    },
    organizationGroupFields: schemaFields(TemplatePartnershipOrganizationGroupSchema),
    organizationGroupKeys: TemplatePartnershipOrganizationGroupKeySchema.options,
    patchInput: TEMPLATE_PATCH_CONTRACT,
  },
  inputs: {
    speakers: {
      create: schemaFields(CreateSpeakerSchema),
      update: schemaFields(UpdateSpeakerSchema),
    },
    attendeeNeeds: {
      list: schemaFields(AdminAttendeeNeedListQuerySchema),
      update: schemaFields(UpdateAdminAttendeeNeedQuestionSchema),
      moderate: schemaFields(ModerateAttendeeNeedQuestionSchema),
      export: schemaFields(AdminAttendeeNeedExportQuerySchema),
    },
  },
};

const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = await readFile(target, 'utf8');
  } catch {
    // The comparison below reports a missing snapshot.
  }
  if (current !== serialized) {
    console.error(
      'TokEMS Admin system contract snapshot is stale. Run pnpm skill:tokems-contracts.',
    );
    process.exit(1);
  }
  console.info('TokEMS Admin system contract snapshot is current');
} else {
  await writeFile(target, serialized, { encoding: 'utf8', mode: 0o644 });
  console.info('skills/tokems-admin/references/system-contracts.json');
}
