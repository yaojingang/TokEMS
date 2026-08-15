import { describe, expect, it } from 'vitest';
import {
  interpretWeixinPayResult,
  isPaidSwitchResult,
  isTransientPaymentFailure,
  manualSwitchChannels,
  paymentErrorMessage,
  shouldAutoPrepareWeChatPayment,
  shouldPollOrderStatus,
} from './useOrderPayment';
import type { PaymentEnvironmentSignals } from './usePaymentEnvironment';
import type { Order } from '@conference/contracts';

/**
 * Builds a signal fixture for manual channel switch tests.
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

/**
 * Builds a minimal order fixture for polling helpers.
 *
 * @param status - Order status
 * @returns Order stub
 */
function order(status: Order['status']): Order {
  return {
    id: 'ord_1',
    orderNo: 'TOK1',
    registrationId: 'reg_1',
    status,
    amount: 100,
    currency: 'CNY',
    paymentMethod: 'wechat',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  };
}

describe('shouldPollOrderStatus', () => {
  it('polls only pending and processing orders', () => {
    expect(shouldPollOrderStatus(order('pending_payment'))).toBe(true);
    expect(shouldPollOrderStatus(order('processing'))).toBe(true);
    expect(shouldPollOrderStatus(order('paid'))).toBe(false);
    expect(shouldPollOrderStatus(order('closed'))).toBe(false);
    expect(shouldPollOrderStatus(undefined)).toBe(false);
  });
});

describe('interpretWeixinPayResult', () => {
  it('treats ok as success', () => {
    expect(interpretWeixinPayResult({ err_msg: 'get_brand_wcpay_request:ok' })).toBeNull();
  });

  it('maps cancel and failure to stable copy', () => {
    expect(interpretWeixinPayResult({ err_msg: 'get_brand_wcpay_request:cancel' })).toMatch(/取消/);
    expect(interpretWeixinPayResult({ err_msg: 'get_brand_wcpay_request:fail' })).toMatch(/未完成/);
  });
});

describe('paymentErrorMessage / isTransientPaymentFailure', () => {
  it('prefers Error.message and API message payloads', () => {
    expect(paymentErrorMessage(new Error('网络中断'), 'fallback')).toBe('网络中断');
    expect(paymentErrorMessage({ data: { message: '通道未启用' } }, 'fallback')).toBe('通道未启用');
    expect(
      paymentErrorMessage(
        Object.assign(new Error('[POST] /payments/wechat/order/native: 503 Service Unavailable'), {
          data: { message: '微信支付尚未完成配置' },
        }),
        'fallback',
      ),
    ).toBe('微信支付尚未完成配置');
    expect(paymentErrorMessage({}, 'fallback')).toBe('fallback');
  });

  it('detects network-like failures without HTTP status', () => {
    expect(isTransientPaymentFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientPaymentFailure({ statusCode: 503 })).toBe(false);
    expect(isTransientPaymentFailure({ response: { status: 400 } })).toBe(false);
  });
});

describe('shouldAutoPrepareWeChatPayment', () => {
  it('skips real WeChat prepare for an authorized local simulation order', () => {
    expect(shouldAutoPrepareWeChatPayment(order('pending_payment'), true)).toBe(false);
    expect(shouldAutoPrepareWeChatPayment(order('pending_payment'), false)).toBe(true);
    expect(shouldAutoPrepareWeChatPayment(order('paid'), false)).toBe(false);
  });
});

describe('manualSwitchChannels', () => {
  it('allows iPad native users to switch to H5', () => {
    expect(
      manualSwitchChannels(
        signals({
          userAgent:
            'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
          platform: 'iPad',
          maxTouchPoints: 5,
        }),
        'native',
      ),
    ).toEqual(['h5']);
  });

  it('allows phone H5 users to fall back to native', () => {
    expect(
      manualSwitchChannels(
        signals({
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
          userAgentDataMobile: true,
        }),
        'h5',
      ),
    ).toEqual(['native']);
  });

  it('does not offer switches inside WeChat JSAPI', () => {
    expect(
      manualSwitchChannels(
        signals({
          userAgent: 'Mozilla/5.0 MicroMessenger/8.0.49',
          userAgentDataMobile: true,
        }),
        'jsapi',
      ),
    ).toEqual([]);
  });

  it('keeps desktop native without manual H5 switch', () => {
    expect(
      manualSwitchChannels(
        signals({
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          platform: 'Win32',
          userAgentDataMobile: false,
        }),
        'native',
      ),
    ).toEqual([]);
  });
});

describe('isPaidSwitchResult', () => {
  it('keeps an already-paid switch response out of the prepare flow', () => {
    expect(isPaidSwitchResult({ paid: true, orderId: 'ord_1' })).toBe(true);
    expect(
      isPaidSwitchResult({
        orderId: 'ord_1',
        channel: 'native',
        attemptId: 'pay_1',
        outTradeNo: 'TOKPAY1',
        codeUrl: 'weixin://wxpay/bizpayurl?pr=test',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toBe(false);
  });
});
