# `customer-data` — governed customer identity, import provenance and data quality

Ten records, three human actions, nine application operations and four declared
capabilities. It **requires nothing**.

| | |
|---|---|
| Owns | `customer-import-run`, `customer-import-row`, `external-identity`, `duplicate-candidate`, `canonical-link`, `data-quality-issue`, `customer-bulk-run`, `customer-bulk-item`, `enriched-field`, `enrichment-opt-out` |
| Requires | **nothing** |
| Offers | `customer-identity@1`, `customer-profile@1`, `channel-sender@1`, `customer-channel-origins@1` |
| Actions | `duplicate-candidate.link-canonical-identity`, `duplicate-candidate.dismiss-duplicate-candidate`, `data-quality-issue.govern-data-quality-issue` |
| Operations | `preview-customer-import`, `apply-customer-import`, `apply-bulk-customer-action`, `export-customer-records`, `read-customer-profile`, `apply-contact-enrichment`, `import-google-contacts`, `opt-out-contact-enrichment`, `count-customer-channel-origins` (ADR-032) |
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
> arbitrary ETL · no global full-text search · no saved views ·
> **no physical merge or consolidation** · no consent
> orchestration · **no GDPR, retention or erasure claim** · no scheduler · no
> RBAC.

The word *CDP* does not appear on any surface this package renders, and it is
not a description of this package anywhere.

## Enable it

```bash
for m in customer-import-run customer-import-row external-identity \
         duplicate-candidate canonical-link data-quality-issue \
         customer-bulk-run customer-bulk-item enriched-field \
         enrichment-opt-out; do
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

## Channel senders: one handle, one contact, no guessing

`resolve-channel-sender` resolves one channel sender — a WhatsApp number, an
Instagram, Facebook or TikTok id, an email address or a phone number — to its
contact. It reuses the records and the rule above: the handle is looked up as
the `external-identity` `${channel}:${handle}`, anything else resolves through
`deterministic-customer-match@1`, and every resolved handle is recorded as an
`external-identity` against its contact. A second sighting refreshes
`lastObserved`, never a second row.

```text
sender  →  matched      the handle already names a contact, or the evidence matches one
        →  created      unknown sender carrying an email: its contact is created, like an accepted import row
        →  unresolved   ambiguous evidence, or nothing this resolution may create
```

- **Ambiguity becomes a candidate, never a merge.** A handle naming one
  contact with an email naming another, or evidence reaching several records,
  is recorded as an unresolved `duplicate-candidate` for a human. Nothing is
  re-linked, nothing is fused.
- **No email, no contact.** A sender that matches nothing and carries no
  email creates nothing: a contact needs a globally-unique email and this
  resolution invents none. A bare handle with no linkable evidence stays
  `unresolved` for human triage.
- **Senders are people.** Evidence that only reaches a company either creates
  its contact (when it carries an email) or stays unresolved — a sender is
  never matched to a company.

## Enrichment: free sources fill gaps, manual data always wins

`apply-contact-enrichment`, `import-google-contacts` and
`opt-out-contact-enrichment` fill contact gaps from free sources — the
space's Google Contacts (People API) and email signatures parsed locally.
No paid enrichment service is wired, called or referenced anywhere.

```text
enrich  →  stored beside the contact with source and date — the record itself is never written
        →  candidate    evidence naming two different contacts, for a human
        →  refused      opted-out subject, or Google source with its flag off
