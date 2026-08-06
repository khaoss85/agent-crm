# Data governance

**Status: design only. None of this is implemented, and nothing here is legal
advice or a compliance claim.**

A CRM is a personal-data system by definition: it exists to hold names, email
addresses, phone numbers, job titles, meeting notes and behavioral signals about
identifiable people. Eleven milestones built the commercial machinery around
that data and none of the governance for it. This document names the missing
pillar so it is a track with a milestone, not an afterthought discovered at the
first customer security review.

## What exists today

- Every mutation is audited with an actor and a timestamp (ADR-002 discipline, all milestones).
- Every action produces a trace run with spans.
- Managed and read-only records cannot be rewritten through public CRUD.
- Provider payloads are normalized into bounded contracts; raw payloads and secrets are never stored, logged or echoed.
- The M9 enrichment snapshot records provenance for data received from a provider.

That is honest audit hygiene. It is **not** governance: nothing classifies a
field as personal, records a lawful basis, expires anything, exports a subject's
data or deletes it.

## What is missing

### Classification

A manifest-level marker for personal data — at minimum `personal`, `sensitive`
and `pseudonymous` — carried by the generated module so downstream tooling
(export, redaction, logging, analytics) can act on it mechanically rather than
by convention.

### Consent and lawful basis

A record per subject and purpose: basis, purpose, source, evidence, captured-at,
withdrawn-at. Immutable history — a withdrawal adds a record, it never edits
one. Marketing use must be answerable from data, not from someone's memory.

### Communication preferences

Channel-level opt-in/opt-out with an audit trail and a global suppression list
that every future outbound provider must consult before sending.

### Provider-sharing history

Which fields went to which provider, under which connection, when, and under
which basis. M9 records enrichment provenance *inbound*; nothing records
*outbound* sharing.

### Retention

Per-record-type retention policies with a defined action at expiry (delete,
anonymize, archive), executed by a scheduled job — which does not exist yet
(`JOBS_AND_OUTBOX.md`) — and evidenced when it runs.

### Audit retention

Audit and trace rows are personal data too (they name actors and records). They
need their own retention window, and it is usually longer than the business
data's, which is exactly why it must be explicit.

### Subject access and export

Given a subject, produce everything held about them across core modules,
generated modules, snapshots, events, audit and traces — in a documented format,
bounded, and without exporting other subjects' data.

### Deletion and anonymization

The hard part, and the reason this document exists: **commercial evidence is
deliberately immutable.** A signed Order, a Quote Version and an audit trail
must not be rewritable — that is the guarantee M10 and M11 are built on. A
deletion request therefore cannot mean "delete everything".

The intended shape, to be decided with a real legal review:

- **Anonymize personal fields** on immutable evidence in place of deleting the row (name → tombstone, email → hash or null), preserving amounts, dates and links.
- **Delete freely** where the record's purpose is personal contact data with no commercial evidence value.
- **Record the erasure itself** as evidence: what was anonymized, when, under which request.
- **State the conflict openly** — some data is retained under a different lawful basis, and the export must say which and why.

This is the single hardest design in the track, and it must not be improvised
inside a delivery milestone.

### Tenant boundary and residency

No tenant column exists; every governance control above is single-tenant until
the Production Spine. Residency (where rows physically live) is a Cloud concern
and is unanswered.

### Encryption expectations

At rest: the deployment's responsibility today (SQLite file permissions); no
application-level encryption exists. In transit: TLS is the deployment's
responsibility; the framework's HTTP server is local-development-only.
Field-level encryption for sensitive columns is future work.

### Data minimization at the boundary

Webhook and provider payloads should be reduced to the normalized contract as
early as possible — already the practice in M10/M11 — and the practice should
become a stated rule with a test, not a habit.

### Secret handling

Covered in `INTEGRATION_RUNTIME.md`: references, never plaintext; never in the
database, schema, audit, trace, error or log.

### Policy version history

Governance policies (retention, classification, basis) are versioned code-first
definitions like scoring and discount policies, so a past decision stays
explainable after the policy changes.

## Future JTBDs (all *not supported*)

| ID | Job |
|---|---|
| DG-01 | Record consent and lawful basis for a subject and purpose |
| DG-02 | Honor a channel opt-out across every outbound path |
| DG-03 | Export everything held about a subject |
| DG-04 | Anonymize or delete a subject while preserving immutable commercial evidence |
| DG-05 | Apply a retention policy automatically and evidence that it ran |
| DG-06 | Inspect which personal data was shared with which provider, when and why |
| DG-07 | Restrict access to sensitive fields by role |
| DG-08 | Prove a deletion request completed, and what was retained and why |

DG-05 needs the scheduler; DG-07 needs RBAC; DG-04 needs the anonymization
design above plus a legal review.

## Boundaries

This document does **not** claim GDPR, CCPA or any other compliance, does not
give legal advice, and does not assert that implementing it would make a
deployment compliant. Compliance is a property of a deployment, its contracts
and its operator — the framework can only make the controls possible and the
evidence honest.
