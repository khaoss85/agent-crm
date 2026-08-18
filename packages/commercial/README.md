# Commercial Operations — domain package

Catalog, server-priced quotes, immutable quote versions and versioned discount
approval (ADR-016), extracted from `packages/core` under the domain package
seam (ADR-018). The second legacy domain to move, on the pattern the Lead
Intelligence extraction established — and proved the same way: LA0-Commercial
(`npm run characterize:commercial`, `tests/characterization/commercial-*`)
froze every externally observable amount, refusal, fingerprint and evidence row
before the move, and zero asserted observations moved across it.

## What it owns

- **Records** (all read-only publicly, written only through the trusted managed
  path): `product`, `product-version`, `price-book`, `offer`,
  `price-component`, `price-tier`, `catalog-sync-run`, `quote`, `quote-line`,
  `quote-version`, `quote-version-line`, `quote-version-component`,
  `quote-version-total`, `quote-approval`. Manifests in `modules/`,
  byte-identical to the ones the starter used to carry: same tables, same
  migrations, same checksums, no data migration.
- **Actions**: `opportunity.create-quote` (on the host application's
  opportunity record, which this package deliberately does not own) and the
  seven `quote` actions (`add-line`, `update-line`, `remove-line`, `submit`,
  `approve`, `reject`, `revise`). `quote.submit` closes over the package's own
  registries — the ambient `commercial` action-context key is gone.
- **Declared definitions** (ADR-015/ADR-016): catalog providers and versioned
  discount policies, passed by the project to `createCommercialDomain` and
  fingerprint-persisted under the `catalog-provider` / `discount-policy` type
  strings shipped databases already carry (the recorded ADR-022 deviation, same
  as Intelligence's).
- **Pricing arithmetic** (`src/money.js`): tier schedules, component amounts,
  trunc-only discount application, grouped totals that never sum unlike
  periods. The domain-neutral value bounds (`requireAmount`, `requireBps`,
  `requireQuantity` and the charge/pricing vocabulary) remain public kernel API
  (`packages/core/src/money.js`).

## Capabilities

- `commercial-quotes@1` — read-only quote/version evidence for the packages
  downstream of a sale (Signature/Order today; amendment execution and
  delivery commercial-followup when they exist). The rows are the contract.
- `commercial-quote-binding@1` — the declared, documented edge for the one
  bounded write: the signature/order domain stamping `signatureEnvelopeId`,
  `signatureStatus` and `orderId` onto a quote. The capability names the field
  allowlist and the guarantee; the write itself stays the quote record's own
  managed path.

## Composition

```js
// packages/domains/generated/index.js
import { createCommercialDomain } from '../../commercial/src/index.js';
import { fixtureSaasCatalogProvider, standardSalesDiscountV1 } from '.../commercial.js';

export const generatedDomains = [
  createCommercialDomain({
    catalogProviders: [fixtureSaasCatalogProvider],
    discountPolicies: [standardSalesDiscountV1],
  }),
];
```

Removing the entry removes the actions, the capabilities, the schema
contribution and `app.syncCatalog` — and deletes no rows
(`tests/commercial-package-absence.test.js`).

## The one recorded residue

`POST /api/catalog/sync` and `app.syncCatalog` stay kernel-attached: no package
can contribute an HTTP route or an application operation today. The package
owns the code (`createCatalogSyncOperation`); `packages/app/src/create-app.js`
attaches it with a single named lookup, recorded as B7 seam evidence in
`docs/plans/extract-commercial-operations-package.md`.
