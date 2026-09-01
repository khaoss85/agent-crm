# Legacy alignment matrix

**Status: assessment and policy. No domain is refactored by the PR that
introduced this document, and none should be until the sequencing below allows
it.**

Two domains — Contract Activation and Delivery — were built *after* the domain
package seam (ADR-018) and use it. Three older ones — Lead Intelligence,
Commercial Operations, and Signature & Order — were built before it and lived in
`packages/core/src/`. That was a fact, not a defect: they were built when the
seam did not exist, and each one is what taught us what the seam had to be.

**Lead Intelligence has since been extracted** and is now a package like any
other. It is the proof that a legacy domain can move without changing what it
decides: LA0 froze its externally observable behaviour first, and zero asserted
observations moved across the extraction. **Commercial Operations has now
followed** on the same pattern: LA0-Commercial
(`tests/characterization/commercial-*`) froze catalog, pricing, quote, version
and approval behaviour as values before the move, and zero asserted
observations moved. Signature & Order followed on the ADR-032 operations
seam with the same acceptance discipline — and that seam retired the recorded
Commercial exception: `app.syncCatalog`, `app.ingestSignatureEvent` and
`app.reconcileSignature` are now package-declared operations attached
generically, the enumerated HTTP routes delegate to them, and the raw-body
webhook stays a hand-written kernel endpoint on ADR-032's measured grounds.
One consequence crossed a package boundary: `order` ownership moved into the
signature package, so Contract Activation's actions on it became a declarable
record-level dependency — signature offers `signature-orders@1`, contracts
declares it, and contracts moved to **version 5**, because a package version
describes its composition contract, including `requires`, not only its
consumer-visible records and actions.

Pipeline is in `packages/core/src/` too and belongs there. It is a reusable
runtime capability rather than a domain, and it is in the matrix so that a reader
scanning core for misplaced business logic is told why it is not one.

The risk is not that they are old. The risk is **drift by silence**: a horizontal
capability lands, the newest domain gets it, the older ones are never assessed,
and after four milestones nobody can say which domain has what. This document
exists so that never has to be reconstructed from source.

## Status vocabulary, used exactly

| Status | Means |
|---|---|
| `aligned` | the domain uses the capability as the contract intends |
| `partial` | it uses part of it, or uses an equivalent that is not the contract |
| `deferred` | it should use it, it does not, and the milestone that closes the gap is named |
| `not_applicable` | the capability does not apply to this domain, with the reason |
| `needs_extraction` | the gap cannot close while the domain lives in `packages/core` |

`needs_extraction` is the one that matters. It says the blocker is **structural**,
not effort — no amount of care inside `packages/core/src/commercial-actions.js`
makes Commercial a package.

## Where each domain lives today

Verified against the working tree, 2026-08-19.

| Domain | Runtime home | Is it a package? |
|---|---|---|
| Core CRM (Sales) | project-generated modules: company, contact, opportunity, lead, task, approval | no — these are a project's own records, not a domain package |
| Pipeline | `packages/core/src/pipeline-*.js`; `packages/pipelines/generated/` | no — and correctly so, see ¹ |
| Lead Intelligence | `packages/intelligence/` — `src/`, `modules/`, `README.md` | **yes** — the first legacy domain extracted |
| Commercial Operations | `packages/commercial/` — `src/`, `modules/`, `README.md` | **yes** — the second legacy domain extracted |
| Signature & Order | `packages/signature/` — `src/`, `modules/` (`external-operation.js` stays in core as the recorded neutral runner) | **yes** — the third legacy domain extracted, on the ADR-032 operations seam |
| Contract Activation | `packages/contracts/` — `src/`, `modules/`, `README.md` | **yes** |
| Delivery | `packages/delivery/` — `src/`, `modules/`, `README.md` | **yes** |
| Service | `packages/service/` — `src/`, `modules/`, `README.md` | **yes** — package-native from its first commit (M15, built and merged) |
| Work | `packages/work/` — `src/`, `modules/`, `README.md` | **yes** — package-native; owns the ADR-030 subject envelope |
| Lifecycle | `packages/lifecycle/` — `src/`, `modules/`, `README.md` | **yes** — package-native (M16a, M16b) |
| Customer Data | `packages/customer-data/` — `src/`, `modules/`, `README.md` | **yes** — package-native (ADR-037). It **requires nothing**, adds no master customer table, and links and projects rather than duplicating |
| Custom-package fixture | `examples/custom-packages/partner-scorecard/` | **yes** — the customer-authoring proof |
| Custom-package capability-consumer fixture | `examples/custom-packages/score-disclosure/` | **yes** — the customer-authored proof that a package can consume `intelligence@1` |
| Marketing & Growth | documentation only (`docs/strategy/`) | — |

Each of the four has a `packages/<name>/generated/` directory and nothing else:
that directory is where a composed project registers the domain's policies and
providers, not where the domain lives.

## The matrix

Columns are the six built domains. Read a row as: *does this domain use this
horizontal capability the way the contract intends?*

### Durable jobs and scheduler contract v1 (Production Spine v3A)

Horizontal runtime capability: a tenant-bound application can atomically enqueue
named work, claim due work with a fenced lease, recover after restart, and run an
explicitly started worker. PostgreSQL uses transactional
`FOR UPDATE SKIP LOCKED`; SQLite uses its one-connection single-writer boundary
and does not claim multi-node worker support. Omitted versus explicit schedule
intent is durable, and each actor-required mutation records payload-free audit
evidence on the same storage transaction. A worker persists a generation-fenced
execution start before handler invocation: under the default recovery policy,
only unstarted expiry is recoverable and started expiry becomes terminal
reconciliation evidence without a second invocation. V3B later adds one
persisted opt-in for its locally reconcilable effect identities; provider jobs
retain this default. Execution lifecycle transitions require an explicit system actor;
operator/agent actors remain limited to scheduling mutations. This slice adds no domain timer
consumer, cron language, outbox, operator surface, worker autostart or public
production-readiness claim.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `partial` | the portable data plane owns the durable primitive, but no kernel Company/Contact/Opportunity/Approval behavior schedules itself in V3A |
| Pipeline | `not_applicable` | pipeline composition defines lifecycle state and owns no timer operation |
| Lead Intelligence | `deferred` | no scoring or routing timer is adopted; a later domain slice must name a real operation and idempotent outcome |
| Commercial Operations | `deferred` | no quote/catalog timer is adopted; provider work must remain behind external-operation v2 and reconciliation |
| Signature & Order | `deferred` | no signature provider effect is replayed from a job; a later outbox/effect slice must preserve external-operation v2 identity |
| Contract Activation | `deferred` | V3C will adopt the primitive for renewal/notice evaluation without authorizing an automatic commercial decision |
| Delivery | `deferred` | no delivery obligation timer is adopted in this infrastructure slice |
| Service | `deferred` | no SLA or escalation timer is adopted in this infrastructure slice |
| Work | `deferred` | V3C will adopt the primitive for named follow-up work while preserving its caller-owned transaction proof |
| Lifecycle | `deferred` | no lifecycle proposal timer is adopted in this infrastructure slice |
| Customer Data | `not_applicable` | linking/projection owns no current scheduled operation and V3A does not invent one |
| Custom-package fixture | `not_applicable` | the fixture proves package authoring and declares no scheduled operation |
| Custom-package score-disclosure fixture | `not_applicable` | the capability-consumer fixture reads scoring disclosure and declares no scheduled operation |

Closing milestone for the named Contract Activation and Work rows: Spine v3C
timer consumers. Every other `deferred` row requires its own later causal domain
adoption with executable idempotency and approval evidence; V3A does not mass-fit
jobs into existing packages.

### Transactional outbox and effect dispatch v1 (Production Spine v3B)

Horizontal PostgreSQL runtime capability: the existing write-outcome event
intents and an applicable V3A effect identity commit together. Workers dispatch
only committed source outcomes and mark internal events promoted only after
subscriber success. V3B identities persist a reconcilable recovery policy, so
expired begun work advances its bounded attempt/generation and may dispatch
again; generic and provider-effect jobs keep terminal unknown-outcome behavior.
A failed subscriber does not starve later stored intents; the pass then retries
as one bounded failure, so duplicates remain possible. Delivery is
at least once plus an idempotent/reconcilable identity, never exactly once.
External receipt continuation exists only when the committed receipt says a
finalize phase was declared, can call only registered local finalize work, and
never receives a provider call/reconcile handle. Provider-only operations do
not create continuation jobs. A legacy receipt whose declaration predates this
evidence remains operator-visible unknown and is never silently treated as
provider-only or authorized for finalize.
SQLite retains immediate in-process event behavior; this is not a durable
SQLite-outbox claim. Security audit is unchanged.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `partial` | PostgreSQL kernel write outcomes now retain and promote their committed internal event intents through exact durable jobs; standalone writes outside that envelope do not gain an outbox by implication |
| Pipeline | `not_applicable` | pipeline composition owns no separate persisted effect intent |
| Lead Intelligence | `deferred` | the bundled provider graph is not adopted onto external-operation v2 and no real provider adapter exists |
| Commercial Operations | `deferred` | catalog/provider effects remain outside the M4 write-outcome envelope |
| Signature & Order | `deferred` | the neutral receipt-to-local-finalize consumer exists, but the shipped package provider graph still requires its own external-operation-v2 adoption; V3B does not replay signature providers |
| Contract Activation | `deferred` | activation scheduling is V3C; no renewal effect is inferred from infrastructure |
| Delivery | `deferred` | no delivery effect consumer is adopted in this slice |
| Service | `deferred` | no service/SLA effect consumer is adopted in this slice |
| Work | `deferred` | due follow-up scheduling is V3C; no task state is changed by the outbox |
| Lifecycle | `deferred` | no decision or commercial follow-up is created automatically |
| Customer Data | `not_applicable` | linking/projection owns no current post-commit effect intent |
| Custom-package fixture | `not_applicable` | the fixture declares no write-outcome effect consumer |
| Custom-package score-disclosure fixture | `not_applicable` | the read-only capability fixture declares no effect consumer |

Closing milestones are causal domain adoptions onto the PostgreSQL write-outcome
and external-operation-v2 contracts. A durable identity alone promotes no domain
coverage and authorizes no provider retry.

### Deployment-storage loader contract v1 assessment (Production Spine v2 M2F)

The shared deployment-storage loader is a horizontal *runtime* capability: every
executable will eventually select adapter and spine binding through one closed
document. Domains do not select storage and must not import the loader. CLI,
serve and MCP now call `prepareDeploymentPreconnect`. Public HTTP `/health` and
`/api/schema` project `{adapter, available}` only. CLI `app.doctor().database`
on `--db` remains the characterized v1 path disclosure.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `not_applicable` | project records do not select the deployment adapter |
| Pipeline | `not_applicable` | pipeline composition does not load deployment storage |
| Lead Intelligence | `not_applicable` | package behaviour does not select the storage adapter |
| Commercial Operations | `not_applicable` | package behaviour does not select the storage adapter |
| Signature & Order | `not_applicable` | package behaviour does not select the storage adapter |
| Contract Activation | `not_applicable` | package behaviour does not select the storage adapter |
| Delivery | `not_applicable` | package behaviour does not select the storage adapter |
| Service | `not_applicable` | package behaviour does not select the storage adapter |
| Work | `not_applicable` | package behaviour does not select the storage adapter |
| Lifecycle | `not_applicable` | package behaviour does not select the storage adapter |
| Customer Data | `not_applicable` | package behaviour does not select the storage adapter |
| Custom-package fixture | `not_applicable` | customer packages receive no deployment-storage document |

Public HTTP locators on `/health` and `/api/schema` are closed by the final M2
posture slice. The factory does not import the loader; entries call
`prepareDeploymentPreconnect`. v1 `--db` `doctor.database` is retained. Dual
bundled v1/v2 package graphs remain later compatibility work.

### Dialect migration intent and module-state v2 assessment (Production Spine v2 M3A)

Horizontal runtime capability: every generated module and every domain that
owns module manifests will eventually need a checked-in PostgreSQL bootstrap
beside its SQLite history. Core CRM handwritten tables are described by core
schema intent, not by `module.state.json`. Bundled package modules remain
pre-state; adopting them is sequenced authoring, not this PR. No domain
selects PostgreSQL and none imports the intent renderer.
<!-- truth: spine.postgresql.implemented=absent -->

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `partial` | handwritten Company/Contact/Opportunity/Approval schema is in core intent; project-generated modules gain v2 state only after `module create --apply` |
| Pipeline | `not_applicable` | pipeline composition does not own persisted tables |
| Lead Intelligence | `deferred` | package modules are pre-state; explicit adoption is later authoring, not this PR |
| Commercial Operations | `deferred` | package modules are pre-state; explicit adoption is later authoring, not this PR |
| Signature & Order | `deferred` | package modules are pre-state; explicit adoption is later authoring, not this PR |
| Contract Activation | `deferred` | package modules are pre-state; explicit adoption is later authoring, not this PR |
| Delivery | `deferred` | package modules are pre-state; explicit adoption is later authoring, not this PR |
| Service | `deferred` | package modules are pre-state; explicit adoption is later authoring, not this PR |
| Work | `deferred` | package modules are pre-state; explicit adoption is later authoring, not this PR |
| Lifecycle | `deferred` | package modules are pre-state; explicit adoption is later authoring, not this PR |
| Customer Data | `deferred` | package modules are pre-state; explicit adoption is later authoring, not this PR |
| Custom-package fixture | `deferred` | customer packages remain pre-state until their authors apply adoption |

Closing milestone for every `deferred` row: package-module state adoption before a composition is selected for PostgreSQL (M3B/dual-graph follow-up), not a silent rewrite in this PR.

### PostgreSQL write-outcome idempotency and external-operation v2 (Production Spine v2 M4A)

Horizontal runtime capability: every PostgreSQL write is keyed, stored as a bounded outcome in the same SERIALIZABLE transaction, and recovered after `COMMIT_OUTCOME_UNKNOWN` by tenant+raw-key lookup. External-operation v2 adds durable intent/finalize phase keys, a stable provider idempotency key and read-only reconcile; PostgreSQL composition refuses `externalOperation: 1`. SQLite legacy calls remain compatible when the key is omitted. HTTP/SDK/Admin/CLI now transport the key (M4C). Leases and tenant binding are M4B. Not shared-database tenancy and not production ready.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `partial` | kernel `company.create` and record actions on PostgreSQL use the outcome envelope; Contact/Opportunity/Approval standalone creates are not yet independently keyed |
| Pipeline | `not_applicable` | pipeline composition does not own write outcomes |
| Lead Intelligence | `deferred` | package still `externalOperation: 1` / SQLite graph; PostgreSQL composition refuses until a v2 graph exists |
| Commercial Operations | `deferred` | catalog sync is not on the M4A envelope; dual-graph PostgreSQL selection is later |
| Signature & Order | `deferred` | shipped `externalOperation: 1`; PostgreSQL composition refuses it until the v2 provider+reconcile graph |
| Contract Activation | `deferred` | package persistence is outside the M4A kernel envelope |
| Delivery | `deferred` | package persistence is outside the M4A kernel envelope |
| Service | `deferred` | package persistence is outside the M4A kernel envelope |
| Work | `deferred` | package persistence is outside the M4A kernel envelope |
| Lifecycle | `deferred` | package persistence is outside the M4A kernel envelope |
| Customer Data | `deferred` | package persistence is outside the M4A kernel envelope |
| Custom-package fixture | `deferred` | customer packages remain SQLite/v1 until their authors declare external-operation v2 |

Closing milestone for every `deferred` row: dual-graph PostgreSQL selection with external-operation v2 (domain adoption), not a silent rewrite of bundled v1 graphs in this PR.

