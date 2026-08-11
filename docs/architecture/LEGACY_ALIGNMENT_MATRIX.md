# Legacy alignment matrix

**Status: assessment and policy. No domain is refactored by the PR that
introduced this document, and none should be until the sequencing below allows
it.**

Two domains — Contract Activation and Delivery — were built *after* the domain
package seam (ADR-018) and use it. Three older ones — Lead Intelligence,
Commercial Operations, and Signature & Order — were built before it and lived in
`packages/core/src/`. That was a fact, not a defect: they were built when the
seam did not exist, and each one is what taught us what the seam had to be.

**Lead Intelligence has since been extracted** and is now a package like any
other. It is the proof that a legacy domain can move without changing what it
decides: LA0 froze its externally observable behaviour first, and zero asserted
observations moved across the extraction. Commercial Operations and Signature &
Order are still where they were.

Pipeline is in `packages/core/src/` too and belongs there. It is a reusable
runtime capability rather than a domain, and it is in the matrix so that a reader
scanning core for misplaced business logic is told why it is not one.

The risk is not that they are old. The risk is **drift by silence**: a horizontal
capability lands, the newest domain gets it, the older ones are never assessed,
and after four milestones nobody can say which domain has what. This document
exists so that never has to be reconstructed from source.

## Status vocabulary, used exactly

| Status | Means |
|---|---|
| `aligned` | the domain uses the capability as the contract intends |
| `partial` | it uses part of it, or uses an equivalent that is not the contract |
| `deferred` | it should use it, it does not, and the milestone that closes the gap is named |
| `not_applicable` | the capability does not apply to this domain, with the reason |
| `needs_extraction` | the gap cannot close while the domain lives in `packages/core` |

`needs_extraction` is the one that matters. It says the blocker is **structural**,
not effort — no amount of care inside `packages/core/src/commercial-actions.js`
makes Commercial a package.

## Where each domain lives today

Verified against the working tree, 2026-08-07.

| Domain | Runtime home | Is it a package? |
|---|---|---|
| Core CRM (Sales) | project-generated modules: company, contact, opportunity, lead, task, approval | no — these are a project's own records, not a domain package |
| Pipeline | `packages/core/src/pipeline-*.js`; `packages/pipelines/generated/` | no — and correctly so, see ¹ |
| Lead Intelligence | `packages/intelligence/` — `src/`, `modules/`, `README.md` | **yes** — the first legacy domain extracted |
| Commercial Operations | `packages/core/src/commercial-*.js`, `catalog-sync.js`; `packages/commercial/generated/` | no |
| Signature & Order | `packages/core/src/signature-*.js`, `external-operation.js`; `packages/signature/generated/` | no |
| Contract Activation | `packages/contracts/` — `src/`, `modules/`, `README.md` | **yes** |
| Delivery | `packages/delivery/` — `src/`, `modules/`, `README.md` | **yes** |
| Custom-package fixture | `examples/custom-packages/partner-scorecard/` | **yes** — the customer-authoring proof |
| Service | not built (M15) | — |
| Marketing & Growth | documentation only (`docs/strategy/`) | — |

Each of the four has a `packages/<name>/generated/` directory and nothing else:
that directory is where a composed project registers the domain's policies and
providers, not where the domain lives.

## The matrix

Columns are the six built domains. Read a row as: *does this domain use this
horizontal capability the way the contract intends?*

### Hosted Docs MCP transport assessment

The stateless Streamable HTTP transport in `packages/docs-mcp/src/http.js` is a
horizontal **documentation/distribution** surface, not a CRM runtime capability.
Its status is `not_applicable` for Pipeline, Lead Intelligence, Commercial
Operations, Signature & Order, Contract Activation and Delivery: it reads the
repository-wide public documentation corpus and claims ledger, imports no domain
package, opens no application/database and exposes no domain mutation. No legacy
domain can align to it or be backfilled into it. This explicit assessment closes
the Compatibility Backfill Rule for the transport without inventing six empty
runtime integrations.

