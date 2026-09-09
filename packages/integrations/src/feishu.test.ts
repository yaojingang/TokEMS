import { describe, expect, it, vi } from 'vitest';
import type { FeishuDigestSnapshot } from '@conference/contracts';
import {
  FEISHU_API_ORIGIN,
  FeishuApiError,
  FeishuBotClient,
  buildFeishuDigestCard,
  buildFeishuDigestLinks,
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

  it('gets the bot token and explains unavailable groups without assuming missing fields', async () => {
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
                {
                  chat_id: 'oc_active',
                  name: '大会运营群',
                  chat_status: 'normal',
                  external: false,
                },
                { chat_id: 'oc_closed', name: '已解散群', chat_status: 'dissolved' },
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
        status: 'normal',
        selectable: true,
        unavailableReason: '',
      },
      {
        chatId: 'oc_closed',
        name: '已解散群',
        description: '',
        ownerId: '',
        external: null,
        status: 'dissolved',
        selectable: false,
        unavailableReason: '该群已解散',
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

    await expect(
      client.sendInteractiveMessage('oc_active', {}, 'delivery-test-id'),
    ).rejects.toMatchObject({
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

    await expect(
      client.sendInteractiveMessage('oc_active', {}, 'delivery-test-id'),
    ).rejects.toMatchObject({
      outcomeUnknown: true,
      retryable: false,
      httpStatus: 500,
    } satisfies Partial<FeishuApiError>);
  });

  it('routes every digest action through the deployed admin base path', () => {
    const links = buildFeishuDigestLinks('https://admin.example.com', 101, snapshot);
    expect(links.dashboard).toBe('https://admin.example.com/admin/events/101/overview');
    expect(links.registrations).toBe(
      'https://admin.example.com/admin/events/101/registrations?status=pending_review',
    );
    expect(links.refunds).toBe(
      'https://admin.example.com/admin/events/101/registrations?panel=refunds&refundStatus=pending_review',
    );
    expect(links.invoices).toBe(
      'https://admin.example.com/admin/events/101/invoices?worklist=actionable',
    );
    const card = buildFeishuDigestCard(snapshot, links);
    expect(JSON.stringify(card)).not.toContain('https://admin.example.com/events/');
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
    expect(serialized).toContain('当前待办');
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

describe('Feishu provider failure boundaries', () => {
  const token = () =>
    new Response(JSON.stringify({ code: 0, tenant_access_token: 't-fixture', expire: 7200 }));
  const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
  it('rejects partial pagination instead of returning a partial group list', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(response({ items: [], has_more: true, page_token: 'next' }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    await expect(
      new FeishuBotClient(
        { appId: 'cli_fixture', appSecret: 'fixture-secret' },
        fetcher,
      ).listChats(),
    ).rejects.toBeInstanceOf(FeishuApiError);
  });
  it('rejects missing and repeated page cursors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValue(response({ items: [], has_more: true }));
    await expect(
      new FeishuBotClient(
        { appId: 'cli_fixture', appSecret: 'fixture-secret' },
        fetcher,
      ).listChats(),
    ).rejects.toMatchObject({ code: 'FEISHU_CHAT_LIST_INCOMPLETE' });
  });
  it('passes the stable UUID and never exposes raw provider messages', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 230020, msg: 'secret-provider-response' }), {
          headers: { 'Retry-After': '60' },
        }),
      );
    const client = new FeishuBotClient(
      { appId: 'cli_fixture', appSecret: 'fixture-secret' },
      fetcher,
    );
    await expect(
      client.sendInteractiveMessage('oc_fixture', {}, 'stable-id'),
    ).rejects.toMatchObject({ retryable: true, retryAfterMs: 60000 });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      uuid: 'stable-id',
      msg_type: 'interactive',
    });
  });
  it.each([
    {},
    null,
    { code: null },
    { code: '0' },
    { code: 0 },
    { code: 0, data: {} },
    { code: 0, data: { message_id: {} } },
    { code: 0, data: { message_id: ' ' } },
  ])('classifies incomplete success responses as unknown: %j', async (body) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response(JSON.stringify(body)));
    await expect(
      new FeishuBotClient(
        { appId: 'cli_fixture', appSecret: 'fixture-secret' },
        fetcher,
      ).sendInteractiveMessage('oc_fixture', {}, 'stable-id'),
    ).rejects.toMatchObject({ outcomeUnknown: true, retryable: false });
  });
  it('enforces the encoded complete-request size before sending', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new FeishuBotClient(
        { appId: 'cli_fixture', appSecret: 'fixture-secret' },
        fetcher,
      ).sendInteractiveMessage('oc_fixture', { text: '中'.repeat(9000) }, 'stable-id'),
    ).rejects.toMatchObject({ code: 'FEISHU_CARD_TOO_LARGE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
