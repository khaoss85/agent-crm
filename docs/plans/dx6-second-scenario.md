# DX6 — the second business consumer of the scenario contract

**Status:** implemented.
**Predecessor:** `docs/plans/dx6-scenario-runner.md` (DX6 v1, merged as `4a89474`).
**Reference:** `docs/SCENARIO_EVIDENCE.md`, `docs/SERVICE_OPERATIONS.md`, ADR-029.

## 1. Goal and user-visible outcome

`scenarioRunContract: 1` shipped with exactly one scenario. A contract validated
by one consumer is not validated: it is a shape fitted to that consumer, wearing
a version number. Its author said so in the DX6 PR body, and this plan is the
follow-through.

The goal is **not** "one more scenario". It is to find out what the contract got
wrong, by making it serve a second consumer chosen to be as unlike the first as
the repository allows — and to change the contract where it was wrong rather
than bend the second consumer to fit.

User-visible outcome:

```console
$ npm run crm -- scenario run service-sla-escalation --json
```

A second checked-in scenario runs a second checked-in journey, on an **injected,
stepped clock**, over a **two-package** composition, and earns five JTBD rows
while stating the hundred and forty-four it says nothing about.

## 2. Current repository context

| File | Role |
|---|---|
| `packages/cli/src/scenario-document.js` | the document contract: closed key allow-list, `EXECUTABLE_SHAPES` content check, path validation, the observation vocabulary |
| `packages/cli/src/scenario-journey.js` | the **frozen journey registry** — the only thing DX6 executes — plus bounded child execution and receipt parsing |
| `packages/cli/src/scenario-run-command.js` | the runner: refusal, journey, AX1 inspection, observation, claim resolution, the honest negative, the report |
| `examples/scenarios/lead-to-won.scenario.json` | consumer #1 |
| `examples/starters/b2b-lead-qualification/install.mjs` | journey #1 — a product installer, on the real wall clock |
| `packages/service/` | Milestone 15: coverage, entitlement, support case, SLA evaluation, escalation |
| `packages/cli/src/project-verify-command.js` | DX5, which publishes `SCENARIO_EVIDENCE_NOT_RUN` and runs no scenario |

### Why Service, and not Lifecycle

Service was chosen over the M16a Lifecycle package because it is the only domain
in the repository whose **outcomes are a function of the clock**. Lifecycle
records renewal intent and a governed follow-up handoff; its facts are states and
refusals, which `journey.fact` alone would have covered. Service adds the
question no other domain asks — *which clock produced this evidence?* — and that
turned out to be the sharpest thing wrong with contract 1.

Service is also **partial**, and stated so in `docs/SERVICE_OPERATIONS.md`: no
auth or RBAC, no notification, provider or contact centre, no business-hours
calendar, no paused clock, SLA is elapsed wall-clock minutes, escalation is
manually recorded. Every one of those bounds the scenario, and each is published
rather than worked around.

## 3. Milestones

### M1 — a second journey, because a wall clock cannot witness a boundary

`examples/journeys/service-sla-escalation/journey.mjs`.

The starter installer runs on the real clock, deliberately: it is a product
artifact and a starter that faked the date would misrepresent what a customer
gets. But `evaluateSla()` in `packages/service/src/service-actions.js` reads
`now()` and exposes no `at` parameter, so on the real clock a case opened seconds
ago is always `on_track` and the boundary is four hours away. The boundary is
unreachable, not merely untested.

The new journey composes with `createAccordoApp({ clock })` and steps the clock
to named constants in its own source:

```text
openedAt                    2026-09-15T11:00:00.000Z
firstResponseDueAt          2026-09-15T15:00:00.000Z    openedAt + 240 minutes
  at the due instant                 firstResponseState = at_risk
  one millisecond later              firstResponseState = breached
```

