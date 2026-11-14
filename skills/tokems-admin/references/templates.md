# Templates

Identify structured and HTML templates before editing. Read revision, version history, variables, assets, bindings, usage, and security report.

Structured drafts use revision checks. HTML imports retain upload reservation, sanitization, scanning, blocker review, binding, preview, and commit stages. A blocker stops publication.

Use the bounded structured-template command for local edits:

```bash
node scripts/tokems-admin.js template patch \
  --template <template-id> \
  --patch-file <absolute-json-path> \
  --reason-file <absolute-text-path>
```

The command reads `templates.draft.get`, captures the live revision, applies the patch in memory, and prepares one complete `templates.draft.update` body. It never confirms, executes, publishes, or binds the template automatically. Supported patch sections are `seo`, `homeBlocks`, `homeOrder`, `flowSteps`, `faqItems`, and `organizationGroups`. Home, flow, and FAQ items use stable `nodeKey` values. Unknown nodes, duplicate nodes, unsupported fields, unsafe object keys, and a home order that omits any current node stop before preparation. Omitted fields preserve the live value. A `null` value inside a home block `content` object deletes that key.

`organizationGroups` accepts ordered `speaker`, `media`, and `member` groups with `label`, `meta`, and `organizations`. Configured groups render first in template order. An omitted group is derived from live public speaker/member data. An explicit empty `organizations` array hides that group. Organization names are deduplicated across groups, and the earliest displayed group keeps the name.

Use `template pull --template <id> --output <absolute-path>` to save the live draft, revision and usages. `template diff --template <id> --patch-file <path>` shows the candidate field changes. `template preview --template <id> --event <id> --patch-file <path> --reason-file <path>` prepares an isolated candidate preview. Structured and scanned HTML candidates use the selected real event. Preview creation leaves the draft, binding and public release unchanged; its 30-minute link is delivered through the protected artifact. Preview pages disable submissions and analytics.

For images use `asset prepare --file <path> --media-type image/png --alt-text <text> --reason-file <path>`. After confirmation, browser approval and execution, `asset upload --operation <id> --file <same-path> --reason-file <path>` uploads the exact approved bytes and prepares asset registration. HTML imports use the same upload command after `templates.html-imports.prepare`; it prepares the scan action. Uploads accept only the storage origins announced by the authorized instance, a matching SHA-256 and size, permitted headers and an unexpired grant. Redirects are rejected and TokEMS credentials stay on the instance origin. Source HTML is limited to 5 MiB; the scanner enforces its sanitized-document limits.

If execution was interrupted after commit, rerun `action execute --operation <same-id>` to recover the original one-time artifact. This path reads escrow and saves it before acknowledgement. It does not execute the business write again.

Publishing creates an immutable version. Binding or upgrading an event verifies its template binding and event release. Rollback uses the prior revision, immutable version, binding, or event release named by the operation.

When a template change affects a published event, execution verifies the admin release plus the public event API and rendered public page on the pinned TokEMS origin. The result contains digests and status metadata only.

Each organization may retain at most 50 candidate snapshots totaling 64 MiB. Capacity is reserved atomically; `TEMPLATE_PREVIEW_LIMIT` leaves existing links intact until expiry. Configured object-storage images and fonts remain available in HTML previews, with scripts and forms disabled. Artifact export preserves existing destination-directory permissions.
