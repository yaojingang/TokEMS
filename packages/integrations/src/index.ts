import { createRequire } from 'node:module';
import type {
  QuerySendDetailsRequest,
  SendSmsRequest,
} from '@alicloud/dysmsapi20170525/dist/client.js';
import * as $OpenApi from '@alicloud/openapi-client';
import type { RuntimeOptions } from '@darabonba/typescript';

export * from './feishu.js';

export const ALIYUN_SMS_ENDPOINT = 'dysmsapi.aliyuncs.com';

const require = createRequire(import.meta.url);
type DysmsapiClientLike = {
  sendSmsWithOptions(
    request: SendSmsRequest,
    runtime: RuntimeOptions,
  ): Promise<{
    body?: {
      code?: string;
      message?: string;
      requestId?: string;
      bizId?: string;
    };
  }>;
  querySendDetailsWithOptions(
    request: QuerySendDetailsRequest,
    runtime: RuntimeOptions,
  ): Promise<{
    body?: {
      code?: string;
      message?: string;
      totalCount?: string;
      smsSendDetailDTOs?: {
        smsSendDetailDTO?: Array<{
          errCode?: string;
          outId?: string;
          receiveDate?: string;
          sendDate?: string;
          sendStatus?: number;
        }>;
      };
    };
  }>;
};
const dysmsapi = require('@alicloud/dysmsapi20170525') as {
  default: new (config: $OpenApi.Config) => DysmsapiClientLike;
  QuerySendDetailsRequest: new (value: Record<string, unknown>) => QuerySendDetailsRequest;
  SendSmsRequest: new (value: Record<string, unknown>) => SendSmsRequest;
};
const darabonba = require('@darabonba/typescript') as {
  RuntimeOptions: new (value: Record<string, unknown>) => RuntimeOptions;
};

function runtimeOptions() {
  return new darabonba.RuntimeOptions({
    autoretry: false,
    maxAttempts: 1,
    connectTimeout: 5_000,
    readTimeout: 15_000,
  });
}

export const ALIYUN_SMS_TEMPLATE_KEYS = [
  'customerOtp',
  'registrationSubmitted',
  'registrationApproved',
  'registrationRejected',
  'paymentSucceeded',
  'ticketIssued',
  'refundSucceeded',
  'refundReviewed',
  'waitlistAvailable',
  'invoiceDetailsRequested',
  'invoiceReady',
  'eventReminder',
] as const;

export type AliyunSmsTemplateKey = (typeof ALIYUN_SMS_TEMPLATE_KEYS)[number];

export const ALIYUN_SMS_TEMPLATE_META: Record<
  AliyunSmsTemplateKey,
  { label: string; variables: readonly string[] }
> = {
  customerOtp: { label: '登录验证码', variables: ['code'] },
  registrationSubmitted: {
    label: '报名已提交',
    variables: ['eventName', 'url', 'expiresAt'],
  },
  registrationApproved: {
    label: '报名审核通过',
    variables: ['eventName', 'url'],
  },
  registrationRejected: {
    label: '报名审核未通过',
    variables: ['eventName', 'reason'],
  },
  paymentSucceeded: {
    label: '支付成功',
    variables: ['eventName', 'orderNo', 'amount'],
  },
  ticketIssued: {
    label: '电子票已签发',
    variables: ['eventName', 'url'],
  },
  refundReviewed: { label: '退款审核结果', variables: ['eventName', 'orderNo', 'result'] },
  refundSucceeded: {
    label: '退款成功',
    variables: ['eventName', 'orderNo', 'amount'],
  },
  waitlistAvailable: {
    label: '候补名额释放',
    variables: ['name', 'eventName', 'expiresAt', 'url'],
  },
  invoiceDetailsRequested: {
    label: '补充发票信息',
    variables: ['eventName', 'expiresAt', 'url'],
  },
  invoiceReady: {
    label: '电子发票已开具',
    variables: ['eventName', 'expiresAt', 'url'],
  },
  eventReminder: {
    label: '大会提醒',
    variables: ['eventName', 'startsAt', 'venue'],
  },
};

export type AliyunSmsStoredConfiguration = {
  enabled: boolean;
  signName: string;
  endpoint: typeof ALIYUN_SMS_ENDPOINT;
  templates: Record<
    AliyunSmsTemplateKey,
    {
      enabled: boolean;
      templateCode: string;
      status: 'unverified' | 'verified' | 'error';
      lastVerifiedAt: string | null;
      lastError: string | null;
    }
  >;
};

export function emptyAliyunSmsConfiguration(): AliyunSmsStoredConfiguration {
  return {
    enabled: false,
    signName: '',
    endpoint: ALIYUN_SMS_ENDPOINT,
    templates: Object.fromEntries(
      ALIYUN_SMS_TEMPLATE_KEYS.map((key) => [
        key,
        {
          enabled: key === 'customerOtp',
          templateCode: '',
          status: 'unverified',
          lastVerifiedAt: null,
          lastError: null,
        },
      ]),
    ) as AliyunSmsStoredConfiguration['templates'],
  };
}

