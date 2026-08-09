# Lead Intelligence

The oldest domain in this repository, and the first legacy one extracted from
the kernel into a package (ADR-018, ADR-021, ADR-022).

It enriches leads from declared providers, records behavioural signals, scores
them with explainable versioned models, and routes them to declared targets —
every decision carrying the fingerprint of the definition that made it.

## Compose it

```js
// packages/domains/generated/index.js — the only place a project names packages
import { createIntelligenceDomain } from '../../intelligence/src/index.js';

export const generatedDomains = [createIntelligenceDomain({
  enrichmentProviders: [fixtureFirmographicsProvider],
  scoringModels: [b2bSaasScoreV1, b2bSaasScoreV2],
  routingPolicies: [b2bRoutingV1, b2bRoutingV2],
  routingTargets,
})];
```

Delete that entry and the domain is gone: the app boots, the Lead and the rest
of the CRM are untouched, the four actions stop being advertised and answer 404,
and **the rows stay on disk**. Reattaching restores the surface and the data.
That is proved in `tests/intelligence-package-absence.test.js`, with each phase
in its own process.

## What it owns

| | |
|---|---|
| **Resources** | `enrichment-snapshot`, `behavioral-signal`, `score-run`, `score-contribution`, `routing-run`, `route-evaluation`, `assignment` — all `writable: "managed"` |
| **Actions** | `enrich`, `record-signal`, `score`, `route`, on the project's `lead` |
| **Offers** | `intelligence@1` |
| **Requires** | nothing |

**It does not own the Lead.** The Lead is the project's record; Intelligence
acts on it and writes its managed fields through the action runtime. That is a
*host-record dependency*, not a package dependency, and it is why `lead` is
absent from `resources`. A project can have a Lead without Intelligence.

## Definitions

Providers use the provider contract; scoring models and routing policies are
versioned, fingerprinted declared definitions (ADR-015). Routing targets are
**declared configuration** of the routing capability, not a definition kind and
not a managed resource: nothing mutates them at runtime, and `capacity` is a
declared ceiling whose moving half — the current load — is counted from Lead
records at decision time (ADR-022).

## One deliberate deviation

The package persists its own `definition_versions` rows, under the type strings
`enrichment-provider`, `scoring-model` and `routing-policy` that it has used
since M9 — not the package registry's `domain-policy:intelligence:<kind>`.
Re-typing them would write a second set of rows in every shipped database, leave
the originals unmatched and silently retire the drift check that makes a
registered version immutable. Persisted identity outranks a mapping decided
before anyone looked at the rows. See `src/index.js`.

## Evidence

- `npm run characterize:intelligence` — LA0 froze every externally observable
  decision **before** the extraction. Zero asserted observations moved across it.
- `npm run crm -- package test packages/intelligence --json` — DX4 conformance.

Neither substitutes for the other: LA0 cannot tell you the result is a
well-formed package, and DX4 cannot tell you it still decides correctly.
