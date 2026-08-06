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
- **Desired outcome**: move an Opportunity through a configurable sequence of stages to a terminal outcome, with server-enforced transitions.
- **Primitives**: code-first pipeline definition (ADR-014), server-managed pipeline state, generic `move-stage` action, optimistic `fromStage`, audit/events/trace, Admin board.
- **Framework capabilities**: pipeline registry → schema metadata → generic action route/SDK → board rendered from metadata.
- **Acceptance scenario**: a converted Opportunity enters the declared default stage; it moves through open stages and is marked won or lost (lost requires a reason); terminal stages refuse further moves; a stale `fromStage` and concurrent conflicting moves yield stable 409s with exactly one transition; state survives restart; CRUD cannot write pipeline fields; the board shows deterministic columns, counts and per-currency totals.
- **Status**: **validated end to end** (Milestone 8) for code-first pipelines on the built-in Opportunity module. The legacy fixed stage enum remains what the renewal-approval policy runs on (unchanged evidence: `tests/workflow.test.js`).
- **Evidence**: `tests/opportunity-pipeline-e2e.test.js` (default stage at conversion, transition rules incl. stale/same/terminal/corrupt/no-pipeline, same-app and cross-connection concurrency, restart, CRUD/HTTP bypass matrix, a second differently-shaped pipeline fixture), `tests/pipeline-contract.test.js`, `tests/admin-pipeline.test.js` (board order/counts/per-currency totals/XSS/move posting), `examples/starters/b2b-lead-qualification/install.mjs` (capture → qualify → convert → Discovery → … → Won/Lost); manual real-Chromium smoke (`docs/ADMIN_SMOKE.md`).
- **Manual interventions**: pipeline definitions are **code-first, generated and maintained by coding agents** in this milestone — there is no runtime pipeline editor for business admins. Custom-object (generated-module) pipelines are contract-ready but not yet proven end to end.
- **Scope note**: deliberately NOT validated: forecasting or weighted-value accuracy (probabilities are display metadata), quotas, runtime pipeline configuration by non-technical admins, saved views, filters/search, stage-duration analytics, approval-before-Won, general reporting.

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

## Future workstream JTBDs (from the Revenue/Delivery/Analytics handover)

The four product workstreams (`docs/strategy/REVENUE_OPERATIONS.md`, `DELIVERY_SERVICE.md`, `ANALYTICS_STUDIO.md`; milestones M9–M15 in `EXECUTION_ROADMAP.md`) introduce the JTBDs below. **Every newly introduced JTBD starts as *not supported*** — no primitive exists — except where an existing validated primitive earns *partially supported*, with the evidence named. None of these may move without linked automated evidence, and JTBDs involving real external users (partners, customers, role-scoped managers) additionally cannot reach *validated end to end* before authentication, tenancy and RBAC exist (Production Spine, JTBD-15).

### Lead Intelligence & Routing (Milestone 9 — implemented for the local slice, ADR-015)

| ID | Job | Status | Notes |
|---|---|---|---|
| JTBD-LI-01 | Enrich a Lead from external sources with snapshot + provenance | **validated end to end** | with a deterministic **fixture** provider behind the real provider contract — a real paid external provider is explicitly NOT validated (needs human-approved credentials) |
| JTBD-LI-02 | Calculate an explainable lead score | **validated end to end** | versioned model → ScoreRun + per-rule contributions; reproducible for identical inputs; bounds clamped |
| JTBD-LI-03 | Prioritize Leads by score | **partially supported** | the managed `score` exists on every scored lead; no sorted/prioritized list surface exists yet |
| JTBD-LI-04 | Route a Lead automatically under a published policy | **validated end to end** | versioned policy → RoutingRun (policy + target-set fingerprints) + per-target route-evaluation evidence + Assignment history; deterministic tie-break; fallback queue; active-workload capacity (released on conversion/disqualification); one final assignment under concurrency incl. a two-connection last-slot race |
| JTBD-LI-05 | Use sales capacity and availability in routing | **partially supported** | declared **capacity** against ACTIVE workload is enforced (full target excluded; slot released when a lead converts/disqualifies — tested); real availability/calendar data is NOT modeled |
| JTBD-LI-06 | Manually reassign with permission and reason | **not supported** | the assignment record carries `source`/`previousAssignmentId`/`reason` as future data, but no override action exists and none may claim manager permissions before the Production Spine (JTBD-15) |
| JTBD-LI-07 | Version and publish a scoring/routing policy | **validated end to end** | narrow wording: publication = code-first registration at startup; each version's fingerprint is persisted in `definition_versions`; an edited registered version stops the app; no runtime publishing UI |
| JTBD-LI-08 | Roll back a policy to an earlier version | **partially supported** | the mechanism is proven (a new version derived from an earlier definition registers cleanly; history immutable) but no end-to-end starter flow routes with a rolled-back version yet |
| JTBD-LI-09 | Reproduce a historical routing decision exactly | **partially supported** | runs persist model/policy identity + declared fingerprints, target-set fingerprint, per-target evaluation evidence (in/out, reason, load, capacity, priority) and fingerprints of the mutable lead inputs — but mutable lead-field VALUES are fingerprinted, not copied, and no automated re-execution harness exists |

