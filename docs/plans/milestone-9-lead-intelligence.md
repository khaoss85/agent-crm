# Milestone 9 — Lead Intelligence v1: enrichment, explainable scoring, deterministic routing

Target brief:

> "When a Lead arrives, enrich company data, combine firmographic and behavioral signals, calculate an explainable score, then assign the Lead using score, country, language, product interest and available sales capacity."

```text
Landing/source creates Lead
→ external-style enrichment (provider call OUTSIDE the transaction)
→ immutable enrichment snapshot with provenance
→ behavioral signals (append-only, deduplicated)
→ explainable score (versioned model, per-rule contributions)
→ versioned routing policy (deterministic, capacity-aware, fallback)
→ deterministic assignment with history
→ complete audit, events and trace
```

Strategy context: `docs/strategy/REVENUE_OPERATIONS.md` §1 (design), `EXECUTION_ROADMAP.md` M9. This milestone implements the local, single-user slice only — no real external providers, no authenticated users, no RBAC.

## Approaches compared

1. **Hardcode enrichment/scoring/routing inside Lead actions.** Fastest, but the logic becomes starter-only spaghetti: no versioning, no reproducibility ("which rules produced this score?" answered by `git blame`), nothing reusable for the next brief, and the routing/scoring policy would drift per project with incompatible shapes — exactly what the workstream strategy forbids.
2. **A generic universal policy/rules DSL.** A declarative rules engine interpreting JSON conditions would make policies "editable" but unreviewable, weakly typed, and effectively a low-code runtime — explicitly against the framework philosophy (ADR-006/011 precedent: no interpreter over a config format). Premature generalization before two consumers exist is the same trap ADR-014 avoided.
3. **Bounded code-first registries and contracts (chosen).** Enrichment providers, scoring models, routing policies and routing targets are plain checked-in definitions validated fail-closed at startup (the ADR-011/014 registry pattern), with **runtime version identity persisted in the database**: every published `{type, name, version}` gets a deterministic fingerprint recorded in a new `definition_versions` core table, every run records the exact name/version/fingerprint it used, and a changed definition under an already-registered version fails startup loudly. Rules are ordinary functions the developer owns; the framework supplies validation, identity, persistence, explainability structure and the action envelope.

Chosen: **3**. Git history alone is not runtime policy versioning — the fingerprint registration plus per-run identity gives reproducibility that survives rollbacks (which are modelled as *new* versions derived from earlier definitions, never edits).

## Storage model — all-managed generated modules

Six record types + signals are starter-owned generated modules whose **every field is `writable: "managed"`**, which the factory now generates as **read-only public modules** (revised in the adversarial review):

- capabilities are `['get', 'list']` — no public `create` or `update` exists at all (HTTP POST/PATCH fail closed with 404 capability gating; the Admin shows no Create/Edit; not even an empty row can be created by a client);
- the only write paths are the generated in-process `createManaged` (one audit + one event per record) and `applyManaged`, reachable only from trusted action code.

Modules (starter manifests, applied through the real CLI/factory like lead/task):

| Module | Purpose | Key fields |
|---|---|---|
| `enrichment-snapshot` | one immutable enrichment result | leadId, provider, providerVersion, sourceKey (unique), status complete/partial, normalized firmographics (companyDomain, companyName, country, employeeRange, industry, revenueRange, language), confidence, sourceRef, retrievedAt, expiresAt |
| `behavioral-signal` | one immutable observed signal | leadId, signalType, source, observedAt, value, sourceKey (unique) |
| `score-run` | one scoring execution | leadId, model, modelVersion, fingerprint, snapshotId, signalCount, signalsFingerprint, totalScore, evaluatedAt, status |
| `score-contribution` | one rule's contribution in a run | runId, ruleKey, label, matched, contribution, reason |
| `routing-run` | one routing execution | leadId, policy, policyVersion, fingerprint, scoreRunId, snapshotId, evaluatedTargets, eligibleTargets, selectedTarget, matchedRule, fallbackReason, routedAt, status |
| `assignment` | one assignment history entry | leadId, targetId, source (automatic), routingRunId, previousAssignmentId, effectiveAt, reason |

Lead links are managed strings (ADR-013 precedent — action-level linkage guarantee, no FK claim): `enrichmentSnapshotId`, `enrichedAt`, `score` (converted from public to managed — nothing in the repo wrote it publicly), `scoreRunId`, `scoredAt`, `assignedTargetId`, `assignedAt`, `routingRunId`. All updated atomically with their run records inside the action transaction.

Correctness reads (latest snapshot, sequence numbers, signal sets, target load) use the generated services' exact `listWhere`/`countWhere` queries over manifest-indexed columns — complete at any row count (revised in the adversarial review; the paged `list()` is never used for a correctness decision).

## Framework pieces