It composes **contracts + service and nothing else** — no intelligence, no
delivery, no lifecycle, no customer package, no Lead or Task module — which is
what "Service imports nothing from contracts and reaches it only through
`contracts/service-obligations@1`" looks like demonstrated rather than asserted.

It invents nothing. A ServiceCoverage exists only through a real activation of a
real pending obligation raised by a real signed Order, so the journey drives the
sale as far as Service needs it and no further.

### M2 — `journey.fact`: the channel contract 1 did not have

Contract 1's only runtime-fact channel was `journey.count`, over the receipt's
numeric keys. A funnel is countable in every part that matters. Service is not:
`slaEvaluations: 2` is equally true of a run that recorded the wrong answer
twice. The load-bearing facts are *which state* and *whether*.

`journey.fact` observes a stated outcome exactly. A fact is a boolean, or one
lower-case token of at most 64 characters. That keeps the original rule — a
journey's prose summary must not enter the evidence, or the fingerprint moves
every time somebody improves a sentence — while admitting the states the domain
already uses. A command, a URL, a path or a sentence is refused twice: once by
the grammar, once by `EXECUTABLE_SHAPES`.

### M3 — `journey.clock`: which clock produced the evidence

Declared in the frozen registry, published in every report, and part of the
semantic fingerprint. **Not** a document field: a document that could name the
instant could name the one where the breach disappears, and a scenario that can
choose its own answer proves nothing.

### M4 — scoped limitations

Contract 1 had one global list, and with one journey every entry was true of
every run. With two, half of any merged list is false of whichever run you are
reading, and an obviously irrelevant disclaimer teaches a reader to skip the ones
that are not. Limitations now carry `scope`, and a journey declares its own in
the registry — never in the document, because every incentive points at a
document writing itself a shorter list.

### M5 — the DX5 relationship

Decided: **A**, unchanged. `crm project verify` keeps publishing
`SCENARIO_EVIDENCE_NOT_RUN` and runs no scenario. Justification in §6.

### M6 — evidence, then public claims

Behavioural mutation for both scenarios; determinism and safety re-runs; then the
DX North Star, the GTM technical evidence handoff and the Coder Tooling Roadmap
updated to *implemented with two consumers, PROVE still partial because DX10 is
absent* — and nothing further.

## 4. Validation

```console
npm run verify
npm run smoke
npm run gtm:check
node packages/cli/bin/accordo.js project doctor --json
node packages/cli/bin/accordo.js project verify --json
node packages/cli/bin/accordo.js scenario run lead-to-won --json
node packages/cli/bin/accordo.js scenario run service-sla-escalation --json
```

Both scenarios exit 0. Both reports are byte-identical between runs from
different working directories. The two reports agree on `scenarioRunContract` and
disagree on clock mode, composition fingerprint, package set, observation kinds
and established rows — which is the point: if the two runs were the same shape,
the contract would still be validated by one consumer.

### Behavioural mutation

A source-digest change is not evidence. Each mutation below changes a
**business fact** and nothing else, and the expected observation must fail:

There are **two** layers that can catch a mutated business fact, and they are not
the same claim. The journey's own in-process assertion is the stronger authority
and fires first; the scenario document is what makes the *report* wrong. Each
mutation is therefore run twice — once as-is, and once with the journey's own
assertion relaxed, so the failure has to reach the scenario.

| Scenario | Mutation | Journey's assertion intact | Journey's assertion relaxed |
|---|---|---|---|
| `service-sla-escalation` | `evaluateSla`: `now > due` → `now >= due` | journey exits 1 → `SCENARIO_JOURNEY_FAILED`, every claim `not_established` | `sla-boundary.02` **fails**: expected `firstResponseStateAtDueInstant is=at_risk`, actual `= breached` |
| `service-sla-escalation` | `record-escalation` returns `notified: true` | journey exits 1 → `SCENARIO_JOURNEY_FAILED` | `escalate.06` **fails**: expected `escalationNotified is=false`, actual `= true` |
| `service-sla-escalation` | the escalation stops citing its SLA evaluation | journey exits 1 | `escalate.04` **fails**: expected `escalationCitesSlaEvaluation is=true`, actual `= false` |
| `lead-to-won` | the intelligence package stops owning the `assignment` resource | the starter's own assertion fails → `SCENARIO_JOURNEY_FAILED`, all fifteen claims `not_established` | — |

