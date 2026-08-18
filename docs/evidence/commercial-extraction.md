# Evidence — the Commercial Operations extraction

The second legacy domain to leave `packages/core`, on the pattern the Lead
Intelligence extraction established. This document records what was proved and
how, so the claim "zero behaviour change" traces to machine-checked evidence
rather than to a diff review.

## The dual gate

| Gate | Result |
|---|---|
| LA0-Commercial (`npm run characterize:commercial`) | the baseline was frozen at the pre-move tree (107 observations; 91 `contractual` + 7 `compatibility_required`, >2,400 individually asserted values), then the **pre-move** baseline was replayed against the **post-move** tree through the harness's own comparison: zero asserted observations changed, zero missing, zero added, zero reclassified, and the asserted-values fingerprint (`82c1f02fa354…`) is byte-identical on both sides of the move |
| DX4 (`crm package test packages/commercial --json`) | `ok: true` — 24 checks passed, 0 failed, 4 not applicable |

Neither gate substitutes for the other: LA0 says the domain still prices and
decides identically; DX4 says the result is a well-formed package.

## What moved, and what deliberately did not

- `commercial-registry.js` → `packages/commercial/src/registry.js`,
  `commercial-actions.js` → `src/actions.js`, `catalog-sync.js` →
  `src/catalog-sync.js` — function bodies unchanged; `quote.submit` now closes
  over the package's own registries instead of the ambient context key.
- `commercial-money.js` split: the eight public money names
  (`requireAmount`, `requireQuantity`, `requireBps`, `CHARGE_TYPES`,
  `PRICING_MODELS`, `RECURRING_INTERVALS`, `MAX_INTERVAL_COUNT`,
  `MAX_QUANTITY`) stayed public kernel API, now served from the neutral
  `packages/core/src/money.js` with bodies and refusal strings byte-identical;
  every pricing *semantic* (tier schedules, component amounts, trunc-only
  discounts, grouped totals) moved to `packages/commercial/src/money.js`. The
  `helpers.money-bounds`, `pricing.*` observation families pin the split.
- The fourteen record manifests moved **byte-identical** from the starter to
  `packages/commercial/modules/` (same digests in the baseline `source` map):
  same tables, same migrations, same checksums, no data migration, no rename.
- The fixed slot `packages/commercial/generated/index.js` and AX1's hard-coded
  `commercial` composition row are gone; projects compose
  `createCommercialDomain({ catalogProviders, discountPolicies })` in
  `packages/domains/generated/index.js` and AX1 discovers the package.
- `app.commercial` and the ambient `commercial` action-context key are deleted
  with no fallback. `/api/schema` publishes the same block contents as the
  package's contribution under `domains.commercial`; the one Admin consumer
  (`admin-quotes.js`) resolves the block through a two-location fallback,
  proven by its existing suite.
- **Deliberately unmoved:** `external-operation.js` (assessed neutral kernel
  helper by the Signature characterization — imported by the action runtime
  for any `externalOperation: 1` action, zero domain vocabulary) and the
  catalog-sync **attachment** (below).

## The B7 residue, measured not hidden

`POST /api/catalog/sync` stays in `apps/server`; `app.syncCatalog` is wired in
`create-app` by one named lookup of the composed package, calling the
package-owned `createCatalogSyncOperation`. No package can contribute an HTTP
route or an application operation today; the full seam evidence — including
the four-property comparison with Signature's webhook and the
operations-seam-vs-route-seam verdict — is
`docs/plans/extract-commercial-operations-package.md` §B7. Without the package
composed, `app.syncCatalog` is absent and the route answers `404`.

## Capabilities

- `commercial-quotes@1` — read-only quote/version evidence (rows as stored;
  four documented semantic guarantees: signable-version lifecycle facts,
  snapshot immutability, snapshot completeness, verbatim policy fingerprints).
  Sized by the Signature agent's measured consumption inventory; future
  consumers: M16b amendment execution, Delivery commercial-followup.
- `commercial-quote-binding@1` — the declared, documented edge for the one
  bounded write (Signature stamping `signatureEnvelopeId`, `signatureStatus`,
  `orderId`): a versioned field-allowlist declaration, deliberately not a
  second write mechanism — the write stays the quote record's managed path.

In this PR the capabilities are offered and conformance-tested; the kernel
Signature code keeps its current module-registry access unchanged. The
Signature extraction is the branch that declares them.

## Absence, detach, reattach

`tests/commercial-package-absence.test.js`, each phase in its own process:
composed (catalog syncs, a quote prices, submits, auto-approves) → absent (app
boots, core CRM works, quote actions and `create-quote` answer 404,
`app.syncCatalog` gone, no schema contribution, **every row still on disk and
readable**) → reattached (historical quote and version evidence byte-for-byte,
an idempotent re-sync writes nothing, the schema contribution returns). A
second test pins the kernel clean: no Commercial file in `packages/core`, no
ambient context key, no fixed AX1 slot, and the `create-app` residue reaches
only the package-exposed operation with no static import.

## Existing databases

A database created and populated by the **pre-move** build (catalog synced,
quote submitted and auto-approved) boots under the **post-move** build with
every persisted provider and policy fingerprint re-verified by the startup
drift check, answers the same rows, and re-prices the same quote identically.
The package persists its `definition_versions` rows under the type strings
shipped databases already carry (`catalog-provider`, `discount-policy`) — the
recorded ADR-022 deviation, same as Intelligence's, because re-typing rows
would silently retire the immutability drift check in every existing database.

## The Lead Intelligence baseline across this change

Regenerated because three of its behaviour-bearing files changed
(`create-app.js`, `action-runtime.js`, `http-server.js`): **zero observations
moved** — the diff is exactly three source digests. Source staleness and
behaviour change stayed distinct signals, which is what LA0 promises.
