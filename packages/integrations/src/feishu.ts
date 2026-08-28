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

  constructor(
    message: string,
    options: {
      code?: string;
      retryable?: boolean;
      outcomeUnknown?: boolean;
      httpStatus?: number;
    } = {},
  ) {
    super(message);
    this.name = 'FeishuApiError';
    this.code = options.code ?? 'FEISHU_REQUEST_FAILED';
    this.retryable = options.retryable ?? false;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.httpStatus = options.httpStatus ?? 0;
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

function boolean(value: unknown) {
  return value === true;
}

function safeProviderMessage(message: string) {
  return message.replaceAll(/(?:t-|u-)[A-Za-z0-9_-]{12,}/gu, '[token]').slice(0, 500);
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
      return JSON.parse(body) as FeishuEnvelope<T>;
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
    } catch (error) {
      throw new FeishuApiError(error instanceof Error ? error.message : '飞书凭据校验请求失败', {
        code: 'FEISHU_TOKEN_NETWORK_ERROR',
        retryable: true,
      });
    }
    const envelope = await this.parse<never>(response);
    if (!response.ok || envelope.code !== 0 || !envelope.tenant_access_token) {
      throw new FeishuApiError(
        safeProviderMessage(envelope.msg || `飞书凭据校验失败（HTTP ${response.status}）`),
        {
          code: String(envelope.code ?? `HTTP_${response.status}`),
          retryable: response.status === 429 || response.status >= 500,
          httpStatus: response.status,
        },
      );
    }
    const expiresIn = Math.max(60, Number(envelope.expire ?? 7_200));
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
    } catch (error) {
      throw new FeishuApiError(error instanceof Error ? error.message : '飞书接口请求失败', {
        code: options.sendingMessage ? 'FEISHU_SEND_OUTCOME_UNKNOWN' : 'FEISHU_NETWORK_ERROR',
        retryable: !options.sendingMessage,
        outcomeUnknown: options.sendingMessage === true,
      });
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
      const outcomeUnknown = options.sendingMessage === true && response.status >= 500;
      throw new FeishuApiError(
        safeProviderMessage(envelope.msg || `飞书接口请求失败（HTTP ${response.status}）`),
        {
          code: String(envelope.code ?? `HTTP_${response.status}`),
          retryable: response.status === 429 || (!options.sendingMessage && response.status >= 500),
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
      for (const item of data.items ?? []) {
        if (!item.chat_id || item.chat_status === 'disbanded') continue;
        chats.push({
          chatId: item.chat_id,
          name: text(item.name) || '未命名群聊',
          description: text(item.description),
          ownerId: text(item.owner_id),
          external: boolean(item.external),
        });
      }
      if (!data.has_more || !data.page_token) break;
      if (page === 19) {
        throw new FeishuApiError('机器人所在群超过 2000 个，请缩小应用使用范围后重试', {
          code: 'FEISHU_CHAT_LIST_LIMIT_EXCEEDED',
        });
      }
      pageToken = data.page_token;
    }
    return chats.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }

  async sendInteractiveMessage(chatId: string, card: Record<string, unknown>) {
    const data = await this.request<{ message_id?: string }>(
      '/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        method: 'POST',
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        }),
      },
      { sendingMessage: true },
    );
    if (!data.message_id) {
      throw new FeishuApiError('飞书已响应，但没有返回消息标识', {
        code: 'FEISHU_MESSAGE_ID_MISSING',
        outcomeUnknown: true,
      });
    }
    return { messageId: data.message_id };
  }
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value / 100);
}

function todoTotal(snapshot: FeishuDigestSnapshot) {
  return Object.values(snapshot.todos).reduce((total, value) => total + value, 0);
}

function todoLine(snapshot: FeishuDigestSnapshot) {
  const items = [
    ['报名待审核', snapshot.todos.pendingRegistrationReview],
    ['发票待处理', snapshot.todos.invoiceActionable],
    ['支付异常', snapshot.todos.paymentExceptions],
    ['合作咨询', snapshot.todos.cooperationRequests],
    ['低库存票种', snapshot.todos.lowStockTicketTypes],
  ].filter(([, value]) => Number(value) > 0);
  return items.length
    ? items.map(([label, value]) => `${label} **${value}**`).join(' · ')
    : '当前没有需要人工处理的事项';
}

