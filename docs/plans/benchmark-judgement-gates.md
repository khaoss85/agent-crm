# Give the benchmark's judgement gates somewhere to land (ExecPlan)

## 1. Goal and user-visible outcome

The CRM build benchmark can be run today and cannot produce a citable result,
for two reasons found by reading the scorer rather than by running it — and a
third found while fixing them. This plan fixes all three **before** any run, so
that no repair can be accused of having been shaped by a result it had already
seen.

After this change a completed run can become `scoreable`, and the 25 points its
largest gate awards mean the run's tests actually caught a broken boundary
rather than merely mentioned a number.

This plan runs no benchmark cell and publishes no figure. `L-03` is unchanged:
the build benchmark has never been run, and nothing here changes that.

## 2. The defects

### 2.1 G2 asks a human a question and gives them nowhere to write the answer

`gateTwo` composes the run's project, counts what it found, and then declines to
judge whether that matches the brief — correctly. The scorer's own rule is
*"a gate that could not be checked is never a pass"*, and whether a domain model
answers a business brief is a judgement, not a measurement.

But `promptPassed` requires all four gates to `pass`, and `scoreable` requires
none to be `needs-operator`. G1 has an operator path — it reads the run's
append-only intervention record. **G2 has none.** So G2 is `needs-operator`
forever, every run is unscoreable forever, and the instrument cannot emit the
verdict it was built to emit.

This is not a design flaw in the refusal. It is a missing half: the refusal was
built, the destination for the human's answer was not.

### 2.2 G3 awards its 25 points for text, not behaviour

`gateThree` derives the boundary values a test must name — in integer cents,
including the value one cent below the edge — and then checks
`corpus.includes(token)` over the concatenated *text* of the project's test
files. It never runs them.

A file containing only the two numbers passes it. Combined with G4 (free from
the scaffold's own tests) and G1 (free when nothing is recorded), an untouched
scaffold plus a two-line file scores 60 of 75 without a CRM having been built.
The gate that carries the most weight is the easiest to satisfy without doing
the work.

### 2.3 A third defect, found while fixing the first two

Both G3 and G4 decide their outcome by spawning the run project's suite and
reading its exit code. Neither sanitised the environment it passed down.

Node's test runner exports `NODE_TEST_CONTEXT` to child processes, and a child
`node --test` that inherits it reports through the parent's channel rather than
exiting on its own result. Measured here: a project whose boundary had been
moved and whose test was therefore failing exited **0**. A gate reading that
would have called an unasserted rule asserted, and a red suite green.

This never surfaced because nobody had run the scorer from inside another test
process. It would have surfaced the first time anyone wrapped it in CI. Both
gates now build their own environment, dropping `NODE_TEST_CONTEXT`,
`NODE_OPTIONS` and `NODE_V8_COVERAGE` — a loader or coverage flag aimed at this
harness has no business inside the project being measured.

## 3. Decisions

**G2 gets the shape G1 already has.** `benchmarks/harness/record.js` gains a
third kind, `verdict`, appended to a `verdicts` array in `run.json` with the
operator's reason. The gate then reads it exactly as G1 reads interventions:

- no verdict → `needs-operator`, unchanged and still the honest default;
- `pass` → pass, with the operator's reason quoted in `why`;
- `fail` → fail.

Three constraints make it a record rather than a lever:

1. **A verdict cannot overrule the machine.** The mechanical failures — no CLI
   in the project, `app inspect` unparseable, an empty composition — are decided
   before the verdict is read and are not appealable. The operator adjudicates
   only what the scorer left open.
2. **A verdict is bound to what was judged.** Recording one captures the
   composition counts at that moment, through the same helper the gate uses, so
   there is one authority for what "composition" means. If the project's
   composition later differs, the verdict is stale and the gate returns to
   `needs-operator` naming both figures.
3. **Append-only, like the rest of the record.** No flag removes a verdict. The
   only reason to want one is to improve a score after the fact.

**G3 falsifies instead of matching.** Naming the boundary stays necessary — a
test that never mentions the edge has not tested it — but it stops being
sufficient:

1. Boundary tokens must appear in the run project's tests (as today).
2. The same tokens must appear in the project's non-test source. If they do not,
   the scorer cannot find the rule to perturb and says so: `needs-operator`,
   not a guess in either direction.
3. The project is **copied**, the boundary is changed in the copy's source, and
   the suite is run there. A suite that still passes has not asserted the rule →
   `fail`. A suite that goes red has → `pass`.

The run artifact is never mutated. This is the discipline the framework already
applies to itself in `npm run falsify` (C-23), turned on the benchmark.

## 4. What this deliberately does not do

- It does not run a benchmark cell, produce a rate, or change `L-03`.
- It does not give G1 a machine path. G1 stays operator-attested, and the report
  keeps saying so in the same breath as any figure derived from it.
- It does not touch Edition D, which remains `BLOCKED_NO_PRODUCTION_SPINE`.
- It does not add a fixture fingerprint, isolation scan or pre-registration to
  the build harness. The sibling tool-selection panel has all three and this one
  does not; that gap is real, is larger than this plan, and is recorded here
  rather than quietly closed.

## 5. Verification

- `node --test tests/benchmark-scorer.test.js` — extended: a verdict that
  passes, one that fails, one absent, one stale, one attempting to overrule a
  mechanical failure; and for G3 a project whose tests name the boundary but do
  not assert it, which must now fail where it previously passed.
- `npm run verify` and `npm run gtm:check` from a clean tree.
- The 60-of-75 scaffold-plus-two-lines case must stop scoring 60.

## 6. Outcome

All three defects are fixed and pinned by tests. `tests/benchmark-scorer.test.js`
went from 10 tests to 15: the case that previously earned G3's full 25 points for
two test *names* containing the right digits is now pinned as a refusal, and the
environment defect is held by the pair of G3 cases that only distinguish
themselves when a child suite's exit code is its own.

Still true, and unchanged by any of it: the build benchmark has never been run
(L-03). What changed is that running it could now produce something worth
publishing.