| Horizontal capability | Pipeline | Lead Intelligence | Commercial Ops | Signature & Order | Contract Activation | Delivery |
|---|---|---|---|---|---|---|
| **Domain package seam** (ADR-018) — `definePackage`, declared resources, one static import | `not_applicable` ¹ | `aligned` | `needs_extraction` | `needs_extraction` | `aligned` | `aligned` |
| **Declared cross-package capability** — reaching another domain only through a named, versioned capability | `not_applicable` ¹ | `aligned` | `needs_extraction` | `needs_extraction` | `aligned` — provides `delivery-obligations@1` | `aligned` — requires that one; provides three |
| **`packageContract: 1` conformance** — validated at startup, detach/reattach proven | `not_applicable` ¹ | `aligned` | `needs_extraction` | `needs_extraction` | `aligned` | `aligned` |
| **Package version discipline** — additive bumps, never a silent break | `not_applicable` ¹ | `aligned` — `intelligence@1` | `not_applicable` | `not_applicable` | `aligned` | `aligned` |
| **Module Evolution v1** (ADR-019) — a shipped record grows through a declared revision | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Managed records** — `writable: "managed"`, no public create, update or delete | `partial` — the stage fields are managed and CRUD cannot write them, but a stage is current state rather than append-only evidence | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Human-actor boundary** — the decision requires `actor.type === "user"` | `partial` — the boundary is in the approval workflow around a staged move, not in `move-stage` | `partial` — scoring and routing carry no user-actor requirement: they are deterministic computations from a published definition, not decisions | `aligned` — quote approval | `aligned` — requesting a signature | `aligned` — activation | `aligned` — every writing action |
| **Public refusal receipt** — optional site content renders a tested request, asserted actor and machine-readable result | `not_applicable` ³ | `not_applicable` ³ | `not_applicable` ³ | `not_applicable` ³ | `not_applicable` ³ | `not_applicable` ³ |
| **Public responsibility map** — optional site content separates exactly two layers and states the missing bridge | `not_applicable` ⁴ | `not_applicable` ⁴ | `not_applicable` ⁴ | `not_applicable` ⁴ | `not_applicable` ⁴ | `not_applicable` ⁴ |
| **Public recommendation measurement identity contract** — a URR name match resolves to this framework before entering the numerator | `not_applicable` ⁵ | `not_applicable` ⁵ | `not_applicable` ⁵ | `not_applicable` ⁵ | `not_applicable` ⁵ | `not_applicable` ⁵ |
| **Fingerprinted declared definitions** (ADR-015) — a declared version is content-addressed | `partial` — definitions are validated and drift refuses safely, but a pipeline carries no content-addressed version | `aligned` | `aligned` | `aligned` — provider definitions are fingerprinted | `aligned` | `aligned` |
| **External-operation contract** (ADR-017) — intent, provider call outside every transaction, finalize, compensate | `not_applicable` | `not_applicable` | `partial` — catalog sync predates it and uses its own fetch-then-reconcile shape | `aligned` — it is the contract's origin | `not_applicable` | `not_applicable` |
| **Money contract** (ADR-014) — integer minor units, currencies never summed, no FX | `not_applicable` | `not_applicable` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Transaction-scoped events** (ADR-012) | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Audit and trace on every write** | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Exact reads past the display bound** — `listWhere`/`countWhere` on every correctness path | `not_applicable` — `move-stage` reads one record by id and makes no collection read | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **AX1 visibility** — appears in `app inspect` as a package with resources, actions and capabilities | `partial` ¹ — its actions are reported; there is no package to report | `aligned` — discovered as a package, with no fixed slot | `partial` | `partial` | `aligned` | `aligned` |
| **AX2 citability** — a Solution Plan can cite the domain's capabilities and record revisions | `partial` ¹ | `aligned` — `intelligence@1` is citable | `partial` | `partial` | `aligned` | `aligned` |
| **Package-scoped Admin section** — renders only while the package's schema metadata is published | `not_applicable` — the board is a core Admin feature | `not_applicable` | `partial` — the quote screens are core Admin, not gated on package metadata | `partial` | `aligned` | `aligned` |
| **Detach/reattach proof** — removing the domain removes its whole surface and nothing else | `not_applicable` ¹ | `aligned` | `needs_extraction` | `needs_extraction` | `aligned` | `aligned` |
| **Fault-injection and two-connection evidence** | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Migration array with per-entry checksums** — an applied migration cannot be edited | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Declared action metadata** — `fromStates`/`toState` published in the schema and in `app inspect` | `aligned` | `not_applicable` — scoring and routing are not transitions | `aligned` | `aligned` | `aligned` | `aligned` |
| **A domain Skill, mirrored in `.claude/` and `.agents/`** | `partial` — covered by `create-crm-workflow`, no pipeline-specific Skill | `partial` ² | `partial` ² | `partial` ² | `partial` ² | `partial` ² |
| **A tool namespace of its own** | `not_applicable` | `deferred` — DX13 | `deferred` — DX13 | `deferred` — DX13 | `deferred` — DX13 | `deferred` — DX13 |
| **JTBD rows with linked evidence** | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Scenario evidence (DX6)** — a checked-in scenario runs a real journey and maps what it observed onto the domain's JTBD rows, with the rows it did *not* establish stated | `aligned` — JTBD-03 claimed and established | `aligned` — LI-01, LI-02, LI-04 claimed and established; LI-07 is not claimed | `aligned` — CO-01, CO-03, CO-07 | `partial` ³ | `partial` ³ | `partial` ³ |

### The domains outside the six-column table

| Domain | Where it stands |
|---|---|
| **Core CRM (Sales)** — company, contact, opportunity, lead, task, approval | `not_applicable` on every package-seam row: these are a *project's* generated records, not a domain package, and a customer's own CRM objects must never require one. `aligned` on the kernel rows (module evolution, migration checksums, managed fields where declared, events, audit and trace, exact reads, JTBD evidence). Its Skills are `create-crm-module` and `create-crm-workflow` |
| **Custom-package fixture** (`examples/custom-packages/partner-scorecard/`) | `aligned` on the package seam by construction — it exists to prove a customer-authored package attaches, works and detaches with no kernel change. It deliberately exercises only a slice: one resource, one action, no capability of its own, so the capability rows read `not_applicable` |
| **Service** | **built, on an open PR (M15).** Package-native from its first commit: `aligned` on the package seam, declared capabilities (requires `contracts/service-obligations@1`, provides three), `packageContract: 1` conformance, package version discipline, managed records, the human-actor boundary, fingerprinted declared definitions, transaction-scoped events, audit and trace, exact reads, AX1 visibility, AX2 citability, detach proof, fault-injection and two-connection evidence, and JTBD rows with linked evidence. `not_applicable` on the money contract and the external-operation contract: it prices nothing and calls no provider. `partial` ² on the Skill mirror — the mirrors currently agree, but nothing keeps them agreeing; the same DX2 gap every domain has. `deferred` on a tool namespace: §C.2b of `AGENT_TOOL_SURFACE.md` now works one through on Service, and it stays a proposal until DX13 |
| **Marketing & Growth** | documentation only. No row can be assessed, and none is claimed |

**Scenario evidence for the domains outside the six-column table.** Core CRM
(Sales) is `aligned` — JTBD-04, JTBD-05 and JTBD-05b are claimed and established
by the shipped scenario. The custom-package fixture is `aligned` — JTBD-PK-01 and
JTBD-PK-02. **Service is `deferred`**: its package is composed in the journey's
application and appears in the composition evidence, but no step observes it and
no claim cites it, so the scenario establishes nothing about it. A service
scenario is the next one to write, and needs no code. Marketing & Growth is
`not_applicable` — documentation only.

³ **`partial` on scenario evidence** means the shipped scenario reaches the
domain and claims part of it, not all of it. The journey drives the signature
envelope, webhook verification and reconciliation, the subscription activation,
and delivery handover — but a claim only exists where a scenario wrote one, and
DX6 publishes that as `COVERAGE_IS_CLAIMED_NOT_DISCOVERED`. Delivery execution,
economics, change and acceptance (M14a/M14b1/M14b2) are not in this journey at
all. Closing these is writing scenarios, not changing any domain.

¹ **Pipeline is not a domain.** `buildMoveStageAction` is a generic factory that
stages *any* module a project points it at — a reusable runtime capability, which
is exactly what ADR-018's core budget rule permits in `packages/core`. Extracting
it would be a mistake, not a backfill. It appears in this matrix because a reader
scanning for "everything in core" will find it, and needs to be told why it is
there.

