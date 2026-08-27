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

Template asset and HTML-import upload preparation returns signed metadata through an encrypted local one-time artifact. Download that artifact to a protected mode-`0600` path and complete the binary upload through the approved TokEMS upload flow. Version `0.2.0` sends no bytes to a separate object-storage origin.

Publishing creates an immutable version. Binding or upgrading an event verifies its template binding and event release. Rollback uses the prior revision, immutable version, binding, or event release named by the operation.

When a template change affects a published event, execution verifies the admin release plus the public event API and rendered `home-document` on the pinned TokEMS origin. The result contains digests and status metadata only.
