import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { OrganizationEventsController } from './operations.module.js';

const PATH_METADATA = 'path';

describe('operations compatibility routes', () => {
  it('keeps the v1 aggregate integration status endpoint available', () => {
    const prototype = OrganizationEventsController.prototype;
    const handlerName = Object.getOwnPropertyNames(prototype).find((name) => {
      const handler = prototype[name as keyof typeof prototype];
      return typeof handler === 'function' && Reflect.getMetadata(PATH_METADATA, handler) === 'integrations/status';
    });

    expect(handlerName).toBe('integrationStatus');
  });
});
