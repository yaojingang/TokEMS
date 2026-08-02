import { describe, expect, it } from 'vitest';
import { EventReleaseSchema } from './index.js';

describe('EventReleaseSchema', () => {
  it('exposes the change context needed to understand automatic releases', () => {
    const parsed = EventReleaseSchema.parse({
      id: '3d102da6-3c8b-4bf8-8a72-e14f4fef74b7',
      eventId: 101,
      version: 7,
      templateKey: 'editorial-blue',
      templateVersionId: null,
      status: 'published',
      artifactKey: 'releases/101/v7/site.json',
      changeSummary: '更新大会基本信息',
      changeScope: 'event',
      activationKind: 'save',
      createdByName: '大会管理员',
      publishedAt: '2026-08-02T08:00:00.000Z',
      rolledBackAt: null,
      active: true,
    });

    expect(parsed).toMatchObject({
      changeSummary: '更新大会基本信息',
      changeScope: 'event',
      activationKind: 'save',
      createdByName: '大会管理员',
    });
  });
});
