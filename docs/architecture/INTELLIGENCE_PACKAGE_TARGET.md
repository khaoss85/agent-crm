# The target shape of an extracted Lead Intelligence

**Status: proposed target, nothing implemented.** This document draws the
topology ADR-021 and ADR-022 describe, so the two decisions can be read against
a picture instead of against each other. It authorizes no extraction and no
migration step. `docs/architecture/EXTRACTION_PREPARATION.md` holds the analysis
and the measurements; this holds the shape they imply and the questions still
open.

Every claim about today's runtime here is measured by LA0
(`tests/characterization/`) or read from source, and named where it is.

---

## Today

```text
packages/core/src/intelligence-registry.js    validators + IntelligenceRegistries
packages/core/src/intelligence-actions.js     enrich, record-signal, score, route
packages/app/src/create-app.js                constructs the registries,
                                              publishes app.intelligence
packages/core/src/action-runtime.js           injects the registries into every
                                              action's context, ambiently
apps/server/src/http-server.js                publishes the `intelligence` block
                                              on /api/schema
packages/intelligence/generated/index.js      project-owned definition slot,
                                              read by AX1 as a fixed slot
```

Four things reach the outside world: the four actions on `lead`, the records
they write, the `/api/schema` block, and `app inspect`'s `intelligence` slot.
There is **no `/api/intelligence/*` route** — verified against
`apps/server/src/http-server.js`, whose only domain-specific routes are
Commercial's `/api/catalog/sync` and Signature's two envelope routes.

## The target

```text
packages/intelligence/
  src/                  the registries, the four actions, the validators
  modules/              enrichment-snapshot, behavioral-signal, score-run,
                        score-contribution, routing-run, route-evaluation,
                        assignment
  index.js              definePackage: capabilities, policies, providers,
                        resources, metadata()

  offers  intelligence@1                  ADR-021
  uses    policies       for scoring models and routing policies    ADR-022
          providers      for enrichment providers                   ADR-022
          ?              for routing targets                        OPEN
  needs   no HTTP route contribution                                below
```

A consumer that wants scoring declares `intelligence@1` in `requires` and opens
it with `domains.capability(...)`, exactly as Delivery opens Contract
Activation's `delivery-obligations@1` today. `crm app inspect` reports the edge;
`crm solution check` can bind a plan to it; `crm package test` refuses a
composition where the requirement does not resolve.

## What is settled, and by which evidence

| Question | Answer | Evidence |
|---|---|---|
| How do consumers reach it? | declared capability `intelligence@1` | ADR-021; `architecture.app-intelligence-consumers` — one non-Intelligence reader, zero external context-key readers |
| How many actions must change? | four, and all four move into the package | same observation |
| Do enrichment providers need a new contract? | no — providers | ADR-022 |
| Do scoring models and routing policies? | no — versioned fingerprinted `policies`, the shape Commercial already ships | ADR-022; ADR-015; ADR-016 |
| Does it need to contribute an HTTP route? | **no** | below |
| Does a generic definition-registry seam have to exist first? | no — two runtime dependants, three of four kinds already expressible | ADR-022; `architecture.definition-registry-slot` |
| Are the neutral helpers still in the way? | no — moved to `definition-fingerprint.js` and `timeout.js` | `EXTRACTION_PREPARATION.md` Blocker 1 |

## The HTTP route seam: not a precondition here

A package cannot contribute an HTTP route today. For Lead Intelligence that
turns out not to matter, and the reason is worth stating precisely rather than
assumed:

- **Its actions are already generic.** `enrich`, `record-signal`, `score` and
  `route` are reached through `/api/modules/lead/records/:id/actions/:action`,
  which is the framework's route for any action on any module. A package that
  contributes actions contributes its HTTP surface with them.
- **Its records are already generic.** Every Intelligence record module is
  `writable: "managed"`, served read-only through the generic module routes.
- **Its schema block is a schema contribution, not a route.** `/api/schema`
  publishing `intelligence` is the thing ADR-021 step 3 changes; it is a
  different mechanism from a route.
- **DX4 confirmed the general case.** Package conformance does not require route
  contribution, so a package that never contributes one is not a lesser package.

It remains a precondition for **Commercial Operations** and **Signature &
Order** specifically, each of which owns a hand-written route in `apps/server`
that would have to go somewhere. That is a reason to design the seam when one of
those is extracted, with two real cases in hand — not now, and not for this
domain.

## What is still open

**Routing targets have no home.** Three of the four definition kinds map onto
contracts that exist. Routing targets carry no version, no fingerprint and no
handler: they are a declared list of who can receive work, with capacity,
priority, countries, languages and skills. They look like project configuration.
ADR-022 declines to invent a definition kind for them and says so; the honest
outcome may be that they stay project configuration, which is a smaller decision
than the seam that would otherwise be built to hold them. It is unresolved
either way.

**AX1's fixed `intelligence` slot.** `packages/cli/src/app-inspect.js` treats
`intelligence` as one of a fixed set of composition slots. Whatever replaces the
project-owned registry file has to answer what AX1 reports instead. This follows
from the decisions above rather than driving them, and nothing in ADR-021 or
ADR-022 changes AX1.

**The two contract decisions themselves.** ADR-021 and ADR-022 are marked
**proposed**. Both are contract decisions, and both belong to a human. This
document exists so that the decision is taken deliberately rather than settled
by whoever writes the extraction PR — which is exactly how an ambient field
became a four-milestone dependency in the first place.

## What this document is not

It is not a plan, not an ExecPlan and not a schedule. It does not claim
Intelligence is ready to move: LA0 proves behaviour can be *checked* across a
move, not that the move is safe to make. The extraction gate in
`EXTRACTION_PREPARATION.md` is the authority on readiness, and two of its rows
are still `no`.