### Tenant binding v2, leases and HTTP/SDK/Admin/CLI (Production Spine v2 M4B–M4C)

Horizontal runtime capability: one tenant per dedicated PostgreSQL data plane; writer leases with generation fencing; `Idempotency-Key` on HTTP/SDK; Admin form/action controller owns the root key. Clone/expiry does not auto-promote a writer. Not shared-database row tenancy and not production ready.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `partial` | kernel HTTP/SDK company writes and workflow stage/approval carry keys on PostgreSQL; Contact/Opportunity standalone creates are not independently keyed |
| Pipeline | `not_applicable` | pipeline composition does not own write outcomes |
| Lead Intelligence | `deferred` | no opportunistic domain refactor to green this cell |
| Commercial Operations | `deferred` | no opportunistic domain refactor to green this cell |
| Signature & Order | `deferred` | no opportunistic domain refactor to green this cell |
| Contract Activation | `deferred` | no opportunistic domain refactor to green this cell |
| Delivery | `deferred` | no opportunistic domain refactor to green this cell |
| Service | `deferred` | no opportunistic domain refactor to green this cell |
| Work | `deferred` | no opportunistic domain refactor to green this cell |
| Lifecycle | `deferred` | no opportunistic domain refactor to green this cell |
| Customer Data | `deferred` | no opportunistic domain refactor to green this cell |
| Custom-package fixture | `deferred` | customer packages remain SQLite/v1 until their authors declare portable v2 |

### Identity-verifier pre-connect contract v2 assessment (Production Spine v2 M2F)

The verifier resolver is a horizontal *runtime* capability: every executable
will eventually import one repository-relative ESM provider before it connects.
Domains do not resolve verifiers and must not import the resolver. CLI/serve/MCP
now resolve the verifier through `prepareDeploymentPreconnect` before a
database or listener exists. Live discover/attest remains M3.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `not_applicable` | project records do not resolve the identity verifier |
| Pipeline | `not_applicable` | pipeline composition does not import verifier modules |
| Lead Intelligence | `not_applicable` | package behaviour does not select the verifier provider |
| Commercial Operations | `not_applicable` | package behaviour does not select the verifier provider |
| Signature & Order | `not_applicable` | package behaviour does not select the verifier provider |
| Contract Activation | `not_applicable` | package behaviour does not select the verifier provider |
| Delivery | `not_applicable` | package behaviour does not select the verifier provider |
| Service | `not_applicable` | package behaviour does not select the verifier provider |
| Work | `not_applicable` | package behaviour does not select the verifier provider |
| Lifecycle | `not_applicable` | package behaviour does not select the verifier provider |
| Customer Data | `not_applicable` | package behaviour does not select the verifier provider |
| Custom-package fixture | `not_applicable` | customer packages receive no identityVerifier document |

### Runtime secret-provider contract v1 assessment (Production Spine v4A)

The secret resolver is a horizontal runtime capability consumed at the
deployment boundary by PostgreSQL control/data authentication and identity
verifier initialization. Domain packages do not receive the resolver, secret
references or leases. Existing fixture provider definitions remain
credential-free; real external-provider credentials are later adapter work, not
an excuse to push this boundary into every domain.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `not_applicable` | project records never resolve credentials; the PostgreSQL adapter consumes them below the service boundary |
| Pipeline | `not_applicable` | pipeline composition has no provider credential |
| Lead Intelligence | `deferred` | only a deterministic fixture provider ships; a future real enrichment adapter must consume the resolver without putting references in its definition fingerprint |
| Commercial Operations | `deferred` | only deterministic fixture catalog providers ship; real catalog adapter credential binding is later provider work |
| Signature & Order | `deferred` | the fixture verification key remains explicitly test-only; a real signature adapter must resolve its credential at the deployment boundary |
| Contract Activation | `not_applicable` | activation calls no external provider |
| Delivery | `not_applicable` | delivery calls no external provider |
| Service | `not_applicable` | service calls no external provider |
| Work | `not_applicable` | work calls no external provider |
| Lifecycle | `not_applicable` | lifecycle calls no external provider |
| Customer Data | `not_applicable` | the bounded source envelope carries provenance, not a provider credential |
| Custom-package fixture | `not_applicable` | customer packages do not receive internal deployment secrets machinery |

Closing milestone for a `deferred` row is the corresponding real provider
adapter with executable zero-leak evidence. This PR does not refactor a domain,
ship a third-party credential or make provider work retryable.

### Scheduled timer consumers assessment (Production Spine v3C)

This horizontal capability lets a person schedule an ask — open this follow-up
on that date, review this renewal when notice opens — as a visible instruction
record whose durable job carries only its identity and fingerprint. An
explicitly started worker presents it at that instant through the capability
seam the domain already offers, using the consumer identity the record carries.
It is infrastructure beside domain packages, not inside them: `work` still
schedules nothing and `lifecycle` still schedules nothing, both literally, and
no package version moves. A timer opens an ask and decides nothing; every
closing action stays refused to its authority. Nothing autostarts, and an
application that starts no worker behaves exactly as it did before.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `partial` | its records can be the subject of a scheduled ask, but no operator surface schedules one and the composition must start the worker itself |
| Pipeline | `not_applicable` | lifecycle definitions own no instant and no ask of their own |
| Lead Intelligence | `not_applicable` | scoring produces no ask a person schedules for later |
| Commercial Operations | `partial` | a commercial follow-up is the first ask a timer opens, through `work/follow-up@1` with lifecycle's declared identity |
| Signature & Order | `not_applicable` | signature timing belongs to the provider and its receipts, never to a local timer |
| Contract Activation | `partial` | a renewal review becomes due on notice, and the renewal decision stays the human action lifecycle already owns |
| Delivery | `not_applicable` | delivery obligations carry their own evidence and open no scheduled ask |
| Service | `not_applicable` | escalation is immediate by contract; nothing about it waits for an instant |
| Work | `aligned` | it receives asks through its existing capability and gains no scheduling behaviour of its own — its published claim that it schedules nothing stays true |
| Lifecycle | `aligned` | it is named as the consumer identity on renewal and commercial asks and gains no scheduling behaviour — its published claim stays true |
| Customer Data | `not_applicable` | projections are read models; a timer opens no projection |
| Custom-package fixture | `not_applicable` | custom packages receive no timer seam |
| Custom-package score-disclosure fixture | `not_applicable` | the capability fixture receives no timer seam |

Closing a `partial` cell requires the operator composition the integration slice
adds. V3C retrofits no domain, adds no recurrence syntax, sends nothing, and
grants a timer no authority to decide anything a person decides today.

### Backup, verify and restore contract v1 assessment (Production Spine v4B)

This horizontal runtime capability creates and verifies a closed PostgreSQL 16
backup bundle and restores it only behind an explicit target lock, broad
empty-target inspection across enumerated database-local catalog families
(including large-object/default-ACL/cast metadata),
independent artifact and canonical-manifest identity, verified-actor control-plane receipt boundary and
normal startup attestation. It is infrastructure below domain packages: no
domain receives connection material, backup paths, native-tool arguments or
restore authority. SQLite and managed backup custody, scheduling, retention and
promotion remain absent.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `partial` | its dedicated PostgreSQL data plane is covered by the self-host contract, but no application/operator composition or managed policy ships in V4B |
| Pipeline | `not_applicable` | lifecycle definitions own no physical data-plane backup behavior |
| Lead Intelligence | `not_applicable` | package records are included only as ordinary data-plane bytes; the package owns no backup adapter |
| Commercial Operations | `not_applicable` | package records are included only as ordinary data-plane bytes; provider state is not backed up by this contract |
| Signature & Order | `not_applicable` | package records are included as data-plane bytes; external provider custody remains outside this contract |
| Contract Activation | `not_applicable` | package records are included as ordinary data-plane bytes and receive no restore authority |
| Delivery | `not_applicable` | package records are included as ordinary data-plane bytes and receive no restore authority |
| Service | `not_applicable` | package records are included as ordinary data-plane bytes and receive no restore authority |
| Work | `not_applicable` | package records are included as ordinary data-plane bytes and receive no restore authority |
| Lifecycle | `not_applicable` | package records are included as ordinary data-plane bytes and receive no restore authority |
| Customer Data | `not_applicable` | projected records are ordinary data-plane bytes; source-system deletion and ejection remain separate policy |
| Custom-package fixture | `not_applicable` | custom packages receive no backup provider, connection or restore-control seam |
| Custom-package score-disclosure fixture | `not_applicable` | the capability fixture receives no backup provider, connection or restore-control seam |

Closing a `partial` cell requires the later authenticated operator composition
and executable deployment policy. V4B does not retrofit domains, claim managed
backups or grant a restored clone writer authority.

### Public site provenance contract v2 assessment

`/version.json` v2 is a horizontal discovery contract for the generated public
site, not a CRM runtime capability. It extends the one existing provenance
artifact so a reader can compare checkout SHA and claims-measurement SHA without
adding a command or rail. No domain reads it and no application behavior moves.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `not_applicable` | project records do not consume public-site build metadata |
| Pipeline | `not_applicable` | runtime pipeline composition is independent of the marketing deployment |
| Lead Intelligence | `not_applicable` | package behavior and evidence do not read `/version.json` |
| Commercial Operations | `not_applicable` | package behavior and evidence do not read `/version.json` |
| Signature & Order | `not_applicable` | package behavior and evidence do not read `/version.json` |
| Contract Activation | `not_applicable` | package behavior and evidence do not read `/version.json` |
| Delivery | `not_applicable` | package behavior and evidence do not read `/version.json` |
| Service | `not_applicable` | package behavior and evidence do not read `/version.json` |
| Work | `not_applicable` | package behavior and evidence do not read `/version.json` |
| Lifecycle | `not_applicable` | package behavior and evidence do not read `/version.json` |
| Customer Data | `not_applicable` | package behavior and evidence do not read `/version.json` |
| Custom-package fixture | `not_applicable` | customer packages receive no public-site deployment metadata |

### Storage contract v1 assessment (Production Spine v2 M1 + M2A + M2B + M2C + M2D + M2F)

The internal dialect-neutral storage seam is horizontal kernel machinery. M1
initially proved only Company and generated Work resources. M2A added the bounded
Approval, Contact, Opportunity, and Work legacy-migration compatibility family.
M2B adds one bounded slice across four packages: the startup persist-or-verify of
immutable definition/version fingerprints, which Commercial, Signature, Lead
Intelligence and the package registry each carried a raw copy of and now share
through one internal core store. It is a *startup identity* slice, not domain
persistence: each of those packages still writes its own records directly, which
is why none of their rows becomes `aligned`. Declaring every other domain aligned
would still be the silent backfill this matrix prevents.

M2C extracts the kernel's remaining raw consumers for run and span lifecycle
evidence. The workflow engine and the action runtime's `writeTrace` each
prepared their own statements against `workflow_runs` and `trace_spans`, and
now share one internal core store on the same seam. Like M2B this is *kernel*
persistence rather than a domain's own records, so it promotes no domain row —
but unlike M2B it is true of every domain's evidence at once, which is recorded
below the table rather than repeated fourteen times.

M2F closes the remaining Spine store itself. Organization and Membership
persistence now uses the same closed statement vocabulary, including its
control mutation plus immutable audit-intent transaction. This is control-plane
identity machinery, not a migration of any domain's own rows, so it changes no
domain status below. The released direct-SQLite `createSpineStore` input is
preserved by a deep-internal adapter; the store file itself no longer reaches
the driver.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `aligned` | Company, Contact, Opportunity and Approval now use the structured seam; conversion, pipeline and approval suites preserve their characterized behavior, and a structural guard prevents raw-driver reachability from returning |
| Work | `aligned` | its generated resources and `migrateLegacyTasks(...)` use the structured storage seam, with executable migration evidence; M2D moved the last reach — `follow-up.js#requireCallerTransaction` proved the caller transaction by reading the driver's transaction flag, and now proves it through the storage seam's opaque witness. No file in `packages/work/src` reaches the driver by any spelling the M2D guard covers |
| Pipeline | `deferred` | runtime pipeline persistence remains direct SQLite and is sequenced for M2; its workflow-run and trace evidence moved onto the seam with M2C, which is kernel machinery rather than this domain's own records |
| Lead Intelligence | `partial` | M2B moved its definition-version registration (enrichment providers, scoring models, routing policies) onto the shared store behind the seam; its own domain persistence remains outside the migrated slice |
| Commercial Operations | `partial` | M2B moved its definition-version registration (catalog providers, discount policies) onto the shared store behind the seam; its own domain persistence remains outside the migrated slice |
| Signature & Order | `partial` | M2B moved its definition-version registration (signature providers) onto the shared store behind the seam; its own domain persistence remains outside the migrated slice |
| Contract Activation | `deferred` | package persistence is outside the two-consumer M1 slice; M2 owns migration |
| Delivery | `deferred` | package persistence is outside the two-consumer M1 slice; M2 owns migration |
| Service | `deferred` | package persistence is outside the two-consumer M1 slice; M2 owns migration |
| Lifecycle | `deferred` | package persistence is outside the two-consumer M1 slice; M2 owns migration |
| Customer Data | `deferred` | package persistence is outside the two-consumer M1 slice; M2 owns migration |
| Custom-package fixture | `partial` | newly generated services use the seam, while existing checked source is not mass-regenerated by M1 |
| Marketing & Growth | `not_applicable` | documentation-only; it has no runtime persistence consumer |

M2D is the same shape of slice and is assessed in its own section below: it
moved one *transaction-context* consumer off the driver, not any domain's
persistence, so no other row above moves because of it.

One consequence of M2B is not a per-domain row, because it is true of every
package at once: a package's declared `domain-policy:<domain>:<kind>` versions
are now registered through the same store on the seam, whatever that package's
own persistence does. A `deferred` row above therefore means *this domain's own
records*, not its policy identity.

The same is true of M2C, for the same reason. Every domain's **run and trace
evidence** — every `workflow_runs` row and every `trace_spans` row, whether a
named workflow, a record action, an external operation or a package-owned
operation produced it — is now written through one internal store on the seam.
A `deferred` row therefore means this domain's own records, not its policy
identity and not the evidence recorded about its runs. What still keeps a
domain off `aligned` is exactly what it always was: its own persistence.

**The kernel's remaining raw residue, after M2C, M2D, the M2F Spine-store
closure and the M2 final raw-driver exit.** M2C moved the workflow engine's
run and span lifecycle onto the store; M2D moved
`packages/work/src/follow-up.js#requireCallerTransaction` off the driver's
transaction flag; M2F then moved the Organization/Membership store itself onto
the same seam. The M2 final posture slice then moved
`packages/core/src/core-adapters.js` Company/Contact lookups onto
`database.storage.sync`. **No application-runtime business or Spine-store
consumer is left in `packages/`.**

Scanned after that slice, no application-runtime business consumer in
`packages/` or `apps/` reaches the driver. Known driver spellings remain in
`packages/core/src/database.js`, which owns `DatabaseSync` and the raw
closure, and in adapter-internal `createSqliteStorage` (a parameter named
`raw`, outside the token set). `spine-store-storage-adapter.js` resolves the
closed storage seam and does not spell `database.raw`. A prose mention in
`packages/core/index.js` describes what M2D replaced.
**A PostgreSQL adapter now exists behind Storage Contract v1 (M3B).** The
application factories still refuse PostgreSQL composition; shared-database
tenancy is not implemented. Domain rows against that adapter are assessed in
the M3B section below.

This paragraph was true when M2C wrote it and false the moment M2D merged into
it, with no conflict marker to say so: git merged the two edits cleanly because
neither touched the other's lines. It is corrected here rather than in a later
reconciliation, because a sentence naming a consumer that no longer exists is
the kind of stale claim this matrix exists to catch.

