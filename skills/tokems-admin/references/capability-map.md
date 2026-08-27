# Capability Map

Run `capabilities sync` for the authoritative live catalog. Catalog actions cover these namespaces:

- `instance.*`, `connection.*`, `organization.*`, `events.*`, `content.*`
- `templates.*`, `attendee-needs.*`, `customers.*`, `registrations.*`, `commerce.*`, `invoices.*`
- `communications.*`, `checkin.*`, `integrations.*`, `audit.*`, `exports.*`

Each entry declares method, fixed route template, required grants, scopes, data class, base and dynamic risk, confirmation, idempotency strategy, verification action, reconciliation action, and rollback boundary.

Version `0.2.0` ships 87 released actions mapped one-to-one to 87 management handlers. The live catalog remains authoritative. `references/system-contracts.json` binds Skill `0.2.0` to catalog `1.2.0` and records every action, surfaced management handler, handler grant metadata, template node type, stable node key, managed input field, risk, grant, scope, approval, and rollback rule. CI regenerates this snapshot, rejects actions without exactly one handler, rejects catalog-to-handler grant mismatches, and fails on content drift.

Use exact organization and resource IDs from a preceding read. Template and public-content writes use revisions and release verification. Orders expose queries and domain actions; arbitrary order fields, paid amount, payment facts, and transaction records have no action ID.

The service rejects any management route missing catalog classification. The connector rejects free methods, paths, origins, and URLs. Its fixed public verification reads cover event or homepage payloads, rendered home documents, and the public attendee-question list after relevant moderation.
