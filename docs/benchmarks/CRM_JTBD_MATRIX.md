# CRM JTBD validation matrix

A validation catalogue of classic CRM jobs-to-be-done, tracking what the framework genuinely supports today. This is **not** a marketing claim: a JTBD is marked *validated end to end* only when an automated test or a checked-in example proves it, with evidence linked. Status is deliberately conservative.

Status legend:
- **not supported** — no primitive exists.
- **partially supported** — some primitives exist; the job cannot be completed without significant handwritten work.
- **technically supported** — the job can be built with current primitives, but no end-to-end proof exists yet.
- **validated end to end** — an automated test or example proves the full job, evidence linked.

Every row: actor · trigger · desired outcome · required CRM primitives · required framework capabilities · acceptance scenario · status · evidence · manual interventions.

---

## JTBD-01 — Manage a custom CRM business object end to end
- **Actor**: developer/agent building for a business user; then the business user.
- **Trigger**: "we need to track <object> that no packaged CRM models well."
- **Desired outcome**: create the object type, then list/create/view/edit its records through the Admin.
- **Primitives**: module, fields, service (create/get/list/update), audit, events.
- **Framework capabilities**: manifest → factory → migration → registration → HTTP API → SDK → schema discovery → generic Admin.
- **Acceptance scenario**: apply the Partner manifest; the module appears in `/api/schema` and the Admin nav; a user creates, opens and edits a Partner record; audit and events are produced; no page code is written.
- **Status**: **validated end to end** (Milestone 4).
- **Evidence**: `tests/module-factory-e2e.test.js` (manifest→apply→runnable), `tests/generated-api-e2e.test.js` (API/SDK), `tests/admin-modules.test.js` + `tests/admin-core.test.js` (Admin list/create/detail/edit with audit+events, real server + fake DOM); `docs/ADMIN.md`. A one-off **real-Chromium** smoke (16 checks incl. XSS-as-text) was run manually during the Milestone 4 review and passed; `docs/ADMIN_SMOKE.md` is the reproducible checklist. Automated browser testing is not in CI.
- **Manual interventions**: writing the manifest and running `module create --apply`; the real-browser smoke is manual (not in CI), not a coding step.

## JTBD-01b — Associate a generated CRM record with another generated CRM record
- **Actor**: developer/agent modelling a relationship; then the business user.
- **Trigger**: "every X belongs to a Y" (e.g. every Partner Contact belongs to a Partner).
- **Desired outcome**: create the dependent object with a reference to the target, view and change the linked target.
- **Primitives**: reference field, foreign key, reference resolver, target service boundary, audit, events.
- **Framework capabilities**: manifest reference → FK migration → runtime target validation → API/SDK → schema relationship metadata → Admin target selector.
- **Acceptance scenario**: apply Partner, then Partner Contact (`partnerId → partner`); create Partners; create a Contact linked to Partner A via SDK; see A's label selected in the Admin; change to Partner B; missing target → validation error; relationship persists across restart; audit/events exactly once on success, none on failure.
- **Status**: **validated end to end** (Milestone 5), for **generated-to-generated many-to-one** references only.
- **Evidence**: `tests/reference-resolver.test.js`, `tests/reference-fields-e2e.test.js` (real server + SDK + SQLite FK + restart), `tests/admin-modules.test.js` (selector, current-target-outside-first-page, hostile label as text), `tests/module-factory.test.js` (plan/generation, core/missing-target rejection); a real-Chromium reference-selector smoke (5 checks) was run manually. `docs/MODULE_FACTORY.md`, ADR-010.
- **Manual interventions**: writing two manifests and applying the target first; real-browser smoke is manual (not in CI).
- **Scope note**: this validates generated-to-generated many-to-one relationships only — **not** a complete CRM relationship model. Generated-to-core references, many-to-many, inverse collections and cascade/delete are out of scope. Optional self-references are supported and tested; required self-references are rejected at plan time; cross-module cycles are not constructible via the CLI and are not claimed.

## JTBD-02 — Request commercial approval on a deal
- **Actor**: sales rep (submits), manager (decides).
- **Trigger**: a renewal ≥ threshold is moved toward Proposal.
- **Desired outcome**: the deal parks in Approval Pending until a human decides; agents cannot self-approve.
- **Primitives**: opportunity, approval, deterministic workflow, human-only policy, audit, trace.
- **Framework capabilities**: named workflow, policy, actor identity, approval service.
- **Acceptance scenario**: €80k renewal → Approval Pending; only `actor.type === 'user'` can decide; trace + audit recorded.
- **Status**: **validated end to end** (Milestone 0), for the built-in renewal object.
- **Evidence**: `tests/workflow.test.js`, `tests/api.test.js`, `npm run smoke`.
- **Manual interventions**: none for the built-in slice; a *custom* object's approval flow is not yet generated (see JTBD-06).

