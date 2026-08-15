export type InvoiceDocumentIdentity = {
  documentId: string;
  storageKey: string;
  contentDigest: string;
  issuedAt: string;
};

export async function deliverWhileInvoiceCurrent(input: {
  withCurrentVersionLease: (run: (current: boolean) => Promise<boolean>) => Promise<boolean>;
  deliver: () => Promise<void>;
  cancelStale: () => Promise<void>;
}) {
  return input.withCurrentVersionLease(async (current) => {
    if (!current) {
      await input.cancelStale();
      return false;
    }
    await input.deliver();
    return true;
  });
}

export function invoiceNotificationIsCurrent(input: {
  eventType: string;
  invoiceStatus: string;
  payloadDocumentIdentity: InvoiceDocumentIdentity | null;
  activeDocumentIdentity: InvoiceDocumentIdentity | null;
}) {
  if (input.eventType === 'InvoiceDetailsRequested') {
    return ['awaiting_details', 'rejected'].includes(input.invoiceStatus);
  }
  const issued =
    input.eventType === 'InvoiceIssued' || input.eventType === 'InvoiceDeliveryRequested';
  if (!issued) return true;
  if (
    input.invoiceStatus !== 'issued' ||
    !input.payloadDocumentIdentity ||
    !input.activeDocumentIdentity
  ) {
    return false;
  }
  return (Object.keys(input.payloadDocumentIdentity) as Array<keyof InvoiceDocumentIdentity>).every(
    (field) => input.payloadDocumentIdentity?.[field] === input.activeDocumentIdentity?.[field],
  );
}