### PostgreSQL Storage Contract v1 adapter (Production Spine v2 M3B)

M3B is a horizontal kernel seam: Storage Contract v1 gains `renderPostgresqlStatement`
and a connection-affine `pg@8.23.0` adapter. The same contract tests run against
SQLite and PostgreSQL. It does **not** compose the application on PostgreSQL,
does not migrate domain schemas, and does not claim shared-database tenancy.
A `deferred` row below means the domain's own records have not been exercised
on this adapter; declaring them aligned here would be the silent backfill this
matrix exists to prevent. Closing the gap is M3C.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `deferred` | Company/Contact/Opportunity/Approval speak Storage Contract v1 on SQLite; application composition on PostgreSQL is M3C |
| Work | `deferred` | Work uses the storage seam on SQLite; PostgreSQL application composition is M3C |
| Pipeline | `deferred` | pipeline persistence is not on this adapter; M3C |
| Lead Intelligence | `deferred` | domain persistence has not been exercised on PostgreSQL; M3C |
| Commercial Operations | `deferred` | domain persistence has not been exercised on PostgreSQL; M3C |
| Signature & Order | `deferred` | domain persistence has not been exercised on PostgreSQL; M3C |
| Contract Activation | `deferred` | domain persistence has not been exercised on PostgreSQL; M3C |
| Delivery | `deferred` | domain persistence has not been exercised on PostgreSQL; M3C |
| Service | `deferred` | domain persistence has not been exercised on PostgreSQL; M3C |
| Lifecycle | `deferred` | domain persistence has not been exercised on PostgreSQL; M3C |
| Customer Data | `deferred` | domain persistence has not been exercised on PostgreSQL; M3C |
| Custom-package fixture | `deferred` | the v1 fixture remains SQLite; PostgreSQL composition is M3C |
| Custom-package score-disclosure fixture | `deferred` | the v1 fixture remains SQLite; PostgreSQL composition is M3C |
| Marketing & Growth | `not_applicable` | documentation-only; it has no runtime persistence consumer |

| Question | Answer |
|---|---|
| Which old domains does this touch? | None at runtime. The adapter is kernel-only; no domain service is composed on PostgreSQL |
| Which are already aligned? | None — alignment here would mean the domain's own records proven on PostgreSQL |
| Which need metadata only? | Every domain row above: declared `deferred` until M3C |
| Which need a code backfill? | Closing the rows is M3C application composition, not a domain rewrite in this PR |
| Was the matrix updated? | Yes — this section |

### PostgreSQL application composition (Production Spine v2 M3C)

M3C is a horizontal kernel seam: the portable async factory boots a dedicated-
database PostgreSQL application after startup attestation. Shared-database
row-level tenancy is still absent. A `partial` row means the domain graph can
be selected on PostgreSQL; a `deferred` row means its own records have not
been proven through a representative write on that adapter.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `aligned` | Company/Contact/Opportunity/Approval create, list, audit and workflow run on PostgreSQL |
| Work | `partial` | contract-2 graph composes on PostgreSQL; follow-up writes still need generated work-task modules |
| Pipeline | `partial` | opportunity pipeline columns exist on the PostgreSQL data plane; dedicated pipeline tests remain SQLite |
| Lead Intelligence | `deferred` | domain records have not been exercised on PostgreSQL |
| Commercial Operations | `deferred` | domain records have not been exercised on PostgreSQL |
| Signature & Order | `deferred` | domain records have not been exercised on PostgreSQL |
| Contract Activation | `deferred` | domain records have not been exercised on PostgreSQL |
| Delivery | `deferred` | domain records have not been exercised on PostgreSQL |
| Service | `deferred` | domain records have not been exercised on PostgreSQL |
| Lifecycle | `deferred` | domain records have not been exercised on PostgreSQL |
| Customer Data | `deferred` | domain records have not been exercised on PostgreSQL |
| Custom-package fixture | `deferred` | the v1 fixture remains SQLite |
| Custom-package score-disclosure fixture | `deferred` | the v1 fixture remains SQLite |
| Marketing & Growth | `not_applicable` | documentation-only; it has no runtime persistence consumer |

| Question | Answer |
|---|---|
| Which old domains does this touch? | Core CRM services gained an async Storage Contract path so PostgreSQL composition can run without changing `createAccordoApp()` |
| Which are already aligned? | Core CRM (Sales) on the representative write/audit/workflow path |
| Which need metadata only? | The deferred package rows: composition is possible, domain writes are unproven |
| Which need a code backfill? | Generated-module services still use `storage.sync`; package record modules need the same dual path before those rows close |
| Was the matrix updated? | Yes — this section |

### Async package-contract v2 assessment (Production Spine v2 M2E-1)

M2E-1 is horizontal kernel capability: it makes uniform contract-1 and
contract-2 package graphs expressible, normalizes an absent capability contract
to 1, publishes the resolved versions, and refuses a mixed graph before any
service is called. It deliberately migrates no package. A `deferred` row below
therefore means the domain still ships only its synchronous v1 definition; it
does not mean its current v1 graph is invalid. Dual bundled v1/v2 graphs remain later compatibility work, not M2E-3.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `not_applicable` | project-owned records are not package definitions; their async service composition belongs to M2E-2 |
| Pipeline | `not_applicable` | a kernel workflow capability, not a domain package |
| Lead Intelligence | `deferred` | its contract-1 graph remains selected; dual v1/v2 definitions remain later compatibility work |
| Commercial Operations | `deferred` | its contract-1 graph remains selected; dual v1/v2 definitions remain later compatibility work |
| Signature & Order | `deferred` | its contract-1 graph remains selected; dual v1/v2 definitions remain later compatibility work |
| Contract Activation | `deferred` | its contract-1 graph remains selected; dual v1/v2 definitions remain later compatibility work |
| Delivery | `deferred` | its contract-1 graph remains selected; dual v1/v2 definitions remain later compatibility work |
| Service | `deferred` | its contract-1 graph remains selected; dual v1/v2 definitions remain later compatibility work |
| Work | `deferred` | its capability declaration still omits the field by compatibility and resolves to contract 1; an explicit dual graph remains later compatibility work |
| Lifecycle | `deferred` | it consumes domain capability version 2 on synchronous execution contract 1; an async graph remains later compatibility work |
| Customer Data | `deferred` | its contract-1 graph remains selected; dual v1/v2 definitions remain later compatibility work |
| Custom-package fixture | `deferred` | it remains the unchanged customer-authored contract-1 compatibility proof; a separate v2 fixture is later compatibility work and must not silently rewrite this v1 fixture |
| Custom-package score-disclosure fixture | `deferred` | its contract-1 graph and `intelligence@1` dependency remain the customer-authored capability-consumer proof; a v2 companion is later compatibility work rather than a silent rewrite of this v1 fixture |
| Marketing & Growth | `not_applicable` | documentation-only; it has no runtime package graph |

### Private async SQLite lifecycle assessment (Production Spine v2 M2E-2A)

M2E-2A is horizontal kernel machinery, not a domain capability and not M2E-2
complete. It proves a selected graph is uniformly async-v2 before any SQLite
path, opener, provider or listener can move, then owns one adapter through
post-open assembly and one shared close promise. It is **not** M2E-1's
graph-validation vocabulary (already merged), **not** a portable application
facade (M2E-2B), **not** awaited HTTP/security (M2E-2C), and **not** a public
async factory (M2E-3). `createAccordoApp()` remains the only public factory and
remains synchronous. A `deferred` row means the domain is not composed through
this private lifecycle; it does not mean its released v1 graph is invalid.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `not_applicable` | project-owned records are not selected through this private lifecycle; 2B owns any portable service graph over it |
| Pipeline | `not_applicable` | a kernel workflow capability, not a selected package graph |
| Lead Intelligence | `deferred` | its contract-1 graph remains the released selection; 2B/2C do not compose it here and dual v1/v2 definitions remain later compatibility work |
| Commercial Operations | `deferred` | its contract-1 graph remains the released selection; 2B/2C do not compose it here and dual v1/v2 definitions remain later compatibility work |
| Signature & Order | `deferred` | its contract-1 graph remains the released selection; 2B/2C do not compose it here and dual v1/v2 definitions remain later compatibility work |
| Contract Activation | `deferred` | its contract-1 graph remains the released selection; 2B/2C do not compose it here and dual v1/v2 definitions remain later compatibility work |
| Delivery | `deferred` | its contract-1 graph remains the released selection; 2B/2C do not compose it here and dual v1/v2 definitions remain later compatibility work |
| Service | `deferred` | its contract-1 graph remains the released selection; 2B/2C do not compose it here and dual v1/v2 definitions remain later compatibility work |
| Work | `deferred` | its capability still resolves to synchronous contract 1; this slice does not compose Work onto the private lifecycle |
| Lifecycle | `deferred` | it still consumes domain capability version 2 on synchronous execution contract 1; this slice does not change that |
| Customer Data | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Custom-package fixture | `deferred` | it remains the customer-authored contract-1 compatibility proof; this slice adds no v2 fixture |
| Custom-package score-disclosure fixture | `deferred` | it remains the customer-authored capability-consumer proof; this slice does not rewrite it |
| Marketing & Growth | `not_applicable` | documentation-only; it has no runtime lifecycle |

### Portable internal application facade assessment (Production Spine v2 M2E-2B)

M2E-2B is horizontal kernel machinery, not a domain capability and not M2E-2
complete. It composes kernel modules, selected packages, actions, operations,
audit, workflow and provider state over 2A's owned storage handle and returns
one frozen lexical-allowlist facade plus `{adapter, available}`. It is **not**
awaited HTTP/security (M2E-2C) and **not** a public async factory (M2E-3).
`createAccordoApp()` remains the only public factory and remains synchronous.
A `deferred` row means the domain's released contract-1 graph is not selected
through this private facade; it does not mean that v1 graph is invalid.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `partial` | kernel Company/Contact/Opportunity/Approval compose over 2A storage and are reachable through the leak-free facade; generated project modules and Spine are not |
| Pipeline | `not_applicable` | a kernel workflow capability; this slice registers an empty pipeline registry and does not migrate pipeline contract 1 |
| Lead Intelligence | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Commercial Operations | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Signature & Order | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Contract Activation | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Delivery | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Service | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Work | `deferred` | its capability still resolves to synchronous contract 1; this slice does not compose Work onto the portable facade |
| Lifecycle | `deferred` | it still consumes domain capability version 2 on synchronous execution contract 1; this slice does not change that |
| Customer Data | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Custom-package fixture | `deferred` | it remains the customer-authored contract-1 compatibility proof; this slice adds no v2 fixture |
| Custom-package score-disclosure fixture | `deferred` | it remains the customer-authored capability-consumer proof; this slice does not rewrite it |
| Marketing & Growth | `not_applicable` | documentation-only; it has no runtime facade |

### Awaited portable HTTP/security assessment (Production Spine v2 M2E-2C)

M2E-2C is horizontal kernel machinery, not a domain capability and not M2E-2
complete. It awaits portable composition, security/identity/authorization
assembly, package startup hooks and capability-contract echoes before binding
an HTTP listener, and it refuses a thenable standing in for a domain value at
the first observable HTTP/capability seam. It is **not** a public async
factory (M2E-3) and it does **not** change default `accordo serve`.
`createAccordoApp()` remains the only public factory and remains synchronous.
A `deferred` row means the domain's released contract-1 graph is not selected
through this private HTTP entry; it does not mean that v1 graph is invalid.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `partial` | kernel Company/Contact/Opportunity/Approval writes and reads are awaited over portable HTTP; generated project modules and dual-plane Spine are not composed here |
| Pipeline | `not_applicable` | a kernel workflow capability; this slice does not migrate pipeline contract 1 |
| Lead Intelligence | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Commercial Operations | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Signature & Order | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Contract Activation | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Delivery | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Service | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Work | `deferred` | its capability still resolves to synchronous contract 1; this slice does not compose Work onto portable HTTP |
| Lifecycle | `deferred` | it still consumes domain capability version 2 on synchronous execution contract 1; this slice does not change that |
| Customer Data | `deferred` | its contract-1 graph remains the released selection; dual v1/v2 definitions remain later compatibility work |
| Custom-package fixture | `deferred` | it remains the customer-authored contract-1 compatibility proof; this slice adds no v2 fixture |
| Custom-package score-disclosure fixture | `deferred` | it remains the customer-authored capability-consumer proof; this slice does not rewrite it |
| Marketing & Growth | `not_applicable` | documentation-only; it has no runtime HTTP graph |

### Public portable async factory assessment (Production Spine v2 M2E-3)

M2E-3 is horizontal kernel machinery: it publishes `createAccordoAppAsync()`
over 2A/2B so a portable SQLite caller has one unconditional `await` path.
The default selected graph is an explicit `packageContract: 2` with empty
package/action/module lists, so kernel Company/Contact/Opportunity/Approval
compose without silently treating bundled v1 packages as v2. It is **not**
dual bundled package graphs, **not** default `accordo serve`, and **not** a
PostgreSQL adapter. `createAccordoApp()` remains the synchronous v1 factory.
A `deferred` row means the domain still ships only its contract-1 definition
and is not selected by this factory's default graph; it does not mean that v1
graph is invalid.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `partial` | kernel Company/Contact/Opportunity/Approval compose through the public async factory over explicit empty contract-2; generated project modules and dual-plane Spine are not |
| Pipeline | `not_applicable` | a kernel workflow capability; this slice does not migrate pipeline contract 1 |
| Lead Intelligence | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Commercial Operations | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Signature & Order | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Contract Activation | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Delivery | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Service | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Work | `deferred` | its capability still resolves to synchronous contract 1; this factory does not compose Work |
| Lifecycle | `deferred` | it still consumes domain capability version 2 on synchronous execution contract 1; this factory does not change that |
| Customer Data | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Custom-package fixture | `deferred` | it remains the customer-authored contract-1 compatibility proof; the public async path refuses it with `PACKAGE_ASYNC_CONTRACT_REQUIRED` rather than rewriting it |
| Custom-package score-disclosure fixture | `deferred` | it remains the customer-authored capability-consumer proof; this slice does not rewrite it |
| Marketing & Growth | `not_applicable` | documentation-only; it has no runtime factory graph |

### Cross-plane Spine audit recovery assessment (Production Spine v2 M2F)

The immutable audit-intent and explicit-reconciliation contract applies only to
Spine Organizations and Memberships: control-plane authorization state whose
audit belongs in a separate tenant data plane. It is horizontal security
machinery, but not a domain capability and not an invitation to route domain
events through a generic outbox.

The startup corrections stay at the same boundary: known global migration
identity and the selected data/control family are checked before composition;
fresh-process ledger races receive bounded startup-only retry; every post-open
refusal closes both handles; and the public recovery options are a closed
`limit: 1..100` shape. A released v1-v5 combined file may still be adopted as
control with dormant CRM tables intact. The isolation claim is separate runtime
handles and service reachability, not physical deletion and not M4 resource
attestation. None of these rules adds a domain persistence consumer, so the
per-domain dispositions below remain unchanged.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `not_applicable` | its data and audit already share the tenant data-plane transaction; no cross-plane Organization/Membership write occurs |
| Pipeline | `not_applicable` | pipeline rows are tenant data and this slice exposes no general event/outbox contract |
| Lead Intelligence | `not_applicable` | package records are tenant data; the contract is closed over Spine authorization mutations |
| Commercial Operations | `not_applicable` | package records are tenant data; the contract is closed over Spine authorization mutations |
| Signature & Order | `not_applicable` | external-operation recovery is its own contract; M2F audit intent accepts no arbitrary package work |
| Contract Activation | `not_applicable` | package multi-write atomicity remains on the caller transaction proof, not this cross-plane intent |
| Delivery | `not_applicable` | delivery writes no Organization or Membership row |
| Service | `not_applicable` | service writes no Organization or Membership row |
| Work | `not_applicable` | Work's transaction boundary is M2D; M2F adds no Work persistence surface |
| Lifecycle | `not_applicable` | lifecycle writes no Organization or Membership row |
| Customer Data | `not_applicable` | customer identity rows are tenant data, not control-plane membership |
| Custom-package fixture | `not_applicable` | customer packages receive neither audit-intent construction nor reconciliation authority |
| Custom-package score-disclosure fixture | `not_applicable` | it consumes `intelligence@1` as a customer-authored capability proof and never writes Organization or Membership rows |
| Marketing & Growth | `not_applicable` | documentation-only; it has no runtime mutation |

