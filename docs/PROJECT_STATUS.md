# Project status

The single operational snapshot of the repository. Volatile facts — merged
milestone, the commit the public numbers were measured at, open PRs, next task —
live **here and nowhere else**; `docs/strategy/MASTER_PLAN.md` holds the stable
vision and links to this file.

> **Update this file in the same PR as every milestone merge.** A status file
> that lags is worse than no status file.

**This file measures nothing of its own, and states no test count.** The count
is measured, never typed: it lives in `site/claims.json` under `measuredAgainst`,
written by `node scripts/measure-suite.js --apply` from a real green run on a
clean tree (ADR-027, `scripts/measure-suite.js`). The `Measured at` row below
*cites* that record's commit, and `npm run gtm:check` fails when the two
disagree. That binding exists because they did disagree, silently: a branch
re-measured the ledger, a merge resolved the conflict in favour of the older
side, and every gate stayed green while the published numbers ran a wave behind
the suite. This file used to own a second SHA and a second count of its own, and
a test pinned both in place — which is how a status file becomes the most
confidently wrong document in a repository.

Generated: **2026-08-18**.

## Snapshot

| Fact | Value |
|---|---|
| Latest merged milestone | **The coding-agent DX wave**, merged in this order: PR #64 (CI keep-alive), PR #65 (**M16a** — renewal & expansion operations, the fourth domain package), PR #66 (**DX5** — `project verify`) and PR #67 (**DX6** — a second scenario). DX6 now ships **two** checked-in scenarios and two journeys over two different compositions — a sales funnel on the wall clock, and a service SLA/escalation story on an injected, stepped clock — which moved the **report** contract to `scenarioRunContract: 2` while the **document** contract stayed at `1`. The rule that came out of it is ADR-029. Then **Work v1** (PR #70, ADR-030): one package-native Task and Activity domain, held against an opaque subject envelope, consumed by three business events through a declared capability that refuses to write unless it is inside the caller's transaction. It claims no `M`-number, because taking one would assert a position in a sequence a horizontal capability does not have. Its adversarial review found seven defects, one of them a reachable half Task/Activity pair, and answered the browser-only timeline defect with a new shared read surface (ADR-008 addendum 2). Then **DX10** (PR #71, ADR-031): `accordo solution verify <plan> --evidence <doc>` grades each requirement of a checked-in Solution Plan against authorities that ran in the same invocation, over an evidence document that has **no status field** — it may point at proof and never declare it. Its review found eight defects, two critical: an evidence author could reach `verified` by labelling a behavioural requirement `structural`, and a requirement could be verified from a run of a **different application**. The first of those reached exit 0 through the real CLI on this repository before it was closed. Then the **AX3 benchmark** (PR #72): a frozen protocol with a receipt contract, a shell classifier checked against bash itself over a cross-product differential oracle, and the first frozen panel — one arm produced valid runs, two are recorded `NOT_RUN`, `comparative: false`, and no rate exists in the record, which is kept in-repo beside its receipts. Then the **rail-selection guidance** (PR #74): one "Selecting an Accordo rail" section, byte-identical in `CLAUDE.md` and `AGENTS.md` — a question→rail table, boundary discriminators and a smallest-rail selection rule. Guidance, not orchestration: no command, tool, router or Skill change. Then the AX3 benchmark's **second frozen panel** (PR #75): the re-run against the new instruction surface, landed as internal evidence from a rewritten branch history — `comparative: false`, no rate, receipts and the invalidated first attempt retained, a receipt being six evidence files and never the apparatus config tree. Then the **Commercial Operations extraction** (PR #79): the second legacy domain leaves `packages/core` for the optional `packages/commercial` on the Lead Intelligence pattern — LA0-Commercial frozen before the move and replayed after with zero asserted observations changed; two declared capabilities (`commercial-quotes@1`, `commercial-quote-binding@1`) sized by the Signature domain's measured consumption; the ambient `app.commercial`/action-context/AX1 wiring gone with no fallback; `external-operation.js` deliberately kept in core; catalog sync's app method recorded as the bounded residue that motivates the package application-operation decision. Its independent review found one Medium defect — the offered capabilities had no behavioural coverage — fixed with a regression suite before merge. Then the **Signature & Order extraction** (PR #84): the third and last legacy domain leaves `packages/core` for the optional `packages/signature`, implementing **ADR-032** exactly within its five-item core boundary — operations are package-declared and attached generically, the enumerated routes delegate to composed aliases, and the raw-body webhook stays the explicit kernel adapter on measured grounds. All three LA0 baselines replayed with byte-identical asserted fingerprints (Signature 110 observations, Commercial 107, Intelligence 151). Moving `order` ownership made Contract Activation's actions a declarable record-level dependency: signature offers `signature-orders@1`, contracts declares it, and — by reviewer decision — contracts moved to **version 5**, because a package version describes its composition contract, including `requires`, not only its consumer-visible records/actions. The second reviewer decision closed the applicationOperations v1 context to exactly the keys its two real consumers use (`config`, `database`, `events`, `modules`, `runExternal`) — the unused bounded trace writer is deferred by the ADR-032 implementation addendum until a first real consumer migrates onto it. With this merge **every former legacy domain is package-native**; `external-operation.js` stays in core as the recorded neutral runner, and M16b amendment execution is architecturally unblocked (Commercial and Signature are reachable through declared capabilities) and remains unimplemented. Then **signed commercial terms** (PR #87, ADR-033): the M16b prerequisite — a public-writable `quote-term` draft that binds nothing, frozen write-once into `quote-version-term` at submit, carried inside the canonical signed document bytes and the `documentHash`, reproduced at completion into a write-once `order-term`, and consumed verbatim by activation as `signed-order-terms`, with `contract-lifecycle-source@2` deriving `signed: true` only from that chain. Termless versions canonicalize byte-identically; old orders are never backfilled and a genuine pre-terms database upgrades with history read back byte-identical; activation on a signed order refuses manual term inputs (`SIGNED_TERMS_AUTHORITATIVE`). All three LA0 baselines replayed byte-identical. Its independent review confirmed every priority attack held — no path presents unsigned terms as signed — and locked the one uncovered degradation branch (older commercial reader) with a revert-verified test. M16b itself remained unimplemented until the next entry. Then **M16b — renewal and amendment execution** (PR #89, ADR-035): a human executes a governed successor commercial agreement from immutable signed evidence. Lifecycle (v2) owns the renewal cycle — `amendment-run`, five human-driven actions, `planned → awaiting_signed_order | ready → executed` with `abandoned` from any non-terminal and **no clock input on any transition**; Contracts (v7) owns the immutable successor activation and lineage behind the declared `contracts-successor-activation@1` edge. The planning action writes nothing at all, and a `ready` plan authorizes nothing: execution recomputes every fact inside its transaction and still refuses an Order activated underneath it. **No historical row is updated anywhere** — the successor is its own signed Order, hash, term, Contract, Version, Lines, Subscription and obligations, written through the activation path M12 already used, plus one immutable succession row with database-enforced uniqueness. Terms not inside signed document bytes refuse (`SUCCESSOR_TERMS_NOT_SIGNED`); classification is derived from the line delta and falls back to `commercial_change` rather than claim a narrower label; no MRR/ARR/TCV, billing, invoicing, payment, tax, revenue recognition, scheduler, notification, RBAC or cancellation exists. Evidence: a third checked-in scenario over a fourth composition, 40 real-Chromium Admin checks run twice by the author, all three LA0 baselines byte-identical, and exactly two JTBD rows moved to *partially supported* with their partials named. Its independent review confirmed every priority attack held and recorded one **pre-existing** Medium, reproduced against plain activation as a control: a signed term snapshot is consumed without re-verifying its own `termsFingerprint`, so a direct-SQL tamper that leaves the document hash intact propagates as signed. It is inherited from ADR-033, has no public or HTTP write path, stays detectable because M16b records the fingerprint immutably, and is deliberately left for a capability-level verifier on `commercial-quotes` rather than duplicating the hash authority inside Contracts. Then **signed-term integrity** (PR #92, ADR-036): that finding is closed. Commercial owns the authority and exposes a read-only verifier through **`commercial-quotes@2`**, offered beside a byte-identical `@1`; every consumer calls it before terms may be described as signed, `order-term` evidence written, a Contract activated, `contract-lifecycle-source` `signed: true` derived, an M16b successor planned or executed, or authoritative Admin evidence rendered. Proven red-first: **twelve of thirteen tamper cases passed silently** against the previous main and now fail closed with no activation, no successor, no audit, no event, no provider call and no hostile value echoed. Its independent review found the fix one anchor short of its own threat model — linkage compared row to row while the attacker is precisely the party that writes rows, so a consistently rewritten pair, and even an inserted pair for an order whose document signed no term, were accepted — and closed it by anchoring verification to the **canonical signed document bytes**, with both forgeries kept as regressions; the consumption guard, defeated twice in review, now discovers its roots from the filesystem and keys on stored field names. That review also ran the browser matrix independently — **40 of 40 twice**, plus a new check proving a corrupted snapshot refuses server-side with the refusal visible and no retry control — which corrects this branch's earlier claim that no browser binary existed. ADR-036 also records the package-version versus capability-version doctrine (the blanket "additive reads never need a bump" is retired), **linear successor v1**, and that signed provenance is **never backfilled**. Then **Customer Data Foundation v1** (PR #95, ADR-037): the trustworthy data layer beneath a customer view, package-native and **not a CDP**. `packages/customer-data` requires nothing and adds four things beside the existing records rather than copying them — identity, provenance, lineage and projection — through the ADR-030 subject envelope: six managed records, three ADR-032 operations, three human-only actions, `customer-identity@1` (four reads, no way to *decide* identity) and a fingerprinted `deterministic-customer-match@1`. **Canonical identity is a logical link**: the decision deletes nothing, rewrites nothing and cascades nowhere, and the scenario fingerprints both business rows as bytes before and after to prove it. A preview writes nothing at all; an apply recomputes in one transaction with an idempotency key derived from the payload rather than a clock, and `accepted + rejected + skipped` always equals the row count. Matching is three exact rules with **no tie-break** — ambiguity becomes durable evidence for a person. A profile section whose package is not composed reads `available: false` with a reason and a **null** count, never a zero, and states `completeTimeline: false` about itself. Its independent review found four defects, one **High**: nine call sites asked a display-paged read for 1,000 rows while the page clamps at 500, so past 250 decided pairs the profile reported *no canonical identity decision recorded* for a record a human had linked, and the duplicate guard stopped firing — a record was driven into being canonical of one cluster and alias of another. Three Mediums followed: a stored label served as current truth, an unreachable domain reference reported as zero, and an ADR that documented five context keys while six shipped. Then **Production Spine v1** (PR #98, ADR-038): the runtime stops trusting the caller. `normalizeActor()` used to return `SYSTEM_ACTOR` — the strongest identity in the framework — for `null`, a string or an unknown type, and `actorFromRequest()` invented `{type: 'user', id: 'api-user'}` when the headers were missing; the safest input produced the strongest identity, and no record carried a tenant at all. The decision is Option C, stated as **the framework authenticates nobody and owns everything after that**: a deployment adapter verifies the request and supplies a bounded `IDENTITY_CONTRACT = 1` context in four kinds that never blur (`verified-user`, `system`, `asserted-local`, `anonymous`), carrying a *fingerprint* of the claims and never a token, credential or secret. The framework owns the rest — tenant selection, membership, the authorization decision over eleven bounded permissions in five role bundles, the audit evidence and a fail-closed boundary with 401 → 404 → 403 ordering, `trustedSystemActor(reason)` as the only privileged construction path, and server-controlled keys **stripped** from request payloads rather than overridden, so object spread order stopped being load-bearing. `ACCORDO_MODE` has **no default**: an unset mode is an error, because "I forgot to configure it" and "I meant the permissive one" must not be the same input, and production **fails startup** without a verifier and a tenant strategy. Tenancy is **one tenant per application instance, enforced rather than documented**: `bindTenantStorage()` returns a handle with no `databasePathFor`, so a second tenant is unreachable rather than refused by a check; a `dbPath` beside a spine is refused with `SPINE_DATA_PLANE_PATH_NOT_CONFIGURABLE`; control and data planes are separate files with separate migration lists, so a crossing write raises `no such table`. Row-level tenancy over 86+ tables was **not** attempted — a half-migrated version of it is worse than none, because it *looks* isolated — and nothing in this repository may call this shared-database multi-tenancy. Its review found F-2 first as the subtler lie: the boundary shipped **declared and not delivered**, `createTenantStorage` defined and nothing calling it, and the scenario observed `tenantStrategyIsDatabasePerTenant` while the journey composed two applications by hand. That was closed by enforcement, not by wording. An **Accordo Organization is not a CRM Company** — the tenant is a customer of the software, the Company is a customer inside one tenant's data — and blurring them is how one tenant's customer list leaks into another's authorization model. Membership administration carries two non-negotiables: nobody grants a permission they do not hold, and the last active administrator cannot demote or suspend themselves, so an organization cannot become permanently unadministrable. `requiredApprovalKey` values stay **descriptive labels** rather than enforced permissions, because promoting them would change the meaning of records already written. **`PRODUCTION_SPINE_ABSENT` was narrowed, never deleted**: what the mode, the verifier, the tenant binding and the memberships actually are remain runtime facts a source inspection cannot see. |
| Measured at | `9badad3` — the commit `site/claims.json` `measuredAgainst` names. This row repeats the ledger and measures nothing. |
| Tests | Measured, never typed. `npm run verify` is green on a clean tree at the commit above; **how many** tests that was lives in `site/claims.json` `measuredAgainst` and in no other file (ADR-027). |
| Smoke | `npm run smoke` green |
| Starter | `examples/starters/b2b-lead-qualification/install.mjs` green from an empty project |
| Browser smoke | Real-Chromium checks remain manual and are **not in CI** — no workflow launches a browser, and `npm run smoke` is an in-process application smoke (`docs/ADMIN_SMOKE.md`). The Work v1 section has a **30-check** block, all passing, driven twice at `184e543`; it covers that section only and re-runs none of the earlier blocks. PR #58's desktop and mobile receipts still describe `ef8487a`, and nothing since has re-run them. |
| CI | The latest completed integration run concluded `success` on both jobs, `verify` and `public-claims`, at its own exact head. This row records that a run passed; it does not claim any particular commit is still the head. GitHub Actions holds the current answer. |
| Open PRs | **PR #99 — the OSS / managed-Cloud repository boundary — is open and deliberately unmerged**, awaiting a human decision. It is a design, five new documents under `docs/editions/` and nothing else: no file moved, none deleted, no private repository created, no licence changed. Merged this wave, in order: PR #95 (Customer Data Foundation v1, `2d74503`), PR #98 (**Production Spine v1**, `e30216c`) and the truth pass that carries this row. **Production Spine v1 is merged, and the sentence this row used to carry — "there is still no authentication, tenancy or role enforcement" — is retired**: tenancy and authorization now exist and are enforced. What does not exist is authentication. The framework authenticates nobody and ships no verifier, so "a human decided" still means an actor object said so — an actor now bounded by a fail-closed contract, a membership and a permission, and trustworthy exactly as far as the adapter a deployment supplies. |
| Public discovery | GitHub About and all 20 intent topics are live. Smithery `khaoss85/accordo` returns 200 and exposes the three production Docs MCP tools. The GitHub social preview is live and **stale**: it was rendered from a much older measurement and its replacement still needs a manual Settings upload, which is a human step no branch can take. |
| npm | **`create-accordo@0.1.0` is live since 2026-08-19** — staged from CI through OIDC trusted publishing (run 32224731197, Sigstore provenance), approved by the maintainer with 2FA, and confirmed against the registry: the published shasum matches the CI assembly, `latest` resolves to `0.1.0`, and a clean-directory `npm create accordo` scaffolds a verifying project. `accordo@0.0.1` remains an **empty name reservation by design** (no framework library). The `@accordo` organization exists since 2026-08-19 and its scope is **deliberately empty**: `@accordo/mcp` was investigated and refused, because the project MCP server composes from the generated indexes of the tree it runs in and a published copy would answer about the wrong application (ADR-034). The MCP-registry submission is no longer blocked by it — `server.json` registers the remote documentation endpoint instead. `site/brand.json` records `npm.status: published`. |
| Project bootstrap | **`create-accordo` is real source and its publication is live**: `projectBootstrapContract: 1` creates the project; `packageAssemblyContract: 1` creates the bounded publishable directory while the source manifest stays `private: true` — publication never lowered that wall, because what npm published is the assembly, which strips `private`. The staged path proved itself the hard way: one dispatch died `E401` (a `registry-url` placeholder token preempting OIDC), the next `ENEEDAUTH` (no matching trusted-publisher config), and run `32224731197` staged clean once the publisher allowed `npm stage publish`. Plans: `docs/plans/project-bootstrap-installability.md`, `docs/plans/npm-create-accordo-publication.md`. |

