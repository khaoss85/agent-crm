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
- **Status**: **partially supported** — cross-module workflows with compensation exist as a primitive, and activating a contract (M12) records explicit **pending** delivery and service obligations from the signed order. Nothing executes, schedules, staffs or completes them: there is no handover process, no delivery project and no acceptance.
- **Evidence**: workflow engine (`tests/workflow.test.js`); `tests/contracts-activation-e2e.test.js` (obligations created `pending_handover` / `pending_activation`).

## JTBD-09 — Onboard a customer
- **Status**: **not supported** — no checklist/onboarding primitives.

## JTBD-10 — Manage contracts and renewals
- **Status**: **partially supported** — a contract can now be *activated* from a signed Order with an explicit term (M12), and the renewal-approval workflow slice is validated. Renewal itself is **not** supported: auto-renew and the notice period are recorded only, nothing fires on them (no scheduler), and amendments, cancellation and non-renewal do not exist.
- **Evidence**: `tests/contracts-activation-e2e.test.js`, `docs/CONTRACT_ACTIVATION.md`, `npm run smoke`, `tests/workflow.test.js`.

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

### Delivery & Service (handover at M13 and execution at M14a, both merged — `docs/DELIVERY_HANDOVER.md`; economics at M14b1 on an **open PR**, not on main — `docs/DELIVERY_ECONOMICS.md`; change, deliverables and acceptance are M14b2, not started)

| ID | Job | Status | Notes |
|---|---|---|---|
| JTBD-DS-01 | Hand over a won Deal to delivery | **validated end to end** | `commercial-contract.create-delivery-handover` (human actor only) turns the activated contract's pending delivery obligations into a planned Delivery Project with work packages and milestones, atomically and idempotently, marking exactly those obligations handed over across a package boundary — `tests/delivery-handover-e2e.test.js`, starter `install.mjs`. It hands the work **over**; it does not execute it |
| JTBD-DS-02 | Create a Commessa / Delivery Project from an Order | **partially supported** | one Delivery Project per activated contract, with one work package per delivery obligation and a milestone plan, each carrying its own snapshot; a project is created from the Contract rather than directly from the Order. M14a adds execution: the project starts, its work packages start, block with a stated reason, resume and complete, and it closes only over completed work — `tests/delivery-execution-e2e.test.js`. Still no percent complete, scheduling, staffing, cost or billing |
| JTBD-DS-03 | Involve a third-party delivery partner (engagement, role, scope) | **partially supported** | at most one planned Partner Engagement per project, naming the partner, its role and the work packages it covers, required exactly when work is partner-delivered. It is a business reference and a name snapshot: **no account, login, portal, invitation, permission, fee, revenue share or SLA**, and multiple partners are not modelled |
| JTBD-DS-04 | Restrict partner access to assigned work only | **not supported** | requires RBAC/tenancy — hard-gated by the Production Spine (JTBD-15). M13 records a partner engagement; it grants no access to restrict |
| JTBD-DS-05 | Manage milestones and deliverables | **partially supported** | a canonical, ordered milestone **plan** is created with the project and linked to its work packages, and M14a lets a human start and complete one under a running project. Nothing schedules, accepts or bills a milestone, it is never a contractual milestone, and **deliverables do not exist as objects** — the job is half met |
| JTBD-DS-06 | Track hours and costs on delivery | **validated end to end** | M14b1 (open PR): append-only time and expense evidence on a running work package, costed server-side by a versioned fingerprinted policy at `roundHalfUp(ratePerHourCents × minutes / 60)`. No public create, update or delete exists on any of it; a client-supplied cost is ignored; internal and partner cost are separable — `tests/delivery-economics-e2e.test.js`, starter `install.mjs`. **Not** payroll, not accounting, and no receipt or invoice is stored or verified |
| JTBD-DS-07 | Calculate delivery margin (forecast vs actual) | **partially supported** | M14b1 (open PR) produces a variance to the latest immutable plan version and a reproducible **delivery contribution estimate** — the latter **only where every commercial input in that currency is one-time**. A project carrying a recurring obligation gets `contributionBasis: "unavailable"` with a reason and a `null` estimate, and its recurring input is preserved as evidence grouped by charge type, interval and interval count. It is deliberately **not a margin**: no revenue is recognized, no accounting or gross margin is computed, no cost of goods sold exists, no ARR/MRR/TCV or annualization exists, periods are never summed, and currencies are never summed because there is no FX |
| JTBD-DS-08 | Manage a Change Request with impact and approval | **not supported** | approval primitive exists (JTBD-02) but no change-request object or versioned project scope |
| JTBD-DS-09 | Collect customer acceptance on deliverables | **not supported** | no acceptance primitives; real *customer* actors gated by the Production Spine. M14a's `completed` states say the work finished — not that anyone accepted it, and no acceptance state is declared. Acceptance is M14b2 |
| JTBD-DS-10 | Activate billing on accepted milestones | **not supported** | no billing-milestone primitives |
| JTBD-DS-11 | Activate a Service Contract with Entitlements and SLA | **not supported** | no service primitives |
| JTBD-DS-12 | Manage support cases and escalation | **not supported** | no case/escalation primitives |

