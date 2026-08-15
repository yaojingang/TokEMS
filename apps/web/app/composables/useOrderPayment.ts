import type {
  CustomerOrderAccess,
  Order,
  WeChatH5Payment,
  WeChatJsapiPayment,
  WeChatNativePayment,
  WeChatPaymentChannel,
  WeChatPaymentPrepareResult,
  WeChatPaymentSwitchResult,
} from '@conference/contracts';
import {
  captureOAuthHandoffFromUrl,
  captureOrderAccessTokenFromUrl,
  clearOrderAccessToken,
  readOrderAccessToken,
} from './useOrderAccessToken';
import {
  detectIPadDesktopMode,
  detectMobileExternalBrowser,
  readPaymentEnvironmentSignals,
  resolvePaymentChannel,
  type PaymentChannel,
  type PaymentEnvironmentSignals,
} from './usePaymentEnvironment';

const OAUTH_SESSION_PREFIX = 'conference.wechatOAuth.';
/** 待支付状态轮询间隔（PC 扫码与手机支付统一） */
const POLL_INTERVAL_MS = 1_000;
const BURST_POLL_DURATION_MS = 12_000;
/** 轮询期间强制向微信查单的最小间隔（绕过服务端 15s 节流） */
const FORCE_SYNC_GAP_MS = 3_000;
const PREPARE_BACKOFF_MS = 2_500;
const MAX_AUTO_PREPARE_RETRIES = 1;

export type OrderPaymentPhase =
  | 'idle'
  | 'authorizing'
  | 'preparing'
  | 'ready'
  | 'launching'
  | 'polling'
  | 'paid'
  | 'error'
  | 'expired'
  | 'closed';

export type WeixinPayInvokeResult = {
  err_msg?: string;
};

type WeixinJSBridgeLike = {
  invoke: (
    method: string,
    params: Record<string, string>,
    callback: (result: WeixinPayInvokeResult) => void,
  ) => void;
};

/**
 * Builds the sessionStorage key for a WeChat OAuth session token.
 *
 * @param orderId - Order identifier
 * @returns Storage key scoped to the order
 */
export function oauthSessionStorageKey(orderId: string): string {
  return `${OAUTH_SESSION_PREFIX}${orderId}`;
}

/**
 * Reads a persisted WeChat OAuth session token for an order.
 *
 * @param orderId - Order identifier
 * @returns Session token or empty string
 */
export function readOAuthSessionToken(orderId: string): string {
  if (!import.meta.client || !orderId) return '';
  try {
    return sessionStorage.getItem(oauthSessionStorageKey(orderId)) ?? '';
  } catch {
    return '';
  }
}

/**
 * Persists a WeChat OAuth session token for an order on the payment origin.
 *
 * @param orderId - Order identifier
 * @param token - Opaque OAuth session token from the API
 */
export function writeOAuthSessionToken(orderId: string, token: string): void {
  if (!import.meta.client || !orderId || !token) return;
  try {
    sessionStorage.setItem(oauthSessionStorageKey(orderId), token);
  } catch {
    // Private mode / quota failures should not break checkout.
  }
}

/**
 * Clears the persisted WeChat OAuth session token for an order.
 *
 * @param orderId - Order identifier
 */
export function clearOAuthSessionToken(orderId: string): void {
  if (!import.meta.client || !orderId) return;
  try {
    sessionStorage.removeItem(oauthSessionStorageKey(orderId));
  } catch {
    // Ignore storage failures.
  }
}

/**
 * Returns channels the user may manually switch to for the current environment.
 * WeChat in-app stays on JSAPI; iPad may fall back to H5; phone H5 may fall back to Native.
 *
 * @param signals - Browser capability signals
 * @param current - Currently selected channel
 * @returns Alternate channels available in the UI
 */
export function manualSwitchChannels(
  signals: PaymentEnvironmentSignals,
  current: PaymentChannel,
): PaymentChannel[] {
  if (current === 'jsapi') return [];
  if (detectIPadDesktopMode(signals)) {
    return (['native', 'h5'] as const).filter((channel) => channel !== current);
  }
  if (detectMobileExternalBrowser(signals)) {
    return (['h5', 'native'] as const).filter((channel) => channel !== current);
  }
  return [];
}