## Completed functional path

```text
Lead capture
→ enrichment · explainable scoring · deterministic routing + assignment      M9
→ qualify / disqualify                                                        M6
→ convert into Company + Contact + Opportunity                                M7
→ Opportunity pipeline with a server-authoritative move-stage action          M8
→ catalog sync: products, versions, offers, price components, tiers           M10
→ composite quote (one-time + recurring; flat/per-unit/volume/graduated)      M10
→ immutable Quote Version + versioned discount policy + human approval        M10
→ signature envelope → verified events → signed-artifact evidence             M11
→ exactly one immutable Order (lines, components, tiers, grouped totals)      M11
→ plan activation, classify every component explicitly, resolve ambiguity     M12
→ Commercial Contract + immutable version + lines, Subscription + lines,      M12
  pending delivery and service obligations                                    M12
→ plan the delivery handover, decide who delivers what                        M13
→ Delivery Project + work packages + milestones + optional partner,           M13
  with the obligations marked handed over                                     M13
→ run the project: start, block with a stated reason, resume, complete;       M14a
  close it only over completed work packages and milestones                   M14a
→ record what it consumed: time and expense evidence, a versioned cost plan,  M14b1
  a reproducible contribution estimate grouped by currency                    M14b1
→ govern what changed: a change request decided once, an immutable plan       M14b2
  revision, or a commercial candidate that raises and stops                   M14b2
→ record what it produced and what a human says a customer accepted, over a   M14b2
  frozen, fingerprinted scope — evidence, never a billing trigger             M14b2
```