### Package developer (Custom Package Authoring v1, M13)

Who: a developer — or Claude Code / Codex on their behalf — extending their own
checked-in Agent CRM repository. Evidence for every row below is
`tests/package-contract.test.js`, `tests/custom-package-e2e.test.js` and
`examples/custom-packages/partner-scorecard`.

| Job | Status | Evidence and limits |
|---|---|---|
| JTBD-PK-01 | Create and compose a custom local domain package | **validated end to end** | a customer-authored package attaches through the identical `definePackage` contract, works over the generic API, and detaches — with every kernel file fingerprinted before and after to prove no kernel change. One static import composes it; deleting the line removes the surface and leaves the data |
| JTBD-PK-02 | Depend on another package without importing its source | **validated end to end** | declared capabilities only. `packages/delivery` reaches `packages/contracts` through `delivery-obligations@1`, inside the caller's transaction. An undeclared reach, a wrong declared provider, a missing or mis-versioned dependency and a cycle are all startup failures naming the edge |
| JTBD-PK-03 | Validate a package before booting it | **partially supported** | `crm package validate\|inspect` runs the startup validator, reports collisions and private kernel imports, and exits non-zero. It **imports and executes** the package's own module body: it is not static analysis and not a sandbox |
| JTBD-PK-04 | Remove a package without losing its data | **partially supported** | removing the import removes actions, schema block and Admin section; the tables and rows are left untouched. There is **no** uninstall, no data migration and no cleanup command — orphaned tables stay orphaned |
| JTBD-PK-05 | Scaffold a new package from a template | **not supported** | `crm package new` deliberately deferred until a third package settles the file shape |
| JTBD-PK-06 | Install a package from a registry or marketplace | **not supported** | no registry, publication, remote install, auto-update, signing or hot loading. Packages are checked-in source, by design |
| JTBD-PK-07 | Run an untrusted package safely | **not supported** | and not planned at this layer. Repository source is trusted: a package's module body, actions and policies run in-process with full authority, and the consumer name passed when opening a capability is asserted by the caller (ADR-018 addendum 4) |

## Marketing & Growth Operations (MK0–MK7, design only)

Who: a marketing or growth operator, and the coding agent working for them.
Strategy: `../strategy/MARKETING_GROWTH_OPERATIONS.md`,
`../strategy/CAMPAIGNS_JOURNEYS.md`,
`../strategy/EXPERIMENTATION_ATTRIBUTION.md`.

**Every row below is `not supported`.** No campaign, audience, consent check,
journey, experiment, content asset, landing page, tracking plan, channel
provider, media plan, funnel definition or attribution model exists in the
repository. Lead Intelligence (M9) scores and routes leads that already exist;
that is emphatically **not** a marketing campaign system, and no MK row inherits
status from it. A row moves only with linked evidence in this repository.

### Audience and governance