/**
 * Determines whether order status polling should run for the given order.
 *
 * @param order - Latest order snapshot
 * @returns True when the order is still awaiting payment confirmation
 */
export function shouldPollOrderStatus(order: Order | undefined | null): boolean {
  if (!order) return false;
  return ['pending_payment', 'processing'].includes(order.status);
}

export function shouldAutoPrepareWeChatPayment(
  order: Order | undefined | null,
  localSimulationAllowed: boolean,
): boolean {
  return Boolean(
    !localSimulationAllowed &&
      order?.paymentMethod === 'wechat' &&
      shouldPollOrderStatus(order),
  );
}

/**
 * Maps a WeixinJSBridge pay result into a stable UI message.
 *
 * @param result - Bridge callback payload
 * @returns Null on success / unknown; user-facing message on cancel or failure
 */
export function interpretWeixinPayResult(result: WeixinPayInvokeResult): string | null {
  const message = String(result.err_msg ?? '');
  if (!message || message.includes(':ok')) return null;
  if (message.includes(':cancel')) return '已取消支付，可再次点击调起微信支付。';
  return '微信支付未完成，请稍后重试或更换支付方式。';
}

/**
 * Extracts a human-readable API / network error message.
 *
 * @param error - Unknown thrown value
 * @param fallback - Fallback copy when the error lacks a message
 * @returns Stable user-facing error string
 */
export function paymentErrorMessage(error: unknown, fallback: string): string {
  const value = error as { data?: { message?: string }; statusMessage?: string };
  return (
    value?.data?.message ||
    (error instanceof Error ? error.message : '') ||
    value?.statusMessage ||
    fallback
  );
}

/**
 * Detects whether a failure looks like a transient network outage (no HTTP status).
 *
 * @param error - Unknown thrown value
 * @returns True when a limited auto-retry may be appropriate
 */
export function isTransientPaymentFailure(error: unknown): boolean {
  const failure = error as { response?: { status?: number }; statusCode?: number; status?: number };
  return !failure?.response?.status && !failure?.statusCode && !failure?.status;
}

/**
 * Narrows a channel-switch response that reports an already-paid order.
 *
 * @param result - Channel-switch response from the API
 * @returns True when the server confirmed payment during the switch
 */
export function isPaidSwitchResult(
  result: WeChatPaymentSwitchResult,
): result is { paid: true; orderId: string } {
  return 'paid' in result && result.paid === true;
}

/**
 * Waits until WeixinJSBridge is available in the WeChat in-app browser.
 *
 * @param timeoutMs - Maximum wait before rejecting
 * @returns Bridge instance
 */
export function waitForWeixinJSBridge(timeoutMs = 8_000): Promise<WeixinJSBridgeLike> {
  return new Promise((resolve, reject) => {
    if (!import.meta.client) {
      reject(new Error('WeixinJSBridge 仅在浏览器中可用'));
      return;
    }

    const existing = (window as Window & { WeixinJSBridge?: WeixinJSBridgeLike }).WeixinJSBridge;
    if (existing) {
      resolve(existing);
      return;
    }

    const timer = window.setTimeout(() => {
      document.removeEventListener('WeixinJSBridgeReady', onReady);
      reject(new Error('微信 JSBridge 未就绪，请在微信内重新打开本页'));
    }, timeoutMs);

    /**
     * Handles the WeixinJSBridgeReady DOM event.
     */
    function onReady() {
      window.clearTimeout(timer);
      document.removeEventListener('WeixinJSBridgeReady', onReady);
      const bridge = (window as Window & { WeixinJSBridge?: WeixinJSBridgeLike }).WeixinJSBridge;
      if (!bridge) {
        reject(new Error('微信 JSBridge 不可用'));
        return;
      }
      resolve(bridge);
    }

    document.addEventListener('WeixinJSBridgeReady', onReady, false);
  });
}

/**
 * Invokes WeChat JSAPI payment through WeixinJSBridge.
 *
 * @param params - Server-signed JSAPI parameters
 * @returns Bridge result payload
 */
export async function invokeWeixinJsapiPay(
  params: WeChatJsapiPayment['jsapiParams'],
): Promise<WeixinPayInvokeResult> {
  const bridge = await waitForWeixinJSBridge();
  return new Promise((resolve) => {
    bridge.invoke(
      'getBrandWCPayRequest',
      {
        appId: params.appId,
        timeStamp: params.timeStamp,
        nonceStr: params.nonceStr,
        package: params.package,
        signType: params.signType,
        paySign: params.paySign,
      },
      (result) => resolve(result ?? {}),
    );
  });
}