Every step above is merged.

Framework underneath: module manifest + generated migrations (M1), module
factory (M2), one generated resource contract over API/SDK (M3), generated
Admin (M4), generated-to-generated references (M5), code-first action runtime
(M6), core adapters (M7), pipeline registry (M8), declared-definition
fingerprints + prepare phase (M9), external-operation runtime (M11), optional
domain packages on a generic seam (M12), and a public domain-package contract
with declared capabilities, a validation CLI and a customer-authoring path (M13).

## Merged milestones and their ADRs

| Milestone | Outcome | ADRs |
|---|---|---|
| M0 | Vertical slice: Company/Contact/Opportunity/Approval, renewal workflow, API, Admin, CLI, MCP, trace, audit | ADR-001…005 |
| M1–M2 | Declarative manifest, generated migrations, module factory | ADR-006, ADR-007 |
| M3–M4 | One generated resource contract; generated Admin | ADR-008, ADR-009 |
| M5 | Generated-to-generated references | ADR-010 |
| M6 | Code-first record actions, atomic execution, post-commit events, trace | ADR-011, ADR-012 |
| M7 | Lead conversion through declared core adapters | ADR-013 |
| M8 | Code-first Opportunity pipelines + Admin board | ADR-014 |
| M9 | Lead Intelligence: enrichment, versioned scoring, routing | ADR-015 |
| M10 | Commercial Operations: composite catalog, quotes, discount policy, approval | ADR-016 |
| M11 | Signature + immutable Order, external-operation runtime | ADR-017 (+ addendum) |
| — | Platform alignment gate: core-vs-domain boundary | ADR-018 |
| M12 | Contract & Subscription activation — the first domain package outside core | ADR-018 addenda 1–2 |
| M13 | Delivery handover + the public package contract and custom-package authoring | ADR-018 addenda 3–4 |
| — | Module Evolution v1: revisions, a checked-in state file and append-only migrations | ADR-019 |
| M14a | Delivery execution: eight human-driven transitions, block evidence, a hierarchy gate | ADR-019 addendum 1 |
| AX1 | Deterministic application inspection: `crm app inspect`, source-only and read-only | — |
| M14b1 | Delivery economics: cost policy, append-only time and expense evidence, versioned plan, reproducible contribution estimate | ADR-014, ADR-016 |
| AX2 | Machine-readable Solution Plans: `crm solution inspect\|validate\|check`, bound to an `app inspect` report | ADR-020 |
| M14b2 | Delivery change, deliverables and acceptance | ADR-014, ADR-019 |
| M15 | Service operations: coverage, entitlements, a five-state support case, elapsed-time SLA evidence, escalation | ADR-018 |
| DX4 | Package Conformance Kit: `crm package test`, generic, composed and booted, never special-cased by name | ADR-018 |
| DX3 | Package Scaffold: `crm package scaffold`, a two-file empty-but-conforming package, dry-run by default | ADR-018 |
| DX1 | Project Doctor: `crm project doctor`, deterministic source diagnostics in ~155 ms, every finding naming an existing authority | ADR-018, ADR-019, ADR-020 |
| LA0 | Legacy Characterization Harness: a domain's externally observable behaviour frozen, replayed and required to be identical — the extraction gate | — |
| M16a | Renewal & expansion operations: the fourth domain package, the second to consume another through a declared capability. It records intent and hands off — it renews, cancels, signs, prices, invoices and schedules nothing | ADR-028 |
| DX5 | Project Verify: `crm project verify --json`, the authorities that already decide, orchestrated behind a blocking doctor preflight, with conformance executed for every composed package and dirty-mutation detection that never cleans | — |
| DX6 | Scenario Evidence: `crm scenario run <scenario> --json`, `scenarioRunContract: 2`. Two checked-in scenarios over two compositions and two clocks; it promotes no JTBD row and publishes the counted list of rows a run did **not** establish | ADR-029 |

