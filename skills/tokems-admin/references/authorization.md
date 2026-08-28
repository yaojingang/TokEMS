# Authorization

TokEMS Admin uses OAuth Device Authorization with public client ID `tokems-admin-skill`, an ES256 P-256 DPoP key, a 10-minute access token, rotating 30-day refresh tokens, and a 90-day absolute connection lifetime.

The connector accepts one exact origin during `instance inspect` or `auth connect`. Remote origins require HTTPS. Local development accepts loopback HTTP. Redirects, credentials in URLs, paths, queries, fragments, host changes, and free request URLs are rejected.

Full connection approval requires the configured TokEMS super administrator, an active browser session, the same device `user_code`, and password step-up. Compare the code displayed by the connector with the code on the TokEMS approval page before approving. Approved scopes are the intersection of requested scopes, delegated grants, catalog requirements, and organization ownership. The default policy asks the browser to approve controlled and critical operations.

Version `0.2.0` is bound to Agent catalog `1.2.0` and API major `1.0.0`. Connections authorized by `0.1.x` must be revoked or left inactive and reauthorized with `0.2.0` after reviewing all 87 actions. The server rejects connector versions below the advertised minimum and active connections whose catalog version differs from the live catalog. `tokems:*` expands to the concrete scopes shown on the approval page and never widens the organization boundary.

Private DPoP material, refresh tokens, the short-lived access-token cache, and the local data key live in macOS Keychain or Linux Secret Service. An unavailable or locked credential store blocks connection. The connector performs a write/read/delete check before starting authorization.

Revoke the local connection and the remote TokEMS connection when the device is lost, the AI platform changes, the administrator changes, or suspicious replay activity appears.

Only configured super administrators can approve devices, approve critical operations, inspect Agent security metrics, change connection policies, or revoke connections. A refresh response can be recovered by the same DPoP-bound connection for two minutes; reuse outside that window revokes the whole token family and its connection. Emergency revoke-all also invalidates outstanding refresh tokens.
