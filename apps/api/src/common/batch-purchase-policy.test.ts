import { describe, expect, it } from 'vitest';
import {
  CreateRegistrationBatchSchema,
  type BatchAttendeeInput,
  type RegistrationField,
} from '@conference/contracts';
import { batchAmount, normalizeBatchAttendees } from './batch-purchase-policy.js';

const attendee = (clientId: string, mobile: string, isSelf = false): BatchAttendeeInput => ({
  clientId,
  isSelf,
  marketingConsent: true,
  attendee: { name: '参会人', mobile, company: '公司', email: '', title: '', city: '' },
});
const fields: RegistrationField[] = [
  { key: 'name', label: '姓名', type: 'text', required: true, enabled: true },
  { key: 'mobile', label: '手机号', type: 'tel', required: true, enabled: true },
  { key: 'company', label: '公司', type: 'text', required: true, enabled: true },
];
describe('batch purchase admission', () => {
  it('charges five seats once and checks integer/payment storage bounds', () => {
    expect(batchAmount(39900, 5)).toBe(199500);
    expect(batchAmount(39900, 4)).toBe(159600);
    expect(batchAmount(0, 20)).toBe(0);
    for (const quantity of [0, 21, 1.5, NaN]) expect(() => batchAmount(39900, quantity)).toThrow();
    expect(() => batchAmount(2147483647, 2)).toThrow();
  });
  it('normalizes phones before duplicate detection and returns stable card identity', () => {
    const rows = [
      attendee('00000000-0000-4000-8000-000000000001', '13800138000'),
      attendee('00000000-0000-4000-8000-000000000002', '+8613800138000'),
    ];
    expect(() => normalizeBatchAttendees(rows, '13900139000', fields)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ clientId: rows[1]!.clientId, field: 'mobile' }),
      }),
    );
  });
  it('uses verified self mobile, per-person form rules, and disables proxy marketing', () => {
    const rows = normalizeBatchAttendees(
      [attendee('self', '', true), attendee('other', '13800138000')],
      '13900139000',
      fields,
    );
    expect(rows[0]!.attendee.mobile).toBe('+8613900139000');
    expect(rows[0]!.marketingConsent).toBe(true);
    expect(rows[1]!.marketingConsent).toBe(false);
    expect(() =>
      normalizeBatchAttendees(
        [{ ...rows[1]!, attendee: { ...rows[1]!.attendee, company: '' } }],
        '13900139000',
        fields,
      ),
    ).toThrow();
  });
  it('rejects mismatched quantity, duplicate cards, and missing proxy consent', () => {
    const input = {
      eventId: 100001,
      ticketTypeId: 'ticket',
      quantity: 1,
      attendees: [attendee('00000000-0000-4000-8000-000000000001', '13800138000')],
      purchaseIntentId: '00000000-0000-4000-8000-000000000003',
      formVersion: 1,
      termsVersion: 'v1',
      termsAccepted: true,
      proxyAuthorizationAccepted: true,
      quoteFingerprint: 'a'.repeat(64),
    };
    expect(CreateRegistrationBatchSchema.safeParse(input).success).toBe(true);
    expect(CreateRegistrationBatchSchema.safeParse({ ...input, quantity: 2 }).success).toBe(false);
    expect(
      CreateRegistrationBatchSchema.safeParse({
        ...input,
        quantity: 2,
        attendees: [input.attendees[0], input.attendees[0]],
      }).success,
    ).toBe(false);
    expect(
      CreateRegistrationBatchSchema.safeParse({ ...input, proxyAuthorizationAccepted: false })
        .success,
    ).toBe(false);
  });
});
