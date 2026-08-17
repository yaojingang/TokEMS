# Templates

Identify structured and HTML templates before editing. Read revision, version history, variables, assets, bindings, usage, and security report.

Structured drafts use revision checks. HTML imports retain upload reservation, sanitization, scanning, blocker review, binding, preview, and commit stages. A blocker stops publication.

Template asset and HTML-import upload preparation returns signed metadata through an encrypted local one-time artifact. Download that artifact to a protected mode-`0600` path and complete the binary upload through the approved TokEMS upload flow. Version `0.1.1` does not send bytes to a separate object-storage origin.

Publishing creates an immutable version. Binding or upgrading an event verifies its template binding and event release. Rollback uses the prior revision, immutable version, binding, or event release named by the operation.

When a template change affects a published event, execution verifies the admin release plus the public event API and rendered `home-document` on the pinned TokEMS origin. The result contains digests and status metadata only.