## JTBD-03 — Manage a deal through pipeline stages
- **Actor**: sales rep.
- **Trigger**: deal progresses.
- **Desired outcome**: move a deal across stages with policy enforced at transitions.
- **Primitives**: opportunity, stage enum, stage-change workflow.
- **Framework capabilities**: workflow, policy, trace.
- **Acceptance scenario**: move an opportunity to Proposal; policy evaluates; trace recorded.
- **Status**: **validated end to end** for the built-in opportunity object; **partially supported** for generated modules (no generated stage workflow/UI).
- **Evidence**: `tests/workflow.test.js`.
- **Manual interventions**: custom-object pipelines need a handwritten workflow.

## JTBD-04 — Capture a lead
- **Actor**: marketing/inbound.
- **Trigger**: a new prospect arrives.
- **Desired outcome**: persist a lead with validation and audit, starting in a known lifecycle state.
- **Primitives**: generated Lead module, managed `status` field with default, service, audit, events.
- **Framework capabilities**: manifest (with `writable: "managed"` + `default`) → factory → API/SDK/Admin.
- **Acceptance scenario**: create a Lead via API/SDK/Admin; it persists with `status: "new"`, null qualification fields, one create audit and one event; `status` cannot be supplied at create.
- **Status**: **validated end to end** (Milestone 6), for the starter's Lead model.
- **Evidence**: `tests/lead-qualification-e2e.test.js` (API/SDK create → default `new` → persistence/audit/event, restart), `examples/starters/b2b-lead-qualification/install.mjs`; Admin create covered by the generic Admin tests plus a manual real-Chromium smoke (`docs/ADMIN_SMOKE.md`).
- **Manual interventions**: applying the starter manifests; no dedup or source-tracking primitives.

## JTBD-05 — Qualify (or disqualify) a lead
- **Actor**: SDR.
- **Trigger**: a `new` lead is worked.
- **Desired outcome**: an explicit, auditable lifecycle transition that generic CRUD cannot bypass.
- **Primitives**: code-first record action, managed fields, outer transaction, transaction-scoped event buffer, trace, audit.
- **Framework capabilities**: action registry/runtime (ADR-011/012), generic action route/SDK/Admin controls.
- **Acceptance scenario**: qualify a `new` lead → `status: "qualified"` + exactly one follow-up Task, atomically, with actor/audit/events/trace; repeat and concurrent qualify → one stable 409, no duplicate; disqualify requires a non-blank reason, sets `disqualified`, creates no Task; CRUD attempts on managed fields → field-tied 400; state survives restart.
- **Status**: **validated end to end** (Milestone 6), for the starter's qualify/disqualify actions.
- **Evidence**: `tests/lead-qualification-e2e.test.js` (atomicity/rollback, repeat 409, same-instance concurrency, CRUD-bypass matrix, restart), `tests/action-runtime-semantics.test.js` (two-connection concurrency, commit-failure injection, post-commit dispatch policy, corrupted-state safety), `tests/action-contract.test.js`, `examples/starters/b2b-lead-qualification/`; Admin buttons validated in `tests/admin-actions.test.js` plus a manual real-Chromium smoke (`docs/ADMIN_SMOKE.md`).
- **Manual interventions**: registering the starter's actions in `packages/actions/generated/index.js`; lead **scoring** remains out of scope (no scoring primitive).

