# Milestone 7 — convert a qualified Lead into Company, Contact and Opportunity

## Goal and user-visible outcome

```text
Qualified Lead → convert → Company (created or reused)
                         → Contact (created or reused)
                         → Opportunity (exactly one)
                         → conversion links on the Lead
                         → audit / events / trace
```

One atomic, idempotent `lead.convert` action over the existing action runtime
(ADR-011/012). No Lead-specific endpoint, no pipeline/kanban, no fuzzy
deduplication, no workflow DSL.

```js
await client.module('lead').action(leadId, 'convert', {
  opportunityName: 'Acme — Enterprise',
  valueCents: 5_000_000,
  currency: 'EUR',
});
```

## Approaches compared (required)

1. **Convert into the existing handwritten Company/Contact/Opportunity
   modules, called directly from the action.** Reuses real modules, but action
   code would reach arbitrarily into core services — any method, no declared
   surface — which erodes the boundary ADR-008 draws around generated modules.
2. **Generate duplicate starter Company/Contact/Opportunity modules.** Keeps
   everything inside the generated world, but forks the core CRM objects: two
   Company models that don't see each other is exactly the "custom CRM that
   ignores the CRM" failure, and the approval workflow/policy would not apply
   to the duplicates. Rejected.
3. **Explicit, static adapters from actions to the handwritten core modules
   (chosen).** A per-app, frozen adapter registry with a handful of declared
   capabilities (`findCompaniesByNormalizedName`, `createCompany`,
   `findContactByEmail`, `createContact`, `createOpportunity`). Writes go
   through the real module services (validation, audit, events preserved);
   normalized-match reads live in the adapter, not in action code; nothing is
   auto-exposed over HTTP; no introspection, no dynamic import, no DSL.
   Recorded as **ADR-013**.

## Lead conversion state (chosen model)

`status` gains a fourth lifecycle value: `new | qualified | disqualified |`
**`converted`**. Convert declares `fromStates: ['qualified']`, so the existing
state guard — not new machinery — blocks converting an unqualified or
already-converted lead, and re-conversion is a stable `409 INVALID_STATE`.

New **managed** Lead fields (settable only via `applyManaged`, refused by
CRUD, shown read-only in the Admin): `convertedAt` (timestamp),
`convertedCompanyId`, `convertedContactId`, `convertedOpportunityId`
(strings — deliberately *not* `reference` fields, because generated-to-core
references are rejected by the factory until an explicit reference adapter
exists; ADR-010). All four are written in **one** `applyManaged` call together
with `status: 'converted'`, so there is exactly one lead-update audit/event and
no partial link state can exist.

**Starter compatibility:** the factory does not alter applied schemas
(ADR-007: applied migrations are immutable), so the extended Lead manifest
requires a fresh project — exactly how the starter is installed and tested.
Documented in the starter README.

## Company reuse policy (deterministic, exact)

