# ExecPlan — DX6 Scenario Runner

**The question it answers:**

> **Which JTBD rows does this checkout actually earn — and which does it not?**

Not "do the tests pass" (that is `npm test`), and not "is this project healthy
enough to hand back" (that is DX5, `crm project verify`). This is the rail that
turns *evidence* into something a machine can aggregate.

```text
crm app inspect       what is composed?                          source facts
crm solution check    is this plan still compatible?             a document
crm project doctor    what is stale in the source?               cheap
crm project verify    can we PROVE the project is healthy?       expensive
crm scenario run      which business jobs does this checkout earn?   DX6
```

DX5 publishes `SCENARIO_EVIDENCE_NOT_RUN` as one of its own blind spots. DX6 is
what closes that one — and closes it narrowly, publishing five blind spots of
its own.

---

## 1. Goal and user-visible outcome

Today the mapping from *a business scenario* to *the JTBD rows it earns* exists
only as Markdown prose in `docs/benchmarks/CRM_JTBD_MATRIX.md`.
`docs/PROJECT_STATUS.md` records that as a known limitation, and AX1 says it out
loud: its `evidence.status` is literally `not_aggregated`, with a note that it
*references* the JTBD documents and never parses them into structured claims.

So the only way to answer "does this checkout support lead → won?" is to read a
149-row table and believe it. Nothing recomputes it, and nothing can tell you
what a given run did **not** establish.

After DX6:

```console
$ npm run crm -- scenario run lead-to-won --json
```

produces one contract-versioned, fingerprinted document that says: this scenario
ran, against this composition, these steps were observed, these JTBD rows it
exercised with this evidence, and **these rows it did not establish**. The
honest negative is a first-class field, counted and enumerated, not an omission.

**It never promotes a row.** The report carries a `promotion` block stating
that it performed none and that promotion is a human act, and its per-claim
vocabulary (`established | not_established | unresolved`) is deliberately *not*
the four-value JTBD status vocabulary, so no reader can mistake one for the
other. `jobs.json` and `CRM_JTBD_MATRIX.md` are opened read-only and never
written.

---

## 2. Current repository context

| What exists | Where | How DX6 uses it |
|---|---|---|
| the JTBD index | `docs/benchmarks/jobs.json` — `jobsContract: 1`, `statusVocabulary`, 149 rows with `tests[]` and `docs[]` | the **only** authority on which rows exist and what status each row carries. Read, never written, never paralleled |
| the composed application | `examples/starters/b2b-lead-qualification/install.mjs` — composes a project from manifests and drives capture → qualify → convert → pipeline → enrich/score/route → catalog → quote → approval → signature → order → contract activation → delivery handover, with in-process assertions, in ~15s | the **journey**: the thing DX6 actually runs |
| composition facts | `crm app inspect --json` (AX1), isolated in a child on fd 3 | the authority for `package.composed`, `resource.present`, `action.present`, `capability.available`, `policy.present` |
| the composition fingerprint | `inspectionFingerprint(report)` exported from `packages/core/src/solution-plan.js` | the composition the evidence is about |
| the command refusal | `EXECUTABLE_SHAPES` in `packages/core/src/solution-plan.js`, enforced by the Solution Plan validator | the same refusal, from the same constant — not a second copy |
| the house report shape | `packages/cli/src/project-verify-command.js`, `app-inspect-command.js`, `safe-text.js` | contract version, closed status vocabulary, canonical order, semantic fingerprint, `problems[]`, `limitations[]`, exit codes 0/1/2 |
| a correct child runner | `packages/cli/src/child-report.js` — settles on **`exit`** with a drain window, documents why | the pattern DX6's journey child follows |
| plans | `examples/solution-plans/*.plan.json` | a scenario may cite one; DX6 validates it as a document |

---

## 3. Three approaches compared

### A. Scenario as a test-selection manifest

The document lists test files; DX6 runs `node --test` over them and maps
pass/fail onto claimed JTBD rows.