## JTBD-05b — Convert a qualified lead into Company, Contact and Opportunity
- **Actor**: SDR / account executive.
- **Trigger**: a qualified lead becomes a real deal.
- **Desired outcome**: one action creates (or deterministically reuses) the Company and Contact and opens exactly one Opportunity, atomically, with conversion links on the Lead.
- **Primitives**: code-first action, managed conversion fields, core-module adapters (ADR-013), outer transaction, database-unique opportunity source key, audit, events, trace.
- **Framework capabilities**: action registry/runtime over generated modules + declared adapters into the handwritten core CRM; `integer` action input (money as minor units).
- **Acceptance scenario**: convert a qualified lead → Company created or reused on an exact normalized-name match (ambiguity refused with 409), Contact created or reused by unique email (cross-company clash refused with 409), exactly one Opportunity (`lead-conversion:<leadId>` unique in the database), one atomic managed update writes status `converted` + all three links; repeat and concurrent conversions yield stable 409s with no duplicates; a failure at any step rolls everything back without touching pre-existing reused records; state survives restart; CRUD cannot write conversion fields.
- **Status**: **validated end to end** (Milestone 7), for the starter's convert action.
- **Evidence**: `tests/lead-conversion-e2e.test.js` (full flow over HTTP/SDK, reuse/ambiguity/mismatch policies incl. Unicode normalization, source-key squat, COMMIT fault injection, post-commit subscriber failure, same-lead and cross-connection concurrency, shared-company concurrent conversions, migration v2 upgrade, restart), `examples/starters/b2b-lead-qualification/install.mjs` (two conversions sharing one Company), `tests/action-contract.test.js` (integer input), `tests/admin-actions.test.js` (integer control). Admin Convert flow additionally exercised in a manual real-Chromium smoke (`docs/ADMIN_SMOKE.md`).
- **Manual interventions**: registering the starter's actions; leads without a `companyName` must have one set before converting.
- **Scope note**: exact deterministic reuse only — **no** fuzzy deduplication, account hierarchies, pipeline movement, or forecasting. Conversion targets the built-in core Company/Contact/Opportunity modules.

## JTBD-06 — Manage a custom object with an approval rule
- **Actor**: business user on a generated object.
- **Desired outcome**: a generated module whose mutations enforce a human-approval policy.
- **Status**: **partially supported** — generated CRUD is validated (JTBD-01), but the factory does not yet generate workflows/approvals for custom objects.
- **Evidence**: JTBD-01 evidence; approval primitives exist but are handwritten.
- **Manual interventions**: write the workflow by hand.

## JTBD-07 — Schedule next actions / follow-ups
- **Status**: **partially supported** — narrowly: **the first follow-up Task is created as part of Lead qualification** (Milestone 6). There is still no reusable task engine, no scheduling/delayed-workflow primitive, no reminders, no queues, no recurring work.
- **Evidence** (for the narrow slice only): `tests/lead-qualification-e2e.test.js` (exactly one Task with a deterministic idempotency key, atomic with the qualify transition); the starter's Task module is an ordinary generated module.
- **Manual interventions**: anything beyond that first Task is handwritten.

## JTBD-08 — Hand off a won deal
- **Status**: **partially supported** — cross-module workflows with compensation exist as a primitive; no built-in handoff.
- **Evidence**: workflow engine (`tests/workflow.test.js`).

## JTBD-09 — Onboard a customer
- **Status**: **not supported** — no checklist/onboarding primitives.

## JTBD-10 — Manage contracts and renewals
- **Status**: **partially supported** — the renewal-approval slice is validated; general contract lifecycle (dates, terms, auto-renewal) is not modeled.
- **Evidence**: `npm run smoke`, `tests/workflow.test.js`.

## JTBD-11 — Identify churn risk
- **Status**: **not supported** — no health-scoring/activity primitives.

## JTBD-12 — Identify upsell
- **Status**: **not supported** — no usage/entitlement primitives.

## JTBD-13 — Report pipeline
- **Status**: **partially supported** — data is queryable via API/SDK and the dashboard shows counts; no reporting/aggregation surface for generated modules.
- **Evidence**: `/health` counts, dashboard.

## JTBD-14 — Integrate email / calendar / marketing
- **Status**: **not supported** — only an in-memory notification provider contract exists; no email/calendar/marketing adapters.

## JTBD-15 — Enforce team / tenant permissions
- **Status**: **not supported** — no authentication, tenancy or RBAC. The server is local-development-only. This is a hard prerequisite before any remote exposure.

---

## Summary

- **Validated end to end**: JTBD-01 (custom business object), JTBD-01b (generated-to-generated reference), JTBD-02 (renewal approval, built-in object), JTBD-04 (capture a lead, starter model), JTBD-05 (qualify/disqualify a lead, starter actions), JTBD-05b (convert a qualified lead into Company/Contact/Opportunity, starter action).
- Deliberately **not** marked validated: pipeline for custom objects, a general task engine/scheduling (only the first follow-up Task inside qualification is proven — JTBD-07 stays partial), onboarding, churn/upsell, reporting, integrations, permissions. Primitives for some exist, but no end-to-end proof does.

This matrix guides roadmap prioritization: the largest gaps blocking common CRM adoption are a reusable Activity/Task engine with scheduling (JTBD-07), generated workflows/approvals for custom objects (JTBD-06), and the auth/tenancy/RBAC prerequisite (JTBD-15).
