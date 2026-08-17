# Capability Map

Run `capabilities sync` for the authoritative live catalog. Catalog actions cover these namespaces:

- `instance.*`, `connection.*`, `organization.*`, `events.*`, `content.*`
- `templates.*`, `customers.*`, `registrations.*`, `commerce.*`, `invoices.*`
- `communications.*`, `checkin.*`, `integrations.*`, `audit.*`, `exports.*`

Each entry declares method, fixed route template, required grants, scopes, data class, base and dynamic risk, confirmation, idempotency strategy, verification action, reconciliation action, and rollback boundary.

Version `0.1.1` ships 77 released actions mapped one-to-one to 77 management handlers. The live catalog remains authoritative. CI requires every management handler to map to one released action or carry an explicit exclusion, with zero unclassified handlers and zero released actions without a handler.

Use exact organization and resource IDs from a preceding read. Template and public-content writes use revisions and release verification. Orders expose queries and domain actions; arbitrary order fields, paid amount, payment facts, and transaction records have no action ID.

The service rejects any management route missing catalog classification. The connector rejects free methods, paths, origins, and URLs. Its only non-catalog reads are the fixed public event/homepage delivery endpoints used after publication to verify the actual frontend payload and rendered home document.
