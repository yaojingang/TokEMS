# Architecture maintainability

- Decision: `pass`
- Node.js source modules: `10`
- Node.js test modules: `2`
- CLI command handlers: `0`
- Largest module: `scripts/lib/operations.mjs` (469 lines)
- Watchlist: `0`; early watchlist: `0`; blockers: `0`

## Node.js inventory

- `scripts/lib/operations.mjs`: 469 lines
- `scripts/tokems-admin.mjs`: 338 lines
- `scripts/lib/auth.mjs`: 322 lines
- `scripts/lib/files.mjs`: 228 lines
- `scripts/lib/http.mjs`: 128 lines
- `scripts/lib/credentials.mjs`: 110 lines
- `scripts/lib/crypto.mjs`: 97 lines
- `scripts/lib/catalog.mjs`: 89 lines
- `scripts/lib/redaction.mjs`: 21 lines
- `scripts/tokems-admin.js`: 13 lines

The repository-local augmentation inventories the required Node.js connector after the upstream Python-oriented audit.
