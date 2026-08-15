import { describe, expect, it } from 'vitest';
import { resolveLocalPaymentSimulationPolicy } from './local-payment-simulation.js';

describe('resolveLocalPaymentSimulationPolicy', () => {
  it('enables only allowlisted mobiles on a loopback local deployment', () => {
    const policy = resolveLocalPaymentSimulationPolicy({
      DEPLOYMENT_MODE: 'local',
      ENABLE_LOCAL_PAYMENT_SIMULATION: 'true',
      LOCAL_PAYMENT_SIMULATION_MOBILES: '18600184180, 138 0013 8000',
      PUBLIC_ORIGIN: 'http://localhost:8088',
      ADMIN_ORIGIN: 'http://admin.localhost:8088',
      PAYMENT_PUBLIC_ORIGIN: 'http://www.localhost:8088',
    });

    expect(policy.enabled).toBe(true);
    expect(policy.allowedMobileE164s).toEqual(['+8618600184180', '+8613800138000']);
  });

  it('stays disabled in production even when the switch is set', () => {
    const policy = resolveLocalPaymentSimulationPolicy({
      DEPLOYMENT_MODE: 'production',
      ENABLE_LOCAL_PAYMENT_SIMULATION: 'true',
      LOCAL_PAYMENT_SIMULATION_MOBILES: '18600184180',
      PUBLIC_ORIGIN: 'https://conference.example.com',
      ADMIN_ORIGIN: 'https://admin.example.com',
    });

    expect(policy).toEqual({ enabled: false, allowedMobileE164s: [] });
  });

  it('stays disabled when any configured browser origin is not loopback', () => {
    const policy = resolveLocalPaymentSimulationPolicy({
      DEPLOYMENT_MODE: 'local',
      ENABLE_LOCAL_PAYMENT_SIMULATION: 'true',
      LOCAL_PAYMENT_SIMULATION_MOBILES: '18600184180',
      PUBLIC_ORIGIN: 'http://192.168.1.20:8088',
      ADMIN_ORIGIN: 'http://admin.localhost:8088',
    });

    expect(policy).toEqual({ enabled: false, allowedMobileE164s: [] });
  });

  it('stays disabled when the dedicated payment origin is missing', () => {
    const policy = resolveLocalPaymentSimulationPolicy({
      DEPLOYMENT_MODE: 'local',
      ENABLE_LOCAL_PAYMENT_SIMULATION: 'true',
      LOCAL_PAYMENT_SIMULATION_MOBILES: '18600184180',
      PUBLIC_ORIGIN: 'http://localhost:8088',
      ADMIN_ORIGIN: 'http://admin.localhost:8088',
    });

    expect(policy).toEqual({ enabled: false, allowedMobileE164s: [] });
  });
});