- **For:** cheap, reuses the suite, ties rows to tests directly.
- **Against:** this is *"npm test with extra words"*. It proves the tests pass —
  which `npm test` already proves — and never drives the business scenario. The
  JTBD matrix's `tests[]` column already names those files, so the mapping would
  be transcription rather than evidence. Worse, a test path in a document *is*
  effectively a script: it puts executable content back into trusted content
  through the back door, which is the exact thing this repository refuses.
- **Rejected.**

### B. Scenario as an executable step DSL

The document describes CRM operations (create lead, qualify, convert…) and DX6
executes them against a composed application through module services.

- **For:** highest fidelity; new scenarios need no new code; reads like a
  business process.
- **Against:** `docs/CODER_TOOLING_ROADMAP.md` → "Deliberately refused" already
  rules this out: *"a format that can describe execution invites a runtime, and
  the first runtime that reads a plan is one edit away from applying it."* It
  would also be a **second, weaker authority** on what the CRM does, competing
  with the starter installer that already drives the same journey with much
  stronger assertions. And every action's input shape would become document
  vocabulary — an unbounded surface.
- **Rejected**, and it is the approach the repository has explicitly refused.

### C. Scenario as a declarative evidence contract over a named journey — **winner**

The document names a **journey by id** from a registry DX6 owns, narrates the
business **steps**, and each step declares **observations** drawn from a closed
vocabulary DX6 implements against two authorities that already exist: the
journey's own receipt, and AX1 over the composed application. **Claims** map
steps to JTBD ids resolved against `jobs.json`.

- **Wins because:** it runs something real (the same installer CI runs on every
  push); it invents no second authority; the document is inert data with no field
  that *could* hold a command and no code path from a value to an invocation;
  adding a scenario needs no new code; and the output is precisely the mapping
  that does not exist today, including the negative over all 149 rows.
- **Costs, published as limitation codes:** coverage is *claimed*, not
  discovered (`COVERAGE_IS_CLAIMED_NOT_DISCOVERED`); the evidence is about one
  composition (`EVIDENCE_IS_ONE_COMPOSITION`); a journey needs a registry entry
  (one today).

---

## 4. The eight DX Simplicity Gate answers

**1. Which concrete agent failure mode does it prevent?**
An agent reports "this checkout supports the lead-to-won job" because a test
filename sits next to that row in a Markdown table, and cannot say what the run
did *not* establish. Concretely: an agent asked to state what a checkout proves
must today read 149 prose rows; nothing recomputes them, DX5's green exit code
explicitly does not mean it, and AX1 refuses to parse them. The failure is
**over-reporting coverage from prose, and having no way to state the negative**.

**2. Why are existing primitives insufficient?**
`npm test` proves tests pass, not which business job they earn. `crm app
inspect` publishes `evidence.status: "not_aggregated"` and says it references
the JTBD documents without parsing them. `crm solution check` binds a plan to a
composition and runs nothing. **I tried extending DX5 first**: adding a
`scenario` category to `crm project verify`. It fails for three reasons — it
puts a journey inside a command that is already minutes long and already means
something else; it makes DX5's fingerprint depend on `jobs.json`, so a docs edit
changes a health verdict; and it gives one command two answers, which is
question 3 in reverse. DX5's own `SCENARIO_EVIDENCE_NOT_RUN` is the record that
this was considered and separated on purpose.

**3. Does it overlap semantically with an existing tool?**
No. DX5: *is this project healthy enough to hand back?* DX6: *which business
jobs does this checkout earn, and which does it not?* DX6 deliberately does not
run `npm test`, does not grade package conformance and does not call the doctor
— doing any of those would make it DX5 again. It shares the word "evidence" and
nothing else.

**4. Can it remain deferred or on-demand?**
Yes, and it is. It is **not** in `npm run verify`, **not** in `npm run check`,
and **not named in any skill** — the surface budget (`scripts/surface-check.js`,
`commandsAcrossSkills`) is at 11/11 and DX6 does not spend the twelfth. It is
run when someone needs to state what a checkout earns: a release, a JTBD review,
a GTM claim.