Normalization: Unicode NFC → trim → collapse internal whitespace runs to one
space → `toLowerCase()` (JavaScript, not SQLite's ASCII-only `LOWER`). Then:

- **0 matches** → create a Company named with the *trimmed original* (never the
  lowercased form) through the real CompanyService.
- **1 match** → reuse it. No create audit/event is emitted for reused records.
- **>1 matches** → `409 CONFLICT` (`AMBIGUOUS_COMPANY`) naming the count — the
  framework refuses to guess. No fuzzy matching.

The find is a full scan of `companies` normalized in JS inside the core
adapter (local-development scale; documented). Leads with no `companyName`
fail validation before any write.

## Contact reuse policy (deterministic, exact)

`contacts.email` is globally UNIQUE in the core schema and stored lowercased.
Normalization: trim → `toLowerCase()`.

- **No contact with that email** → create one under the resolved Company (first
  name / last name from the Lead).
- **Contact exists and belongs to the resolved Company** → reuse.
- **Contact exists under a different Company** → `409 CONFLICT`
  (`CONTACT_COMPANY_MISMATCH`) — silently re-parenting a contact would corrupt
  another account.

## Opportunity + idempotency

Exactly one Opportunity per converted Lead:

- `name` = input `opportunityName`; `valueCents` = input (integer minor units);
  `currency` = 3-letter code, uppercased (default `EUR`); `type` =
  `new_business`; `stage` = `qualification` (first stage the pipeline already
  supports — no new stages); `owner` = input `owner` or the actor id;
  `companyId`/`contactId` = the resolved records.
- **Core migration v2** adds `opportunities.source_key TEXT` with a partial
  UNIQUE index (`WHERE source_key IS NOT NULL`) — existing rows and normal
  creates are untouched. The conversion sets `sourceKey =
  'lead-conversion:<leadId>'`, so even if the state guard were bypassed the
  database itself refuses a second conversion Opportunity.
- Money stays **integer minor units** (`valueCents`), the repo-wide rule. The
  action input contract gains an `integer` type (safe integers only; strings,
  fractions, NaN, unsafe magnitudes rejected); negative values are rejected in
  the action before any write.

## Concurrency

- Same lead, same server: `BEGIN IMMEDIATE` serializes; the loser re-reads
  `status = 'converted'` → `409 INVALID_STATE`.
- Same lead, two connections: the write-lock loser gets the M6 retryable
  `409 CONFLICT`; a retry then gets `INVALID_STATE`. Never a raw SQLITE error.
- Two *different* leads with the same company name / email, concurrently:
  writer serialization means the second conversion observes the first's
  Company/Contact and **reuses** them — no duplicate Company; the shared
  contact email either reuses or conflicts per the policy above.

## Transaction & failure

One outer transaction covers company find/create, contact find/create,
opportunity create, the single lead managed update, and every audit row.
Events flush only after commit (M6 buffer). Fault injection: contact-conflict
after company create, opportunity source-key squat after contact create, and
injected COMMIT failure — each must leave no new Company/Contact/Opportunity,
an unconverted Lead, no audit, no events, and an honest failed trace.
Rollback never deletes *pre-existing* reused records (it only undoes this
transaction's writes — asserted in tests).

## Surfaces

Generic action route/SDK/Admin only. Admin renders Convert for qualified,
unconverted leads (`fromStates` gating), an integer input control is added to
the generic action form (number field, whole-number client check), and the
conversion links appear read-only in the managed-fields panel after refresh.

## Milestones

- [x] ExecPlan (this document).
- [x] Core migration v2 (`opportunities.source_key` + partial unique index) and OpportunityService `sourceKey` support.
- [x] Core adapter registry (ADR-013) wired into the action ctx.
- [x] `integer` action-input type (registry, runtime, Admin form).
- [x] Extended Lead manifest + `convert` action in the starter; install/README updates.
- [x] Tests: conversion e2e (capture→qualify→convert→verify→repeat→concurrent→reuse→restart), fault injection, reuse/ambiguity/mismatch policies, CRUD-bypass on conversion fields, integer input validation, migration v2 upgrade.
- [x] Docs: ADR-013, ACTIONS/API/MODULE docs, JTBD matrix (evidence-first), TASKS.md.
- [x] `npm run verify` + smoke + starter + Chromium; PR open and unmerged.

## Fixed in the adversarial review (same PR)

1. **Corruption compounding.** A qualified lead carrying a stray conversion
   link (out-of-band write) converted successfully and silently overwrote the
   link. Convert now refuses any pre-set conversion field on a qualified lead
   with `409 CONVERSION_STATE_CORRUPT` — tested for all four fields.
2. **Minor-units ambiguity.** The Admin's "Value Cents" number field gave no
   cue that `500000` means `5,000.00`. Action inputs gained a validated,
   bounded `hint` rendered as text; convert's money and currency inputs use it.
3. **Explicit boundaries documented** (ADR-013): the public opportunity
   `sourceKey` write is deliberate (blocks visibly, cannot forge — the lead's
   links are authoritative); company lookup is a complete O(n) scan proven
   beyond 250 rows (no page-limit correctness dependency); conversion links
   are action-level guarantees, not SQL FKs; the old-Admin integer fallback is
   safe (text → server 400).
4. **Hardening**: the adapter registry is built once per app (was once per
   action call); convert validates `ctx.core` presence with a clear error and
   bounds `companyName` at the action-string limit; adapter construction fails
   closed on malformed dependencies (tested); two-app isolation, frozen
   registry, reused-contact identity preservation, same-email/same-company
   reuse, same-email/different-company concurrency, and audit/managed-update
   fault injections are all pinned by tests.

## Explicitly deferred

Pipeline stages/kanban, forecasting, fuzzy deduplication, account hierarchies,
quotes/products, task engine, reminders, email/calendar, durable outbox,
dashboards, OpenAPI, MCP mutation tools, PostgreSQL, auth/tenancy/RBAC, remote
exposure, deployment, telemetry, rename/license/publication.