type UseOrderPaymentOptions = {
  orderId: string;
  eventSlug?: string;
  onPaid?: (order: CustomerOrderAccess) => void | Promise<void>;
};

/**
 * Orchestrates three-channel WeChat payment prepare, launch, polling, and cleanup.
 * Prepare failures stay in a stable error state; status polling never re-POSTs prepare.
 *
 * @param options - Order identity and optional paid callback
 * @returns Reactive payment state and control methods
 */
export function useOrderPayment(options: UseOrderPaymentOptions) {
  const api = useConferenceApi();
  const signals = shallowRef(readPaymentEnvironmentSignals());
  const channel = ref<PaymentChannel>(resolvePaymentChannel(signals.value));
  const phase = ref<OrderPaymentPhase>('idle');
  const preparing = ref(false);
  const launching = ref(false);
  const polling = ref(false);
  const errorMessage = ref('');
  const accessToken = ref('');
  const oauthSessionToken = ref('');
  const codeUrl = ref('');
  const h5Url = ref('');
  const jsapiParams = ref<WeChatJsapiPayment['jsapiParams'] | null>(null);
  const attemptId = ref('');
  const outTradeNo = ref('');
  const paymentExpiresAt = ref('');
  const order = ref<CustomerOrderAccess>();
  const pageVisible = ref(true);
  const autoPrepareRetries = ref(0);

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let prepareBackoffTimer: ReturnType<typeof setTimeout> | undefined;
  let burstUntilMs = 0;
  let lastForcedSyncAtMs = 0;
  let started = false;

  const switchOptions = computed(() => manualSwitchChannels(signals.value, channel.value));
  const canPay = computed(
    () =>
      Boolean(order.value) &&
      shouldPollOrderStatus(order.value) &&
      new Date(order.value!.expiresAt).getTime() > Date.now(),
  );

  /**
   * Applies a prepare API result to local channel payload state.
   *
   * @param result - Discriminated prepare payload from the API
   */
  function applyPrepareResult(result: WeChatPaymentPrepareResult) {
    channel.value = result.channel;
    attemptId.value = result.attemptId;
    outTradeNo.value = result.outTradeNo;
    paymentExpiresAt.value = result.expiresAt;
    codeUrl.value = '';
    h5Url.value = '';
    jsapiParams.value = null;

    if (result.channel === 'native') {
      codeUrl.value = result.codeUrl;
      if (order.value) order.value = { ...order.value, paymentUrl: result.codeUrl };
    } else if (result.channel === 'h5') {
      h5Url.value = result.h5Url;
    } else {
      jsapiParams.value = result.jsapiParams;
    }
    phase.value = 'ready';
  }

  /**
   * Clears prepared channel payloads without touching the access token.
   */
  function clearPreparedPayload() {
    codeUrl.value = '';
    h5Url.value = '';
    jsapiParams.value = null;
    attemptId.value = '';
    outTradeNo.value = '';
    paymentExpiresAt.value = '';
  }

  /**
   * Stops the status polling timer.
   */
  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
    polling.value = false;
  }

  /**
   * Schedules the next status poll tick.
   *
   * @param delayMs - Delay before the next tick
   */
  function scheduleNextPoll(delayMs: number) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      void runPollTick();
    }, delayMs);
  }

  /**
   * Runs one poll tick. Forces a WeChat sync about every FORCE_SYNC_GAP_MS so PC QR
   * watch and mobile return alike do not sit behind the server query throttle.
   */
  async function runPollTick() {
    pollTimer = undefined;
    if (!shouldPollOrderStatus(order.value) || !pageVisible.value) {
      polling.value = false;
      return;
    }

    const now = Date.now();
    // During the post-pay window, sync every tick; otherwise sync about every FORCE_SYNC_GAP_MS.
    const forceSync =
      now < burstUntilMs ||
      lastForcedSyncAtMs === 0 ||
      now - lastForcedSyncAtMs >= FORCE_SYNC_GAP_MS;
    if (forceSync) lastForcedSyncAtMs = now;

    await refreshOrderStatus({ sync: forceSync });
    if (!shouldPollOrderStatus(order.value) || !pageVisible.value) {
      polling.value = false;
      return;
    }

    polling.value = true;
    scheduleNextPoll(POLL_INTERVAL_MS);
  }

  /**
   * Starts status polling while the page is visible and the order is payable.
   * PC QR and mobile return share the same 1s cadence; `burst` only renews the force-sync window.
   *
   * @param options - Pass `burst: true` after JSAPI/H5 return to extend aggressive sync
   */
  function startPolling(options: { burst?: boolean } = {}) {
    if (!import.meta.client || !shouldPollOrderStatus(order.value) || !pageVisible.value) return;
    if (options.burst) {
      burstUntilMs = Date.now() + BURST_POLL_DURATION_MS;
      stopPolling();
    } else if (pollTimer || polling.value) {
      return;
    }
    polling.value = true;
    if (phase.value === 'ready' || phase.value === 'idle') phase.value = 'polling';
    // Kick immediately so PC QR pages do not wait a full interval before the first sync.
    void runPollTick();
  }

  /**
   * Cancels a pending limited prepare backoff retry.
   */
  function clearPrepareBackoff() {
    if (prepareBackoffTimer) {
      clearTimeout(prepareBackoffTimer);
      prepareBackoffTimer = undefined;
    }
  }

  /**
   * Ensures an OAuth session exists for JSAPI, starting WeChat authorize when needed.
   *
   * @returns True when a session token is ready for prepare
   */
  async function ensureOAuthSession(): Promise<boolean> {
    const existing = oauthSessionToken.value || readOAuthSessionToken(options.orderId);
    if (existing) {
      oauthSessionToken.value = existing;
      return true;
    }

    const handoff = captureOAuthHandoffFromUrl();
    if (handoff) {
      phase.value = 'authorizing';
      const session = await api.exchangeWeChatOAuthHandoff(handoff);
      writeOAuthSessionToken(options.orderId, session.sessionToken);
      oauthSessionToken.value = session.sessionToken;
      return true;
    }

    if (!accessToken.value) {
      throw new Error('订单访问凭证缺失，请从报名邮件或报名页重新进入支付。');
    }

    phase.value = 'authorizing';
    const returnPath = `/order/${encodeURIComponent(options.orderId)}${
      options.eventSlug ? `?event=${encodeURIComponent(options.eventSlug)}` : ''
    }`;
    const start = await api.startWeChatOAuth(options.orderId, accessToken.value, returnPath);
    window.location.assign(start.authorizeUrl);
    return false;
  }

  /**
   * Prepares a WeChat payment attempt for the active channel.
   * Does not start polling; callers control status queries separately.
   *
   * @param optionsOverride - Optional flags for retry behaviour
   */
  async function preparePayment(optionsOverride: { userInitiated?: boolean } = {}) {
    if (!order.value || !accessToken.value) return;
    if (!shouldPollOrderStatus(order.value)) return;
    if (preparing.value || launching.value) return;

    clearPrepareBackoff();
    if (optionsOverride.userInitiated) autoPrepareRetries.value = 0;

    preparing.value = true;
    errorMessage.value = '';
    phase.value = channel.value === 'jsapi' ? 'authorizing' : 'preparing';

    try {
      let result: WeChatPaymentPrepareResult;

      if (channel.value === 'jsapi') {
        const ready = await ensureOAuthSession();
        if (!ready) return;
        phase.value = 'preparing';
        result = await api.prepareWeChatJsapiPayment(
          options.orderId,
          accessToken.value,
          oauthSessionToken.value,
        );
      } else if (channel.value === 'h5') {
        result = await api.prepareWeChatH5Payment(options.orderId, accessToken.value);
      } else {
        result = await api.prepareWeChatNativePayment(options.orderId, accessToken.value);
      }

      applyPrepareResult(result);
      startPolling();
    } catch (error) {
      clearPreparedPayload();
      errorMessage.value = paymentErrorMessage(error, '微信支付准备失败，请稍后重试。');
      phase.value = 'error';

      if (
        !optionsOverride.userInitiated &&
        isTransientPaymentFailure(error) &&
        autoPrepareRetries.value < MAX_AUTO_PREPARE_RETRIES
      ) {
        autoPrepareRetries.value += 1;
        prepareBackoffTimer = setTimeout(() => {
          void preparePayment({ userInitiated: false });
        }, PREPARE_BACKOFF_MS);
      }
    } finally {
      preparing.value = false;
    }
  }

  /**
   * Queries order status only. Never re-POSTs prepare on failure or missing paymentUrl.
   *
   * @param refreshOptions - Pass `sync: true` to force a WeChat transaction query
   */
  async function refreshOrderStatus(refreshOptions: { sync?: boolean } = {}) {
    if (!accessToken.value) return;
    try {
      const latest = await api.getOrder(options.orderId, accessToken.value, {
        sync: refreshOptions.sync,
      });
      if (!latest) return;
      order.value = latest;

      if (latest.status === 'paid') {
        stopPolling();
        burstUntilMs = 0;
        phase.value = 'paid';
        errorMessage.value = '';
        await options.onPaid?.(latest);
        return;
      }

      if (latest.status === 'closed') {
        stopPolling();
        burstUntilMs = 0;
        phase.value = 'closed';
        return;
      }

      if (new Date(latest.expiresAt).getTime() <= Date.now()) {
        stopPolling();
        burstUntilMs = 0;
        phase.value = 'expired';
        return;
      }

      if (shouldPollOrderStatus(latest) && pageVisible.value && !pollTimer) {
        startPolling();
      }
    } catch {
      // Keep QR / ready state; user can tap “我已完成支付” to retry the query.
    }
  }

  /**
   * Launches the prepared channel: JSAPI bridge, H5 redirect, or no-op for Native QR.
   */
  async function launchPayment() {
    if (!canPay.value || preparing.value || launching.value) return;

    if (channel.value === 'native') {
      if (!codeUrl.value) await preparePayment({ userInitiated: true });
      return;
    }

    if (channel.value === 'h5') {
      if (!h5Url.value) {
        await preparePayment({ userInitiated: true });
      }
      if (!h5Url.value) return;
      launching.value = true;
      phase.value = 'launching';
      window.location.assign(h5Url.value);
      return;
    }

    // jsapi
    if (!jsapiParams.value) {
      await preparePayment({ userInitiated: true });
    }
    if (!jsapiParams.value) return;

    launching.value = true;
    phase.value = 'launching';
    errorMessage.value = '';
    try {
      const result = await invokeWeixinJsapiPay(jsapiParams.value);
      const message = interpretWeixinPayResult(result);
      if (message) {
        errorMessage.value = message;
        phase.value = 'ready';
      } else {
        phase.value = 'polling';
        await refreshOrderStatus({ sync: true });
        lastForcedSyncAtMs = Date.now();
        startPolling({ burst: true });
      }
    } catch (error) {
      errorMessage.value = paymentErrorMessage(error, '无法调起微信支付，请稍后重试。');
      phase.value = 'error';
    } finally {
      launching.value = false;
    }
  }

  /**
   * Switches payment channel via API, then prepares the new channel once.
   *
   * @param next - Target WeChat payment channel
   */
  async function switchChannel(next: WeChatPaymentChannel) {
    if (!accessToken.value || next === channel.value) return;
    if (!switchOptions.value.includes(next)) return;

    stopPolling();
    clearPrepareBackoff();
    preparing.value = true;
    errorMessage.value = '';
    phase.value = 'preparing';
    clearPreparedPayload();

    try {
      const result = await api.switchWeChatPaymentChannel(options.orderId, accessToken.value, next);
      if (isPaidSwitchResult(result)) {
        const paidOrder = order.value ? { ...order.value, status: 'paid' as const } : undefined;
        if (paidOrder) order.value = paidOrder;
        phase.value = 'paid';
        errorMessage.value = '';
        if (paidOrder) await options.onPaid?.(paidOrder);
        return;
      }
      applyPrepareResult(result);
      startPolling();
    } catch (error) {
      errorMessage.value = paymentErrorMessage(error, '切换支付方式失败，请稍后重试。');
      phase.value = 'error';
    } finally {
      preparing.value = false;
    }
  }

  /**
   * Handles pageshow / visibility / focus: pause when hidden; query once on return.
   */
  function handleVisibilityResume() {
    if (!import.meta.client) return;
    const visible = document.visibilityState !== 'hidden';
    pageVisible.value = visible;
    if (!visible) {
      stopPolling();
      return;
    }
    if (!shouldPollOrderStatus(order.value)) return;
    void refreshOrderStatus({ sync: true }).then(() => {
      lastForcedSyncAtMs = Date.now();
      if (shouldPollOrderStatus(order.value) && pageVisible.value) {
        startPolling({ burst: true });
      }
    });
  }

  /**
   * Handles bfcache pageshow events (e.g. return from WeChat / H5).
   *
   * @param event - PageTransitionEvent from pageshow
   */
  function handlePageShow(event: PageTransitionEvent) {
    if (event.persisted || document.visibilityState === 'visible') {
      handleVisibilityResume();
    }
  }

  /**
   * Bootstraps access token capture, order load, and initial prepare for payable orders.
   */
  async function start(startOptions: { localSimulationAllowed?: boolean } = {}) {
    if (!import.meta.client || started) return;
    started = true;

    signals.value = readPaymentEnvironmentSignals();
    channel.value = resolvePaymentChannel(signals.value);
    accessToken.value =
      captureOrderAccessTokenFromUrl(options.orderId) || readOrderAccessToken(options.orderId);
    oauthSessionToken.value = readOAuthSessionToken(options.orderId);

    document.addEventListener('visibilitychange', handleVisibilityResume);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('focus', handleVisibilityResume);

    if (!accessToken.value) {
      phase.value = 'error';
      errorMessage.value = '订单访问凭证缺失，请从报名成功页或邮件中的支付链接重新进入。';
      return;
    }

    try {
      const latest = await api.getOrder(options.orderId, accessToken.value);
      if (!latest) throw new Error('订单不存在或访问链接已经失效');
      order.value = latest;

      if (latest.status === 'paid') {
        phase.value = 'paid';
        await options.onPaid?.(latest);
        return;
      }
      if (latest.status === 'closed') {
        phase.value = 'closed';
        return;
      }
      if (new Date(latest.expiresAt).getTime() <= Date.now()) {
        phase.value = 'expired';
        return;
      }

      if (shouldAutoPrepareWeChatPayment(latest, startOptions.localSimulationAllowed === true)) {
        // Reuse a server-provided native code URL when already present.
        if (channel.value === 'native' && latest.paymentUrl) {
          codeUrl.value = latest.paymentUrl;
          phase.value = 'ready';
          startPolling();
        } else {
          await preparePayment({ userInitiated: false });
        }
      }
    } catch (error) {
      phase.value = 'error';
      errorMessage.value = paymentErrorMessage(error, '订单读取失败，请稍后重试。');
    }
  }

  /**
   * Tears down timers and listeners. Does not clear the access token (refresh-safe).
   */
  function cleanup() {
    stopPolling();
    clearPrepareBackoff();
    if (!import.meta.client) return;
    document.removeEventListener('visibilitychange', handleVisibilityResume);
    window.removeEventListener('pageshow', handlePageShow);
    window.removeEventListener('focus', handleVisibilityResume);
  }

  /**
   * Explicit user retry: reload order and prepare again.
   */
  async function retry() {
    errorMessage.value = '';
    autoPrepareRetries.value = 0;
    if (!accessToken.value) {
      accessToken.value = readOrderAccessToken(options.orderId);
    }
    if (!accessToken.value) {
      phase.value = 'error';
      errorMessage.value = '订单访问凭证缺失，请从报名页重新进入支付。';
      return;
    }
    await refreshOrderStatus();
    if (shouldPollOrderStatus(order.value)) {
      await preparePayment({ userInitiated: true });
    }
  }

  /**
   * Clears local OAuth + access material for this order (e.g. after security logout).
   */
  function clearLocalSecrets() {
    clearOrderAccessToken(options.orderId);
    clearOAuthSessionToken(options.orderId);
    accessToken.value = '';
    oauthSessionToken.value = '';
  }

  return {
    channel,
    phase,
    preparing,
    launching,
    polling,
    errorMessage,
    accessToken,
    codeUrl,
    h5Url,
    jsapiParams,
    attemptId,
    outTradeNo,
    paymentExpiresAt,
    order,
    switchOptions,
    canPay,
    start,
    cleanup,
    preparePayment,
    refreshOrderStatus,
    launchPayment,
    switchChannel,
    retry,
    clearLocalSecrets,
  };
}

export type { WeChatNativePayment, WeChatJsapiPayment, WeChatH5Payment };
