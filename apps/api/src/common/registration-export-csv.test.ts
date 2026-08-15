import { describe, expect, it } from 'vitest';
import { buildRegistrationExportCsv } from './registration-export-csv.js';

describe('registration CSV export', () => {
  it('exports purchaser, attendee, ownership, intent, and order total as separate columns', () => {
    const csv = buildRegistrationExportCsv(
      {
        eventName: '指标大会',
        actorPublicId: 10001,
        exportedAt: '2026-08-15T00:00:00.000Z',
        scope: 'organization/event',
      },
      [
        {
          registration: {
            registrationCode: 'REG-1',
            status: 'confirmed',
            attendee: {
              name: '参会人',
              mobile: '13900139000',
              email: 'attendee@example.com',
              company: '参会公司',
              title: '负责人',
              city: '深圳',
            },
            formVersion: 3,
            termsVersion: '2026-08',
            formAnswers: { source: 'friend' },
            consentSnapshot: { purchaseFor: 'other' },
            createdAt: new Date('2026-08-15T01:00:00.000Z'),
          },
          order: {
            orderNo: 'ORDER-1',
            status: 'paid',
            amount: 39_900,
            currency: 'CNY',
            purchaserCustomerUserId: '11111111-1111-4111-8111-111111111111',
            purchaserSnapshot: {
              name: '购票人',
              mobile: '13800138000',
              email: 'buyer@example.com',
            },
            purchaseIntentId: '22222222-2222-4222-8222-222222222222',
          },
        },
      ],
    );

    expect(csv).toContain(
      '"购票人姓名","购票人手机号","购票人邮箱","参会人姓名","参会人手机号","参会人邮箱","订单归属","购买意图 ID","订单总额（分）"',
    );
    expect(csv).toContain(
      '"购票人","13800138000","buyer@example.com","参会人","13900139000","attendee@example.com","proxy","22222222-2222-4222-8222-222222222222","39900"',
    );
  });

  it('neutralizes spreadsheet formulas in purchaser and attendee fields', () => {
    const csv = buildRegistrationExportCsv(
      {
        eventName: '=WEBSERVICE("https://example.test")',
        actorPublicId: 10001,
        exportedAt: '2026-08-15T00:00:00.000Z',
        scope: 'organization/event',
      },
      [
        {
          registration: {
            registrationCode: 'REG-2',
            status: 'confirmed',
            attendee: {
              name: '+SUM(1,1)',
              mobile: '13900139000',
              email: 'attendee@example.com',
              company: '@IMPORTXML(A1)',
              title: '负责人',
              city: '深圳',
            },
            formVersion: 1,
            termsVersion: '2026-08',
            formAnswers: {},
            consentSnapshot: { purchaseFor: 'self' },
            createdAt: new Date('2026-08-15T01:00:00.000Z'),
          },
          order: {
            orderNo: 'ORDER-2',
            status: 'paid',
            amount: 39_900,
            currency: 'CNY',
            purchaserCustomerUserId: '11111111-1111-4111-8111-111111111111',
            purchaserSnapshot: {
              name: '=CMD()',
              mobile: '13800138000',
              email: '-1+1@example.com',
            },
            purchaseIntentId: '22222222-2222-4222-8222-222222222222',
          },
        },
      ],
    );

    expect(csv).toContain(`"'=WEBSERVICE(""https://example.test"")"`);
    expect(csv).toContain(`"'=CMD()"`);
    expect(csv).toContain(`"'+SUM(1,1)"`);
    expect(csv).toContain(`"'@IMPORTXML(A1)"`);
    expect(csv).toContain(`"'-1+1@example.com"`);
  });

  it('uses customer ownership to identify a same-mobile proxy purchase', () => {
    const csv = buildRegistrationExportCsv(
      {
        eventName: '归属大会',
        actorPublicId: 10001,
        exportedAt: '2026-08-15T00:00:00.000Z',
        scope: 'organization/event',
      },
      [
        {
          registration: {
            customerUserId: '33333333-3333-4333-8333-333333333333',
            registrationCode: 'REG-3',
            status: 'confirmed',
            attendee: {
              name: '参会人',
              mobile: '13800138000',
              email: 'attendee@example.com',
              company: '参会公司',
              title: '负责人',
              city: '深圳',
            },
            formVersion: 1,
            termsVersion: '2026-08',
            formAnswers: {},
            consentSnapshot: {},
            createdAt: new Date('2026-08-15T01:00:00.000Z'),
          },
          order: {
            orderNo: 'ORDER-3',
            status: 'paid',
            amount: 39_900,
            currency: 'CNY',
            purchaserCustomerUserId: '11111111-1111-4111-8111-111111111111',
            purchaserSnapshot: {
              name: '购票人',
              mobile: '13800138000',
              email: 'buyer@example.com',
            },
            purchaseIntentId: '22222222-2222-4222-8222-222222222222',
          },
        },
      ],
    );

    expect(csv).toContain('"proxy"');
  });
});
