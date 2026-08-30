import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_IDS } from '@conference/contracts';
import { templateAssets } from '@conference/database';
import { inArray } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { TemplateOperationsService } from './template-operations.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('template asset purpose isolation', () => {
  const database = new DatabaseService();
  const service = new TemplateOperationsService(database);
  const publicAssetId = randomUUID();
  const privateAssetId = randomUUID();
  const sharedDigest = randomUUID().replaceAll('-', '');

  beforeAll(async () => {
    await database.db!.insert(templateAssets).values([
      {
        id: publicAssetId,
        organizationId: DEMO_IDS.organization,
        storageKey: `templates/${DEMO_IDS.organization}/purpose-${publicAssetId}.png`,
        mediaType: 'image/png',
        size: 67,
        contentDigest: sharedDigest,
        altText: '公开模板图片',
        purpose: 'template',
        createdBy: DEMO_IDS.adminUser,
      },
      {
        id: privateAssetId,
        organizationId: DEMO_IDS.organization,
        storageKey: `attendee-services/${DEMO_IDS.organization}/purpose-${privateAssetId}.png`,
        mediaType: 'image/png',
        size: 67,
        contentDigest: sharedDigest,
        altText: '大会组织者微信二维码',
        purpose: 'attendee_service_qr',
        createdBy: DEMO_IDS.adminUser,
      },
    ]);
  });

  afterAll(async () => {
    await database
      .db!.delete(templateAssets)
      .where(inArray(templateAssets.id, [publicAssetId, privateAssetId]));
  });

  it('keeps equal-content public and private assets as separate rows', async () => {
    const assets = await service.listAssets(DEMO_IDS.organization);
    expect(assets.some((asset) => asset.id === publicAssetId)).toBe(true);
    expect(assets.some((asset) => asset.id === privateAssetId)).toBe(false);
  });

  it('returns not found for private assets on the generic public route', async () => {
    await expect(service.publicAssetUrl(privateAssetId)).rejects.toMatchObject({ status: 404 });
  });
});