### Dual bundled v1/v2 package graphs (Production Spine v2 M3P)

Horizontal kernel capability: `selectPackageGraph` stamps package, action,
operation and capability contracts onto a cloned declaration and wraps only
the v2 execute/create seams. Each bundled package keeps its v1 factory as the
`createAccordoApp()` selection and exports an explicit v2 companion for
`createAccordoAppAsync({ selected })`. The async factory default graph stays
empty; v1 custom packages remain fail-closed on that path. Default
`accordo serve` and PostgreSQL are not this slice.
<!-- truth: spine.postgresql.implemented=absent -->

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `not_applicable` | kernel Company/Contact/Opportunity/Approval are not domain packages; they already compose on both factories |
| Pipeline | `not_applicable` | a kernel workflow capability, not a domain package |
| Lead Intelligence | `aligned` | `createIntelligenceDomain()` stays v1; `createIntelligenceDomainV2()` is the awaited graph |
| Commercial Operations | `aligned` | `createCommercialDomain()` stays v1; `createCommercialDomainV2()` is the awaited graph |
| Signature & Order | `aligned` | `createSignatureDomain()` stays v1; `createSignatureDomainV2()` is the awaited graph |
| Contract Activation | `aligned` | `createContractsDomain()` stays v1; `createContractsDomainV2()` is the awaited graph |
| Delivery | `aligned` | `createDeliveryPackage()` stays v1; `createDeliveryPackageV2()` is the awaited graph |
| Service | `aligned` | `createServicePackage()` stays v1; `createServicePackageV2()` is the awaited graph |
| Work | `aligned` | `createWorkPackage()` stays v1; `createWorkPackageV2()` is the awaited graph |
| Lifecycle | `aligned` | `createLifecyclePackage()` stays v1; `createLifecyclePackageV2()` is the awaited graph |
| Customer Data | `aligned` | `createCustomerDataPackage()` stays v1; `createCustomerDataPackageV2()` is the awaited graph |
| Custom-package fixture | `deferred` | partner-scorecard remains the customer-authored contract-1 compatibility proof; the portable path still refuses it with `PACKAGE_ASYNC_CONTRACT_REQUIRED` rather than rewriting it |
| Custom-package score-disclosure fixture | `deferred` | it remains the customer-authored capability-consumer proof on contract 1; this slice does not rewrite it |
| Marketing & Growth | `not_applicable` | documentation-only; it has no runtime package graph |

### Public storage posture, health boundary and raw-driver exit (Production Spine v2 M2 final)

This slice is horizontal kernel machinery, not a domain capability. Portable
and document-selected public surfaces project `{adapter, available}` only;
`GET /health` is process liveness and does not run request identity, doctor,
tenant services or business tables; Admin counts live on authenticated
`GET /api/admin/metrics`; `createCoreAdapters` reads through Storage Contract
v1. Dual bundled v1/v2 package graphs remain later compatibility work, not
completed. A `deferred` row means the domain still ships only its contract-1
definition and is not selected by the portable factory's default graph.

| Domain | Status | Reason |
|---|---|---|
| Core CRM (Sales) | `partial` | kernel Company/Contact/Opportunity/Approval compose through v1 HTTP health/metrics and the portable factory; generated project modules and dual-plane Spine are not the default portable graph |
| Pipeline | `not_applicable` | a kernel workflow capability; this slice does not migrate pipeline contract 1 |
| Lead Intelligence | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Commercial Operations | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Signature & Order | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Contract Activation | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Delivery | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Service | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Work | `deferred` | its capability still resolves to synchronous contract 1; this slice does not compose Work onto the portable factory |
| Lifecycle | `deferred` | it still consumes domain capability version 2 on synchronous execution contract 1; this slice does not change that |
| Customer Data | `deferred` | its contract-1 graph remains the released v1 selection; dual v1/v2 definitions remain later work |
| Custom-package fixture | `deferred` | it remains the customer-authored contract-1 compatibility proof; the public async path refuses it with `PACKAGE_ASYNC_CONTRACT_REQUIRED` rather than rewriting it |
| Custom-package score-disclosure fixture | `deferred` | it remains the customer-authored capability-consumer proof; this slice does not rewrite it |
| Marketing & Growth | `not_applicable` | documentation-only; it has no runtime health or storage-posture graph |

### Hosted Docs MCP transport assessment

The stateless Streamable HTTP transport in `packages/docs-mcp/src/http.js` is a
horizontal **documentation/distribution** surface, not a CRM runtime capability.
Its status is `not_applicable` for Pipeline, Lead Intelligence, Commercial
Operations, Signature & Order, Contract Activation and Delivery: it reads the
repository-wide public documentation corpus and claims ledger, imports no domain
package, opens no application/database and exposes no domain mutation. No legacy
domain can align to it or be backfilled into it. This explicit assessment closes
the Compatibility Backfill Rule for the transport without inventing six empty
runtime integrations.

### Repository Truth Contract assessment (ADR-039)

`scripts/repo-truth.js` and `docs/repository-truth.json` are a horizontal
**repository evidence discipline**, not a CRM runtime capability. Its status is
`not_applicable` for all six columns and for every domain outside the table: it
opens no application or durable domain database, exposes no domain mutation,
and adds nothing a domain could align to or be backfilled into. Its storage
authority imports selected Company and Work source and opens isolated in-memory
SQLite databases only to execute bounded, disposable contract probes; no probe
observes or changes application state. It otherwise reads the checked-in source
of the framework, a frozen benchmark receipt and the measured claims ledger,
and it never leaves this repository — a generated project has no claims ledger,
no JTBD matrix and no status file.

One fact *is* nearly domain-shaped and is deliberately not a row:
`domain.<name>.package_native` is generated for all nine checked-in packages
from a named **reference composition**. That is a fact *about* the packages, read
from `resolvePackageComposition`, not a capability any package implements —
adding or removing a package moves the fact with no edit to the package. This
explicit assessment closes the Compatibility Backfill Rule for the contract
without inventing six empty runtime integrations.

