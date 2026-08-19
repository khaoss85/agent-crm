# ExecPlan — Customer Data Foundation v1

**Status: in progress.** Branch `claude/customer-data-foundation-v1` from `61e1aa4`
(signed-term integrity verifier merged as `e059664`; measurement pass on top).
Decision: **ADR-037** (next free number in `DECISIONS.md`).

## C1 — the promise, and its ceiling

One bounded job: **bring external customer data into Accordo → preserve source
and provenance → identify exact duplicates or leave them unresolved → let a
human govern canonical identity → surface data-quality issues → read one
consolidated Accordo-managed customer profile.**

It is **not** a CDP, a warehouse, real-time activation, a probabilistic
identity graph, ML entity resolution, arbitrary ETL, global full-text search, a
consent platform, GDPR certification, or a physical destructive merge. The
phrase "CDP" appears nowhere in code, docs, Admin, JTBD or the PR as a claim
about what this ships.

## C2 — architecture: Option B, package-native `customer-data`

| Option | Verdict | Why |
|---|---|---|
| **A — put it in `packages/core`** | **Rejected** | Customer identity, dedupe policy and data-quality semantics are *domain behaviour*, not runtime mechanics. The ADR-018 test for what core may own is "a runtime primitive with no domain vocabulary in it"; `duplicate-candidate` and `canonical-link` fail it outright. Core already supplies every generic primitive this needs (below), so nothing is blocked by leaving it out. |
| **B — package-native `customer-data`** | **Chosen** | Narrowest honest name: it is customer *data* foundations — identity, provenance, import, quality — not customer *management*. Optional like every other package: removing its composition line removes the whole thing and every other package keeps working. |
| **C — a new master `customer` record duplicating Company/Contact** | **Rejected** | It would create a second mutable copy of the truth, fight the core schema's `contacts.email NOT NULL UNIQUE`, and force a cascade rewrite across nine packages that reference `companyId`/`contactId`. The inventory below proves the existing model *can* carry identity linkage, which C2 makes the condition for rejecting this. |

**Governing principle, applied literally: existing business records remain the
source records.** This package adds identity, provenance, lineage and
projection *around* them and writes none of their columns.

Three existing primitives make Option B work without inventing anything:

1. **Core adapters (ADR-013)** already expose exactly the deterministic
   matching this needs — `findContactByEmail` (over the globally unique,
   lowercased `contacts.email`) and `findCompaniesByNormalizedName` (NFC +
   whitespace-collapse + lowercase, oldest-first deterministic order) — plus
   the sanctioned create path. No package re-implements normalization.
2. **The ADR-030 subject envelope** (`work-task`) is the proven way to point at
   a record another package owns without an FK or a copy:
   `subjectResource` + `subjectId` + `subjectOwner` + `subjectOwnerPackage`.
   Every reference in this package uses that shape.
3. **The `enrichment-snapshot` provenance pattern** (Intelligence) is the
   proven way to record external data honestly: `provider`,
   `providerVersion`, `providerFingerprint`, unique `sourceKey`, typed
   extracted fields — and **no raw payload column**. External identity copies
   that discipline.

## C3 — inventory of what already exists (from source)

| Record | Kind | Identity/uniqueness today | Dedupe today |
|---|---|---|---|
| `companies` (core, handwritten) | **authoritative mutable** | `id` only. `name` and `domain` carry **no unique constraint** | none — `findCompaniesByNormalizedName` returns *all* matches and callers decide |
| `contacts` (core, handwritten) | **authoritative mutable** | `email` is **NOT NULL UNIQUE** (stored lowercased); `company_id` FK CASCADE | a duplicate contact *by email* is already impossible; the real duplicate is one human under two addresses |
| `opportunities` (core) | authoritative mutable | FK company RESTRICT, contact SET NULL | none |
| `lead` (starter module) | authoritative mutable | project-defined | none |
| `quote` / `quote-version*` (commercial) | version rows are **immutable snapshots** | `sourceKey` unique per version | n/a |
| `order` + family (signature) | **immutable snapshot** — carries `companyId`, `contactId` **and** `customerName`, `customerEmail` frozen at signature | `sourceKey` unique | n/a |
| `commercial-contract` / `contract-version` (contracts) | contract row mutable-by-activation, version **immutable**; also carries `customerName`/`customerEmail` | `orderId` unique | n/a |
| `delivery-*`, `service-*` | operational records referencing contract/company | own source keys | none |
| `work-task` / `work-activity` | **source evidence**, opaque subject envelope | `sourceKey` unique | none |
| `enrichment-snapshot` (intelligence) | **immutable external evidence** | `sourceKey` unique, provider fingerprinted | none |
| `contract-succession` (lifecycle) | immutable lineage | one per source cycle | n/a |

