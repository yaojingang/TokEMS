import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import {
  API_ERROR_CODES,
  type UpdateWeChatPayConfiguration,
  type WeChatH5Payment,
  type WeChatJsapiPayment,
  type WeChatNativePayment,
  type WeChatOAuthSession,
  type WeChatOAuthStart,
  type WeChatPayConfiguration,
  type WeChatPayConnectionTest,
  type WeChatPaymentChannel,
  type WeChatPaymentPrepareResult,
} from '@conference/contracts';
import {
  ACTIVE_WECHAT_PAYMENT_STATUSES,
  auditLogs,
  events,
  orderAccessTokens,
  orders,
  organizationIntegrations,
  paymentNotificationInbox,
  payments,
  refundRequests,
  refunds,
  refundNotificationInbox,
} from '@conference/database';
import { resolvePaymentPublicUrl } from '@conference/security';
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { ConferenceRepository } from './conference.repository.js';
import { DatabaseService } from './database.service.js';
import { DomainError } from './domain-error.js';
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
  integrationEncryptionKeyVersion,
} from './integration-credentials.js';
import { RedisService } from './redis.service.js';
import { RefundGatewayError, WeChatRefundOutcomeSchema } from './refund-policy.js';
import {
  lockWeChatConfiguration,
  type WeChatConfigurationTransaction,
} from './wechat-configuration-lock.js';

type RefundConfigurationReader =
  NonNullable<DatabaseService['db']> | WeChatConfigurationTransaction;

const PROVIDER = 'wechatpay';
const WECHAT_PAY_API = 'https://api.mch.weixin.qq.com';
const WECHAT_OAUTH_AUTHORIZE = 'https://open.weixin.qq.com/connect/oauth2/authorize';
const WECHAT_OAUTH_TOKEN = 'https://api.weixin.qq.com/sns/oauth2/access_token';
const REDIS_PREFIX = 'tokems:wechat:';
const PREPARE_CLAIM_TTL_MS = 15_000;
const QUERY_THROTTLE_MS = 15_000;
const FORCE_QUERY_COALESCE_MS = 3_000;
const PAYMENT_INBOX_MAX_ATTEMPTS = 10;
const PAYMENT_INBOX_PROCESSING_LEASE_MS = 60_000;
const PAYMENT_INBOX_RETRY_BASE_MS = 15_000;
const PAYMENT_INBOX_RETRY_MAX_MS = 5 * 60_000;
const PAYMENT_MAINTENANCE_INTERVAL_MS = 15_000;
const PAYMENT_CLOSE_LEASE_MS = 45_000;
const OAUTH_STATE_TTL_SECONDS = 600;
const OAUTH_SESSION_TTL_SECONDS = 1800;
const OAUTH_HANDOFF_TTL_SECONDS = 120;

type ChannelFlags = {
  native: boolean;
  jsapi: boolean;
  h5: boolean;
};

type PublicConfig = {
  refundFunding?: 'default' | 'available' | null;
  enabled: boolean;
  appId: string;
  mchId: string;
  merchantCertificateSerial: string;
  platformPublicKeyId: string;
  oauthEnabled: boolean;
  channels: ChannelFlags;
};

type Credentials = {
  refundPublicKeys?: string;
  merchantPrivateKey: string;
  apiV3Key: string;
  platformPublicKey: string;
  appSecret?: string;
};

type WeChatNotification = {
  id: string;
  event_type: string;
  resource: {
    algorithm: string;
    ciphertext: string;
    nonce: string;
    associated_data?: string;
  };
};

type WeChatTransaction = {
  appid: string;
  mchid: string;
  out_trade_no: string;
  transaction_id?: string;
  trade_state: string;
  trade_state_desc?: string;
  amount?: {
    total: number;
    payer_total?: number;
    currency: string;
    payer_currency?: string;
  };
  success_time?: string;
};

type AuthorizedOrder = {
  order: typeof orders.$inferSelect;
  eventName: string;
  accessTokenHash: string;
};

type PaymentAttempt = typeof payments.$inferSelect;

/**
 * Determines whether an existing provider credential can reopen the same
 * payment surface without creating the WeChat order again.
 *
 * @param status - Current local payment-attempt state
 * @param hasCredential - Whether the channel credential is persisted
 * @returns True when the existing credential is safe to return
 */
export function isReusablePreparedPaymentCredential(
  status: PaymentAttempt['status'],
  hasCredential: boolean,
) {
  return hasCredential && (status === 'pending' || status === 'query_pending');
}

type ParsedPaymentNotification = {
  inboxId: string;
  notificationId: string;
  organizationId: string;
  orderId: string;
  paymentId?: string;
  attemptId?: string;
  outTradeNo: string;
  externalId: string;
  amount: number;
  currency: string;
  occurredAt: string;
  alreadyProcessed: boolean;
  alreadyReceived: boolean;
};

type QueryPaymentSuccess = {
  orderId: string;
  paymentId: string;
  outTradeNo: string;
  externalId: string;
  amount: number;
  currency: string;
  occurredAt: string;
  tradeState: 'SUCCESS';
};

type OAuthStateRecord = {
  orderId: string;
  organizationId: string;
  accessTokenHash: string;
  returnPath: string;
};

type OAuthSessionRecord = {
  orderId: string;
  organizationId: string;
  openid: string;
};

/**
 * Reads a boolean channel flag from persisted integration config.
 *
 * @param value - Raw channel map from JSON config.
 * @param key - Channel key.
 * @param fallback - Default when unset.
 * @returns Normalized boolean flag.
 */
function readChannelFlag(
  value: Record<string, unknown> | undefined,
  key: keyof ChannelFlags,
  fallback: boolean,
) {
  if (!value || typeof value !== 'object') return fallback;
  const raw = value[key];
  return typeof raw === 'boolean' ? raw : fallback;
}

/**
 * Normalizes public WeChat Pay configuration stored on the integration row.
 *
 * @param value - Raw JSON config from organization_integrations.
 * @returns Safe public configuration without secrets.
 */
function safeConfig(value: Record<string, unknown>): PublicConfig {
  const channelsValue =
    value.channels && typeof value.channels === 'object'
      ? (value.channels as Record<string, unknown>)
      : undefined;
  return {
    enabled: value.enabled === true,
    refundFunding:
      value.refundFunding === 'default' || value.refundFunding === 'available'
        ? value.refundFunding
        : null,
    appId: typeof value.appId === 'string' ? value.appId : '',
    mchId: typeof value.mchId === 'string' ? value.mchId : '',
    merchantCertificateSerial:
      typeof value.merchantCertificateSerial === 'string' ? value.merchantCertificateSerial : '',
    platformPublicKeyId:
      typeof value.platformPublicKeyId === 'string' ? value.platformPublicKeyId : '',
    oauthEnabled: value.oauthEnabled === true,
    channels: {
      native: readChannelFlag(channelsValue, 'native', true),
      jsapi: readChannelFlag(channelsValue, 'jsapi', false),
      h5: readChannelFlag(channelsValue, 'h5', false),
    },
  };
}

/**
 * Extracts a human-readable WeChat API error message from a response body.
 *
 * @param body - Raw response text.
 * @returns Combined code/message or a generic failure string.
 */
function readErrorMessage(body: string) {
  try {
    const parsed = JSON.parse(body) as { message?: string; code?: string };
    return [parsed.code, parsed.message].filter(Boolean).join(' · ') || '微信支付请求失败';
  } catch {
    return '微信支付请求失败';
  }
}

/**
 * Builds a WeChat-compliant out_trade_no unique per payment attempt.
 *
 * @param orderNo - Local order number used as a readable prefix.
 * @returns 6–32 character merchant trade number.
 */
function generateOutTradeNo(orderNo: string) {
  const prefix = orderNo.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'TOKEMS';
  const suffix = randomBytes(8).toString('hex');
  return `${prefix}${suffix}`.slice(0, 32);
}

/**
 * Validates an IPv4/IPv6 literal suitable for WeChat payer_client_ip.
 *
 * @param value - Candidate IP string.
 * @returns True when the value looks like a usable client IP.
 */
function isUsableClientIp(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'unknown') return false;
  if (trimmed.includes(':')) {
    return /^[0-9a-fA-F:.]+$/.test(trimmed) && trimmed.length <= 45;
  }
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed);
}

/**
 * Resolves a trusted client IP for H5 payer_client_ip.
 * Prefers Fastify `request.ip` when TRUST_PROXY is configured; otherwise
 * only accepts an explicit direct IP and never untrusted X-Forwarded-For.
 *
 * @param requestIp - Fastify request.ip (already proxy-aware when trustProxy set).
 * @param forwardedFor - Raw X-Forwarded-For header.
 * @returns IPv4/IPv6 string accepted by WeChat.
 */
export function resolveTrustedClientIp(
  requestIp: string | undefined,
  forwardedFor?: string,
): string {
  const trustProxyConfigured = Boolean(process.env.TRUST_PROXY?.trim());
  if (trustProxyConfigured && requestIp && isUsableClientIp(requestIp)) {
    return requestIp.trim();
  }
  if (trustProxyConfigured && forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim() ?? '';
    if (isUsableClientIp(first)) return first;
  }
  if (requestIp && isUsableClientIp(requestIp)) {
    return requestIp.trim();
  }
  throw new DomainError(
    API_ERROR_CODES.VALIDATION_ERROR,
    '无法确定可信的客户端 IP，无法发起 H5 支付',
    HttpStatus.BAD_REQUEST,
  );
}

/**
 * Builds the JSAPI paySign message required by WeChat Pay v3.
 *
 * @param appId - Official account AppID.
 * @param timeStamp - Unix timestamp seconds as a string.
 * @param nonceStr - Random nonce.
 * @param packageValue - Package value such as `prepay_id=...`.
 * @returns Canonical message terminated by a newline.
 */
export function buildJsapiSignMessage(
  appId: string,
  timeStamp: string,
  nonceStr: string,
  packageValue: string,
): string {
  return `${appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`;
}

/**
 * Appends a single server-controlled redirect_url to a WeChat H5 URL.
 *
 * @param h5Url - Raw h5_url from WeChat.
 * @param redirectUrl - Absolute payment-surface return URL.
 * @returns H5 URL containing exactly one redirect_url query parameter.
 */
function appendH5RedirectUrl(h5Url: string, redirectUrl: string) {
  if (/[?&]redirect_url=/.test(h5Url)) return h5Url;
  const separator = h5Url.includes('?') ? '&' : '?';
  return `${h5Url}${separator}redirect_url=${encodeURIComponent(redirectUrl)}`;
}

/**
 * Builds the fixed OAuth redirect_uri under the payment public surface.
 *
 * @returns Absolute OAuth callback URL registered with WeChat.
 */
function oauthRedirectUri() {
  return resolvePaymentPublicUrl('/api/v1/payments/wechat/oauth/callback');
}

/**
 * Builds the fixed H5 redirect_url for an order on the payment surface.
 *
 * @param orderId - Local order UUID.
 * @returns Absolute order page URL used after H5 payment.
 */
function h5RedirectUrl(orderId: string) {
  return resolvePaymentPublicUrl(`/order/${orderId}`);
}

/**
 * Selects notification inbox rows whose retry lease is currently available.
 * Failed rows use exponential backoff so multiple API replicas cannot exhaust
 * the durable retry budget during a short downstream outage.
 */