```

- **Manual wins by construction.** Enrichment has no write path to the
  contact (or company) record, so a manually entered value cannot be
  overwritten — there is nothing that overwrites. Enriched attributes live
  in `enriched-field` rows beside the record, each with its `source` and
  `observedAt`; consumers read the record first and the enriched rows as
  fallback.
- **The Google source is behind its flag.** `import-google-contacts` and the
  `google-contacts` source refuse with
  `ENRICHMENT_GOOGLE_CONTACTS_DISABLED` unless the composition enables
  `enrichmentGoogleContacts` — off until the Google verification approves
  the `contacts.readonly` scope, which must also sit on the space's Google
  grant (control plane, not here). Tests drive the in-memory fake People
  API; the deployment wires the real client through the same adapter seam.
- **One person, one contact.** A Google id already naming one contact with
  an email naming another becomes an unresolved `duplicate-candidate`
  (`contact-enrichment` rule) — never a merge, never a second contact. A
  person with no usable email and no linked identity is skipped, never
  invented.
- **Opt-out is final.** `opt-out-contact-enrichment` records the refusal
  and purges the subject's active enriched fields (status `purged`, value
  cleared). Afterwards no new field is stored for the subject, and no pair
  naming the subject is ever proposed as a union: `recordCandidatePairs`
  skips opted-out contacts on every path (owner decision Q-G1, BO-F1-04).
  Channel identities stay: they route messages, they are not enrichment.

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

## Bulk: one decision across many records, one receipt per record

`apply-bulk-customer-action` applies one of the three human decisions above —
link, dismiss or govern — across up to 500 records in one call.

```text
bulk  →  one transaction per item, one receipt per item, one run row
```

- **Partial reads partial.** Every item gets a receipt naming `applied`,
  `failed` (with the refusal's code) or — on resume — `already-applied`. A
  run that did not apply every item reads `partial`, never `completed`, and
  a partial run is a result, not an error.
- **One refusal stops nothing else.** Each record runs in its own
  transaction with the action runtime's own `fromStates` guard, so a refusal
  on one record neither rolls back nor blocks the rest.
- **Resumable, never silently reapplied.** The idempotency key is derived
  from the action and the sorted item digests. Retrying a finished bulk
  replays the stored run with `replayed: true` and runs nothing twice; an
  interrupted run stays `in_progress` and the retry continues the items with
  no applied receipt.
- **The human boundary holds per item.** Every bulked decision keeps its
  human-only check: a non-user actor gets one `HUMAN_APPROVAL_REQUIRED`
  receipt per item, never one silent refusal for the batch.

## Export: counted first, refused rather than truncated

`export-customer-records` exports one of this package's ten managed record
sets — the import log and its receipts, the identities, the candidates, the
links, the findings, the bulk runs with their receipts, the enriched fields,
and the opt-outs.

```text
export  →  count, then rows — or a refusal, never a short file
```

- **Counted first.** The set is counted with the complete exact-match query
  before anything is returned, and the answer states the row count and the
  bound. Display pages (`list()`, clamped to 500) are never the read behind
  an export.
- **Truncation is a refusal.** A set larger than the bound refuses with
  `EXPORT_WOULD_TRUNCATE` (409) naming the resource, the count and the
  bound. At most 10,000 rows; a smaller bound may be asked, never a larger
  one.
- **Writes nothing.** An export creates no run, no receipt and no audit
  entry. The role boundary lives at the enumerated HTTP route, which gates
  `records.read` before the operation runs.

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

## `channel-sender@1`

```js
// The composed customer-data definition, handed to createChannelsPackage()
createChannelsPackage({ customerData /* … */ }),
```

One write: `resolveSender`. The channels initial history import
(backlog:66282d13d81c) reconciles every imported sender through this path
instead of a second identity store: matched names the contact, an unknown
sender carrying an email creates it, ambiguous evidence stays an unresolved
duplicate-candidate for a human and is never merged. It opens on the
consumer runtime (`{ modules, core, database, events }`) with this
package's own name resolution and match policy — exactly one resolution,
the provider's. The edge is optional: without it the import still stores
conversations and messages and leaves senders pending, never refusing.

## The human-actor boundary, stated exactly

Every decision here requires `actor.type === "user"`. That is an **audit**
boundary — this framework ships no authentication, so it is not Sales,
Legal or Finance role enforcement, and this README does not pretend otherwise.

## Evidence

- `tests/customer-data-foundation.test.js` — the v1 claims against a real composed application
- `tests/customer-data-operations-v2.test.js` — bulk actions and export at scale: per-record receipts, partial honesty, resume and replay, truncation refusal
- `tests/customer-data-faults.test.js` — faults, two-connection races, restart, detach and old-database upgrade
- `tests/contact-enrichment.test.js` — free-source enrichment: flag, source and date on every field, manual-wins, candidates, opt-out purge
- `tests/admin-customer-data.test.js` — the Admin section, including the failure states
- `examples/scenarios/customer-identity-governance.scenario.json` — the DX6 journey and what it does *not* establish
- `docs/ADMIN_SMOKE.md` — the 32-check real-Chromium matrix