Every mutation is reverted, and the proof of revert is not `git status`: it is
that both scenarios re-run to reports **byte-identical** to their pre-mutation
baselines, fingerprints `4078f05e…` and `1910cec7…`.

One process finding worth keeping: `git checkout --` **silently reverts nothing**
when any pathspec in the same invocation is untracked, and the new journey is
untracked until it is committed. A revert script that mixed the two left two
mutated files behind and only the byte-identical re-run caught it.

### Determinism and safety, re-run

| Condition | Result |
|---|---|
| repository root, then cwd `/` with `--root`, then a root path containing spaces **that is also a symlink**, then `TZ=Pacific/Kiritimati LANG=tr_TR.UTF-8` | all four reports **byte-identical**, for both scenarios |
| scratch cleanup | no `/tmp/accordo-scenario-*` left behind |
| repository mutation | `git status --porcelain` digest unchanged across every run, including `crm project verify` |
| a document with an executable field / executable content / a command in a fact value | `SCENARIO_FIELD_UNKNOWN` / `SCENARIO_EXECUTABLE_CONTENT` / `SCENARIO_EXECUTABLE_CONTENT` + `SCENARIO_FIELD_INVALID`; **no journey started** |
| a plan citation of `../../etc/passwd` or `/etc/passwd` | `SCENARIO_PATH_REFUSED`; no journey started. The realpath boundary from `3c441a8` is untouched and still test-pinned |
| zero observations in a step | `SCENARIO_FIELD_INVALID` — a step that observes nothing is narration |
| a duplicate step id | `SCENARIO_DUPLICATE_ID` |
| a journey id the registry does not know | `SCENARIO_JOURNEY_UNKNOWN`, with the known ids named |
| a missing capability and a missing package, on a real run | both observations **fail** rather than skip; the claim is `not_established` |
| already inside a run (`ACCORDO_SCENARIO_RUN=1`) | exit 2, `SCENARIO_RECURSION_REFUSED`, nothing executed |
| a driver that throws | `ok=false code=1`, diagnostic kept, settled in 56 ms |
| a driver that hangs | bounded: `timedOut=true signal=SIGTERM`, the process **group** stopped |
| a driver that floods | `truncated=true`, output cut at the bound and the truncation stated |
| a driver that exits while a grandchild holds the pipes | settled on `exit` in 324 ms against a 60 s bound, receipt intact — the DX5 defect-1 property |
| a driver whose installer is not in the project | a stated `spawnError`, not a crash |

## 5. Decision log

**Extend the contract, do not bend the consumer.** The brief said to extend the
three-layer refusal if consumer #2 needed a new field and never to bypass it.
`journey.fact` is a new entry in a closed vocabulary with a closed argument
grammar; every string still passes `EXECUTABLE_SHAPES`; the key allow-list still
refuses anything else at that node. No command, script or env field exists, and
none was added.

**No `requires` block.** Service needs the contracts package and
`contracts/service-obligations@1`, and states that as `package.composed` and
`capability.available` observations that must pass — answered by AX1, failing
closed. A prerequisites block would say the same thing a second way, and a
precondition invites "skip if unmet", which converts a failure into silence.

**No record-graph query.** "The escalation cites the SLA evaluation it rests on"
is a link between two records. The journey asserts it and publishes one boolean.
A traversal syntax over records is exactly the slope that ends in an executable
format.

**No negation operator.** A refusal is published as a positive fact the journey
earned by *attempting* the operation. `absent:` or `not:` would let a run claim
safety by never looking.