³ **The refusal receipt is a site content contract, not a domain runtime
capability.** Pipeline, Lead Intelligence, Commercial Operations, Signature &
Order, Contract Activation and Delivery are therefore `not_applicable`; so are
Core CRM, the custom-package fixture, Service and documentation-only Marketing &
Growth. Their actual human-actor behavior remains assessed by the row immediately
above. The Smart CRM page uses Commercial's tested quote refusal as evidence, but
that does not make the renderer a capability Commercial must adopt or other domains
must backfill.

⁴ **The responsibility map is also a site content contract, not a domain runtime
capability.** Every domain is `not_applicable`, including those outside the six-column
table. The CDP + CRM page cites Lead Intelligence and the general mutation envelope as
evidence for the process layer; it does not add a CDP dependency, integration seam or
new obligation to any domain package.

⁵ **The recommendation measurement identity contract is a project-level GTM
evidence discipline, not a domain runtime capability.** Every domain is
`not_applicable`, including Core CRM, the custom-package fixture, Service and
documentation-only Marketing & Growth. It governs whether an external model response
may enter a public metric; it adds no requirement to a package, record, action, policy
or provider.

### Reading the shape rather than the cells

The rows split cleanly into two groups, and the split is the whole finding.

**Rows where every domain is `aligned`** — Module Evolution, transaction-scoped
events, audit and trace, fault-injection and two-connection evidence, JTBD
evidence. These are **kernel capabilities**: a domain gets them by existing.
They needed no backfill because there was never a version of the framework where
one domain had them and another did not. That is the argument for putting a
horizontal capability in the kernel when it honestly is one — and ADR-018's core
budget rule is the argument against doing it when it is not.

**Rows where the three older domains are `needs_extraction`** — the package seam,
declared capabilities, contract conformance, detach proof. Every one of them is
the *same* gap wearing a different name. There are not four problems here; there
is one, and extraction is its only fix. The `partial` AX1 and AX2 rows are that
same gap seen from the agent's side: an agent can cite an action of theirs, but
there is no package or capability to cite.

Everything else is `partial` or `not_applicable`, and `partial` is where an
argument is worth having — `not_applicable` rows are settled by the domain's
nature.

## Every non-aligned cell, in full

The matrix gives a status. A status without a consequence is a colour. Each
entry below states the **gap**, the **evidence** it rests on, the **pass that
closes it**, and the **compatibility risk** of closing it.

### `needs_extraction` — Lead Intelligence, Commercial Operations, Signature & Order

Four rows, one gap: the package seam, declared capabilities, `packageContract`
conformance, and the detach proof.

- **Gap.** The domain's runtime lives in `packages/core/src/`, so it declares no
  package, owns no resources through a package, publishes no capability and
  cannot be detached.
- **Evidence.** `packages/{intelligence,commercial,signature}/` contain only
  `generated/`; the runtime is `packages/core/src/{intelligence,commercial,signature}-*.js`.
  `app inspect` on a composed project lists their actions and modules and **no
  package entry** for them.
- **Pass that closes it.** The controlled Legacy Domain Alignment Pass, after
  M15 and after DX4 makes conformance mechanical. One domain, one PR.
- **Compatibility risk.** **High, and it is data risk, not code risk.** These
  domains own scoring runs, quote versions, signed orders and provider
  definitions whose fingerprints are checked at startup. A move must preserve
  every source key, every stored fingerprint and every historical decision
  byte-for-byte. The acceptance criterion is behavior preservation proved from
  outside — a "cleaner" extraction that changes one recorded outcome has failed.

### `partial` — AX1 visibility and AX2 citability, same three domains

- **Gap.** An agent can cite an action or a record revision, but there is no
  package version or capability to cite, so a Solution Plan cannot bind to them
  the way it binds to `delivery@4`.
- **Evidence.** `packages: []` for them in `app inspect`; the AX2 example plan
  can only pin `contracts` and `delivery`.
- **Pass.** Closes automatically with extraction — it is the same gap seen from
  the agent's side, not separate work.
- **Compatibility risk.** Low on its own; it inherits the extraction's risk.

### `partial` ² — the Skill mirrors: the state is clean, the mechanism is not

**Re-measured against the current tree, because the earlier entry was stale.**
It said the domain build Skills existed under `.claude/skills/` only and that
`.agents/skills/` carried none of them. That was true when it was written and is
**no longer true**: the agent-discovery work merged to main copied the mirrors
across.

- **Measured now.** `.claude/skills/` and `.agents/skills/` each carry **12**
  skills, with **none** on one side only. `crm project doctor` reports
  `skills.mirror-coverage` **passing** and `skills.mirror-drift` **passing**,
  and the whole report is `passed`.
- **So why is this still `partial`?** Because the row is about a *capability
  used as the contract intends*, and the contract needs the mirrors to **stay**
  in agreement. Nothing keeps them there. There is no canonical source, no
  `sync`, no CI drift gate and no adapter generation — Project Doctor *detects*
  disagreement and, by design, never writes. The debt was paid down **by hand,
  in state**; the **mechanism** is still missing, and the next skill added to
  one side re-opens it silently until somebody runs the doctor.
- **Evidence.** `ls .claude/skills/` versus `ls .agents/skills/`;
  `crm project doctor --json` → `skills.mirror-coverage`, `skills.mirror-drift`.
- **Pass.** **DX2** (`crm agent skills sync|check`) — unchanged, and now the
  *only* thing missing rather than one of two.
- **Compatibility risk.** **None.** Additive files; no runtime reads them.

This is the distinction the matrix exists to keep: a green check today is not an
aligned capability. Marking this row `aligned` on the strength of a clean `ls`
is exactly the drift-by-silence the document was written to prevent.

### `partial` — Commercial Operations against the external-operation contract

- **Gap.** Catalog sync predates ADR-017 and uses its own
  fetch-outside-the-transaction then reconcile-inside-one shape rather than the
  intent / call / finalize / compensate contract Signature established.
- **Evidence.** `packages/core/src/catalog-sync.js` versus
  `packages/core/src/external-operation.js`.
- **Pass.** Deferred, with no milestone named — and deliberately so. Catalog sync
  is idempotent by DB-unique source keys and has its own tests; rewriting a
  working external boundary to match a later contract is a change with real risk
  and no user-visible benefit.