function retryablePaymentInbox(staleCutoff: Date) {
  return or(
    eq(paymentNotificationInbox.status, 'received'),
    and(
      eq(paymentNotificationInbox.status, 'failed'),
      sql`${paymentNotificationInbox.updatedAt} <= now() - (
        interval '1 millisecond' * least(
          ${PAYMENT_INBOX_RETRY_MAX_MS},
          ${PAYMENT_INBOX_RETRY_BASE_MS} * power(
            2,
            greatest(${paymentNotificationInbox.attemptCount} - 1, 0)
          )
        )
      )`,
    ),
    and(
      eq(paymentNotificationInbox.status, 'processing'),
      lt(paymentNotificationInbox.updatedAt, staleCutoff),
    ),
  );
}

/**
 * WeChat Pay API v3 multi-channel service (Native / JSAPI / H5).
 *
 * Security constraints:
 * - openid never appears in HTTP responses or structured logs
 * - H5 redirect_url and OAuth redirect_uri are server-fixed
 * - Channel switches require query → close → CLOSED before a new attempt
 */
@Injectable()
export class WeChatPayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WeChatPayService.name);
  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private maintenanceRunning = false;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional() @Inject(RedisService) private readonly redis?: RedisService,
    @Optional() @Inject(ConferenceRepository) private readonly repository?: ConferenceRepository,
  ) {}

  onApplicationBootstrap() {
    if (!this.database.db) return;
    void this.runPaymentMaintenance();
    this.maintenanceTimer = setInterval(
      () => void this.runPaymentMaintenance(),
      PAYMENT_MAINTENANCE_INTERVAL_MS,
    );
    this.maintenanceTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
  }

  /**
   * Runs durable notification recovery and expired-attempt reconciliation.
   */
  private async runPaymentMaintenance() {
    if (this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    try {
      await this.reconcilePaymentNotificationInbox();
      await this.reconcileExpiredPaymentAttempts();
    } catch (error) {
      this.logger.error(
        `Payment maintenance failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.maintenanceRunning = false;
    }
  }

  /**
   * Returns the Drizzle client or fails when PostgreSQL mode is unavailable.
   *
   * @returns Active database handle.
   */
  private db() {
    if (!this.database.db) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '微信支付需要 PostgreSQL 持久化模式',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.database.db;
  }

  /**
   * Returns the Redis client used for OAuth state and openid sessions.
   *
   * @returns Shared Redis client.
   */
  private redisClient() {
    if (!this.redis) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '微信支付 OAuth 需要 Redis',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.redis.getClient();
  }

  /**
   * Builds the stable WeChat notify URL on the primary API origin (hui).
   *
   * @param organizationId - Tenant organization UUID.
   * @returns Absolute notify callback URL.
   */
  private notifyUrl(organizationId: string) {
    const base =
      process.env.PUBLIC_API_URL?.replace(/\/+$/, '') ??
      `http://localhost:${process.env.API_PORT ?? '4100'}`;
    return `${base}/api/v1/payments/wechat/notify/${organizationId}`;
  }

  /**
   * Loads the WeChat Pay integration row for an organization.
   *
   * @param organizationId - Tenant organization UUID.
   * @returns Integration row or undefined.
   */
  private async integration(organizationId: string, reader: RefundConfigurationReader = this.db()) {
    const [row] = await reader
      .select()
      .from(organizationIntegrations)
      .where(
        and(
          eq(organizationIntegrations.organizationId, organizationId),
          eq(organizationIntegrations.provider, PROVIDER),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Decrypts WeChat credentials for an organization.
   *
   * @param organizationId - Tenant organization UUID.
   * @param encryptedCredentials - Ciphertext blob from the integration row.
   * @returns Decrypted credentials or undefined when incomplete.
   */
  private credentials(
    organizationId: string,
    encryptedCredentials: string | null,
  ): Credentials | undefined {
    if (!encryptedCredentials) return undefined;
    const value = decryptIntegrationCredentials(organizationId, PROVIDER, encryptedCredentials);
    if (!value.merchantPrivateKey || !value.apiV3Key || !value.platformPublicKey) {
      return undefined;
    }
    return {
      ...(value.refundPublicKeys ? { refundPublicKeys: value.refundPublicKeys } : {}),
      merchantPrivateKey: value.merchantPrivateKey,
      apiV3Key: value.apiV3Key,
      platformPublicKey: value.platformPublicKey,
      ...(typeof value.appSecret === 'string' && value.appSecret
        ? { appSecret: value.appSecret }
        : {}),
    };
  }

  /**
   * Returns public WeChat Pay configuration including channel flags and OAuth readiness.
   *
   * @param organizationId - Tenant organization UUID.
   * @returns Public configuration DTO.
   */
  async getConfiguration(organizationId: string): Promise<WeChatPayConfiguration> {
    const row = await this.integration(organizationId);
    const config = safeConfig(row?.config ?? {});
    const secrets = this.credentials(organizationId, row?.encryptedCredentials ?? null);
    let oauthRedirect: string | undefined;
    try {
      oauthRedirect = oauthRedirectUri();
    } catch {
      oauthRedirect = undefined;
    }
    return {
      ...config,
      notifyUrl: this.notifyUrl(organizationId),
      refundNotifyUrl: this.notifyUrl(organizationId).replace(
        '/wechat/notify/',
        '/wechat/refund-notify/',
      ),
      oauthRedirectUri: oauthRedirect,
      status:
        row?.status === 'verified' || row?.status === 'error' || row?.status === 'configured'
          ? row.status
          : 'unconfigured',
      lastVerifiedAt: row?.lastVerifiedAt?.toISOString() ?? null,
      lastError: row?.lastError ?? null,
      secretsPresent: {
        merchantPrivateKey: Boolean(secrets?.merchantPrivateKey),
        apiV3Key: Boolean(secrets?.apiV3Key),
        platformPublicKey: Boolean(secrets?.platformPublicKey),
        appSecret: Boolean(secrets?.appSecret),
      },
    };
  }

  /**
   * Creates or updates WeChat Pay integration settings and encrypted secrets.
   *
   * @param organizationId - Tenant organization UUID.
   * @param actorId - Admin user performing the change.
   * @param input - Validated configuration update payload.
   * @returns Updated public configuration.
   */
  async updateConfiguration(
    organizationId: string,
    actorId: string,
    input: UpdateWeChatPayConfiguration,
  ): Promise<WeChatPayConfiguration> {
    await this.db().transaction(async (tx) => {
      await lockWeChatConfiguration(tx, organizationId);
      const existing = await this.integration(organizationId, tx);
      const previousCredentials = this.credentials(
        organizationId,
        existing?.encryptedCredentials ?? null,
      );
      const appSecret = input.appSecret?.trim() ?? previousCredentials?.appSecret;
      const credentials: Credentials = {
        merchantPrivateKey:
          input.merchantPrivateKey?.trim() ?? previousCredentials?.merchantPrivateKey ?? '',
        apiV3Key: input.apiV3Key ?? previousCredentials?.apiV3Key ?? '',
        platformPublicKey:
          input.platformPublicKey?.trim() ?? previousCredentials?.platformPublicKey ?? '',
        ...(appSecret ? { appSecret } : {}),
      };
      if (
        !credentials.merchantPrivateKey ||
        !credentials.apiV3Key ||
        !credentials.platformPublicKey
      ) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '首次配置需要完整填写商户私钥、APIv3 密钥和微信支付公钥',
          HttpStatus.BAD_REQUEST,
        );
      }
      try {
        createPrivateKey(credentials.merchantPrivateKey);
        createPublicKey(credentials.platformPublicKey);
      } catch {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '商户私钥或微信支付公钥格式无效',
          HttpStatus.BAD_REQUEST,
        );
      }
      const previousConfig = safeConfig(existing?.config ?? {});
      if (
        existing &&
        (input.mchId !== previousConfig.mchId ||
          (input.apiV3Key && input.apiV3Key !== previousCredentials?.apiV3Key))
      ) {
        const [unfinished] = await tx
          .select({ id: refundRequests.id })
          .from(refundRequests)
          .where(
            and(
              eq(refundRequests.organizationId, organizationId),
              isNull(refundRequests.terminatedAt),
            ),
          )
          .limit(1);
        const [unfinishedExecution] = await tx
          .select({ id: refunds.id })
          .from(refunds)
          .where(
            and(
              eq(refunds.organizationId, organizationId),
              inArray(refunds.status, [
                'queued',
                'submitting',
                'query_pending',
                'waiting_funds',
                'processing',
                'abnormal',
              ]),
            ),
          )
          .limit(1);
        const [pendingNotification] = await tx
          .select({ id: refundNotificationInbox.id })
          .from(refundNotificationInbox)
          .where(
            and(
              eq(refundNotificationInbox.organizationId, organizationId),
              inArray(refundNotificationInbox.status, ['received', 'quarantined']),
            ),
          )
          .limit(1);
        if (unfinished || unfinishedExecution || pendingNotification)
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '存在未结清退款，需先完成退款或交接原商户解密配置',
            HttpStatus.CONFLICT,
          );
      }
      const config: PublicConfig = {
        refundFunding:
          input.refundFunding === undefined
            ? (previousConfig.refundFunding ?? null)
            : input.refundFunding,
        enabled: input.enabled,
        appId: input.appId,
        mchId: input.mchId,
        merchantCertificateSerial: input.merchantCertificateSerial,
        platformPublicKeyId: input.platformPublicKeyId,
        oauthEnabled: input.oauthEnabled ?? previousConfig.oauthEnabled,
        channels: {
          native: input.channels?.native ?? previousConfig.channels.native,
          jsapi: input.channels?.jsapi ?? previousConfig.channels.jsapi,
          h5: input.channels?.h5 ?? previousConfig.channels.h5,
        },
      };
      const encryptedPayload: Record<string, string> = {
        merchantPrivateKey: credentials.merchantPrivateKey,
        apiV3Key: credentials.apiV3Key,
        platformPublicKey: credentials.platformPublicKey,
      };
      const notificationKeys: Array<{ serial: string; key: string }> = JSON.parse(
        previousCredentials?.refundPublicKeys ?? '[]',
      );
      if (
        previousCredentials?.platformPublicKey &&
        previousConfig.platformPublicKeyId &&
        previousConfig.platformPublicKeyId !== config.platformPublicKeyId
      ) {
        notificationKeys.unshift({
          serial: previousConfig.platformPublicKeyId,
          key: previousCredentials.platformPublicKey,
        });
      }
      encryptedPayload.refundPublicKeys = JSON.stringify(
        notificationKeys
          .filter(
            (item, index, list) =>
              item.serial !== config.platformPublicKeyId &&
              list.findIndex((other) => other.serial === item.serial) === index,
          )
          .slice(0, 3),
      );
      if (credentials.appSecret) {
        encryptedPayload.appSecret = credentials.appSecret;
      }
      const encryptedCredentials = encryptIntegrationCredentials(
        organizationId,
        PROVIDER,
        encryptedPayload,
      );
      const now = new Date();
      await tx
        .insert(organizationIntegrations)
        .values({
          organizationId,
          provider: PROVIDER,
          status: 'configured',
          config,
          encryptedCredentials,
          keyVersion: integrationEncryptionKeyVersion(),
          lastVerifiedAt: null,
          lastError: null,
          updatedBy: actorId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [organizationIntegrations.organizationId, organizationIntegrations.provider],
          set: {
            status: 'configured',
            config,
            encryptedCredentials,
            keyVersion: integrationEncryptionKeyVersion(),
            lastVerifiedAt: null,
            lastError: null,
            updatedBy: actorId,
            updatedAt: now,
          },
        });
      await tx.insert(auditLogs).values({
        organizationId,
        actorId,
        action: 'integration.wechatpay.update',
        resourceType: 'organization_integration',
        resourceId: existing?.id ?? organizationId,
        before: existing ? { status: existing.status, config: safeConfig(existing.config) } : null,
        after: { status: 'configured', config },
        traceId: crypto.randomUUID(),
      });
    });
    return this.getConfiguration(organizationId);
  }

  /**
   * Signs a WeChat Pay API v3 request Authorization header.
   *
   * @param method - HTTP method.
   * @param canonicalUrl - Path and query as sent to WeChat.
   * @param body - Serialized JSON body or empty string.
   * @param config - Public merchant configuration.
   * @param credentials - Merchant private key material.
   * @returns Authorization header value.
   */
  private signRequest(
    method: string,
    canonicalUrl: string,
    body: string,
    config: PublicConfig,
    credentials: Credentials,
  ) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');
    const message = `${method}\n${canonicalUrl}\n${timestamp}\n${nonce}\n${body}\n`;
    const signer = createSign('RSA-SHA256');
    signer.update(message);
    signer.end();
    const signature = signer.sign(credentials.merchantPrivateKey, 'base64');
    return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.merchantCertificateSerial}",signature="${signature}"`;
  }

  /**
   * Verifies WeChat response signature headers against the platform public key.
   *
   * @param response - Fetch response.
   * @param body - Raw response body text.
   * @param config - Public merchant configuration.
   * @param credentials - Platform public key material.
   */
  private verifyResponse(
    response: Response,
    body: string,
    config: PublicConfig,
    credentials: Credentials,
  ) {
    const timestamp = response.headers.get('wechatpay-timestamp') ?? '';
    const nonce = response.headers.get('wechatpay-nonce') ?? '';
    const signature = response.headers.get('wechatpay-signature') ?? '';
    const serial = response.headers.get('wechatpay-serial') ?? '';
    const timestampValue = Number(timestamp);
    if (
      !timestamp ||
      !Number.isFinite(timestampValue) ||
      Math.abs(Date.now() / 1000 - timestampValue) > 300 ||
      !nonce ||
      !signature ||
      serial !== config.platformPublicKeyId
    ) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '微信支付响应缺少可信签名',
        HttpStatus.BAD_GATEWAY,
      );
    }
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${timestamp}\n${nonce}\n${body}\n`);
    verifier.end();
    if (!verifier.verify(credentials.platformPublicKey, signature, 'base64')) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '微信支付响应签名校验失败',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * Performs a signed WeChat Pay API v3 request with response signature verification.
   *
   * @param method - HTTP method.
   * @param canonicalUrl - Canonical path including query string.
   * @param body - JSON body or undefined for GET.
   * @param config - Public merchant configuration.
   * @param credentials - Signing and verification material.
   * @returns Parsed JSON object (empty object when body is empty).
   */
  private async request(
    method: string,
    canonicalUrl: string,
    body: Record<string, unknown> | undefined,
    config: PublicConfig,
    credentials: Credentials,
    refundRequest = false,
  ) {
    const serialized = body ? JSON.stringify(body) : '';
    let response: Response;
    try {
      response = await fetch(`${WECHAT_PAY_API}${canonicalUrl}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: this.signRequest(method, canonicalUrl, serialized, config, credentials),
          'Wechatpay-Serial': config.platformPublicKeyId,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          'User-Agent': 'TokEMS/0.1',
        },
        ...(body ? { body: serialized } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (refundRequest) throw new RefundGatewayError('NETWORK_ERROR', false);
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '暂时无法连接微信支付，请稍后重试',
        HttpStatus.BAD_GATEWAY,
      );
    }
    const responseBody = await response.text();
    const hasResponseSignature = Boolean(response.headers.get('wechatpay-signature'));
    if (response.ok || hasResponseSignature) {
      this.verifyResponse(response, responseBody, config, credentials);
    }
    if (!response.ok) {
      if (refundRequest) {
        let code = 'UNKNOWN_ERROR';
        try {
          const parsed = JSON.parse(responseBody) as { code?: unknown };
          if (typeof parsed.code === 'string' && /^[A-Z_]{1,80}$/u.test(parsed.code))
            code = parsed.code;
        } catch {
          /* A non-JSON response leaves the acceptance outcome unknown. */
        }
        throw new RefundGatewayError(
          code,
          hasResponseSignature &&
            [
              'NOT_ENOUGH',
              'NO_AUTH',
              'SIGN_ERROR',
              'PARAM_ERROR',
              'INVALID_REQUEST',
              'USER_ACCOUNT_ABNORMAL',
            ].includes(code),
          response.status,
          hasResponseSignature,
        );
      }
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        readErrorMessage(responseBody),
        HttpStatus.BAD_GATEWAY,
      );
    }
    return responseBody ? (JSON.parse(responseBody) as Record<string, unknown>) : {};
  }

  /** Refund reconciliation remains available when new payments are disabled. */
  private async refundIntegration(
    organizationId: string,
    merchantId?: string,
    requireReady = false,
    reader: RefundConfigurationReader = this.db(),
  ) {
    const row = await this.integration(organizationId, reader);
    const config = safeConfig(row?.config ?? {});
    const credentials = this.credentials(organizationId, row?.encryptedCredentials ?? null);
    if (
      !row ||
      !credentials ||
      !config.mchId ||
      !config.merchantCertificateSerial ||
      (requireReady && (row.status !== 'verified' || !config.refundFunding))
    ) {
      throw new RefundGatewayError('REFUND_NOT_CONFIGURED', true);
    }
    if (merchantId && merchantId !== config.mchId)
      throw new RefundGatewayError('MERCHANT_MISMATCH', true);
    return { row, config, credentials };
  }

  async refundMerchantId(organizationId: string, reader: RefundConfigurationReader = this.db()) {
    const { config } = await this.refundIntegration(organizationId, undefined, false, reader);
    return config.mchId;
  }

  async refundConfiguration(organizationId: string, reader: RefundConfigurationReader = this.db()) {
    const { config } = await this.refundIntegration(organizationId, undefined, true, reader);
    const notifyUrl = this.notifyUrl(organizationId).replace(
      '/wechat/notify/',
      '/wechat/refund-notify/',
    );
    if (process.env.NODE_ENV === 'production' && !notifyUrl.startsWith('https://')) {
      throw new RefundGatewayError('REFUND_NOT_CONFIGURED', true);
    }
    return { merchantId: config.mchId, funding: config.refundFunding!, notifyUrl };
  }

  /** Verify legacy payment provenance without altering the order/payment lifecycle. */
  async verifyRefundPayment(organizationId: string, paymentId: string) {
    const [row] = await this.db()
      .select({ payment: payments, order: orders })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(and(eq(payments.id, paymentId), eq(orders.organizationId, organizationId)))
      .limit(1);
    if (!row || row.payment.provider !== PROVIDER || !row.payment.externalId) {
      throw new RefundGatewayError('PAYMENT_NOT_VERIFIED', true);
    }
    const { config, credentials } = await this.refundIntegration(
      organizationId,
      row.payment.merchantId ?? undefined,
    );
    const outTradeNo = row.payment.outTradeNo ?? row.order.orderNo;
    const result = (await this.request(
      'GET',
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.mchId)}`,
      undefined,
      config,
      credentials,
      true,
    )) as unknown as WeChatTransaction;
    if (
      result.mchid !== config.mchId ||
      result.out_trade_no !== outTradeNo ||
      result.transaction_id !== row.payment.externalId ||
      !['SUCCESS', 'REFUND'].includes(result.trade_state) ||
      result.amount?.total !== row.payment.amount ||
      result.amount?.currency !== row.payment.currency ||
      !result.success_time ||
      !Number.isFinite(Date.parse(result.success_time))
    ) {
      throw new RefundGatewayError('PAYMENT_NOT_VERIFIED', true);
    }
    await this.db()
      .update(payments)
      .set({
        merchantId: config.mchId,
        outTradeNo,
        succeededAt: new Date(result.success_time),
        updatedAt: new Date(),
      })
      .where(eq(payments.id, paymentId));
    return { merchantId: config.mchId, paidAt: new Date(result.success_time) };
  }

  async submitRefund(organizationId: string, merchantId: string, body: Record<string, unknown>) {
    const { config, credentials } = await this.refundIntegration(organizationId, merchantId);
    const result = await this.request(
      'POST',
      '/v3/refund/domestic/refunds',
      body,
      config,
      credentials,
      true,
    );
    const parsed = WeChatRefundOutcomeSchema.safeParse(result);
    if (!parsed.success) throw new RefundGatewayError('INVALID_RESPONSE', false);
    return parsed.data;
  }

  async queryRefund(organizationId: string, merchantId: string, outRefundNo: string) {
    const { config, credentials } = await this.refundIntegration(organizationId, merchantId);
    const result = await this.request(
      'GET',
      `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`,
      undefined,
      config,
      credentials,
      true,
    );
    const parsed = WeChatRefundOutcomeSchema.safeParse(result);
    if (!parsed.success || parsed.data.out_refund_no !== outRefundNo)
      throw new RefundGatewayError('INVALID_RESPONSE', false);
    return parsed.data;
  }

  /** Persist authenticated refund notifications before acknowledging WeChat. */
  async receiveRefundNotification(
    organizationId: string,
    rawBody: Buffer,
    headers: {
      timestamp?: string;
      nonce?: string;
      signature?: string;
      serial?: string;
    },
  ) {
    if (
      !headers.timestamp ||
      !headers.nonce ||
      !headers.signature ||
      !headers.serial ||
      !Number.isFinite(Number(headers.timestamp)) ||
      Math.abs(Date.now() / 1000 - Number(headers.timestamp)) > 300
    ) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '退款通知签名信息无效',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const signature = headers.signature;
    await this.db().transaction(async (tx) => {
      await lockWeChatConfiguration(tx, organizationId);
      const { config, credentials } = await this.refundIntegration(
        organizationId,
        undefined,
        false,
        tx,
      );
      const previousKeys: Array<{ serial: string; key: string }> = JSON.parse(
        credentials.refundPublicKeys ?? '[]',
      );
      const verificationKey =
        headers.serial === config.platformPublicKeyId
          ? credentials.platformPublicKey
          : previousKeys.find((item) => item.serial === headers.serial)?.key;
      if (!verificationKey) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '退款通知签名信息无效',
          HttpStatus.UNAUTHORIZED,
        );
      }
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${headers.timestamp}\n${headers.nonce}\n${rawBody.toString('utf8')}\n`);
      verifier.end();
      if (!verifier.verify(verificationKey!, signature, 'base64')) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '退款通知签名无效',
          HttpStatus.UNAUTHORIZED,
        );
      }
      let notification: WeChatNotification;
      let resource: Record<string, unknown>;
      try {
        notification = JSON.parse(rawBody.toString('utf8')) as WeChatNotification;
        if (
          !['REFUND.SUCCESS', 'REFUND.CLOSED', 'REFUND.ABNORMAL'].includes(
            notification.event_type,
          ) ||
          typeof notification.id !== 'string' ||
          !notification.id ||
          notification.id.length > 128 ||
          notification.resource.algorithm !== 'AEAD_AES_256_GCM'
        )
          throw new Error('invalid');
        const ciphertext = Buffer.from(notification.resource.ciphertext, 'base64');
        const decipher = createDecipheriv(
          'aes-256-gcm',
          Buffer.from(credentials.apiV3Key, 'utf8'),
          Buffer.from(notification.resource.nonce, 'utf8'),
        );
        decipher.setAAD(Buffer.from(notification.resource.associated_data ?? '', 'utf8'));
        decipher.setAuthTag(ciphertext.subarray(-16));
        resource = JSON.parse(
          Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString(
            'utf8',
          ),
        );
        if (
          resource.mchid !== config.mchId ||
          typeof resource.out_refund_no !== 'string' ||
          !/^[A-Za-z0-9_\-|@]{1,64}$/u.test(resource.out_refund_no)
        )
          throw new Error('invalid');
      } catch {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          '退款通知内容或商户归属无效',
          HttpStatus.BAD_REQUEST,
        );
      }
      // Only persist reconciliation identifiers. Cash settlement always uses a signed query result.
      await tx
        .insert(refundNotificationInbox)
        .values({
          organizationId,
          merchantId: config.mchId,
          notificationId: notification.id,
          outRefundNo: String(resource.out_refund_no),
          payload: {
            eventType: notification.event_type,
            refundId: resource.refund_id,
            transactionId: resource.transaction_id,
            amount: resource.amount,
          },
        })
        .onConflictDoNothing({
          target: [
            refundNotificationInbox.organizationId,
            refundNotificationInbox.merchantId,
            refundNotificationInbox.notificationId,
          ],
        });
    });
  }

  /**
   * Loads a verified WeChat integration required for live payment operations.
   *
   * @param organizationId - Tenant organization UUID.
   * @param options - Optional verification strictness.
   * @returns Integration row with config and credentials.
   */
  private async requiredIntegration(
    organizationId: string,
    options: { requireVerified?: boolean; requireAppSecret?: boolean } = {},
  ) {
    const row = await this.integration(organizationId);
    const config = safeConfig(row?.config ?? {});
    const credentials = this.credentials(organizationId, row?.encryptedCredentials ?? null);
    if (!row || !config.enabled || !config.appId || !config.mchId || !credentials) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '微信支付尚未完成配置',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (options.requireVerified && row.status !== 'verified') {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '微信支付连接尚未验证通过',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (options.requireAppSecret && !credentials.appSecret) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '公众号 AppSecret 尚未配置，无法完成微信授权',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (
      process.env.NODE_ENV === 'production' &&
      !this.notifyUrl(organizationId).startsWith('https://')
    ) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '生产环境的微信支付回调地址必须使用 HTTPS',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { row, config, credentials };
  }

  /**
   * Ensures the requested payment channel is enabled for the organization.
   *
   * @param config - Public configuration.
   * @param channel - Requested WeChat channel.
   */
  private assertChannelEnabled(config: PublicConfig, channel: WeChatPaymentChannel) {
    const enabled =
      channel === 'native'
        ? config.channels.native
        : channel === 'jsapi'
          ? config.channels.jsapi
          : config.channels.h5;
    if (!enabled) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        `微信支付通道 ${channel} 尚未对该组织开放`,
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * Resolves a trusted client IP for H5 payer_client_ip.
   *
   * @param requestIp - Fastify request.ip (already proxy-aware when trustProxy set).
   * @param forwardedFor - Raw X-Forwarded-For header.
   * @returns IPv4/IPv6 string accepted by WeChat.
   */
  trustedClientIp(requestIp: string | undefined, forwardedFor?: string) {
    return resolveTrustedClientIp(requestIp, forwardedFor);
  }

  /**
   * Authorizes an order access token for payment operations.
   *
   * @param orderId - Order UUID.
   * @param accessToken - Bearer order access token.
   * @returns Order row, event name, and token hash.
   */
  private async authorizeOrder(orderId: string, accessToken: string): Promise<AuthorizedOrder> {
    const accessTokenHash = createHash('sha256').update(accessToken).digest('hex');
    const [row] = await this.db()
      .select({
        order: orders,
        eventName: events.name,
        tokenScopes: orderAccessTokens.scopes,
      })
      .from(orders)
      .innerJoin(events, eq(events.id, orders.eventId))
      .innerJoin(
        orderAccessTokens,
        and(
          eq(orderAccessTokens.orderId, orders.id),
          eq(orderAccessTokens.tokenHash, accessTokenHash),
          isNull(orderAccessTokens.revokedAt),
          gt(orderAccessTokens.expiresAt, new Date()),
        ),
      )
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!row || !row.tokenScopes.includes('order:read')) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '订单访问链接无效或已经过期',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (row.order.status !== 'pending_payment' || row.order.expiresAt <= new Date()) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '当前订单无法发起支付',
        HttpStatus.CONFLICT,
      );
    }
    return {
      order: row.order,
      eventName: row.eventName,
      accessTokenHash,
    };
  }

  /**
   * Loads the single active WeChat payment attempt for an order, if any.
   *
   * @param orderId - Order UUID.
   * @returns Active attempt row or undefined.
   */
  private async findActiveAttempt(orderId: string) {
    const [attempt] = await this.db()
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.orderId, orderId),
          eq(payments.provider, PROVIDER),
          inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES]),
        ),
      )
      .limit(1);
    return attempt;
  }

  /**
   * Tests WeChat API connectivity via /v3/security/echo.
   *
   * @param organizationId - Tenant organization UUID.
   * @param actorId - Admin user performing the test.
   * @returns Connection test result.
   */
  async testConnection(organizationId: string, actorId: string): Promise<WeChatPayConnectionTest> {
    const { row, config, credentials } = await this.requiredIntegration(organizationId);
    const verifiedAt = new Date();
    try {
      const echoMessage = `tokems-${organizationId}-${verifiedAt.getTime()}`;
      const result = await this.request(
        'POST',
        '/v3/security/echo',
        { echo_message: echoMessage },
        config,
        credentials,
      );
      if (result.echo_message !== echoMessage) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '微信支付应答内容与验证请求不一致',
          HttpStatus.BAD_GATEWAY,
        );
      }
      const [verified] = await this.db()
        .update(organizationIntegrations)
        .set({
          status: 'verified',
          lastVerifiedAt: verifiedAt,
          lastError: null,
          updatedBy: actorId,
          updatedAt: verifiedAt,
        })
        .where(
          and(
            eq(organizationIntegrations.id, row.id),
            eq(organizationIntegrations.organizationId, organizationId),
            eq(organizationIntegrations.provider, PROVIDER),
            eq(organizationIntegrations.status, row.status),
            eq(organizationIntegrations.config, row.config),
            row.encryptedCredentials
              ? eq(organizationIntegrations.encryptedCredentials, row.encryptedCredentials)
              : isNull(organizationIntegrations.encryptedCredentials),
            eq(organizationIntegrations.keyVersion, row.keyVersion),
          ),
        )
        .returning({ id: organizationIntegrations.id });
      if (!verified) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '验证期间支付配置已经变化，请重新测试最新配置',
          HttpStatus.CONFLICT,
        );
      }
      return {
        ok: true,
        status: 'verified',
        message: '连接验证通过，可以创建微信支付订单。',
        verifiedAt: verifiedAt.toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '微信支付连接验证失败';
      await this.db()
        .update(organizationIntegrations)
        .set({
          status: 'error',
          lastVerifiedAt: verifiedAt,
          lastError: message.slice(0, 500),
          updatedBy: actorId,
          updatedAt: verifiedAt,
        })
        .where(
          and(
            eq(organizationIntegrations.id, row.id),
            eq(organizationIntegrations.organizationId, organizationId),
            eq(organizationIntegrations.provider, PROVIDER),
            eq(organizationIntegrations.status, row.status),
            eq(organizationIntegrations.config, row.config),
            row.encryptedCredentials
              ? eq(organizationIntegrations.encryptedCredentials, row.encryptedCredentials)
              : isNull(organizationIntegrations.encryptedCredentials),
            eq(organizationIntegrations.keyVersion, row.keyVersion),
          ),
        );
      return {
        ok: false,
        status: 'error',
        message,
        verifiedAt: verifiedAt.toISOString(),
      };
    }
  }

  /**
   * Claims or reuses an active payment attempt under an advisory lock.
   *
   * @param orderId - Order UUID.
   * @param channel - Target channel.
   * @param order - Authorized order row.
   * @param accessTokenHash - Hash of the token that must remain valid while the attempt is claimed.
   * @param credentialVersion - Integration key version snapshot.
   * @returns Existing reusable attempt or a freshly claimed preparing attempt.
   */
  private async claimAttempt(
    orderId: string,
    channel: WeChatPaymentChannel,
    order: AuthorizedOrder['order'],
    accessTokenHash: string,
    credentialVersion: number,
    merchantId: string,
  ): Promise<{ attempt: PaymentAttempt; reusedCredential: boolean }> {
    return this.db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`wechatpay:prepare:${orderId}`}, 0))`,
      );
      const [currentAuthorization] = await tx
        .select({ order: orders, tokenScopes: orderAccessTokens.scopes })
        .from(orders)
        .innerJoin(
          orderAccessTokens,
          and(
            eq(orderAccessTokens.orderId, orders.id),
            eq(orderAccessTokens.tokenHash, accessTokenHash),
            isNull(orderAccessTokens.revokedAt),
            gt(orderAccessTokens.expiresAt, new Date()),
          ),
        )
        .where(eq(orders.id, orderId))
        .limit(1);
      if (!currentAuthorization || !currentAuthorization.tokenScopes.includes('order:read')) {
        throw new DomainError(
          API_ERROR_CODES.UNAUTHORIZED,
          '订单访问链接无效或已经过期',
          HttpStatus.UNAUTHORIZED,
        );
      }
      if (
        currentAuthorization.order.status !== 'pending_payment' ||
        currentAuthorization.order.expiresAt <= new Date()
      ) {
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前订单无法发起支付',
          HttpStatus.CONFLICT,
        );
      }
      const [existing] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.orderId, orderId),
            eq(payments.provider, PROVIDER),
            inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES]),
          ),
        )
        .limit(1);

      if (existing) {
        if (existing.channel && existing.channel !== channel) {
          throw new DomainError(
            API_ERROR_CODES.INVALID_STATE_TRANSITION,
            '当前订单已有其他支付通道进行中，请先切换通道',
            HttpStatus.CONFLICT,
          );
        }
        const payload =
          existing.payload && typeof existing.payload === 'object'
            ? (existing.payload as Record<string, unknown>)
            : {};
        const hasCredential =
          (channel === 'native' && typeof payload.codeUrl === 'string') ||
          (channel === 'jsapi' && typeof payload.prepayId === 'string') ||
          (channel === 'h5' && typeof payload.h5Url === 'string');
        if (isReusablePreparedPaymentCredential(existing.status, hasCredential)) {
          return { attempt: existing, reusedCredential: true };
        }
        if (existing.status === 'preparing') {
          const preparingAt = existing.updatedAt ?? existing.createdAt;
          if (Date.now() - preparingAt.getTime() < PREPARE_CLAIM_TTL_MS) {
            throw new DomainError(
              API_ERROR_CODES.INVALID_STATE_TRANSITION,
              '微信支付正在准备中，请稍后重试',
              HttpStatus.CONFLICT,
            );
          }
        }
        // Reuse the same outTradeNo when previous WeChat result is unknown/incomplete.
        if (
          existing.outTradeNo &&
          (existing.status === 'unknown' ||
            existing.status === 'preparing' ||
            existing.status === 'pending' ||
            existing.status === 'query_pending')
        ) {
          const [updated] = await tx
            .update(payments)
            .set({
              status: 'preparing',
              channel,
              credentialVersion,
              updatedAt: new Date(),
              payload: {
                ...payload,
                preparingAt: new Date().toISOString(),
                reuseOutTradeNo: true,
              },
            })
            .where(eq(payments.id, existing.id))
            .returning();
          return { attempt: updated!, reusedCredential: false };
        }
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '当前支付尝试状态不允许重新下单，请切换通道或稍后再试',
          HttpStatus.CONFLICT,
        );
      }

      const outTradeNo = generateOutTradeNo(order.orderNo);
      const [created] = await tx
        .insert(payments)
        .values({
          orderId,
          provider: PROVIDER,
          channel,
          outTradeNo,
          status: 'preparing',
          amount: order.amount,
          currency: order.currency,
          credentialVersion,
          merchantId,
          payload: { preparingAt: new Date().toISOString() },
        })
        .returning();
      return { attempt: created!, reusedCredential: false };
    });
  }

  /**
   * Marks an attempt as unknown when WeChat may have accepted the order.
   *
   * @param attemptId - Payment attempt UUID.
   * @param reason - Short failure reason stored in payload.
   */
  private async markAttemptUnknown(attemptId: string, reason: string) {
    const [existing] = await this.db()
      .select()
      .from(payments)
      .where(eq(payments.id, attemptId))
      .limit(1);
    const payload =
      existing?.payload && typeof existing.payload === 'object'
        ? (existing.payload as Record<string, unknown>)
        : {};
    await this.db()
      .update(payments)
      .set({
        status: 'unknown',
        wechatTradeState: 'UNKNOWN',
        payload: {
          ...payload,
          lastError: reason.slice(0, 500),
          unknownAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(payments.id, attemptId));
  }

  /**
   * Marks an attempt failed so a new outTradeNo may be created later.
   *
   * @param attemptId - Payment attempt UUID.
   * @param reason - Failure reason.
   */
  private async markAttemptFailed(attemptId: string, reason: string) {
    const [existing] = await this.db()
      .select()
      .from(payments)
      .where(eq(payments.id, attemptId))
      .limit(1);
    const payload =
      existing?.payload && typeof existing.payload === 'object'
        ? (existing.payload as Record<string, unknown>)
        : {};
    await this.db()
      .update(payments)
      .set({
        status: 'failed',
        payload: {
          ...payload,
          lastError: reason.slice(0, 500),
          failedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(payments.id, attemptId));
  }

  /**
   * Builds RSA paySign parameters for WeixinJSBridge invoke.
   *
   * @param prepayId - WeChat prepay_id.
   * @param config - Public merchant configuration.
   * @param credentials - Merchant private key.
   * @returns Frontend JSAPI invoke parameters (no openid).
   */
  buildJsapiParams(prepayId: string, config: PublicConfig, credentials: Credentials) {
    const timeStamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = randomBytes(16).toString('hex');
    const packageValue = `prepay_id=${prepayId}`;
    const message = buildJsapiSignMessage(config.appId, timeStamp, nonceStr, packageValue);
    const signer = createSign('RSA-SHA256');
    signer.update(message);
    signer.end();
    const paySign = signer.sign(credentials.merchantPrivateKey, 'base64');
    return {
      appId: config.appId,
      timeStamp,
      nonceStr,
      package: packageValue,
      signType: 'RSA' as const,
      paySign,
    };
  }

  /**
   * Prepares a Native (QR code) payment attempt.
   *
   * @param orderId - Order UUID.
   * @param accessToken - Bearer order access token.
   * @returns Native prepare result.
   */
  async prepareNativePayment(orderId: string, accessToken: string): Promise<WeChatNativePayment> {
    const authorized = await this.authorizeOrder(orderId, accessToken);
    const { row, config, credentials } = await this.requiredIntegration(
      authorized.order.organizationId,
      { requireVerified: true },
    );
    this.assertChannelEnabled(config, 'native');
    const { attempt, reusedCredential } = await this.claimAttempt(
      orderId,
      'native',
      authorized.order,
      authorized.accessTokenHash,
      row.keyVersion,
      config.mchId,
    );
    if (reusedCredential) {
      const payload = attempt.payload as Record<string, unknown>;
      return {
        orderId,
        channel: 'native',
        attemptId: attempt.id,
        outTradeNo: attempt.outTradeNo!,
        codeUrl: String(payload.codeUrl),
        expiresAt: authorized.order.expiresAt.toISOString(),
      };
    }
    const outTradeNo = attempt.outTradeNo!;
    try {
      const result = await this.request(
        'POST',
        '/v3/pay/transactions/native',
        {
          appid: config.appId,
          mchid: config.mchId,
          description: authorized.eventName.slice(0, 127),
          out_trade_no: outTradeNo,
          time_expire: authorized.order.expiresAt.toISOString(),
          notify_url: this.notifyUrl(authorized.order.organizationId),
          amount: {
            total: authorized.order.amount,
            currency: authorized.order.currency,
          },
        },
        config,
        credentials,
      );
      const codeUrl = typeof result.code_url === 'string' ? result.code_url : '';
      if (!codeUrl) {
        await this.markAttemptFailed(attempt.id, '微信支付未返回付款二维码');
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '微信支付未返回付款二维码',
          HttpStatus.BAD_GATEWAY,
        );
      }
      const now = new Date();
      await this.db()
        .update(payments)
        .set({
          status: 'pending',
          preparedAt: now,
          prepayExpiresAt: authorized.order.expiresAt,
          payload: {
            codeUrl,
            preparedAt: now.toISOString(),
            outTradeNo,
          },
          updatedAt: now,
        })
        .where(eq(payments.id, attempt.id));
      return {
        orderId,
        channel: 'native',
        attemptId: attempt.id,
        outTradeNo,
        codeUrl,
        expiresAt: authorized.order.expiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof DomainError && error.getStatus() === HttpStatus.BAD_GATEWAY) {
        const message = error.message;
        if (message.includes('暂时无法连接')) {
          await this.markAttemptUnknown(attempt.id, message);
        } else {
          await this.markAttemptFailed(attempt.id, message);
        }
      }
      throw error;
    }
  }

  /**
   * Prepares a JSAPI payment attempt bound to a server-side OAuth session.
   *
   * @param orderId - Order UUID.
   * @param accessToken - Bearer order access token.
   * @param oauthSessionToken - Redis OAuth session token (never an openid).
   * @returns JSAPI prepare result with RSA-signed invoke params.
   */
  async prepareJsapiPayment(
    orderId: string,
    accessToken: string,
    oauthSessionToken: string,
  ): Promise<WeChatJsapiPayment> {
    const authorized = await this.authorizeOrder(orderId, accessToken);
    const { row, config, credentials } = await this.requiredIntegration(
      authorized.order.organizationId,
      { requireVerified: true },
    );
    this.assertChannelEnabled(config, 'jsapi');
    if (!config.oauthEnabled) {
      throw new DomainError(API_ERROR_CODES.FORBIDDEN, '微信 OAuth 尚未启用', HttpStatus.FORBIDDEN);
    }
    const openid = await this.resolveOpenIdFromSession(oauthSessionToken, orderId);
    const { attempt, reusedCredential } = await this.claimAttempt(
      orderId,
      'jsapi',
      authorized.order,
      authorized.accessTokenHash,
      row.keyVersion,
      config.mchId,
    );
    if (reusedCredential) {
      const payload = attempt.payload as Record<string, unknown>;
      const prepayId = String(payload.prepayId);
      return {
        orderId,
        channel: 'jsapi',
        attemptId: attempt.id,
        outTradeNo: attempt.outTradeNo!,
        expiresAt: authorized.order.expiresAt.toISOString(),
        jsapiParams: this.buildJsapiParams(prepayId, config, credentials),
      };
    }
    const outTradeNo = attempt.outTradeNo!;
    try {
      const result = await this.request(
        'POST',
        '/v3/pay/transactions/jsapi',
        {
          appid: config.appId,
          mchid: config.mchId,
          description: authorized.eventName.slice(0, 127),
          out_trade_no: outTradeNo,
          time_expire: authorized.order.expiresAt.toISOString(),
          notify_url: this.notifyUrl(authorized.order.organizationId),
          amount: {
            total: authorized.order.amount,
            currency: authorized.order.currency,
          },
          payer: { openid },
        },
        config,
        credentials,
      );
      const prepayId = typeof result.prepay_id === 'string' ? result.prepay_id : '';
      if (!prepayId) {
        await this.markAttemptFailed(attempt.id, '微信支付未返回 prepay_id');
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '微信支付未返回 prepay_id',
          HttpStatus.BAD_GATEWAY,
        );
      }
      const now = new Date();
      await this.db()
        .update(payments)
        .set({
          status: 'pending',
          preparedAt: now,
          prepayExpiresAt: authorized.order.expiresAt,
          payload: {
            prepayId,
            preparedAt: now.toISOString(),
            outTradeNo,
          },
          updatedAt: now,
        })
        .where(eq(payments.id, attempt.id));
      return {
        orderId,
        channel: 'jsapi',
        attemptId: attempt.id,
        outTradeNo,
        expiresAt: authorized.order.expiresAt.toISOString(),
        jsapiParams: this.buildJsapiParams(prepayId, config, credentials),
      };
    } catch (error) {
      if (error instanceof DomainError && error.getStatus() === HttpStatus.BAD_GATEWAY) {
        const message = error.message;
        if (message.includes('暂时无法连接')) {
          await this.markAttemptUnknown(attempt.id, message);
        } else {
          await this.markAttemptFailed(attempt.id, message);
        }
      }
      throw error;
    }
  }

  /**
   * Prepares an H5 payment attempt with server-fixed redirect_url.
   *
   * @param orderId - Order UUID.
   * @param accessToken - Bearer order access token.
   * @param clientIp - Trusted payer client IP.
   * @returns H5 prepare result.
   */
  async prepareH5Payment(
    orderId: string,
    accessToken: string,
    clientIp: string,
  ): Promise<WeChatH5Payment> {
    if (!isUsableClientIp(clientIp)) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'H5 支付需要有效的客户端 IP',
        HttpStatus.BAD_REQUEST,
      );
    }
    const authorized = await this.authorizeOrder(orderId, accessToken);
    const { row, config, credentials } = await this.requiredIntegration(
      authorized.order.organizationId,
      { requireVerified: true },
    );
    this.assertChannelEnabled(config, 'h5');
    const redirectUrl = h5RedirectUrl(orderId);
    const { attempt, reusedCredential } = await this.claimAttempt(
      orderId,
      'h5',
      authorized.order,
      authorized.accessTokenHash,
      row.keyVersion,
      config.mchId,
    );
    if (reusedCredential) {
      const payload = attempt.payload as Record<string, unknown>;
      return {
        orderId,
        channel: 'h5',
        attemptId: attempt.id,
        outTradeNo: attempt.outTradeNo!,
        h5Url: String(payload.h5Url),
        expiresAt: authorized.order.expiresAt.toISOString(),
        redirectUrl,
      };
    }
    const outTradeNo = attempt.outTradeNo!;
    try {
      const result = await this.request(
        'POST',
        '/v3/pay/transactions/h5',
        {
          appid: config.appId,
          mchid: config.mchId,
          description: authorized.eventName.slice(0, 127),
          out_trade_no: outTradeNo,
          time_expire: authorized.order.expiresAt.toISOString(),
          notify_url: this.notifyUrl(authorized.order.organizationId),
          amount: {
            total: authorized.order.amount,
            currency: authorized.order.currency,
          },
          scene_info: {
            payer_client_ip: clientIp.trim(),
            h5_info: {
              type: 'Wap',
            },
          },
        },
        config,
        credentials,
      );
      const rawH5Url = typeof result.h5_url === 'string' ? result.h5_url : '';
      if (!rawH5Url) {
        await this.markAttemptFailed(attempt.id, '微信支付未返回 h5_url');
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '微信支付未返回 h5_url',
          HttpStatus.BAD_GATEWAY,
        );
      }
      const h5Url = appendH5RedirectUrl(rawH5Url, redirectUrl);
      const now = new Date();
      await this.db()
        .update(payments)
        .set({
          status: 'pending',
          preparedAt: now,
          prepayExpiresAt: authorized.order.expiresAt,
          payload: {
            h5Url,
            redirectUrl,
            preparedAt: now.toISOString(),
            outTradeNo,
          },
          updatedAt: now,
        })
        .where(eq(payments.id, attempt.id));
      return {
        orderId,
        channel: 'h5',
        attemptId: attempt.id,
        outTradeNo,
        h5Url,
        expiresAt: authorized.order.expiresAt.toISOString(),
        redirectUrl,
      };
    } catch (error) {
      if (error instanceof DomainError && error.getStatus() === HttpStatus.BAD_GATEWAY) {
        const message = error.message;
        if (message.includes('暂时无法连接')) {
          await this.markAttemptUnknown(attempt.id, message);
        } else {
          await this.markAttemptFailed(attempt.id, message);
        }
      }
      throw error;
    }
  }

  /**
   * Queries WeChat for the active attempt and returns success details when paid.
   *
   * @param orderId - Order UUID.
   * @param accessToken - Bearer order access token.
   * @param options - Optional force flag to bypass the background query throttle.
   * @returns Success payload when trade_state is SUCCESS; otherwise undefined.
   */
  async queryPayment(
    orderId: string,
    accessToken: string,
    options: { force?: boolean } = {},
  ): Promise<QueryPaymentSuccess | undefined> {
    const accessTokenHash = createHash('sha256').update(accessToken).digest('hex');
    const [row] = await this.db()
      .select({
        order: orders,
        tokenScopes: orderAccessTokens.scopes,
      })
      .from(orders)
      .innerJoin(
        orderAccessTokens,
        and(
          eq(orderAccessTokens.orderId, orders.id),
          eq(orderAccessTokens.tokenHash, accessTokenHash),
          isNull(orderAccessTokens.revokedAt),
          gt(orderAccessTokens.expiresAt, new Date()),
        ),
      )
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!row || !row.tokenScopes.includes('order:read')) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '订单访问链接无效或已经过期',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (!['pending_payment', 'processing'].includes(row.order.status)) return undefined;

    const attempt = await this.findActiveAttempt(orderId);
    if (!attempt?.outTradeNo) return undefined;

    const queryGapMs = options.force ? FORCE_QUERY_COALESCE_MS : QUERY_THROTTLE_MS;
    const queryCutoff = new Date(Date.now() - queryGapMs);
    const queryClaimedAt = new Date();
    const [claimedAttempt] = await this.db()
      .update(payments)
      .set({
        lastQueriedAt: queryClaimedAt,
        queryCount: sql`${payments.queryCount} + 1`,
        status: attempt.status === 'pending' ? 'query_pending' : attempt.status,
        updatedAt: queryClaimedAt,
      })
      .where(
        and(
          eq(payments.id, attempt.id),
          eq(payments.status, attempt.status),
          or(isNull(payments.lastQueriedAt), lt(payments.lastQueriedAt, queryCutoff)),
        ),
      )
      .returning();
    if (!claimedAttempt) return undefined;

    const { config, credentials } = await this.requiredIntegration(row.order.organizationId, {
      requireVerified: true,
    });
    const result = (await this.request(
      'GET',
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(attempt.outTradeNo)}?mchid=${encodeURIComponent(config.mchId)}`,
      undefined,
      config,
      credentials,
    )) as unknown as WeChatTransaction;

    await this.db()
      .update(payments)
      .set({
        wechatTradeState: result.trade_state,
        status:
          result.trade_state === 'SUCCESS'
            ? 'processing'
            : result.trade_state === 'CLOSED'
              ? 'closed'
              : result.trade_state === 'USERPAYING'
                ? 'query_pending'
                : claimedAttempt.status === 'query_pending'
                  ? 'pending'
                  : claimedAttempt.status,
        closedAt: result.trade_state === 'CLOSED' ? new Date() : claimedAttempt.closedAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(payments.id, claimedAttempt.id),
          eq(payments.status, claimedAttempt.status),
          eq(payments.lastQueriedAt, claimedAttempt.lastQueriedAt!),
        ),
      );

    if (result.trade_state !== 'SUCCESS') {
      return undefined;
    }

    const occurredAt = result.success_time ? new Date(result.success_time) : undefined;
    if (
      result.appid !== config.appId ||
      result.mchid !== config.mchId ||
      result.out_trade_no !== attempt.outTradeNo ||
      !result.transaction_id ||
      !occurredAt ||
      Number.isNaN(occurredAt.getTime()) ||
      result.amount?.total !== row.order.amount ||
      result.amount?.currency !== row.order.currency
    ) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '微信支付查单结果与本地订单不一致',
        HttpStatus.BAD_GATEWAY,
      );
    }

    return {
      orderId,
      paymentId: attempt.id,
      outTradeNo: attempt.outTradeNo,
      externalId: result.transaction_id,
      amount: result.amount!.total,
      currency: result.amount!.currency,
      occurredAt: occurredAt.toISOString(),
      tradeState: 'SUCCESS',
    };
  }

  /**
   * Compatibility alias for {@link queryPayment}.
   *
   * @param orderId - Order UUID.
   * @param accessToken - Bearer order access token.
   * @returns Success payload when paid.
   */
  async queryNativePayment(orderId: string, accessToken: string) {
    return this.queryPayment(orderId, accessToken);
  }

  /**
   * Closes a WeChat transaction for the given merchant out_trade_no.
   *
   * @param outTradeNo - Merchant trade number.
   * @param config - Public merchant configuration.
   * @param credentials - Signing credentials.
   */
  private async closeWeChatOrder(
    outTradeNo: string,
    config: PublicConfig,
    credentials: Credentials,
  ) {
    await this.request(
      'POST',
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`,
      { mchid: config.mchId },
      config,
      credentials,
    );
  }

  /**
   * Queries WeChat trade state for an out_trade_no without order-token auth.
   *
   * @param outTradeNo - Merchant trade number.
   * @param organizationId - Tenant organization UUID.
   * @returns Parsed WeChat transaction.
   */
  private async queryWeChatTransaction(outTradeNo: string, organizationId: string) {
    const { config, credentials } = await this.requiredIntegration(organizationId, {
      requireVerified: true,
    });
    return (await this.request(
      'GET',
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.mchId)}`,
      undefined,
      config,
      credentials,
    )) as unknown as WeChatTransaction;
  }

  /**
   * Closes the active attempt after confirming WeChat CLOSED state.
   *
   * @param orderId - Order UUID.
   * @param accessToken - Bearer order access token.
   * @returns Closed attempt id when an attempt was closed.
   */
  async closeAttempt(orderId: string, accessToken: string) {
    const authorized = await this.authorizeOrder(orderId, accessToken);
    return this.closeActiveAttemptLocked(authorized);
  }

  /**
   * Marks the active attempt close_pending under an advisory lock.
   *
   * @param orderId - Order UUID.
   * @returns Active attempt snapshot or undefined when none.
   */
  private async beginCloseAttempt(orderId: string) {
    return this.db().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`wechatpay:switch:${orderId}`}, 0))`,
      );
      const [attempt] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.orderId, orderId),
            eq(payments.provider, PROVIDER),
            inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES]),
          ),
        )
        .limit(1);
      if (!attempt?.outTradeNo) return undefined;
      if (
        attempt.status === 'close_pending' &&
        Date.now() - attempt.updatedAt.getTime() < PAYMENT_CLOSE_LEASE_MS
      ) {
        return { busy: true as const };
      }
      const claimedAt = new Date();
      const [updated] = await tx
        .update(payments)
        .set({ status: 'close_pending', updatedAt: claimedAt })
        .where(and(eq(payments.id, attempt.id), eq(payments.status, attempt.status)))
        .returning();
      return updated ?? { busy: true as const };
    });
  }

  /**
   * Finalizes attempt status after WeChat close/query coordination.
   *
   * @param attempt - Claimed payment attempt snapshot.
   * @param patch - Status fields to persist.
   */
  private async finalizeAttemptStatus(
    attempt: PaymentAttempt,
    patch: {
      status: PaymentAttempt['status'];
      wechatTradeState?: string;
      closedAt?: Date;
      payload?: Record<string, unknown>;
    },
  ) {
    const [updated] = await this.db()
      .update(payments)
      .set({
        status: patch.status,
        wechatTradeState: patch.wechatTradeState,
        closedAt: patch.closedAt,
        ...(patch.payload ? { payload: patch.payload } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(payments.id, attempt.id),
          eq(payments.status, 'close_pending'),
          eq(payments.updatedAt, attempt.updatedAt),
        ),
      )
      .returning({ id: payments.id });
    if (!updated) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '微信支付状态协调租约已经变化，请稍后重试',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * Internal close flow: lock → query → close → confirm CLOSED (HTTP outside DB tx).
   *
   * @param authorized - Authorized order context.
   * @returns Closed attempt metadata or paid result that must be confirmed.
   */
  private async closeActiveAttemptLocked(authorized: AuthorizedOrder): Promise<{
    closed: boolean;
    paid?: QueryPaymentSuccess;
    attemptId?: string;
  }> {
    const orderId = authorized.order.id;
    const attempt = await this.beginCloseAttempt(orderId);
    if (attempt && 'busy' in attempt) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '微信支付状态正在协调，请稍后重试',
        HttpStatus.CONFLICT,
      );
    }
    if (!attempt?.outTradeNo) {
      return { closed: true };
    }

    const toPaid = (transaction: WeChatTransaction): QueryPaymentSuccess => ({
      orderId,
      paymentId: attempt.id,
      outTradeNo: attempt.outTradeNo!,
      externalId: transaction.transaction_id!,
      amount: transaction.amount!.total,
      currency: transaction.amount!.currency,
      occurredAt: (transaction.success_time
        ? new Date(transaction.success_time)
        : new Date()
      ).toISOString(),
      tradeState: 'SUCCESS',
    });

    let transaction: WeChatTransaction;
    try {
      transaction = await this.queryWeChatTransaction(
        attempt.outTradeNo,
        authorized.order.organizationId,
      );
    } catch (error) {
      await this.finalizeAttemptStatus(attempt, {
        status: 'unknown',
        wechatTradeState: 'UNKNOWN',
        payload: {
          ...(typeof attempt.payload === 'object' ? attempt.payload : {}),
          queryError: error instanceof Error ? error.message.slice(0, 500) : 'query failed',
        },
      });
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '查询微信支付订单失败，请稍后重试',
        HttpStatus.CONFLICT,
      );
    }

    if (transaction.trade_state === 'SUCCESS' && transaction.transaction_id) {
      return { closed: false, paid: toPaid(transaction) };
    }

    if (transaction.trade_state === 'USERPAYING') {
      await this.finalizeAttemptStatus(attempt, {
        status: 'query_pending',
        wechatTradeState: 'USERPAYING',
      });
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '用户正在支付中，请稍后查询结果后再切换通道',
        HttpStatus.CONFLICT,
      );
    }

    if (transaction.trade_state !== 'CLOSED' && transaction.trade_state !== 'REVOKED') {
      const { config, credentials } = await this.requiredIntegration(
        authorized.order.organizationId,
        { requireVerified: true },
      );
      try {
        await this.closeWeChatOrder(attempt.outTradeNo, config, credentials);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.includes('ORDERPAID') || message.includes('ORDER_PAID')) {
          const paidTx = await this.queryWeChatTransaction(
            attempt.outTradeNo,
            authorized.order.organizationId,
          );
          if (paidTx.trade_state === 'SUCCESS' && paidTx.transaction_id) {
            return { closed: false, paid: toPaid(paidTx) };
          }
        }
        await this.finalizeAttemptStatus(attempt, {
          status: 'unknown',
          wechatTradeState: transaction.trade_state,
          payload: {
            ...(typeof attempt.payload === 'object' ? attempt.payload : {}),
            closeError: message.slice(0, 500),
          },
        });
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '关闭微信支付订单失败，请稍后重试',
          HttpStatus.CONFLICT,
        );
      }

      const confirmed = await this.queryWeChatTransaction(
        attempt.outTradeNo,
        authorized.order.organizationId,
      );
      if (confirmed.trade_state === 'SUCCESS' && confirmed.transaction_id) {
        return { closed: false, paid: toPaid(confirmed) };
      }
      if (confirmed.trade_state !== 'CLOSED' && confirmed.trade_state !== 'REVOKED') {
        await this.finalizeAttemptStatus(attempt, {
          status: 'unknown',
          wechatTradeState: confirmed.trade_state,
        });
        throw new DomainError(
          API_ERROR_CODES.INVALID_STATE_TRANSITION,
          '微信支付订单尚未确认关闭，请稍后重试',
          HttpStatus.CONFLICT,
        );
      }
    }

    const now = new Date();
    await this.finalizeAttemptStatus(attempt, {
      status: 'closed',
      wechatTradeState: 'CLOSED',
      closedAt: now,
    });
    return { closed: true, attemptId: attempt.id };
  }

  /**
   * Switches the payment channel after safely closing any active attempt.
   *
   * @param orderId - Order UUID.
   * @param accessToken - Bearer order access token.
   * @param channel - Target channel.
   * @param options - Optional OAuth session and client IP for the target channel.
   * @returns Either a paid confirmation payload or a fresh prepare result.
   */
  async switchChannel(
    orderId: string,
    accessToken: string,
    channel: WeChatPaymentChannel,
    options: { oauthSessionToken?: string; clientIp?: string } = {},
  ): Promise<
    | { paid: true; payment: QueryPaymentSuccess }
    | { paid: false; payment: WeChatPaymentPrepareResult }
  > {
    const authorized = await this.authorizeOrder(orderId, accessToken);
    const { config } = await this.requiredIntegration(authorized.order.organizationId, {
      requireVerified: true,
    });
    this.assertChannelEnabled(config, channel);

    const closeResult = await this.closeActiveAttemptLocked(authorized);
    if (closeResult.paid) {
      return { paid: true, payment: closeResult.paid };
    }

    if (channel === 'native') {
      return {
        paid: false,
        payment: await this.prepareNativePayment(orderId, accessToken),
      };
    }
    if (channel === 'jsapi') {
      if (!options.oauthSessionToken) {
        throw new DomainError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'JSAPI 支付需要有效的微信授权会话',
          HttpStatus.BAD_REQUEST,
        );
      }
      return {
        paid: false,
        payment: await this.prepareJsapiPayment(orderId, accessToken, options.oauthSessionToken),
      };
    }
    if (!options.clientIp) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'H5 支付需要可信客户端 IP',
        HttpStatus.BAD_REQUEST,
      );
    }
    return {
      paid: false,
      payment: await this.prepareH5Payment(orderId, accessToken, options.clientIp),
    };
  }

  /**
   * Starts snsapi_base OAuth and returns the WeChat authorize URL.
   *
   * @param orderId - Order UUID.
   * @param accessToken - Bearer order access token.
   * @param _returnPath - Legacy client hint; redirects are pinned to the authorized order page.
   * @returns Authorize URL and state expiry.
   */
  async startOAuth(
    orderId: string,
    accessToken: string,
    _returnPath = `/order/${orderId}`,
  ): Promise<WeChatOAuthStart> {
    const authorized = await this.authorizeOrder(orderId, accessToken);
    const { config, credentials } = await this.requiredIntegration(
      authorized.order.organizationId,
      { requireVerified: true, requireAppSecret: true },
    );
    if (!config.oauthEnabled || !config.channels.jsapi) {
      throw new DomainError(
        API_ERROR_CODES.FORBIDDEN,
        '微信 OAuth / JSAPI 尚未启用',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!credentials.appSecret) {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '公众号 AppSecret 尚未配置',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const normalizedReturn = `/order/${orderId}`;
    const state = randomBytes(24).toString('base64url');
    const ttl = Math.min(
      OAUTH_STATE_TTL_SECONDS,
      Math.max(60, Math.floor((authorized.order.expiresAt.getTime() - Date.now()) / 1000)),
    );
    const record: OAuthStateRecord = {
      orderId,
      organizationId: authorized.order.organizationId,
      accessTokenHash: authorized.accessTokenHash,
      returnPath: normalizedReturn,
    };
    await this.redisClient().set(
      `${REDIS_PREFIX}oauth:state:${state}`,
      JSON.stringify(record),
      'EX',
      ttl,
    );
    const redirectUri = encodeURIComponent(oauthRedirectUri());
    const authorizeUrl =
      `${WECHAT_OAUTH_AUTHORIZE}?appid=${encodeURIComponent(config.appId)}` +
      `&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_base` +
      `&state=${encodeURIComponent(state)}#wechat_redirect`;
    return {
      authorizeUrl,
      stateExpiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  /**
   * Consumes the WeChat OAuth callback, stores openid in Redis, and returns a handoff redirect.
   *
   * @param code - Temporary OAuth code from WeChat.
   * @param state - One-time state issued by {@link startOAuth}.
   * @returns Absolute Location URL with fragment handoff (no openid).
   */
  async consumeOAuthCallback(
    code: string,
    state: string,
  ): Promise<{ redirectUrl: string; orderId: string }> {
    if (!code || !state || code.length > 200 || state.length > 200) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '微信授权回调参数无效',
        HttpStatus.BAD_REQUEST,
      );
    }
    const stateKey = `${REDIS_PREFIX}oauth:state:${state}`;
    const raw = await this.redisClient().get(stateKey);
    if (!raw) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '微信授权状态无效或已过期',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.redisClient().del(stateKey);
    let stateRecord: OAuthStateRecord;
    try {
      stateRecord = JSON.parse(raw) as OAuthStateRecord;
    } catch {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '微信授权状态无效',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const { config, credentials } = await this.requiredIntegration(stateRecord.organizationId, {
      requireVerified: true,
      requireAppSecret: true,
    });
    const tokenUrl =
      `${WECHAT_OAUTH_TOKEN}?appid=${encodeURIComponent(config.appId)}` +
      `&secret=${encodeURIComponent(credentials.appSecret!)}` +
      `&code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(tokenUrl, { signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new DomainError(
        API_ERROR_CODES.INVALID_STATE_TRANSITION,
        '暂时无法完成微信授权，请稍后重试',
        HttpStatus.BAD_GATEWAY,
      );
    }
    const tokenBody = (await tokenResponse.json()) as {
      openid?: string;
      errcode?: number;
      errmsg?: string;
    };
    if (!tokenBody.openid || tokenBody.errcode) {
      this.logger.warn(
        `WeChat OAuth token exchange failed for order ${stateRecord.orderId} errcode=${tokenBody.errcode ?? 'n/a'}`,
      );
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '微信授权失败，请重新发起授权',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const sessionToken = randomBytes(32).toString('base64url');
    const handoffCode = randomBytes(24).toString('base64url');
    const session: OAuthSessionRecord = {
      orderId: stateRecord.orderId,
      organizationId: stateRecord.organizationId,
      openid: tokenBody.openid,
    };
    const redis = this.redisClient();
    await redis.set(
      `${REDIS_PREFIX}oauth:session:${sessionToken}`,
      JSON.stringify(session),
      'EX',
      OAUTH_SESSION_TTL_SECONDS,
    );
    await redis.set(
      `${REDIS_PREFIX}oauth:handoff:${handoffCode}`,
      JSON.stringify({
        sessionToken,
        orderId: stateRecord.orderId,
        expiresAt: new Date(Date.now() + OAUTH_SESSION_TTL_SECONDS * 1000).toISOString(),
      }),
      'EX',
      OAUTH_HANDOFF_TTL_SECONDS,
    );
    const returnPath = `/order/${stateRecord.orderId}`;
    const base = resolvePaymentPublicUrl(returnPath);
    const separator = base.includes('#') ? '&' : '#';
    return {
      redirectUrl: `${base}${separator}handoff=${encodeURIComponent(handoffCode)}`,
      orderId: stateRecord.orderId,
    };
  }

  /**
   * Exchanges a one-time fragment handoff code for an OAuth session token.
   *
   * @param handoffCode - One-time handoff from the OAuth callback fragment.
   * @returns Session token bound to the order (never includes openid).
   */
  async exchangeHandoff(handoffCode: string): Promise<WeChatOAuthSession> {
    if (!handoffCode || handoffCode.length < 16 || handoffCode.length > 128) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '授权交接码无效',
        HttpStatus.BAD_REQUEST,
      );
    }
    const key = `${REDIS_PREFIX}oauth:handoff:${handoffCode}`;
    const raw = await this.redisClient().get(key);
    if (!raw) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '授权交接码无效或已使用',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.redisClient().del(key);
    const parsed = JSON.parse(raw) as {
      sessionToken: string;
      orderId: string;
      expiresAt: string;
    };
    return {
      sessionToken: parsed.sessionToken,
      expiresAt: parsed.expiresAt,
      orderId: parsed.orderId,
    };
  }

  /**
   * Resolves openid from a Redis OAuth session bound to the given order.
   * openid is never logged or returned to callers outside this service.
   *
   * @param sessionToken - Server-issued session token.
   * @param orderId - Expected order UUID.
   * @returns WeChat openid for JSAPI payer.
   */
  async resolveOpenIdFromSession(sessionToken: string, orderId: string) {
    if (!sessionToken || sessionToken.length < 16 || sessionToken.length > 200) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '微信授权会话无效',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const raw = await this.redisClient().get(`${REDIS_PREFIX}oauth:session:${sessionToken}`);
    if (!raw) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '微信授权会话无效或已过期',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const session = JSON.parse(raw) as OAuthSessionRecord;
    if (session.orderId !== orderId || !session.openid) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '微信授权会话与订单不匹配',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return session.openid;
  }

  /**
   * Verifies, decrypts, and persists a WeChat payment notification into the inbox.
   *
   * @param organizationId - Tenant organization UUID from the notify path.
   * @param rawBody - Raw HTTP body buffer.
   * @param headers - WeChat signature headers.
   * @returns Parsed notification ready for async confirmation.
   */
  async parseNotification(
    organizationId: string,
    rawBody: Buffer,
    headers: {
      timestamp: string | undefined;
      nonce: string | undefined;
      signature: string | undefined;
      serial: string | undefined;
    },
  ): Promise<ParsedPaymentNotification> {
    const { config, credentials } = await this.requiredIntegration(organizationId, {
      requireVerified: true,
    });
    const timestamp = Number(headers.timestamp);
    if (
      !headers.timestamp ||
      !Number.isFinite(timestamp) ||
      Math.abs(Date.now() / 1000 - timestamp) > 300 ||
      headers.serial !== config.platformPublicKeyId
    ) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '微信支付回调时间戳或公钥标识无效',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headers.timestamp}\n${headers.nonce ?? ''}\n${rawBody.toString('utf8')}\n`);
    verifier.end();
    if (
      !headers.signature ||
      !verifier.verify(credentials.platformPublicKey, headers.signature, 'base64')
    ) {
      throw new DomainError(
        API_ERROR_CODES.UNAUTHORIZED,
        '微信支付回调签名校验失败',
        HttpStatus.UNAUTHORIZED,
      );
    }
    let notification: WeChatNotification;
    try {
      notification = JSON.parse(rawBody.toString('utf8')) as WeChatNotification;
    } catch {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '微信支付回调不是有效的 JSON',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      notification.event_type !== 'TRANSACTION.SUCCESS' ||
      notification.resource?.algorithm !== 'AEAD_AES_256_GCM'
    ) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '微信支付回调事件类型不受支持',
        HttpStatus.BAD_REQUEST,
      );
    }

    const [existingInbox] = await this.db()
      .select()
      .from(paymentNotificationInbox)
      .where(eq(paymentNotificationInbox.notificationId, notification.id))
      .limit(1);
    if (existingInbox?.status === 'processed') {
      return {
        inboxId: existingInbox.id,
        notificationId: notification.id,
        organizationId,
        orderId: existingInbox.orderId!,
        ...(existingInbox.paymentId
          ? { paymentId: existingInbox.paymentId, attemptId: existingInbox.paymentId }
          : {}),
        outTradeNo: existingInbox.outTradeNo,
        externalId: String((existingInbox.payload as Record<string, unknown>).externalId ?? ''),
        amount: Number((existingInbox.payload as Record<string, unknown>).amount ?? 0),
        currency: String((existingInbox.payload as Record<string, unknown>).currency ?? 'CNY'),
        occurredAt: String(
          (existingInbox.payload as Record<string, unknown>).occurredAt ?? new Date().toISOString(),
        ),
        alreadyProcessed: true,
        alreadyReceived: true,
      };
    }

    let transaction: WeChatTransaction;
    try {
      const ciphertext = Buffer.from(notification.resource.ciphertext, 'base64');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(credentials.apiV3Key, 'utf8'),
        Buffer.from(notification.resource.nonce, 'utf8'),
      );
      decipher.setAAD(Buffer.from(notification.resource.associated_data ?? '', 'utf8'));
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const plaintext = Buffer.concat([
        decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
        decipher.final(),
      ]);
      transaction = JSON.parse(plaintext.toString('utf8')) as WeChatTransaction;
      if (
        transaction.appid !== config.appId ||
        transaction.mchid !== config.mchId ||
        transaction.trade_state !== 'SUCCESS' ||
        !transaction.transaction_id ||
        !transaction.out_trade_no
      ) {
        throw new Error('Unexpected transaction payload');
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '微信支付回调内容无法解密或与订单不匹配',
        HttpStatus.BAD_REQUEST,
      );
    }

    const [payment] = await this.db()
      .select()
      .from(payments)
      .where(eq(payments.outTradeNo, transaction.out_trade_no))
      .limit(1);

    let order = payment
      ? (await this.db().select().from(orders).where(eq(orders.id, payment.orderId)).limit(1))[0]
      : undefined;
    if (!order) {
      // Legacy Native attempts used orderNo as out_trade_no.
      const [legacy] = await this.db()
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.organizationId, organizationId),
            eq(orders.orderNo, transaction.out_trade_no),
          ),
        )
        .limit(1);
      order = legacy;
    }
    if (
      !order ||
      order.organizationId !== organizationId ||
      order.amount !== transaction.amount?.total ||
      order.currency !== transaction.amount?.currency
    ) {
      throw new DomainError(
        API_ERROR_CODES.VALIDATION_ERROR,
        '微信支付回调内容无法解密或与订单不匹配',
        HttpStatus.BAD_REQUEST,
      );
    }

    const occurredAt = transaction.success_time ?? new Date().toISOString();
    const payload = {
      externalId: transaction.transaction_id,
      amount: transaction.amount!.total,
      currency: transaction.amount!.currency,
      occurredAt,
      tradeState: transaction.trade_state,
      rawEventType: notification.event_type,
    };

    let inboxId = existingInbox?.id;
    if (!existingInbox) {
      try {
        const [inserted] = await this.db()
          .insert(paymentNotificationInbox)
          .values({
            organizationId,
            notificationId: notification.id,
            outTradeNo: transaction.out_trade_no,
            paymentId: payment?.id,
            orderId: order.id,
            eventType: notification.event_type,
            status: 'received',
            payload,
          })
          .returning({ id: paymentNotificationInbox.id });
        inboxId = inserted!.id;
      } catch {
        const [raced] = await this.db()
          .select()
          .from(paymentNotificationInbox)
          .where(eq(paymentNotificationInbox.notificationId, notification.id))
          .limit(1);
        if (!raced) {
          throw new DomainError(
            API_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            '通知入库冲突',
            HttpStatus.CONFLICT,
          );
        }
        inboxId = raced.id;
        if (raced.status === 'processed') {
          return {
            inboxId: raced.id,
            notificationId: notification.id,
            organizationId,
            orderId: raced.orderId!,
            ...(raced.paymentId ? { paymentId: raced.paymentId, attemptId: raced.paymentId } : {}),
            outTradeNo: raced.outTradeNo,
            externalId: String((raced.payload as Record<string, unknown>).externalId ?? ''),
            amount: Number((raced.payload as Record<string, unknown>).amount ?? 0),
            currency: String((raced.payload as Record<string, unknown>).currency ?? 'CNY'),
            occurredAt: String(
              (raced.payload as Record<string, unknown>).occurredAt ?? new Date().toISOString(),
            ),
            alreadyProcessed: true,
            alreadyReceived: true,
          };
        }
      }
    }

    return {
      inboxId: inboxId!,
      notificationId: notification.id,
      organizationId,
      orderId: order.id,
      ...(payment?.id ? { paymentId: payment.id, attemptId: payment.id } : {}),
      outTradeNo: transaction.out_trade_no,
      externalId: transaction.transaction_id!,
      amount: transaction.amount!.total,
      currency: transaction.amount!.currency,
      occurredAt,
      alreadyProcessed: false,
      alreadyReceived: Boolean(existingInbox),
    };
  }

  /**
   * Asynchronously confirms payment for a persisted notification inbox row.
   * Used by the HTTP notify path and the API maintenance reconciler.
   *
   * @param inboxId - payment_notification_inbox UUID.
   */
  async processPaymentNotificationAsync(inboxId: string) {
    if (!this.repository) {
      this.logger.error(`Cannot process notification ${inboxId}: ConferenceRepository missing`);
      return;
    }
    const staleCutoff = new Date(Date.now() - PAYMENT_INBOX_PROCESSING_LEASE_MS);
    const [inbox] = await this.db()
      .update(paymentNotificationInbox)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(
        and(
          eq(paymentNotificationInbox.id, inboxId),
          lt(paymentNotificationInbox.attemptCount, PAYMENT_INBOX_MAX_ATTEMPTS),
          retryablePaymentInbox(staleCutoff),
        ),
      )
      .returning();
    if (!inbox) return;

    const payload = inbox.payload as Record<string, unknown>;
    const externalId = String(payload.externalId ?? '');
    const amount = Number(payload.amount ?? 0);
    const currency = String(payload.currency ?? 'CNY');
    const occurredAt = String(payload.occurredAt ?? new Date().toISOString());
    if (!inbox.orderId || !externalId) {
      await this.db()
        .update(paymentNotificationInbox)
        .set({
          status: 'dead',
          lastError: 'Missing orderId or externalId',
          attemptCount: sql`${paymentNotificationInbox.attemptCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(paymentNotificationInbox.id, inboxId));
      return;
    }

    try {
      await this.repository.confirmPayment(inbox.orderId, `wechatpay:${externalId}`, {
        provider: PROVIDER,
        externalId,
        amount,
        currency,
        occurredAt,
        ...(inbox.paymentId ? { paymentId: inbox.paymentId } : {}),
        outTradeNo: inbox.outTradeNo,
        payload: {
          notificationId: inbox.notificationId,
          inboxId,
          occurredAt,
          receivedAt: new Date().toISOString(),
        },
        reason: '微信支付回调确认成功',
      });
      await this.db()
        .update(paymentNotificationInbox)
        .set({
          status: 'processed',
          processedAt: new Date(),
          attemptCount: sql`${paymentNotificationInbox.attemptCount} + 1`,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(paymentNotificationInbox.id, inboxId));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'confirm failed';
      const nextAttempts = inbox.attemptCount + 1;
      await this.db()
        .update(paymentNotificationInbox)
        .set({
          status: nextAttempts >= PAYMENT_INBOX_MAX_ATTEMPTS ? 'dead' : 'failed',
          lastError: message.slice(0, 500),
          attemptCount: nextAttempts,
          updatedAt: new Date(),
        })
        .where(eq(paymentNotificationInbox.id, inboxId));
      throw error;
    }
  }

  /**
   * Reclaims new, failed, and stale processing notification rows.
   *
   * @param limit - Maximum rows to schedule in one maintenance pass
   * @returns Number of candidate rows handed to the canonical confirmation path
   */
  async reconcilePaymentNotificationInbox(limit = 50) {
    const staleCutoff = new Date(Date.now() - PAYMENT_INBOX_PROCESSING_LEASE_MS);
    const candidates = await this.db()
      .select({ id: paymentNotificationInbox.id })
      .from(paymentNotificationInbox)
      .where(
        and(
          lt(paymentNotificationInbox.attemptCount, PAYMENT_INBOX_MAX_ATTEMPTS),
          retryablePaymentInbox(staleCutoff),
        ),
      )
      .orderBy(asc(paymentNotificationInbox.updatedAt))
      .limit(Math.min(Math.max(limit, 1), 100));

    for (const candidate of candidates) {
      try {
        await this.processPaymentNotificationAsync(candidate.id);
      } catch (error) {
        this.logger.error(
          `Payment inbox retry failed id=${candidate.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    return candidates.length;
  }

  /**
   * Queries and safely closes provider attempts whose local payment window expired.
   * Successful provider transactions are confirmed through ConferenceRepository.
   *
   * @param limit - Maximum attempts to reconcile in one maintenance pass
   * @returns Counts of closed and paid attempts
   */
  async reconcileExpiredPaymentAttempts(limit = 50) {
    if (!this.repository) return { closed: 0, paid: 0 };
    const now = new Date();
    const candidates = await this.db()
      .select({ attempt: payments, order: orders })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(
        and(
          eq(payments.provider, PROVIDER),
          inArray(payments.status, [...ACTIVE_WECHAT_PAYMENT_STATUSES]),
          sql`coalesce(${payments.prepayExpiresAt}, ${orders.expiresAt}) < ${now}`,
          lt(orders.expiresAt, now),
          inArray(orders.status, ['pending_payment', 'processing']),
        ),
      )
      .orderBy(asc(payments.updatedAt))
      .limit(Math.min(Math.max(limit, 1), 100));

    let closed = 0;
    let paid = 0;
    for (const candidate of candidates) {
      try {
        const result = await this.closeActiveAttemptLocked({
          order: candidate.order,
          eventName: '',
          accessTokenHash: '',
        });
        if (result.paid) {
          await this.repository.confirmPayment(
            result.paid.orderId,
            `wechatpay:${result.paid.externalId}`,
            {
              provider: PROVIDER,
              externalId: result.paid.externalId,
              amount: result.paid.amount,
              currency: result.paid.currency,
              occurredAt: result.paid.occurredAt,
              paymentId: result.paid.paymentId,
              outTradeNo: result.paid.outTradeNo,
              payload: {
                source: 'expired-attempt-reconciliation',
                outTradeNo: result.paid.outTradeNo,
                occurredAt: result.paid.occurredAt,
                receivedAt: new Date().toISOString(),
              },
              reason: '支付窗口结束时查单确认成功',
            },
          );
          paid += 1;
        } else if (result.closed) {
          closed += 1;
        }
      } catch (error) {
        this.logger.error(
          `Expired payment reconciliation failed id=${candidate.attempt.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    return { closed, paid };
  }
}

/** @internal Exported for unit tests. */
export const __wechatPayTestUtils = {
  generateOutTradeNo,
  appendH5RedirectUrl,
  isUsableClientIp,
  buildJsapiSignMessage,
};