## Next planned development

1. The default product task remains the first unchecked item in `TASKS.md`:
   first-class Activity and Task modules with a reusable automatic follow-up
   workflow. No GTM branch silently changes that product order.
2. Before any remote CRM write surface, add tenant and role boundaries; the
   authenticated Streamable HTTP project MCP and PostgreSQL adapter remain
   separate platform work. The production Docs MCP is read-only framework
   documentation and does not satisfy any of those production gates.
3. The GTM stack and production promotion are complete. The active distribution
   task is to configure the `create-accordo` trusted publisher on npm for
   `khaoss85/agent-crm`, `stage-create-accordo.yml`, environment `npm-stage` and
   stage-only permission; then rerun, inspect and approve with human 2FA.
   Registry and marketplace claims remain blocked until a real receipt exists.

Two parallel tracks run alongside and are not gated by domain progress: the
**platform track** (domain package boundary, PostgreSQL,
authentication, Jobs & durable outbox, Integration Runtime, Data Governance,
Design-to-CRM, Cloud), the **Marketing & Growth track** (MK0–MK7 — design only;
`MARKETING_GROWTH_OPERATIONS.md`) and the cross-cutting **Agent Experience
track** (AX0–AX5 — AX0 is a strategy and a Skill, AX1 and AX2 are merged (AX2
is a machine-readable plan *contract* — not a planner and not a runtime) and
AX3–AX5 are not implemented; `OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md`). Sequencing and dependencies are in
`EXECUTION_ROADMAP.md`.

