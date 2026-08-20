# Repository truth

`npm run repo:truth` · `npm run repo:truth -- --check` — **ADR-039**.

> **Is what this repository says about itself still true of the code?**

A generated, machine-readable product-fact document (`docs/repository-truth.json`,
`repositoryTruthContract: 1`) plus a checker that holds the repository's *current*
claims against it.

This is a **repository-maintenance script**, not an Accordo rail and not a product
command. It adds nothing to `npm run surface:check`'s budget, appears in no Skill,
and never leaves this repository: a generated project has no claims ledger, no JTBD
matrix and no status file.

## The failure it closes

<!-- truth: retired-code TENANT_ISOLATION_NOT_ENFORCED — this document names the canonical retired code as the regression the machine-code rule exists to catch. It is named as history, never asserted. -->

```text
code implemented Production Spine v1
  → schema/runtime truth changed
  → PROJECT_STATUS / JTBD / claims / scenario limitation metadata stayed
    MUTUALLY CONSISTENT but stale
  → every existing gate passed
```

Twice, measurably, in two days:

1. `app inspect` published `productionPosture: "no authentication, tenancy or RBAC
   exists"` in the **same report** whose `PRODUCTION_SPINE_ABSENT` message described
   identity, tenancy and authorization (fixed in PR #101).
2. The `tenant-isolation-and-authorization` scenario published
   `TENANT_ISOLATION_NOT_ENFORCED` and *"the framework does NOT enforce it"* **after**
   ADR-038 Amendment 2 closed F-2 by binding (fixed in PR #102, found by a person).

The one sentence that explains why the existing gates could not help:

> **Existing gates check consistency *between* documents. These documents were
> consistently wrong *together*.**

`scripts/measurement.js` compares two literal strings. `scripts/site-check.js`
matches a numeric pattern. `scripts/generate-jobs.js` regenerates one index from one
Markdown source. None of them has any tie to what the code does, so all three stayed
green while the code moved out from under the prose.

## The document

```json
{
  "repositoryTruthContract": 1,
  "sourceSha": "…",
  "authorities": [ { "id": "tenant.storage", "kind": "source", "reads": [ … ] } ],
  "facts": [ {
    "id": "spine.tenant.crm_data_plane_enforced",
    "value": "enforced_by_binding",
    "authority": "tenant.storage",
    "evidence": [ "packages/core/src/tenant-storage.js#bindTenantStorage", … ],
    "scope": "framework",
    "status": "current",
    "limitations": []
  } ],
  "limitations": [ { "code": "…", "message": "…" } ],
  "fingerprint": "…"
}
```

- **`sourceSha` is not a commit id.** A commit id would move on every merge and make
  the document stale the moment it was committed. It is a SHA-256 over the sorted
  `(path, content-hash)` pairs of the **authority source set** — the exact files the
  facts are read from. It answers *what was read*; `fingerprint` answers *what was
  concluded*, so a comment-only edit to an authority moves the first and leaves the
  second exactly where it was.
- **Closed vocabularies.** `value` is a token from a fixed list, or one of three
  bounded literal shapes — a 7–40 hex `sha`, a non-negative integer `count`, a
  positive integer `contract`. Nothing else may carry a literal, so a sentence can
  never become a fact value. `status` is `current | stale | unknown`; `scope` is
  `framework | package | repository | measurement`.
- **No timestamp anywhere**, not merely outside the fingerprint, and no secret, no
  absolute path and no function. Two runs over an unchanged checkout produce
  byte-identical bytes from different working directories.

## The three kinds of authority, kept apart and labelled

**Source-derived** — read from checked-in source, recomputed on every run, so *stale*
is not a state they can be in; disagreement is a failure instead.

| Authority | Read as |
|---|---|
| `identity.contract` | `IDENTITY_CONTRACT` and the four identity kinds |
| `spine.contract` | `SPINE_CONTRACT`, `PERMISSIONS`, `ROLE_BUNDLES`, `SPINE_NOT_MODELED` |
| `runtime.mode` | `MODE_ENV`, and production's refusal to start without a verifier |
| `tenant.storage` | `TENANT_STRATEGY`, `TENANT_LIMITATIONS`, and a **structural probe of `bindTenantStorage()`'s own returned shape** |
| `reference.composition` | the nine checked-in domain packages composed through `resolvePackageComposition` — the same function `PackageRegistry` throws from at startup |
| `cli.rails` | the CLI dispatch table **and** each handler module's export, which must agree |

**Receipt-derived** — read from a recorded run, and **verified rather than trusted**.

| Authority | Read as | Verified by |
|---|---|---|
| `benchmark.tool_selection` | `aggregate.json` `comparative`, and whether any rate key exists at all | `protocolFingerprint`, `instrumentFingerprint` and `baseSha` must equal the frozen protocol's. A mismatch is `TRUTH_AUTHORITIES_CONTRADICT`, and nothing is read from the receipt |

**Measurement-derived** — the measured ledger, and what git can prove about it.

| Authority | Read as |
|---|---|
| `measurement.ledger` | `site/claims.json` `measuredAgainst` |
| `measurement.git` | ancestry of the recorded commit, and `tests/` at that commit versus at `HEAD` |

## Two probes worth reading, because they are the shape the whole thing turns on

**The tenant binding is asked, not quoted.** ADR-038 Amendment 2 says a second tenant
is unreachable *"through the handle the application holds"*. That is a property of an
object, so it is asked of the object: the provisioning-side storage has
`databasePathFor`, the bound handle does not, and the two planes resolve to different
files. Before Amendment 2 the bound handle **did** expose `databasePathFor`, and this
generator would have produced `declared_not_enforced` — which is why that token is in
the vocabulary. A fact that could only ever take one value proves nothing.

**Production's refusal is executed, not described.** `resolveRuntimeMode({ mode:
'production' })` with no verifier is called, and the refusal code it throws
(`SPINE_VERIFIER_REQUIRED`) is what makes
`spine.authentication.framework_verifier=absent` a positive statement about the seam
rather than an observation of silence.

## The rule that matters most

> **A fact never silently defaults from a missing authority, and `false` is never
> inferred from absence unless the contract defines that meaning.**

- An unreadable **source** authority is `TRUTH_AUTHORITY_UNAVAILABLE`, a non-zero
  exit, and no document at all. It does not become an `unknown` fact the run then
  carries on around.
- An unverifiable **receipt or measurement** authority refuses *its own* facts and
  fails the run, while the source facts still stand. Collapsing the whole document
  over a shallow clone would stop the citation and machine-code rules — the half
  that needs no git — running in the one job that runs on every push.
- Two authorities that disagree are `TRUTH_AUTHORITIES_CONTRADICT` and a non-zero
  exit. **Neither answer is published**: a fact already built is withdrawn rather
  than left standing beside a problem nobody reading `facts[]` would see.
- Where absence *is* the meaning, the contract names the rule:
  - **declared-absence** — the value comes from a list the source *declares* as not
    modelled (`SPINE_NOT_MODELED`, `TENANT_LIMITATIONS`, the frozen journey
    registry's limitation codes). Reading a declaration is not inferring from
    silence, and a declaration that has gone is a failure, not a default.
  - **namespace-probe** — a product area is `absent` when **no** resource, action,
    capability or policy in the reference composition carries any of the prefixes the
    contract declares for it. The prefixes are published in the fact's own evidence,
    prefixes match on the hyphen-segment boundary (so `tax` does not match
    `taxonomy`), and the probe is refused outright if the composition did not resolve
    cleanly — a probe over a broken composition would report every area absent.
  - `not_measured` is a statement **about measurement**. The absence of a measurement
    is measurement's absence; it is not a claim that the thing measured is false.

## Binding a document

Three checks, and the mechanism for each was chosen to be the least invasive one that
works.

**1 — fact citation.** `<!-- truth: <id>=<value> -->` in Markdown, or a
`"facts": ["<id>=<value>"]` array in JSON. One grammar, one parser, both surfaces.
The Markdown form is an HTML comment, so it is invisible when a page renders and
load-bearing when the checker runs.

- an id nothing resolves → `TRUTH_FACT_UNKNOWN`
- a cited value the authority no longer produces → `TRUTH_FACT_VALUE_STALE`

A reversed polarity is a value that differs, so it is the same failure — which is the
point: a document that says `enforced` about something the code now leaves
`declared_not_enforced` fails without anyone writing a rule about that particular
sentence.

**2 — document freshness.** The committed `docs/repository-truth.json` must equal a
fresh generation, or `TRUTH_DOCUMENT_STALE`, with the facts that moved named in the
message.

**3 — machine-code vocabulary.** Every `SCREAMING_SNAKE` identifier in a bound
surface must exist in the source vocabulary harvested from `packages/`, `scripts/`,
`apps/`, `examples/` and `benchmarks/`, or be a repository file's basename, or be an
angle-bracketed metavariable (`<ERROR_CODE>`). Otherwise `TRUTH_CODE_UNKNOWN`.

That third rule is the one lexical rule kept from the rejected "more grep rules over
prose" option, and it is kept for two reasons: it matches **identifiers**, never
wording, and the vocabulary is **harvested** rather than hand-listed, so nothing has
to be maintained and a code deleted from the code fails every document still naming
it. It is exactly the `TENANT_ISOLATION_NOT_ENFORCED` regression, written as a rule
— and it binds `docs/PROJECT_STATUS.md`, `TASKS.md` and every scenario document with
**no marker at all**, which is why none of them was edited.

## What is bound, and what is deliberately historical

Bound: `README.md`, `PRODUCT.md`, `AGENTS.md`, `CLAUDE.md`, `TASKS.md`,
`docs/PROJECT_STATUS.md`, `docs/CODER_TOOLING_ROADMAP.md`, `docs/QUALITY_GATES.md`,
this file, `docs/strategy/EXECUTION_ROADMAP.md`,
`docs/benchmarks/CRM_JTBD_MATRIX.md`, `docs/benchmarks/jobs.json`,
`site/claims.json`, `site/assets/llms.txt`, `site/assets/llms-full.txt` and every
`examples/scenarios/*.scenario.json`.

Excluded **by path rule, never by heuristic**: `DECISIONS.md` (dated ADRs),
`docs/plans/**`, `benchmarks/**`, `docs/transcripts/**`, `site/blog/**`,
`docs/editions/**`, and everything in `scripts/measurement.js`'s `DATED_HISTORY`. A
dated ADR, an ExecPlan, a benchmark receipt and a blog post preserve what was true
when they were written, and rewriting them to satisfy a checker would be falsifying
history.

## What v1 does not do

Published in the document's own `limitations[]`, by code:

| Code | Means |
|---|---|
| `TRUTH_IS_SOURCE_AND_RECEIPTS_NOT_RUNTIME` | nothing here reports what a deployed instance is doing |
| `REFERENCE_COMPOSITION_NOT_THE_PROJECT` | `packages/domains/generated/index.js` is empty here, so package facts describe a **reference** composition of the nine checked-in packages, not this checkout's |
| `JTBD_ROWS_NOT_ENCODED` | no job status is a fact; only a person moves one |
| `NO_SCENARIO_RECEIPT_AVAILABLE` | `scenario run` writes nothing into the project, so this repository checks in no scenario receipt and scenario evidence is not an authority in v1 |
| `IMPLEMENTATION_EVIDENCE_NOT_AN_AUTHORITY` | the checked-in evidence documents describe other applications' compositions, so their fingerprints cannot be checked here |
| `MEASUREMENT_DESCRIBES_COMMITTED_TREE` | the measurement facts compare git trees, so an uncommitted change to `tests/` does not move them |
| `MEASUREMENT_FACTS_ARE_GENERATED_BUT_NOT_CITED` | the measurement facts are generated and provenance-checked, but no document cites one: a citation would resolve differently in a shallow clone, and the document would fail for a reason that has nothing to do with what it says |
| `CITATIONS_ARE_OPT_IN` | a sentence with no citation is not checked, and this contract cannot discover which sentences ought to have one |
| `WORDING_IS_NOT_GENERATED` | no prose is written or rewritten; a fact constrains what a bound sentence may assert, it does not produce the sentence |
| `EDITIONS_NOT_BOUND` | `docs/editions/**` is outside the bound set in v1 |

## Where it runs, and where it deliberately does not

`repo:truth` is **standalone in v1**. It is not in `npm run verify` and not in
`npm run gtm:check`, for one measured reason: its measurement checks need full git
history, `gtm:check`'s `public-claims` CI job has `fetch-depth: 0` but the `verify`
job does not, and wiring a fail-closed history check into a shallow job would turn a
truth gate into a flake.

The deterministic, git-free half **is** covered by `verify`:
`tests/repository-truth-contract.test.js` runs inside `npm test` and asserts the
document against its authorities, every citation across every bound surface, and each
negative rule against the mutation that must fail it. Where full history is
available it asserts the measurement facts too; where it is not, it asserts the
**refusal** instead of skipping — and the file was run in a real `--depth 1` clone
to prove it, because a test that quietly stops testing in CI is the same class of
failure this contract exists to close.

Promoting `repo:truth` into `gtm:check` is v2 work, and it needs the CI job to be
given full history first.

## The measured ledger is visibly stale, and that is the design

`site/claims.json` `measuredAgainst` names a commit that **is** a genuine ancestor of
`HEAD`, and `tests/` has moved since. So:

```text
measurement.source_is_ancestor   true      (provenance intact)
measurement.test_tree_current    false     (the corpus moved)
measurement.source_sha           status: stale
measurement.test_count           status: stale
measurement.test_file_count      status: stale
```

Nothing here fails because of that, and nothing papers over it. ADR-027 already
settled that a record naming its own ancestor commit is truthful even when the suite
has since moved; what must not exist is a *sentence* quoting a stale number as
current, and the citation check is what makes writing one fail. Re-measure with
`node scripts/measure-suite.js --apply` on a clean tree and the three `stale`
statuses become `current` in the same regeneration.

## Related

`DECISIONS.md` ADR-039 (the four options and why C) · ADR-027 (the measurement
record and its provenance) · ADR-038 (what the spine owns and what it does not) ·
`docs/QUALITY_GATES.md` §6 · `docs/plans/repository-truth-contract-v1.md` ·
`scripts/repo-truth.js` · `tests/repository-truth-contract.test.js`.