- **Compatibility risk.** **Medium.** It touches a provider boundary and a
  reconciliation path that customers' catalogs depend on.

### `partial` — the Admin sections of Commercial Operations and Signature & Order

- **Gap.** Their screens are core Admin, not gated on package metadata, so they
  do not disappear when a package does.
- **Evidence.** `apps/admin/public/admin-quotes.js` and `admin-signature.js`
  render unconditionally; `admin-delivery-change.js` returns early without
  `schema.domains.delivery.changeAcceptance`.
- **Pass.** Follows extraction; there is nothing to gate on until a package
  publishes metadata.
- **Compatibility risk.** Low.

### `partial` — Pipeline's managed records, human boundary and fingerprints

- **Gap.** A stage is current state rather than append-only evidence; the human
  boundary lives in the approval workflow around a staged move rather than in
  `move-stage`; a pipeline definition is validated but carries no
  content-addressed version.
- **Evidence.** `packages/core/src/pipeline-actions.js` and
  `pipeline-registry.js`; the human check is in
  `packages/workflows/src/decide-opportunity-approval.js`.
- **Pass.** **None planned, and none needed.** These are properties of a generic
  staging mechanism, not gaps in a domain. Recording them stops a future reader
  concluding Pipeline was overlooked.
- **Compatibility risk.** Not applicable.

### `deferred` — a tool namespace, every domain

- **Gap.** No domain has an MCP namespace; the shipped MCP server exposes a
  sample domain that predates AX1 and AX2.
- **Evidence.** `docs/MCP.md`; `docs/architecture/AGENT_TOOL_SURFACE.md` §B.3.
- **Pass.** **DX13**, and only after the exposure policy in that document is a
  decision rather than a proposal.
- **Compatibility risk.** Low — additive — but it is the row most likely to be
  closed badly. §C.0 exists to stop "one tool per package" being the answer.

## The Compatibility Backfill Rule

> When a PR introduces or changes a **horizontal** capability — one that every
> domain could use — it must, in that same PR, record every existing domain's
> status against it in this matrix, using the vocabulary above, with a one-line
> reason. A `deferred` status must name the milestone that closes it.
>
> **Declaring the gap is mandatory. Closing it in the same PR is not.**
> Retrofitting five domains inside a feature PR is how a feature PR stops being
> reviewable. But a capability that only the newest domain has, and that nobody
> wrote down, is a fork rather than a platform.

Five questions, answered in the PR body:

```text
Which old domains does this touch?
Which are already aligned?
Which need metadata only?
Which need a code backfill?
Was the Legacy Alignment Matrix updated?
```

The distinction between the third and fourth is the useful one. A metadata gap —
a manifest flag, a published field, a Skill file — is cheap and can often be
closed immediately. A code backfill is a change to a domain's runtime, and for a
`needs_extraction` domain it is not closeable at all until that domain moves. A
PR that cannot tell the two apart has not looked.

Three practical consequences:

1. The row is written by the PR that creates the capability, not by whoever
   later notices the gap.
2. `needs_extraction` is an acceptable answer. It is not an admission of failure;
   it is the honest name for a structural blocker.
3. A reviewer may reject a PR for a missing row the same way they reject a
   missing test — and `docs/QUALITY_GATES.md` §1 now says so.

## The M15 backfill answer, as the rule requires

M15 introduced one horizontal change: a **second capability on an existing
package**, `contracts/service-obligations@1`, and with it the first evolution of
a shipped M12 record (`service-obligation` → revision 2, gaining `coverageRef`
and `activatedAt` and an `activated` status).

| Question | Answer |
|---|---|
| Which old domains does this touch? | **Contracts only.** It gains a capability and a record revision; nothing else in the repository changed shape |
| Which are already aligned? | Contracts is `aligned` on every seam row and stays so: the capability is additive, `delivery-obligations@1` is byte-identical, and `packageContract: 1` did not move |
| Which need metadata only? | **None.** No other domain gained a concept it must now declare |
| Which need a code backfill? | **None.** Service is a new package and owns its own surface; the three `needs_extraction` domains are untouched and no closer to extraction than before |
| Was the matrix updated? | Yes — the Service row above, and this section |

The honest note: M15 is *not* evidence that the seam is finished. It is the
third package and the second consumer, and what it showed the seam still cannot
express is the input to step 3 of the sequencing below.

## The DX4 backfill answer, as the rule requires

DX4 (`crm package test`) is a **horizontal capability**: it applies to every
package, including the three domains that are not packages yet.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **None at runtime.** DX4 adds a CLI command and moves three pieces of shared CLI logic into their own modules. No kernel behaviour changes, no domain is refactored |
| Which are already aligned? | The three first-party packages — Contracts, Delivery, Service — pass `crm package test` mechanically, which is stronger than the prose "aligned" that preceded it. The custom-package fixture **does not**: it acts on a record `delivery` owns without declaring `delivery`, and no capability of `delivery` expresses that. A real seam gap, reported rather than rescued |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None today.** The three `needs_extraction` domains cannot be run through DX4 at all: they are not packages, so there is nothing for it to compose. That is not a new gap — it is the same gap, now measurable |
| What changed for extraction? | DX4 is the gate the extraction pilot was waiting for. An extracted domain is a package, and a package that cannot pass `crm package test` has not been extracted, only moved |
| Matrix updated? | Yes — this section, the conformance row below and the revised extraction gate |

One row of the matrix changes meaning rather than status: **"JTBD rows with
linked evidence"** and the package-seam rows were previously argued from prose
and per-package suites. For the four packages they are now argued from a
mechanical run whose output is a stable document. The three legacy domains stay
exactly where they were.

### `service` had no conformance coverage until now

`assertPackageConforms` was called three times — for `contracts`, `delivery` and
`partner-scorecard`. The newest package, the one M15 built and the one this
matrix cites as validating the seam, had **none**. Anything this document said
about "every package conforms" was untrue of `service` at the moment it was
written. DX4's official matrix covers all four, and its suite fails if a package
is added without being listed.

## The DX3 backfill answer, as the rule requires