## Known platform limitations (not blockers, but not forgotten)

| Limitation | Consequence today | Tracked |
|---|---|---|
| The generated Admin renders **every** action a module declares and does not filter by the record's current state | a delivery record offers buttons its state cannot take; the server refuses them with a `409` naming the allowed moves, and the schema already publishes per-action `from`/`to` metadata a client can filter on | `TASKS.md` → Future platform items |
| JTBD and quality-gate evidence live in Markdown | **partly closed.** `crm scenario run <scenario> --json` (DX6) maps real business journeys onto the JTBD index and publishes both what each run established and the counted list of rows it did **not**. **Two** scenarios and two journeys now ship over two different compositions — a sales funnel on the wall clock and a service SLA/escalation story on an injected, stepped clock — which is what turned the contract from one fitted to a single consumer into one with two (`scenarioRunContract: 2`). Still open: coverage is *claimed* rather than discovered, quality-gate status is still prose, and nothing promotes a row — a person does, on merged tests | `docs/SCENARIO_EVIDENCE.md`, `docs/plans/dx6-second-scenario.md`, `TASKS.md` |
| Source-only view of module evolution | the checked-in revision and migration list are knowable; what a particular database applied is not | `TASKS.md` |

## Production blockers

Everything below must land before the framework is safe for multi-user or
public use. None of it is started.