| Job | Status | Blocked by |
|---|---|---|
| JTBD-MK-01 | Create a dynamic audience from CRM data | **not supported** | MK2; no audience primitive |
| JTBD-MK-02 | Freeze an audience snapshot for a send | **not supported** | MK2; no snapshot primitive |
| JTBD-MK-03 | Apply exclusions and suppression sets | **not supported** | MK2; `DATA_GOVERNANCE.md` |
| JTBD-MK-04 | Verify consent and communication preferences | **not supported** | MK2; `DATA_GOVERNANCE.md` — hard |
| JTBD-MK-05 | Apply a cross-campaign frequency cap | **not supported** | MK2; needs campaign history |
| JTBD-MK-06 | Sync an audience to a provider | **not supported** | MK6; no provider adapter |

### Campaign planning

| Job | Status | Blocked by |
|---|---|---|
| JTBD-MK-07 | Diagnose a funnel drop | **not supported** | MK1; funnel primitives, better with Analytics Studio |
| JTBD-MK-08 | Create a complete Campaign Proposal | **not supported** | MK1 — the first milestone, and it needs no provider |
| JTBD-MK-09 | Select a channel and an installed provider, with rationale | **not supported** | MK1/MK2; provider contracts |
| JTBD-MK-10 | Recommend a send time and window | **not supported** | MK1 |
| JTBD-MK-11 | Define content, creative, landing page and CTA | **not supported** | MK3 |
| JTBD-MK-12 | Define a tracking plan (UTM, conversion events) | **not supported** | MK3 |
| JTBD-MK-13 | Request human approval of a proposal | **not supported** | MK1; real roles need the Production Spine |

### Execution

| Job | Status | Blocked by |
|---|---|---|
| JTBD-MK-14 | Run a one-shot email campaign | **not supported** | MK2; fixture provider first |
| JTBD-MK-15 | Run a rolling campaign | **not supported** | MK4; `JOBS_AND_OUTBOX.md` — hard |
| JTBD-MK-16 | Run a triggered campaign | **not supported** | MK4; durable event inbox — hard |
| JTBD-MK-17 | Run a multi-step multichannel journey | **not supported** | MK4; scheduler and durable waits — hard |
| JTBD-MK-18 | Pause or stop a running campaign | **not supported** | MK4 |
| JTBD-MK-19 | Handle bounces and unsubscribes | **not supported** | MK2; inbound provider events |

### Content

| Job | Status | Blocked by |
|---|---|---|
| JTBD-MK-20 | Generate email content | **not supported** | MK3 |
| JTBD-MK-21 | Generate SMS/WhatsApp messaging content | **not supported** | MK3 |
| JTBD-MK-22 | Generate a landing page, form and CTA | **not supported** | MK3; design ownership per `DESIGN_TO_CRM.md` |
| JTBD-MK-23 | Publish a preview | **not supported** | MK3 |
| JTBD-MK-24 | Publish an approved asset to production | **not supported** | MK3; human approval mandatory |

### Experimentation

| Job | Status | Blocked by |
|---|---|---|
| JTBD-MK-25 | Create an A/B test | **not supported** | MK5 |
| JTBD-MK-26 | Assign a deterministic control group | **not supported** | MK5; fingerprinted assignment rule |
| JTBD-MK-27 | Create a holdout | **not supported** | MK5 |
| JTBD-MK-28 | Measure lift against control | **not supported** | MK5/MK7 |
| JTBD-MK-29 | Select and publish a winner | **not supported** | MK5; human approval where risk exists |

### Paid media

| Job | Status | Blocked by |
|---|---|---|
| JTBD-MK-30 | Prepare a Media Plan | **not supported** | MK6 |
| JTBD-MK-31 | Sync an audience to an ads platform | **not supported** | MK6; consent rules |
| JTBD-MK-32 | Launch an approved ads campaign | **not supported** | MK6; human spend approval mandatory |
| JTBD-MK-33 | Ingest spend and results | **not supported** | MK6; provider adapters |
| JTBD-MK-34 | Propose a budget change | **not supported** | MK6; a proposal, never an action |

### Analytics and attribution