**The rule this inventory forces:** `order.customerName`/`customerEmail` and
the contract's copies are **party snapshots frozen at signature**, not live
master data. This package reads them as *evidence of what was signed*, never as
the current truth of who the customer is, and never writes them.

## C4 — the v1 record model (six records, no second copy of anybody)

All owned by `customer-data`, all fully managed (no public write path), each
pointing at existing records through the subject envelope.

1. **`customer-import-run`** — one import. Mapping name + version +
   **mapping fingerprint**, policy identity + fingerprint, mode
   (`preview`/`apply`), acceptance mode, `idempotencyKey` **UNIQUE**
   (business-derived), counts (`rows`, `accepted`, `rejected`, `skipped`),
   status, actor, timestamps.
2. **`customer-import-row`** — one receipt per input row: run, row index,
   input digest, outcome (`accepted`/`rejected`/`skipped`), stable reason code,
   the subject it produced or matched, and the deterministic match rule that
   fired. Every rejected row has a receipt; the run summary reconciles exactly.
3. **`external-identity`** — `system` + `externalId` → subject envelope, with
   `sourceKey` **UNIQUE** (`system:externalId`), first/last observed, status.
   **No raw payload, no credential, no secret.**
4. **`duplicate-candidate`** — two subject envelopes (left/right, ordered
   deterministically), the **policy identity + fingerprint** that produced it,
   the explainable rule and its evidence, status
   (`unresolved`/`linked`/`dismissed`). **Never auto-resolved.**
5. **`canonical-link`** — the human decision. `clusterKey`, member subject,
   role (`canonical`/`alias`), the decision id it belongs to, actor, reason.
   **Non-destructive: every source row survives, every reference survives.**
6. **`data-quality-issue`** — kind, subject envelope, explainable evidence,
   status (`open`/`resolved`/`dismissed`), detector policy identity.

**No `customer` master record. No profile table** — the profile is a projection
(C8), computed on read from records the owning packages already hold.

## C5 — import v1

- **Input**: bounded structured rows handed to an application operation
  (ADR-032 seam) — `{ system, mapping, rows: [...] }`, with hard caps on row
  count, field count and string length. **No file path, no arbitrary file
  execution, no remote provider, no credentials.** A checked-in local artifact
  is out of v1: rows arrive as data.
- **Preview writes no business data** and no `customer-data` record either: it
  returns the receipts it *would* write.
- **Apply recomputes authoritatively** inside its own transaction — a preview
  result is never an authorization (the M16b lesson).
- **Idempotency key is business-derived**: `sha256(system, mappingFingerprint,
  canonical row digest set)`. Never `now()`, never random. A repeat with the
  same key returns the same run; a *different* payload under the same key is a
  conflict refusal, not an adoption.
- **Acceptance mode is explicit**: v1 default is **partial-accept**, chosen
  because a 500-row import that dies on row 7 helps nobody; `all-or-nothing` is
  offered as an explicit input. Under partial-accept every rejected row carries
  a receipt and `accepted + rejected + skipped === rows`, asserted.
- Mapping is **code-first, versioned, fingerprinted** (ADR-015 discipline).

## C6 — matching: deterministic and explainable only

Three rules, in fixed precedence, each recording which fired:

1. **exact external identity** — same `system` + `externalId` → same subject.
2. **exact normalized email** — through `findContactByEmail` (core's own
   normalization, not a second implementation).
3. **exact normalized company name** *plus* exact domain — through
   `findCompaniesByNormalizedName`, and only when the domain also matches
   exactly; name alone yields a **duplicate candidate**, never a match.