| Blocker | Consequence today |
|---|---|
| No authentication | the HTTP server is local-development-only; actor headers are not identity |
| No tenancy | no data boundary between customers |
| No RBAC | approval keys are labels; only actor *type* is enforced |
| No PostgreSQL adapter | SQLite only |
| No durable outbox | post-commit event delivery dies with the process |
| No scheduler | no renewal triggers, SLA timers, reminders or unattended follow-up |
| No secret management | no real provider credential can be handled safely |
| Browser E2E outside CI | UI regressions are caught manually |
| No real provider adapters | every provider is an offline fixture |

## Implemented versus documentation-only

**Implemented (merged):** module manifest and factory; module evolution and
adoption; generated API/SDK/Admin; references; actions; core adapters;
pipelines; Lead Intelligence, Commercial Operations and Signature & Order —
all three now **package-native** (`packages/{intelligence,commercial,signature}`),
so every former legacy domain composes optionally and detaches without deleting
rows; Contract activation and subscriptions (contracts package **version 5**,
carrying its declared `signature/signature-orders@1` requirement); the public domain-package contract, the
delivery handover and delivery execution; deterministic application inspection
(AX1); delivery economics (M14b1); delivery change, deliverables and acceptance
evidence (M14b2); machine-readable Solution Plans (AX2); **Service operations
(M15)**; **renewal & expansion operations (M16a) — recorded intent and a
hand-off, nothing that renews, cancels, signs, prices or schedules**; the coding-agent
DX rungs **DX1, DX3, DX4, DX5, DX6, DX10 and LA0**; the project bootstrap
(`create-accordo`, source only — nothing is published); MCP server; CLI.