| Job | Status | Blocked by |
|---|---|---|
| JTBD-MK-35 | Define a funnel | **not supported** | MK1/MK7 |
| JTBD-MK-36 | Identify and segment a drop | **not supported** | MK1; `ANALYTICS_STUDIO.md` |
| JTBD-MK-37 | Report a campaign result | **not supported** | MK2 onward |
| JTBD-MK-38 | First-touch attribution | **not supported** | MK7; identity/touchpoint model |
| JTBD-MK-39 | Last-touch attribution | **not supported** | MK7 |
| JTBD-MK-40 | Multi-touch attribution | **not supported** | MK7; `ANALYTICS_STUDIO.md` — hard |
| JTBD-MK-41 | Connect a campaign to an Opportunity or Order | **not supported** | MK7 |
| JTBD-MK-42 | Calculate campaign ROI | **not supported** | MK7 |
| JTBD-MK-43 | Recommend the next campaign version | **not supported** | MK7; closes the loop |


## Agent experience (AX0–AX5, cross-cutting)

Who: a user who supplies a **business objective** rather than a technical
change, and the coding agent working for them. Design:
`../strategy/OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md`; worked example:
`../strategy/OBJECTIVE_DRIVEN_FUNNEL_EXAMPLE.md`.

| Job | Status | Evidence and limits |
|---|---|---|
| JTBD-AX-01 | Discover installed packages, capabilities and policies | **validated end to end** | `crm app inspect [--json]` (AX1) answers it in one deterministic document: the installed package graph with its five distinct version axes, the resolved capability graph including unresolved edges, records with their revisions, actions with declared transition metadata, policies and provider definitions. An invalid composition still produces a complete report with deterministic `problems[]`, and `limitations[]` names every gap by code — `tests/app-inspect.test.js`. **Source-only**: no database is opened, no provider is contacted, and JTBD/quality evidence is referenced by path, never parsed |
| JTBD-AX-02 | Extend the CRM for a goal without patching the kernel | **validated end to end** | the package contract: a customer-authored package attaches, works and detaches with every kernel file fingerprinted unchanged (JTBD-PK-01/PK-02). A record that must gain a field or a status evolves by revision (ADR-019) |
| JTBD-AX-03 | Turn a business objective into a reviewable solution plan | **partially supported** | AX2 (open PR): `solutionPlanContract: 1` with a revision and a canonical fingerprint, six decision types mapped to the repository's own hierarchy, six evidence categories with resolving citations, a closed approval vocabulary, and `crm solution inspect\|validate\|check` — `check` binds the plan to this project's `app inspect` report and reports `PLAN_STALE` when the composition has moved. A plan cannot carry a command, and rung 5 cannot be a step — `tests/solution-plan.test.js`. **Partial, not validated**: nothing writes the plan (there is no planner) and nothing executes it (there is no runtime); the contract makes a hand-written plan checkable, which is a different job from producing one |
| JTBD-AX-04 | Build the solution as checked-in, customer-owned source | **partially supported** | true for modules, actions, policies, packages and Admin views that exist today; the analytics and campaign parts of a typical funnel goal cannot be built at all |
| JTBD-AX-05 | Verify the solution against defined acceptance | **partially supported** | Quality Gates, `crm package validate`, the test suites, the clean-clone run and the JTBD matrix are real and enforced; there is no automated goal-to-acceptance runner (AX3) |
| JTBD-AX-06 | Report unavailable capabilities honestly | **partially supported** | the JTBD matrix and package metadata make the honest answer *available*; nothing enforces that an agent uses it, which is why the Skill states it as a rule |
| JTBD-AX-07 | Analyse a funnel and identify a drop from a goal | **not supported** | needs Analytics Studio and a funnel primitive |
| JTBD-AX-08 | Propose an optimization campaign from an insight | **not supported** | MK1; no Campaign Proposal object exists |
| JTBD-AX-09 | Deploy, observe and fix a solution in production | **not supported** | AX4; hard-gated by the Production Spine and Cloud |
| JTBD-AX-10 | Close the loop: measure, learn, propose the next version | **not supported** | AX5; needs Marketing, Analytics, Data Governance and Durable Automation |


### Analytics (target: M16)

| ID | Job | Status | Notes |
|---|---|---|---|
| JTBD-AN-01 | Define a trusted, explainable metric | **not supported** | no semantic model or metric-definition primitives |
| JTBD-AN-02 | Create a report from approved metrics/dimensions | **not supported** | no report/query-compilation primitives |
| JTBD-AN-03 | Create a role-aware dashboard | **not supported** | requires RBAC at the query boundary — gated by the Production Spine |
| JTBD-AN-04 | Version and roll back a dashboard | **not supported** | no dashboard-version primitives |
| JTBD-AN-05 | Validate metric correctness against fixtures | **not supported** | no metric test harness |