No fuzzy, no ML, no scoring, no random tie-break. **Ambiguity stays
unresolved**: if rule 3 returns more than one company, the row produces a
`duplicate-candidate` and an unresolved outcome rather than picking one.
Policies are synchronous, total, deterministic and fingerprinted; inputs are
frozen; the evidence is stored.

## C7 — canonical identity: a logical link, never a deletion

- **Human-only.** The action refuses a non-user actor (`HUMAN_APPROVAL_REQUIRED`),
  exactly as contract activation and M16b execution do.
- **Logical cluster**: members are linked under a `clusterKey`; one member is
  `canonical`, the others are `alias`. **No row is deleted, no field is
  overwritten, no reference is rewritten, no cascade touches another package.**
- Every decision is audited with its actor and reason.
- The word **merge** appears only as **"logical canonical merge (link, not
  deletion)"** — in code comments, Admin and docs alike.
- Physical consolidation is explicitly **Customer Data Operations v2**.

## C8 — the profile read model

A **projection**, not a table: an application operation aggregates over
capabilities the owning packages already offer, plus core adapters for
Company/Contact. It reports canonical identity, external identities, open
opportunities, current contract/subscription, delivery/service summary, work
summary, renewal lineage and data-quality issues.

**Every contributing package is optional.** A package that is not composed
reads **`"not available"`** with a stated reason — never `0`, never `[]`, never
"none". The profile states plainly that it is **not a complete cross-channel
timeline** (no marketing, no analytics, no external events), and the JTBD row
stays partial to match.

## C9 — capabilities

Offered by `customer-data`, sized by real consumers only:

- **`customer-identity@1`** — read canonical identity and external identities
  for a subject. Consumer: the profile operation and Admin.

That is the only capability v1 offers, because it is the only one with a real
consumer. Nothing is frozen against hypothetical future readers. The package
*requires* nothing: it reads core through adapters and other packages through
their own already-declared capabilities where composed, degrading to "not
available" where not.

## C10 — data quality

Detectors are deterministic and explainable: missing required identity ·
conflicting external identity (same `system:externalId` pointing at two
subjects) · invalid email or domain shape · duplicate candidate outstanding ·
orphaned subject reference where detectable · unresolved import row. Issues are
governed (open → resolved/dismissed with actor and reason), append-only in
history, and **resolution never erases the record**. **No universal DSL, no
compliance claim.**

## C11 — scope honesty

| Capability | v1 |
|---|---|
| Import preview/apply, receipts | **implemented** |
| External identity + provenance | **implemented** |
| Deterministic duplicate candidates | **implemented** |
| Human canonical linking | **implemented** |
| Data-quality queue | **implemented** |
| Read-only consolidated profile | **implemented** |
| Global full-text search | **Customer Data Operations v2** |
| Saved views | **Customer Data Operations v2** |
| Bulk actions / export at scale | **Customer Data Operations v2** |
| Physical merge / consolidation | **Customer Data Operations v2** |
| Retention / erasure workflow | **Customer Data Operations v2**, and legal-policy dependent |

Named track, one home, not scattered "not supported" rows.

## C12 — API / SDK / schema / Admin

Generic surfaces only: package actions for the human decisions, one ADR-032
application operation for import, one for the profile read. Admin gets a
`customer-data` section: import preview → run → row outcomes · duplicate
candidates · canonical decisions · data-quality queue · the read-only profile ·
source/provenance evidence. Visible limits, verbatim: no ML matching · no
automatic destructive merge · no warehouse or activation · no RBAC · no remote
provider · no GDPR or legal assurance. **Real Chromium** for the main flow.

## C14 — security and governance

No raw payload, no credential, no secret stored. Bounded input (rows, fields,
lengths). **Control-safe strings reuse the existing strictest PII policy** —
`/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/`, the signer policy from
`packages/signature/src/operations.js` — not a new one. Services and prepared
statements only; no raw SQL from input; no file path at all in v1. Every human
identity decision is audited. Retention limitation documented; **erasure versus
immutable evidence is explicitly left unresolved and legal-policy dependent**.
The Production Spine's absence stays visible in the Admin and the schema.

## C15 — fault, concurrency, scale

