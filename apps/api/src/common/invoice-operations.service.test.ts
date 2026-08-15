import { describe, expect, it } from 'vitest';
import {
  allowedInvoiceTransitions,
  buildInvoiceExportCsv,
  canTransitionInvoice,
  invoiceDocumentNotificationIdentity,
  invoiceExportJobMatchesEvent,
  invoiceExportRequiresWorker,
} from './invoice-operations.service.js';

describe('invoice lifecycle', () => {
  it('only permits transitions defined by the approved lifecycle', () => {
    expect(canTransitionInvoice('awaiting_details', 'pending_review')).toBe(true);
    expect(canTransitionInvoice('pending_review', 'issuing')).toBe(true);
    expect(canTransitionInvoice('issuing', 'issued')).toBe(true);
    expect(canTransitionInvoice('issued', 'awaiting_details')).toBe(false);
    expect(canTransitionInvoice('cancelled', 'pending_review')).toBe(false);
    expect(allowedInvoiceTransitions('adjustment_required')).toEqual(['voided']);
  });

  it('routes exports at fifty thousand rows to the worker', () => {
    expect(invoiceExportRequiresWorker(49_999)).toBe(false);
    expect(invoiceExportRequiresWorker(50_000)).toBe(true);
  });

  it('binds export jobs to their conference', () => {
    expect(invoiceExportJobMatchesEvent({ eventId: 101 }, 101)).toBe(true);
    expect(invoiceExportJobMatchesEvent({ eventId: '101' }, 101)).toBe(true);
    expect(invoiceExportJobMatchesEvent({ eventId: 102 }, 101)).toBe(false);
    expect(invoiceExportJobMatchesEvent({}, 101)).toBe(false);
  });

  it('guards spreadsheet formulas in exported invoice fields', () => {
    const csv = buildInvoiceExportCsv([
      {
        requestNo: 'INV-1',
        registrationCode: 'TOK-R-1',
        eventName: '=HYPERLINK("https://example.com")',
        attendeeName: '江云舟',
        mobile: '13800138000',
        title: '+危险公式',
        taxId: '911100001234567801',
        email: 'invoice@example.com',
        paymentStatus: 'paid',
        paidAmount: 39900,
        refundedAmount: 0,
        invoiceAmount: 39900,
        currency: 'CNY',
        invoiceStatus: 'issuing',
        invoiceNumber: '',
        invoiceCode: '',
        uploadFile: 'files/INV-1.pdf',
      },
    ]);
    expect(csv).toContain('request_no,registration_code,event_name,attendee_name');
    expect(csv).toContain(`'=HYPERLINK`);
    expect(csv).toContain(`'+危险公式`);
  });

  it('binds invoice notifications to the complete immutable document identity', () => {
    expect(
      invoiceDocumentNotificationIdentity({
        id: '06ae1f24-34f4-4d09-90ae-4640f37fc118',
        storageKey: 'invoices/INV-1.pdf',
        contentDigest: 'sha256:document',
        issuedAt: new Date('2028-01-02T00:00:00.000Z'),
      }),
    ).toEqual({
      documentId: '06ae1f24-34f4-4d09-90ae-4640f37fc118',
      storageKey: 'invoices/INV-1.pdf',
      contentDigest: 'sha256:document',
      issuedAt: '2028-01-02T00:00:00.000Z',
    });
  });
});