**Evidence (LI-01/02/04/07)**: `tests/lead-intelligence-e2e.test.js` (full enrich→score→route over HTTP/SDK; snapshot provenance + reuse + expiry refresh; contribution order and totals incl. clamp; provider outage/timeout/invalid-data honesty; CRUD immutability matrix on all six record modules and the lead links; capacity exclusion; same-app and cross-connection concurrency with exactly one assignment; restart persistence; fingerprint drift stopping the next boot), `tests/intelligence-contract.test.js` (validation matrix, fingerprint determinism, persisted-version integrity, prepare-phase contract, hostile names), `examples/starters/b2b-lead-qualification/install.mjs` (Enterprise Italy / Spain Sales / fallback outcomes). Real Chromium coverage is the generic Admin smoke (`docs/ADMIN_SMOKE.md`); no dedicated intelligence browser step yet.

### Commercial Operations / CPQ (Milestones 10-11 implemented for the local slice, ADR-016 and ADR-017)

| ID | Job | Status | Notes |
|---|---|---|---|
| JTBD-CO-01 | Create a Quote from a Price Book | **validated end to end** | narrow wording: Opportunity → one price book → **composite Offers** (rate plans with several price components) → controlled server-priced lines mixing **one-time and recurring** charges with **flat / per-unit / volume / graduated** models and deterministic tier breakdowns → **grouped one-time + per-period totals** (never a single grand total) → immutable Quote Version snapshotting component definitions, tier schedules, breakdowns and provenance. NOT included: metered usage, overage, taxes, FX, proration, ramps, minimum commitments, attribute-based pricing, ARR/MRR/TCV |
| JTBD-CO-02 | Synchronize an external catalog (Stripe/Zuora/ERP/custom) | **partially supported** | validated only for a **deterministic fixture** catalog provider: immutable product versions and whole-offer revisions (components + tiers), idempotent re-sync, preserved provider provenance (`sourcePricingModel`, external ids), unsupported models refused rather than flattened, trace. The normalized model can represent Stripe one_time/recurring + volume/graduated tiers and Zuora one-time/recurring + Volume/Tiered pricing, but **real Stripe/Zuora/ERP adapters are not supported** (no credentials, no adapter ships) and full Stripe Billing / Zuora support is NOT claimed |
| JTBD-CO-03 | Request a discount under a deterministic policy | **validated end to end** | basis-point line discounts applied uniformly per component after tier calculation, evaluated by a versioned, fingerprinted discount policy over the grouped totals and component mix, with an explainable bounded decision recorded on the Quote Version |
| JTBD-CO-04 | Obtain required commercial approval on a discount | **partially supported** | the **human-actor boundary is validated** (agent actors refused 403; one atomic decision per version; concurrent decisions resolve to one winner) — but `requiredApprovalKey` is a label: **secure Sales-Manager/Finance role enforcement is not validated before RBAC** (JTBD-15) |
| JTBD-CO-05 | Create a signature envelope with a provider | **partially supported** | validated only for the **deterministic fixture** signature provider: human-actor send boundary (agents refused 403), exactly one envelope per quote version with a deterministic idempotency key, the provider call outside every transaction, a monotonic envelope/signer state machine, and a recoverable `failed` state with explicit reconciliation. **No real DocuSign / Adobe Sign / Dropbox Sign integration exists or is claimed**, and no credential ships |
| JTBD-CO-06 | Verify signing via verified provider events | **partially supported** | provider events are verified as the **raw signed bytes** before any state changes (constant-time HMAC + replay window in the fixture), replay is idempotent by DB-unique provider event id, out-of-order and post-terminal events are recorded and ignored, unknown envelopes are quarantined, and completion produces signed-artifact evidence (hashes, provider reference, signer evidence). Replay scope is provider + event id + payload fingerprint, a reused id with different bytes is refused, and a delivery whose processing failed is resumed rather than stranded. **The fixture verification key is test-only: production webhook security, secret management and legally qualified signature assurance are NOT supported, `artifactHash` is provider-reported, and no artifact byte is downloaded, hashed or cryptographically verified** |
| JTBD-CO-07 | Create an immutable signed Order snapshot | **validated end to end** | narrow wording: a verified completed signature creates, in one transaction, exactly one immutable Order (DB-unique per quote version) with lines, components, complete tier schedules, band breakdowns and grouped totals **copied from the approved Quote Version snapshot, never re-read from the live catalog**; duplicate, concurrent and reconciled completions still produce one Order; a real killed process mid-operation recovers by reconciliation with no second envelope; completion fault injection at artifact, order, line, component and total rolls back whole and retries to exactly one complete Order; a later catalog change leaves it byte-identical, and the Order renders its customer, offer, quantities, tier bands, recurrence and grouped totals from order rows alone; a decline or failure creates none. NOT included: fulfillment, billing, invoicing, payment, tax, FX, revenue recognition, amendments, cancellation, renewals |