export function buildFeishuDigestLinks(
  adminOrigin: string,
  eventId: number,
  snapshot: FeishuDigestSnapshot,
) {
  const dashboard = new URL(`/events/${eventId}/overview`, adminOrigin).toString();
  let todoPath = `/events/${eventId}/overview`;
  if (snapshot.todos.pendingRegistrationReview > 0) {
    todoPath = `/events/${eventId}/registrations?reviewStatus=pending_review`;
  } else if (snapshot.todos.invoiceActionable > 0) {
    todoPath = `/events/${eventId}/invoices?status=pending_review%2Cissue_failed%2Cadjustment_required`;
  } else if (snapshot.todos.paymentExceptions > 0) {
    todoPath = `/events/${eventId}/orders?paymentException=true`;
  } else if (snapshot.todos.cooperationRequests > 0) {
    todoPath = `/events/${eventId}/registrations/cooperation-requests?status=new`;
  }
  return { dashboard, todos: new URL(todoPath, adminOrigin).toString() };
}

export function buildFeishuDigestCard(
  snapshot: FeishuDigestSnapshot,
  links: { dashboard: string; todos: string },
  options: { test?: boolean; label?: string } = {},
): Record<string, unknown> {
  const titlePrefix = options.test ? '【测试】' : options.label ? `【${options.label}】` : '';
  const pv = snapshot.pageViewsAvailable ? String(snapshot.daily.pageViews ?? 0) : '暂无完整数据';
  const checkinDaily =
    snapshot.event.status === 'in_progress' || snapshot.event.status === 'ended'
      ? ` · 签到 **${snapshot.daily.checkins}**`
      : '';
  const checkinCumulative =
    snapshot.event.status === 'in_progress' || snapshot.event.status === 'ended'
      ? ` · 累计签到 **${snapshot.cumulative.checkins}**`
      : '';
  const monitoring = [
    snapshot.monitoring.invoiceAwaitingDetails
      ? `待补资料发票 ${snapshot.monitoring.invoiceAwaitingDetails}`
      : '',
    snapshot.monitoring.invoiceIssuing ? `开票中 ${snapshot.monitoring.invoiceIssuing}` : '',
    snapshot.monitoring.pendingPayments ? `待支付 ${snapshot.monitoring.pendingPayments}` : '',
  ].filter(Boolean);

  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      template: todoTotal(snapshot) > 0 ? 'orange' : 'blue',
      title: {
        tag: 'plain_text',
        content: `${titlePrefix}${snapshot.event.name}｜运营日报`,
      },
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
          content:
            `**昨日核心**\n访问 **${pv}** · 新增报名 **${snapshot.daily.newRegistrations}** · 支付订单 **${snapshot.daily.paidOrders}**${checkinDaily}\n` +
            `支付 ${money(snapshot.daily.grossReceipts, snapshot.currency)} · 退款 ${snapshot.daily.successfulRefunds} 笔 / ${money(snapshot.daily.refundAmount, snapshot.currency)}\n` +
            `净现金 **${money(snapshot.daily.netCash, snapshot.currency)}** · 发票申请 **${snapshot.daily.invoiceRequests}**`,
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content:
            `**当前累计**\n有效报名 **${snapshot.cumulative.validRegistrations}** · 已支付订单 **${snapshot.cumulative.paidOrders}** · 已确认参会 **${snapshot.cumulative.confirmedAttendees}**\n` +
            `累计净收入 **${money(snapshot.cumulative.netRevenue, snapshot.currency)}** · 剩余库存 **${snapshot.cumulative.remainingInventory}**${checkinCumulative}`,
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: `**待处理 ${todoTotal(snapshot)}**\n${todoLine(snapshot)}`,
        },
        ...(monitoring.length
          ? [{ tag: 'markdown', content: `**监控**\n${monitoring.join(' · ')}` }]
          : []),
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: '8px',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                {
                  tag: 'button',
                  type: 'primary',
                  text: { tag: 'plain_text', content: '查看大会仪表盘' },
                  behaviors: [{ type: 'open_url', default_url: links.dashboard }],
                },
              ],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [
                {
                  tag: 'button',
                  type: 'default',
                  text: { tag: 'plain_text', content: '处理待办' },
                  behaviors: [{ type: 'open_url', default_url: links.todos }],
                },
              ],
            },
          ],
        },
        {
          tag: 'markdown',
          text_size: 'notation',
          content: `生成时间：${new Intl.DateTimeFormat('zh-CN', {
            timeZone: snapshot.event.timezone,
            dateStyle: 'medium',
            timeStyle: 'medium',
            hourCycle: 'h23',
          }).format(new Date(snapshot.generatedAt))}`,
        },
      ],
    },
  };
}
