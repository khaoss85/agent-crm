---
name: build-service-operations
description: Add or extend service operations in an Accordo project - activating the pending service obligations of an activated contract into an operational Service Coverage with immutable Entitlements through a versioned activation policy, and recording support cases over an explicit transition table with elapsed-time SLA evidence and manually recorded escalation. Use for service coverage, support entitlement, support case/ticket, first response, SLA target or evaluation, case escalation, ending coverage, or the Service Admin section. Do not use for a second legal contract, billing, invoicing, renewal or an authenticated customer portal (none of which exist), contract activation (build-contract-activation), delivery work (build-delivery-handover) or a single custom object (create-crm-module).
requires:
  tier: generated-project
  command: "crm app inspect"
  projectSurface: ["packages/domains/generated/index.js", "packages/core/index.js"]
  repositorySurface: ["ARCHITECTURE.md", "DECISIONS.md", "docs/SERVICE_OPERATIONS.md", "docs/MODULE_EVOLUTION.md", "docs/PACKAGE_AUTHORING.md"]
  degradesTo: "the composed packages, capabilities and policies reported by `crm app inspect --json`, plus `crm package test` for the contract a package must satisfy"
---

## Orient yourself first

```bash
npm run crm -- app inspect --json
```

Read `valid`, then `problems[]`, then `limitations[]`, in that order. Every problem is fixed or reported before anything is built on top of it, and **every limitation is a hard boundary on what you may claim.** Then read `packages[]`, `capabilities[]`, `resources[]`, `actions[]`, `policies[]` and `providers[]`: that list is what exists. A capability absent from the report does not exist, whatever a record name, a label or a document suggests.

If the repository documents this skill names are absent, you are in a project built from this framework rather than in the framework itself. The inspection report is then the source of truth and those documents are optional background — do not guess at their contents, and do not assume a path exists because this skill names it.

**Background, where they exist:** `ARCHITECTURE.md`, `DECISIONS.md` (ADR-018 and its addenda, ADR-019 with addendum 1), `docs/SERVICE_OPERATIONS.md`, `docs/MODULE_EVOLUTION.md` and `docs/PACKAGE_AUTHORING.md`. They are the deeper source for the rules below, not a prerequisite for them — the rules stand on their own.

## It is not a contract, and the name is the guardrail

1. A **ServiceCoverage** is operational evidence. Nobody signed it, it has no envelope, signer or artifact, and it neither amends nor replaces the Commercial Contract it was activated from. Every document, every action description and every screen says so before it says anything else.
2. Never introduce a record, field or label called *service contract*. Anything called *Contract* here is read as signed, and then two records claim to be authoritative.
3. `activate-service` returns `amendedCommercialRecord: false` because that is the claim a reader would otherwise make. Keep claims like it, and keep them honest.

## Reach the sale only through the capability

1. Service depends on `contracts/service-obligations@1` and on nothing else in that package: no import from `packages/contracts/src`, no table, no source key. If the capability lacks something, add it **inside `packages/contracts`**, never in the kernel.
2. Open it with your own `modules`, `actor` and `now`, so the obligation update commits inside your transaction. An unawaited managed write would escape it — await every one.
3. Consume exactly the obligations you planned, by id. Delivery obligations are not Service's business: never touch them.
4. Evolving a shipped contracts record is ADR-019 work: bump `revision`, one step, additive. Prove it against a project that already holds real rows — an evolution that only works on an empty table is not an evolution.

## Decide an entitlement, never default one

1. A **service activation policy** is versioned, fingerprinted and pure. It reads the obligation and the contract and returns a support tier, covered categories and priorities, elapsed-minute targets and an optional open-case limit — or `ambiguous`.
2. `ambiguous` blocks activation until a human supplies an override **with a stated reason**. A defaulted support tier is a promise nobody in the business made.
3. `activate-service` recomputes the plan server-side. A caller may choose the policy and resolve an ambiguity; it never supplies the outcome.
4. `plan-service-activation` is read-only and open to an agent: no record, no audit row, no event. Keep it that way, and test the zero counts rather than asserting them in prose.

