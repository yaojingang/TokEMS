import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { OrganizationEventsController } from './operations.module.js';

const PATH_METADATA = 'path';
const REQUIRED_GRANTS_METADATA = 'conference.required_grants';

describe('operations compatibility routes', () => {
  it('keeps the v1 aggregate integration status endpoint available', () => {
    const prototype = OrganizationEventsController.prototype;
    const handlerName = Object.getOwnPropertyNames(prototype).find((name) => {
      const handler = prototype[name as keyof typeof prototype];
      return (
        typeof handler === 'function' &&
        Reflect.getMetadata(PATH_METADATA, handler) === 'integrations/status'
      );
    });

    expect(handlerName).toBe('integrationStatus');
  });

  it('protects website analytics updates with their dedicated grant', () => {
    const handler = OrganizationEventsController.prototype.updateOrganizationAnalytics;

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('organization/analytics');
    expect(Reflect.getMetadata(REQUIRED_GRANTS_METADATA, handler)).toEqual([
      'org.analytics.manage',
    ]);
  });
});
