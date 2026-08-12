# Scenario evidence

`accordo scenario run <scenario> [--json] [--root dir]` — **DX6**.

> **Which JTBD rows does this checkout actually earn — and which does it not?**

Job status in this repository lives in `docs/benchmarks/CRM_JTBD_MATRIX.md` and
its generated index `docs/benchmarks/jobs.json`. Both are maintained by people.
Nothing recomputed them, and nothing could tell you what a given run did **not**
establish — `docs/PROJECT_STATUS.md` lists that as a known limitation, and AX1
says it in its own report: `evidence.status` is `not_aggregated`, with a note
that the JTBD documents are referenced by path and never parsed.

This command closes that gap, and only that gap.

```text
accordo app inspect      what is composed?                             source facts
accordo solution check   is this plan still compatible?                a document
accordo project doctor   what is stale in the source?                  cheap
accordo project verify   can we PROVE the project is healthy?          expensive
accordo scenario run     which business jobs does this checkout earn?  this
accordo solution verify  is the plan actually finished?                DX10, which runs this
```

## Two consumers, and what the second one changed

A generic contract validated by exactly one consumer is not generic. It is a
shape fitted to that consumer, wearing a version number.

`scenarioRunContract: 1` shipped with one scenario — `lead-to-won`, a sales
funnel. The second one, `service-sla-escalation`, was written specifically to be
*unlike* it: Service is package-native, has a declared state machine, real clock
semantics and immutable evidence records, and its load-bearing outcomes are
states rather than counts. Three things broke, and each was something contract 1
had got wrong rather than merely lacked.

| What contract 1 did | Why nobody noticed | What contract 2 does |
|---|---|---|
| journey evidence was **numeric only** (`journey.count`) | a funnel is countable in every part that matters — three leads, one won | `journey.fact` observes a **stated outcome**: `at_risk`, `breached`, `false`. `slaEvaluations: 2` is equally true of a run that recorded the wrong answer twice |
| the report never said **which clock** produced the evidence | nothing in a funnel is a function of the current instant | `journey.clock` is published from the frozen registry. An SLA state is a function of the clock and of nothing else |
| `limitations[]` was a **single global list** | with one journey, every limitation was true of every run | limitations carry a `scope`, and a journey declares its own. "No business-hours calendar" is meaningless for a lead funnel; "no external enrichment provider" is meaningless for a support case |

Four things did **not** change, and the second consumer is the reason we can say
so rather than assume it:

- **the document contract stayed at `scenarioContract: 1`.** A vocabulary gained
  an entry; nothing existing changed meaning, and every v1 scenario still
  validates. The **report** contract moved to `2`, because the report gained
  fields and every fingerprint moved with them — a consumer diffing fingerprints
  across that boundary deserves to be told rather than to discover it.
- **no `requires` block.** Service needs the contracts package and the
  capability `contracts/service-obligations@1`, and it states that as
  `package.composed` and `capability.available` *observations that must pass* —
  answered by AX1, failing closed. A prerequisites block would be a second way
  to say the same thing, and worse: a precondition invites "skip if unmet",
  which turns a failure into silence.
- **no record-graph query.** "The escalation cites the SLA evaluation it was
  raised on" is a link between two records, and the contract does not learn to
  traverse them. The journey — trusted, checked-in source — asserts the link and
  publishes it as one fact. A query language over records is exactly the slope
  that ends in an executable format.
- **no negation operator.** "Nobody was notified" is published as
  `escalationNotified = false` and observed as `false`, not as an assertion that
  something is absent. A run can earn an absence by never attempting the
  operation; the service journey attempts every refusal it reports.

## What it is not

**It is not a second test runner.** It runs no suite, grades no package and
calls no doctor — that is `accordo project verify`, and duplicating it would leave
two commands answering almost the same question. What it produces is the mapping
prose cannot give you: *this scenario ran, against this composition, these rows
it exercised with linked evidence, and these rows it did **not** establish.*