export function readAliyunSmsConfiguration(
  value: Record<string, unknown>,
): AliyunSmsStoredConfiguration {
  const defaults = emptyAliyunSmsConfiguration();
  const rawTemplates =
    typeof value.templates === 'object' && value.templates !== null
      ? (value.templates as Record<string, unknown>)
      : {};
  return {
    enabled: value.enabled === true,
    signName: typeof value.signName === 'string' ? value.signName : '',
    endpoint: ALIYUN_SMS_ENDPOINT,
    templates: Object.fromEntries(
      ALIYUN_SMS_TEMPLATE_KEYS.map((key) => {
        const raw =
          typeof rawTemplates[key] === 'object' && rawTemplates[key] !== null
            ? (rawTemplates[key] as Record<string, unknown>)
            : {};
        return [
          key,
          {
            enabled:
              typeof raw.enabled === 'boolean' ? raw.enabled : defaults.templates[key].enabled,
            templateCode: typeof raw.templateCode === 'string' ? raw.templateCode : '',
            status: raw.status === 'verified' || raw.status === 'error' ? raw.status : 'unverified',
            lastVerifiedAt: typeof raw.lastVerifiedAt === 'string' ? raw.lastVerifiedAt : null,
            lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
          },
        ];
      }),
    ) as AliyunSmsStoredConfiguration['templates'],
  };
}

export type AliyunSmsCredentials = {
  accessKeyId: string;
  accessKeySecret: string;
};

export type AliyunSmsSendInput = {
  phoneNumber: string;
  signName: string;
  templateCode: string;
  templateParameters: Record<string, string>;
  outId: string;
};

export type AliyunSmsSendResult = {
  accepted: boolean;
  code: string;
  message: string;
  requestId: string;
  bizId: string;
};

export type AliyunSmsDeliveryResult = {
  status: 'waiting' | 'delivered' | 'failed' | 'unknown';
  errorCode: string;
  errorMessage: string;
  sentAt: string | null;
  receivedAt: string | null;
};

export function aliyunDomesticPhone(value: string) {
  const national = value.trim().replace(/^\+86/, '');
  if (!/^1[3-9]\d{9}$/.test(national)) {
    throw new Error('阿里云国内短信仅支持有效的中国大陆手机号');
  }
  return national;
}

export class AliyunSmsClient {
  private readonly client: DysmsapiClientLike;

  constructor(credentials: AliyunSmsCredentials) {
    const config = new $OpenApi.Config({
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      endpoint: ALIYUN_SMS_ENDPOINT,
      connectTimeout: 5_000,
      readTimeout: 15_000,
    });
    this.client = new dysmsapi.default(config);
  }

  async send(input: AliyunSmsSendInput): Promise<AliyunSmsSendResult> {
    const response = await this.client.sendSmsWithOptions(
      new dysmsapi.SendSmsRequest({
        phoneNumbers: aliyunDomesticPhone(input.phoneNumber),
        signName: input.signName,
        templateCode: input.templateCode,
        templateParam: JSON.stringify(input.templateParameters),
        outId: input.outId,
      }),
      runtimeOptions(),
    );
    const body = response.body;
    return {
      accepted: body?.code === 'OK',
      code: body?.code ?? 'UNKNOWN',
      message: body?.message ?? '阿里云短信未返回结果说明',
      requestId: body?.requestId ?? '',
      bizId: body?.bizId ?? '',
    };
  }

  async query(input: {
    phoneNumber: string;
    bizId?: string;
    outId?: string;
    sendDate: string;
  }): Promise<AliyunSmsDeliveryResult> {
    let detail:
      | {
          errCode?: string;
          outId?: string;
          receiveDate?: string;
          sendDate?: string;
          sendStatus?: number;
        }
      | undefined;
    for (let currentPage = 1; currentPage <= (input.bizId ? 1 : 5); currentPage += 1) {
      const response = await this.client.querySendDetailsWithOptions(
        new dysmsapi.QuerySendDetailsRequest({
          phoneNumber: aliyunDomesticPhone(input.phoneNumber),
          ...(input.bizId ? { bizId: input.bizId } : {}),
          sendDate: input.sendDate,
          pageSize: 50,
          currentPage,
        }),
        runtimeOptions(),
      );
      const body = response.body;
      if (body?.code !== 'OK') {
        return {
          status: 'unknown',
          errorCode: body?.code ?? 'UNKNOWN',
          errorMessage: body?.message ?? '阿里云短信状态查询失败',
          sentAt: null,
          receivedAt: null,
        };
      }
      const details = body.smsSendDetailDTOs?.smsSendDetailDTO ?? [];
      detail =
        (input.outId ? details.find((item) => item.outId === input.outId) : undefined) ??
        (input.bizId || (!input.outId && details.length === 1) ? details[0] : undefined);
      if (detail) break;
      const total = Number(body.totalCount ?? details.length);
      if (details.length < 50 || currentPage * 50 >= total) break;
    }
    const status =
      detail?.sendStatus === 3
        ? 'delivered'
        : detail?.sendStatus === 2
          ? 'failed'
          : detail?.sendStatus === 1
            ? 'waiting'
            : 'unknown';
    return {
      status,
      errorCode: detail?.errCode ?? '',
      errorMessage: status === 'failed' ? (detail?.errCode ?? '短信投递失败') : '',
      sentAt: detail?.sendDate ?? null,
      receivedAt: detail?.receiveDate ?? null,
    };
  }
}