**Evidence (CO-05/06/07)**: `tests/signature-order-e2e.test.js` (human-actor send boundary with an agent refused and nothing written, one envelope per version with a deterministic idempotency key, provider call outside every transaction with intent/external/finalize spans, verified delivered and completed events over the real HTTP route, signed-artifact evidence, one immutable Order whose components, tier schedules, band breakdowns and grouped totals equal the quote version field for field, catalog change after signing leaving both byte-identical, read-only CRUD matrix across all nine signature/order modules, exact reads, restart persistence, forged/missing/malformed/stale-timestamp webhooks refused 401 without echoing the payload or key, unknown-envelope quarantine, out-of-order and post-terminal events ignored, duplicate and concurrent webhooks producing one order, a reused provider event id unable to cross envelopes, webhook racing reconcile, a second app instance on the same database, provider outage and timeout leaving a recoverable failed intent, provider success + injected local finalization failure recovered by idempotency key, a lost webhook recovered by reconciliation, decline terminal with no order, and full lifecycle gating including superseded and foreign versions), `tests/signature-contract.test.js` (provider validation, registry fingerprints, the monotonic transition matrix including every terminal case, constant-time HMAC and replay bounds, provider-result normalization, signer bounds, structured input and phase-boundary freezing, bounded external timeouts), `tests/admin-signature.test.js` (one send control with its caveats, read-only evidence, reconciliation control on a failed envelope, XSS-as-text, graceful degradation), `examples/starters/b2b-lead-qualification/install.mjs` (signature request → verified events → artifact → order, forged webhook refused, replay and out-of-order ignored, decline with no order).

**Evidence (CO-01/03, and the partial parts of CO-02/04)**: `tests/commercial-e2e.test.js` (composite catalog sync + idempotency + whole-offer revisioning with historical quote evidence byte-identical after tier/price changes, mixed-recurrence quotes with grouped one-time/monthly/annual totals, volume and graduated breakdowns, unsupported-offer refusal, optimistic draft revisions, immutable version + component + total rows, read-only CRUD matrix across all fourteen commercial modules, human/agent approval boundary, concurrent submit and concurrent decision, two-connection draft race with no lost update, submission fault injection with full rollback, provider failure/timeout/invalid/bad-tier payloads with no partial catalog, policy-config drift stopping the boot, restart persistence, 520-row exact reads, hostile inputs and forged-amount rejection), `tests/commercial-contract.test.js` (provider/policy validation, fingerprint drift, tier-schedule validation matrix, volume/graduated boundary math at 1/10/11/20/100/101, flat-fee-charged-once, grouped totals, overflow/fraction/string/unsafe money inputs), `tests/admin-quotes.test.js` (component and tier rendering, grouped period totals with no ARR/MRR/TCV, lifecycle-dependent controls, server-authoritative amounts, action payloads, XSS-as-text, route parsing), `examples/starters/b2b-lead-qualification/install.mjs` (composite offer quote, mixed periods, auto-approve and human-approval paths, tier change with unchanged history).

### Delivery & Service (target: M12–M14)

