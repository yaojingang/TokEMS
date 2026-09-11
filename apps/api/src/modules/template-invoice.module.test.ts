import { describe, expect, it } from 'vitest';
import {
  invoiceDocumentReplaceIdempotencyScope,
  invoiceDocumentVoidIdempotencyScope,
} from './template-invoice.module.js';

describe('invoice document replacement idempotency scope', () => {
  it('keeps a document-specific scope within the database column limit', () => {
    const scope = invoiceDocumentReplaceIdempotencyScope(
      '11111111-1111-4111-8111-111111111111',
      101,
      '6ff88391-5412-44ec-b019-e9a6efa0dba4',
      '439dbbf1-eb7a-4f9c-8cb5-e338ecbd40cc',
    );

    expect(scope.length).toBeLessThanOrEqual(120);
    expect(scope).toContain('invoice:document:replace-file:');
  });

  it('keeps voiding a document within the database column limit', () => {
    const scope = invoiceDocumentVoidIdempotencyScope(
      '11111111-1111-4111-8111-111111111111',
      101,
      '6ff88391-5412-44ec-b019-e9a6efa0dba4',
      '439dbbf1-eb7a-4f9c-8cb5-e338ecbd40cc',
    );

    expect(scope.length).toBeLessThanOrEqual(120);
    expect(scope).toContain('invoice:document:void:');
  });
});
