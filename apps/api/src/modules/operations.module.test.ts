import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { OrganizationEventsController } from './operations.module.js';

const PATH_METADATA = 'path';
const REQUIRED_GRANTS_METADATA = 'conference.required_grants';
const REQUIRED_ALL_GRANTS_METADATA = 'conference.required_all_grants';

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

  it('requires both settings and dashboard access before exposing or sending digest data', () => {
    const protectedHandlers = [
      ['updateFeishuDigestSubscription', 'org.settings.manage'],
      ['feishuDigestPreview', 'org.settings.read'],
      ['sendFeishuDigestTest', 'org.settings.manage'],
      ['resendFeishuDigestDelivery', 'org.settings.manage'],
    ] as const;

    for (const [handlerName, settingsGrant] of protectedHandlers) {
      const handler = OrganizationEventsController.prototype[handlerName];
      expect(Reflect.getMetadata(REQUIRED_GRANTS_METADATA, handler)).toBeUndefined();
      expect(Reflect.getMetadata(REQUIRED_ALL_GRANTS_METADATA, handler)).toEqual([
        settingsGrant,
        'event.dashboard.read',
      ]);
    }
  });

  it('keeps chat reads side-effect free and exposes reconciliation as an explicit command', () => {
    const prototype = OrganizationEventsController.prototype;

    expect(Reflect.getMetadata(PATH_METADATA, prototype.feishuBotChats)).toBe(
      'integrations/feishu-bot/chats',
    );
    expect(Reflect.getMetadata(PATH_METADATA, prototype.refreshFeishuBotChats)).toBe(
      'integrations/feishu-bot/chats/refresh',
    );
  });
});