| Horizontal capability | Pipeline | Lead Intelligence | Commercial Ops | Signature & Order | Contract Activation | Delivery |
|---|---|---|---|---|---|---|
| **Domain package seam** (ADR-018) — `definePackage`, declared resources, one static import | `not_applicable` ¹ | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Declared cross-package capability** — reaching another domain only through a named, versioned capability | `not_applicable` ¹ | `aligned` | `aligned` — provides `commercial-quotes@1` and `commercial-quote-binding@1` | `aligned` — requires both of those | `aligned` — provides `delivery-obligations@1` | `aligned` — requires that one; provides three |
| **`packageContract: 1` conformance** — validated at startup, detach/reattach proven | `not_applicable` ¹ | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Package version discipline** — additive bumps, never a silent break | `not_applicable` ¹ | `aligned` — `intelligence@1` | `aligned` — `commercial@1` | `not_applicable` | `aligned` | `aligned` |
| **Module Evolution v1** (ADR-019) — a shipped record grows through a declared revision | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Managed records** — `writable: "managed"`, no public create, update or delete | `partial` — the stage fields are managed and CRUD cannot write them, but a stage is current state rather than append-only evidence | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Human-actor boundary** — the decision requires `actor.type === "user"` | `partial` — the boundary is in the approval workflow around a staged move, not in `move-stage` | `partial` — scoring and routing carry no user-actor requirement: they are deterministic computations from a published definition, not decisions | `aligned` — quote approval | `aligned` — requesting a signature | `aligned` — activation | `aligned` — every writing action |
| **Public refusal receipt** — optional site content renders a tested request, asserted actor and machine-readable result | `not_applicable` ³ | `not_applicable` ³ | `not_applicable` ³ | `not_applicable` ³ | `not_applicable` ³ | `not_applicable` ³ |
| **Public responsibility map** — optional site content separates exactly two layers and states the missing bridge | `not_applicable` ⁴ | `not_applicable` ⁴ | `not_applicable` ⁴ | `not_applicable` ⁴ | `not_applicable` ⁴ | `not_applicable` ⁴ |
| **Public recommendation measurement identity contract** — a URR name match resolves to this framework before entering the numerator | `not_applicable` ⁵ | `not_applicable` ⁵ | `not_applicable` ⁵ | `not_applicable` ⁵ | `not_applicable` ⁵ | `not_applicable` ⁵ |
| **Fingerprinted declared definitions** (ADR-015) — a declared version is content-addressed | `partial` — definitions are validated and drift refuses safely, but a pipeline carries no content-addressed version | `aligned` | `aligned` | `aligned` — provider definitions are fingerprinted | `aligned` | `aligned` |
| **External-operation contract** (ADR-017) — intent, provider call outside every transaction, finalize, compensate | `not_applicable` | `not_applicable` | `partial` — catalog sync predates it and uses its own fetch-then-reconcile shape | `aligned` — it is the contract's origin | `not_applicable` | `not_applicable` |
| **Money contract** (ADR-014) — integer minor units, currencies never summed, no FX | `not_applicable` | `not_applicable` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Transaction-scoped events** (ADR-012) | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Audit and trace on every write** | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Exact reads past the display bound** — `listWhere`/`countWhere` on every correctness path | `not_applicable` — `move-stage` reads one record by id and makes no collection read | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **AX1 visibility** — appears in `app inspect` as a package with resources, actions and capabilities | `partial` ¹ — its actions are reported; there is no package to report | `aligned` — discovered as a package, with no fixed slot | `aligned` — discovered as a package, with no fixed slot | `aligned` — discovered as a package, with no fixed slot | `aligned` | `aligned` |
| **AX2 citability** — a Solution Plan can cite the domain's capabilities and record revisions | `partial` ¹ | `aligned` — `intelligence@1` is citable | `aligned` — `commercial-quotes@1` is citable | `aligned` — its declared requires and operations are citable | `aligned` | `aligned` |
| **Package-scoped Admin section** — renders only while the package's schema metadata is published | `not_applicable` — the board is a core Admin feature | `not_applicable` | `partial` — the quote screens are core Admin, gated at render time on the package's published block; a package-contributed screen is still not expressible | `partial` — same shape: the quote signature section is core Admin, render-gated on the package's published block | `aligned` | `aligned` |
| **Detach/reattach proof** — removing the domain removes its whole surface and nothing else | `not_applicable` ¹ | `aligned` | `aligned` — `tests/commercial-package-absence.test.js` | `aligned` — `tests/signature-package-absence.test.js` | `aligned` | `aligned` |
| **Fault-injection and two-connection evidence** | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Migration array with per-entry checksums** — an applied migration cannot be edited | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Declared action metadata** — `fromStates`/`toState` published in the schema and in `app inspect` | `aligned` | `not_applicable` — scoring and routing are not transitions | `aligned` | `aligned` | `aligned` | `aligned` |
| **A domain Skill, mirrored in `.claude/` and `.agents/`** | `partial` — covered by `create-crm-workflow`, no pipeline-specific Skill | `partial` ² | `partial` ² | `partial` ² | `partial` ² | `partial` ² |
| **A tool namespace of its own** | `not_applicable` | `deferred` — DX13 | `deferred` — DX13 | `deferred` — DX13 | `deferred` — DX13 | `deferred` — DX13 |
| **JTBD rows with linked evidence** | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` | `aligned` |
| **Scenario evidence (DX6)** — a checked-in scenario runs a real journey and maps what it observed onto the domain's JTBD rows, with the rows it did *not* establish stated | `aligned` — JTBD-03 claimed and established | `aligned` — LI-01, LI-02, LI-04 claimed and established; LI-07 is not claimed | `aligned` — CO-01, CO-03, CO-07 | `partial` ³ | `partial` ³ | `partial` ³ |

### The domains outside the six-column table

| Domain | Where it stands |
|---|---|
| **Core CRM (Sales)** — company, contact, opportunity, lead, task, approval | `not_applicable` on every package-seam row: these are a *project's* generated records, not a domain package, and a customer's own CRM objects must never require one. `aligned` on the kernel rows (module evolution, migration checksums, managed fields where declared, events, audit and trace, exact reads, JTBD evidence). Its Skills are `create-crm-module` and `create-crm-workflow` |
| **Custom-package fixture** (`examples/custom-packages/partner-scorecard/`) | `aligned` on the package seam by construction — it exists to prove a customer-authored package attaches, works and detaches with no kernel change. It deliberately exercises only a slice: one resource, one action, no capability of its own, so the capability rows read `not_applicable` |
| **Service** | **built and merged (M15).** Package-native from its first commit: `aligned` on the package seam, declared capabilities (requires `contracts/service-obligations@1`, provides three), `packageContract: 1` conformance, package version discipline, managed records, the human-actor boundary, fingerprinted declared definitions, transaction-scoped events, audit and trace, exact reads, AX1 visibility, AX2 citability, detach proof, fault-injection and two-connection evidence, and JTBD rows with linked evidence. `not_applicable` on the money contract and the external-operation contract: it prices nothing and calls no provider. `partial` ² on the Skill mirror — the mirrors currently agree, but nothing keeps them agreeing; the same DX2 gap every domain has. `deferred` on a tool namespace: §C.2b of `AGENT_TOOL_SURFACE.md` now works one through on Service, and it stays a proposal until DX13 |
| **Marketing & Growth** | documentation only. No row can be assessed, and none is claimed |

**Scenario evidence for the domains outside the six-column table.** Core CRM
(Sales) is `aligned` — JTBD-04, JTBD-05 and JTBD-05b are claimed and established
by the `lead-to-won` scenario. The custom-package fixture is `aligned` —
JTBD-PK-01 and JTBD-PK-02. **Service is now `aligned`**: it was `deferred`
because its package composed into the journey's application while nothing
observed it, and `examples/scenarios/service-sla-escalation.scenario.json` closes
that — JTBD-DS-11 and JTBD-DS-12 are claimed and established over a **second**
journey with an injected clock, and both rows stay *partially supported* because
a run promotes nothing. Closing it needed no milestone, but it did need one code
change nobody predicted: the observation vocabulary had no way to state a
*non-numeric outcome*, which is what a support process is judged on. Marketing &
Growth is `not_applicable` — documentation only.

³ **`partial` on scenario evidence** means the shipped scenario reaches the
domain and claims part of it, not all of it. The journey drives the signature
envelope, webhook verification and reconciliation, the subscription activation,
and delivery handover — but a claim only exists where a scenario wrote one, and
DX6 publishes that as `COVERAGE_IS_CLAIMED_NOT_DISCOVERED`. Delivery execution,
economics, change and acceptance (M14a/M14b1/M14b2) are not in this journey at
all. Closing these is writing scenarios, not changing any domain.

¹ **Pipeline is not a domain.** `buildMoveStageAction` is a generic factory that
stages *any* module a project points it at — a reusable runtime capability, which
is exactly what ADR-018's core budget rule permits in `packages/core`. Extracting
it would be a mistake, not a backfill. It appears in this matrix because a reader
scanning for "everything in core" will find it, and needs to be told why it is
there.

³ **The refusal receipt is a site content contract, not a domain runtime
capability.** Pipeline, Lead Intelligence, Commercial Operations, Signature &
Order, Contract Activation and Delivery are therefore `not_applicable`; so are
Core CRM, the custom-package fixture, Service and documentation-only Marketing &
Growth. Their actual human-actor behavior remains assessed by the row immediately
above. The Smart CRM page uses Commercial's tested quote refusal as evidence, but
that does not make the renderer a capability Commercial must adopt or other domains
must backfill.

⁴ **The responsibility map is also a site content contract, not a domain runtime
capability.** Every domain is `not_applicable`, including those outside the six-column
table. The CDP + CRM page cites Lead Intelligence and the general mutation envelope as
evidence for the process layer; it does not add a CDP dependency, integration seam or
new obligation to any domain package.

⁵ **The recommendation measurement identity contract is a project-level GTM
evidence discipline, not a domain runtime capability.** Every domain is
`not_applicable`, including Core CRM, the custom-package fixture, Service and
documentation-only Marketing & Growth. It governs whether an external model response
may enter a public metric; it adds no requirement to a package, record, action, policy
or provider.

### Reading the shape rather than the cells

The rows split cleanly into two groups, and the split is the whole finding.

**Rows where every domain is `aligned`** — Module Evolution, transaction-scoped
events, audit and trace, fault-injection and two-connection evidence, JTBD
evidence. These are **kernel capabilities**: a domain gets them by existing.
They needed no backfill because there was never a version of the framework where
one domain had them and another did not. That is the argument for putting a
horizontal capability in the kernel when it honestly is one — and ADR-018's core
budget rule is the argument against doing it when it is not.

**Rows where the three older domains are `needs_extraction`** — the package seam,
declared capabilities, contract conformance, detach proof. Every one of them is
the *same* gap wearing a different name. There are not four problems here; there
is one, and extraction is its only fix. The `partial` AX1 and AX2 rows are that
same gap seen from the agent's side: an agent can cite an action of theirs, but
there is no package or capability to cite.

Everything else is `partial` or `not_applicable`, and `partial` is where an
argument is worth having — `not_applicable` rows are settled by the domain's
nature.

## Every non-aligned cell, in full

The matrix gives a status. A status without a consequence is a colour. Each
entry below states the **gap**, the **evidence** it rests on, the **pass that
closes it**, and the **compatibility risk** of closing it.

### `needs_extraction` — Lead Intelligence, Commercial Operations, Signature & Order

> **Update:** all three domains have since been extracted — Signature & Order
> last, on the ADR-032 operations seam. The entry below is kept as the record
> of the gap it described; it applies to no domain today.

Four rows, one gap: the package seam, declared capabilities, `packageContract`
conformance, and the detach proof.

- **Gap.** The domain's runtime lives in `packages/core/src/`, so it declares no
  package, owns no resources through a package, publishes no capability and
  cannot be detached.
- **Evidence.** `packages/{intelligence,commercial,signature}/` contain only
  `generated/`; the runtime is `packages/core/src/{intelligence,commercial,signature}-*.js`.
  `app inspect` on a composed project lists their actions and modules and **no
  package entry** for them.
- **Pass that closes it.** The controlled Legacy Domain Alignment Pass, after
  M15 and after DX4 makes conformance mechanical. One domain, one PR.
- **Compatibility risk.** **High, and it is data risk, not code risk.** These
  domains own scoring runs, quote versions, signed orders and provider
  definitions whose fingerprints are checked at startup. A move must preserve
  every source key, every stored fingerprint and every historical decision
  byte-for-byte. The acceptance criterion is behavior preservation proved from
  outside — a "cleaner" extraction that changes one recorded outcome has failed.

### `partial` — AX1 visibility and AX2 citability, same three domains

- **Gap.** An agent can cite an action or a record revision, but there is no
  package version or capability to cite, so a Solution Plan cannot bind to them
  the way it binds to `delivery@4`.
- **Evidence.** `packages: []` for them in `app inspect`; the AX2 example plan
  can only pin `contracts` and `delivery`.
- **Pass.** Closes automatically with extraction — it is the same gap seen from
  the agent's side, not separate work.
- **Compatibility risk.** Low on its own; it inherits the extraction's risk.

### `partial` ² — the Skill mirrors: the state is clean, the mechanism is not

**Re-measured against the current tree, because the earlier entry was stale.**
It said the domain build Skills existed under `.claude/skills/` only and that
`.agents/skills/` carried none of them. That was true when it was written and is
**no longer true**: the agent-discovery work merged to main copied the mirrors
across.

- **Measured now.** `.claude/skills/` and `.agents/skills/` each carry **12**
  skills, with **none** on one side only. `accordo project doctor` reports
  `skills.mirror-coverage` **passing** and `skills.mirror-drift` **passing**,
  and the whole report is `passed`.
- **So why is this still `partial`?** Because the row is about a *capability
  used as the contract intends*, and the contract needs the mirrors to **stay**
  in agreement. Nothing keeps them there. There is no canonical source, no
  `sync`, no CI drift gate and no adapter generation — Project Doctor *detects*
  disagreement and, by design, never writes. The debt was paid down **by hand,
  in state**; the **mechanism** is still missing, and the next skill added to
  one side re-opens it silently until somebody runs the doctor.
- **Evidence.** `ls .claude/skills/` versus `ls .agents/skills/`;
  `accordo project doctor --json` → `skills.mirror-coverage`, `skills.mirror-drift`.
- **Pass.** **DX2** (`crm agent skills sync|check`) — unchanged, and now the
  *only* thing missing rather than one of two.
- **Compatibility risk.** **None.** Additive files; no runtime reads them.

This is the distinction the matrix exists to keep: a green check today is not an
aligned capability. Marking this row `aligned` on the strength of a clean `ls`
is exactly the drift-by-silence the document was written to prevent.

### `partial` — Commercial Operations against the external-operation contract

- **Gap.** Catalog sync predates ADR-017 and uses its own
  fetch-outside-the-transaction then reconcile-inside-one shape rather than the
  intent / call / finalize / compensate contract Signature established.
- **Evidence.** `packages/core/src/catalog-sync.js` versus
  `packages/core/src/external-operation.js`.
- **Pass.** Deferred, with no milestone named — and deliberately so. Catalog sync
  is idempotent by DB-unique source keys and has its own tests; rewriting a
  working external boundary to match a later contract is a change with real risk
  and no user-visible benefit.
- **Compatibility risk.** **Medium.** It touches a provider boundary and a
  reconciliation path that customers' catalogs depend on.

### `partial` — the Admin sections of Commercial Operations and Signature & Order

- **Gap.** Their screens are core Admin, not gated on package metadata, so they
  do not disappear when a package does.
- **Evidence.** `apps/admin/public/admin-quotes.js` and `admin-signature.js`
  render unconditionally; `admin-delivery-change.js` returns early without
  `schema.domains.delivery.changeAcceptance`.
- **Pass.** Follows extraction; there is nothing to gate on until a package
  publishes metadata.
- **Compatibility risk.** Low.

### `partial` — Pipeline's managed records, human boundary and fingerprints

- **Gap.** A stage is current state rather than append-only evidence; the human
  boundary lives in the approval workflow around a staged move rather than in
  `move-stage`; a pipeline definition is validated but carries no
  content-addressed version.
- **Evidence.** `packages/core/src/pipeline-actions.js` and
  `pipeline-registry.js`; the human check is in
  `packages/workflows/src/decide-opportunity-approval.js`.
- **Pass.** **None planned, and none needed.** These are properties of a generic
  staging mechanism, not gaps in a domain. Recording them stops a future reader
  concluding Pipeline was overlooked.
- **Compatibility risk.** Not applicable.

### `deferred` — a tool namespace, every domain

- **Gap.** No domain has an MCP namespace; the shipped MCP server exposes a
  sample domain that predates AX1 and AX2.
- **Evidence.** `docs/MCP.md`; `docs/architecture/AGENT_TOOL_SURFACE.md` §B.3.
- **Pass.** **DX13**, and only after the exposure policy in that document is a
  decision rather than a proposal.
- **Compatibility risk.** Low — additive — but it is the row most likely to be
  closed badly. §C.0 exists to stop "one tool per package" being the answer.

## The Compatibility Backfill Rule

> When a PR introduces or changes a **horizontal** capability — one that every
> domain could use — it must, in that same PR, record every existing domain's
> status against it in this matrix, using the vocabulary above, with a one-line
> reason. A `deferred` status must name the milestone that closes it.
>
> **Declaring the gap is mandatory. Closing it in the same PR is not.**
> Retrofitting five domains inside a feature PR is how a feature PR stops being
> reviewable. But a capability that only the newest domain has, and that nobody
> wrote down, is a fork rather than a platform.

Five questions, answered in the PR body:

```text
Which old domains does this touch?
Which are already aligned?
Which need metadata only?
Which need a code backfill?
Was the Legacy Alignment Matrix updated?
```

The distinction between the third and fourth is the useful one. A metadata gap —
a manifest flag, a published field, a Skill file — is cheap and can often be
closed immediately. A code backfill is a change to a domain's runtime, and for a
`needs_extraction` domain it is not closeable at all until that domain moves. A
PR that cannot tell the two apart has not looked.

Three practical consequences:

1. The row is written by the PR that creates the capability, not by whoever
   later notices the gap.
2. `needs_extraction` is an acceptable answer. It is not an admission of failure;
   it is the honest name for a structural blocker.
3. A reviewer may reject a PR for a missing row the same way they reject a
   missing test — and `docs/QUALITY_GATES.md` §1 now says so.

## The M2D transaction-proof backfill answer, as the rule requires

Production Spine v2 M2D exports a **horizontal** kernel capability from
`packages/core/index.js`: `proveCallerTransaction` and `TRANSACTION_PROOF` — a
way to prove that a set of writes will land on **one** storage handle inside an
outer transaction the caller owns, without the domain holding the SQLite driver.

The rule says every existing domain gets a row. The honest answer for most of
them is `not_applicable`, and the reason is worth stating precisely rather than
waving at: a domain needs this primitive only where it writes a set of rows that
must commit together **through an entry point whose runtime context the caller
supplies** — a declared capability, or a function a host action imports. A domain
that writes such a set only inside its own action's `execute` cannot reach the
failure, because `runRecordAction` opens the transaction for it
(`packages/core/src/action-runtime.js`).

| Question | Answer |
|---|---|
| Which old domains does this touch? | Potentially all of them; in practice only the four capability entry points that write. There are exactly four write-capable capabilities in the repository, and before M2D one of them checked its transactional context while three made the same promise in their doc comments with nothing checking it |
| Which are already aligned? | **Work** and **Contract Activation** — both migrated in this PR, which is the whole of the milestone |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None, and that is the finding.** Every remaining domain either offers no writing capability at all, or writes its sets only inside its own action envelope. Giving those a check that can never fire would add a refusal path nobody can reach and a claim nobody can test |
| Which were measured rather than reasoned about? | The three unchecked ones. Each was run outside a transaction and each committed a partial write; the probes are in `docs/plans/spine-v2-m2d-transaction-context.md` §2 and are checked-in regressions |
| Was the matrix updated? | Yes — this section, and the Work row of the storage-contract assessment above |

| Domain | Status | Reason |
|---|---|---|
| Work | `aligned` | `createFollowUp` proves before the first write, and `complete`/`cancel` prove the same task+activity pair even though the action envelope makes it unreachable for them |
| Contract Activation | `aligned` | all three of its writing capabilities prove before their first write — `delivery-obligations@1`, `service-obligations@1` and `contracts-successor-activation@1`. Each was measured committing a partial write outside a transaction before this change |
| Core CRM (Sales) | `not_applicable` | its multi-row writes (conversion, approval, stage change) run inside `runRecordAction` or open their own transaction; it offers no capability and exports no writer a caller can invoke with its own context |
| Pipeline | `not_applicable` | a stage move is one managed write inside an action; there is no set to hold together |
| Lead Intelligence | `not_applicable` | `intelligence@1` is read-only over declared definitions and reaches no record; enrich, score and route write inside the action envelope |
| Commercial Operations | `not_applicable` | `commercial-quotes@1`/`@2` are read-only, and `commercial-quote-binding@1` deliberately returns frozen *data* describing a write path rather than performing one. Catalog sync opens its own transaction, so it is not a consumer |
| Signature & Order | `not_applicable` | `signature-orders@1` is read-only; its application operations run through the injected `runExternal` sequencer, which opens a transaction per phase |
| Delivery | `not_applicable` | it writes large sets — project, work packages, milestones, partner engagement — but only inside its own action's `execute`, and all three capabilities it offers are read-only. It is a *consumer* of `contracts/delivery-obligations@1`, not a provider of a writing one |
| Service | `not_applicable` | same shape: coverage and entitlements are written inside its own action, and all three capabilities it offers are read-only |
| Lifecycle | `not_applicable` | it declares `capabilities: []` and offers none. It consumes `work/follow-up@1` and `contracts-successor-activation@1`, both of which now prove on its behalf |
| Customer Data | `not_applicable` | `customer-identity@1` is read-only; its import operation opens its own transaction |
| Custom-package fixture | `not_applicable` | one action, one managed write, and no capability of its own — it exercises the package seam, not a write set |
| Marketing & Growth | `not_applicable` | documentation-only; it has no runtime persistence consumer |

**What would move a `not_applicable` row.** Not a refactor, and not effort: a
domain changes status the moment it offers a **capability that writes more than
one row**, or exports a writer a host action imports directly. That is the test,
and it is the same test the consumer search used — `PackageRegistry.capability()`
hands the *caller's* context to `create()`, so a writing capability cannot assume
its caller opened anything.

### What M2D deliberately did not close

- **Nothing about transaction ownership.** An earlier cut of this milestone
  proved only that a transaction was open on the connection, and recorded the
  gap as a limitation. It is now closed: the witness is published into the async
  context that opened the transaction, a flow that did not open one is refused
  `NOT_TRANSACTION_OWNER`, and the mint that could forge ownership is taken once
  by the kernel at module load rather than guarded by import analysis. What
  remains open belongs to pooled connections and is an obligation on that
  milestone (`DECISIONS.md`, ADR-018 addendum 8).
- **No domain's persistence is migrated.** M2D is a transaction-context slice.
  Every `deferred` row in the storage-contract assessment above stays exactly
  where it was.
- **No domain is given a check it cannot fail.** The eleven `not_applicable`
  rows are not a backlog. Adding the proof to a write set that only ever runs
  inside an action envelope would be a refusal path with no reachable caller —
  the silent backfill this matrix exists to prevent, wearing a safety label.

## The Work v1 backfill answer, as the rule requires

Work v1 (ADR-030) introduces a **horizontal** capability: `work/follow-up@1`, a
shared Task and Activity model any domain could consume, plus the *opaque subject
envelope* those records carry. Every domain could open a follow-up, so every
domain gets a row — and the honest answer for most of them is that they should
not.

| Question | Answer |
|---|---|
| Which old domains does this touch? | Potentially all of them. In practice three business events actually imply human work today: Lead qualification (host), Lifecycle's commercial follow-up, Service escalation. |
| Which are already aligned? | **Core CRM (Lead)** through the host path, **Lifecycle** and **Service** through the declared capability — all three opt in explicitly |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None, and that is the finding.** A domain does not become non-conforming by *not* opening a task. Creating a follow-up where the business event does not imply human work would be worse than the gap: it would put rows in somebody's queue that nobody asked for. Contract Activation, Delivery, Commercial Ops, Signature & Order, Pipeline and Lead Intelligence are `not_applicable` for exactly that reason, each stated below |
| Was the matrix updated? | Yes — the two rows below, this section, and the three domains outside the six-column table |

| Horizontal capability | Pipeline | Lead Intelligence | Commercial Ops | Signature & Order | Contract Activation | Delivery |
|---|---|---|---|---|---|---|
| **Shared follow-up capability** (`work/follow-up@1`) — human work arising from a business event is one model, not a table per domain | `not_applicable` — a stage move is state, not an ask of a person; the board is where the work is seen | `not_applicable` — scoring and routing are deterministic computations, and routing a lead to a target is not a task somebody accepted | `not_applicable` — a quote approval is already a governed human decision with its own record; a task beside it would be a second queue for one ask | `not_applicable` — a signature request is an *external* party's action, not internal work, and a provider event is not a person | `partial` — activation raises pending delivery and service obligations, which are the domain's own explicit handoff records. A follow-up task on an unhandled obligation is a plausible future consumer and is deliberately **not** built here | `deferred` — M14b2's `delivery-commercial-change` already hands off through Lifecycle, which now opens the task. Consuming the capability a second time from Delivery would create two tasks for one human ask; revisit with M16b |
| **Opaque subject envelope** — a record referenced across a seam carries resource, id, owner and provenance rather than a typed foreign key | `not_applicable` — no cross-domain reference | `aligned` by construction — Intelligence acts on the host `lead` and claims no ownership of it | `not_applicable` | `not_applicable` | `partial` — `contract-activation` stores typed ids to records it owns, which is correct; the envelope applies only where the target table varies | `partial` — same reason: `deliveryProjectId` and friends are typed and correct within one package |

### The three domains outside the six-column table

| Domain | Status against Work v1 |
|---|---|
| **Core CRM (Sales) / Lead** | `aligned` — `lead.qualify` opens exactly one follow-up with a host-owned subject, through the exported creator rather than the capability, because `PackageRegistry.capability({ consumer })` resolves against *registered packages* and a host action is not one. Published as `HOST_ACTIONS_CANNOT_DECLARE_CAPABILITIES`; it is the same code, not a second path |
| **Service** | `aligned` — `record-escalation` opens one task through `work/follow-up@1` when composed with `followUp: true`. **`support-case-activity` stays domain-specific and is not migrated.** It is a support-case-scoped log with its own visibility model, its own types (`customer_reply`, `internal_note`, `transition`) and its own sequence; folding it into Work's four-entry vocabulary would either lose those distinctions or force Work's vocabulary open, and an open vocabulary is not a curated timeline. Two timelines that mean different things are honest; one that means both is not |
| **Lifecycle** | `aligned` — `request-commercial-followup` opens one task through the capability when composed with `followUp: true`. The subject is package-owned and the envelope says so |
| **Custom-package fixture** (`partner-scorecard`) | `not_applicable` — it rates a partner from a policy. Nothing about a rating is an ask of a person, and adding one to demonstrate the seam would be a fixture pretending to be a business |
| **Marketing & Growth** | `not_applicable` — **task and journey work remains unimplemented.** `MARKETING_GROWTH_OPERATIONS.md` and `CAMPAIGNS_JOURNEYS.md` plan campaign tasks and durable journey steps; none of it exists, MK4 is hard-blocked on `JOBS_AND_OUTBOX.md`, and a journey step is a *scheduled* thing, which Work v1 explicitly is not. No Marketing row can be assessed and none is claimed |

### Compatibility Backfill — declared application operations (ADR-032 seam)

Landed by the Signature extraction PR, which is the PR the rule binds: the
`operations` contract, the generic operation runtime and the generic alias
attachment are horizontal, so every domain's status is recorded here.

| Question | Answer |
|---|---|
| What is the capability? | a package declares bounded application-scoped operations (`operations: [{operationContract: 1, name, appMethod?, input?, create(runtime)}]`); the composition validates them, builds ONE bounded runtime context (`database`, `modules`, buffered `events`, bounded `config`, injected `runExternal`, bounded `trace`) and attaches declared aliases generically, refusing collisions and shadowing |
| Which old domains does this touch? | **Commercial Operations** — `aligned`: `sync-catalog` (`appMethod: syncCatalog`, run name `catalog.sync` grandfathered) replaced the named create-app lookup, LA0-Commercial replaying with zero asserted observations moved. **Signature & Order** — `aligned`: `ingest-signature-event` and `reconcile-signature` compose through it, closing the private `runExternalOperation` gap the injected-context way ADR-032 chose |
| Which are `not_applicable`, and why | **Pipeline, Lead Intelligence, Contract Activation, Delivery, Service, Work, Lifecycle**: every application-scoped behaviour each of them has is a record action addressed by a CRM record id — none owns a provider-addressed operation, so declaring one would invent surface. The webhook route is deliberately NOT this seam (ADR-032's four measured properties); no other domain accepts outside bytes |
| Which need a code backfill? | **None.** Both real consumers landed with the seam; a third consumer declares its own operation when it measures one |

### What Work v1 deliberately did not close

- **Delivery history is not unified.** Delivery's change requests, plan
  revisions, deliverables and acceptance evidence remain its own records with
  their own semantics. Work v1 adds no cross-domain reader and no aggregation:
  `JTBD-DO-08` is *partially supported* for a **subject** timeline, and the row
  says in the same breath that it is not unified.
- **No existing domain-specific activity record is migrated.** Service's
  `support-case-activity` is the named case; the rule is general.
- **Nothing is scheduled.** The `deferred` cell above is about a *consumer*, not
  about a timer. There is no scheduler in this repository and Work v1 does not
  bring one.

## The Commercial-extraction backfill answer, as the rule requires

The Commercial Operations extraction changes one **horizontal** surface: the
public kernel gains `writeTrace` and `normalizeError`
(`packages/core/index.js`), because a package-owned, provider-backed operation
that runs outside the action runtime (catalog sync) must persist the same
trace and failure shapes every run surface reads, and `packages/core/src/*` is
private. The neutral money bounds every package already imported
(`requireAmount`, `requireQuantity`, `requireBps` and the charge/pricing
vocabulary) moved from `commercial-money.js` into a neutral
`packages/core/src/money.js` with the public re-export unchanged in name and
behaviour — the `definition-fingerprint.js`/`timeout.js` judgement applied
again.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **Commercial Operations** (extracted) and, prospectively, **Signature & Order**: its `ingestSignatureEvent`/`reconcileSignature` operations are the measured second consumer of `writeTrace`/`normalizeError` when that domain extracts |
| Which are already aligned? | Commercial — it is the consumer the exports were added for. Contracts, Delivery, Service, Work, Lifecycle and Intelligence run their writes through the action runtime, which traces for them: `not_applicable` |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None.** No existing domain re-implements the trace row today |
| Was the matrix updated? | Yes — this section, the Commercial cells above, and the characterization coverage table |

## The M16a hardening backfill answer, as the rule requires

The M16a post-merge hardening introduced one horizontal change: a **shared
calendar-date authority** in `packages/core/src/validation.js`
(`isCalendarDate`, `requireCalendarDate`, `calendarDaysBetween`). A calendar
date is a different kind of fact from an instant, `Date.parse` alone accepts
days that never existed, and the round-trip rule that refuses them had been
independently re-implemented in **four** packages. A validator carries no domain
vocabulary and is a runtime primitive, which is the ADR-018 test for what core
may own.

| Question | Answer |
|---|---|
| Which old domains does this touch? | Every domain that stores a `YYYY-MM-DD` value: **Contract Activation**, **Delivery**, **Service** and **Lifecycle**. Pipeline, Lead Intelligence, Commercial Ops and Signature & Order store no calendar date and are `not_applicable` |
| Which are already aligned? | **Contract Activation** and **Lifecycle** — both now delegate to the core authority; `packages/contracts/src/dates.js` re-exports it so M12's public surface is unchanged |
| Which need metadata only? | **None** |
| Which need a code backfill? | **Delivery** (`packages/delivery/src/dates.js`) and **Service** (`calendarDate` in `packages/service/src/service-actions.js`) keep their own copies of the identical round-trip rule. They are `partial`: the rule they apply is the same rule and no behaviour differs today, but it is a second and third implementation of it. Declared here, not closed here — extraction and consolidation of a legacy implementation is sequenced work, not something a defect-fix PR does on the way past |
| Was the matrix updated? | Yes — the row below, and this section |

| Horizontal capability | Pipeline | Lead Intelligence | Commercial Ops | Signature & Order | Contract Activation | Delivery |
|---|---|---|---|---|---|---|
| **Shared calendar-date authority** — one round-trip validator for `YYYY-MM-DD`, refusing days that never existed | `not_applicable` — stores no calendar date | `not_applicable` — same | `not_applicable` — same | `not_applicable` — same | `aligned` — delegates to `packages/core` and re-exports it | `partial` — keeps an identical private copy in `src/dates.js` |

Service is `partial` for the same reason as Delivery; Lifecycle is `aligned`.

## The M15 backfill answer, as the rule requires

M15 introduced one horizontal change: a **second capability on an existing
package**, `contracts/service-obligations@1`, and with it the first evolution of
a shipped M12 record (`service-obligation` → revision 2, gaining `coverageRef`
and `activatedAt` and an `activated` status).

| Question | Answer |
|---|---|
| Which old domains does this touch? | **Contracts only.** It gains a capability and a record revision; nothing else in the repository changed shape |
| Which are already aligned? | Contracts is `aligned` on every seam row and stays so: the capability is additive, `delivery-obligations@1` is byte-identical, and `packageContract: 1` did not move |
| Which need metadata only? | **None.** No other domain gained a concept it must now declare |
| Which need a code backfill? | **None.** Service is a new package and owns its own surface; the three `needs_extraction` domains are untouched and no closer to extraction than before |
| Was the matrix updated? | Yes — the Service row above, and this section |

The honest note: M15 is *not* evidence that the seam is finished. It is the
third package and the second consumer, and what it showed the seam still cannot
express is the input to step 3 of the sequencing below.

## The DX4 backfill answer, as the rule requires

DX4 (`crm package test`) is a **horizontal capability**: it applies to every
package, including the three domains that are not packages yet.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **None at runtime.** DX4 adds a CLI command and moves three pieces of shared CLI logic into their own modules. No kernel behaviour changes, no domain is refactored |
| Which are already aligned? | The three first-party packages — Contracts, Delivery, Service — pass `crm package test` mechanically, which is stronger than the prose "aligned" that preceded it. The custom-package fixture **does not**: it acts on a record `delivery` owns without declaring `delivery`, and no capability of `delivery` expresses that. A real seam gap, reported rather than rescued |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None today.** The three `needs_extraction` domains cannot be run through DX4 at all: they are not packages, so there is nothing for it to compose. That is not a new gap — it is the same gap, now measurable |
| What changed for extraction? | DX4 is the gate the extraction pilot was waiting for. An extracted domain is a package, and a package that cannot pass `crm package test` has not been extracted, only moved |
| Matrix updated? | Yes — this section, the conformance row below and the revised extraction gate |

One row of the matrix changes meaning rather than status: **"JTBD rows with
linked evidence"** and the package-seam rows were previously argued from prose
and per-package suites. For the four packages they are now argued from a
mechanical run whose output is a stable document. The three legacy domains stay
exactly where they were.

### `service` had no conformance coverage until now

`assertPackageConforms` was called three times — for `contracts`, `delivery` and
`partner-scorecard`. The newest package, the one M15 built and the one this
matrix cites as validating the seam, had **none**. Anything this document said
about "every package conforms" was untrue of `service` at the moment it was
written. DX4's official matrix covers all four, and its suite fails if a package
is added without being listed.

## The DX3 backfill answer, as the rule requires

DX3 (`crm package scaffold`) is a **horizontal capability** in the same sense
DX4 is: it applies to every package that could exist, including the three
domains that are not packages yet.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **None, at runtime or on disk.** DX3 adds one CLI command and one test file. It changes no kernel behaviour, refactors no domain, and its own output is written only where a caller points it |
| Which are already aligned? | Not the right question for this capability. DX3 produces *new* packages; the four existing ones were written before it and none is regenerated. What is aligned is the **shape**: scaffolded output passes the same `crm package test` matrix the four packages are held to, so DX4's contract is now the default starting point rather than something an author has to remember |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None.** The three `needs_extraction` domains cannot be scaffolded any more than they can be conformance-tested — they are not packages. DX3 does not change that, and a scaffold is explicitly *not* an extraction tool: it writes an empty package, never a migration of an existing one |
| What changed for extraction? | The pilot gains a starting point but no permission. An extraction now begins `crm package scaffold lead-intelligence --apply` and proceeds by moving code into it, with `crm package test` as the gate. Every precondition recorded below is unchanged and still unproved |
| Matrix updated? | Yes — this section and the re-evaluated ordering below |

### What DX3 deliberately did not close

- **No domain semantics.** The scaffold generates no record, action, policy,
  capability, provider, Admin section, Solution Plan or MCP tool. That is a
  decision, not an omission: a generated field is a claim about a business
  nobody described, and an agent reads generated code as a decision already
  taken.
- **No composition.** `packages/domains/generated/index.js` is still edited by
  hand. Automating it would remove the one deliberate human act in the
  package-installation path.
- **No migration, no database, no install, no publish, no registry.**
- **No HTTP-route contribution.** Still the open seam DX4 identified, still a
  precondition for Commercial and Signature specifically, and still untouched.

## The DX1 backfill answer, as the rule requires

DX1 (`accordo project doctor`) is a **horizontal capability**: it applies to every
project built on this framework, and to every domain in one.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **None at runtime.** DX1 adds one CLI command, two CLI modules and a test file. It changes no kernel behaviour, refactors no domain, mutates nothing and executes no project source in its own process |
| Which are already aligned? | All of them, in the only sense the command measures: it reports composition, package-boundary, module-state, plan, Skill, docs-link and hygiene health for whatever the project contains, and the three `needs_extraction` domains are ordinary kernel source to it. Its first run on this repository is **0 failures** with three real warnings — two stale Solution Plans and six one-sided Skill mirrors |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None.** The doctor asks existing authorities; it introduces no rule any domain must now satisfy |
| What changed for extraction? | It becomes a precondition of the *process* rather than of the seam: an extraction should start from a project whose coherence is machine-checked, and should be re-checked after. It does not remove any of the four open blockers |
| Matrix updated? | Yes — this section, and the extraction gate now maintained in `EXTRACTION_PREPARATION.md` |

### What DX1 measured that this matrix had only asserted

Two rows of this document were prose until now and are now mechanical:

- **the Skill mirrors.** This matrix records `partial` because six domain build
  skills exist under `.claude/` only. `accordo project doctor` reports that as
  `skills.mirror-coverage: warning` with the six named, and would report a
  **failure** if two mirrors of one skill ever disagreed in content. DX2 still
  owns the fix; the gap is now observed on every run rather than remembered.
- **Solution Plan currency.** Two of the three checked-in plans no longer bind to
  the current composition. That was true before this PR — verified identical on
  `main@5da5205` — and nothing reported it. It is now `plans.*: warning`.

### What DX1 deliberately did not close

- **No mutation, no `--fix`.** Every finding names the existing command that
  would fix it.
- **No domain behaviour, no database, no provider health, no production
  readiness.** All named limitations in the report itself.
- **No package conformance run.** `PACKAGE_CONFORMANCE_NOT_RUN` points at
  `crm package test`.
- **No generated-source drift beyond what a generator contract proves.** A
  fuzzy comparison that cries wolf is a check people silence.

## The Project Bootstrap answer: **not horizontal**, and why that is the finding

`create-accordo` (`packages/create-accordo`, `projectBootstrapContract: 1`) is
recorded here **because the rule's failure mode is silence.** An unrecorded "not
horizontal" is indistinguishable from a forgotten one, so the judgement is
written down where somebody can disagree with it in one place rather than
reconstruct it from the diff.

**The judgement: it is not a horizontal capability, and no domain row exists for
it.** The rule's test is *"one every domain could use"*. This sits one level
**above** domains: it creates the container a domain lives in. It composes none
of them — the generated `packages/domains/generated/index.js` is the empty one
this repository ships — and it introduces no contract, check or discipline that
a domain is measured against. The question a matrix row would have to answer,
*"is Commercial Operations aligned with project bootstrap?"*, has no meaning in
the way *"is it aligned with the package seam?"* does.

Contrast the three that **did** declare a horizontal answer, each for a reason
this one lacks: DX4 introduced a conformance contract every package is held to;
DX3 made the shape every new package starts from; DX1 introduced findings graded
against every project. This introduces a way to *obtain* a project, and then gets
out of the way.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **None, at runtime or on disk.** It adds one package, one test file and documentation. It changes no kernel behaviour, refactors no domain, executes no project source, opens no database and mutates nothing outside a caller-chosen empty directory |
| Which are already aligned? | Not a question this capability asks. Every domain's source is copied into a generated project as inert files; none of them is composed, so none is graded |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None** |
| What changed for extraction? | **Nothing.** Every precondition in `EXTRACTION_PREPARATION.md` is unchanged and still unproved. A bootstrap produces empty projects; it moves no domain out of `packages/core` and it is not an extraction tool |
| Matrix updated? | Yes — this section, recording the decision rather than a row |

### What it deliberately did not close

- **No domain composition.** A project that arrived carrying somebody else's
  Lead model is the DX3 "rich template" mistake at project scale, and it is
  refused for the same reason: a generated domain is a claim about a business
  nobody described.
- **No upgrade path.** The framework is vendored, so a generated project
  upgrades by merging rather than by bumping a version. Closing that needs a
  published, versioned framework package — a human decision, not a code gap.
- **No publication.** The npm names remain empty reservations. The source
  scaffolds; the registry does not.

## The DX6 backfill answer, as the rule requires

DX6 (`accordo scenario run`) is a **horizontal capability**: business-scenario
evidence is something every domain could have, and this matrix already carries a
"JTBD rows with linked evidence" row that DX6 turns from prose into a report.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **None at runtime.** DX6 adds one CLI command, three CLI modules, one checked-in scenario document and two test files. It changes no kernel behaviour, refactors no domain, and writes nothing into the project it reports on — the journey composes its application in a temporary directory outside the repository, which is removed afterwards. The one change outside the CLI is that `EXECUTABLE_SHAPES` is now **exported** from `packages/core/src/solution-plan.js`, so the scenario contract refuses commands from the same constant rather than a second copy. No behaviour changed |
| Which are already aligned? | Pipeline, Lead Intelligence and Commercial Operations, plus Core CRM and the custom-package fixture outside the table: the shipped scenario claims and establishes their headline rows |
| Which need metadata only? | **None.** A domain gets scenario evidence by a scenario claiming it — a checked-in JSON document, no code |
| Which need a code backfill? | **None.** A *new journey* would need a registry entry in `packages/cli/src/scenario-journey.js`, deliberately: that boundary is what keeps a document from naming something to run |
| What is `partial`, and why | Signature & Order, Contract Activation and Delivery: the journey drives more of each than any claim cites. DX6 cannot discover coverage — it checks what a scenario claims, and says so as `COVERAGE_IS_CLAIMED_NOT_DISCOVERED` |
| What is `deferred`, and closed by what | **Service.** Its package composes into the journey's application but nothing observes it. Closed by writing a service scenario; no milestone is required |
| What changed for extraction? | Nothing. DX6 measures jobs, not seams. It is neutral on the three `needs_extraction` domains and adds no blocker |
| Matrix updated? | Yes — the row above, footnote ³, the note under the outside-the-table domains, and this section |

### What DX6 deliberately did not close

- **It promotes no JTBD row.** `docs/QUALITY_GATES.md` §3 keeps that with a
  person, on merged tests. DX6 reports evidence, publishes
  `SCENARIO_IS_NOT_PROMOTION`, and opens `jobs.json` and the matrix read-only.
- **It discovers no coverage.** A row a journey exercises but no scenario claims
  is reported as **not established**, exactly like a row nothing touched.
- **It drives no browser**, so nothing here is evidence about the Admin as a user
  sees it — the same `BROWSER_EVIDENCE_NOT_AUTOMATED` gap DX5 publishes.
- **It speaks for one composition only** (`EVIDENCE_IS_ONE_COMPOSITION`). **Two**
  journeys and two scenarios ship today, over two genuinely different
  compositions — six packages and two — which is what makes that limitation
  demonstrated rather than merely stated.

### The second-consumer backfill answer

A follow-up made the same horizontal capability serve a second, deliberately
unlike consumer (`docs/plans/dx6-second-scenario.md`). The rule applies again.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **None at runtime.** It adds one checked-in journey under `examples/journeys/`, one scenario document, one observation kind, one registry field for the clock and one for journey-scoped limitations. No kernel behaviour, no domain source and no manifest changed — the service journey drives the Service package's existing public actions exactly as `docs/SERVICE_OPERATIONS.md` describes them |
| Which are already aligned? | Service moves `deferred` → `aligned`. Contract Activation stays `partial`: the service journey activates a contract on its way to a service obligation, but claims nothing about the activation itself — that claim belongs to `lead-to-won` |
| Which need metadata only? | **None** |
| Which need a code backfill? | **The scenario contract itself did**, which is the finding. `journey.count` could not express "the SLA said `breached`", so `journey.fact` was added; the report could not say which clock produced a time-dependent answer, so `journey.clock` was added; and one global limitations list was half false of whichever run you read, so limitations gained a `scope`. Domains needed nothing |
| What is `deferred` now, and closed by what | **Lifecycle (M16a)** and **Delivery execution, economics, change and acceptance (M14a/M14b1/M14b2)**: real runtimes that no scenario claims. Closed by writing scenarios; neither needs a code change unless it needs a clock. **Marketing, Analytics and Communications stay `not_applicable`** — they have no runtime, so no scenario can honestly claim their rows |
| What changed for extraction? | Nothing |
| Matrix updated? | Yes — the Service row above, and this section |

## The DX10 backfill answer, as the rule requires

DX10 (`accordo solution verify`) is a **read-only agent surface over authorities that
already decide**, not a capability a domain implements. The rule still applies,
and the answer is the finding: **there is no per-domain status to record**, so
the gap is declared rather than assumed.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **None, at runtime or in source.** DX10 adds one CLI command, one core contract module, two checked-in evidence documents and two test files. It changes no kernel behaviour, refactors no domain, adds no capability, and writes nothing anywhere — it has no write mode, no `--fix` and no generation mode. Two changes sit outside its own files, both additive: `planRequirements()` in `packages/core/src/solution-plan.js` derives requirement identity **without touching `solutionPlanContract: 1`** — no field, no rule, and not one byte of any plan's fingerprint — and `worktreeState`/`sampled`/`defaultGit` are now **exported** from `packages/cli/src/project-verify-command.js` so the dirty-state semantics are imported rather than copied. No behaviour changed |
| Is it horizontal? | **No, and that is the row.** A domain does not "support DX10" or fail to. What a domain can have is a *plan* with an evidence document beside it, and that is a checked-in JSON file per plan, not a per-domain capability. The matrix would carry the same value in every cell |
| Which are already aligned? | Not applicable. The two shipped consumers are **plans**, not domains: `lead-to-won` (declared current, bound to this project) and `activate-support-and-manage-cases` (bound through the service scenario, which composes the application it was written against) |
| Which need metadata only? | **None.** A plan gets requirement ids for free the moment DX10 ships — derived, no migration, no rewrite of any historical plan |
| Which need a code backfill? | **None.** A new *evidence kind* would need one, deliberately: that boundary is what keeps a document from naming a new thing to trust |
| What is `deferred`, and closed by what | Nothing per domain. What is genuinely open is **plan coverage**, and after REVIEW-71 it is wider than first recorded — see the inventory below. Closed by scenarios that compose the applications those plans were written against; no code change is needed unless one of them needs a clock |
| What changed for extraction? | Nothing. DX10 measures plans, not seams. It is neutral on the three `needs_extraction` domains and adds no blocker |
| Matrix updated? | Yes — this section, which records that the capability is not horizontal and why |

### The evidence inventory — which checked-in plan has a behavioural authority

Recorded per plan rather than per domain, because a plan is DX10's unit. The
third column is the one that matters: a plan whose application no shipped
scenario composes has **no behavioural authority available to it at all**, and
under `EVIDENCE_COMPOSITION_MISMATCH` (ADR-031 addendum 1) a run of a different
application is not a substitute.

| Plan | Evidence document | A scenario composes its application? | Status |
|---|---|---|---|
| `activate-support-and-manage-cases` | yes | **yes** — `scenario:service-sla-escalation` publishes composition `b038c158…`, exactly the digest the plan pins | `partial` — 6 verified, 4 partial, exit 1 |
| `lead-to-won` | yes | **no.** It binds to the repository root (`649add63…`), which composes no domain package; `scenario:lead-to-won` composes a *starter* into a directory of its own. Declared in the document as `NO_SCENARIO_COMPOSES_THIS_APPLICATION` | `partial` — nothing behavioural can be proven for it today, exit 1 |
| `govern-delivery-change` | **no** | **no** — no shipped scenario composes the application it was written against | `deferred`. Not papered over: no evidence document is invented for it, because one would have nothing honest to cite |
| `verifier-fixture-exit-zero` | yes | yes — binds through `scenario:service-sla-escalation` | **verifier fixture, not a product plan.** 4 verified, exit 0. It exists so the exit-0 arm of the contract is exercised end to end, and it claims no product coverage and no JTBD row |

### What DX10 deliberately did not close

- **It promotes nothing** — no JTBD row, no plan status, no document. `promotion.performed` is `false` on every report.
- **It discovers no requirement.** It reports the requirements *a plan wrote down*
  (`COVERAGE_IS_THE_PLAN_ONLY`). A requirement no plan states cannot be caught here.
- **It drives no browser**, contacts no provider, opens no database, and observes
  no deployed or external system — the same gaps DX5 and DX6 publish, published
  again here rather than assumed to carry over.
- **It does not make PROVE complete.** Both shipped consumers exit 1. That is the
  true state of both plans, and a green exit here would be the defect.

## The LA0 backfill answer, as the rule requires

LA0 (the Lead Intelligence characterization harness) is **not** a horizontal
capability in the sense the rule usually means — it adds no kernel behaviour and
no contract any domain must satisfy. It is recorded here because it changes what
this matrix can claim about one domain.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **Lead Intelligence only**, and only by observing it. No code moved, no helper was relocated, no ambient field replaced, no seam added |
| Which are already aligned? | Not the frame. What changed is coverage: Lead Intelligence now has a frozen, machine-checked record of its externally observable behaviour — 149 observations, 779 asserted values. Commercial Operations and Signature & Order have **none** |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None from LA0 itself.** It surfaced two `defect_candidate` findings in `record-signal` — an unbounded `value` and control characters stored verbatim — which were fixed in their own PR, before the extraction rather than during it |
| What changed for extraction? | The acceptance criterion — behaviour preservation proved from the outside — is mechanical for the first time. It was the last unknown; what remains is decisions |
| Matrix updated? | Yes — this section |

### Characterization coverage, by domain

| Domain | Characterized | Note |
|---|---|---|
| Lead Intelligence | **yes** — `tests/characterization/`, `legacyCharacterizationContract: 1` | the extraction candidate. Still **not** package-aligned: it remains kernel source with an ambient runtime field and a fixed definition slot |
| Commercial Operations | **yes** — `tests/characterization/commercial-*`, `legacyCharacterizationContract: 1` | extracted; the baseline replayed identically across the move |
| Signature & Order | **yes** — `tests/characterization/signature-*`, `legacyCharacterizationContract: 1` | extracted; the asserted baseline replayed byte-identical across the move (`fe1875bf…`), and the webhook route stays kernel-owned by ADR-032's measured decision |
| Contracts, Delivery, Service, Work, Lifecycle, Customer Data | **not applicable** | package-native from birth; `crm package test` plus their own suites already cover them |

**LA0 is a gate for extracting a legacy domain, not a requirement for building a
new one.** A package written package-native has no pre-move behaviour to
preserve, and demanding a characterization baseline from it would be ceremony.

## The Customer Data Foundation backfill answer, as the rule requires

Customer Data Foundation v1 (ADR-037) introduces a capability that *looks*
horizontal and mostly is not: `customer-data/customer-identity@1`, plus a
consolidated **profile projection** that reads across whatever packages an
application composes. Every domain holds customer-shaped data, so every domain
gets a row — and the honest answer for almost all of them is that nothing
changes, because **the foundation links and projects; it never duplicates.**

That sentence is the whole assessment. The foundation adds no master customer
table, no copy of a business record and no foreign key into one. Company and
Contact stay the host application's records; every other record stays with the
package that owns it; and identity, provenance, lineage and projection are held
*beside* them through the ADR-030 subject envelope. A domain that keeps owning
its own records has nothing to backfill.

| Question | Answer |
|---|---|
| Which old domains does this touch? | **Potentially all of them, and materially none.** The profile reads every composed package, so every package is a possible section of it. No package is read *into* — nothing is copied, re-keyed, re-pointed or normalized away, and no domain's records change shape, ownership or lifecycle |
| Which are already aligned? | **All of them, by construction.** The foundation requires nothing (`requires: []`) and reaches the host only through the ADR-013 core adapters. A composed package is projected as it already is; an uncomposed one reads *not available* with a reason. Neither case asks the domain for anything |
| Which need metadata only? | **None** |
| Which need a code backfill? | **None.** One kernel change was needed and it is not a domain backfill: the ADR-032 bounded operation context gained `core`, the same frozen ADR-013 adapter handle a record action already receives as `ctx.core`. It was measured against both alternatives — a 500-capped scan through `modules`, which is a correctness bug the moment a project has more contacts than that, and raw SQL through `database`, which would have a package re-implementing core's own normalization — and the sanctioned adapter won. `tests/package-operations-seam.test.js` freezes the widened key set, so a further widening is a deliberate act |
| What changed for extraction? | **Nothing.** No legacy domain moved, and this package was package-native from its first commit, so it has no pre-move behaviour to preserve and needs no LA0 baseline. The three asserted LA0 baselines replay byte-identical across this work |
| Matrix updated? | Yes — this section, plus the coverage table below |

### What the foundation asks of each domain: nothing, stated per domain

| Domain | Status against Customer Data Foundation v1 |
|---|---|
| **Core CRM (Sales)** | `aligned` — and it is the load-bearing case. Company and Contact **remain the source records**. An import creates them through the core adapters exactly as a person would; a canonical link records a decision *beside* them and leaves both rows byte-identical; and the scenario proves that by fingerprinting them before and after. No core record gained a field, a foreign key or an owner |
| **Pipeline** | `not_applicable` — a stage is the state of an opportunity, not an identity or a source of customer rows |
| **Lead Intelligence** | `not_applicable` — enrichment already carries its own snapshot and provenance for a Lead (M9). The foundation does not read, replace or reconcile it, and a Lead is not a customer identity |
| **Commercial Operations** | `aligned` — projected as a profile section when composed. Quotes are read, never copied, and the section is absent-with-a-reason when the package is not composed |
| **Signature & Order** | `aligned` — same shape, and with one deliberate silence: signed evidence is immutable, and nothing in this foundation edits, anonymizes or erases it. The erasure question against immutable signed evidence is stated as unresolved rather than answered |
| **Contract Activation** | `aligned` — projected when composed; contracts and subscriptions keep their own identity and their own lifecycle |
| **Delivery** | `aligned` — projected when composed |
| **Service** | `aligned` — projected when composed. `support-case-activity` stays domain-specific and is **not** aggregated into the profile, for the same reason Work v1 refused to fold it in: two timelines that mean different things are honest, one that means both is not |
| **Work** | `aligned` — projected when composed. The foundation reuses Work's ADR-030 subject envelope to point at records rather than inventing a second reference mechanism |
| **Lifecycle** | `aligned` — projected when composed |
| **Custom-package fixture** | `not_applicable` — it owns one resource and no customer-shaped record |
| **Marketing & Growth** | `not_applicable` — documentation only. This is the row most at risk of being over-read: a customer data layer next to an unbuilt marketing track invites the word *CDP*, and **no such claim is made anywhere**. There is no audience, no segment, no consent, no activation and no export |

### The profile is a projection, and the absence is part of the contract

A profile section for a package that is not composed reads `available: false`
with a reason and with a **null** count and null items — never a zero. A zero
would be a claim that there are none, which an application that cannot see the
package is not entitled to make. `examples/scenarios/customer-identity-governance.scenario.json`
observes this over a composition holding **no other package at all**, which is
what makes it a fact rather than a rendering detail.

### And the Production Spine's absence stays visible

Nothing here changes it. This framework ships no authentication, so
"a human decided" means an actor object said `type: "user"` — an audit boundary,
not role enforcement. Nothing is scheduled, notified, exported or activated;
nothing is deployed; and none of this is a GDPR, consent, retention or erasure
claim. Those absences are published by the package's own metadata and by the
scenario's limitations rather than left for a reader to discover.

## Sequencing, which this document does not change

```text
1.  finish, independently review and merge M14b2      done (PR #25)
2.  M15 — Service package, built on the seam          ← where we are
3.  review the M15 learnings: what the seam still cannot express
4.  a controlled Legacy Domain Alignment Pass, one domain at a time
```

Steps 2 and 3 come before step 4 on purpose. Contracts and Delivery are two
data points, and Delivery is the only one that has *consumed* another package's
capability. Service is the third — and the first built with the seam already
mature. Extracting a legacy domain before that learning bakes today's shape into
four more places.

**DX4 (`crm package test`) is the practical gate.** An extraction without a
conformance harness is a refactor whose only proof is that the existing tests
still pass — which is precisely the proof that misses a boundary violation. The
roadmap already sequences DX3 and DX4 after M15, and the extraction pilot after
DX4.

### Lead Intelligence as the first extraction — a hypothesis, pending evidence

**This is a working hypothesis, not a decision.** It is recorded so the eventual
choice is argued against a written position rather than made ad hoc.

Why it is the plausible first candidate:

- **Its dependency direction is inward.** Intelligence reads CRM records and
  writes its own evidence. It is not read by Commercial, Signature or Delivery,
  so extracting it should not require a new capability for anyone else.
- **It already has the shape.** Versioned fingerprinted definitions (ADR-015),
  managed append-only evidence, a reproducible historical decision — the
  properties a package must prove are already proven for it.
- **Its blast radius is bounded.** Scoring and routing are self-contained;
  Commercial and Signature carry money and an external provider.
- **Its failure mode is legible.** A scoring or routing regression is visible in
  a reproduction test, not months later in a ledger.

What must be true before it is chosen — none of which is established today:

1. DX4 exists and a package can prove conformance mechanically.
2. M15's learnings are reviewed and the seam has whatever they showed it needs.
3. A real dependency audit shows nothing reads Intelligence internals — asserted
   above from the layout, **not yet proved by a tool**.
4. Every historical routing decision still reproduces identically across the
   move. Behavior preservation is the entire acceptance criterion.

If any of those fails, another domain is the pilot, or none is. **Nothing in this
document authorizes starting an extraction.**

### The three candidates, measured (M15 review)

The hypothesis above was written before M15 shipped. The M15 review measured the
three candidates rather than reasoning about them, so the eventual decision is
argued against numbers. **Still planning only: nothing here starts an
extraction, and no extraction work is in PR #27.**

| | Lead Intelligence | Commercial Operations | Signature & Order |
|---|---|---|---|
| kernel source to move | 1,313 lines, 2 files | 1,393 lines, 3 files | 1,488 lines, 2 files |
| files outside the domain that name it | 11 | 16 | 10 |
| dedicated HTTP routes in the kernel server | none | `POST /api/catalog/sync` | `POST /api/signature/providers/:provider/events`, `POST /api/signature/envelopes/:id/reconcile` |
| dedicated method on the app object | none | `syncCatalog` | `ingestSignatureEvent`, `reconcileSignature` |
| `/api/schema` block | `intelligence` | `commercial` | `signature` |
| Admin files that read its schema block | 0 | 6 | 3 |
| carries money | no | **yes** (`commercial-money.js`, 416 lines) | yes, by reference |
| calls an external provider | yes, in a `prepare` phase the kernel already isolates | yes, outside the write transaction | **yes, and it receives inbound webhooks** |
| depended on by another domain | no | **yes** — Contracts activates an Order; Delivery and Service reach obligations raised from it | yes — Contracts reads the signed Order |
| what a regression looks like | a reproduction test disagrees | a stored amount disagrees | an envelope or artifact is lost, or a webhook is accepted twice |

Three things the table says that prose did not:

1. **Intelligence is the only candidate with no kernel HTTP surface, no app
   method and no Admin coupling.** Its extraction is a package boundary and
   nothing else. Commercial and Signature each require moving a route out of
   `apps/server`, which is a second, unrelated piece of work — and one the
   package seam does not currently support at all: **no package can contribute
   an HTTP route today.** That is a seam gap, not a scheduling problem.
2. **Commercial is the most depended-upon.** Contracts, Delivery and Service all
   sit downstream of the Order it produces. Moving it first means designing
   three capability edges at once, on the domain that carries money.
3. **Signature is the riskiest for a reason unrelated to size.** It is the only
   domain that accepts bytes from outside. An extraction that changes where the
   verification code lives is an extraction that has to re-prove replay,
   out-of-order and wrong-tenant handling — the evidence hardest to be confident
   about after a move.

**Recommendation: Lead Intelligence, at moderate confidence.** Moderate rather
than high because two of its four preconditions are still unproved — DX4 does
not exist, and "nothing reads Intelligence internals" is read off the file
layout rather than established by a tool. The measurement strengthens the
hypothesis; it does not convert it into a decision.

**A precondition the table added:** before Commercial or Signature could ever be
a candidate, the package seam needs a way for a package to own an HTTP route.
Neither is extractable today at any confidence, and that is a finding about the
*seam*, not about them.

### Recommended next ordering

Ordering, with the reason each item sits where it does. This is a
recommendation to a human, not a plan of record:

1. **DX4 — `crm package test` (conformance harness).** Everything else that
   touches the seam is safer after it, and it is the stated gate for any
   extraction. Without it an extraction's only proof is that the old tests still
   pass, which is exactly the proof that misses a boundary violation.
2. **DX3 — package scaffold.** Cheap next to DX4, and it makes DX4's contract
   the default shape rather than something to remember.
3. **DX1 — `crm doctor` deepening.** Independent of the seam, useful to every
   other item, and the smallest of the four.
4. **The extraction pilot — Lead Intelligence.** Only after 1 and 2, and only if
   its four preconditions are established rather than assumed.
5. **DX2 — Skill mirror sync.** Real (six domain build skills now live under
   `.claude/` only) but nothing depends on it, and it stays a documentation
   correctness gap rather than a runtime one.
6. **M16 — Analytics Studio.** Last, because it is the item most likely to
   *consume* whatever the extraction learns about reading across packages. Doing
   it before the pilot risks writing the cross-package read pattern twice.

The one ordering claim worth arguing with: DX2 sits fifth despite being the
cheapest, because cheap and urgent are different, and the gap is already
documented in this matrix.

### Re-evaluated after DX4 was built

DX4 is now item 1 done. Three things it established change the ordering below
it, and one thing it did **not** establish leaves a recommendation where it was.

**Lead Intelligence is still the recommended pilot, and the confidence rises
from moderate to moderate-high.** DX4 removes the largest unknown: "how would we
know the extracted domain still conforms" now has a mechanical answer, and that
answer is a stable document rather than a reviewer's judgement. The remaining
preconditions are unchanged and still unproved — nothing yet establishes that
no code reads Intelligence internals, and behaviour preservation across the move
is still the whole acceptance criterion.

**But DX4 also measured what an extraction would have to produce.** A package
passes `crm package test` only if it declares its records, its actions target
records somebody owns, its dependencies are declared capabilities, its manifests
apply and the application boots without it. Intelligence today has none of that
shape: its actions live in `packages/core/src/intelligence-actions.js` and its
registries in the kernel. The extraction is therefore not a move — it is an
authoring exercise with a conformance target, which is a better-defined job than
it was a week ago and not a smaller one.

**The HTTP-route seam is confirmed as an extraction precondition, and DX4 did
not need it.** DX4 composes and boots packages without any package contributing
a route, so the answer to "is route contribution required for generic package
conformance" is **no**. It stays exactly what the previous section called it: a
precondition for Commercial and Signature specifically, because each owns a
route in `apps/server` that would have to go somewhere. Neither is extractable
at any confidence until that seam exists, and building it was correctly out of
DX4's scope.

**One new precondition DX4 surfaced, and its review sharpened it.** There are
two different situations that look alike:

- acting on a record **no package owns** — a *host-application* record. Every
  legacy domain does this (Commercial and Signature on `quote` and `order`,
  Intelligence on `lead`), every package here does it on `order`, and it is
  ordinary: the project supplies the manifest. `crm package test` passes it.
- acting on a record **another package owns**, without declaring that package.
  `crm package test` **fails** it, because the package cannot be composed into
  any project that lacks the owner and nothing in its declaration says so.

For extraction this is good news: the legacy domains' record dependencies are
almost all of the first kind. The one that would need a decision is any
extracted domain acting on another *extracted* domain's record — and the answer
is either a capability on the owner, or an explicit contract extension for
record-level coupling. Neither is needed to start the pilot.

`partner-scorecard` is the worked example of the second kind, and it is
**non-conforming** as a result: `delivery` offers no capability that expresses
rating a partner engagement. That is a real seam gap, recorded rather than
patched.

### The extraction gate now lives in its own document

The measured blockers, the LA0 characterization-harness design, and the decision
analyses for `app.intelligence` and the definition registry are maintained in
**`docs/architecture/EXTRACTION_PREPARATION.md`**, produced alongside DX1. The
summary below is the state as of DX3 and remains accurate; the newer document
adds the recommendations and the ordering.

### Re-evaluated after DX3 was built — extraction readiness, measured

The question DX3 makes it fair to ask: **is the path now complete enough to
extract Lead Intelligence?**

```text
accordo app inspect        the composition before                    exists (AX1)
accordo solution check     a plan bound to that composition          exists (AX2)
crm package scaffold   an empty conforming lead-intelligence     exists (DX3)
  move code            registries, actions, records              by hand
crm package test       does the result conform?                  exists (DX4)
  characterization     does it still decide identically?         DOES NOT EXIST
```

Five of six rungs exist. **The recommendation does not change: do not start.**
Confidence in Lead Intelligence as the right *first* pilot stays moderate-high;
confidence that it can be started *today* is low, and the reasons are now
measured rather than assumed.

**The precondition "no code reads Intelligence internals" is disproved.** It was
recorded as unproved; it is now false, and the evidence is three imports:

| Reader | What it reaches for | Why it blocks |
|---|---|---|
| `packages/core/index.js` | re-exports `computeDefinitionFingerprint` from `intelligence-registry.js` | it is **public kernel API** that every package depends on, sitting inside the domain that would move |
| `packages/core/src/catalog-sync.js` | `withTimeout` from `intelligence-actions.js`, `computeDefinitionFingerprint` from `intelligence-registry.js` | Commercial Operations' provider sync depends on Intelligence's *files*, and Commercial is itself `needs_extraction` |
| `packages/cli/src/app-inspect.js` | `packages/intelligence/generated/index.js` by path, as one of AX1's fixed composition slots | AX1's report shape names `intelligence` as a first-class definition kind |

The first two are the real blocker and they have the same shape: the
fingerprint and timeout helpers are **horizontal kernel machinery that happens
to live in an Intelligence file**. They must move to a neutral kernel module
*before* any extraction, as a separate, behaviour-preserving PR. That is a
prerequisite, not part of the pilot.

> **Resolved** by the neutral-helper move. `computeDefinitionFingerprint`,
> its canonicalizer and `validateDeclaredConfig` now live in
> `packages/core/src/definition-fingerprint.js`, and `withTimeout` in
> `packages/core/src/timeout.js`. The finding above is left standing as the
> record of what was measured; what changed is where the code lives, not
> whether the reading was true. The importer list LA0 measures shrank from
> ten files to four, and the four that remain — `create-app.js`, the
> starter's `install.mjs`, `DECISIONS.md` and Intelligence's own actions
> module — are genuine Intelligence dependencies rather than helper reach-ins.
> The third row, AX1's fixed composition slot, is untouched and still open.

**Two seams the extracted package would need and cannot declare today.**

- `app.intelligence` is a field on the application object. It is published in
  `/api/schema` (`apps/server/src/http-server.js`) and injected into every
  action's context (`packages/core/src/action-runtime.js`). A package can
  declare a *capability*, which another package opens deliberately; it cannot
  contribute an ambient context key that every action in the application
  receives. Either that ambient key becomes a declared capability — a real
  behaviour change for every existing action — or the contract grows a way to
  express it. Neither is decided.
- `packages/intelligence/generated/index.js` is a **project-owned registry
  file**, on the same pattern as `packages/actions/generated`. A package that
  owns a definition kind needs somewhere for a project to declare instances of
  it. There is no generic seam for a package to contribute one, and inventing
  one for a single consumer would violate this repository's own rule that a new
  generic seam needs two real consumers.

**And the acceptance criterion has no harness.** The criterion is behaviour
preservation proved from the outside: every historical decision reproduces
identically. `crm package test` cannot answer that — it says so itself, under
`DOMAIN_CORRECTNESS_NOT_PROVEN` — and no characterization-test harness exists.
An extraction started before that harness has, as its only proof, "the existing
tests still pass", which is precisely the proof this document has twice said is
insufficient.

**So the ordered blockers, none of which is an extraction:**

1. Move `computeDefinitionFingerprint` and `withTimeout` out of the Intelligence
   files into neutral kernel modules. Behaviour-preserving, mechanical, its own PR.
2. Decide `app.intelligence`: ambient context key, or declared capability.
3. Decide how a package contributes a project-owned definition registry — or
   establish that Intelligence keeps its registry in the host application.
4. Build the characterization harness that can prove behaviour preservation.
5. *Then* the pilot, one domain, one PR.

Item 1 is small and independently useful; it is the honest next thing anyone
who wants the pilot should do. Items 2 and 3 are contract decisions and belong
to a human. Nothing in this section authorizes starting any of them.

## What this document is not

- Not a schedule. No date, no milestone number for the alignment pass.
- Not permission to refactor a legacy domain.
- Not a judgment on the older domains. They are the reason the seam is any good.
- Not a test-count report. Volatile numbers live in `docs/PROJECT_STATUS.md`.

## Evidence

`DECISIONS.md` (ADR-012, ADR-014, ADR-015, ADR-017, ADR-018 and its addenda,
ADR-019, ADR-020), `docs/PACKAGE_AUTHORING.md`, `docs/APPLICATION_INSPECTION.md`,
`docs/CODER_TOOLING_ROADMAP.md`, `docs/architecture/AGENT_TOOL_SURFACE.md`,
`docs/QUALITY_GATES.md`, `packages/contracts/README.md`,
`packages/delivery/README.md`. Cell values were checked against the working tree
on 2026-08-07; a reader who doubts one should run
`npm run crm -- app inspect --json` in a composed project and compare.
