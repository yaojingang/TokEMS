import { describe, expect, it } from 'vitest';
import type { CustomerInvoiceCenterItem } from '@conference/contracts';
import {
  customerInvoiceDownloadUrl,
  customerInvoicePrimaryAction,
  invoiceDocumentType,
  invoiceFileSize,
  invoiceMoney,
} from './customer-invoice';

const item: CustomerInvoiceCenterItem = {
  orderId: 'order-1',
  orderNo: 'ORDER-1',
  eventId: 101,
  eventName: '测试大会',
  eventSlug: 'test-event',
  startsAt: new Date().toISOString(),
  orderAmount: 39900,
  eligibleAmount: 39900,
  invoiceAmount: null,
  currency: 'CNY',
  invoiceId: null,
  requestNo: null,
  title: null,
  status: null,
  category: 'eligible' as const,
  requestedAt: null,
  updatedAt: new Date().toISOString(),
  availableActions: ['apply'],
};

describe('customer invoice presentation', () => {
  it('resolves relative invoice download paths against the public API base', () => {
    expect(
      customerInvoiceDownloadUrl(
        '/orders/order-1/invoice-documents/document-1/download?expires=123&signature=test',
        '/api/v1',
      ),
    ).toBe(
      '/api/v1/orders/order-1/invoice-documents/document-1/download?expires=123&signature=test',
    );
  });

  it('chooses the primary action from server-provided capabilities', () => {
    expect(customerInvoicePrimaryAction(item)).toBe('申请发票');
    expect(
      customerInvoicePrimaryAction({
        ...item,
        invoiceId: 'invoice-1',
        requestNo: 'INV-1',
        status: 'pending_review',
        category: 'processing',
        availableActions: ['edit', 'view'],
      }),
    ).toBe('修改资料');
  });

  it('formats money and file metadata for the invoice list', () => {
    expect(invoiceMoney(39900)).toContain('399');
    expect(invoiceFileSize(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(invoiceDocumentType('reissue')).toBe('重开发票');
  });
});
