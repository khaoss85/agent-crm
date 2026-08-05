# Delivery & Service Operations

**Status: product strategy and roadmap only. Nothing in this document is implemented.** No delivery project, milestone, partner engagement, time tracking, change request, acceptance, billing, service contract, SLA or support primitive exists in the repository today. This document defines the post-sale workstream so the roadmap can sequence it (`EXECUTION_ROADMAP.md`, milestones M12–M14) and so coding agents build it by composing declared primitives.

**Framing:** this is the CRM equivalent of ecommerce fulfillment. Medusa's promise is not "a checkout" but the whole order lifecycle — fulfillment, inventory, returns. The CRM equivalent of that completeness is what happens *after* Deal Won: handover, delivery, economics, acceptance, billing, service. A CRM framework that stops at Won is a pipeline toy; this workstream is where the Medusa analogy is earned.

Delivery model per domain, as everywhere in this repository: native deterministic primitives + provider contracts + code-first policies/actions + Agent Skills + starter + JTBD evidence + reproducible E2E benchmark.

---

## 1. Lifecycle

```text
Deal Won / Order Signed  (Order = immutable commercial snapshot, REVENUE_OPERATIONS.md)
→ sales-to-delivery handover
→ Delivery Project / Commessa  (immutable copy of ordered scope)
→ milestones · deliverables · work packages
→ internal resource assignments + third-party partner engagements
→ time and expense tracking → budget and margin
→ risks · issues · Change Requests
→ customer acceptance
→ billing milestones
→ Service Contract · Entitlements · SLA
→ support cases · escalations
→ handover to Customer Success
→ renewal and upsell (feeds back into the sales pipeline)
```

## 2. Sales-to-delivery handover

When a Deal is Won or an Order is signed, an explicit handover action can:

