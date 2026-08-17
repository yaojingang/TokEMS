# Troubleshooting

- `AGENT_ACCESS_DISABLED`: the instance owner must enable the staged feature flag. Writes and critical actions have separate flags.
- `AGENT_CONNECTION_REVOKED`: reconnect after confirming administrator membership and credentials.
- `AGENT_SCOPE_REQUIRED`: request a new connection with the required scope. Existing scopes cannot be expanded in place.
- `AGENT_APPROVAL_REQUIRED`: open the returned TokEMS browser approval URL and complete the exact operation approval.
- `AGENT_OPERATION_STALE`: inspect again and prepare a new operation from the current revision.
- `AGENT_OPERATION_LIMIT`: finish, cancel, or reconcile outstanding operations before preparing another one.
- `AGENT_DPOP_REPLAY`: stop and run `doctor`; repeated proof use can indicate credential or process compromise.
- `AGENT_VERSION_UNSUPPORTED`: update the local package after registry and checksum review.
- `AGENT_RESULT_UNKNOWN`: run reconciliation and audit lookup. Do not execute the prior body again.
- `AGENT_SECRET_HANDOFF_REQUIRED`: download the protected artifact before its one-hour escrow expires.
- `SENSITIVE_READ_PURPOSE_REQUIRED`: create a UTF-8 purpose file containing the concrete task purpose and pass `--purpose-file`.
- `PUBLIC_DELIVERY_VERIFY_FAILED`: keep the operation `unverified`, inspect the release and public page manually, and do not claim publication success.
- `SECRET_FILE_UNSUPPORTED`: `--secret-file` is limited to `checkin.sync`; other secrets use the action body or protected one-time artifact defined by the live catalog.
- `OUTPUT_PATH_EXISTS`: choose a new absolute artifact path. The connector never overwrites an existing file.

Run `doctor` to check Node.js, credential store, local state permissions, active connection, live metadata, catalog version, and expired pending-file cleanup.
