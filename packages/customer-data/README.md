# `customer-data` — governed customer identity, import provenance and data quality

Six records, three human actions, three application operations and one declared
capability. It **requires nothing**.

| | |
|---|---|
| Owns | `customer-import-run`, `customer-import-row`, `external-identity`, `duplicate-candidate`, `canonical-link`, `data-quality-issue` |
| Requires | **nothing** |
| Offers | `customer-identity@1` |
| Actions | `duplicate-candidate.link-canonical-identity`, `duplicate-candidate.dismiss-duplicate-candidate`, `data-quality-issue.govern-data-quality-issue` |
| Operations | `preview-customer-import`, `apply-customer-import`, `read-customer-profile` (ADR-032) |
| Policies | `deterministic-customer-match@1` |
| ADR | ADR-037 · ExecPlan `docs/plans/customer-data-foundation-v1.md` |

## What it is

The trustworthy data layer beneath a customer view. It brings bounded external
rows in and keeps their provenance, finds **deterministic** duplicates or leaves
them unresolved, lets a human govern canonical identity, surfaces explainable
data-quality findings, and reads one consolidated profile across whatever
packages the application composes.

**The governing choice: existing business records stay the source records.**
There is no master customer table here. Company and Contact remain the host
application's; every other record stays with the package that owns it; and this
package adds four things *beside* them — identity, provenance, lineage and
projection — pointing at records through the ADR-030 subject envelope rather
than copying or foreign-keying them.

**Canonical identity is a logical link.** Linking two records records a
decision. It deletes nothing, rewrites nothing and cascades nowhere: both
records still exist, both still resolve, and both still read a profile.

## What it is not

Stated here, in `metadata().notModeled`, and asserted as absent by the tests:

> **not a CDP** · no customer data platform · no warehouse or lakehouse · no
> real-time streaming or activation · no probabilistic identity graph · no
> machine-learning entity resolution · no fuzzy or phonetic matching · no
> arbitrary ETL · no global full-text search · no saved views · no bulk actions
> · no export at scale · **no physical merge or consolidation** · no consent
> orchestration · **no GDPR, retention or erasure claim** · no scheduler · no
> RBAC.

The word *CDP* does not appear on any surface this package renders, and it is
not a description of this package anywhere.

## Enable it

```bash
for m in customer-import-run customer-import-row external-identity \
         duplicate-candidate canonical-link data-quality-issue; do
  npm run crm -- module create packages/customer-data/modules/$m.module.json --apply
done
```

```js
// packages/domains/generated/index.js
import { createCustomerDataPackage } from '../../customer-data/src/index.js';

export const generatedDomains = [
  createCustomerDataPackage(),
];
```

Removing that line removes the actions, the operations, the capability, the
schema block and the Admin section. **It leaves every row**: the framework never
drops your tables.

## Import: a preview writes nothing, an apply recomputes

```text
preview  →  receipts, and NOT ONE WRITE — not a business record, not a run
apply    →  one transaction: the run, one receipt row per input row, the records
```

- **Bounded.** At most 500 rows, at most 300 characters per field, under a
  fingerprinted mapping (`customer-rows@1`). An import is a bounded ask, not a
  pipe.
- **Receipts reconcile.** `accepted + rejected + skipped` always equals the row
  count, and every row has a receipt naming its outcome and reason code. The
  operation throws `IMPORT_RECEIPTS_UNRECONCILED` rather than report a total
  that does not add up.
- **The idempotency key is derived from the payload** — the source system, the
  mapping fingerprint and the sorted row digests. Never a clock, never a random
  value: the same import retried is the same run, not a second one.
- **No raw provider payload is stored.** A field the mapping does not know is
  read by nothing and kept nowhere.
- **`acceptance`** is `partial` (keep the good rows, receipt the rest) or
  `all_or_nothing` (one bad row stops everything).

## Matching: exact, ordered, and it refuses to guess

`deterministic-customer-match@1`, three rules in a fixed precedence:

```text
1  external-identity      this system already named this record
2  contact-email          exact, on core's normalized email
3  company-name-domain    exact normalized name AND exact domain
```

Nothing scores, guesses or learns, and **no rule breaks a tie**. When the
evidence is ambiguous the row is `skipped` with every candidate reported, and
each pair becomes a `duplicate-candidate` carrying its rule, its evidence and
the policy fingerprint — durable evidence for a person, never a decision.

Changing a rule changes the fingerprint on every receipt and candidate it
produced, so an old decision keeps naming the rules that actually made it.

## Canonical identity: a human decision, and a logical link

```text
duplicate-candidate  unresolved  →  linked      link-canonical-identity
                     unresolved  →  dismissed   dismiss-duplicate-candidate
```

Both require `actor.type === "user"` and a reason. Linking writes two
`canonical-link` rows — one `canonical`, one `alias`, under one cluster key —
each carrying who decided and why.

- **Nothing is deleted or rewritten.** The scenario fingerprints both business
  rows as bytes before and after and proves they are identical.
- **A decision is not silently overwritten.** A decided candidate cannot be
  decided again (`INVALID_STATE`), and a record already inside a cluster cannot
  be re-parented by deciding a different candidate that contains it
  (`ALREADY_IN_CANONICAL_CLUSTER`, 409).
- **Physical merge does not exist** and is deliberately deferred to Customer
  Data Operations v2. An operator who wants two rows to become one row does not
  get that here.

## The profile: a projection, where absence is part of the contract

`read-customer-profile` reads one customer across the packages this application
composes. It creates nothing.

A section whose owning package is **not composed** reads:

```json
{ "available": false, "count": null, "items": null,
  "reason": "the commercial package is not composed in this application, so quotes are not available — this is not a claim that there are none" }
```

Never a zero. A zero would be a claim that there are none, which an application
that cannot see the package is not entitled to make.

The same holds for a package that **is** composed but whose record declares no
company, contact or opportunity reference this projection can follow: it reads
`available: false` naming that as the reason, rather than a `0` it has not
earned. And every readable section publishes `countIsComplete` — `true` when
the count came from the complete exact-match query, `false` when the owning
module offers only a bounded display page, in which case the count is a floor
and the section says so.

And it says so about itself: `completeTimeline: false`. This is a projection
over Accordo-managed records, **not** a cross-channel customer timeline. No
email, call, meeting, marketing or communications event appears on it, because
none exist in this framework.

## `customer-identity@1`

```js
requires: [{ package: 'customer-data', capability: 'customer-identity', version: 1 }],
```

Four reads: `canonicalIdentity`, `externalIdentities`, `resolveExternalIdentity`
and `openDuplicateCandidates`. A consumer asks who a record *is* without
importing this package's source, and gets no way to decide identity — deciding
is a human action on a record, and a capability that could decide would be a
back door around that.

## The human-actor boundary, stated exactly

Every decision here requires `actor.type === "user"`. That is an **audit**
boundary — this framework ships no authentication, so it is not Sales,
Legal or Finance role enforcement, and this README does not pretend otherwise.

## Evidence

- `tests/customer-data-foundation.test.js` — the v1 claims against a real composed application
- `tests/customer-data-faults.test.js` — faults, two-connection races, restart, detach and old-database upgrade
- `tests/admin-customer-data.test.js` — the Admin section, including the failure states
- `examples/scenarios/customer-identity-governance.scenario.json` — the DX6 journey and what it does *not* establish
- `docs/ADMIN_SMOKE.md` — the 32-check real-Chromium matrix
