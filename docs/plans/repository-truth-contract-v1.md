# Repository Truth Contract v1 — bind current product claims to executable facts

**Status:** implemented on `claude/repository-truth-contract-v1`.
**ADR:** ADR-039 (`DECISIONS.md`).
**Branch point:** `aa1359f` (`origin/main`).

## 1. Goal and user-visible outcome

One deterministic, machine-readable **product-fact document** — generated from
runtime, package, schema, CLI, benchmark and measurement authorities — plus a
repository-maintainer script that regenerates it and checks that the
repository's *current* claims still agree with it.

```console
$ npm run repo:truth              # regenerate docs/repository-truth.json
$ npm run repo:truth -- --check   # fail when the repository and the facts disagree
```

A maintainer or coding agent gets one answer to *"is what this repository says
about itself still true of the code?"* — and, when it is not, a machine-readable
reason naming the fact, the authority, the document and the line.

This is **not** a new Accordo rail and **not** a public product command. It is a
repository-maintenance script beside `scripts/measurement.js`,
`scripts/generate-jobs.js` and `scripts/generate-llms.js`, and it never leaves
this repository: a generated project has no claims ledger, no JTBD matrix and no
status file.

## 2. The failure this exists to close

Measured twice in this repository in the two days before this plan was written:

```text
code implemented Production Spine v1
  → schema/runtime truth changed
  → PROJECT_STATUS / JTBD / claims / scenario limitation metadata stayed
    MUTUALLY CONSISTENT but stale
  → every existing gate passed
```

Two concrete instances, both real, both fixed by hand afterwards:

1. `app inspect` published `productionPosture: "no authentication, tenancy or
   RBAC exists"` in the **same report** whose `PRODUCTION_SPINE_ABSENT` message
   described identity, tenancy and authorization. Fixed in PR #101.
2. The `tenant-isolation-and-authorization` scenario published
   `TENANT_ISOLATION_NOT_ENFORCED` and *"the framework does NOT enforce it"*
   **after** ADR-038 Amendment 2 closed F-2 by binding. Fixed in PR #102, found
   by a person reading the file, not by a gate.

**The design driver, stated once:**

> Existing gates check consistency *between* documents. These documents were
> consistently wrong *together*.

`scripts/measurement.js` compares two literal strings (`PROJECT_STATUS.md`'s
`Measured at` row against `site/claims.json`). `scripts/site-check.js` matches a
numeric pattern. `scripts/generate-jobs.js` regenerates one index from one
Markdown source. None of them has any tie to what the code does, so all three
stayed green while the code moved out from under the prose.

## 3. Current repository context

| Surface | What it already is |
|---|---|
| `packages/core/src/identity.js` | `IDENTITY_CONTRACT`, the four identity kinds |
| `packages/core/src/tenant-storage.js` | `TENANT_STORAGE_CONTRACT`, `TENANT_STRATEGY`, `TENANT_LIMITATIONS`, `createTenantStorage`, `bindTenantStorage` |
| `packages/core/src/runtime-mode.js` | `MODE_ENV = 'ACCORDO_MODE'`, the two modes, no default |
| `packages/app/src/spine.js` | `SPINE_CONTRACT = 2`, `PERMISSIONS`, `ROLE_BUNDLES`, `describe()` and its `notModeled` list |
| `packages/core/src/package-composition.js` | `resolvePackageComposition` — the one function that decides what a valid composition is |
| `packages/cli/src/*-command.js` | one handler module per rail |
| `packages/cli/src/scenario-journey.js` | the frozen journey registry: clocks and journey-scoped limitation codes |
| `benchmarks/tool-selection/panel-v2-2026-08-18/` | a frozen protocol and an aggregate — a real recorded receipt |
| `site/claims.json` | `claimsContract: 2`, `measuredAgainst`, 23 claims, 11 limitations |
| `scripts/measurement.js` | provenance and loose-count rules (ADR-027 + addendum 1) |

Two facts about the current tree that this plan must not paper over:

- `packages/domains/generated/index.js` exports an **empty** `generatedDomains`.
  `app inspect` on the repository root therefore reports **zero packages**. Any
  package-level fact must come from an explicitly named **reference
  composition**, and the document must say so.
- `site/claims.json` `measuredAgainst` names `e30216c` with 1480 tests over 131
  files. That commit is a genuine ancestor of `aa1359f`, but `tests/` has moved
  since: `e30216c:tests` is `8f11127f…` and `HEAD:tests` is `f41904c2…`. The
  ledger is **provably stale in its corpus** and provably honest in its
  provenance, and the facts must publish both.

## 4. Architecture — four options, and why C

| Option | Verdict |
|---|---|
| **A — more grep rules over prose** | **Rejected as the primary design.** It misses reworded falsehoods. Instance 2 above is exactly what a phrase-matching rule misses, and it makes truth depend on phrasing. |
| **B — one hand-maintained status JSON** | **Insufficient alone.** A human can update it independently of the code, which is the failure itself. It would have been updated in the same pass that left the scenario metadata stale. |
| **C — generated executable product facts + cited stable fact IDs** | **Chosen.** Runtime, package, schema, CLI, benchmark and measurement authorities generate the facts; current documents cite stable fact ids or are checked against the generated vocabulary. |
| **D — an LLM semantic reviewer as a deterministic merge gate** | **Rejected.** A gate must be reproducible byte-for-byte offline. It may return later as a non-blocking reviewer; never as the gate. |

One bounded lexical rule survives from A and is kept **deliberately**: the
*machine-code vocabulary* check (§7.3). It matches **identifiers**, never
wording, and the vocabulary it matches against is **harvested from source**
rather than hand-listed — so it needs no maintenance and it fails the moment a
code is deleted from the code and left standing in a document. That is instance
2, and it is the one rule that would have caught it.

## 5. `repositoryTruthContract: 1`

`docs/repository-truth.json`, generated, committed, and regenerated by
`npm run repo:truth`.

```json
{
  "repositoryTruthContract": 1,
  "sourceSha": "<sha256 over the authority source set>",
  "authorities": [ { "id": "…", "kind": "source|receipt|measurement", "…": "…" } ],
  "facts": [ { "id": "…", "value": "…", "authority": "…", "evidence": […],
               "scope": "…", "status": "…", "limitations": […] } ],
  "limitations": [ { "code": "…", "message": "…" } ],
  "fingerprint": "<sha256 over the semantic body>"
}
```

- **`sourceSha` is not a commit id.** A commit id would move on every merge and
  make the document stale the moment it was committed. It is a SHA-256 over the
  sorted `(path, content-hash)` pairs of the **authority source set** — the
  exact files the facts are derived from. It moves when an authority moves and
  stays put when anything else does.
- **Closed vocabularies.** `value` for a capability fact is one of
  `implemented · absent · enforced · enforced_by_binding · refused_at_startup ·
  one_tenant_per_instance · package_native · core_native · not_measured ·
  not_applicable · unknown`, or a bounded numeric/string literal for a
  measurement fact. `status` is `current · stale · unknown`. `scope` is
  `framework · package · repository · measurement`. `kind` on an authority is
  `source · receipt · measurement`.
- **No free-form executable content, no secrets, no absolute paths, no
  timestamps.** No timestamp exists anywhere in the document, not merely outside
  the fingerprint — two runs over the same checkout produce byte-identical
  bytes from different working directories.

## 6. Authorities, kept in three labelled kinds

**Source-derived** — read from checked-in source, deterministic, real-time:

| Authority | Read as |
|---|---|
| `spine.contract` | `SPINE_CONTRACT`, `PERMISSIONS`, `ROLE_BUNDLES`, `SPINE_NOT_MODELED` |
| `identity.contract` | `IDENTITY_CONTRACT`, the four kinds |
| `tenant.storage` | `TENANT_STORAGE_CONTRACT`, `TENANT_STRATEGY`, `TENANT_LIMITATIONS`, and a **structural probe** of `bindTenantStorage()`'s own returned shape |
| `runtime.mode` | `MODE_ENV`, and that the mode has no default |
| `reference.composition` | the nine checked-in domain packages composed through `resolvePackageComposition` — the same function `PackageRegistry` throws from at startup |
| `cli.rails` | the CLI dispatch table **and** the handler modules' exports, which must agree |
| `code.vocabulary` | every `SCREAMING_SNAKE` identifier appearing anywhere under `packages/`, `scripts/`, `apps/`, `examples/` and `benchmarks/` |

**Receipt-derived** — read from a recorded run, and **verified rather than
trusted**:

| Authority | Read as | Verified by |
|---|---|---|
| `benchmark.tool_selection` | `aggregate.json` `comparative` | `protocolFingerprint`, `instrumentFingerprint` and `baseSha` must equal the frozen protocol's. A mismatch fails closed. |

**Measurement-derived** — read from the measured ledger and from git:

| Authority | Read as |
|---|---|
| `measurement.ledger` | `site/claims.json` `measuredAgainst` |
| `measurement.git` | ancestry of the recorded SHA, and `tests/` tree at that SHA versus at `HEAD` |

The three kinds are separate keys in `authorities[]`, and every fact names
exactly one of them. A fact never blends kinds.

## 7. Fact inventory for v1 — deliberately narrow

**Spine (9)** — `spine.identity.contract` · `spine.authentication.framework_verifier` ·
`spine.authorization.enforced` · `spine.tenant.isolation.mode` ·
`spine.tenant.crm_data_plane_enforced` · `spine.multi_tenant_single_instance` ·
`spine.postgresql.implemented` · `spine.durable_jobs.implemented` ·
`spine.secrets_backups.implemented`.

**Domain packages (9)** — `domain.<name>.package_native` for commercial,
contracts, customer-data, delivery, intelligence, lifecycle, service, signature
and work.

**Rails (8)** — `rail.app_inspect.implemented` · `rail.solution_check.implemented` ·
`rail.project_doctor.implemented` · `rail.package_scaffold.implemented` ·
`rail.package_test.implemented` · `rail.project_verify.implemented` ·
`rail.scenario_run.implemented` · `rail.solution_verify.implemented`.

**Product limits (5)** — `cdf.full_cdp.implemented` ·
`customer_timeline.complete` · `billing.implemented` ·
`marketing_runtime.implemented` · `cloud_control_plane.implemented`.

**Measurement (5)** — `measurement.source_sha` · `measurement.test_count` ·
`measurement.test_file_count` · `measurement.source_is_ancestor` ·
`measurement.test_tree_current`.

**No JTBD row is encoded in v1.** 149 rows maintained by people, promoted only
by a person under `docs/QUALITY_GATES.md` §3, are not a fact a generator may
own.

### 7.1 The rule a reviewer will attack first

> **A fact never silently defaults from a missing authority, and `false` is
> never inferred from absence unless the contract defines that meaning.**

Three consequences, each implemented rather than promised:

- An authority that cannot be read produces `TRUTH_AUTHORITY_UNAVAILABLE` and
  a non-zero exit. It does not produce `unknown` facts and carry on.
- Two authorities that disagree produce `TRUTH_AUTHORITIES_CONTRADICT` and a
  non-zero exit. The rails are the live case: the dispatch table and the handler
  exports are read separately and must agree.