**It promotes nothing.** `docs/QUALITY_GATES.md` §3 gives the four-value JTBD
status vocabulary and puts the burden of proof on the higher value, decided by a
person reviewing merged tests. This command reports evidence. Its own per-claim
vocabulary — `established | not_established | unresolved` — is deliberately not
the JTBD vocabulary, so the two can never be read as the same thing, and every
report carries a `promotion` block recording that it performed none. `jobs.json`
and the matrix are opened read-only.

**The negative is the point.** A scenario that earns fifteen rows and cannot
speak to a hundred and thirty-four has to say so in its own output, so
`jtbd.notEstablished` is a counted, sectioned, fully enumerated list. "Not
established" means *this scenario said nothing about the row* — never that the
row is unsupported. The recorded status in the index is the only statement about
support.

## The scenario document

A scenario is a **checked-in declarative document**, not a script:
`examples/scenarios/<id>.scenario.json`. A bare id on the command line resolves
there; anything with a path separator is treated as an explicit path.

```json
{
  "scenarioContract": 1,
  "id": "lead-to-won",
  "title": "Lead to won, and everything the won deal sets in motion",
  "summary": "…",
  "journey": "b2b-lead-qualification",
  "steps": [
    {
      "id": "capture",
      "narrative": "Leads are captured into the starter's Lead record.",
      "observe": [
        { "kind": "module.present", "module": "lead" },
        { "kind": "journey.count", "metric": "leads", "atLeast": 3 }
      ]
    }
  ],
  "claims": [
    { "job": "JTBD-04", "steps": ["capture"], "note": "narrow wording…" }
  ]
}
```

- **`journey`** names, by id, the thing the runner executes. Ids resolve against
  a frozen registry in the runner's own source — today two entries, both
  checked-in repository source that CI runs. A journey is a *stronger* authority
  than DX6, never a weaker one: its own in-process assertions are the claim, and
  DX6 adds the mapping nobody has. The registry, not the document, also declares
  the journey's **clock** and the journey's **own limitations**.
- **`steps`** are the business narrative, in order. Each declares observations.
- **`claims`** map JTBD ids, resolved against `jobs.json`, to the steps that are
  their evidence. A claim is `established` only when *every* observation in
  *every* cited step passed.

### How it refuses to carry a command

`docs/CODER_TOOLING_ROADMAP.md` refuses "executable commands as trusted plan
content" — *a format that can describe execution invites a runtime, and the
first runtime that reads a plan is one edit away from applying it* — and the
Solution Plan validator enforces that rather than documenting it. A scenario
refuses the same thing, in three independent layers:

1. **Shape.** No field in the contract could hold a command. Every object is
   checked against a closed key allow-list, so `{"run": "npm test"}` is refused
   as `SCENARIO_FIELD_UNKNOWN` *before its value is read*.
2. **Content.** Every string at every depth goes through `EXECUTABLE_SHAPES` —
   **the same exported constant the Solution Plan validator uses**, not a second
   copy that gets fixed once. A shell command, a command substitution, shell
   chaining, a remote address or a script tag is `SCENARIO_EXECUTABLE_CONTENT`.
3. **Path.** There is no code path from a document value to an invocation. The
   only thing the runner spawns is a journey selected by id from that frozen
   registry. A scenario cannot name a path, a script, an argument, an
   interpreter or an environment variable. The single field that names a file —
   a Solution Plan citation — is read and validated as a document, never
   executed, and is refused if it is absolute, contains `..`, uses a backslash
   or a URL scheme, or resolves outside the project. "Outside the project" is
   decided on the **canonical** path, not the written one: a lexical check
   cannot see a symlink, and `docs/plans/x.json` can be a well-formed relative
   path that reads somewhere else entirely. ADR-026 settled this for the
   publication assembler; the same rule holds here. A link that stays inside the
   project is still followed — the boundary is where the bytes are, not whether
   a link was used to reach them.

**A document with any problem never starts a journey.** The refusal costs
nothing and happens first.

### The observation vocabulary

Closed, and owned by the runner rather than the document — the same discipline
`accordo project verify` uses for declared scripts, where the project declares a
*name* and the framework owns the list.