**Documentation only (no code):** billing, invoicing, revenue recognition and
everything else downstream of activation; renewal *execution* and amendment
(M16b — M16a records the intent and stops; the Signature extraction leaves it
architecturally **unblocked** — Commercial and Signature are reachable through
declared capabilities — and still entirely unimplemented); Analytics Studio; Integration Runtime;
Jobs & durable outbox; Data Governance; Design-to-CRM; Accordo Cloud; a
published **framework library** on npm (the create package is live; the framework
itself is vendored by it, never installed); PostgreSQL; authentication; Marketing & Growth (MK0–MK7);
the Agent Experience track beyond AX2 — except the AX3 benchmark, which
exists and has run (observation only: no product surface, no published
number, `comparative: false`); DX2 and DX9.

## Keeping this file honest

- Update it in the milestone merge PR, not afterwards.
- Every number must come from a clean-clone run, not from memory.
- If a fact is stale, delete it rather than guess.
- **The `Measured at` row is checked, not trusted.** `npm run gtm:check` fails
  when its SHA is not the one in `site/claims.json` `measuredAgainst`, and fails
  again if any document under `docs/` types a test count instead of citing the
  ledger. That is the whole of the automation: two literal comparisons, no
  natural-language inference and no new command
  (`scripts/measurement.js`, `tests/repository-truth.test.js`).
- **Future automation (not built, and deliberately not written in this PR):** a
  `npm run status` command could regenerate the snapshot table from `git
  rev-parse`, the test reporter's summary and the GitHub API, and CI could fail
  a milestone PR whose status block does not match. That is a small tool with
  real value — it is listed here so it is not forgotten, and it is out of scope
  for a documentation-only gate.
