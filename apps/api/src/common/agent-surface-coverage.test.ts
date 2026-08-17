import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import {
  AGENT_ACTION_MAP,
  AGENT_ACTION_METADATA,
  AGENT_EXCLUDED_METADATA,
  AGENT_SURFACE_METADATA,
} from './agent-operation-catalog.js';

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
  return [...found];
}

describe('Agent administration surface coverage', () => {
  it('keeps the number of unclassified handlers at zero', () => {
    const modules = applicationModules();
    const unclassified: string[] = [];
    const invalidActions: string[] = [];
    const missingSurfaces: string[] = [];
    const actionHandlers = new Map<string, string[]>();
    let classified = 0;
    for (const moduleType of modules) {
      const controllers =
        (Reflect.getMetadata('controllers', moduleType) as Array<{
          name: string;
          prototype: Record<string, object>;
        }>) ?? [];
      for (const controller of controllers) {
        const controllerPath = Reflect.getMetadata('path', controller) as
          string | string[] | undefined;
        const controllerPaths = Array.isArray(controllerPath) ? controllerPath : [controllerPath];
        const managementController = controllerPaths.some(
          (path) => path === 'admin' || path?.startsWith('admin/'),
        );
        if (managementController && !Reflect.getMetadata(AGENT_SURFACE_METADATA, controller)) {
          missingSurfaces.push(controller.name);
        }
        if (!Reflect.getMetadata(AGENT_SURFACE_METADATA, controller)) continue;
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          if (name === 'constructor') continue;
          const handler = controller.prototype[name];
          if (!handler || Reflect.getMetadata('method', handler) === undefined) continue;
          const actionId = Reflect.getMetadata(AGENT_ACTION_METADATA, handler) as
            string | undefined;
          const excluded = Reflect.getMetadata(AGENT_EXCLUDED_METADATA, handler) as
            string | undefined;
          if (!actionId && !excluded) unclassified.push(`${controller.name}.${name}`);
          if (actionId && !AGENT_ACTION_MAP.has(actionId)) {
            invalidActions.push(`${controller.name}.${name}:${actionId}`);
          }
          if (actionId) {
            const handlers = actionHandlers.get(actionId) ?? [];
            handlers.push(`${controller.name}.${name}`);
            actionHandlers.set(actionId, handlers);
          }
          if (actionId || excluded) classified += 1;
        }
      }
    }
    expect(classified).toBeGreaterThan(0);
    expect(invalidActions).toEqual([]);
    expect(missingSurfaces).toEqual([]);
    expect(unclassified).toEqual([]);
    expect(
      [...AGENT_ACTION_MAP.keys()].filter((actionId) => !actionHandlers.has(actionId)),
    ).toEqual([]);
    expect([...actionHandlers.entries()].filter(([, handlers]) => handlers.length !== 1)).toEqual(
      [],
    );
  });
});