## Enforce entitlements on the server

1. Category, priority, coverage state, effective dates and the open-case limit are all checked in the action. None of it may depend on the UI having filtered anything.
2. Count the open-case limit with an **unpaged** read (`listWhere`/`countWhere`). A limit computed from a page bound lets the eleventh case through on a project with a large history.
3. Exceeding a limit **refuses the case**. Nothing is billed for exceeding it, because nothing here bills.

## SLA is elapsed time, and says so

1. `firstResponseDueAt = openedAt + firstResponseTargetMinutes`, `resolutionDueAt = openedAt + resolutionTargetMinutes`. Elapsed wall-clock minutes against the injected UTC clock.
2. There is no business-hours calendar, no holiday table, no timezone interpretation and **no paused clock**: `waiting_customer` does not stop it. A half-implemented pause understates a breach, and that is the direction that hurts.
3. `breached` is an elapsed-time state, never a contractual or legal determination. Never write "contractually breached", and never emit an event that says it.
4. `preview-sla` computes and writes nothing. `record-sla-evaluation` stores the judgement **with every input it used**, so a stored evaluation is evidence about a stated instant and never current truth.

## A case is evidence, not authentication

1. Every case, note and reply is what a **user actor** recorded. No customer is authenticated, no channel is integrated, and nothing is emailed, called or messaged. The `source` field is a label; a listed channel does not mean a provider is connected.
2. `visibility` is an assertion by whoever recorded it, never an access grant.
3. An escalation is recorded evidence that a human escalated. Nothing is routed, notified, assigned or scheduled, so a target is a label rather than a permission.
4. Moves follow the declared transition table and nothing else. Nothing moves on a clock.

## Keys, and the collisions they must not have

1. A caller's key and a key the framework writes itself must live in **separate namespaces**. `sourceKey` is unique, and evidence records are append-only: a caller who seizes the key an action owns blocks that action permanently, with no correction path.
2. Framework evidence for a repeatable move needs an **occurrence ordinal**, not just `<from>:<to>`. `in_progress ↔ waiting_customer` is the ordinary support loop, and a key that repeats collides with its own earlier evidence and strands the case.
3. A retry answers from storage only after proving it is the same call — including the policy the caller *stated*. A divergent retry reported as honoured is worse than a refusal.

## Human-only writes

Activating, ending, recording a case, a first response, a transition, an activity, an SLA evaluation and an escalation each require `actor.type === 'user'`; an agent is refused `403 HUMAN_APPROVAL_REQUIRED`, and the refusal writes nothing. This is a **human-actor boundary, not Service Manager or customer role enforcement** — there are no roles to enforce until the Production Spine exists. Say that wherever the boundary appears.

## The Admin section

`apps/admin/public/admin-service.js` is **package-scoped, not package-owned**: AX1 publishes `ADMIN_EXTENSIONS_UNSUPPORTED`, so it lives in the Admin app and renders only while `/api/schema` publishes `domains.service`. A control appears only where the server would accept it, every refusal re-throws so the parent's re-render cannot paint over it, and selection that must survive a write lives outside the render closure.

## Prove it, do not argue it

Fault injection after every write in each action's write graph · two connections racing every decision, including the *same* move · exact reads past 500 rows · exact audit, event and trace counts · the SLA arithmetic at its exact boundaries · hostile input in every field · AX1 visibility, AX2 citability and a clean detach · a live upgrade over data that predates the change. Finish with `npm run verify`.

## Never build here

Billing, invoicing, payment or billing eligibility · a second legal contract or any contract amendment · renewal or expansion · an authenticated customer or agent portal · RBAC or tenancy · email, chat, WhatsApp or telephony · a contact centre · attachment or file storage · a knowledge base · business-hours calendars · a scheduler, automatic escalation or notification · customer-success health scoring.
