# Attendee Needs

Read `attendee-needs.list` with an 8–1000 character purpose file and `tokems:pii`. Use event-scoped filters for exact `questionId`, query, tag, visibility, moderation status, submission time, and pagination. The connector carries `questionId` into pre-state and post-state reads so approval, concurrency checks, and verification observe the affected question. Keep customer, registration, ticket, attribution, and question details out of chat output.

`attendee-needs.update` accepts `version`, `content`, `tagCodes`, and `reason`. `attendee-needs.moderate` accepts `version`, `action`, and `reason`; actions are `hide`, `restore`, `delete`, `restore-delete`, and `anonymize`. Both are controlled operations. Read the current list immediately before preparation, preserve its positive version, explain the moderation purpose, and stop on a version conflict.

After an update or moderation action, verify the admin list, public event payload, rendered home document, and `/api/v1/events/<slug>/attendee-needs?page=1`. Hidden, deleted, private, or ineligible questions must remain absent from the public response. Restored visible questions must match the approved content and anonymity state.

`attendee-needs.export` is critical and requires `tokems:pii`, `tokems:export`, `tokems:dangerous`, and browser step-up. The default `speaker` variant forces anonymity. Download the encrypted artifact to a new absolute path; the connector writes mode `0600`, verifies bytes and SHA-256, and refuses overwrite.
