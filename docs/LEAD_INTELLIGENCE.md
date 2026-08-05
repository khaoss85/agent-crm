# Lead Intelligence (Milestone 9, ADR-015)

Enrichment, explainable scoring and deterministic routing over the Lead
starter — local development slice; no real external providers, no
authenticated users, no RBAC (see the boundary section).

## The flow

```text
capture (lead create)
→ record-signal        appends an immutable behavioral signal (deduped by sourceKey)
→ enrich               provider call OUTSIDE the transaction → immutable snapshot + provenance
→ score                versioned explainable model → ScoreRun + per-rule contributions
→ route                versioned deterministic policy → RoutingRun + Assignment history
→ inspect              snapshot / contributions / runs / assignment / audit / trace
```

```js
const leads = client.module('lead');
await leads.action(leadId, 'record-signal', { signalType: 'demo-requested', observedAt: '2026-08-01T11:00:00Z' });
await leads.action(leadId, 'enrich', { provider: 'fixture-firmographics' });
await leads.action(leadId, 'score',  { model: 'b2b-saas-score', version: 1 });
await leads.action(leadId, 'route',  { policy: 'b2b-sales-routing', version: 1 });
```

Every decision is deterministic, explainable, versioned, audited, traced and
reproducible from source. Inspect via the generic surfaces: the Lead's managed
link fields (read-only in the Admin), the `enrichment-snapshot` /
`behavioral-signal` / `score-run` / `score-contribution` / `routing-run` /
`assignment` modules (immutable through public CRUD — every field managed),
`/api/traces?workflowName=lead.enrich|lead.score|lead.route`, and the audit log.

## Definitions are code, versions are runtime state

Providers, scoring models, routing policies and targets are checked-in
definitions registered through `packages/intelligence/generated/index.js`
(empty in-repo; the starter writes it — see
`examples/starters/b2b-lead-qualification/intelligence.js`). Scoring models and
routing policies are **versioned**: each `{name, version}` persists a
deterministic source fingerprint in `definition_versions` at startup, runs
record the exact version + fingerprint they executed under, and editing a
registered version's source stops the app. **Rollback = publish a new version
derived from an earlier definition** (e.g. v3 with v1's rules), never an edit.
Git history alone is not runtime policy versioning.

## Semantics worth knowing

- **Enrich** reuses a non-expired snapshot for the same lead+provider (no
  provider call); an expired one is refreshed as a NEW snapshot version
  (`enrich:<leadId>:<provider>@<version>:<seq>`, DB-unique). Provider
  outage/timeout/out-of-contract data → stable `PROVIDER_FAILED` /
  `PROVIDER_TIMEOUT` / `PROVIDER_INVALID`, nothing persisted, honest failed
  trace. The provider call runs in the action's `prepare` phase — never inside
  the write transaction.
- **Score** evaluates every rule in declared order against frozen inputs
  (expired snapshots are ignored), persists one contribution per rule, clamps
  to declared bounds, and updates the Lead's `score`/`scoreRunId` atomically
  with the run. Re-scoring makes a new run; old runs stay readable forever.
- **Route** refuses an already-assigned lead (`409 ALREADY_ASSIGNED` — reroute
  is deferred) and an unscored one (`409 LEAD_NOT_SCORED`). Eligibility =
  active + score band + capacity, where current load is the in-transaction
  count of leads assigned to each target. Ties break priority desc → load asc
  → key asc — never randomness. No eligible target → the single declared
  fallback queue with a recorded reason, else `409 NO_ELIGIBLE_TARGET`.
  Exactly one final assignment under concurrency, across connections.

## The authorization boundary (honest)

Routing targets are **trusted application identifiers**, not authenticated
users. The automatic engine may assign them; **no manual-override action
exists**, because real Sales-Manager reassignment authorization requires the
Production Spine (authentication, tenancy, RBAC enforced in services —
`docs/strategy/EXECUTION_ROADMAP.md` Phase 6). The `assignment` record already
carries `source`, `previousAssignmentId` and `reason` so a future override
lands as data. Do not claim manager-permission JTBDs before the Spine exists.

## Evidence

`tests/intelligence-contract.test.js`, `tests/lead-intelligence-e2e.test.js`,
`examples/starters/b2b-lead-qualification/install.mjs` (three leads → Enterprise
Italy / Spain Sales / fallback), `docs/plans/milestone-9-lead-intelligence.md`.
Agent instructions: `.claude/skills/build-lead-intelligence/SKILL.md` (this file
is the Codex-readable mirror of that skill's content).
