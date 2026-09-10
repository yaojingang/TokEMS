import { describe, expect, it } from 'vitest';
import {
  detectIPadDesktopMode,
  detectMobileExternalBrowser,
  detectWeChatInApp,
  resolvePaymentChannel,
  type PaymentEnvironmentSignals,
} from './usePaymentEnvironment';

/**
 * Builds a signal fixture for the environment matrix.
 *
 * @param partial - Overrides applied on top of empty defaults
 * @returns Complete signal object
 */
function signals(partial: Partial<PaymentEnvironmentSignals>): PaymentEnvironmentSignals {
  return {
    userAgent: '',
    platform: '',
    maxTouchPoints: 0,
    userAgentDataMobile: null,
    ...partial,
  };
}

describe('detectWeChatInApp', () => {
  it('detects MicroMessenger user agents', () => {
    expect(
      detectWeChatInApp(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.49',
      ),
    ).toBe(true);
  });

  it('rejects non-WeChat browsers', () => {
    expect(
      detectWeChatInApp(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(false);
  });
});

describe('detectIPadDesktopMode', () => {
  it('detects classic iPad user agents', () => {
    expect(
      detectIPadDesktopMode(
        signals({
          userAgent:
            'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
          platform: 'iPad',
          maxTouchPoints: 5,
        }),
      ),
    ).toBe(true);
  });

  it('detects iPadOS desktop-mode Macintosh spoof with multi-touch', () => {
    expect(
      detectIPadDesktopMode(
        signals({
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
          platform: 'MacIntel',
          maxTouchPoints: 5,
        }),
      ),
    ).toBe(true);
  });

  it('does not treat a real desktop Mac as iPad', () => {
    expect(
      detectIPadDesktopMode(
        signals({
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
          platform: 'MacIntel',
          maxTouchPoints: 0,
        }),
      ),
    ).toBe(false);
  });
});

describe('detectMobileExternalBrowser', () => {
  it('uses userAgentData.mobile when present', () => {
    expect(
      detectMobileExternalBrowser(
        signals({
          userAgent: 'Mozilla/5.0',
          userAgentDataMobile: true,
        }),
      ),
    ).toBe(true);
  });

  it('detects iPhone Safari outside WeChat', () => {
    expect(
      detectMobileExternalBrowser(
        signals({
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
        }),
      ),
    ).toBe(true);
  });

  it('detects Android mobile Chrome outside WeChat', () => {
    expect(
      detectMobileExternalBrowser(
        signals({
          userAgent:
            'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        }),
      ),
    ).toBe(true);
  });

  it('excludes WeChat and iPad', () => {
    expect(
      detectMobileExternalBrowser(
        signals({
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.49',
          userAgentDataMobile: true,
        }),
      ),
    ).toBe(false);

    expect(
      detectMobileExternalBrowser(
        signals({
          userAgent:
            'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
          platform: 'iPad',
          maxTouchPoints: 5,
        }),
      ),
    ).toBe(false);
  });
});

describe('resolvePaymentChannel matrix', () => {
  it.each([
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 MicroMessenger/3.9.10.27 WindowsWechat',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 MicroMessenger/3.8.9 MacWechat',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 MicroMessenger/4.0.0',
  ])('routes desktop WeChat to a Native QR code: %s', (userAgent) => {
    expect(resolvePaymentChannel(signals({ userAgent }))).toBe('native');
  });

  it('keeps iPad WeChat on JSAPI even with a Macintosh user agent', () => {
    expect(
      resolvePaymentChannel(
        signals({
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 MicroMessenger/8.0.49',
          platform: 'MacIntel',
          maxTouchPoints: 5,
        }),
      ),
    ).toBe('jsapi');
  });

  it('routes WeChat in-app to jsapi', () => {
    expect(
      resolvePaymentChannel(
        signals({
          userAgent:
            'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 MicroMessenger/8.0.49 Mobile Safari/537.36',
          userAgentDataMobile: true,
        }),
      ),
    ).toBe('jsapi');
  });

  it('routes iPhone/Android external browsers to h5', () => {
    expect(
      resolvePaymentChannel(
        signals({
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
          userAgentDataMobile: true,
        }),
      ),
    ).toBe('h5');

    expect(
      resolvePaymentChannel(
        signals({
          userAgent:
            'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          userAgentDataMobile: true,
        }),
      ),
    ).toBe('h5');
  });

  it('routes desktop browsers to native', () => {
    expect(
      resolvePaymentChannel(
        signals({
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          platform: 'Win32',
          userAgentDataMobile: false,
        }),
      ),
    ).toBe('native');
  });

  it('routes iPadOS (including desktop mode) to native', () => {
    expect(
      resolvePaymentChannel(
        signals({
          userAgent:
            'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
          platform: 'iPad',
          maxTouchPoints: 5,
        }),
      ),
    ).toBe('native');

    expect(
      resolvePaymentChannel(
        signals({
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
          platform: 'MacIntel',
          maxTouchPoints: 5,
        }),
      ),
    ).toBe('native');
  });

  it('never uses viewport resolution (signals omit width/height entirely)', () => {
    const desktop = resolvePaymentChannel(
      signals({
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        platform: 'Linux x86_64',
        userAgentDataMobile: false,
      }),
    );
    expect(desktop).toBe('native');
    expect(Object.keys(signals({})).sort()).toEqual(
      ['maxTouchPoints', 'platform', 'userAgent', 'userAgentDataMobile'].sort(),
    );
  });
});
