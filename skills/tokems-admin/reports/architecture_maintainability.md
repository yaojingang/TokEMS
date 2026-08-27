# Architecture maintainability

- Decision: `pass`
- Node.js source modules: `11`
- Node.js test modules: `3`
- CLI command handlers: `0`
- Largest module: `scripts/lib/operations.mjs` (512 lines)
- Watchlist: `0`; early watchlist: `0`; blockers: `0`

## Node.js inventory

- `scripts/lib/operations.mjs`: 512 lines
- `scripts/tokems-admin.mjs`: 370 lines
- `scripts/lib/auth.mjs`: 330 lines
- `scripts/lib/template-patch.mjs`: 284 lines
- `scripts/lib/files.mjs`: 228 lines
- `scripts/lib/http.mjs`: 128 lines
- `scripts/lib/credentials.mjs`: 110 lines
- `scripts/lib/catalog.mjs`: 105 lines
- `scripts/lib/crypto.mjs`: 97 lines
- `scripts/lib/redaction.mjs`: 21 lines
- `scripts/tokems-admin.js`: 13 lines

The repository-local augmentation inventories the required Node.js connector after the upstream Python-oriented audit.