DX3 (`crm package scaffold`) is a **horizontal capability** in the same sense
DX4 is: it applies to every package that could exist, including the three
domains that are not packages yet.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **None, at runtime or on disk.** DX3 adds one CLI command and one test file. It changes no kernel behaviour, refactors no domain, and its own output is written only where a caller points it |
| Which are already aligned? | Not the right question for this capability. DX3 produces *new* packages; the four existing ones were written before it and none is regenerated. What is aligned is the **shape**: scaffolded output passes the same `crm package test` matrix the four packages are held to, so DX4's contract is now the default starting point rather than something an author has to remember |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None.** The three `needs_extraction` domains cannot be scaffolded any more than they can be conformance-tested — they are not packages. DX3 does not change that, and a scaffold is explicitly *not* an extraction tool: it writes an empty package, never a migration of an existing one |
| What changed for extraction? | The pilot gains a starting point but no permission. An extraction now begins `crm package scaffold lead-intelligence --apply` and proceeds by moving code into it, with `crm package test` as the gate. Every precondition recorded below is unchanged and still unproved |
| Matrix updated? | Yes — this section and the re-evaluated ordering below |

### What DX3 deliberately did not close

- **No domain semantics.** The scaffold generates no record, action, policy,
  capability, provider, Admin section, Solution Plan or MCP tool. That is a
  decision, not an omission: a generated field is a claim about a business
  nobody described, and an agent reads generated code as a decision already
  taken.
- **No composition.** `packages/domains/generated/index.js` is still edited by
  hand. Automating it would remove the one deliberate human act in the
  package-installation path.
- **No migration, no database, no install, no publish, no registry.**
- **No HTTP-route contribution.** Still the open seam DX4 identified, still a
  precondition for Commercial and Signature specifically, and still untouched.

## The DX1 backfill answer, as the rule requires

DX1 (`crm project doctor`) is a **horizontal capability**: it applies to every
project built on this framework, and to every domain in one.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **None at runtime.** DX1 adds one CLI command, two CLI modules and a test file. It changes no kernel behaviour, refactors no domain, mutates nothing and executes no project source in its own process |
| Which are already aligned? | All of them, in the only sense the command measures: it reports composition, package-boundary, module-state, plan, Skill, docs-link and hygiene health for whatever the project contains, and the three `needs_extraction` domains are ordinary kernel source to it. Its first run on this repository is **0 failures** with three real warnings — two stale Solution Plans and six one-sided Skill mirrors |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None.** The doctor asks existing authorities; it introduces no rule any domain must now satisfy |
| What changed for extraction? | It becomes a precondition of the *process* rather than of the seam: an extraction should start from a project whose coherence is machine-checked, and should be re-checked after. It does not remove any of the four open blockers |
| Matrix updated? | Yes — this section, and the extraction gate now maintained in `EXTRACTION_PREPARATION.md` |

### What DX1 measured that this matrix had only asserted

Two rows of this document were prose until now and are now mechanical:

- **the Skill mirrors.** This matrix records `partial` because six domain build
  skills exist under `.claude/` only. `crm project doctor` reports that as
  `skills.mirror-coverage: warning` with the six named, and would report a
  **failure** if two mirrors of one skill ever disagreed in content. DX2 still
  owns the fix; the gap is now observed on every run rather than remembered.
- **Solution Plan currency.** Two of the three checked-in plans no longer bind to
  the current composition. That was true before this PR — verified identical on
  `main@5da5205` — and nothing reported it. It is now `plans.*: warning`.

### What DX1 deliberately did not close

- **No mutation, no `--fix`.** Every finding names the existing command that
  would fix it.
- **No domain behaviour, no database, no provider health, no production
  readiness.** All named limitations in the report itself.
- **No package conformance run.** `PACKAGE_CONFORMANCE_NOT_RUN` points at
  `crm package test`.
- **No generated-source drift beyond what a generator contract proves.** A
  fuzzy comparison that cries wolf is a check people silence.

## The Project Bootstrap answer: **not horizontal**, and why that is the finding

`create-accordo` (`packages/create-accordo`, `projectBootstrapContract: 1`) is
recorded here **because the rule's failure mode is silence.** An unrecorded "not
horizontal" is indistinguishable from a forgotten one, so the judgement is
written down where somebody can disagree with it in one place rather than
reconstruct it from the diff.

**The judgement: it is not a horizontal capability, and no domain row exists for
it.** The rule's test is *"one every domain could use"*. This sits one level
**above** domains: it creates the container a domain lives in. It composes none
of them — the generated `packages/domains/generated/index.js` is the empty one
this repository ships — and it introduces no contract, check or discipline that
a domain is measured against. The question a matrix row would have to answer,
*"is Commercial Operations aligned with project bootstrap?"*, has no meaning in
the way *"is it aligned with the package seam?"* does.

Contrast the three that **did** declare a horizontal answer, each for a reason
this one lacks: DX4 introduced a conformance contract every package is held to;
DX3 made the shape every new package starts from; DX1 introduced findings graded
against every project. This introduces a way to *obtain* a project, and then gets
out of the way.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **None, at runtime or on disk.** It adds one package, one test file and documentation. It changes no kernel behaviour, refactors no domain, executes no project source, opens no database and mutates nothing outside a caller-chosen empty directory |
| Which are already aligned? | Not a question this capability asks. Every domain's source is copied into a generated project as inert files; none of them is composed, so none is graded |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None** |
| What changed for extraction? | **Nothing.** Every precondition in `EXTRACTION_PREPARATION.md` is unchanged and still unproved. A bootstrap produces empty projects; it moves no domain out of `packages/core` and it is not an extraction tool |
| Matrix updated? | Yes — this section, recording the decision rather than a row |

### What it deliberately did not close

- **No domain composition.** A project that arrived carrying somebody else's
  Lead model is the DX3 "rich template" mistake at project scale, and it is
  refused for the same reason: a generated domain is a claim about a business
  nobody described.
- **No upgrade path.** The framework is vendored, so a generated project
  upgrades by merging rather than by bumping a version. Closing that needs a
  published, versioned framework package — a human decision, not a code gap.
- **No publication.** The npm names remain empty reservations. The source
  scaffolds; the registry does not.

## The DX6 backfill answer, as the rule requires