### Contract & Subscription (Milestone 12 implemented for the local slice — ADR-018 addendum, `docs/CONTRACT_ACTIVATION.md`)

The layer between the immutable Order (M11) and Delivery/Service. **Activation
exists; nothing downstream of it does** — no billing, no amendment, no renewal,
no cancellation, and deliberately no recurring-revenue figure.

| ID | Job | Status | Notes |
|---|---|---|---|
| JTBD-CS-01 | Activate a commercial contract from a signed Order | **partially supported** | `order.activate-contract` (human actor only) creates one contract, its immutable version and one line per order component, atomically and idempotently, with every amount copied from the signed Order — but the **term is not signed**: the document package carries no dates, so effective/start/end, auto-renew and notice are operational metadata recorded after signature (`termsSource`, with a required reason). A signed commercial agreement end to end needs a pre-signature term snapshot, which does not exist. Evidence: `tests/contracts-activation-e2e.test.js`, `tests/contracts-review.test.js`, starter `install.mjs` |
| JTBD-CS-02 | Activate a subscription with lines and an initial term | **partially supported** | one subscription per contract, with a line for every component whose commercial axis is `subscription` — including recurring components that also carry a service or delivery obligation, so no recurring commitment is lost. It is a commercial activation record only: nothing bills, prorates, renews or cancels it; a future-dated subscription is `scheduled` and nothing transitions it (no scheduler); and the term itself is post-signature operational metadata |
| JTBD-CS-03 | Amend seats or quantity on a live subscription | **not supported** | no amendment primitives |
| JTBD-CS-04 | Record an expansion or contraction, classified at the time of change | **not supported** | no amendment classification |
| JTBD-CS-05 | Calculate MRR, ARR and TCV from real contract data | **not supported** | deliberately not derived — M12 now provides a term and an active subscription, but normalizing unlike periods into one figure is a stated business policy that does not exist here; the Admin and the schema say so rather than implying a number |
| JTBD-CS-06 | Schedule a renewal ahead of term end | **not supported** | needs both this layer and a scheduler (`JOBS_AND_OUTBOX.md`) |
| JTBD-CS-07 | Create a renewal opportunity from an expiring subscription | **not supported** | needs CS-06 |
| JTBD-CS-08 | Apply a versioned price-uplift policy at renewal | **not supported** | the versioned-policy mechanism exists (ADR-015/016/018) and M12 uses it to classify, but the renewal domain does not exist |
| JTBD-CS-09 | Cancel or non-renew with an audited reason | **not supported** | no cancellation primitives |
| JTBD-CS-10 | Read a complete amendment history | **not supported** | no amendments exist; what M12 does record is the activation itself — who activated, from which order, under which policy version, and both classification axes with their reasons and any human override |

### Data operations (no milestone assigned)

The everyday jobs that decide whether a CRM is usable at all. **None is implemented**, and none has a milestone yet — which is itself a finding.

| ID | Job | Status | Notes |
|---|---|---|---|
| JTBD-DO-01 | Import records from CSV | **not supported** | no import path; records are created one at a time through services or actions |
| JTBD-DO-02 | Detect duplicates on import or entry | **not supported** | unique constraints exist per field; no matching or scoring |
| JTBD-DO-03 | Merge two Companies or Contacts | **not supported** | no merge primitive; references would have to be re-pointed and evidence preserved |
| JTBD-DO-04 | Export records | **not supported** | no export endpoint; `list` is page-bounded by design |
| JTBD-DO-05 | Bulk update a set of records | **not supported** | every mutation is single-record |
| JTBD-DO-06 | Save and share a filtered view | **not supported** | no saved-view primitive |
| JTBD-DO-07 | Search across modules | **not supported** | no global search; exact indexed lookups are per-module |
| JTBD-DO-08 | See a unified activity timeline for a record | **not supported** | audit and trace exist per record but there is no Activity model or timeline view |
| JTBD-DO-09 | Attach notes or files to a record | **not supported** | no note or attachment primitive |

