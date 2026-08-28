# Communications, Check-in, and Exports

Notification preparation fixes an audience snapshot and count. Audience drift invalidates the operation. Real delivery is controlled; all-audience, over 100 recipients, or accumulated high-impact delivery rises to critical. Queue acceptance and provider delivery are separate evidence.

Check-in device tokens are one-time secrets. Offline batches use one idempotency key and request hash; the same key with changed input is rejected. Verify duplicate, invalid, forbidden, and manual-review results.

Exports use approved filters, absolute output paths, mode `0600`, byte count, SHA-256, and explicit retention responsibility. Presigned upload or download targets must come from the same approved TokEMS operation, use HTTPS, omit TokEMS authorization, and reject redirects.

Attendee-question exports use the same artifact boundary. The `speaker` variant carries only anonymous content and topic labels; the connector refuses `forceAnonymous=false`. Internal variants retain PII classification and require the exact approved filters.