- inspect the Order lines (the immutable signed scope);
- create the **DeliveryProject / Commessa**;
- copy the ordered scope immutably into the project (later catalog or quote changes never mutate a running project's contracted scope);
- create initial **Milestones** and **WorkPackages** from the order structure;
- assign the Delivery Manager;
- create **PartnerEngagements** where third parties deliver part of the scope;
- create the kickoff record;
- preserve documents, audit and trace across the boundary.

The handover is an action/workflow in the ADR-011/012 sense: atomic, audited, traced, idempotent — a second handover of the same Order is a stable, visible conflict, never a duplicate project.

## 3. Project structure primitives

- **DeliveryProject / Commessa** — the unit of post-sale execution, linked to its Order;
- **Milestone** — dated, orderable checkpoints; billing and acceptance attach here;
- **Deliverable** — a concrete output a customer can accept or reject;
- **WorkPackage** — a scoped block of work, assignable internally or to a partner;
- **ResourceAssignment** — who works on what, with role and period.

## 4. Third-party delivery partners

A Deal or Order may involve partners in three distinct roles — **commercial/referral**, **delivery**, and **support** — and one partner may hold several roles on different engagements.

**PartnerEngagement** (with its **PartnerAgreement**) stores per engagement:

- role;
- scope (which work packages / deliverables);
- responsibilities;
- cost (what we pay the partner);
- revenue share (**PartnerFee / RevenueShare** — deterministic tables, integer minor units, never floating point);
- SLA expectations;
- access scope (what the partner may see and touch);
- dates and status.

## 5. Access boundaries — the honest limit

Intended permission model, enforced at **service boundaries, not UI**:

| Role | Sees / does |
|---|---|
| Sales | commercial summary, handover status |
| Delivery Manager | full project control |
| Delivery Partner | only assigned customer/project/work packages |
| Customer | approved milestones/deliverables, acceptance actions |
| Finance | budget, cost, margin, billing |

**Stated clearly: real partner and customer access cannot be validated before authentication, tenancy and RBAC exist (Production Spine, `EXECUTION_ROADMAP.md` Phase 6).** Today the framework has no authentication and its actor headers are identity claims on a local-development surface. Until the Spine exists, partner/customer boundaries can be *designed* into service contracts and *tested* against declared actors, but no JTBD involving a real external partner or customer login may be claimed validated, and no benchmark gate involving real access enforcement may be scored.

## 6. Economics

```text
Order revenue
− internal delivery cost   (time entries × rates)
− partner cost             (engagement fees)
− expenses
= delivery margin
```

Primitives: **TimeEntry**, **Expense**, delivery budget on the project, and computed margin. Forecast versus actual is tracked for hours, costs, margin, progress, delays and billable milestones. All money is integer minor units per the repository money contract; currencies are never summed together.

## 7. Risks, issues and change

**Risk** and **Issue** are plain auditable records. Scope change is a governed flow:

```text
scope change request
→ ChangeRequest (what, why, requested by)
→ impact estimate (time, cost, margin)
→ approval (human, deterministic policy — ADR-003 pattern)
→ optionally a new Quote/Order version (REVENUE_OPERATIONS.md)
→ versioned project scope (the previous scope stays in history)
```

## 8. Customer acceptance and billing

```text
deliverable complete
→ CustomerAcceptance requested
→ accepted / rejected with notes (actor recorded)
→ milestone close
→ BillingMilestone becomes billable
```

Acceptance state and billing eligibility are managed fields: generic CRUD can never mark something accepted or billable — only the acceptance action/workflow can, with audit and trace. Invoicing itself stays outside the framework (ERP/billing providers); the framework owns *eligibility* and its evidence.

## 9. Service operations

After go-live:

- **ServiceContract** — the ongoing relationship (dates, terms, renewal linkage);
- **Entitlement** — what the customer is entitled to (support tiers, hours, seats);
- **SLA** — deterministic response/resolution targets, versioned like other policies;
- **SupportCase / ServiceRequest / Incident** — the work records;
- **Escalation** — governed escalation with policy-driven targets and human decision points.

Ownership hands over to Customer Success explicitly (assignment records, not tribal knowledge), and service activity connects forward to **renewal and upsell**: a ServiceContract nearing expiry or an entitlement consistently exceeded becomes a signal the revenue side (Lead Intelligence / pipeline) can consume deterministically.

---

## 10. What is native, what is a provider, what is a policy

| Concept | Classification |
|---|---|
| DeliveryProject/Commessa, Milestone, Deliverable, WorkPackage, ResourceAssignment | **Native primitive** |
| PartnerEngagement, PartnerAgreement, PartnerFee/RevenueShare | **Native primitive** |
| TimeEntry, Expense, budget/margin records | **Native primitive** |
| Risk, Issue, ChangeRequest, CustomerAcceptance, BillingMilestone | **Native primitive** |
| ServiceContract, Entitlement, SLA, SupportCase, ServiceRequest, Incident, Escalation | **Native primitive** |
| Handover, acceptance, change-approval, escalation flows | **Code-first actions/workflows** (ADR-011/012 envelope; approvals human-only per ADR-003) |
| SLA/escalation targets, margin thresholds, revenue-share tables | **Code-first policies**, versioned via the shared policy-version model (`REVENUE_OPERATIONS.md` §3) |
| Billing/invoicing systems, time-tracking imports, partner portals' identity | **Provider contracts** (and, for identity, Production Spine work) |

**Deliberately not built:** a general project-management suite competing with dedicated PM tools; resource-optimization AI; automatic acceptance; invoicing. The framework owns the *commercial truth* of delivery — scope, economics, acceptance, eligibility, service obligations — with audit and trace.

## 11. Dependencies and human approvals

- **Hard dependency:** Orders (`REVENUE_OPERATIONS.md`, M11) precede delivery handover (M12) — a Commessa is created *from* an immutable Order.
- **Production Spine** gates all real partner/customer access, portals, and any remote exposure (see §5).
- **Human approvals:** Change Request approvals and acceptance decisions are human by design; partner agreements (cost/revenue share) are commercial commitments requiring human sign-off; any provider action that bills or charges.
- **Agents execute:** primitives, flows, policies, starters, tests, benchmark evidence through ExecPlans.

JTBD tracking: `docs/benchmarks/CRM_JTBD_MATRIX.md` (Delivery & Service section — everything starts **not supported** except where the matrix already holds partial evidence). Benchmark scenario: Delivery & Service E2E in `CRM_BUILD_BENCHMARK.md` (planned, not implemented).