### Communications (no milestone assigned)

| ID | Job | Status | Notes |
|---|---|---|---|
| JTBD-CM-01 | Sync email with CRM records | **not supported** | no email provider; needs the Integration Runtime |
| JTBD-CM-02 | Sync calendar events | **not supported** | no calendar provider |
| JTBD-CM-03 | Log meetings and calls | **not supported** | no Activity model |
| JTBD-CM-04 | Schedule and track a follow-up | **partially supported** | qualification creates exactly one follow-up Task with a deterministic source key (M6); there is no scheduler, reminder or task engine — the same limit JTBD-07 states |
| JTBD-CM-05 | Honor unsubscribe and communication preferences | **not supported** | no preference or suppression model (`DATA_GOVERNANCE.md`) |

### Data governance (no milestone assigned — `DATA_GOVERNANCE.md`)

| ID | Job | Status | Notes |
|---|---|---|---|
| JTBD-DG-01 | Record consent and lawful basis | **not supported** | no consent primitive |
| JTBD-DG-02 | Honor an opt-out across outbound paths | **not supported** | no outbound paths and no suppression list |
| JTBD-DG-03 | Export everything held about a subject | **not supported** | no subject-access path |
| JTBD-DG-04 | Anonymize or delete a subject while preserving immutable evidence | **not supported** | the hardest design in the track: commercial evidence is deliberately immutable |
| JTBD-DG-05 | Apply a retention policy and evidence that it ran | **not supported** | needs the scheduler |
| JTBD-DG-06 | Inspect what was shared with which provider | **not supported** | M9 records inbound provenance only |
| JTBD-DG-07 | Restrict sensitive fields by role | **not supported** | needs RBAC |
| JTBD-DG-08 | Prove a deletion request completed | **not supported** | needs DG-04 |

### Cloud operations (design only — `CLOUD_JTBD.md`)

All fifteen operator jobs (CL-01…CL-15) are **not supported**: no control plane, deployment, account or billing code exists, and Cloud is gated on the Production Spine. Actors, triggers, acceptance scenarios and approval boundaries are specified in `CLOUD_JTBD.md`.

### Design-to-CRM (design only — `DESIGN_TO_CRM.md`)

| ID | Job | Status | Notes |
|---|---|---|---|
| JTBD-DC-01 | Apply a brand's colors and typography | **not supported** | one stylesheet, no token layer |
| JTBD-DC-02 | Choose and group Admin navigation | **not supported** | navigation is derived from module metadata |
| JTBD-DC-03 | Control field order, sections and responsive layout | **not supported** | layout is generated from field order in the manifest |
| JTBD-DC-04 | Replace a component without forking the Admin | **partially supported** | the ADR-009 override seam exists and carries the pipeline board and the quote/signature view — but it is an internal seam with no declared contract, registry or plugin path |
| JTBD-DC-05 | Generate a CRM UI from a Figma file or screenshot | **not supported** | pixel-perfect generation is explicitly not claimed |
| JTBD-DC-06 | Prove the UI still matches its design after a change | **not supported** | no visual regression; browser tests are not in CI |
| JTBD-DC-07 | Meet a stated accessibility bar | **not supported** | no automated checks |

**Anti-inflation rule:** none of the broad JTBDs above may be marked *validated end to end* because an isolated constituent primitive lands. A row moves only when the *whole job* is proven by automated evidence — the same standard every existing validated row met.

---

## Summary

- **Validated end to end**: JTBD-01 (custom business object), JTBD-01b (generated-to-generated reference), JTBD-02 (renewal approval, built-in object), JTBD-03 (opportunity through configurable pipeline stages, code-first), JTBD-04 (capture a lead, starter model), JTBD-05 (qualify/disqualify a lead, starter actions), JTBD-05b (convert a qualified lead into Company/Contact/Opportunity, starter action).
- Deliberately **not** marked validated: pipeline for custom objects, a general task engine/scheduling (only the first follow-up Task inside qualification is proven — JTBD-07 stays partial), onboarding, churn/upsell, reporting, integrations, permissions. Primitives for some exist, but no end-to-end proof does.

