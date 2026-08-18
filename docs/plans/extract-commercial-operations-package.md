# ExecPlan — extract Commercial Operations into a domain package

**Goal.** Convert the second legacy domain — catalog, server-priced quotes,
immutable quote versions and versioned discount approval (ADR-016) — into a
package-native optional domain, preserving every LA0-Commercial `contractual`
and `compatibility_required` behaviour. The acceptance criterion is not "the
tests still pass": it is that the Commercial characterization baseline proves
the decisions are identical **and** `crm package test` proves the result is a
package. Neither substitutes for the other.

**Authority.** ADR-018 (domain package seam and the core budget rule), ADR-021
(declared capability, never an ambient field — decided for Intelligence, applied
here as precedent), ADR-022 (extracted definition kinds reuse the provider and
versioned-policy contracts; persisted identity outranks a remapping),
`docs/architecture/EXTRACTION_PREPARATION.md`,
`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`, and the merged Lead Intelligence
extraction (`docs/plans/extract-lead-intelligence-package.md`,
`docs/evidence/lead-intelligence-extraction.md`) as the worked pattern.

**What is different about Commercial.** Three things Intelligence did not have:

1. **It carries money.** Every stored amount is evidence; a "cleaner" extraction
   that changes one persisted cent has failed. The characterization freezes
   amounts as *values*, never as pass/fail summaries.
2. **It owns a kernel HTTP route and an app method.** `POST /api/catalog/sync`
   and `app.syncCatalog` have no package-native home: **no package can
   contribute an HTTP route or an application operation today.** That seam gap
   is a *recorded finding* (§B7 below), not something this extraction invents a
   solution for.
3. **It is the most depended-upon legacy domain.** Signature builds the
   immutable Order from an approved Quote Version; Contracts activates that
   Order; future M16b amendment execution and Delivery commercial-followup sit
   downstream. The extraction therefore ships a declared read capability for
   quote/version evidence (§B4).

---

## Two approaches rejected

**A cosmetic file move.** Create `packages/commercial/src/`, move the four
kernel files, keep `app.commercial`, the ambient action-context key, the fixed
AX1 slot and the project-owned `packages/commercial/generated/` registry. It
would pass the characterization trivially and close nothing: the domain would
still be reachable without declaring it, still occupy a fixed inspection slot,
and still not be removable. Every `needs_extraction` row would stay open.

**A big-bang rewrite including the route seam.** One PR that extracts the
domain *and* designs a generic package-contributed HTTP-route/app-operation
seam. The seam needs two real consumers designed together (Commercial and
Signature), a metadata contract, an AX1 representation and its own ADR — and a
seam designed inside an extraction PR is a seam nobody reviewed. The
repository's own rule (`INTELLIGENCE_PACKAGE_TARGET.md`) says to design it
"when one of those is extracted, with two real cases in hand" — this extraction
*produces* one of the two cases as evidence and deliberately does not build the
seam.

**Chosen: staged extraction on the Intelligence pattern, with the catalog-sync
attachment left as an explicit, minimized, recorded kernel residue.** Each stage
is independently verifiable; the baseline is frozen before anything moves.

---

## Stage 0 — LA0-Commercial: freeze behaviour before anything moves

`tests/characterization/commercial-*` + `scripts/characterize-commercial.mjs`
(+ `npm run characterize:commercial`), on the shipped
`legacyCharacterizationContract: 1` (`characterization-contract.mjs` is reused,
not forked). Values, not verdicts: every observation records what the system
*returned*, and only `contractual` / `compatibility_required` observations are
compared.

Coverage (each item is observations with exact values):

- **catalog sync** — first sync counts and created records; idempotent re-sync
  (zero writes, zero new audits/events); provider provenance and fingerprints on
  product versions, offers and components; the v2 variant creating new immutable
  offer revisions while old rows stay byte-identical; `deactivateMissing`
  honoured only when declared; sync-run evidence rows; trace (`catalog.sync`)
  for success and failure.
