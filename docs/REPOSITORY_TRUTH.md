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
| `storage.contract` | the M1 contract constant; Company `create/get/list` executed through the real SQLite adapter; generated public and managed services executed against their generated schemas; and the Work legacy migration's structured-read probe |
| `reference.composition` | the nine checked-in domain packages composed through `resolvePackageComposition` — the same function `PackageRegistry` throws from at startup |
| `cli.rails` | the CLI dispatch table **and** each handler module's export, which must agree |

| `jtbd.portfolio` | the desired-state catalogue and the two overlays beside it, **counted** |

The last one is worth its own sentence, because it looks like the thing this contract refuses.
`JTBD_ROWS_NOT_ENCODED` still holds: no job status is a fact here, and nothing reads a coverage
status and turns it into a value. What `jtbd.portfolio` publishes is six **summary counts** —
how many desired jobs exist, whether the coverage overlay covers all of them, how many are
claimed by no milestone, how many non-default coverage rows cite no desired job, and how many
positive coverage rows carry no evidence. The last is the one that matters. It must stay `0`,
and hand-typing it is exactly how it would stop being `0` with every gate green. Per-job
validation stays in `scripts/jtbd-gate.js`, where it belongs, and the six facts each carry
`JTBD_ROWS_NOT_ENCODED` in their own `limitations[]` so a reader meets the boundary in the
document rather than discovering it.

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

**Storage facts are bounded executable probes, not repository-wide extraction claims.**
The Company probe executes only `create`, exact `get` and `list` against an isolated
SQLite schema through the M1 adapter. The synthetic generated probes execute public
string, nullable-string, enum and boolean paths, managed enum paths, the closed
predicate shapes, and complete mutation/readback checks against their generated
schemas. They prove those selected runtimes and the generator template use the
contract; they do not claim every checked-in generated service is migrated. The Work
probe deliberately detects that `legacy-tasks.js` still reaches the raw migration
source, so it remains visible M2 residue rather than being mistaken for alignment.

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
    silence, and a declaration that has gone is a failure, not a default. **Every
    declared-absence fact also carries a second authority read from the code** —
    the manifest's production dependencies for PostgreSQL, a namespace probe for
    durable jobs and for secrets/backups, the journey limitation code for billing
    — because a hand-maintained English sentence only ever answers "does the list
    still say this". Deleting the sentence refuses the fact; *building* the thing
    and leaving the sentence standing has to fail too, or the claim outlives the
    code, which is what this whole contract is against.
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

**1 — fact citation.** `<!-- truth: <id>=<value> -->` in Markdown, a
`"facts": ["<id>=<value>"]` array in JSON, or `// truth: <id>=<value>` in a bound
`.js` source file. One grammar, one parser, three comment characters. The Markdown
form is an HTML comment, so it is invisible when a page renders and load-bearing
when the checker runs. The JavaScript form is applied **only** to a `.js` file in
the bound set, so `// truth: …` in a fenced example inside a document stays an
example.

The JavaScript form is read from a line that is **nothing but** that comment, so a
string literal quoting the grammar stays a string literal — it used to become a
citation nobody wrote. And a `truth:` directive that is not one of the three legal
forms is **refused**, not ignored: `// truth: <id> -> <value>` matched no pattern,
so a typo turned a load-bearing citation off with no signal at all.

The bound set is a frozen list of repository-relative paths, and it is enforced as
one. A path that is absolute, carries a `..` segment, or reaches its file through a
symbolic link at **any** component is `TRUTH_SURFACE_UNSAFE` and is refused rather
than read: a symlink at `packages/cli/src/app-inspect.js` pointed the gate at a file
outside the repository, and pointed at a citation-free file it dropped that
surface's citations and left `--check` green. The same check guards every authority
source, which is imported as well as hashed.

- an id nothing resolves → `TRUTH_FACT_UNKNOWN`
- a cited value the authority no longer produces → `TRUTH_FACT_VALUE_STALE`
- a directive no rule reads → `TRUTH_CITATION_MALFORMED`
- a bound path the filesystem can redirect → `TRUTH_SURFACE_UNSAFE`

A reversed polarity is a value that differs, so it is the same failure — which is the
point: a document that says `enforced` about something the code now leaves
`declared_not_enforced` fails without anyone writing a rule about that particular
sentence.

**2 — document freshness.** The committed `docs/repository-truth.json` must equal a
fresh generation, or `TRUTH_DOCUMENT_STALE`, with the facts that moved named in the
message.

