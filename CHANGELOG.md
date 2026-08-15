# Changelog

All notable changes to TokEMS will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added additional-seat purchases with separate purchaser and attendee identities, durable purchase intents, attendee claim invitations, and customer purchase history.
- Added attendee showcase profiles, a public member directory, shareable attendee pages, personal poster generation, avatar processing, and moderation controls.
- Added invoice batch preflight/import workflows, richer registration exports, and administrator account management.
- Added dashboard metrics for paid orders, paid seats, confirmed attendees, and distinct purchasers.

### Changed

- Made mainland-China mobile OTP the primary customer entry path and enforced one active registration identity per event through repair tooling and database constraints.
- Simplified customer invoice submission to company name, tax identifier, and email while retaining the previous v1 request contract during the compatibility window.
- Consolidated organization and event settings navigation while retaining redirects for removed content routes and the aggregate integration-status API.
- Added build migration hashes to runtime health checks so API and Worker startup can detect schema drift.

### Fixed

- Prevented expired pending-payment orders from blocking a purchaser's next checkout while background cleanup is still pending.
- Preserved customer-facing invoice and integration API compatibility for previously deployed clients.
- Corrected dashboard trend fixtures and generated project inventory after the metrics and test suites expanded.

### Security

- Restricted proxy-purchased ticket codes, QR payloads, checkout responses, and order-token retrieval to the attendee identity.
- Added stricter tenant and ownership checks, encrypted notification payload secrets, persistent purchase-attempt throttling, transaction retries, and a production-safe local payment simulation allowlist.
- Bound generated order and invoice access tokens to their notification delivery so retries reuse one sealed capability and terminal failures revoke it.
- Revoked customer sessions on account blocking and pinned the transitive `nanoid` dependency to a patched release.

### Planned

- Continue security and production deployment hardening.
- Add `zh-CN` and `en-US` support to the admin console.
- Publish `v0.1.0` as the initial public preview.

## [0.1.0] - 2026-08-01

### Added

- Template-driven conference websites and release snapshots.
- Registration, ticket inventory, orders, payment callbacks, refunds, digital tickets, and waitlists.
- Admin workflows for events, templates, attendees, registrations, invoices, notifications, settings, and audits.
- Device enrollment, QR check-in, offline synchronization, and duplicate detection.
- Multi-organization isolation, role-based access control, encrypted integration credentials, Outbox delivery, and rate limits.
- Docker Compose deployment, database migrations, demo seeds, and automated acceptance tooling.

### Changed

- Replaced project-specific prototype content with neutral TokEMS demo data.
- Added Chinese and English repository introductions and an internationalization roadmap.

[Unreleased]: https://github.com/yaojingang/TokEMS/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yaojingang/TokEMS/releases/tag/v0.1.0
