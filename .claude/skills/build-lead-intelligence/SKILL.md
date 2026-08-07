---
name: build-lead-intelligence
description: Add or extend Lead Intelligence in an Agent CRM project - enrichment providers, versioned explainable scoring models, versioned routing policies and routing targets. Use for enrich/score/route work on leads. Do not use for CRUD module changes (create-crm-module) or approval processes (create-crm-workflow).
requires:
  tier: generated-project
  command: "crm app inspect"
  projectSurface: ["packages/intelligence/generated/index.js"]
  repositorySurface: ["ARCHITECTURE.md", "DECISIONS.md", "docs/LEAD_INTELLIGENCE.md"]
  degradesTo: "the composed providers, policies and actions reported by `crm app inspect --json`"
---

## Orient yourself first

```bash
npm run crm -- app inspect --json
```

Read `valid`, then `problems[]`, then `limitations[]`, in that order. Every problem is fixed or reported before anything is built on top of it, and **every limitation is a hard boundary on what you may claim.** Then read `packages[]`, `capabilities[]`, `resources[]`, `actions[]`, `policies[]` and `providers[]`: that list is what exists. A capability absent from the report does not exist, whatever a record name, a label or a document suggests.

If the repository documents this skill names are absent, you are in a project built from this framework rather than in the framework itself. The inspection report is then the source of truth and those documents are optional background — do not guess at their contents, and do not assume a path exists because this skill names it.

`providers[]` reports declared metadata only. A provider entry never means the provider is configured, credentialed or reachable — `PROVIDER_HEALTH_UNKNOWN` is in `limitations[]` for exactly that reason.

**Background, where they exist:** `ARCHITECTURE.md`, `DECISIONS.md` (ADR-015) and `docs/LEAD_INTELLIGENCE.md`. They are the deeper source for the rules below, not a prerequisite for them — the rules stand on their own.

## Integrate an enrichment provider

1. Define it code-first: `{ name, version, label, capabilities: ['company'], async enrichCompany({ lead }, { now }) }` returning `{ fields: { companyDomain, companyName, country (A-Z2), employeeRange, industry, revenueRange, language (a-z2) }, confidence (0–100 int), sourceRef, expiresAt?, partial? }`. Out-of-contract output is refused (`PROVIDER_INVALID`) — never loosen the normalizer.
2. Register it in `packages/intelligence/generated/index.js` (static import, like actions/pipelines).
3. The provider is called in the action's `prepare` phase — never inside a DB transaction. Do not add DB writes to a provider.
4. Test failure paths with a deterministic fixture (outage → `PROVIDER_FAILED`, hang → `PROVIDER_TIMEOUT`, bad shapes → `PROVIDER_INVALID`): nothing persisted, honest failed trace.
5. Real paid providers need human-approved credentials and are out of scope until then.

## Create a scoring model version

1. `{ name, version, label, minScore?, maxScore?, rules: [{ key, label, weight (non-zero int), evaluate(context) }] }` — `evaluate` gets frozen `{ lead, snapshot, signals, evaluatedAt }`, must be total, deterministic, side-effect-free (no network, no LLM, no DB writes) and return `boolean` or `{ matched, reason }`.
2. **Declare every threshold in `config`.** The fingerprint is a *declared-definition* fingerprint: it captures the definition's source and its declared `config` (frozen into `ctx.config`), NOT values captured by closures or out-of-file helpers. A closure-held threshold changes silently — put it in `config` or as a literal.
3. **Never edit a registered version.** Changing rules or config = a NEW version registered alongside the old (the persisted fingerprint check stops the app on in-place edits). Rollback = publish a new version whose rules come from an earlier one.
4. Test explainability: contributions sum to the total, appear in declared rule order, and the same inputs reproduce the same score. Test the bounds clamp and behavior without snapshot/signals.

## Create a routing policy version

1. `{ name, version, label, route(context) }` — context gives frozen `{ lead, score, snapshot, targets (eligible, with currentLoad), allTargets, rank, routedAt }`; return `{ target, rule }` choosing an ELIGIBLE target, or `null` for the fallback queue. Use `rank()` (priority desc → load asc → key asc) for ties — never randomness.
2. Targets are declared data (`key, kind, active, countries, languages, skills, capacity, priority, scoreMin/Max`); capacity works against the in-transaction count of assigned leads. Same versioning rules as scoring models.
3. Test: deterministic selection, capacity exclusion (full target skipped), fallback with recorded reason, `ALREADY_ASSIGNED` on reroute, `LEAD_NOT_SCORED` before scoring, one final assignment under concurrency.

## Test policy fingerprints

Boot the app twice: same source must boot cleanly; a changed registered version must fail with "source changed after registration". Runs must retain the old version + fingerprint after new versions appear.

## Never claim manual override before RBAC

There is no Sales-Manager reassignment action and none may be added before the Production Spine (auth, tenancy, RBAC). Routing targets are trusted identifiers, not users. Keep the JTBD matrix honest.

Finish with `npm run verify` and the starter (`node examples/starters/b2b-lead-qualification/install.mjs`).