DX6 (`crm scenario run`) is a **horizontal capability**: business-scenario
evidence is something every domain could have, and this matrix already carries a
"JTBD rows with linked evidence" row that DX6 turns from prose into a report.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **None at runtime.** DX6 adds one CLI command, three CLI modules, one checked-in scenario document and two test files. It changes no kernel behaviour, refactors no domain, and writes nothing into the project it reports on — the journey composes its application in a temporary directory outside the repository, which is removed afterwards. The one change outside the CLI is that `EXECUTABLE_SHAPES` is now **exported** from `packages/core/src/solution-plan.js`, so the scenario contract refuses commands from the same constant rather than a second copy. No behaviour changed |
| Which are already aligned? | Pipeline, Lead Intelligence and Commercial Operations, plus Core CRM and the custom-package fixture outside the table: the shipped scenario claims and establishes their headline rows |
| Which need metadata only? | **None.** A domain gets scenario evidence by a scenario claiming it — a checked-in JSON document, no code |
| Which need a code backfill? | **None.** A *new journey* would need a registry entry in `packages/cli/src/scenario-journey.js`, deliberately: that boundary is what keeps a document from naming something to run |
| What is `partial`, and why | Signature & Order, Contract Activation and Delivery: the journey drives more of each than any claim cites. DX6 cannot discover coverage — it checks what a scenario claims, and says so as `COVERAGE_IS_CLAIMED_NOT_DISCOVERED` |
| What is `deferred`, and closed by what | **Service.** Its package composes into the journey's application but nothing observes it. Closed by writing a service scenario; no milestone is required |
| What changed for extraction? | Nothing. DX6 measures jobs, not seams. It is neutral on the three `needs_extraction` domains and adds no blocker |
| Matrix updated? | Yes — the row above, footnote ³, the note under the outside-the-table domains, and this section |

### What DX6 deliberately did not close

- **It promotes no JTBD row.** `docs/QUALITY_GATES.md` §3 keeps that with a
  person, on merged tests. DX6 reports evidence, publishes
  `SCENARIO_IS_NOT_PROMOTION`, and opens `jobs.json` and the matrix read-only.
- **It discovers no coverage.** A row a journey exercises but no scenario claims
  is reported as **not established**, exactly like a row nothing touched.
- **It drives no browser**, so nothing here is evidence about the Admin as a user
  sees it — the same `BROWSER_EVIDENCE_NOT_AUTOMATED` gap DX5 publishes.
- **It speaks for one composition only** (`EVIDENCE_IS_ONE_COMPOSITION`), and one
  journey and one scenario ship today.

## The LA0 backfill answer, as the rule requires

LA0 (the Lead Intelligence characterization harness) is **not** a horizontal
capability in the sense the rule usually means — it adds no kernel behaviour and
no contract any domain must satisfy. It is recorded here because it changes what
this matrix can claim about one domain.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **Lead Intelligence only**, and only by observing it. No code moved, no helper was relocated, no ambient field replaced, no seam added |
| Which are already aligned? | Not the frame. What changed is coverage: Lead Intelligence now has a frozen, machine-checked record of its externally observable behaviour — 149 observations, 779 asserted values. Commercial Operations and Signature & Order have **none** |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None from LA0 itself.** It surfaced two `defect_candidate` findings in `record-signal` — an unbounded `value` and control characters stored verbatim — which are fixed in their own open PR, before the extraction rather than during it |
| What changed for extraction? | The acceptance criterion — behaviour preservation proved from the outside — is mechanical for the first time. It was the last unknown; what remains is decisions |
| Matrix updated? | Yes — this section |

### Characterization coverage, by domain

| Domain | Characterized | Note |
|---|---|---|
| Lead Intelligence | **yes** — `tests/characterization/`, `legacyCharacterizationContract: 1` | the extraction candidate. Still **not** package-aligned: it remains kernel source with an ambient runtime field and a fixed definition slot |
| Commercial Operations | no | would need its own suite before any extraction |
| Signature & Order | no | same, plus the HTTP-route seam it owns |
| Contracts, Delivery, Service | **not applicable** | package-native from birth; `crm package test` plus their own suites already cover them |

**LA0 is a gate for extracting a legacy domain, not a requirement for building a
new one.** A package written package-native has no pre-move behaviour to
preserve, and demanding a characterization baseline from it would be ceremony.

## Sequencing, which this document does not change

```text
1.  finish, independently review and merge M14b2      done (PR #25)
2.  M15 — Service package, built on the seam          ← where we are
3.  review the M15 learnings: what the seam still cannot express
4.  a controlled Legacy Domain Alignment Pass, one domain at a time
```

Steps 2 and 3 come before step 4 on purpose. Contracts and Delivery are two
data points, and Delivery is the only one that has *consumed* another package's
capability. Service is the third — and the first built with the seam already
mature. Extracting a legacy domain before that learning bakes today's shape into
four more places.

**DX4 (`crm package test`) is the practical gate.** An extraction without a
conformance harness is a refactor whose only proof is that the existing tests
still pass — which is precisely the proof that misses a boundary violation. The
roadmap already sequences DX3 and DX4 after M15, and the extraction pilot after
DX4.

### Lead Intelligence as the first extraction — a hypothesis, pending evidence

**This is a working hypothesis, not a decision.** It is recorded so the eventual
choice is argued against a written position rather than made ad hoc.

Why it is the plausible first candidate:

- **Its dependency direction is inward.** Intelligence reads CRM records and
  writes its own evidence. It is not read by Commercial, Signature or Delivery,
  so extracting it should not require a new capability for anyone else.
- **It already has the shape.** Versioned fingerprinted definitions (ADR-015),
  managed append-only evidence, a reproducible historical decision — the
  properties a package must prove are already proven for it.
- **Its blast radius is bounded.** Scoring and routing are self-contained;
  Commercial and Signature carry money and an external provider.
- **Its failure mode is legible.** A scoring or routing regression is visible in
  a reproduction test, not months later in a ledger.

What must be true before it is chosen — none of which is established today:

1. DX4 exists and a package can prove conformance mechanically.
2. M15's learnings are reviewed and the seam has whatever they showed it needs.
3. A real dependency audit shows nothing reads Intelligence internals — asserted
   above from the layout, **not yet proved by a tool**.
4. Every historical routing decision still reproduces identically across the
   move. Behavior preservation is the entire acceptance criterion.

