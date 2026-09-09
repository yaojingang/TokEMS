import type { FeishuChat, FeishuDigestSnapshot } from '@conference/contracts';

export const FEISHU_API_ORIGIN = 'https://open.feishu.cn';
const MAX_RESPONSE_BYTES = 1024 * 1024;

type FetchLike = typeof fetch;

type FeishuEnvelope<T> = {
  code?: number;
  msg?: string;
  data?: T;
  bot?: unknown;
  tenant_access_token?: string;
  expire?: number;
};

export class FeishuApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  readonly httpStatus: number;
  readonly retryAfterMs: number;

  constructor(
    message: string,
    options: {
      code?: string;
      retryable?: boolean;
      outcomeUnknown?: boolean;
      httpStatus?: number;
      retryAfterMs?: number;
    } = {},
  ) {
    super(message);
    this.name = 'FeishuApiError';
    this.code = options.code ?? 'FEISHU_REQUEST_FAILED';
    this.retryable = options.retryable ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.httpStatus = options.httpStatus ?? 0;
    this.retryAfterMs = options.retryAfterMs ?? 0;
  }
}

export type FeishuBotCredentials = {
  appId: string;
  appSecret: string;
};

export type FeishuBotInfo = {
  appName: string;
  openId: string;
};

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

export function feishuErrorMessage(code: string) {
  if (['10003', '10014', '10015', '10017', '10018', '10019', '10020'].includes(code))
    return '应用信息未通过验证，请检查 App ID 和应用密钥。';
  if (code === '230002') return '机器人已不在目标群，请重新添加机器人或选择接收群。';
  if (['230018', '230035'].includes(code)) return '当前群限制机器人发言，请检查群内发言设置。';
  if (['230006', 'FEISHU_BOT_NOT_ACTIVE'].includes(code))
    return '请在飞书应用中开启机器人能力，并发布新版本。';
  if (['99991672', '99991679', '230027'].includes(code))
    return '当前应用缺少所需权限，请在飞书开通权限并发布生效。';
  if (['230020', 'HTTP_429'].includes(code)) return '飞书暂时限制了发送频率，系统会自动重试。';
  return '飞书请求未完成，请检查应用发布、权限和群设置后重试。';
}

export function serializeFeishuCard(card: Record<string, unknown>) {
  return JSON.stringify(card, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')));
  });
}

export class FeishuBotClient {
  private token?: { value: string; expiresAt: number };
  private tokenRequest: Promise<string> | undefined;