1. **`packages/core/src/intelligence-registry.js`** — validators + `IntelligenceRegistries` (Map-backed, per-app, fail-closed): enrichment providers (name, positive integer version, capabilities ⊆ {company}, real handler), scoring models (canonical rule keys, bounded labels, integer weights, evaluate functions, optional min/max bounds, unique keys), routing policies (route function), routing targets (canonical key, kind user/team/queue/fallback, ≤1 fallback, countries `[A-Z]{2}`, languages `[a-z]{2}`, skills, capacity ≥ 0 or null, integer priority, optional score band). `computeDefinitionFingerprint` canonicalizes the definition (sorted object keys, functions via `toString()`) and SHA-256s it — deterministic from source. `metadata()` returns function-free, sorted, serializable metadata for `/api/schema`.
2. **Core migration v4** — `definition_versions(type, name, version, fingerprint, registered_at, UNIQUE(type, name, version))`. At startup the registries insert-or-verify each scoring model and routing policy: same identity + same fingerprint is a no-op, **same identity + different fingerprint throws** (the persisted-usage guard; runs additionally store their fingerprint, so history stays self-describing even across databases).
3. **Action runtime `prepare` phase** — an action definition may declare `prepare(ctx)`, which runs **before** the event buffer and the write transaction, with a read-oriented ctx (`record` pre-read, `input`, `actor`, `config`, `now`, `intelligence`, `modules`, `step`) and no `managed`. Its return value reaches `execute` as `ctx.prepared`. This is where the enrichment provider is called, so **no DB write transaction is ever held open across an external-style call**. A `prepare` failure fails the action with an honest trace and never opens the transaction. Additive to `actionContract: 1` (absent `prepare` = today's behavior).
4. **`packages/core/src/intelligence-actions.js`** — `buildEnrichAction`, `buildScoreAction`, `buildRouteAction`, `buildRecordSignalAction` (framework-provided, starter-registered, module-parameterized like `buildMoveStageAction`), plus the documented deterministic target ranking helper (priority desc → load asc → key asc) policies compose.
5. **`packages/intelligence/generated/index.js`** — empty checked-in registry (providers/models/policies/targets); the starter writes it in projects, mirroring actions/pipelines.
6. **`create-app` + schema** — registries built per app from the generated index, fingerprints persisted at startup, `app.intelligence` exposed, `intelligence` passed to the action runtime, `/api/schema` gains an additive `intelligence` metadata block.

## Action semantics

**`lead.enrich`** (input: provider, refresh?) —
`prepare`: resolve provider (Map lookup, canonical name), reuse check (latest non-expired snapshot for lead+provider → skip the call), else call `enrichCompany({lead fields}, {now})` under a bounded timeout, validate/normalize the result (bounded strings, integer confidence 0–100, canonical country/language shapes; anything else → provider-invalid failure).
`execute` (in transaction): re-read lead, re-check reuse (a concurrent enrich wins; the prepared provider result is then discarded — recorded honestly as a step), else compute `sourceKey = enrich:<leadId>:<provider>@<version>:<seq>` (seq = existing snapshots for that lead+provider + 1; the UNIQUE column makes cross-connection duplicates impossible), create + fill the immutable snapshot, update the Lead's links. Provider failure/timeout/invalid data → failed action, honest trace, **no records** (failed snapshots deliberately not persisted — a documented choice, revisit when a real brief needs failure inventory). Expired snapshot → new snapshot version; historical snapshots never overwritten.

**`lead.record-signal`** (input: signalType, source?, observedAt, value?, sourceKey?) — creates one immutable signal; the default sourceKey `signal:<leadId>:<type>:<observedAt>` (or the caller's explicit key) dedupes repeats via the UNIQUE column → stable 409, no duplicate contribution.

**`lead.score`** (input: model, version) — in one transaction: look up the model version (explicit version, no implicit latest), gather inputs (linked snapshot if unexpired else null; all signals for the lead, deduped by construction, sorted `observedAt, id`), evaluate every rule in declared order (a throwing rule fails the action — models must be total), clamp to declared bounds, persist ScoreRun + one ScoreContribution per rule (matched flag, contribution, bounded reason), update the Lead's score/scoreRunId/scoredAt atomically. Re-scoring is allowed and creates a new run (safe retry, deterministic result for identical inputs); old runs remain readable forever.

**`lead.route`** (input: policy, version) — in one transaction: refuse if already assigned (**chosen semantics: repeated routing is a stable `409 ALREADY_ASSIGNED`; explicit reroute is deferred**), require a score (`409 LEAD_NOT_SCORED`), build the target set with **current load = count of leads currently assigned to each target** (computed in-transaction from the lead module — the documented capacity source), let the policy pick among eligible targets, validate the choice, fall back to the declared fallback target with a recorded reason when nothing is eligible (`409 NO_ELIGIBLE_TARGET` when no fallback exists), persist RoutingRun + Assignment (previousAssignmentId null in v1) and update the Lead atomically. Ties broken by the documented deterministic ranking — never randomness.

Concurrency inherits M6–M8 posture: same-app writers serialize on `BEGIN IMMEDIATE` (the loser re-reads and hits ALREADY_ASSIGNED/reuse), cross-connection losers get the retryable `409 CONFLICT` or the snapshot UNIQUE conflict — never raw SQLITE_BUSY; exactly one final assignment.

## RBAC boundary (honest)

The routing engine assigns **trusted application identifiers** — not authenticated users. No manual-override action ships: real Sales-Manager reassignment authorization needs the Production Spine (authentication, tenancy, roles, service-level authorization). The `assignment` record already carries `source`/`previousAssignmentId`/`reason` so the future override lands as data, but JTBD-LI-06 stays **not supported** and nothing claims otherwise.

## Starter and proof

`intelligence.js` in the B2B starter ships: a deterministic `fixture-firmographics` provider (outputs derived from the lead's email domain/company; magic domains trigger failure/timeout/partial/invalid-data paths), scoring model v1 and v2 (v2 = "rollback-style" republication with an added rule — proving old runs keep old identity), routing policy v1 and v2, and four targets (`enterprise-italy`, `spain-sales`, `growth-queue`, fallback `unrouted-queue`). `install.mjs` drives three leads (IT/enterprise → Enterprise Italy; ES/mid → Spain Sales; unsupported territory → fallback), signals, full enrich→score→route, provider failure, repeat/conflict behavior, and prints the summary.

Tests: `tests/intelligence-contract.test.js` (validation matrix, fingerprint determinism and drift detection, hostile names, prepare-phase contract, metadata safety) and `tests/lead-intelligence-e2e.test.js` (temp-project harness like the M6/M7 suites: full flow over service + HTTP/SDK, CRUD immutability matrix, reuse/expiry/refresh, provider failure/timeout/invalid, scoring reproducibility and contributions, v1/v2 + persisted fingerprint mismatch on reboot, routing eligibility/capacity/fallback/no-target, same-app and cross-connection concurrency, restart persistence, audit/event exactness, hostile inputs end to end).

## Out of scope (deliberate)

Real third-party providers/credentials, ML/LLM scoring, intent prediction, fuzzy matching, real users/teams/calendars, secure manual reassignment, auth/tenancy/RBAC, notifications, CPQ and later workstreams, PostgreSQL, Cloud code, remote MCP, telemetry.

## Fixed in the adversarial review

1. **Prepare-context write access (critical)**: `prepare` received the full module registry, so `applyManaged`/`create` were callable outside any transaction. Fixed: prepare's `modules` is a read-only per-module view (get/list/listWhere/countWhere only), and the prepared value is normalized to plain JSON-safe data and deep-frozen (functions/symbols/non-plain objects/cycles rejected, dangerous keys dropped).
2. **Publicly creatable empty rows (critical)**: all-managed modules still generated public create (empty rows) and a silently no-op update. Fixed: the factory now generates them read-only — capabilities `['get','list']`, no public create/update at all, a trusted in-process `createManaged` (one audit + one event), the Admin shows no Create/Edit, and HTTP POST/PATCH fail closed.
3. **Page-bounded correctness + lifetime load (critical)**: latest-snapshot/sequence/signal/load reads used `list({limit: 500})`, and load counted lifetime assignments. Fixed: generated services gained exact `listWhere`/`countWhere` (declared-field equality/IN, prepared statements) with manifest-declared `index` columns; current load = exact count of ACTIVE (`new`/`qualified`) assigned leads — capacity is released on conversion/disqualification (proven, incl. a two-connection last-slot race with no oversubscription and 520-signal exactness).
4. **Fingerprint honesty (major)**: canonicalization silently swallowed Dates/Maps/getters and crashed on cycles; closure-captured thresholds escaped the fingerprint. Fixed: strict canonicalization (unsupported values fail loudly), the guarantee renamed to *declared-definition fingerprint*, and a declared `config` contract (fingerprinted, frozen into evaluations) as the sanctioned home for thresholds — the starter's models/policies now declare their tunables. Registration also became transactional (concurrent boots serialize; providers get the same persisted protection, and snapshots store the provider fingerprint).
5. **Missing decision evidence (major)**: routing runs recorded no target-set state; score runs didn't evidence mutable lead inputs. Fixed: RoutingRun stores the target-set fingerprint plus one `route-evaluation` record per candidate (in/out, exact reason, load, capacity, priority); ScoreRun stores a fingerprint of the lead fields read. LI-09 stays partial (values fingerprinted, not copied).
6. **Missing lifecycle gating (major)**: intelligence actions ran in any lead state — a converted lead could be routed. Fixed: enrich/score/record-signal `fromStates ['new','qualified']`, route `['new']`, server-enforced.
7. **Timeout hygiene (moderate)**: the losing provider promise could surface an unhandled rejection. Fixed: late settlement is observed and abandoned (no cancellation claim), proven by a late-rejecting fixture.