| ID | Job | Status | Notes |
|---|---|---|---|
| JTBD-DS-01 | Hand over a won Deal to delivery | **partially supported** | same job as JTBD-08: cross-module workflows with compensation exist as a primitive (`tests/workflow.test.js`); no handover flow or delivery objects |
| JTBD-DS-02 | Create a Commessa / Delivery Project from an Order | **not supported** | no order or project primitives |
| JTBD-DS-03 | Involve a third-party delivery partner (engagement, role, scope) | **not supported** | no partner-engagement primitives |
| JTBD-DS-04 | Restrict partner access to assigned work only | **not supported** | requires RBAC/tenancy — hard-gated by the Production Spine (JTBD-15) |
| JTBD-DS-05 | Manage milestones and deliverables | **not supported** | no milestone/deliverable primitives |
| JTBD-DS-06 | Track hours and costs on delivery | **not supported** | no time-entry/expense primitives |
| JTBD-DS-07 | Calculate delivery margin (forecast vs actual) | **not supported** | no budget/margin primitives |
| JTBD-DS-08 | Manage a Change Request with impact and approval | **not supported** | approval primitive exists (JTBD-02) but no change-request object or versioned project scope |
| JTBD-DS-09 | Collect customer acceptance on deliverables | **not supported** | no acceptance primitives; real *customer* actors gated by the Production Spine |
| JTBD-DS-10 | Activate billing on accepted milestones | **not supported** | no billing-milestone primitives |
| JTBD-DS-11 | Activate a Service Contract with Entitlements and SLA | **not supported** | no service primitives |
| JTBD-DS-12 | Manage support cases and escalation | **not supported** | no case/escalation primitives |

### Analytics (target: M15)

| ID | Job | Status | Notes |
|---|---|---|---|
| JTBD-AN-01 | Define a trusted, explainable metric | **not supported** | no semantic model or metric-definition primitives |
| JTBD-AN-02 | Create a report from approved metrics/dimensions | **not supported** | no report/query-compilation primitives |
| JTBD-AN-03 | Create a role-aware dashboard | **not supported** | requires RBAC at the query boundary — gated by the Production Spine |
| JTBD-AN-04 | Version and roll back a dashboard | **not supported** | no dashboard-version primitives |
| JTBD-AN-05 | Validate metric correctness against fixtures | **not supported** | no metric test harness |

**Anti-inflation rule:** none of the broad JTBDs above may be marked *validated end to end* because an isolated constituent primitive lands. A row moves only when the *whole job* is proven by automated evidence — the same standard every existing validated row met.

---

## Summary

- **Validated end to end**: JTBD-01 (custom business object), JTBD-01b (generated-to-generated reference), JTBD-02 (renewal approval, built-in object), JTBD-03 (opportunity through configurable pipeline stages, code-first), JTBD-04 (capture a lead, starter model), JTBD-05 (qualify/disqualify a lead, starter actions), JTBD-05b (convert a qualified lead into Company/Contact/Opportunity, starter action).
- Deliberately **not** marked validated: pipeline for custom objects, a general task engine/scheduling (only the first follow-up Task inside qualification is proven — JTBD-07 stays partial), onboarding, churn/upsell, reporting, integrations, permissions. Primitives for some exist, but no end-to-end proof does.

This matrix guides roadmap prioritization: the largest gaps blocking common CRM adoption are a reusable Activity/Task engine with scheduling (JTBD-07), generated workflows/approvals for custom objects (JTBD-06), and the auth/tenancy/RBAC prerequisite (JTBD-15).

The workstream sections chart the M9–M15 roadmap. Commercial Operations (M10) is now implemented for the local slice: JTBD-CO-01/03 **validated end to end**, CO-02 partial (fixture provider only — no real external catalog), CO-04 partial (human boundary validated, secure roles not), CO-05/06/07 still **not supported** (Milestone 11). Lead Intelligence (M9) is implemented for the local slice: JTBD-LI-01/02/04/07 **validated end to end** (fixture provider, explainable versioned scoring, deterministic routing, persisted version fingerprints — ADR-015), LI-03/05/08/09 partial, LI-06 still not supported. The CO/DS/AN sections remain all **not supported** except JTBD-CO-04 and JTBD-DS-01, which inherit *partial* status from the validated approval and workflow primitives. The Production Spine (JTBD-15) remains the hard gate for every job involving real external or role-scoped users — including manual manager reassignment.