- **provider failure** — `PROVIDER_FAILED` (fixture `fail`), `PROVIDER_TIMEOUT`
  (fixture `slow` under a bounded `catalogTimeoutMs`), `PROVIDER_INVALID`
  (fixture `invalid`, `bad-tiers`, and hostile payloads), each with **no partial
  catalog state** (record counts before/after) and an honest failed trace.
- **pricing** — flat_fee / per_unit / volume / graduated, one-time and
  recurring, at tier boundaries (20/21/100/101), with discount rounding
  (`trunc`, never up) pinned as a value table through the public seam; overflow
  refusal; grouped totals (one one-time + one per currency/interval/count;
  unlike periods never summed).
- **quote lifecycle** — create-quote, add/update/remove-line, submit, approve,
  reject, revise over HTTP/SDK; every `fromStates` refusal; `STALE_REVISION`,
  `EMPTY_QUOTE`, `OFFER_NOT_QUOTE_ELIGIBLE`, `OFFER_INACTIVE`,
  `CURRENCY_MISMATCH`, `PRICE_BOOK_MISMATCH`, `PRICE_BOOK_INACTIVE`,
  `ALREADY_DECIDED`; the human boundary (`403 HUMAN_APPROVAL_REQUIRED` for an
  agent actor).
- **immutable versions** — a submitted Quote Version's rows (version, lines,
  components, totals) byte-identical after later catalog movement; a draft line
  re-pricing from its pinned revision; version numbers DB-monotonic.
- **discount policy** — auto_approve / approval_required / reject with policy
  name, version and fingerprint stored on the version; v1 and v2 carrying
  distinct fingerprints; the decision context values the policy saw.
- **schema** — the `commercial` block read through a harness-owned locator
  (contents are contract; *location* is `pre_extraction_evidence`, exactly the
  Stage-0 lesson the Intelligence extraction learned the hard way): money and
  discount contract strings, chargeTypes, pricingModels, quantitySemantics,
  provider and policy identities with fingerprints.
- **API/SDK surface** — module metadata for the fourteen records (capabilities
  `get`/`list` only, POST/PATCH fail closed 404), advertised actions with
  declared inputs and fromStates (sorted sets asserted; order recorded as
  incidental), Admin-read data (the same schema block and rows
  `admin-quotes.js` renders; browser rendering itself stays with
  `tests/admin-quotes.test.js` and is a declared limitation).
- **audit / events / trace** — exact counts by action, event vocabulary,
  trace-run vocabulary and order.
- **storage and restart** — reopen the same database: identical rows, identical
  totals; a fresh submit after restart reproduces the same amounts.
- **>500 exact values** — the contract test that counts individually asserted
  leaf values must exceed 500; plus a >500-row scale case (a 520-product
  catalog) proving exact `listWhere`/`countWhere` reads beyond every page bound.
- **concurrency** — two connections: concurrent submit produces exactly one
  version; concurrent approve produces exactly one decision (`ALREADY_DECIDED`);
  concurrent sync serializes without a raw SQLite error.
- **hostile input** — `__proto__`/`constructor`/`prototype` keys, markup,
  template syntax, control characters, oversized strings, out-of-range integers
  across quote-action inputs and provider payloads.
- **AX1 / AX2** — the `app inspect` report shape for Commercial (today: fixed
  slot + providers; recorded as `pre_extraction_evidence`) and the shipped plan
  binding.
- **architecture evidence** (`pre_extraction_evidence`, recorded and never
  asserted) — files reading `app.commercial`, files importing
  `commercial-*.js`/`catalog-sync.js` internals, dependants of the fixed
  `packages/commercial/generated` slot, `app.syncCatalog` and the kernel route
  ownership, and the schema block's current location.

The baseline is committed **before any source moves**. No extraction work until
it is green twice (generation, then verification against itself).

## Stage 1 — the package exists and owns its code

`packages/commercial/src/` receives, moved with function bodies unchanged:

| From (kernel) | To (package) |
|---|---|
| `packages/core/src/commercial-registry.js` | `packages/commercial/src/registry.js` |
| `packages/core/src/commercial-actions.js` | `packages/commercial/src/actions.js` |
| `packages/core/src/commercial-money.js` (pricing arithmetic) | `packages/commercial/src/money.js` |
| `packages/core/src/catalog-sync.js` | `packages/commercial/src/catalog-sync.js` |

`packages/commercial/src/index.js` exports `createCommercialDomain({
catalogProviders, discountPolicies, config })` → `definePackage` with the
fourteen `resources`, the eight quote actions (closing over the package's own
registries instead of the ambient context key), the `commercial-quotes@1`
capability (§B4), `metadata()` (the same block, published as the package's
contribution), and `policies: []` with the package persisting its own
`definition_versions` rows under the type strings shipped databases already
carry (`catalog-provider`, `discount-policy`) — the same recorded ADR-022
deviation the Intelligence extraction made, for the same reason: re-typing rows
would silently retire the drift check on every existing database.

**The money split (ADR-018 core budget rule, applied not violated).**
`packages/core/index.js` publicly exports eight money names from
`commercial-money.js` (`requireAmount`, `requireQuantity`, `requireBps`,
`CHARGE_TYPES`, `PRICING_MODELS`, `RECURRING_INTERVALS`, `MAX_INTERVAL_COUNT`,
`MAX_QUANTITY`) as the ADR-014 contract for every package. Those eight are
domain-neutral value bounds; the pricing *semantics* (tier validation,
component amounts, discount application, grouped totals) are Commercial. So the
neutral eight (plus `MAX_DISCOUNT_BPS`, which `requireBps` is defined by) move
to a neutral `packages/core/src/money.js` — function bodies and error strings
byte-identical, the public re-export unchanged in name and behaviour — and
everything else in `commercial-money.js` moves into the package, which imports
the neutral bounds from public core. This is the `definition-fingerprint.js` /
`timeout.js` precedent, executed inside the extraction because unlike
Intelligence's helpers these were already public API.

**Two additive public-core exports, justified under the same rule that added
`withTimeout` and `nowIso` for Intelligence:** `writeTrace` and
`normalizeError`. Catalog sync is a provider-backed operation that runs outside
the action runtime and persists the same trace shape every run surface reads;
`packages/core/src/*` is private, so a package cannot reach `writeTrace` where
it lives, and a package that re-implements the trace row drifts from the
evidence beside it. Signature's `ingest`/`reconcile` operations are the second
consumer of exactly this pair, measured in
`packages/core/src/signature-operations.js` today. Recorded in the Legacy
Alignment Matrix as the Compatibility Backfill Rule requires.

Nothing composes the package yet; the kernel still works as before.

## Stage 2 — records become package-owned

The fourteen record manifests move from
`examples/starters/b2b-lead-qualification/` to
`packages/commercial/modules/`, **byte-identical**: `product`,
`product-version`, `price-book`, `offer`, `price-component`, `price-tier`,
`catalog-sync-run`, `quote`, `quote-line`, `quote-version`,
`quote-version-line`, `quote-version-component`, `quote-version-total`,
`quote-approval`. Identity is the manifest: unchanged manifests are unchanged
tables, migrations, checksums and module state. The installer, the journey and
the test helpers apply them from the new home. No table, record type or column
is renamed.

The signature manifests (`signature-*`, `signed-artifact`, `order*`) are the
Signature domain's and are **not touched** here.

## Stage 3 — composition replaces the fixed slot

`packages/domains/generated/index.js` composes
`createCommercialDomain({ catalogProviders: […], discountPolicies: […] })`.
The project-owned `packages/commercial/generated/index.js` slot is deleted,
`create-app` stops importing it, and AX1's hard-coded `commercial` row and
provider-collection lines are removed — the package is discovered the way
Contracts, Delivery, Service and Intelligence are. The three shipped Solution
Plans are repinned to the new inspection fingerprint (the same mechanical
repin the Intelligence extraction performed).

