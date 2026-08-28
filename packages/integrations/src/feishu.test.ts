import { describe, expect, it, vi } from 'vitest';
import type { FeishuDigestSnapshot } from '@conference/contracts';
import {
  FEISHU_API_ORIGIN,
  FeishuApiError,
  FeishuBotClient,
  buildFeishuDigestCard,
} from './feishu.js';

const snapshot: FeishuDigestSnapshot = {
  metricVersion: 1,
  event: {
    id: 101,
    slug: 'tokems26',
    name: '第二届中国 GEO & AI 营销大会',
    status: 'registration_open',
    timezone: 'Asia/Shanghai',
  },
  reportDate: '2026-08-19',
  windowStart: '2026-08-18T16:00:00.000Z',
  windowEnd: '2026-08-19T16:00:00.000Z',
  generatedAt: '2026-08-20T01:00:00.000Z',
  currency: 'CNY',
  pageViewsAvailable: true,
  daily: {
    pageViews: 1286,
    newRegistrations: 43,
    paidOrders: 31,
    grossReceipts: 1_236_900,
    successfulRefunds: 2,
    refundAmount: 79_800,
    netCash: 1_157_100,
    invoiceRequests: 8,
    checkins: 0,
  },
  cumulative: {
    pageViews: 12_000,
    validRegistrations: 402,
    paidOrders: 380,
    paidSeats: 380,
    confirmedAttendees: 368,
    netRevenue: 14_268_000,
    remainingInventory: 132,
    checkins: 0,
  },
  todos: {
    pendingRegistrationReview: 4,
    invoiceActionable: 5,
    paymentExceptions: 1,
    cooperationRequests: 2,
    lowStockTicketTypes: 0,
  },
  monitoring: {
    invoiceAwaitingDetails: 1,
    invoiceIssuing: 2,
    pendingPayments: 3,
  },
};

describe('Feishu bot integration', () => {
  it('reads robot identity from the top-level bot envelope used by bot/v3/info', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, tenant_access_token: 't-test', expire: 7200 })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            bot: { activate_status: 2, app_name: 'TokEMS 运营机器人', open_id: 'ou_bot' },
          }),
        ),
      );
    const client = new FeishuBotClient({ appId: 'cli_tokems', appSecret: 'secret-value' }, fetcher);

    await expect(client.getBotInfo()).resolves.toEqual({
      appName: 'TokEMS 运营机器人',
      openId: 'ou_bot',
    });
  });

  it('gets the bot token and lists only active chats the bot belongs to', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, tenant_access_token: 't-test', expire: 7200 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                { chat_id: 'oc_active', name: '大会运营群', chat_status: 'normal' },
                { chat_id: 'oc_closed', name: '已解散群', chat_status: 'disbanded' },
              ],
              has_more: false,
            },
          }),
          { status: 200 },
        ),
      );
    const client = new FeishuBotClient({ appId: 'cli_tokems', appSecret: 'secret-value' }, fetcher);

    await expect(client.listChats()).resolves.toEqual([
      {
        chatId: 'oc_active',
        name: '大会运营群',
        description: '',
        ownerId: '',
        external: false,
      },
    ]);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `${FEISHU_API_ORIGIN}/open-apis/im/v1/chats?page_size=100`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer t-test' }),
      }),
    );
  });

  it('shares one in-flight token request across concurrent API calls', async () => {
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    let tokenRequests = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/tenant_access_token/internal')) {
        tokenRequests += 1;
        await tokenGate;
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: 't-shared', expire: 7200 }),
        );
      }
      return new Response(JSON.stringify({ code: 0, data: { items: [], has_more: false } }));
    });
    const client = new FeishuBotClient({ appId: 'cli_tokems', appSecret: 'secret-value' }, fetcher);

    const first = client.listChats();
    const second = client.listChats();
    await vi.waitFor(() => expect(tokenRequests).toBe(1));
    releaseToken();

    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(tokenRequests).toBe(1);
  });

  it('marks an interrupted message send as outcome unknown', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, tenant_access_token: 't-test', expire: 7200 })),
      )
      .mockRejectedValueOnce(new Error('socket reset'));
    const client = new FeishuBotClient({ appId: 'cli_tokems', appSecret: 'secret-value' }, fetcher);

    await expect(client.sendInteractiveMessage('oc_active', {})).rejects.toMatchObject({
      code: 'FEISHU_SEND_OUTCOME_UNKNOWN',
      outcomeUnknown: true,
      retryable: false,
    } satisfies Partial<FeishuApiError>);
  });

  it('does not automatically retry an ambiguous provider 5xx after a send', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, tenant_access_token: 't-test', expire: 7200 })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 230099, msg: 'internal error' }), { status: 500 }),
      );
    const client = new FeishuBotClient({ appId: 'cli_tokems', appSecret: 'secret-value' }, fetcher);

    await expect(client.sendInteractiveMessage('oc_active', {})).rejects.toMatchObject({
      outcomeUnknown: true,
      retryable: false,
      httpStatus: 500,
    } satisfies Partial<FeishuApiError>);
  });

  it('builds a static card with aggregate data and safe deep links', () => {
    const card = buildFeishuDigestCard(
      snapshot,
      {
        dashboard: 'https://admin.example.com/events/101/overview',
        todos: 'https://admin.example.com/events/101/registrations?reviewStatus=pending_review',
      },
      { test: true },
    );
    const serialized = JSON.stringify(card);
    expect(serialized).toContain('【测试】第二届中国 GEO & AI 营销大会');
    expect(serialized).toContain('待处理 12');
    expect(serialized).toContain('https://admin.example.com/events/101/overview');
    expect(serialized).toContain('"behaviors":[{"type":"open_url"');
    expect(serialized).not.toContain('"url":');
    expect(serialized).not.toContain('13800138000');
  });

  it('adds check-in emphasis while the event is in progress', () => {
    const card = buildFeishuDigestCard(
      {
        ...snapshot,
        event: { ...snapshot.event, status: 'in_progress' },
        daily: { ...snapshot.daily, checkins: 96 },
        cumulative: { ...snapshot.cumulative, checkins: 188 },
      },
      {
        dashboard: 'https://admin.example.com/events/101/overview',
        todos: 'https://admin.example.com',
      },
    );

    expect(JSON.stringify(card)).toContain('签到 **96**');
    expect(JSON.stringify(card)).toContain('累计签到 **188**');
  });
});