If any of those fails, another domain is the pilot, or none is. **Nothing in this
document authorizes starting an extraction.**

### The three candidates, measured (M15 review)

The hypothesis above was written before M15 shipped. The M15 review measured the
three candidates rather than reasoning about them, so the eventual decision is
argued against numbers. **Still planning only: nothing here starts an
extraction, and no extraction work is in PR #27.**

| | Lead Intelligence | Commercial Operations | Signature & Order |
|---|---|---|---|
| kernel source to move | 1,313 lines, 2 files | 1,393 lines, 3 files | 1,488 lines, 2 files |
| files outside the domain that name it | 11 | 16 | 10 |
| dedicated HTTP routes in the kernel server | none | `POST /api/catalog/sync` | `POST /api/signature/providers/:provider/events`, `POST /api/signature/envelopes/:id/reconcile` |
| dedicated method on the app object | none | `syncCatalog` | `ingestSignatureEvent`, `reconcileSignature` |
| `/api/schema` block | `intelligence` | `commercial` | `signature` |
| Admin files that read its schema block | 0 | 6 | 3 |
| carries money | no | **yes** (`commercial-money.js`, 416 lines) | yes, by reference |
| calls an external provider | yes, in a `prepare` phase the kernel already isolates | yes, outside the write transaction | **yes, and it receives inbound webhooks** |
| depended on by another domain | no | **yes** — Contracts activates an Order; Delivery and Service reach obligations raised from it | yes — Contracts reads the signed Order |
| what a regression looks like | a reproduction test disagrees | a stored amount disagrees | an envelope or artifact is lost, or a webhook is accepted twice |

Three things the table says that prose did not:

1. **Intelligence is the only candidate with no kernel HTTP surface, no app
   method and no Admin coupling.** Its extraction is a package boundary and
   nothing else. Commercial and Signature each require moving a route out of
   `apps/server`, which is a second, unrelated piece of work — and one the
   package seam does not currently support at all: **no package can contribute
   an HTTP route today.** That is a seam gap, not a scheduling problem.
2. **Commercial is the most depended-upon.** Contracts, Delivery and Service all
   sit downstream of the Order it produces. Moving it first means designing
   three capability edges at once, on the domain that carries money.
3. **Signature is the riskiest for a reason unrelated to size.** It is the only
   domain that accepts bytes from outside. An extraction that changes where the
   verification code lives is an extraction that has to re-prove replay,
   out-of-order and wrong-tenant handling — the evidence hardest to be confident
   about after a move.

**Recommendation: Lead Intelligence, at moderate confidence.** Moderate rather
than high because two of its four preconditions are still unproved — DX4 does
not exist, and "nothing reads Intelligence internals" is read off the file
layout rather than established by a tool. The measurement strengthens the
hypothesis; it does not convert it into a decision.

**A precondition the table added:** before Commercial or Signature could ever be
a candidate, the package seam needs a way for a package to own an HTTP route.
Neither is extractable today at any confidence, and that is a finding about the
*seam*, not about them.

### Recommended next ordering

Ordering, with the reason each item sits where it does. This is a
recommendation to a human, not a plan of record:

1. **DX4 — `crm package test` (conformance harness).** Everything else that
   touches the seam is safer after it, and it is the stated gate for any
   extraction. Without it an extraction's only proof is that the old tests still
   pass, which is exactly the proof that misses a boundary violation.
2. **DX3 — package scaffold.** Cheap next to DX4, and it makes DX4's contract
   the default shape rather than something to remember.
3. **DX1 — `crm doctor` deepening.** Independent of the seam, useful to every
   other item, and the smallest of the four.
4. **The extraction pilot — Lead Intelligence.** Only after 1 and 2, and only if
   its four preconditions are established rather than assumed.
5. **DX2 — Skill mirror sync.** Real (six domain build skills now live under
   `.claude/` only) but nothing depends on it, and it stays a documentation
   correctness gap rather than a runtime one.
6. **M16 — Analytics Studio.** Last, because it is the item most likely to
   *consume* whatever the extraction learns about reading across packages. Doing
   it before the pilot risks writing the cross-package read pattern twice.

The one ordering claim worth arguing with: DX2 sits fifth despite being the
cheapest, because cheap and urgent are different, and the gap is already
documented in this matrix.

### Re-evaluated after DX4 was built

DX4 is now item 1 done. Three things it established change the ordering below
it, and one thing it did **not** establish leaves a recommendation where it was.

**Lead Intelligence is still the recommended pilot, and the confidence rises
from moderate to moderate-high.** DX4 removes the largest unknown: "how would we
know the extracted domain still conforms" now has a mechanical answer, and that
answer is a stable document rather than a reviewer's judgement. The remaining
preconditions are unchanged and still unproved — nothing yet establishes that
no code reads Intelligence internals, and behaviour preservation across the move
is still the whole acceptance criterion.

**But DX4 also measured what an extraction would have to produce.** A package
passes `crm package test` only if it declares its records, its actions target
records somebody owns, its dependencies are declared capabilities, its manifests
apply and the application boots without it. Intelligence today has none of that
shape: its actions live in `packages/core/src/intelligence-actions.js` and its
registries in the kernel. The extraction is therefore not a move — it is an
authoring exercise with a conformance target, which is a better-defined job than
it was a week ago and not a smaller one.

**The HTTP-route seam is confirmed as an extraction precondition, and DX4 did
not need it.** DX4 composes and boots packages without any package contributing
a route, so the answer to "is route contribution required for generic package
conformance" is **no**. It stays exactly what the previous section called it: a
precondition for Commercial and Signature specifically, because each owns a
route in `apps/server` that would have to go somewhere. Neither is extractable
at any confidence until that seam exists, and building it was correctly out of
DX4's scope.

**One new precondition DX4 surfaced, and its review sharpened it.** There are
two different situations that look alike:

- acting on a record **no package owns** — a *host-application* record. Every
  legacy domain does this (Commercial and Signature on `quote` and `order`,
  Intelligence on `lead`), every package here does it on `order`, and it is
  ordinary: the project supplies the manifest. `crm package test` passes it.
- acting on a record **another package owns**, without declaring that package.
  `crm package test` **fails** it, because the package cannot be composed into
  any project that lacks the owner and nothing in its declaration says so.