## Stage 4 — the ambient key goes; the schema block moves; the Admin follows

- The `commercial` action-context key is removed from
  `packages/core/src/action-runtime.js` (its only reader was `quote.submit`,
  which now closes over the package's registries — measured, not assumed).
- `app.commercial` is deleted; `/api/schema` stops publishing the ambient
  `commercial` block and the package's `metadata()` publishes the same contents
  under `domains.commercial`. The characterization reads the block through the
  harness locator, so contents stay asserted while location moves.
- `apps/admin/public/admin-quotes.js` — the one Admin consumer of the block
  (measured: two reads) — resolves it through the same
  `schema.commercial ?? schema.domains?.commercial` fallback, proven equivalent
  by its existing suite (`tests/admin-quotes.test.js`). No Admin ownership,
  layout or gating changes beyond following the block.

## Stage 5 — catalog sync: package-owned code, recorded kernel attachment (B7)

`createCatalogSync` moves into the package, and the composed package instance
exposes it (`pkg.createCatalogSyncOperation(runtime)` beside the
`persistFingerprints(database)` hook the seam already tolerates for extracted
packages). `packages/app/src/create-app.js` keeps **one** domain-named residue:
it looks up the composed package by name and, only when present, wires
`app.syncCatalog` — so `POST /api/catalog/sync` behaves byte-identically when
Commercial is composed and answers the route guard's honest
`404 Operation "catalog sync"` when it is not. The route itself stays in
`apps/server/src/http-server.js`, where it lives today.

This residue is deliberate and bounded: **it is the measured seam pressure, not
a seam.** A duck-typed generic hook ("any package may contribute app
operations") would be a new generic contract with one reviewed consumer,
designed inside an extraction PR — exactly what the DX Simplicity Gate and the
two-real-consumers rule refuse. The full B7 evidence is below.

## Stage 6 — absence, detach, reattach

Without the package composed: the app boots; core CRM, Intelligence, Contracts,
Delivery and Service are untouched; the fourteen record modules are whatever
the project still applies (removing the composition entry removes actions,
capability, schema block and `syncCatalog` — never rows); quote actions answer
404; `POST /api/catalog/sync` answers 404; no `commercial` schema block exists
anywhere. Rows written before detach stay on disk; reattaching restores surface
and data, and a pre-detach quote re-reads byte-identically. Proven in
`tests/commercial-package-absence.test.js`, each phase in its own process.

## Stage 7 — evidence (B8)

LA0-Commercial: identical asserted observations before and after (the pre-move
baseline replayed against the post-move tree through the harness's own
comparison — the file diff at the extraction commit may touch only source
digests, `attachment`, and `pre_extraction_evidence` entries) · the Lead
Intelligence baseline regenerated for the create-app/action-runtime/http-server
digests with **zero** asserted observations moved · `crm package test
packages/commercial` green · `npm run verify`, `npm run smoke`,
`npm run gtm:check`, `app inspect --json`, `project doctor --json`,
`project verify --json` · an existing pre-move database boots and answers
identically post-move · detach/reattach · two-connection races · fault
injection · >500 exact reads · provider hostile/timeout/retry.

---

## B4 — the capability, sized by its real consumers

Consumers that exist or are scheduled: **Signature/Order** (reads the quote and
its approved current version's immutable evidence — version, lines, components,
totals — to build the signature document package and the Order), **M16b
amendment execution** (future: reads the same evidence to base an amendment on),
**Delivery commercial-followup** (future: cites the same evidence). All three
are *reads over immutable evidence*. No consumer needs a mutation: quote
mutation authority stays with the quote actions and their human boundary, so
there is no second write path to separate — one read capability, not a
capability per method and not a package-as-tool.

`commercial-quotes@1` (frozen only after the integrator delivers the Signature
agent's import inventory; the shape below is the working draft):

```js
{
  name: 'commercial-quotes', version: 1,
  create({ modules, consumer }) => ({
    capabilityContract: 1,
    quote(quoteId),                      // bounded quote summary (status, currency, links)
    version(versionId),                  // one immutable Quote Version row
    versionEvidence(versionId),          // { version, lines, components, totals } — exact indexed reads
    policies(),                          // declared discount-policy identities + fingerprints
  })
}
```

Reads run against the caller's `modules` view inside the caller's transaction —
the pattern `contracts/delivery-obligations@1` established. The capability
grants no registration, no storage handle, no catalog write and no way to
evaluate a policy.

## B7 — the HTTP-route / app-operation seam, recorded not built

For each Commercial-owned surface:

**`POST /api/catalog/sync`**
- *Owned today by:* `apps/server/src/http-server.js` (route) →
  `app.syncCatalog` (`packages/app/src/create-app.js`) →
  `createCatalogSync` (domain source; after this PR, package source).
- *Why generated actions/resources are insufficient:* the operation is not
  record-scoped — its identity is a *provider*, not a CRM record id, so the
  generic `POST /api/modules/:module/records/:id/actions/:action` shape cannot
  carry it without inventing a fake anchor record. It also writes across seven
  record modules in one reconciliation transaction after a provider call that
  must run outside any transaction — the action runtime's external-operation
  phases (intent/external/finalize) could host that *call* shape, but not the
  record-less identity.
- *Could a declared action solve it?* Only by minting a synthetic singleton
  record ("catalog") for the sync to target — a schema change and an API
  change, both out of bounds for a behaviour-preserving extraction.
- *Does the package need a custom endpoint?* It needs its **existing** endpoint:
  the route already exists, is documented, and is called by the starter, the
  Admin flow's operators and tests. Package-native ownership would need routes
  to be package-contributable.
- *What a generic seam would need:* a declared, versioned
  `operations`/`routes` contribution on `packageContract` — per entry: method,
  path template, body/raw-body policy and bounds, actor semantics, the runtime
  handles injected (`database`, `events`, `modules`, bounded `config`), a
  refusal shape for absence, AX1/`/api/schema` representation, and DX4
  composition checks (path collisions, reserved prefixes). It now has its
  **two real cases measured**: this operation and Signature's
  `POST /api/signature/providers/:provider/events` +
  `POST /api/signature/envelopes/:id/reconcile` (raw-body, system-actor,
  64 KiB-bounded — the harder of the two). Designing it belongs to its own ADR
  with both extractions' evidence in hand.

**`app.syncCatalog` (in-process operation)** — same analysis; the residue in
`create-app` (Stage 5) is the interim attachment, one named lookup, honestly
commented, removed the day the seam exists.

**Admin quote screens (`apps/admin/public/admin-quotes.js`)**
- *Owned today by:* core Admin, unconditionally routed; gated at render time on
  the presence of the schema block.
- *Why that is already almost right:* the screens render entirely from schema
  metadata and generic module/action routes; the only ownership defect was the
  hard-coded block location, fixed by the Stage-4 locator. Package-scoped Admin
  *sections* (a package contributing its own screen) remain the open
  `partial` in the matrix; nothing new is needed for this extraction beyond
  following the block.

## What this plan will not do

Build the route/app-operation seam or any generic "operations" hook · rename a
table, record type, module or field · change any pricing semantic, rounding
rule, policy decision or approval rule · widen or narrow the HTTP/SDK surface ·
add a scheduler, billing, taxes or FX · touch `tests/characterization/signature-*`
or any Signature-owned file beyond none · run `measure-suite --apply` · merge
the PR.

## The dual gate, stated once

| Gate | Answers | Cannot answer |
|---|---|---|
| LA0-Commercial | does it still **decide and price** identically? | is the result a well-formed package? |
| DX4 `crm package test` | does it **conform** to the package contract? | does it still decide correctly? |

An extraction that passes one and not the other has failed.
