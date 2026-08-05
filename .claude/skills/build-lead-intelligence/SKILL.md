---
name: build-lead-intelligence
description: Add or extend Lead Intelligence in an Agent CRM project - enrichment providers, versioned explainable scoring models, versioned routing policies and routing targets. Use for enrich/score/route work on leads. Do not use for CRUD module changes (create-crm-module) or approval processes (create-crm-workflow).
---

Read `ARCHITECTURE.md`, `DECISIONS.md` (ADR-015) and `docs/LEAD_INTELLIGENCE.md` first.

## Integrate an enrichment provider

1. Define it code-first: `{ name, version, label, capabilities: ['company'], async enrichCompany({ lead }, { now }) }` returning `{ fields: { companyDomain, companyName, country (A-Z2), employeeRange, industry, revenueRange, language (a-z2) }, confidence (0–100 int), sourceRef, expiresAt?, partial? }`. Out-of-contract output is refused (`PROVIDER_INVALID`) — never loosen the normalizer.
2. Register it in `packages/intelligence/generated/index.js` (static import, like actions/pipelines).
3. The provider is called in the action's `prepare` phase — never inside a DB transaction. Do not add DB writes to a provider.
4. Test failure paths with a deterministic fixture (outage → `PROVIDER_FAILED`, hang → `PROVIDER_TIMEOUT`, bad shapes → `PROVIDER_INVALID`): nothing persisted, honest failed trace.
5. Real paid providers need human-approved credentials and are out of scope until then.

## Create a scoring model version

1. `{ name, version, label, minScore?, maxScore?, rules: [{ key, label, weight (non-zero int), evaluate(context) }] }` — `evaluate` gets frozen `{ lead, snapshot, signals, evaluatedAt }`, must be total, deterministic, side-effect-free (no network, no LLM, no DB writes) and return `boolean` or `{ matched, reason }`.
2. **Never edit a registered version.** Changing rules = a NEW version registered alongside the old (the persisted fingerprint check stops the app on in-place edits). Rollback = publish a new version whose rules come from an earlier one.
3. Test explainability: contributions sum to the total, appear in declared rule order, and the same inputs reproduce the same score. Test the bounds clamp and behavior without snapshot/signals.

## Create a routing policy version

1. `{ name, version, label, route(context) }` — context gives frozen `{ lead, score, snapshot, targets (eligible, with currentLoad), allTargets, rank, routedAt }`; return `{ target, rule }` choosing an ELIGIBLE target, or `null` for the fallback queue. Use `rank()` (priority desc → load asc → key asc) for ties — never randomness.
2. Targets are declared data (`key, kind, active, countries, languages, skills, capacity, priority, scoreMin/Max`); capacity works against the in-transaction count of assigned leads. Same versioning rules as scoring models.
3. Test: deterministic selection, capacity exclusion (full target skipped), fallback with recorded reason, `ALREADY_ASSIGNED` on reroute, `LEAD_NOT_SCORED` before scoring, one final assignment under concurrency.

## Test policy fingerprints

Boot the app twice: same source must boot cleanly; a changed registered version must fail with "source changed after registration". Runs must retain the old version + fingerprint after new versions appear.

## Never claim manual override before RBAC

There is no Sales-Manager reassignment action and none may be added before the Production Spine (auth, tenancy, RBAC). Routing targets are trusted identifiers, not users. Keep the JTBD matrix honest.

Finish with `npm run verify` and the starter (`node examples/starters/b2b-lead-qualification/install.mjs`).
