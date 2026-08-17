# Safety and Approvals

## Risk gates

- `read`: verify instance, organization, scope, grant, and action.
- `sensitive-read`: require an explicit purpose, minimize fields, and record access audit.
- `routine-write`: inspect, reason, idempotency key, redacted difference, confirmation, and write-after-read verification.
- `controlled`: add browser approval according to connection policy.
- `critical`: require super-administrator password step-up and one-operation browser approval.

Runtime risk can rise when content is already public, notification audience exceeds 100, a batch exceeds 20 affected resources, or an action changes a protected domain. Runtime risk cannot fall below catalog risk.

The server derives and stores request hashes, signed pre-state fingerprints, a canonical route/query target fingerprint, redacted differences, impact, approvals, status, verification, and Agent audit links. Full request bodies and fixed secret headers remain client-side in AES-256-GCM pending files with mode `0600`.

Immediately before execution, the connector reads the target again and receives a short-lived server-signed state observation. The execution request carries the prepared fingerprint and fresh observation token; the API rejects a mismatch and binds both to the connection, organization, action, target, state and approved operation. Request bodies, route parameters, and query parameters are canonicalized and hashed again by the API before domain code runs.

The current observation gate runs before the domain handler. Keep write feature flags disabled until each write action also applies a revision or ETag condition inside the same domain transaction.

Agent reads create an access audit. Sensitive reads require an 8–1000 character purpose file. Ordinary PII list actions are masked by the API before the response leaves TokEMS; local redaction remains a second boundary.

Successful writes query the declared verification action and submit a client evidence digest. Client evidence remains `client-reported`; only a server verifier or Worker can advance the operation to `verified`. Public event and homepage changes also read the public delivery API and rendered home-document endpoint on the pinned TokEMS origin. A missing, stale, unbound, or unavailable delivery response keeps verification `unverified`.

When execution may have succeeded and the response is lost, status becomes `unknown`. Run reconciliation and audit lookup. Create a new operation only after evidence confirms that the prior side effect did not occur.

Exports and one-time-secret handoffs require an absolute output path. The connector refuses overwrite, writes mode `0600`, prints path, byte count, SHA-256, and retention warning, and emits no file content. One-time results use a one-hour encrypted server escrow; the connector saves the local encrypted artifact before acknowledging server-side deletion.
