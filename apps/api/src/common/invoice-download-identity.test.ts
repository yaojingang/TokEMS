import { describe, expect, it } from 'vitest';
import { invoiceDownloadIdentity } from './invoice-download-identity.js';

describe('invoice download identity', () => {
  it('changes when a reused document row points to a replacement file', () => {
    const original = invoiceDownloadIdentity({
      id: 'document-1',
      storageKey: 'invoices/original.pdf',
      contentDigest: 'a'.repeat(64),
      issuedAt: '2026-08-15T00:00:00.000Z',
    });
    const replacement = invoiceDownloadIdentity({
      id: 'document-1',
      storageKey: 'invoices/replacement.pdf',
      contentDigest: 'b'.repeat(64),
      issuedAt: '2026-08-15T00:01:00.000Z',
    });

    expect(replacement).not.toBe(original);
  });
});
