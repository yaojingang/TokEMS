# Feishu Digest Reads

Version `0.2.0` exposes five read-only actions:

- `integrations.feishu.get`: masked connection status.
- `integrations.feishu.chats.list`: chats already visible to the configured application.
- `communications.feishu-digest.get`: one event's digest configuration.
- `communications.feishu-digest.preview`: aggregated daily, cumulative, todo, and monitoring metrics.
- `communications.feishu-digest.deliveries.list`: delivery history.

The preview is a sensitive financial read. Supply an explicit 8–1000 character purpose file and require `tokems:finance`, `org.settings.read`, and `event.dashboard.read`. Summaries may report aggregate counts and status. Keep chat identifiers, operator details, raw delivery payloads, and finance detail minimized.

Feishu bot credential changes, verification, chat refresh, subscription edits, test sending, scheduled activation, and manual resend remain human-only. Direct the operator to the TokEMS browser admin when the task needs one of those actions and report `missing evidence` until the human workflow is verified.