  constructor(
    private readonly credentials: FeishuBotCredentials,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  private async parse<T>(response: Response): Promise<FeishuEnvelope<T>> {
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      throw new FeishuApiError('飞书响应超过安全大小限制', {
        code: 'FEISHU_RESPONSE_TOO_LARGE',
        httpStatus: response.status,
      });
    }
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed as FeishuEnvelope<T>;
    } catch {
      throw new FeishuApiError('飞书返回了无法识别的响应', {
        code: 'FEISHU_INVALID_RESPONSE',
        retryable: response.status >= 500,
        httpStatus: response.status,
      });
    }
  }

  private async requestAccessToken() {
    let response: Response;
    try {
      response = await this.fetcher(
        `${FEISHU_API_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            app_id: this.credentials.appId,
            app_secret: this.credentials.appSecret,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new FeishuApiError('飞书凭据校验暂时无法连接，请稍后重试', {
        code: 'FEISHU_TOKEN_NETWORK_ERROR',
        retryable: true,
      });
    }
    const envelope = await this.parse<never>(response);
    if (!response.ok || envelope.code !== 0 || !envelope.tenant_access_token) {
      throw new FeishuApiError(
        feishuErrorMessage(String(envelope.code ?? `HTTP_${response.status}`)),
        {
          code: String(envelope.code ?? `HTTP_${response.status}`),
          retryable: response.status === 429 || response.status >= 500,
          httpStatus: response.status,
        },
      );
    }
    const expiresIn = Number(envelope.expire);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0)
      throw new FeishuApiError('飞书凭证响应缺少有效期', {
        code: 'FEISHU_INVALID_RESPONSE',
        retryable: true,
      });
    this.token = {
      value: envelope.tenant_access_token,
      expiresAt: Date.now() + expiresIn * 1_000,
    };
    return this.token.value;
  }

  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    if (this.tokenRequest) return this.tokenRequest;
    const request = this.requestAccessToken();
    this.tokenRequest = request;
    try {
      return await request;
    } finally {
      if (this.tokenRequest === request) this.tokenRequest = undefined;
    }
  }

  private async request<T>(
    pathname: string,
    init: RequestInit = {},
    options: { sendingMessage?: boolean; topLevelBot?: boolean } = {},
  ) {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await this.fetcher(`${FEISHU_API_ORIGIN}${pathname}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
          ...init.headers,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new FeishuApiError(
        options.sendingMessage
          ? '暂时无法确认消息是否到达，请先查看目标群。'
          : '飞书暂时无法连接，请稍后重试',
        {
          code: options.sendingMessage ? 'FEISHU_SEND_OUTCOME_UNKNOWN' : 'FEISHU_NETWORK_ERROR',
          retryable: !options.sendingMessage,
          outcomeUnknown: options.sendingMessage === true,
        },
      );
    }
    let envelope: FeishuEnvelope<T>;
    try {
      envelope = await this.parse<T>(response);
    } catch (error) {
      if (options.sendingMessage && error instanceof FeishuApiError) {
        throw new FeishuApiError(error.message, {
          code: error.code,
          outcomeUnknown: true,
          httpStatus: error.httpStatus,
        });
      }
      throw error;
    }
    if (!response.ok || envelope.code !== 0) {
      const outcomeUnknown =
        options.sendingMessage === true &&
        (response.status >= 500 ||
          typeof envelope.code !== 'number' ||
          !Number.isInteger(envelope.code) ||
          envelope.code === 230049);
      const retryAfter = response.headers.get('retry-after');
      const retryAfterMs = retryAfter
        ? /^\d+$/u.test(retryAfter)
          ? Number(retryAfter) * 1_000
          : Math.max(0, Date.parse(retryAfter) - Date.now())
        : 0;
      throw new FeishuApiError(
        feishuErrorMessage(String(envelope.code ?? `HTTP_${response.status}`)),
        {
          code: String(envelope.code ?? `HTTP_${response.status}`),
          retryable:
            response.status === 429 ||
            envelope.code === 230020 ||
            (!options.sendingMessage && response.status >= 500),
          retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
          outcomeUnknown,
          httpStatus: response.status,
        },
      );
    }
    if (options.topLevelBot && envelope.bot) return envelope.bot as T;
    if (!envelope.data) {
      throw new FeishuApiError('飞书响应缺少 data 字段', {
        code: 'FEISHU_INVALID_RESPONSE',
        httpStatus: response.status,
        outcomeUnknown: options.sendingMessage === true,
      });
    }
    return envelope.data;
  }

  async getBotInfo(): Promise<FeishuBotInfo> {
    const bot = await this.request<{
      app_name?: string;
      open_id?: string;
      activate_status?: number;
    }>('/open-apis/bot/v3/info', {}, { topLevelBot: true });
    if (!bot.open_id || (bot.activate_status !== undefined && bot.activate_status !== 2)) {
      throw new FeishuApiError('应用尚未启用机器人能力，或机器人版本尚未发布', {
        code: 'FEISHU_BOT_NOT_ACTIVE',
      });
    }
    return {
      appName: text(bot.app_name),
      openId: bot.open_id,
    };
  }

  async listChats(): Promise<FeishuChat[]> {
    const chats: FeishuChat[] = [];
    let pageToken = '';
    const seenTokens = new Set<string>();
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request<{
        items?: Array<{
          chat_id?: string;
          name?: string;
          description?: string;
          owner_id?: string;
          external?: boolean;
          chat_status?: string;
        }>;
        has_more?: boolean;
        page_token?: string;
      }>(`/open-apis/im/v1/chats?${query.toString()}`);
      if (!Array.isArray(data.items) || typeof data.has_more !== 'boolean')
        throw new FeishuApiError('群列表未读取完整，请重试', {
          code: 'FEISHU_CHAT_LIST_INCOMPLETE',
          retryable: true,
        });
      for (const item of data.items) {
        if (!item || typeof item.chat_id !== 'string' || !/^oc_[A-Za-z0-9]+$/u.test(item.chat_id))
          throw new FeishuApiError('群列表未读取完整，请重试', {
            code: 'FEISHU_CHAT_LIST_INCOMPLETE',
            retryable: true,
          });
        const status =
          item.chat_status === 'normal' ||
          item.chat_status === 'dissolved' ||
          item.chat_status === 'dissolved_save'
            ? item.chat_status
            : 'unknown';
        const external = typeof item.external === 'boolean' ? item.external : null;
        chats.push({
          chatId: item.chat_id,
          name: text(item.name) || '未命名群聊',
          description: text(item.description),
          ownerId: text(item.owner_id),
          external,
          status,
          selectable: external === false && status === 'normal',
          unavailableReason:
            external === true
              ? '首版支持企业内部群'
              : status === 'dissolved' || status === 'dissolved_save'
                ? '该群已解散'
                : external === null || status === 'unknown'
                  ? '群状态暂无法确认，请刷新'
                  : '',
        });
      }
      if (!data.has_more) break;
      if (!data.page_token || seenTokens.has(data.page_token))
        throw new FeishuApiError('群列表未读取完整，请重试', {
          code: 'FEISHU_CHAT_LIST_INCOMPLETE',
          retryable: true,
        });
      seenTokens.add(data.page_token);
      if (page === 19) {
        throw new FeishuApiError('机器人所在群超过 2000 个，请缩小应用使用范围后重试', {
          code: 'FEISHU_CHAT_LIST_LIMIT_EXCEEDED',
        });
      }
      pageToken = data.page_token;
    }
    return [...new Map(chats.map((chat) => [chat.chatId, chat])).values()].sort((left, right) =>
      left.name.localeCompare(right.name, 'zh-CN'),
    );
  }

  async sendInteractiveMessage(chatId: string, card: Record<string, unknown>, uuid: string) {
    const body = JSON.stringify({
      receive_id: chatId,
      msg_type: 'interactive',
      content: serializeFeishuCard(card),
      uuid,
    });
    if (!uuid || uuid.length > 50)
      throw new FeishuApiError('投递标识无效', { code: 'FEISHU_INVALID_UUID' });
    if (new TextEncoder().encode(body).byteLength > 24 * 1024)
      throw new FeishuApiError('日报内容超过发送大小限制，请查看后台数据', {
        code: 'FEISHU_CARD_TOO_LARGE',
      });
    const data = await this.request<{ message_id?: string }>(
      '/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        method: 'POST',
        body,
      },
      { sendingMessage: true },
    );
    if (typeof data.message_id !== 'string' || !/^om_[A-Za-z0-9_-]+$/u.test(data.message_id)) {
      throw new FeishuApiError('飞书已响应，但没有返回消息标识', {
        code: 'FEISHU_MESSAGE_ID_MISSING',
        outcomeUnknown: true,
      });
    }
    return { messageId: data.message_id };
  }
}