**5. Does it preserve Claude / Codex / Gemini portability?**
Yes. A CLI command, a JSON contract (`scenarioRunContract: 1`), stable exit
codes, and checked-in JSON scenario documents. No harness-specific logic exists
anywhere in it.

**6. What machine-readable evidence proves its value?**
`scenarioRunContract: 1`; exit codes 0/1/2; a semantic `fingerprint`; a
`compositionFingerprint`; a `jobsFingerprint`; per-claim
`established | not_established | unresolved`; and `jtbd.notEstablished` with a
count and the full id list.

**7. Does horizontal impact update the Compatibility Backfill and the Legacy
Alignment Matrix?**
**Yes — DX6 is horizontal.** Evidence discipline is a capability every domain
could use, and the matrix already carries a "JTBD rows with linked evidence"
row. A **Scenario evidence (DX6)** row is added in this PR recording every
domain's status, with `deferred` where no shipped scenario reaches the domain.

**8. Does the end-user goal flow become simpler, not more manual?**
The user still states a goal; no skill gains a step, and `solve-business-goal`
is untouched. What becomes simpler is a question people already answer by hand:
"what does this checkout actually prove?" — one command with a machine-readable
answer instead of a 149-row table read hopefully. If a user had to run it, that
would fail question 1; they do not.

---

## 5. The contract

`scenarioRunContract: 1`.

```text
exit 0   the scenario ran and every claim is established
exit 1   the scenario ran and something did not hold — or the document is
         invalid, in which case the journey is never started
exit 2   the scenario document could not be read at all
```

### Vocabularies, all closed

| Vocabulary | Values |
|---|---|
| observation kinds | `journey.completed`, `journey.count`, `package.composed`, `resource.present`, `action.present`, `capability.available`, `policy.present`, `plan.valid` |
| observation status | `passed`, `failed`, `skipped`, `not_applicable` |
| claim outcome | `established`, `not_established`, `unresolved` — **deliberately not** the JTBD status vocabulary |
| run status | `passed`, `failed` |

### Problem codes

`SCENARIO_UNREADABLE`, `SCENARIO_TOO_LARGE`, `SCENARIO_CONTRACT_UNSUPPORTED`,
`SCENARIO_FIELD_INVALID`, `SCENARIO_FIELD_UNKNOWN`,
`SCENARIO_EXECUTABLE_CONTENT`, `SCENARIO_VOCABULARY_UNKNOWN`,
`SCENARIO_DUPLICATE_ID`, `SCENARIO_CITATION_UNRESOLVED`,
`SCENARIO_JOURNEY_UNKNOWN`, `SCENARIO_JOB_UNKNOWN`,
`SCENARIO_JOBS_INDEX_UNREADABLE`, `SCENARIO_JOURNEY_FAILED`,
`SCENARIO_COMPOSITION_UNREADABLE`, `SCENARIO_RECURSION_REFUSED`.

### Limitation codes — DX6's own blind spots, published on every run

| Code | Means |
|---|---|
| `SCENARIO_IS_NOT_PROMOTION` | this changes no JTBD status. A row is promoted by a human against `docs/QUALITY_GATES.md` §3, on merged tests |
| `COVERAGE_IS_CLAIMED_NOT_DISCOVERED` | DX6 checks the rows a scenario *claims*. It cannot discover which rows a journey happens to exercise |
| `NEGATIVE_EVIDENCE_IS_SILENCE` | "not established" means this scenario said nothing about the row — never that the row is unsupported |
| `EVIDENCE_IS_ONE_COMPOSITION` | the evidence is about the one application this journey composed, not every composition |
| `JOURNEY_SOURCE_TRUSTED` | the journey is checked-in repository source run with the operator's authority. The child is bounded in time, output and process group; that is isolation, not a sandbox |
| `BROWSER_EVIDENCE_NOT_AUTOMATED` | no browser is driven; nothing here is evidence about the Admin as a user sees it |
| `NO_PROVIDER_CONTACTED` | offline by construction. Every provider in the journey is a checked-in fixture |
| `PRODUCTION_READINESS_NOT_ASSESSED` | no auth, tenancy or RBAC exists; nothing here assesses deployment or operational readiness |

