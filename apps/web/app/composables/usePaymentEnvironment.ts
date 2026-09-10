import type { WeChatPaymentChannel } from '@conference/contracts';

export type PaymentChannel = WeChatPaymentChannel;

/**
 * Browser capability signals used for payment channel selection.
 * Screen resolution must never appear here or influence the channel.
 */
export type PaymentEnvironmentSignals = {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentDataMobile?: boolean | null;
};

/**
 * Reads current browser environment signals without using viewport size.
 *
 * @returns Normalized capability signals for channel resolution
 */
export function readPaymentEnvironmentSignals(): PaymentEnvironmentSignals {
  if (typeof navigator === 'undefined') {
    return { userAgent: '' };
  }

  const userAgentData = (
    navigator as Navigator & {
      userAgentData?: { mobile?: boolean };
    }
  ).userAgentData;

  return {
    userAgent: navigator.userAgent ?? '',
    platform: navigator.platform ?? '',
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    userAgentDataMobile: typeof userAgentData?.mobile === 'boolean' ? userAgentData.mobile : null,
  };
}

/**
 * Detects WeChat in-app browser via the MicroMessenger user-agent token.
 *
 * @param userAgent - Browser user agent string
 * @returns True when running inside WeChat
 */
export function detectWeChatInApp(userAgent = ''): boolean {
  return /MicroMessenger/i.test(userAgent);
}

/**
 * Detects iPad / iPadOS, including desktop-mode Safari that spoofs Macintosh.
 * Uses platform and maxTouchPoints; never uses screen resolution.
 *
 * @param signals - Browser capability signals
 * @returns True when the device should be treated as an iPad
 */
export function detectIPadDesktopMode(signals: PaymentEnvironmentSignals): boolean {
  const userAgent = signals.userAgent ?? '';
  const platform = signals.platform ?? '';
  const maxTouchPoints = signals.maxTouchPoints ?? 0;

  if (/iPad/i.test(userAgent) || /iPad/i.test(platform)) {
    return true;
  }

  // iPadOS 13+ may report as Macintosh with multi-touch.
  const isMacLike = /Macintosh|MacIntel/i.test(platform) || /Macintosh/i.test(userAgent);
  return isMacLike && maxTouchPoints > 1;
}

/** Identifies desktop WeChat so its checkout displays a Native payment QR code. */
export function detectDesktopWeChat(signals: PaymentEnvironmentSignals): boolean {
  if (!detectWeChatInApp(signals.userAgent)) return false;
  if (
    signals.userAgentDataMobile === true ||
    /Android|iPhone|iPad|iPod|Windows Phone/i.test(signals.userAgent) ||
    detectIPadDesktopMode(signals)
  )
    return false;
  return /WindowsWechat|MacWechat|DesktopWechat|Windows NT|Macintosh|X11|Linux (?:x86_64|i686)/i.test(
    signals.userAgent,
  );
}

/**
 * Detects a phone-class browser outside WeChat (external Safari/Chrome/etc.).
 * Prefers `navigator.userAgentData.mobile` when available; falls back to UA.
 * iPad is excluded so tablets stay on the Native path by default.
 *
 * @param signals - Browser capability signals
 * @returns True for mobile external browsers that should use H5
 */
export function detectMobileExternalBrowser(signals: PaymentEnvironmentSignals): boolean {
  if (detectWeChatInApp(signals.userAgent)) return false;
  if (detectIPadDesktopMode(signals)) return false;

  if (signals.userAgentDataMobile === true) return true;
  if (signals.userAgentDataMobile === false) return false;

  const userAgent = signals.userAgent ?? '';
  return /Android.+Mobile|iPhone|iPod|Windows Phone|Mobile/i.test(userAgent);
}

/**
 * Resolves the default WeChat payment channel from environment signals.
 * Resolution (viewport width/height/DPR) must never decide the channel.
 *
 * Rules:
 * - Desktop WeChat → native
 * - Mobile WeChat in-app → jsapi
 * - iPad / tablet → native (manual H5 switch remains available in UI)
 * - Phone external browser → h5
 * - Desktop → native
 *
 * @param signals - Optional signals; defaults to current navigator
 * @returns Default payment channel for this environment
 */
export function resolvePaymentChannel(
  signals: PaymentEnvironmentSignals = readPaymentEnvironmentSignals(),
): PaymentChannel {
  if (detectDesktopWeChat(signals)) return 'native';
  if (detectWeChatInApp(signals.userAgent)) return 'jsapi';
  if (detectIPadDesktopMode(signals)) return 'native';
  if (detectMobileExternalBrowser(signals)) return 'h5';
  return 'native';
}

/**
 * Payment environment helpers for order checkout UI.
 *
 * @returns Detection helpers bound to the current browser when called on client
 */
export function usePaymentEnvironment() {
  return {
    readPaymentEnvironmentSignals,
    detectWeChatInApp,
    detectDesktopWeChat,
    detectIPadDesktopMode,
    detectMobileExternalBrowser,
    resolvePaymentChannel,
  };
}