This matrix guides roadmap prioritization: the largest gaps blocking common CRM adoption are a reusable Activity/Task engine with scheduling (JTBD-07), generated workflows/approvals for custom objects (JTBD-06), and the auth/tenancy/RBAC prerequisite (JTBD-15).

The workstream sections chart the M9–M16 roadmap (corrected at the Platform Alignment Gate: M12 is Order Activation & Subscription, and Delivery/Service/Analytics shift by one — `EXECUTION_ROADMAP.md`). Commercial Operations (M10) is now implemented for the local slice: JTBD-CO-01/03 **validated end to end**, CO-02 partial (fixture provider only — no real external catalog), CO-04 partial (human boundary validated, secure roles not), CO-05/06/07 still **not supported** (Milestone 11). Lead Intelligence (M9) is implemented for the local slice: JTBD-LI-01/02/04/07 **validated end to end** (fixture provider, explainable versioned scoring, deterministic routing, persisted version fingerprints — ADR-015), LI-03/05/08/09 partial, LI-06 still not supported. The CO/DS/AN sections remain all **not supported** except JTBD-CO-04 and JTBD-DS-01, which inherit *partial* status from the validated approval and workflow primitives. Signature and Order (M11) is implemented for the local slice: JTBD-CO-07 **validated end to end**, CO-05/CO-06 partial (fixture provider, test-only webhook key, provider-reported artifact hash — ADR-017). Contract activation (M12) is implemented for the local slice as the first optional domain package, and its adversarial review narrowed what it may claim: JTBD-CS-01 is **partially supported** (the activation is real and atomic, but the term is post-signature operational metadata, not a signed term), CS-02 partial (an activation record that now keeps every recurring commitment, with nothing billing, renewing or cancelling it), CS-05 deliberately still **not supported**, and every remaining CS row unchanged. Delivery handover (M13) is implemented for the local slice as the second package — and the first that depends on another through a declared capability: JTBD-DS-01 **validated end to end**, DS-02/DS-03/DS-05 partial (a planned project, a planned partner reference that grants nothing, and a milestone plan), DS-04 and DS-06 through DS-11 still **not supported**. Custom Package Authoring v1 adds a **Package developer** section: JTBD-PK-01/PK-02 **validated end to end** (a customer-authored package attaches and detaches with the kernel fingerprinted unchanged; cross-package reach only through a declared capability), PK-03/PK-04 partial (the CLI executes what it validates; removal leaves data behind with no uninstall), and PK-05/PK-06/PK-07 **not supported** — no scaffold, no registry or marketplace, and no sandboxing of package code. The adversarial review of PR #17 corrected the contract before these rows were written: ADR-018 addendum 4. Marketing & Growth Operations (MK0–MK7) is added as a **design-only parallel workstream**: all 43 JTBD-MK rows are **not supported**, because no campaign, audience, consent-check, journey, experiment, content, provider, media-plan, funnel or attribution primitive exists. Lead Intelligence's scoring and routing is not a marketing campaign system and no MK row inherits status from it. A cross-cutting **Agent experience** section (AX0–AX5) records how a user reaches any of this from a business objective: JTBD-AX-01 and AX-02 **validated end to end** (deterministic application inspection through `crm app inspect`, and extending without patching the kernel), AX-03 moves to **partially supported** with AX2's machine-readable Solution Plan contract (a document that can be checked and bound to a real inspection — not a planner and not a runtime), AX-04/AX-05/AX-06 partial, and AX-07 through AX-10 **not supported** — there is still no Solution Plan *runtime*, no funnel or campaign primitive, and no production deployment path.

The Production Spine (JTBD-15) remains the hard gate for every job involving real external or role-scoped users — including manual manager reassignment.

**Six sections added at the Platform Alignment Gate** — Contract & Subscription, Data operations, Communications, Data governance, Cloud operations and Design-to-CRM — are **entirely `not supported`** except two rows that inherit *partial* status from proven primitives (JTBD-CM-04, the single deterministic follow-up Task; JTBD-DC-04, the Admin override seam). Data operations is the most uncomfortable of them: CSV import, dedupe, merge, export, bulk edit, saved views, global search and an activity timeline are table stakes in every commercial CRM and none of them has a milestone. That is recorded here deliberately rather than left implicit.