---

## 6. The scenario document, and how it refuses to carry a command

```json
{
  "scenarioContract": 1,
  "id": "lead-to-won",
  "title": "…",
  "summary": "…",
  "journey": "b2b-lead-qualification",
  "plan": "examples/solution-plans/lead-to-won.plan.json",
  "steps": [
    { "id": "capture", "narrative": "…",
      "observe": [ { "kind": "journey.count", "metric": "leads", "atLeast": 3 } ] }
  ],
  "claims": [ { "job": "JTBD-04", "steps": ["capture"], "note": "…" } ]
}
```

Three independent layers, each enforced and each tested in both directions:

1. **Shape.** No field in the contract could hold a command. Every object is
   checked against a closed key allow-list, so `{"run": "npm test"}` is refused
   as `SCENARIO_FIELD_UNKNOWN` *before its value is ever read*.
2. **Content.** Every string in the document — including keys' values at every
   depth — goes through `EXECUTABLE_SHAPES`, the same constant the Solution Plan
   validator uses: shell command, command substitution, shell chaining, a remote
   address, a script tag → `SCENARIO_EXECUTABLE_CONTENT`. One authority, not a
   second copy that gets fixed once.
3. **Path.** There is **no code path from a document value to an invocation.**
   The only thing DX6 ever spawns is a journey selected by id from a frozen
   registry in DX6's own source, whose installer path is a constant. A scenario
   cannot name a path, a script, an argument, an interpreter or an environment
   variable. `journey` is an identifier matched against
   `^[a-z0-9][a-z0-9-]{0,63}$` and then looked up; anything else is
   `SCENARIO_JOURNEY_UNKNOWN`, never a filesystem operation.

`plan` is the one field that names a file. It is bounded to a repository-relative
POSIX path with no `..` segment, no absolute prefix, no null byte and no
backslash, resolved under the project root and refused if it escapes — and it is
only ever *read and validated as a document*, never executed.

---

## 7. Not reproducing the six DX5 defects

DX5 merged with six defects, fixed on the unmerged branch
`claude/postmerge-dx5-hardening`. This base does not contain those fixes, so
importing DX5's helpers would inherit them. DX6 therefore **does not import
anything from `project-verify-command.js`**.

| DX5 defect | What DX6 does |
|---|---|
| 1. child settled on stream `close`, so a leaked grandchild held the pipes for the full timeout | DX6's journey child settles on **`exit`** with a bounded drain window, following `child-report.js`, which documents finding and fixing this exact defect in AX1 |
| 2. package selection intersected paths against basenames, and a *required* check silently reported `not_applicable` | DX6 recomputes nothing an upstream authority resolved: package/resource/action/capability/policy names come verbatim from the AX1 report. A claim with nothing to check is `unresolved` and **fails the run** — it never passes by having nothing to check |
| 3. no recursion guard | `ACCORDO_SCENARIO_RUN` is set in the journey child; a run that starts with it already set refuses with `SCENARIO_RECURSION_REFUSED` before spawning anything |
| 4. dirty-worktree check ran once, at the end, and missed untracked files | DX6 makes **no worktree claim at all** — it runs the journey in a throwaway directory outside the repository and never writes to the project. There is no check to get wrong |
| 5. `redact()` over-redacted diagnostics and under-redacted unusual paths | DX6 publishes no free-form child log. Failure reasons are built from structured fields; the only text that travels is the child's **last line**, passed through `safeMessage()` from `safe-text.js` and bounded. Tested in both directions: a diagnostic keeps its meaning, and a path with non-ASCII characters is still replaced |
| 6. silent truncation, UTF-8 corrupted across chunk boundaries, `exit null` for a signal-killed child | streams use `setEncoding('utf8')` so no multi-byte character splits; truncation sets an explicit `truncated: true` in the report; a signal-killed child reports `{"code": null, "signal": "SIGKILL"}` and the report says `killed by SIGKILL`, never `exit null` |

