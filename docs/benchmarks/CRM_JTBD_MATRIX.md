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
- **Scope note**: this validates generated-to-generated many-to-one relationships only — **not** a complete CRM relationship model. Generated-to-core references, many-to-many, inverse collections and cascade/delete are out of scope.

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
- **Desired outcome**: persist a lead with validation and audit.
- **Primitives**: a lead-like module (company/contact or a generated module), service, audit.
- **Framework capabilities**: modules, generic API/Admin.
- **Acceptance scenario**: create a lead record via Admin/API with audit.
- **Status**: **technically supported** (model it as company/contact or a generated module); not validated as a named "lead capture" flow.
- **Evidence**: company/contact modules; generated-module CRUD.
- **Manual interventions**: choose/define the lead model; no dedup or source-tracking primitives yet.

## JTBD-05 — Qualify a lead
- **Actor**: SDR.
- **Trigger**: a lead needs scoring/qualification.
- **Desired outcome**: record qualification state via explicit rules.
- **Status**: **partially supported** — enum/boolean fields exist; there is no scoring/qualification workflow primitive.
- **Evidence**: field types (`tests/module-manifest.test.js`).
- **Manual interventions**: handwritten qualification logic.

## JTBD-06 — Manage a custom object with an approval rule
- **Actor**: business user on a generated object.
- **Desired outcome**: a generated module whose mutations enforce a human-approval policy.
- **Status**: **partially supported** — generated CRUD is validated (JTBD-01), but the factory does not yet generate workflows/approvals for custom objects.
- **Evidence**: JTBD-01 evidence; approval primitives exist but are handwritten.
- **Manual interventions**: write the workflow by hand.

## JTBD-07 — Schedule next actions / follow-ups
- **Status**: **not supported** — no Activity/Task module or scheduling/delayed-workflow primitive yet (roadmap Milestone 5+).
- **Manual interventions**: N/A.

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

- **Validated end to end**: JTBD-01 (custom business object), JTBD-02 (renewal approval, built-in object).
- **First Milestone 4 target achieved**: JTBD-01 — a user can define a module through the framework and then list, create, view and edit records through the Admin with audit/events and no manual page coding.
- Deliberately **not** marked validated: lead capture/qualification, pipeline for custom objects, follow-ups, onboarding, churn/upsell, reporting, integrations, permissions. Primitives for some exist, but no end-to-end proof does.

This matrix guides roadmap prioritization: the largest gaps blocking common CRM adoption are Activity/Task + follow-ups (JTBD-07), generated workflows/approvals for custom objects (JTBD-06), and the auth/tenancy/RBAC prerequisite (JTBD-15).