function money(value: number | null, currency: string) {
  if (value === null) return '待核对';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value / 100);
}

function valueText(value: number | null) {
  return value === null ? '待核对' : String(value);
}
function markdownText(value: string) {
  return value
    .replaceAll(/[\\`*_{}[\]()<>#!|]/gu, (char) => `\\${char}`)
    .replaceAll(/[\r\n]/gu, ' ');
}

function todoLine(snapshot: FeishuDigestSnapshot) {
  const items: Array<[string, number]> = [
    ['报名待审核', snapshot.todos.pendingRegistrationReview],
    ['发票待处理', snapshot.todos.invoiceActionable],
    ['支付异常', snapshot.todos.paymentExceptions],
    ['合作咨询', snapshot.todos.cooperationRequests],
    ['低库存票种', snapshot.todos.lowStockTicketTypes],
  ];
  if (snapshot.metricVersion === 2)
    items.splice(
      1,
      0,
      ['退款待审核', snapshot.todos.refundPendingReview],
      ['退款等待资金', snapshot.todos.refundWaitingFunds],
      ['退款需关注', snapshot.todos.refundAttention],
    );
  const active = items.filter(([, value]) => value > 0);
  return active.length
    ? active.map(([label, value]) => `${label} **${value}**`).join(' · ')
    : '当前没有需要人工处理的事项';
}

export function buildFeishuDigestLinks(
  adminOrigin: string,
  eventId: number,
  snapshot: FeishuDigestSnapshot,
) {
  const origin = new URL(adminOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password)
    throw new Error('后台链接配置无效');
  const link = (path: string) =>
    new URL(`/admin/events/${eventId}/${path}`, origin.origin).toString();
  const refundStatus =
    snapshot.metricVersion === 2 && snapshot.todos.refundAttention > 0
      ? 'attention'
      : snapshot.metricVersion === 2 &&
          snapshot.todos.refundPendingReview === 0 &&
          snapshot.todos.refundWaitingFunds > 0
        ? 'waiting_funds'
        : 'pending_review';
  const registrations = link('registrations?status=pending_review');
  const invoices = link('invoices?worklist=actionable');
  const refunds = link(`registrations?panel=refunds&refundStatus=${refundStatus}`);
  return {
    dashboard: link('overview'),
    registrations,
    refunds,
    invoices,
    todos:
      snapshot.todos.pendingRegistrationReview > 0
        ? registrations
        : snapshot.todos.invoiceActionable > 0
          ? invoices
          : link('overview'),
  };
}

export function buildFeishuDigestCard(
  snapshot: FeishuDigestSnapshot,
  links: {
    dashboard: string;
    todos: string;
    registrations?: string;
    refunds?: string;
    invoices?: string;
  },
  options: { test?: boolean; label?: string } = {},
): Record<string, unknown> {
  const titlePrefix = options.test ? '【测试】' : options.label ? `【${options.label}】` : '';
  const pv =
    snapshot.pageViewsAvailable && snapshot.daily.pageViews !== null
      ? String(snapshot.daily.pageViews)
      : '暂无完整数据';
  const checkins = ['in_progress', 'ended'].includes(snapshot.event.status)
    ? ` · 签到 **${snapshot.daily.checkins}**`
    : '';
  const invoiceDaily =
    snapshot.metricVersion === 2
      ? `新增退款申请 **${snapshot.daily.refundRequests}** · 新增开票需求 **${snapshot.daily.invoiceDemands}** · 提交开票资料 **${snapshot.daily.invoiceSubmissions}**`
      : `发票申请 **${snapshot.daily.invoiceRequests}**（历史 V1 口径）`;
  const monitoring = [
    snapshot.monitoring.invoiceAwaitingDetails
      ? `发票待补资料 ${snapshot.monitoring.invoiceAwaitingDetails}`
      : '',
    snapshot.monitoring.invoiceIssuing ? `开票中 ${snapshot.monitoring.invoiceIssuing}` : '',
    snapshot.monitoring.pendingPayments ? `待支付 ${snapshot.monitoring.pendingPayments}` : '',
    snapshot.metricVersion === 2 && snapshot.monitoring.refundProcessing
      ? `退款处理中 ${snapshot.monitoring.refundProcessing}`
      : '',
  ].filter(Boolean);
  const buttons =
    links.registrations && links.refunds && links.invoices
      ? [
          ['查看大会', links.dashboard],
          ['审核报名', links.registrations],
          ['处理退款', links.refunds],
          ['处理发票', links.invoices],
        ]
      : [
          ['查看大会', links.dashboard],
          ['处理待办', links.todos],
        ];
  const issues =
    snapshot.metricVersion === 2
      ? [...new Set(snapshot.qualityIssues.map((issue) => issue.description))]
      : [];
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      template:
        Object.values(snapshot.todos).some((value) => value > 0) || issues.length
          ? 'orange'
          : 'blue',
      title: { tag: 'plain_text', content: `${titlePrefix}${snapshot.event.name}｜运营日报` },
      subtitle: {
        tag: 'plain_text',
        content: `${snapshot.reportDate} · ${snapshot.event.timezone}`,
      },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: [
        {
          tag: 'markdown',
          content: `**昨日新增**\n访问 **${pv}** 次 · 新增报名记录 **${snapshot.daily.newRegistrations}** 条 · 支付订单 **${snapshot.daily.paidOrders}** 笔${checkins}\n支付金额 ${money(snapshot.daily.grossReceipts, snapshot.currency)} · 退款成功 ${valueText(snapshot.daily.successfulRefunds)} 笔 / ${money(snapshot.daily.refundAmount, snapshot.currency)}\n支付净额 **${money(snapshot.daily.netCash, snapshot.currency)}**\n${invoiceDaily}`,
        },
        { tag: 'hr' },
        { tag: 'markdown', content: `**当前待办**\n${todoLine(snapshot)}` },
        ...(monitoring.length ? [{ tag: 'markdown', content: monitoring.join(' · ') }] : []),
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: `**当前累计**\n有效报名 **${snapshot.cumulative.validRegistrations}** · 已支付订单 **${snapshot.cumulative.paidOrders}** · 已确认参会 **${snapshot.cumulative.confirmedAttendees}**\n${snapshot.metricVersion === 1 ? '累计净收入（历史 V1）' : '累计订单净额'} **${money(snapshot.cumulative.netRevenue, snapshot.currency)}** · 剩余库存 **${snapshot.cumulative.remainingInventory}**${['in_progress', 'ended'].includes(snapshot.event.status) ? ` · 累计签到 **${snapshot.cumulative.checkins}**` : ''}`,
        },
        ...issues.map((description) => ({
          tag: 'markdown',
          text_size: 'notation',
          content: markdownText(description),
        })),
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: '8px',
          columns: buttons.map(([label, url], index) => ({
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [
              {
                tag: 'button',
                type: index === 0 ? 'primary' : 'default',
                text: { tag: 'plain_text', content: label },
                behaviors: [{ type: 'open_url', default_url: url }],
              },
            ],
          })),
        },
        {
          tag: 'markdown',
          text_size: 'notation',
          content: `生成于 ${new Intl.DateTimeFormat('zh-CN', { timeZone: snapshot.event.timezone, dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' }).format(new Date(snapshot.generatedAt))}，当前待办以此时刻为准。金额按业务流水统计，未表示银行结算或扣除手续费后的到账金额。`,
        },
      ],
    },
  };
}