**Stated dependency: none.** DX6 works on this base as-is. It does not depend on
`claude/postmerge-dx5-hardening`, and it does not re-implement DX5's helpers —
it uses the already-correct `child-report.js` pattern and `safe-text.js`.

---

## 8. Milestones (each leaves the repository runnable)

1. **Document contract** — `packages/cli/src/scenario-document.js`: parse,
   validate, normalize, canonical order, document fingerprint. Refusals only, no
   execution. Tests for every refusal.
2. **Journey child** — `packages/cli/src/scenario-journey.js`: the frozen
   journey registry and a bounded child that settles on `exit`.
3. **Runner** — `packages/cli/src/scenario-run-command.js`: run the journey,
   inspect the composition, evaluate observations, resolve claims against
   `jobs.json`, compute the negative set, fingerprint, render, exit.
4. **CLI wiring** — `crm scenario run <scenario> [--json] [--root dir]`, help
   text, `npm run crm` reachable.
5. **The shipped scenario** — `examples/scenarios/lead-to-won.scenario.json`,
   claiming only rows the journey really exercises.
6. **Docs** — `docs/SCENARIO_EVIDENCE.md`, the roadmap's DX6 row, the North Star
   rails table, the GTM handoff (in **every** place, and repairing the existing
   DX5 contradiction while there), `LEGACY_ALIGNMENT_MATRIX.md`, `TASKS.md`,
   `docs/PROJECT_STATUS.md`.

## 9. Validation

```console
npm run crm -- scenario run lead-to-won --json      # exit 0, full report
npm run crm -- scenario run lead-to-won             # human render
npm run verify
```

Tests (`tests/scenario-run.test.js`, `tests/scenario-document.test.js`) cover
the happy path with an injected journey, every refusal, the negative-evidence
path, hostile input, determinism across two runs and two working directories,
and one **real** end-to-end run of the shipped scenario against the real
journey.

## 10. Decision log

- **Kept out of `packages/core`.** The Solution Plan contract lives in core, so
  a scenario contract there would be symmetrical — but ADR-018's core budget
  says new behaviour stays out until a second consumer proves it is a reusable
  runtime capability. It has one consumer. It lives in `packages/cli/src/`, next
  to `package-test-checks.js`, and moves to core when DX13 gives it a second.
- **One field changed in core:** `EXECUTABLE_SHAPES` becomes exported from
  `packages/core/src/solution-plan.js`. A second copy of a refusal is a second
  place for it to be fixed only once — the argument `safe-text.js` already makes.
- **The journey always runs.** An `application: {kind: "project"}` variant that
  only checked composition was dropped: `crm app inspect` already answers that,
  and a second command answering the same question is the overlap the Simplicity
  Gate refuses.
- **Claims fail closed.** A claim whose job id is not in `jobs.json`, or whose
  step id does not exist, is `unresolved` and the run **fails**. Silence would
  let a typo read as coverage.
- **The negative set is enumerated, not summarized.** All 149 ids are cheap and
  the whole point is that a reader can see the forty rows a scenario cannot
  speak to.

## 11. Progress log

1. **Baseline, before any code.** `npm install && npm run verify` on the branch
   point (`0c8a29d`): **741 tests, 740 pass, 1 fail**. The failure is
   `tests/delivery-change-acceptance-evidence.test.js` → "exact reads stay exact
   past the display bound", `TypeError: fetch failed` / `read ECONNRESET`. It is
   the known flake under separate investigation; re-running that file alone on
   this loaded machine reproduced the same `ECONNRESET`. Not touched.
