export interface InvoiceDownloadDocumentIdentity {
  id: string;
  storageKey: string;
  contentDigest: string;
  issuedAt: Date | string;
}

export function invoiceDownloadIdentity(document: InvoiceDownloadDocumentIdentity) {
  return JSON.stringify([
    document.id,
    document.storageKey,
    document.contentDigest.toLowerCase(),
    document.issuedAt instanceof Date ? document.issuedAt.toISOString() : document.issuedAt,
  ]);
}
