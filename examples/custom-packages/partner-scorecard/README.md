# `partner-scorecard` — a customer-authored package (conformance example)

This is **not** a first-party domain and not a product workstream. It exists to
prove that an agent — Claude Code or Codex — can add a bounded domain to a
customer's own repository through the public package contract, without
touching the kernel.

It is deliberately the smallest thing that is still honestly a package: one
resource, one action, one versioned policy.

Read [`docs/PACKAGE_AUTHORING.md`](../../../docs/PACKAGE_AUTHORING.md) first.

## What it models

A human records how a delivery partner performed on an engagement: a score
(0–100), a required reason, and a rating band decided by a versioned policy.

A rating is **internal opinion**. It grants nothing, changes nothing
commercially, is never shown to the partner, and never rates anyone
automatically.

## What it proves

| Claim | Where |
|---|---|
| package identity, version and contract version | `src/index.js` |
| a package-owned resource through the ordinary module factory | `modules/partner-scorecard.module.json` |
| a package-owned action on the generic action runtime | `buildRatePartnerAction()` |
| a versioned, fingerprinted policy with declared config | `standardPartnerRatingV1` |
| function-free schema metadata | `metadata()` |
| **public kernel imports only** | the single `packages/core/index.js` import |
| static registration, and removal by deleting one line | `packages/domains/generated/index.js` |
| no kernel change is needed for any of it | `tests/custom-package-e2e.test.js` fingerprints every kernel file before and after |

## Enabling it

```bash
npm run crm -- module create examples/custom-packages/partner-scorecard/modules/partner-scorecard.module.json --apply
npm run crm -- package validate examples/custom-packages/partner-scorecard
```

```js
// packages/domains/generated/index.js
import { createPartnerScorecardPackage } from '../../../examples/custom-packages/partner-scorecard/src/index.js';

export const generatedDomains = [
  /* …first-party packages… */
  createPartnerScorecardPackage(),
];
```

It attaches to `delivery-partner-engagement`, so it needs the delivery package
applied — but it declares no capability requirement, because it only adds an
action to a record another package owns. If it needed that package's *behaviour*
rather than its records, it would declare a capability instead.

Removing the import removes the package. The scorecards it wrote stay in the
database: the framework never drops your tables behind you.