2. **Document contract** — `packages/cli/src/scenario-document.js`, plus one
   line in `packages/core/src/solution-plan.js` exporting `EXECUTABLE_SHAPES`
   (re-exported from `packages/core/index.js`). 19 tests.
3. **Journey child** — `packages/cli/src/scenario-journey.js`: the frozen
   registry, and a bounded child that settles on `exit` with a drain window.
4. **Runner** — `packages/cli/src/scenario-run-command.js`.
5. **CLI wiring** — `crm scenario run <scenario> [--json] [--root dir]`, help
   text, and the missing `project verify` usage line DX5 never added.
6. **The shipped scenario** — `examples/scenarios/lead-to-won.scenario.json`:
   16 steps, 69 observations, 15 claims.
7. **Tests** — `tests/scenario-document.test.js` (19),
   `tests/scenario-run.test.js` (33), including one real end-to-end run and a
   named regression test for each of the six DX5 defects.
8. **A defect in my own child runner, found by the first full `verify`.** A
   chunk larger than the whole output budget was dropped rather than bounded, so
   a journey whose first write was enormous left *nothing* — DX5 defect 6 in a
   new place. Fixed in the reader (keep the prefix that fits, whole characters
   only), with a second regression test for the single-oversized-write case.
9. **Docs** — `docs/SCENARIO_EVIDENCE.md`, the roadmap's DX6 row and priority
   list, the North Star rails table and failure-mode map, the GTM handoff (new
   §12, both status tables, and the pre-existing DX5 contradiction repaired),
   `LEGACY_ALIGNMENT_MATRIX.md` (a new horizontal row, a footnote, the
   outside-the-table note and a full backfill section), `TASKS.md`,
   `docs/PROJECT_STATUS.md`, `README.md`, and DX5's own two limitation messages,
   which pointed at DX6 as future work.

## 12. Outcome

**Final `npm run verify`: 793 tests, 793 pass, 0 fail, exit 0.** Baseline was
741 / 740 / 1 (the known `ECONNRESET` flake), so this adds 52 tests and the
flake did not reproduce on the final run. `README.md`'s test count, stale at 701,
was corrected in the same pass.

**A worked run**, on this repository:

```console
$ npm run crm -- scenario run lead-to-won --json
exit 0 · 69 observations passed · 15 claims established · 134 rows not established
```

The journey composed a six-package application (`contracts`, `delivery`,
`intelligence`, `lifecycle`, `partner-scorecard`, `service`) and reported
`leads 7 · tasks 2 · companies 1 · contacts 2 · opportunities 2 · won 1 · lost 1`.
Two runs from different working directories produced **byte-identical**
documents.

The fifteen established rows are JTBD-03, 04, 05, 05b, AX-01, CO-01, CO-03,
CO-07, CS-01, DS-01, LI-01, LI-02, LI-04, PK-01 and PK-02. `JTBD-CS-01` is
recorded as *partially supported* and **stays** partially supported: the run
shows the activation happening, the row's missing part is a pre-signature term
snapshot no run can supply, and only a person may move a status.

The honest negative is the larger number: **134 rows across 19 sections** this
scenario says nothing about — including `JTBD-01`, which the journey arguably
touches but whose own wording is about the Admin, which nothing here drives.

**Limitations that remain**, stated plainly:

- coverage is **claimed by a scenario, not discovered** — a row a journey
  exercises but no scenario claims reads exactly like a row nothing touched;
- **one scenario and one journey ship.** Service composes into the application
  and no claim reaches it (`deferred` in the alignment matrix);
- **no browser is driven**, so JTBD rows whose wording is about the Admin cannot
  be earned here at all;
- the evidence is about **one composition**;
- quality-gate status is still prose — DX6 closed the JTBD half of that gap only;
- **PROVE is still partial**: DX10 does not exist, so nothing maps a plan's
  requirements to the code that implements them.
