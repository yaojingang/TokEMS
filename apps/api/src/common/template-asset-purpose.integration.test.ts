import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_IDS } from '@conference/contracts';
import { conferenceTemplates, templateAssets } from '@conference/database';
import { eq, inArray } from 'drizzle-orm';
import { DatabaseService } from './database.service.js';
import { TemplateOperationsService } from './template-operations.service.js';

const describePersistent = process.env.DATABASE_URL ? describe : describe.skip;

describePersistent('template asset purpose isolation', () => {
  const database = new DatabaseService();
  const service = new TemplateOperationsService(database);
  const publicAssetId = randomUUID();
  const privateAssetId = randomUUID();
  const sharedDigest = randomUUID().replaceAll('-', '');
  let templateId: string | undefined;

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
    if (templateId)
      await database.db!.delete(conferenceTemplates).where(eq(conferenceTemplates.id, templateId));
    await database
      .db!.delete(templateAssets)
      .where(inArray(templateAssets.id, [publicAssetId, privateAssetId]));
    await database.onModuleDestroy();
  });

  it('keeps equal-content public and private assets as separate rows', async () => {
    const assets = await service.listAssets(DEMO_IDS.organization);
    expect(assets.some((asset) => asset.id === publicAssetId)).toBe(true);
    expect(assets.some((asset) => asset.id === privateAssetId)).toBe(false);
  });

  it('returns not found for private assets on the generic public route', async () => {
    await expect(service.publicAssetUrl(privateAssetId)).rejects.toMatchObject({ status: 404 });
  });

  it('accepts public logo assets, rejects private and missing assets, and protects referenced logos from deletion', async () => {
    const detail = await service.create(DEMO_IDS.organization, DEMO_IDS.adminUser, {
      name: `Logo 维护验证 ${randomUUID()}`,
      description: '临时验证 Logo 素材引用',
      tags: [],
      publishImmediately: false,
    });
    templateId = detail.summary.id;
    const definition = structuredClone(detail.draft.definition);
    if (definition.presentation.kind !== 'structured')
      throw new Error('Expected structured template');
    const block = definition.presentation.home.blocks.find(
      (item) => item.nodeKey === 'home.cooperation',
    )!;
    const item = {
      id: randomUUID(),
      name: 'Logo 验证',
      assetId: publicAssetId,
      group: 'speaker',
      enabled: true,
      background: 'light',
      scale: 1,
    };
    block.content.logoWall = { enabled: true, items: [item] };
    const saved = await service.saveDraft(DEMO_IDS.organization, templateId, DEMO_IDS.adminUser, {
      revision: 0,
      definition,
    });
    expect(saved.revision).toBe(1);
    for (const assetId of [privateAssetId, randomUUID()]) {
      block.content.logoWall = { enabled: true, items: [{ ...item, assetId }] };
      await expect(
        service.saveDraft(DEMO_IDS.organization, templateId, DEMO_IDS.adminUser, {
          revision: 1,
          definition,
        }),
      ).rejects.toMatchObject({ status: 422 });
    }
    await expect(
      service.deleteAsset(DEMO_IDS.organization, publicAssetId, DEMO_IDS.adminUser),
    ).rejects.toMatchObject({ status: 409 });
  });
});