**3 — machine-code vocabulary.** Every `SCREAMING_SNAKE` identifier in a bound
surface must exist in the source vocabulary harvested from `packages/`, `scripts/`,
`apps/`, `examples/` and `benchmarks/`, or be a repository file's basename.
Otherwise `TRUTH_CODE_UNKNOWN`. There are **only those two** exemptions: a
metavariable written `<ERROR_CODE>` is legal because `ERROR_CODE` is declared in
source, not because angle brackets excuse a name. v1 stripped angle-bracketed
tokens before looking, which let `<TENANT_ISOLATION_NOT_ENFORCED>` pass in
`README.md` and in `site/assets/llms.txt` — where it renders literally — and
disarmed the rule that exists because that code survived its own fix.

That third rule is the one lexical rule kept from the rejected "more grep rules over
prose" option, and it is kept for two reasons: it matches **identifiers**, never
wording, and the vocabulary is **harvested** rather than hand-listed, so nothing has
to be maintained and a code deleted from the code fails every document still naming
it. It is exactly the `TENANT_ISOLATION_NOT_ENFORCED` regression, written as a rule
— and it binds `docs/PROJECT_STATUS.md`, `TASKS.md` and every scenario document with
**no marker at all**, which is why none of them was edited.

## One bound surface is source, and why

<!-- truth: retired-claim no authentication, tenancy or RBAC exists — this section quotes the retired posture as the recorded failure the rule exists to catch. Named as history, never asserted about this repository. -->