Preview writes nothing (asserted by full-database fingerprint) · apply rolls
back completely on an injected fault after every write, leaving no run, no row,
no identity, no candidate · idempotent retry returns the same run · a divergent
payload under the same key is a conflict refusal · two connections racing one
import produce one run via DB uniqueness, not an in-process lock · two
connections racing a canonical decision produce one decision · restart is
stable · exact indexed reads past 500 rows where correctness depends on the
collection · hostile input (control chars, `__proto__`, markup, oversized) is
refused or stored inert · old-DB upgrade · detach/reattach with rows intact ·
**no partial canonical identity decision**, ever.

## Verification plan

`npm install`, `verify`, `smoke`, `gtm:check`, `app inspect`, `project doctor`,
`project verify`, `package test packages/customer-data`, all scenarios
including a new bounded CDF scenario, the fault/race/scale matrix, old-DB
upgrade, detach/reattach, hostile input, **real Chromium** for the main Admin
flow, AX1/AX2/DX4/DX5/DX10, and **all three LA0 replays byte-identical**
(`fe1875bf…`, `82c1f02f…`, `f80592be…`). CI green on the exact head. PR left
**OPEN and UNMERGED**.

## Results of record

| Gate | Result |
|---|---|
| `npm run verify` | pass on the exact head |
| `npm run smoke` | pass |
| `npm run gtm:check` | pass |
| `app inspect --json` | the package reports 6 resources, 3 actions, 3 operations, 1 capability, 1 fingerprinted policy |
| `project doctor --json` | passed — 9 passed, 0 warning, 0 failed |
| `package test packages/customer-data --json` | 25 passed, 0 failed, 3 not applicable |
| `scenario run customer-identity-governance` | passed — 56 observations, 7 JTBD rows established |
| `scenario run lead-to-won` / `service-sla-escalation` / `contract-renewal-execution` | all passed, unchanged |
| `solution check` (AX2) | valid, no problems |
| `solution verify` (DX10) | **incomplete, deliberately** — 8 requirements proven, 3 PARTIAL with stated gaps |
| Real Chromium | 32/32, twice from a clean project, database and browser profile, plus once more on the final head |
| LA0 replays | all three asserted fingerprints byte-identical: `fe1875bf…`, `82c1f02f…`, `f80592be…` |

### Defects this work found

1. **Admin — a preview discarded the operator's typed rows.** The panel
   re-renders after a preview, and the re-render rebuilt the import form empty,
   so Apply refused the operator's own import as *paste the rows*. The primary
   flow of the surface was unusable. Found by the real-Chromium run, not by any
   unit test, because the fake DOM re-render happened to be invisible to the
   assertions. Fixed with a draft that survives the render, and a regression
   test that previews and then applies.
2. **Admin — an unreadable list rendered as zero.** `rowsOf()` swallowed a
   failed read into `[]`, so an unreachable queue read *Import runs (0)* — the
   exact empty-truth this foundation refuses in the profile. Fixed: a list that
   could not be read says so, and says it is not a claim that there are none.
3. **DX4 — a doc comment failed conformance.** Both source-boundary rules are
   regular expressions over source text, and a comment writing a path in
   backticks after the word *from* matched as an import: a conforming package
   failed conformance for the sentence explaining why it was conforming.
   Comments are now stripped by a scanner that respects strings, templates and
   regular expressions, so a `//` inside a URL cannot blind it to what follows.
   Both directions are regression-tested.

### Deliberate re-records

- The three LA0 baselines, because `operation-runtime.js`, `create-app.js` and
  `http-server.js` are in the behaviour-bearing set and all three changed. The
  whole diff is three source digests; every asserted fingerprint and every
  observation count is unchanged.
- `docs/benchmarks/jobs.json` and `site/assets/llms*.txt`, because both are
  generated from the JTBD matrix and three rows moved.

### Not done, and why

- **`operation.present` was not added to the DX6 observation vocabulary.** This
  package's principal surface is three ADR-032 operations and the closed
  vocabulary cannot observe one. Widening it is a framework change outside this
  milestone's scope; the gap is recorded in `docs/SCENARIO_EVIDENCE.md` and in
  ADR-037, and the second package to declare an operation is when it should be
  closed.
- Everything under **Customer Data Operations v2**: global search, saved views,
  bulk actions, export at scale, physical merge or consolidation, and any
  retention or erasure workflow.