**Audit, event and trace stay journey-published counts.** They are runtime facts;
AX1 reads source and cannot see one. Growing a second authority that opens the
journey's database would be a second thing to keep honest for no new answer.

**Report contract bumped to 2; document contract stayed at 1.** Every v1 scenario
still validates — a vocabulary gained an entry. The report gained fields and
every fingerprint moved with them, and a consumer diffing fingerprints across
that boundary deserves to be told.

**A second journey rather than extending the starter.** The starter is a product
installer whose value is that it is what a customer gets; giving it a fake clock
would misrepresent that. Its composition setup is similar to the new journey's by
necessity, not by copy-paste convenience — the new one composes a deliberately
different, smaller application, which is itself part of the evidence.

## 6. DX5 relationship: A, and why not B

**A. Scenario evidence stays a separate explicit command.** DX5 keeps reporting
`SCENARIO_EVIDENCE_NOT_RUN`.

**B — a bounded applicability contract, scenarios declaring themselves
`required`/`current` the way plans do — is refused for now:**

- each scenario composes a **whole application**, so the cost is minutes per
  scenario and grows with every one a project adds. Turning the
  cheap-to-reason-about final proof into a silently multi-minute one is the
  opposite of what it is for, and the brief's own boundary — *do not make every
  Project Verify run every scenario implicitly* — is the same concern;
- a declaration vocabulary is a new agent-facing contract. The DX Simplicity Gate
  asks which **failure mode** it prevents, not which capability it adds;
- the failure mode it would prevent, "somebody forgot to run the scenario", is
  already named in machine-readable form by `SCENARIO_EVIDENCE_NOT_RUN`, which a
  caller can switch on today. A published limitation is a cheap fix; a hidden
  multi-minute expansion is an expensive one.

What would change the answer: a scenario registry with declared applicability
that exists for reasons other than DX5, or DX10 arriving and making a single
final proof genuinely complete.

## 7. Progress log

1. Read `docs/SERVICE_OPERATIONS.md`, `packages/service/src/{actions,service-actions,activation-policy,capabilities}.js`, the four service test suites and the starter's service section, so the journey drives only what the package actually publishes.
2. Established the blocking fact: `evaluateSla()` reads `now()` and the actions expose no `at`, so the SLA boundary is unreachable on a wall clock. That decided "second journey" over "second scenario on the existing journey".
3. Wrote the journey; it passed on its second run (one wrong result key). 5.2 s, against 11.1 s for the starter journey.
4. Added `journey.fact`, `journey.clock` and limitation scopes; bumped the report contract to 2, left the document contract at 1.
5. Wrote the scenario; it passed on its first full run. As shipped: eleven steps, 52 observations all passing, five claims established, 144 rows reported as not established.
6. Nine new tests. Full suite green on the local Node and on the CI-pinned 22.16.0.
7. Mutations, both layers, both scenarios; determinism and safety re-runs; then the public-evidence documents.

## 8. Outcome and follow-up

Implemented. The scenario contract now has two consumers, one of which is
time-dependent, package-native and composition-narrow.

**Not done, and named:**

- **Coverage is still claimed, not discovered** (`COVERAGE_IS_CLAIMED_NOT_DISCOVERED`).
  Two consumers do not change that.
- **PROVE remains partial.** DX10 does not exist, so nothing maps a plan's
  requirements to the code implementing them. Two scenarios make the evidence
  broader, not complete.
- **No third consumer.** Marketing, Analytics and Communications have no runtime
  at all, so no scenario can honestly claim their rows. Lifecycle (M16a) and
  Delivery execution/economics/change are the next honest scenarios, and neither
  needs a code change unless it needs a clock.
- **Scenario documents are not registered anywhere.** `examples/scenarios/` is a
  directory, not an index with declared applicability. That is the missing piece
  option B above would need, and it should be built for its own reasons if it is
  built at all.