| Kind | Authority | Answers |
|---|---|---|
| `journey.completed` | journey | the journey ran to completion and reported success |
| `journey.count` | journey | a numeric metric the journey reported (`atLeast` or `equals`, exactly one) |
| `journey.fact` | journey | a **stated outcome** the journey reported (`fact` and `is`), compared exactly |
| `package.composed` | `app inspect` | the composed application includes this domain package |
| `resource.present` | `app inspect` | a domain package in this composition owns this resource |
| `module.present` | `app inspect` | the composition has this record module (a project's own, or package-owned) |
| `action.present` | `app inspect` | the composition publishes this `module.action` |
| `capability.available` | `app inspect` | a declared cross-package capability **resolved** here (declared-but-unresolved fails) |
| `policy.present` | `app inspect` | a versioned policy this composition registered |
| `plan.valid` | Solution Plan | a checked-in plan this scenario is the evidence run for, read as a document |

Composition facts are taken **verbatim** from the AX1 report. Nothing an
upstream authority already resolved is recomputed here.

**Which authority answers what** is the line the second consumer made explicit.
`app inspect` answers *what this application is* — read from checked-in source,
opening no database and contacting no provider. The journey answers *what
happened when it ran* — the only channel for a runtime fact, because AX1 by
construction cannot see one. `journey.count` and `journey.fact` are that channel:
counts for how many, facts for which. Audit, event and trace facts belong there
too, as counts the journey publishes about the application it drove
(`auditEvents`, `workflowRuns`); the contract does **not** grow an authority that
opens the journey's database, because a second reader of runtime state is a
second thing to keep honest.

### `journey.fact`, and the rule that keeps prose out

A fact is a **boolean**, or a string that is one lower-case token of at most 64
characters (`/^[a-z][a-z0-9_]{0,63}$/`). Booleans are published as `true` /
`false`, so one closed grammar covers every fact and a document never carries a
JSON type. A summary sentence has spaces, capitals and length, so it is excluded
*by construction* rather than by a denylist somebody has to maintain — and a
shell command, a URL, a path and a command substitution are all refused twice,
once by that grammar and once by `EXECUTABLE_SHAPES`.

```json
{ "kind": "journey.fact", "fact": "firstResponseStateAtDueInstant", "is": "at_risk" }
{ "kind": "journey.fact", "fact": "escalationNotified", "is": "false" }
```

## The report

`scenarioRunContract: 2`, canonically ordered, with `scenario`, `status`,
`counts`, `journey`, `composition`, `steps`, `observations`, `jtbd`,
`promotion`, `problems`, `limitations` and a semantic `fingerprint`.

`journey` carries `clock` (`wall-clock` or `injected-fixed`, from the registry),
`metrics` and `facts`. `limitations` entries carry `scope`: `global` for what is
true of every run, `journey` for what the journey that ran declares about
itself. A journey may **add** to what a run does not prove; it may never
subtract, and a scenario document may do neither — there is no field in the
shape that could hold a limitation.

```text
exit 0   the scenario ran and every claim is established
exit 1   the scenario ran and something did not hold, or the document is
         invalid — in which case no journey was started
exit 2   the scenario document could not be read at all
```

**Deterministic and offline.** No duration, timestamp, temporary path, machine
layout or random value enters the report *at all* — not merely the fingerprint —
so two runs of an unchanged checkout produce byte-identical documents from
different working directories. Nothing reaches the network. Three fingerprints
travel with every report: the scenario document's own, the composition's
(`inspectionFingerprint`, shared with AX2), and the JTBD index's.

The journey composes a whole application in a temporary directory outside the
repository, which is removed afterwards. **Nothing is written into the project
being reported on**, which is why there is no worktree check to get wrong.

### Problem codes

`SCENARIO_UNREADABLE`, `SCENARIO_TOO_LARGE`, `SCENARIO_CONTRACT_UNSUPPORTED`,
`SCENARIO_FIELD_INVALID`, `SCENARIO_FIELD_UNKNOWN`,
`SCENARIO_EXECUTABLE_CONTENT`, `SCENARIO_VOCABULARY_UNKNOWN`,
`SCENARIO_DUPLICATE_ID`, `SCENARIO_CITATION_UNRESOLVED`, `SCENARIO_PATH_REFUSED`,
`SCENARIO_JOURNEY_UNKNOWN`, `SCENARIO_JOURNEY_FAILED`, `SCENARIO_JOB_UNKNOWN`,
`SCENARIO_JOBS_INDEX_UNREADABLE`, `SCENARIO_COMPOSITION_UNREADABLE`,
`SCENARIO_RECURSION_REFUSED`.

Everything fails closed. A claim whose job id is not in the index, a step id that
does not exist, a metric the journey never reported, a capability that is
declared but unresolved — each fails the run rather than passing by having
nothing to check.

### What it does not prove — global, published on every run

| Code | Means |
|---|---|
| `SCENARIO_IS_NOT_PROMOTION` | this changes no JTBD status and writes to no document |
| `COVERAGE_IS_CLAIMED_NOT_DISCOVERED` | it checks the rows a scenario *claims*; it cannot discover which rows a journey happens to exercise |
| `NEGATIVE_EVIDENCE_IS_SILENCE` | a row under `notEstablished` means the scenario said nothing about it, never that it is unsupported |
| `EVIDENCE_IS_ONE_COMPOSITION` | the evidence is about the one application this journey composed |
| `JOURNEY_SOURCE_TRUSTED` | the journey is checked-in repository source running with the operator's authority. The child is bounded in time, output and process group — isolation, not a sandbox |
| `BROWSER_EVIDENCE_NOT_AUTOMATED` | no browser is driven; nothing here is evidence about the Admin as a user sees it |
| `NO_PROVIDER_CONTACTED` | offline by construction; every provider in the journey is a checked-in fixture |
| `PRODUCTION_READINESS_NOT_ASSESSED` | no auth, tenancy or RBAC exists, and nothing here assesses deployment or operational readiness |

### What the journey does not prove — journey-scoped

| Journey | Codes |
|---|---|
| `b2b-lead-qualification` | `JOURNEY_CLOCK_IS_WALL_CLOCK`, `ENRICHMENT_PROVIDER_IS_A_FIXTURE` |
| `service-sla-escalation` | `SLA_IS_ELAPSED_TIME_NOT_A_CONTRACTUAL_JUDGEMENT`, `NOTHING_WAS_NOTIFIED_OR_ROUTED`, `ESCALATION_IS_MANUALLY_RECORDED`, `SERVICE_COVERAGE_IS_NOT_A_CONTRACT` |

No code appears in more than one list — not in both journeys, and not shadowing a
global one. A limitation true of both journeys belongs in the global set; a
limitation true of neither is noise that teaches a reader to skip the ones that
matter; and one code with two messages is a report that contradicts itself. All
three are test-pinned, as is the rule that every registered journey declares a
clock and at least one limitation of its own.

## Two worked runs

```console
$ npm run crm -- scenario run lead-to-won --json
```

The first scenario runs the B2B starter journey on the **wall clock** and claims
fifteen rows across capture, qualification, conversion, pipeline, enrichment,
scoring, routing, quoting, discount approval, signature and order, contract
activation, delivery handover, custom-package authoring, cross-package capability
and application discovery. It reports **fifteen established** and **one hundred
and thirty-four not established**, sectioned, over a composition of six packages.

One of the fifteen — `JTBD-CS-01`, contract activation — is recorded as
*partially supported*, and stays that way. The run shows the activation
happening; the row's missing part (a pre-signature term snapshot) is not
something a run can supply, and only a person may move a status.

```console
$ npm run crm -- scenario run service-sla-escalation --json
```

The second runs the service journey on an **injected, stepped clock**, over a
composition of **two** packages — `contracts` and `service`, and nothing else,
which is what "Service reaches contracts only through a declared capability"
looks like when it is demonstrated instead of asserted. It claims five rows and
reports **five established** and **one hundred and forty-four not established**.

Its centre is three instants:

```text
openedAt                     2026-09-15T11:00:00.000Z
firstResponseDueAt           2026-09-15T15:00:00.000Z   openedAt + 240 minutes
  evaluated at the due instant        firstResponseState = at_risk
  evaluated one millisecond later     firstResponseState = breached
```

That boundary is the reason the journey injects a clock. `evaluateSla()` reads
`now()` and exposes no `at` parameter, so on the wall clock the boundary is four
hours away and no run can ever reach it. A regression turning `now > due` into
`now >= due` changes a business outcome and nothing else, and this is the only
run in the repository that fails on it.

Both service rows it claims — `JTBD-DS-11` and `JTBD-DS-12` — are recorded as
*partially supported* and stay that way. What the run shows is real; what it does
not show is published in the journey's own limitations, including that **nothing
was notified, routed or billed** — each of those a fact the journey states as
`false` and the scenario observes as `false`, because a refusal a run could earn
by never attempting the operation is worth nothing.

## Adding a scenario

Write `examples/scenarios/<id>.scenario.json`, claim only rows the journey
genuinely exercises, and run it. No code changes. A *new journey* does need a
registry entry in `packages/cli/src/scenario-journey.js`, deliberately: that is
the boundary that keeps a document from naming something to run. A new journey
also declares its **clock** and its **own limitations** there, for the same
reason — a document that could choose the instant could choose the one where the
breach disappears, and a document that could write its own limitations could
write a shorter list.

## Relationship to `accordo project verify` (DX5)

`accordo project verify` **does not run scenarios**, and that was re-examined when
the second one landed. It stays a separate, explicit command, and DX5 keeps
publishing `SCENARIO_EVIDENCE_NOT_RUN`.

The alternative considered was a bounded applicability contract — scenarios
declaring themselves `required` or `current`, the way Solution Plans do, so DX5
could run the declared ones. It is refused for now:

- each scenario composes a **whole application** of its own, so the cost is
  minutes per scenario and grows with every one a project adds. Making the
  cheap-to-reason-about command silently multi-minute is the opposite of what
  it is for;
- a declaration vocabulary is a new agent-facing contract, and the DX Simplicity
  Gate asks which *failure mode* it prevents rather than which capability it
  adds;
- the failure mode it would prevent — "somebody forgot to run the scenario" — is
  already named in machine-readable form by `SCENARIO_EVIDENCE_NOT_RUN`, which a
  caller can switch on today.

What would change the answer: a scenario registry with declared applicability
that exists for reasons other than DX5. DX10 has since arrived, and it did **not**
change the answer — it made the relationship explicit in the other direction.
`accordo solution verify` runs Project Verify and each **explicitly referenced**
scenario, once each, because an evidence document names exactly the scenarios its
requirements rest on. That is the applicability declaration the alternative
wanted, and it lives where the *consumer* is declared rather than inside the
scenario, for the reason ADR-029 already gives.

## Related

`DECISIONS.md` ADR-029 (why a second consumer is validation work, and why a
consumer-specific bound is declared where the consumer is) ·
`docs/QUALITY_GATES.md` (§3, the status vocabulary and who may change it) ·
`docs/benchmarks/CRM_JTBD_MATRIX.md` · `docs/APPLICATION_INSPECTION.md` (AX1) ·
`docs/SOLUTION_PLAN.md` (AX2) · `docs/CODER_TOOLING_ROADMAP.md` ·
`docs/plans/dx6-scenario-runner.md` (the ExecPlan, with the eight DX Simplicity
Gate answers) · `docs/plans/dx6-second-scenario.md` (the second consumer, and
what it changed) · `docs/IMPLEMENTATION_EVIDENCE.md` (DX10, which cites a
scenario observation as requirement-level evidence) · `docs/SERVICE_OPERATIONS.md` (what Service does and,
crucially, does not do) · `tests/scenario-document.test.js` ·
`tests/scenario-run.test.js` ·
`examples/journeys/service-sla-escalation/journey.mjs`.