For extraction this is good news: the legacy domains' record dependencies are
almost all of the first kind. The one that would need a decision is any
extracted domain acting on another *extracted* domain's record — and the answer
is either a capability on the owner, or an explicit contract extension for
record-level coupling. Neither is needed to start the pilot.

`partner-scorecard` is the worked example of the second kind, and it is
**non-conforming** as a result: `delivery` offers no capability that expresses
rating a partner engagement. That is a real seam gap, recorded rather than
patched.

### The extraction gate now lives in its own document

The measured blockers, the LA0 characterization-harness design, and the decision
analyses for `app.intelligence` and the definition registry are maintained in
**`docs/architecture/EXTRACTION_PREPARATION.md`**, produced alongside DX1. The
summary below is the state as of DX3 and remains accurate; the newer document
adds the recommendations and the ordering.

### Re-evaluated after DX3 was built — extraction readiness, measured

The question DX3 makes it fair to ask: **is the path now complete enough to
extract Lead Intelligence?**

```text
crm app inspect        the composition before                    exists (AX1)
crm solution check     a plan bound to that composition          exists (AX2)
crm package scaffold   an empty conforming lead-intelligence     exists (DX3)
  move code            registries, actions, records              by hand
crm package test       does the result conform?                  exists (DX4)
  characterization     does it still decide identically?         DOES NOT EXIST
```

Five of six rungs exist. **The recommendation does not change: do not start.**
Confidence in Lead Intelligence as the right *first* pilot stays moderate-high;
confidence that it can be started *today* is low, and the reasons are now
measured rather than assumed.

**The precondition "no code reads Intelligence internals" is disproved.** It was
recorded as unproved; it is now false, and the evidence is three imports:

| Reader | What it reaches for | Why it blocks |
|---|---|---|
| `packages/core/index.js` | re-exports `computeDefinitionFingerprint` from `intelligence-registry.js` | it is **public kernel API** that every package depends on, sitting inside the domain that would move |
| `packages/core/src/catalog-sync.js` | `withTimeout` from `intelligence-actions.js`, `computeDefinitionFingerprint` from `intelligence-registry.js` | Commercial Operations' provider sync depends on Intelligence's *files*, and Commercial is itself `needs_extraction` |
| `packages/cli/src/app-inspect.js` | `packages/intelligence/generated/index.js` by path, as one of AX1's fixed composition slots | AX1's report shape names `intelligence` as a first-class definition kind |

The first two are the real blocker and they have the same shape: the
fingerprint and timeout helpers are **horizontal kernel machinery that happens
to live in an Intelligence file**. They must move to a neutral kernel module
*before* any extraction, as a separate, behaviour-preserving PR. That is a
prerequisite, not part of the pilot.

> **Resolved** by the neutral-helper move. `computeDefinitionFingerprint`,
> its canonicalizer and `validateDeclaredConfig` now live in
> `packages/core/src/definition-fingerprint.js`, and `withTimeout` in
> `packages/core/src/timeout.js`. The finding above is left standing as the
> record of what was measured; what changed is where the code lives, not
> whether the reading was true. The importer list LA0 measures shrank from
> ten files to four, and the four that remain — `create-app.js`, the
> starter's `install.mjs`, `DECISIONS.md` and Intelligence's own actions
> module — are genuine Intelligence dependencies rather than helper reach-ins.
> The third row, AX1's fixed composition slot, is untouched and still open.

**Two seams the extracted package would need and cannot declare today.**

- `app.intelligence` is a field on the application object. It is published in
  `/api/schema` (`apps/server/src/http-server.js`) and injected into every
  action's context (`packages/core/src/action-runtime.js`). A package can
  declare a *capability*, which another package opens deliberately; it cannot
  contribute an ambient context key that every action in the application
  receives. Either that ambient key becomes a declared capability — a real
  behaviour change for every existing action — or the contract grows a way to
  express it. Neither is decided.
- `packages/intelligence/generated/index.js` is a **project-owned registry
  file**, on the same pattern as `packages/actions/generated`. A package that
  owns a definition kind needs somewhere for a project to declare instances of
  it. There is no generic seam for a package to contribute one, and inventing
  one for a single consumer would violate this repository's own rule that a new
  generic seam needs two real consumers.

**And the acceptance criterion has no harness.** The criterion is behaviour
preservation proved from the outside: every historical decision reproduces
identically. `crm package test` cannot answer that — it says so itself, under
`DOMAIN_CORRECTNESS_NOT_PROVEN` — and no characterization-test harness exists.
An extraction started before that harness has, as its only proof, "the existing
tests still pass", which is precisely the proof this document has twice said is
insufficient.

**So the ordered blockers, none of which is an extraction:**

1. Move `computeDefinitionFingerprint` and `withTimeout` out of the Intelligence
   files into neutral kernel modules. Behaviour-preserving, mechanical, its own PR.
2. Decide `app.intelligence`: ambient context key, or declared capability.
3. Decide how a package contributes a project-owned definition registry — or
   establish that Intelligence keeps its registry in the host application.
4. Build the characterization harness that can prove behaviour preservation.
5. *Then* the pilot, one domain, one PR.

Item 1 is small and independently useful; it is the honest next thing anyone
who wants the pilot should do. Items 2 and 3 are contract decisions and belong
to a human. Nothing in this section authorizes starting any of them.

## What this document is not

- Not a schedule. No date, no milestone number for the alignment pass.
- Not permission to refactor a legacy domain.
- Not a judgment on the older domains. They are the reason the seam is any good.
- Not a test-count report. Volatile numbers live in `docs/PROJECT_STATUS.md`.

## Evidence

`DECISIONS.md` (ADR-012, ADR-014, ADR-015, ADR-017, ADR-018 and its addenda,
ADR-019, ADR-020), `docs/PACKAGE_AUTHORING.md`, `docs/APPLICATION_INSPECTION.md`,
`docs/CODER_TOOLING_ROADMAP.md`, `docs/architecture/AGENT_TOOL_SURFACE.md`,
`docs/QUALITY_GATES.md`, `packages/contracts/README.md`,
`packages/delivery/README.md`. Cell values were checked against the working tree
on 2026-08-07; a reader who doubts one should run
`npm run crm -- app inspect --json` in a composed project and compare.
