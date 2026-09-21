# Spine v2 M4C — HTTP / SDK / Admin / CLI

M4A stored caller-visible write outcomes. M4B leased the writer. M4C carries that key across the public surfaces.

## What this slice does

- HTTP write routes read `Idempotency-Key`, pass it into the outcome envelope, and echo it on the response (including `COMMIT_OUTCOME_UNKNOWN`).
- The SDK forwards the same header on mutating calls.
- The Admin form/action controller issues and retains one root key per deliberate submission. Low-level `fetch` refuses a mutation without that context. Double-click joins the pending promise. A changed payload under a retained key is a client-side divergent replay.
- Durable browser recovery stores key, issued-at, route and request fingerprint only — never credentials or domain payload.
- `GET /api/write-outcomes/:key` is tenant-and-subject bound. Another subject's key is 404. The projection has no response body.
- `POST /api/write-outcomes/:key/ack` is an idempotent child operation (`admin-ack`).
- `POST /api/write-outcomes/:key/reconcile` is the HTTP face of unknown-commit recovery.
- Workflow `run` on PostgreSQL is an outcome envelope. An inner `transactionAsync` becomes a savepoint on the affine client.

## What this slice does not do

- Shared-database row tenancy
- Spine v3 jobs/outbox/scheduler
- Spine v4 secrets/backups/observability
- Accordo Cloud
- General production-readiness claim
- JTBD promotion