`packages/cli/src/app-inspect.js` is in the bound set. `productionPosture` is a
hand-written English sentence that `app inspect` publishes to every agent that asks
what this framework is, and it is the **first** of the two failures in the record:
it read "no authentication, tenancy or RBAC exists" in the same report whose
`PRODUCTION_SPINE_ABSENT` message described identity, tenancy and authorization, and
a person found it (PR #101). v1 of this contract bound twenty documents and left that
sentence out of all of them. It carries nine citations now.

**Citations alone did not close that failure, and the record has to say so.** A
citation binds a **value**: reversing `spine.authorization.enforced=enforced` to
`=absent` fails, which is what the nine `// truth:` lines above the sentence
actually prove. They say nothing about the *sentence underneath them*, so pasting
the historical falsehood back into `productionPosture` and leaving the citations
untouched left `repo:truth -- --check` **green** — measured, not reasoned about.
Two rules close it, and neither reads prose:

- **`RETIRED_CLAIMS`** holds the one recorded false posture across every bound
  surface, on exactly the terms `RETIRED_CODES` holds a retired code: a short
  list, each entry a reviewable edit with an argument attached, and a
  `truth: retired-claim <claim> — why` declaration for the surface that names it
  as history (this section carries one). Matched on folded case and collapsed
  whitespace, and read across a single line break as well as along a line,
  because prose re-wraps and a rule that a newline defeats is not a rule. In a
  `.js` surface the declaration reaches **comment lines only** — file-scoped, it
  excused the published string as readily as the paragraph explaining it.
  `TRUTH_CLAIM_RETIRED`.
- **A directive no rule reads is refused.** `// truth: spine.authorization.enforced
  -> enforced` matched no pattern and was silently not a citation, so a typo turned
  a load-bearing citation off with no signal. `TRUTH_CITATION_MALFORMED`.

The boundary, stated rather than implied: this holds the falsehood that **is** in
the record, not the set of all falsehoods. A newly invented false posture is still
outside the contract — `POSTURE_PROSE_NOT_GENERATED`. Generating the sentence from
its own facts is the answer, and it is v2.

That is the boundary of what "bound" means for source: a product claim written as a
string, deliberately cited, one file at a time and each one argued in review. This
contract does not scan source for sentences and cannot discover which strings are
claims.

## What is bound, and what is deliberately historical

Bound: `README.md`, `PRODUCT.md`, `AGENTS.md`, `CLAUDE.md`, `TASKS.md`,
`docs/PROJECT_STATUS.md`, `docs/CODER_TOOLING_ROADMAP.md`, `docs/QUALITY_GATES.md`,
this file, `docs/strategy/EXECUTION_ROADMAP.md`,
`docs/benchmarks/CRM_JTBD_MATRIX.md`, `docs/benchmarks/jobs.json`,
`site/claims.json`, `site/assets/llms.txt`, `site/assets/llms-full.txt`, every
`examples/scenarios/*.scenario.json`, and one source file —
`packages/cli/src/app-inspect.js`, for the reason in the section above.

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
| `STORAGE_FACT_IS_BOUNDED_PROBE` | Company, generated-service and Work storage facts cover only their named executable probes and field shapes, not every checked-in service, schema or storage path |
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
| `NUMERIC_CLAIMS_NOT_BOUND` | this contract requires no number to be bound and can discover none that ought to be — see the section below, which states the two things the shorter wording got wrong |
| `POSTURE_PROSE_NOT_GENERATED` | `productionPosture` is hand-written English bound to fact **ids**; the citations hold its values, not its wording. `RETIRED_CLAIMS` catches the one recorded falsehood; generating the sentence is v2 |
| `CODE_VOCABULARY_INCLUDES_COMMENTS` | the vocabulary is harvested lexically, so a code named only in a source comment counts as declared. `RETIRED_CODES` closes the case that matters: a code this repository deliberately removed is subtracted wherever it is mentioned |

### `NUMERIC_CLAIMS_NOT_BOUND`, said accurately

The one-line form said "no fact any document cites is a count, so every number in a
bound sentence … is outside this contract". Two things in that are wrong, and both
matter to a reader deciding whether a number they are reading was checked.

**One cited fact is an integer.** `spine.identity.contract=1` is cited by
`site/claims.json` and checked exactly like any other value — the closed vocabulary
admits three literal shapes, and `contract` is one of them. So the companion claim in
`docs/QUALITY_GATES.md` §6.1, "**No number is checked**", was false. What holds is
narrower: no **count** is cited. The count-shaped facts are the three measurement
ones, and `MEASUREMENT_FACTS_ARE_GENERATED_BUT_NOT_CITED` keeps those out of every
document.

**Typed test counts are not unchecked — a different gate holds them.**
`findLooseTestCounts` in `scripts/measurement.js`, run by `scripts/site-check.js`
inside `npm run gtm:check`, refuses a literal `N tests` in `README.md`, `AGENTS.md`,
`TASKS.md`, `site/`, the site templates and **every** document under `docs/` outside
`DATED_HISTORY`. Listing test counts first among the things "outside this contract"
read as *unchecked*, which is the opposite of the case.

What genuinely no gate holds is **every other current count** — module, package,
resource, action, policy, provider, rail, skill, scenario and JTBD-row counts,
including the ones this very file publishes about itself.

**Why binding them is v2 and not a line of code.** Requiring a number to carry a fact
means telling a load-bearing current count from a date, an ADR number, a currency
example, a benchmark receipt's raw count and a number inside a fenced code block —
classification, not citation. `findLooseTestCounts` needed two hand-tuned negative
lookbehinds (a hyphen, a currency symbol) to survive widening from `site/` to `docs/`
alone, for **one** noun. Generalising that to seven nouns across twenty-one surfaces
is a new gate with its own false-positive budget, and it needs count-shaped facts —
`package.count`, `rail.count` — that do not exist yet. v2 owns both halves.

## Where it runs, and where it deliberately does not

`repo:truth -- --check` runs on every push and every pull request, as its own step in
the **`public-claims`** CI job. That is the one job checked out with `fetch-depth: 0`,
and the measurement provenance checks need full git history — which is also why it is
**not** in `npm run verify`, deliberately left at `fetch-depth: 1`, where a
fail-closed history check would be a flake rather than a gate.

It is a separate step rather than a member of `npm run gtm:check`, because
`gtm:check` is also run locally, in a clone that may be shallow.

v1 wired it into nothing at all and asked a person to run it "when the PR changes a
product boundary". That reproduced the failure this contract exists to close: both
instances in the record were found by a person and not by a gate, which is only a
complaint if a gate exists.

The deterministic, git-free half **is** covered by `verify`:
`tests/repository-truth-contract.test.js` runs inside `npm test` and asserts the
document against its authorities, every citation across every bound surface, and each
negative rule against the mutation that must fail it. Where full history is
available it asserts the measurement facts too; where it is not, it asserts the
**refusal** instead of skipping — and the file was run in a real `--depth 1` clone
to prove it, because a test that quietly stops testing in CI is the same class of
failure this contract exists to close.

Folding `repo:truth` into `npm run gtm:check` itself — so one command name covers
both — is v2 work, and it needs `gtm:check` to stop being something a developer runs
in a shallow clone.

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