- Where absence *is* the meaning, the contract says so **by name**. Two such
  rules exist and no others:
  - **`declared-absence`** — the value comes from a list the source *declares*
    as not modelled (`SPINE_NOT_MODELED`, `TENANT_LIMITATIONS`, the journey
    registry's limitation codes). This is reading a declaration, not inferring
    from silence.
  - **`namespace-probe`** — a `product.*` fact is `absent` when **no** resource,
    action, capability or policy in the reference composition carries the
    namespace prefix the contract declares for it. The prefixes are in the
    document, the probe is over a composition that resolved without problems,
    and the contract states that this is what `absent` means here.
  - `not_measured` for the build benchmark is a statement *about measurement*.
    The absence of a measurement is measurement's absence; it is not a claim
    that the thing measured is false.

### 7.2 Real-time facts versus frozen-evidence facts

Published per fact and summarised here:

- **Real-time source facts** (31 of 36): recomputed from checked-in source on
  every run. Stale is impossible; disagreement is a failure.
- **Frozen-evidence facts** (5): `benchmark.*` and the `measurement.*` set.
  These read a record of something that happened. Each carries its own
  verification — fingerprint equality for the benchmark, ancestry and tree
  identity for the measurement — so a stale record is *detected* rather than
  trusted.

### 7.3 The three checks over documents

1. **Fact citation** — `<factId>=<value>`, in a Markdown HTML comment
   (`<!-- truth: spine.postgresql.implemented=absent -->`) or in a JSON
   `facts: []` array. An unknown id is `TRUTH_FACT_UNKNOWN`; a cited value that
   differs from the generated one is `TRUTH_FACT_VALUE_STALE`. A reversed
   polarity is a value that differs, so it is the same failure.
2. **Document freshness** — the committed `docs/repository-truth.json` must
   equal a fresh generation. Otherwise `TRUTH_DOCUMENT_STALE`.
3. **Machine-code vocabulary** — every `SCREAMING_SNAKE` identifier in a bound
   surface must exist in the source vocabulary or be the basename of a file in
   the repository. Otherwise `TRUTH_CODE_UNKNOWN`. There is no third exemption:
   review re-measured the claim that "one token needed the metavariable rule"
   and found the count is **zero** — the one candidate, `ERROR_CODE`, is
   declared in source and was already in the harvested vocabulary. The
   angle-bracket strip that rested on that measurement let
   `<TENANT_ISOLATION_NOT_ENFORCED>` through and was removed.

### 7.4 Bound surfaces, and the historical exclusions

Bound: `README.md`, `PRODUCT.md`, `AGENTS.md`, `CLAUDE.md`, `TASKS.md`,
`docs/PROJECT_STATUS.md`, `docs/QUALITY_GATES.md`, `docs/REPOSITORY_TRUTH.md`,
`docs/CODER_TOOLING_ROADMAP.md`, `docs/strategy/EXECUTION_ROADMAP.md`,
`docs/benchmarks/CRM_JTBD_MATRIX.md`, `docs/benchmarks/jobs.json`,
`site/claims.json`, `site/assets/llms.txt`, `site/assets/llms-full.txt`,
`examples/scenarios/*.scenario.json`, and — added in review —
`packages/cli/src/app-inspect.js`, whose `productionPosture` string is the
product claim that failed as instance 1 in §2.

Excluded **by path rule, never by heuristic**: `DECISIONS.md` (dated ADRs),
`docs/plans/**`, `benchmarks/**`, `docs/transcripts/**`, `site/blog/**`,
`docs/editions/**` (owned by another branch this wave) and everything named in
`scripts/measurement.js`'s `DATED_HISTORY`. Those preserve what was true when
they were written.

## 8. Milestones

1. **The contract and the generator.** `scripts/repo-truth.js`, the authority
   readers, `docs/repository-truth.json`, `npm run repo:truth`.
2. **The checker.** `--check`: regeneration diff, citation resolution, code
   vocabulary, measurement provenance.
3. **Binding.** Fact citations added to `README.md`, `PRODUCT.md`,
   `site/claims.json`, `docs/CODER_TOOLING_ROADMAP.md` and
   `docs/strategy/EXECUTION_ROADMAP.md`. `docs/PROJECT_STATUS.md`, `TASKS.md`
   and `docs/editions/**` are **not edited**: they are bound by the code
   vocabulary rule, which requires no marker at all.
4. **Negative tests.** `tests/repository-truth-contract.test.js` — every rule
   driven by a mutation that must fail it.
5. **Documentation.** ADR-039, `docs/REPOSITORY_TRUTH.md`, `docs/QUALITY_GATES.md`
   §6, `AGENTS.md`, `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`.

## 9. Validation

```console
npm run repo:truth -- --check
npm run verify
npm run smoke
npm run gtm:check
npm run crm -- app inspect --json
npm run crm -- project doctor --json
npm run crm -- project verify --json
```

## 10. Decision log

- **`repo:truth` stays out of `verify` and `gtm:check` for v1.** Its
  measurement checks need full git history; `gtm:check`'s `public-claims` CI job
  has `fetch-depth: 0` but the `verify` job does not, and wiring a fail-closed
  history check into a shallow job would turn a truth gate into a flake. The
  deterministic, git-free half is wired into `npm test` through
  `tests/repository-truth-contract.test.js` instead, so `verify` does cover it.
  B10 permits leaving it standalone if in doubt; this is the stated doubt.
- **No edit to `docs/PROJECT_STATUS.md` or `TASKS.md`.** The code-vocabulary
  rule binds them with zero edits, which is strictly less invasive than a
  marker.
- **No edit to `examples/scenarios/*.scenario.json`.** The scenario document
  contract has a **closed key allow-list**; a `truth` key would be refused as
  `SCENARIO_FIELD_UNKNOWN`. Scenario limitation metadata is bound by the code
  vocabulary rule instead — which is precisely the instance-2 regression.
- **One product-source change.** `packages/app/src/spine.js`'s `notModeled`
  array is hoisted to an exported `SPINE_NOT_MODELED` constant, spread into
  `describe()`. Zero behaviour change; it makes a declaration readable without
  booting an application, which is what turns it into an authority.
- **`measurement.test_tree_current` is allowed to churn.** When `tests/` moves
  after a measurement the fact flips `true → false` once, and stays `false`
  until someone re-measures. That single flip in a diff is the point.

## 11. Progress log

- Read `AGENTS.md`, `PRODUCT.md`, `ARCHITECTURE.md`, ADR-027/032/036/037/038,
  `docs/QUALITY_GATES.md`, `docs/APPLICATION_INSPECTION.md`,
  `docs/SCENARIO_EVIDENCE.md`, `docs/IMPLEMENTATION_EVIDENCE.md`.
- Measured the code-vocabulary rule against the bound corpus before committing
  to it: 72 distinct `SCREAMING_SNAKE` tokens, 1 unresolved after the
  file-basename and metavariable rules. Review re-measured it: that one token,
  `ERROR_CODE`, is in the harvested vocabulary, so the metavariable rule
  resolved nothing and has been removed.
- Measured the reference composition: nine packages, zero problems, 178 ms
  including process start.
- Confirmed the ledger's staleness is real and detectable: `e30216c` is an
  ancestor of `aa1359f`, and `e30216c:tests` ≠ `HEAD:tests`.
- Implemented milestones 1–3 (contract, generator, checker, binding).
- Implemented milestone 4: `tests/repository-truth-contract.test.js`, 39 tests,
  every negative rule driven by the mutation that must fail it.
- Implemented milestone 5: ADR-039, `docs/REPOSITORY_TRUTH.md`,
  `docs/QUALITY_GATES.md` §6.1, `AGENTS.md` rule 17, `CLAUDE.md`, and the
  Compatibility Backfill assessment in
  `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`.
- **Adversarial review, in place on this branch (ADR-039 Amendment 1).** Five
  defects confirmed with runnable probes and fixed with the mutation that must
  fail each one: the gate ran in no CI job at all and now runs in
  `public-claims`; `<TENANT_ISOLATION_NOT_ENFORCED>` in angle brackets passed
  the machine-code rule in `README.md` and `site/assets/llms.txt`; the two
  declared-absence facts resting only on a `SPINE_NOT_MODELED` sentence could be
  outlived by the code and now carry a namespace probe as a second authority;
  the JSON citation grammar was wider than the one three documents publish; and
  the stale-document message blamed evidence that had not moved. Two published
  inventories were corrected — the explainer listed ten of eleven limitation
  codes, and `README.md` claimed every boundary carried a citation when three
  carry none — and a twelfth limitation, `NUMERIC_CLAIMS_NOT_BOUND`, was added
  because no cited fact is a count. The largest finding was scope rather than
  code: v1 closed one of the two failures §2 names. Instance 1's sentence lives
  in `packages/cli/src/app-inspect.js`, in no bound surface and covered by no
  fact, so restoring it in a clean clone left `--check` green. That file is now
  bound, and the citation grammar takes `// truth: id=value` on a bound `.js`
  surface. CI then caught the suite being flaky at one commit — 1527/1527 on one
  runner, 1526/1527 on the other, failing only in a fixture's `t.after` — and the
  throwaway directories now retry their removal and never fail a run whose
  assertions passed.

### Three things the work changed about the plan

1. **Fatal and deferred problems are separated.** CI runs `npm run verify` at
   `actions/checkout`'s default `fetch-depth: 1`. As first written, an
   unprovable measurement collapsed the *whole* document, so the citation and
   machine-code rules would have stopped running in the one job that runs on
   every push. A source authority that cannot be read is still fatal; a receipt
   or measurement that cannot be verified now refuses **its own** facts, fails
   the run, and leaves the source facts standing. The test file was then run in
   a real `git clone --depth 1` and passes there too, asserting the refusal
   rather than skipping.
2. **No document cites a measurement fact.** `site/claims.json` briefly cited
   `measurement.source_is_ancestor=true`; in a shallow clone that fact reads
   `unknown` and the citation failed for a reason that had nothing to do with
   the sentence. Measurement facts are generated and provenance-checked, and
   the boundary is published as `MEASUREMENT_FACTS_ARE_GENERATED_BUT_NOT_CITED`.
3. **A contradiction withdraws the fact.** Two of the three contradiction paths
   originally left the first authority's answer in `facts[]` beside a problem.
   A reader of `facts[]` would have seen a value two authorities could not agree
   on — this contract's own failure mode, reproduced inside it. All three now
   remove the fact.

### The validation pass, and the four things it found

A second pass ran the attacks the two accepted extensions were scoped by, rather
than reading the code for them. Four findings, each with the probe that
reproduces it and the mutation that now fails.

1. **Binding the posture sentence did not close instance 1.** The paragraph above
   records that it did. A citation binds a **value**: reversing one of the
   `// truth:` lines fails, and that is the whole of what they prove. Pasting
   *"no authentication, tenancy or RBAC exists"* back into `productionPosture`
   with the citations untouched exited **0**. `RETIRED_CLAIMS` now holds that one
   recorded claim across every bound surface, on the terms `RETIRED_CODES` holds
   a retired code, with a `truth: retired-claim <claim> — why` declaration for
   the two surfaces that name it as history — and in a `.js` surface that
   declaration reaches **comment lines only**, because a file-scoped one excused
   the published string as readily as the paragraph about it. A benign rewording
   that keeps the bounded meaning still passes. The boundary is published as
   `POSTURE_PROSE_NOT_GENERATED`: this holds the falsehood that *is* in the
   record, not the set of all falsehoods, and generating the sentence is v2.
2. **A symlink widened the path allowlist, silently.** `BOUND_SURFACES` is a
   frozen literal list, so nothing in the script can traverse; the filesystem
   can. Replacing `packages/cli/src/app-inspect.js` with a symlink to a file
   outside the repository made *that* file's citations the ones the gate read,
   and pointing it at a citation-free file dropped the count from 95 to 88 and
   left `--check` **green** with the false posture sitting in the target. Every
   bound surface and authority source is now checked to be repository-relative,
   `..`-free and reachable without traversing a symlink at any component — a
   parent directory included. `TRUTH_SURFACE_UNSAFE`, refused rather than skipped.
3. **The grammar read its own examples, and ignored its own typos.** A string
   literal quoting `// truth: id=value` inside the bound `.js` surface became a
   citation; `// truth: id -> value` matched nothing and was silently not one.
   Own-line comments only, and `TRUTH_CITATION_MALFORMED` — a code already
   declared in `TRUTH_PROBLEMS` that had never been emitted.
4. **The cleanup compromise was half-implemented.** Retry-and-warn was in; the
   suite-level residual gate was not, so a *permanent* leak was invisible.
   `tests/helpers/scratch.js` gives the run one `mkdtemp` scratch root, creates
   every fixture inside it, registers what a per-test cleanup could not remove,
   and after every test in the file retries once and then **fails**
   deterministically on a directory or a program still inside that root. It
   deletes nothing outside the root — the guard is exercised, not asserted —
   kills nothing, and names residue by **class** (`accordo-truth-fixture-`,
   `git`), never by absolute path, because a CI log is machine-facing and public.
   `tests/helpers/scratch-concurrency-probe.js` runs two of these side by side,
   in both orders, and proves each survives the other's full sweep; swapping the
   sweep for a `/tmp` glob makes that probe fail, which is what makes it evidence.

   **Scope, stated rather than implied:** the helper is adopted by the one file
   whose teardown this ADR's amendment is about. Fifty-nine other test files
   still create their own `mkdtemp` directories under `os.tmpdir()` and tear them
   down by hand, so a leak in any of those is still invisible. Moving them onto
   the helper is mechanical and broad, it touches every domain suite, and it does
   not belong inside a validation pass — it is named here so the next person
   finds it written down rather than discovering it.

**Still a hypothesis, and left as one.** The detached `git gc --auto` explanation
for the original teardown race is unchanged and unpromoted: `gc.auto=0` and
`maintenance.auto=false` are set on the theory that it is the writer, the race
never reproduced locally in 75 rounds under three concurrent workers, and the new
gate reports *what* is left, never *why*.

**Numeric binding stays v2, and the limitation was reworded rather than
implemented.** The published `NUMERIC_CLAIMS_NOT_BOUND` was wrong twice:
`spine.identity.contract=1` is a cited integer, so §6.1's "no number is checked"
was false; and typed *test* counts are not unchecked at all —
`findLooseTestCounts` holds them inside `gtm:check` — so listing them first among
the things "outside this contract" read as the opposite of the case. Requiring a
number to carry a fact means telling a load-bearing current count from a date, an
ADR number, a currency example, a receipt's raw count and a digit inside a code
fence. `findLooseTestCounts` needed two hand-tuned negative lookbehinds to
survive widening from `site/` to `docs/` for **one** noun; seven nouns across
twenty-one surfaces is a new gate with its own false-positive budget, and it needs
count-shaped facts that do not exist yet.

## 12. Outcome and follow-up

Measured on `claude/repository-truth-contract-v1`:

- `docs/repository-truth.json` — 38 facts from 9 authorities (6 source, 1
  receipt, 2 measurement), 13 published limitations.
- 97 citations across 21 bound surfaces, one of which is source: the `app inspect`
  `productionPosture` sentence, which is the first of the two failures in §2. It
  carries nine now, having asserted the identity-contract seam and shared-database
  tenancy while citing nothing for either.
- `npm run repo:truth -- --check`: **~0.5 s** wall clock, one app-composition
  build and no scenario run, run as its own step in the `public-claims` CI job
  on every push and every pull request.
- `tests/repository-truth-contract.test.js`: 58 tests, ~3.5 s, passing in both a
  full-history checkout and a `--depth 1` shallow clone.

**Deliberately out of v1:** JTBD rows, `docs/editions/**`, any scenario-run
receipt (this repository checks none in: `scenario run` writes nothing into the
project), `solution verify` evidence as an authority (the evidence documents
describe *other* applications' compositions, so their fingerprints cannot be
checked against this repository), citation of any measurement fact, PostgreSQL,
durable jobs, and any wording generation beyond citation.

**Follow-up for v2:** fold `repo:truth -- --check` into `npm run gtm:check`
itself, which needs `gtm:check` to stop being something a developer runs in a
shallow clone; bind `docs/editions/**` once its owner merges; decide whether a
non-blocking LLM reviewer (option D) is worth adding beside the deterministic
gate, never inside it.
