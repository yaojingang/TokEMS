# Commerce and Invoices

Orders support read and related domain actions. Compute paid amount, refunded amount, refundable ceiling, inventory, and ticket impact before refund preparation. Every refund is critical and uses the domain idempotency key.

Invoice actions follow the current status machine and expected version. File download, replacement, voiding, sensitive export, and critical delivery changes require the declared approval. Verify invoice version, document state, job or outbox state, order relationship, and audit record.

Do not expose invoice or CSV content in JSON or terminal output. Store artifacts at an absolute path with mode `0600` and report SHA-256.
