import { describe, expect, it } from 'vitest';
import {
  deliverWhileInvoiceCurrent,
  invoiceNotificationIsCurrent,
} from './invoice-notification-policy.js';

describe('invoice notification policy', () => {
  const activeDocument = {
    documentId: 'document-2',
    storageKey: 'invoices/document-2.pdf',
    contentDigest: 'sha256:active',
    issuedAt: '2028-01-02T00:00:00.000Z',
  };

  it('drops an issued delivery after refund or document replacement', () => {
    expect(
      invoiceNotificationIsCurrent({
        eventType: 'InvoiceDeliveryRequested',
        invoiceStatus: 'voided',
        payloadDocumentIdentity: activeDocument,
        activeDocumentIdentity: null,
      }),
    ).toBe(false);
    expect(
      invoiceNotificationIsCurrent({
        eventType: 'InvoiceIssued',
        invoiceStatus: 'issued',
        payloadDocumentIdentity: { ...activeDocument, documentId: 'document-1' },
        activeDocumentIdentity: activeDocument,
      }),
    ).toBe(false);
  });

  it('rejects a same-row document replacement when immutable identity changed', () => {
    expect(
      invoiceNotificationIsCurrent({
        eventType: 'InvoiceDeliveryRequested',
        invoiceStatus: 'issued',
        payloadDocumentIdentity: { ...activeDocument, contentDigest: 'sha256:old' },
        activeDocumentIdentity: activeDocument,
      }),
    ).toBe(false);
    expect(
      invoiceNotificationIsCurrent({
        eventType: 'InvoiceIssued',
        invoiceStatus: 'issued',
        payloadDocumentIdentity: { ...activeDocument, storageKey: 'invoices/replaced.pdf' },
        activeDocumentIdentity: activeDocument,
      }),
    ).toBe(false);
  });

  it('accepts only the complete identity of the active unvoided document', () => {
    expect(
      invoiceNotificationIsCurrent({
        eventType: 'InvoiceIssued',
        invoiceStatus: 'issued',
        payloadDocumentIdentity: activeDocument,
        activeDocumentIdentity: activeDocument,
      }),
    ).toBe(true);
  });

  it('sends details links only while details can still be supplied', () => {
    expect(
      invoiceNotificationIsCurrent({
        eventType: 'InvoiceDetailsRequested',
        invoiceStatus: 'awaiting_details',
        payloadDocumentIdentity: null,
        activeDocumentIdentity: null,
      }),
    ).toBe(true);
    expect(
      invoiceNotificationIsCurrent({
        eventType: 'InvoiceDetailsRequested',
        invoiceStatus: 'rejected',
        payloadDocumentIdentity: null,
        activeDocumentIdentity: null,
      }),
    ).toBe(true);
    expect(
      invoiceNotificationIsCurrent({
        eventType: 'InvoiceDetailsRequested',
        invoiceStatus: 'cancelled',
        payloadDocumentIdentity: null,
        activeDocumentIdentity: null,
      }),
    ).toBe(false);
    expect(
      invoiceNotificationIsCurrent({
        eventType: 'InvoiceDetailsRequested',
        invoiceStatus: 'refunded',
        payloadDocumentIdentity: null,
        activeDocumentIdentity: null,
      }),
    ).toBe(false);
  });

  it('keeps the current-version lease active until delivery finishes', async () => {
    let leaseActive = false;
    let delivered = false;
    const result = await deliverWhileInvoiceCurrent({
      withCurrentVersionLease: async (run) => {
        leaseActive = true;
        try {
          return await run(true);
        } finally {
          leaseActive = false;
        }
      },
      deliver: async () => {
        expect(leaseActive).toBe(true);
        delivered = true;
      },
      cancelStale: async () => undefined,
    });

    expect(result).toBe(true);
    expect(delivered).toBe(true);
    expect(leaseActive).toBe(false);
  });

  it('cancels a stale delivery without calling the provider', async () => {
    let delivered = false;
    let cancelled = false;
    const result = await deliverWhileInvoiceCurrent({
      withCurrentVersionLease: async (run) => run(false),
      deliver: async () => {
        delivered = true;
      },
      cancelStale: async () => {
        cancelled = true;
      },
    });

    expect(result).toBe(false);
    expect(delivered).toBe(false);
    expect(cancelled).toBe(true);
  });
});
