# The target shape of an extracted Lead Intelligence

**Status: accepted target, nothing implemented.** ADR-021 and ADR-022 are
accepted; this document draws the topology they describe, so the two decisions
can be read against a picture instead of against each other. It authorizes no extraction and no
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
          declared config for routing targets (no mutation path)     ADR-022
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
| Where do routing targets live? | declared configuration of the routing capability — no runtime mutation path exists | ADR-022, from the runtime inventory |
| What replaces AX1's fixed slot? | ordinary package discovery | below |
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

## AX1 and `/api/schema`: what replaces the special cases

Both ADRs are accepted, so the two mechanisms they lean on need a stated target.

### The fixed AX1 slot goes away

`packages/cli/src/app-inspect.js` holds a table of fixed composition slots, one
of which is `intelligence` at the hard-coded path
`packages/intelligence/generated/index.js`. It exists because Intelligence
predates package discovery.

Once Intelligence is a package, nothing about it needs a named slot. AX1 already
discovers packages, their version, `requires`/`provides`, resources, actions,
providers, policies and record revisions — that is how Contract Activation and
Delivery are reported today, with no entry in that table. The extraction removes
the `intelligence` row and the domain appears through ordinary discovery,
including the `intelligence@1` edge from ADR-021.

This is a **consequence** of the two decisions, not a third decision. Nothing in
ADR-021 or ADR-022 changes AX1's contract; what changes is that one domain stops
needing an exception to it.

### `/api/schema` stays consumer-visible, and there is a real gap

Today `/api/schema` publishes three legacy blocks at the top level —
`intelligence`, `commercial`, `signature` — each from an ambient field's
`metadata()`. Packages contribute through a generic path already:
`app.domains.metadata()`, published under a `domains` key.

So a mechanism exists, and it is nested. An extracted package's metadata is
reachable at `domains.intelligence`, not at `intelligence`. That is a change in
shape for anything reading the top-level key.

What LA0 says about this is precise, and it is the reason the migration is
tractable:

| Observation | Classification | Meaning |
|---|---|---|
| `architecture.definition-kinds-published` | **contractual** | the four kinds and their published contents are asserted and must not move |
| `architecture.schema-intelligence-block-present` | `pre_extraction_evidence` | the block's *location* is recorded, not asserted |

The harness already drew the line where it belongs: **what is published is
contract; where its ownership metadata sits is not.** An extraction may move the
block under `domains` and must not change a single published definition.

**The gap, stated rather than papered over:** there is no way for a package to
contribute a **top-level** schema key, only a nested one. For Lead Intelligence
that is acceptable, because LA0 classifies the location as evidence rather than
contract. It would not be acceptable for a package that needed to preserve a
top-level key exactly, and no such package exists. This is therefore recorded as
a **known limitation of the package schema-contribution surface**, not designed
around now: two real consumers, then a seam.

`GENERIC_SCHEMA_CONTRIBUTION_IS_NESTED_ONLY` — a package publishes metadata
under `domains.<name>`; the three top-level legacy blocks are pre-package
special cases and are not a contract a package can join.

## What is still open

**Routing targets: decided.** They were the open question in the proposed
version. The runtime settles it — no runtime mutation path, no table, no module,
no CRUD, and `capacity` is a declared ceiling whose mutable half (`currentLoad`)
is computed from Lead records at decision time. They are static source-defined
configuration, so ADR-022 keeps them as declared configuration of the routing
capability rather than inventing a definition kind or a managed resource.
Operationally mutable targets would be the managed-resource branch; that is a
different capability with its own evidence, not a reinterpretation of this one.

**The nested-only schema contribution**, recorded above as
`GENERIC_SCHEMA_CONTRIBUTION_IS_NESTED_ONLY`. Acceptable for this domain because
LA0 classifies the location as evidence; a limitation of the surface all the
same.

**Whether the migration is scheduled.** Both ADRs are accepted as contracts and
neither is implemented. Accepting the contract is what stops the decision being
settled by whoever writes the extraction PR — which is exactly how an ambient
field became a four-milestone dependency in the first place.

## What this document is not

It is not a plan, not an ExecPlan and not a schedule. It does not claim
Intelligence is ready to move: LA0 proves behaviour can be *checked* across a
move, not that the move is safe to make. The extraction gate in
`EXTRACTION_PREPARATION.md` is the authority on readiness, and two of its rows
are still `no`.
