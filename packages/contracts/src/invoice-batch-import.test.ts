import { describe, expect, it } from 'vitest';
import { InvoiceBatchPreflightSchema } from './index.js';

describe('invoice batch import manifest', () => {
  it('accepts a normalized PDF work item', () => {
    expect(
      InvoiceBatchPreflightSchema.parse({
        items: [
          {
            requestNo: 'INV2026ABC001',
            invoiceNumber: '254012345678',
            invoiceCode: '044002500111',
            uploadFile: 'files/INV2026ABC001.pdf',
            mediaType: 'application/pdf',
            size: 1024,
            contentDigest: 'a'.repeat(64),
          },
        ],
      }).items,
    ).toHaveLength(1);
  });

  it('rejects traversal paths and duplicate request numbers', () => {
    expect(
      InvoiceBatchPreflightSchema.safeParse({
        items: [
          {
            requestNo: 'INV2026ABC001',
            invoiceNumber: '254012345678',
            invoiceCode: '',
            uploadFile: '../INV2026ABC001.pdf',
            mediaType: 'application/pdf',
            size: 1024,
            contentDigest: 'a'.repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      InvoiceBatchPreflightSchema.safeParse({
        items: [
          {
            requestNo: 'INV2026ABC001',
            invoiceNumber: '254012345678',
            invoiceCode: '',
            uploadFile: 'files/INV2026ABC001.pdf',
            mediaType: 'application/pdf',
            size: 1024,
            contentDigest: 'a'.repeat(64),
          },
          {
            requestNo: 'INV2026ABC001',
            invoiceNumber: '254012345679',
            invoiceCode: '',
            uploadFile: 'files/INV2026ABC001-2.pdf',
            mediaType: 'application/pdf',
            size: 1024,
            contentDigest: 'b'.repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects mismatched media types and duplicate file content', () => {
    expect(
      InvoiceBatchPreflightSchema.safeParse({
        items: [
          {
            requestNo: 'INV2026ABC001',
            invoiceNumber: '254012345678',
            invoiceCode: '',
            uploadFile: 'files/INV2026ABC001.pdf',
            mediaType: 'application/ofd',
            size: 1024,
            contentDigest: 'a'.repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      InvoiceBatchPreflightSchema.safeParse({
        items: [
          {
            requestNo: 'INV2026ABC001',
            invoiceNumber: '254012345678',
            invoiceCode: '',
            uploadFile: 'files/INV2026ABC001.pdf',
            mediaType: 'application/pdf',
            size: 1024,
            contentDigest: 'a'.repeat(64),
          },
          {
            requestNo: 'INV2026ABC002',
            invoiceNumber: '254012345679',
            invoiceCode: '',
            uploadFile: 'files/INV2026ABC002.pdf',
            mediaType: 'application/pdf',
            size: 2048,
            contentDigest: 'A'.repeat(64),
          },
        ],
      }).success,
    ).toBe(false);
  });
});
