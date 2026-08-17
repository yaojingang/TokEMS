import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_EVENT, DEMO_IDS, type CreateCooperationRequest } from '@conference/contracts';
import { CooperationRequestService } from './cooperation-request.service.js';
import type { DatabaseService } from './database.service.js';

const input: CreateCooperationRequest = {
  eventId: DEMO_IDS.event,
  cooperationTypes: ['brand_sponsorship', 'media'],
  companyName: '深圳南山品牌增长研究院',
  contactName: '陈思远',
  contactTitle: '品牌合作负责人',
  mobile: '13800138000',
  email: '',
  wechatId: 'geo-chen',
  message: '希望围绕年度白皮书发布和现场品牌展示开展联合合作。',
  consentAccepted: true as const,
};

describe('cooperation request service', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a public request and exposes it to the scoped admin workflow', async () => {
    const service = new CooperationRequestService({ db: undefined } as unknown as DatabaseService);

    const created = await service.create('geo-conference', input);
    expect(created).toMatchObject({ eventName: DEMO_EVENT.name });
    expect(created.requestNo).toMatch(/^COOP-\d{8}-[A-Z2-9]{6}$/);

    const list = await service.list(DEMO_IDS.organization, DEMO_IDS.event, {
      page: 1,
      pageSize: 20,
    });
    expect(list.total).toBe(1);
    expect(list.counts.new).toBe(1);
    expect(list.items[0]).toMatchObject({
      requestNo: created.requestNo,
      companyName: input.companyName,
      status: 'new',
    });
  });

  it('updates status with optimistic concurrency and records lifecycle timestamps', async () => {
    const service = new CooperationRequestService({ db: undefined } as unknown as DatabaseService);
    await service.create('geo-conference', input);
    const listed = await service.list(DEMO_IDS.organization, DEMO_IDS.event, {
      page: 1,
      pageSize: 20,
    });
    const before = await service.detail(DEMO_IDS.organization, DEMO_IDS.event, listed.items[0]!.id);

    const updated = await service.update(
      DEMO_IDS.organization,
      DEMO_IDS.event,
      before.id,
      DEMO_IDS.adminUser,
      {
        status: 'contacted',
        internalNote: '已通过微信建立联系。',
        expectedUpdatedAt: before.updatedAt,
      },
    );
    expect(updated.status).toBe('contacted');
    expect(updated.firstContactedAt).toBeTruthy();

    await expect(
      service.update(DEMO_IDS.organization, DEMO_IDS.event, before.id, DEMO_IDS.adminUser, {
        status: 'closed',
        expectedUpdatedAt: before.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('keeps request details isolated by organization and event', async () => {
    const service = new CooperationRequestService({ db: undefined } as unknown as DatabaseService);
    await service.create('geo-conference', input);
    const listed = await service.list(DEMO_IDS.organization, DEMO_IDS.event, {
      page: 1,
      pageSize: 20,
    });
    const requestId = listed.items[0]!.id;

    await expect(
      service.detail('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', DEMO_IDS.event, requestId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.detail(
        DEMO_IDS.organization,
        (DEMO_IDS.event + 1) as typeof DEMO_IDS.event,
        requestId,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('returns the newest requests first and applies search, status, and direction filters', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T08:00:00.000Z'));
    const service = new CooperationRequestService({ db: undefined } as unknown as DatabaseService);
    await service.create('geo-conference', input);
    vi.setSystemTime(new Date('2026-08-17T08:01:00.000Z'));
    const newest = await service.create('geo-conference', {
      ...input,
      cooperationTypes: ['community'],
      companyName: '湾区人工智能产业联盟',
      contactName: '林书宁',
    });

    const list = await service.list(DEMO_IDS.organization, DEMO_IDS.event, {
      q: '产业联盟',
      type: 'community',
      status: 'new',
      page: 1,
      pageSize: 20,
    });

    expect(list.items.map((item) => item.requestNo)).toEqual([newest.requestNo]);
    expect(list.counts).toMatchObject({ all: 2, new: 2 });
  });
});
