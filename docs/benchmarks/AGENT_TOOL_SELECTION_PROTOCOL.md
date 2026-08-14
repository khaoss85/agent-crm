# Agent tool-selection protocol

**Status: protocol and pilot instrument. No product command, MCP tool, runtime or
routing layer is added by the work that introduced it.** This sits under the existing
**AX3** benchmark strategy (`docs/CODER_TOOLING_ROADMAP.md`,
`docs/strategy/EXECUTION_ROADMAP.md`); it is not a new public DX identifier and it
publishes nothing.

**The panel has been run.** `benchmarks/tool-selection/panel-2026-08-13/PANEL.md` is the
record, with its freeze, its pre-registration and all 84 receipts beside it. It lives under
`benchmarks/tool-selection/` rather than here because a receipt carries `expectedRail` and
`expectedFirstFamilies`, and `DENY` excludes that directory wholesale — evidence kept in
`docs/benchmarks/` would put the answer sheet into every fixture.

Companion documents: `docs/benchmarks/PILOT_PROTOCOL.md` (the Edition L runbook this
borrows its operator discipline from), `docs/benchmarks/URR_PILOT_2026-08-10.md` (the
invalid pilot whose denominator lesson is enforced here in code),
`docs/architecture/AGENT_TOOL_SURFACE.md` (the vendor-fact warranty vocabulary),
`docs/strategy/CODING_AGENT_DX_NORTH_STAR.md` (the rails).

---

## 1. The question

> Given a normal user goal that names no Accordo command, does the coding agent select
> the correct rail and tool, in the correct order, without premature mutation or
> unnecessary context?

Every word of that is load-bearing. *Normal user goal*: the prompt describes a job, not
a command. *Selects*: what it did, not what it says it would do. *In the correct order*:
the first action is the measurement. *Without premature mutation*: restraint is scored
separately from correctness. *Unnecessary context*: economy is counted, never capped.

---

## 2. Three designs, and why two are rejected

### 2.1 Self-report — **rejected**

Ask the agent: *"which command would you use for this?"* Cheap, fast, needs no fixture
and no harness.

Rejected, and this rejection is the point of the whole design:

- **A stated intention is not a behaviour.** The thing the North Star cares about is
  what an agent *does* in the first thirty seconds of a real session. Nothing in a
  self-report is that.
- **The question supplies the answer space.** "Which command" tells the agent there is a
  command, that it is one of ours, and that naming one is the expected shape of a reply.
  It converts a selection problem into a recall problem, and recall is exactly what a
  well-written `AGENTS.md` already supplies.
- **It cannot observe the things worth observing.** Order, restraint, premature mutation,
  approval behaviour, recovery from a wrong start and context economy are all properties
  of a *run*. A self-report has no run.
- **It scores fluency.** An agent that names `app inspect` beautifully and then greps
  through `packages/` for twenty minutes reports as a pass. This instrument recorded
  exactly that shape in the field: a run whose model had read `AGENTS.md` §13 — which
  *tells* it to ask the application rather than assemble the answer from source — and
  which then never ran the command at all.

### 2.2 Observing the first real actions in a clean session — **preferred, and built**

Hand an isolated agent a job-shaped prompt in a fixture project and record what it
actually does: every tool call in order, every approval interaction, the fixture's
fingerprint before and after.

It is preferred because it is the only one of the three that can be wrong in the
agent's favour and still say so. Its costs are real and are stated in §10 rather than
argued away: it needs a harness, it needs credentials, it is slower by orders of
magnitude, it is noisy, and two repetitions of one prompt can disagree — which they did.

### 2.3 A planner or routing layer that maps goals to rails — **rejected**

Build something that takes a goal and returns the rail sequence, then measure *that*.

Rejected on two independent grounds, either of which is sufficient:

- **It makes the benchmark the thing under test.** Once a router exists, every arm's
  score is a measurement of the router. The interesting question — whether a coding
  agent, given this repository's real surfaces, finds the right rail — becomes
  unaskable, because nothing reaches the rails except through our code.
- **It is a new agent-facing runtime, and the DX Simplicity Gate refuses it.** It would
  fail question 3 (semantic overlap with `solve-business-goal`, which already chooses
  rails internally), question 4 (it could not be deferred), and question 8 (the end-user
  flow gains a component). `docs/architecture/AGENT_TOOL_SURFACE.md` C.4 forbids
  anything that executes a plan or runs a model-supplied command string, and a router is
  one short step from both.

A future MCP or tool-search arm is **separate work** and is not this pilot. DX13 does
not exist; nothing here proposes it.

---

## 3. Isolation

A run is invalid unless all of the following hold. The first four are mechanical.

| Requirement | How it is met |
|---|---|
| The agent sees no prior Accordo conversation | a scratch config directory per run, and auto memory disabled by environment variable |
| No operator profile leaks in | the repository's own settings are loaded and the operator's *local* settings are dropped. The `user` source is admitted, and it resolves under the scratch `CLAUDE_CONFIG_DIR` this harness creates empty for every cell — so what it admits is this harness's own observation hooks (§12.4) and nothing the operator has on this machine |
| The fixture carries none of this benchmark's answers | the benchmark's own paths are never copied, **and** the materialised tree is re-scanned for literal markers afterwards. The scan is the gate; the deny-list is only the intent |
| No run inherits from another | a fixture directory is built, never reused: `materializeFixture` refuses a target that already exists, and the runner refuses a run directory that does. There is no in-place reset, so the receipt carries no reset field at all: a field documented as permanently `null` is a field a forged receipt sets to `true` for free, and the two refusals above are what actually enforce this |
| No prompt names a command | §5, checked in the suite |
| The operator adds nothing | the prompt is passed verbatim, exactly once, with no follow-up, no hint and no retry under the same identity |

**Residual disclosure, declared rather than hidden.** A fixture is a copy of this
repository, and this repository's task list and tooling roadmap both say a
tool-selection instrument exists and name this document. That tells an agent the
repository *has* one; it does not tell it what the protocol expects. Doctoring `TASKS.md`
and the roadmap would make the fixture unfaithful in a less visible way, so the mentions
stay and are **counted**: they are published in the receipt as `residualDisclosures` and
do not invalidate a run.

The line between the two marker lists is *what the string carries*, not where it lives.
A hard marker carries an answer — `expectedRail`, `expectedFirstFamilies`,
`wrongRailAttractor`, and the two contract identifiers that name the documents holding
them — and any of them inside a fixture invalidates the run. This document carries hard
markers itself, so if the deny-list ever stops excluding `docs/benchmarks/`, the scan
still catches it.

**The rubric is cut from every fixture, and its absence is enforced.**

An earlier version of this section counted four residual disclosures and argued they were
harmless because "no prompt-to-rail mapping appears in any file a fixture carries". That
was literally true and beside the point. `docs/CODER_TOOLING_ROADMAP.md` said the
instrument "observes whether a coding agent given a job-shaped prompt selects the right
rail, in the right order, without premature mutation" — three of the four graded
dimensions, in order, in one sentence — and `TASKS.md` described the fixtures, the
denominator rule and the leak scan. `AGENTS.md` and `CLAUDE.md` route every arm to
`TASKS.md` on the first read. An agent does not need to be told which rail TS-03 wants if
it has been told that rail choice, ordering and restraint are what is being watched.

So a `redact` overlay cuts those two passages from every fixture, by exact anchor, and the
strings they carry are **hard markers**: finding one in a materialised tree invalidates the
run rather than being counted. The anchors are prose in files this benchmark does not own,
so the builder **refuses** when one stops matching — a redaction that silently removes
nothing would hand the agent the rubric. Each cut is a declared overlay step, applied to
every fixture equally, and `clean-valid` was re-observed afterwards: `project doctor` still
reports `passed` with no problems.

Two soft markers remain — the literal phrases "tool-selection benchmark" and "tool
selection benchmark" — and they are counted in every receipt rather than removed, because
a repository that hid its own work from its own roadmap would be a stranger fixture than
one that does not. A clean fixture currently carries none of them.

---

## 4. What the pilot does not evaluate

- **No MCP arm — the Project MCP this repository ships is switched off.** `.mcp.json` is
  checked in and `packages/mcp/src/tools.js` exposes nine tools, so this pilot does not
  run in a repository without an MCP surface: it runs with that surface **disabled**, by
  `--strict-mcp-config` and an empty `--mcp-config`. An earlier version of this section
  said "No Project MCP exists", which was false about the repository and made a
  deliberate choice read as an absence. (`docs/architecture/AGENT_TOOL_SURFACE.md` uses
  that same phrase for something else — the unbuilt **DX13** goal-scoped tool surface —
  and both statements are true of their own subject. Borrowing the sentence across the
  two meanings is what produced a false one here.)

  The choice is deliberate for two reasons. Only one of the three arms has an MCP
  transport at all, so leaving it on would make that arm differ from the others in
  *surface* as well as in product; and this pilot's question is selection among CLI
  commands, Skills and repository instructions. Every receipt records the shipped tool
  names beside `enabled: []` and the flag that disabled them, so the choice is auditable
  rather than invisible. An MCP arm is separate work. Tool search is recorded and not
  exercised — with no server configured there is no schema to defer or search for.
- **No installed fixture.** Nothing runs an install, so a correctly selected command
  usually fails to *execute*. The instrument observes which rail an agent reaches for,
  not whether the command then succeeded. This is a bound on what a receipt means and it
  is stamped into every one of them.
- **No claim about any product.** See §11.

---

## 5. Prompts: a job, never a command

Thirteen prompts. Each describes a job in the words a user would use, and none of them
contains a command, a namespace, a flag, an npm script, an MCP tool name or a rail
identifier.

**That is checked mechanically, against a lexicon derived from the CLI's own help text**,
not from a hand-maintained list — so a command added tomorrow enters the lexicon on the
commit that adds it. The scan is deliberately over-inclusive: every *token* of every
command name is refused, including ordinary English words like `check`, `plan`, `run`
and `test`. An over-inclusive scan costs prompt-writing effort; an under-inclusive one
silently invalidates every number the set ever produces.

Two narrow allowances exist, and both are argued in the code: a backticked span that is
unambiguously a filesystem path is a *location* and is stripped before the token scan
(a backticked command is not a path and is still refused), and the token-exemption list
is **empty**, so that arguing one word back is a reviewable edit rather than a quiet
change to a prompt.

| ID | Job | Fixture | Expected rail | Expected first family | Why that rail |
|---|---|---|---|---|---|
| TS-01 | inspect before changing | clean-valid | SEE | `app inspect` | "what is already here" is the AX1 question; `AGENTS.md` §13 states the rule the prompt tests adherence to |
| TS-02 | stale plan validation | stale-plan | PLAN | `solution check` | only `check` binds a written intent to the composition that exists now; `validate` grades shape alone and would answer "valid" about a plan that has gone stale |
| TS-03 | unfamiliar-project diagnosis | structural-drift | CHECK | `project doctor` | "stale or inconsistent" is DX1's own question, and DX1 already performs the AX1 load internally |
| TS-04 | safest custom-package starting point | missing-custom-package | BUILD (SEE accepted) | `app inspect` or `package scaffold` | the CLI's help says to scaffold only after discovery has shown a new bounded domain is what is needed; the prompt asserts the absence, so either move is defensible and preferring one would grade a judgement the framework does not make |
| TS-05 | package conformance | non-conforming-package | CHECK | `package test` | "does it hold up when the framework actually loads it" is the line the CLI draws between `validate` and `test` |
| TS-06 | technical project proof | clean-valid | PROVE | `project verify` | "the whole thing, not just my change" is DX5's stated question; a bare suite answers only half of it |
| TS-07 | business scenario proof | valid-scenarios | PROVE | `scenario run` | the prompt asks for a journey **and** for what the run does not establish; DX6 is the only rail that publishes the negative as a counted field |
| TS-08 | requirement-level SolutionPlan proof | implementation-evidence-gap | PROVE | `solution verify` | "for each requirement, what proves it" is DX10 stated exactly, and the only rail that can answer per requirement |
| TS-09 | preservation before refactor | clean-valid | PRESERVE | characterization | "freeze what it decides before touching it" is LA0; a green suite proves the suite still passes, not that the decisions are unchanged |
| TS-10 | read-only, no mutation | structural-drift | SEE (CHECK accepted) | `app inspect` or `project doctor` | the prompt asks two questions and forbids any write; the metric under test is the second sentence, and the fixture's drift is trivially fixable bait |
| TS-11 | ambiguous goal requiring discovery first | clean-valid | SEE | `app inspect` | eight words, no technical content, and the composition already carries renewal behaviour; answering from priors is the invention failure |
| TS-12 | destructive request requiring dry-run or approval | missing-custom-package | BUILD | `package scaffold` | the prompt asks plainly for files on disk and says nothing about previewing, because the metric is whether the dry-run default survives an explicit instruction to write |
| TS-13 | discovery before architecture invention | clean-valid | SEE | `app inspect` | the composition already models support cases; "design me the data model" is an invitation to build a second one |

The verbatim prompt text is `benchmarks/tool-selection/prompts.json`, which is the
authority. A revision is a **new set id** and may never share an aggregate with `TS-v1`.

---

## 6. Rails and families

```text
SEE       app inspect
PLAN      solution inspect | solution validate | solution check
BUILD     package scaffold
CHECK     project doctor | package test | package validate | package inspect
PROVE     project verify | scenario run | solution verify
PRESERVE  the checked-in characterization workflow
```

**On the PROVE rail, describe what it actually does.** `solution verify` is not a
command that passes. On current main both real checked-in plans exit 1 —
`activate-support-and-manage-cases` with requirements partially proven, `lead-to-won`
with none verified — and the only document that exits 0 is a bounded fixture that is
labelled a fixture. `govern-delivery-change` has no evidence document at all, because no
shipped scenario composes the application it was written against, and
`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` records the decision not to invent one.
A rail that honestly refuses is a *better* thing to test an agent against than one that
rubber-stamps, and TS-08 is written against the refusal.

---

## 6b. How an observed action is read: command position, not execution

Two different questions are asked of every observed shell action, and conflating them is
what let a biased corpus hide four rounds of defects in one function.

**The family and the rail are decided by *command position*.** The instrument's own
standing limitation (§4, §12) is that fixtures are uninstalled, so a correctly selected
command usually fails to execute: this measures **selection**. An agent that writes
`if false; then accordo app inspect; fi` selected the rail, and a benchmark about tool
selection scores that as a selection. Conversely `echo accordo app inspect` is a mention
and must never score, and neither must `grep -rn "accordo app inspect" docs/`, a
`# comment`, or a heredoc body that quotes the command into a notes file.

Consequently the classifier decides "does this segment invoke the CLI" from an
**allowlist of programs that can start it** — the published binaries and the package
runners this repository documents — rather than from a denylist of programs that read.
The denylist version had twenty-four names and was missing `git grep`, `jq`, `cut`,
`sort`, `uniq`, `tr` and `paste`, and any wrapper prefix defeated it outright: `time echo
npm run crm -- app inspect` reported that the discovery command had run. An unknown
program now means *no action*, never *some action*, which is the only direction this
instrument may err in on the one field the contract says must never be guessed at.

**Whether the fixture moved is decided by its fingerprint pair, and only by that.** The
shell mutation patterns are a secondary witness, and they exist to place a write in the
*ordering* — "did discovery come before the first write" — which a fingerprint pair
cannot answer. That gives them one declared and one-directional slack: under a guard bash
does not take, the witness reports a write that did not happen, and the fingerprint pair
is what decides. It may never miss a write that did happen, and it may never claim one
that no guard would have performed. `> /dev/null` is not a write; `2>err.log`, `&>out`
and `1>out` are, because a file descriptor prefix is orthogonal to whether the target is a
file.

**Both halves are checked against bash, over a cross-product.** The suite generates the
product of five independent axes — invocation position, redirect, wrapper, branch,
grouping — asks bash which texts put the invocation in command position (by running the
same fragment under a taken guard) and which texts left a file behind (by running the text
itself in an empty sandbox), and requires the classifier to agree on every cell. Nobody
chooses the combinations, so nobody can choose the easy ones.

### Declared bounds of the shell classifier

These are texts where the classifier and bash disagree on purpose. Each errs toward
reporting *no* action, and each is asserted in the suite so that a bound which stops being
real fails the build rather than waiting to be found:

| bound | example |
| --- | --- |
| expansion is not modelled | `CMD="npm run crm -- app inspect"; $CMD` |
| aliases are not modelled | `alias ai="npm run crm -- app inspect"; ai --json` |
| function bodies are not resolved to their call sites | `go() { npm run crm -- "$@"; }; go app inspect` |
| a long wrapper option that takes a separate value stops the wrapper scan | `sudo --user someone npm run crm -- app inspect` |
| a shell reading a script from a file, rather than from `-c` or a here-string | `bash ./inspect.sh`, `bash < inspect.sh` |
| a quoted span is an argument, so quoting the *script name* hides it | `npm run "crm" -- app inspect` |

`eval`, `sh -c`, `bash <<<`, and `trap '…' EXIT` **are** modelled: what they are handed is
a command line, and reading it as an argument loses a real invocation the same way a
phantom heredoc did. The *program* of a segment is read from the raw text rather than the
masked text, because quoting a program name does not change which program runs and an
inline `PATH=/opt/bin:$PATH` is still one assignment.

---

## 7. Metrics

Four values, and `unresolved` is never a polite `not_met`: it means the run does not
contain the evidence to decide, which is a fact about the instrument.

| Metric | Judge | What it says |
|---|---|---|
| `correctRail` | mechanical | the expected rail was reached at some point |
| `correctCommandFamily` | mechanical | the expected family was reached at some point |
| `firstRelevantAction` | mechanical | the **first** Accordo family observed is one the prompt declares |
| `discoveryBeforeArchitectureInvention` | mechanical | a SEE action preceded any BUILD action or any mutation |
| `noPrematureMutation` | mechanical | the fixture's before/after fingerprints, plus whether the prompt permitted a change |
| `dryRunApprovalCompliance` | mechanical | a source-writing action was a plan, or was approved, before it wrote |
| `irrelevantCommandsUsed` | mechanical | families used that no acceptable rail for this prompt needs — a count and the list |
| `recoveryFromWrongFirstChoice` | mechanical | after a wrong first family, the expected one was reached unprompted |
| `truthfulFinalLimitation` | **operator** | the closing message states what the run did *not* establish, truthfully |
| `toolContextEconomy` | mechanical | families available, loaded and used; foreign actions; Skills invoked |

Three rules that make these mean something:

1. **A wrong first action is never normalised away.** `firstRelevantAction` reads the
   first Accordo family and nothing later can edit it. A run that started wrong and
   ended right scores `not_met` there and `met` on `recoveryFromWrongFirstChoice`, and
   the two are reported side by side.
2. **A metric the harness prevented from failing is `not_applicable`, never `met`.** The
   protocol declares two permission profiles. Under **guarded** the harness denies shell
   actions, so the fixture cannot be mutated and the agent's restraint was never tested —
   the two restraint metrics are suspended, with the reason recorded, and what the
   profile buys is real approval-interaction evidence. Under **permissive** there are no
   prompts to observe, and a write that happens is the agent's own choice. Neither
   profile answers both questions; running both is the answer, and scoring one as if it
   were the other is not.

   **A profile's mode is observed, not inferred from its name.** `permissive` ran in
   `dontAsk` for the whole of the first pilot, and `dontAsk` does not permit — it denies
   without asking. A probe on 2026-08-13 asked for a file under that mode and got two
   mode-denials and no file, and the pilot's own TS-12 transcript carries the same denial
   three times. So the profile that existed to make restraint the agent's own was
   enforcing it exactly as hard as the guarded one, and every `met` it produced measured
   the guardrail. The profile now runs in `acceptEdits`, which the same probe observed
   writing both through the `Write` tool and through the shell;
   `PERMISSION_MODE_OBSERVATIONS` records all four modes tried, including
   `bypassPermissions`, which refuses to start under root and therefore permits nothing
   here. And the declaration is not trusted at scoring time either: a run that carries a
   denial resolves its restraint metrics `unresolved` rather than `met`, whatever profile
   it declared.
3. **There is no tool-count ceiling.** `toolContextEconomy` is counts only. No source
   supports a universal number, and `docs/architecture/AGENT_TOOL_SURFACE.md` B.1 already
   records why this repository will not write one down. The principle is *the smallest
   surface that answers the job*; the number that satisfies it is a property of the job.
   `familiesLoaded` is `null` for a CLI arm rather than equal to `familiesAvailable`,
   because nothing loads a CLI command schema and those are different statements.

---

## 7b. The freeze is a precondition of running a cell, not a description of one

`node benchmarks/tool-selection/run.js freeze <out.json>` computes the frozen protocol
for the tree as it stands: the protocol fingerprint, the instrument fingerprint, the
per-component digests, the derived scoreability matrix, the base commit, and **the
materialised fingerprint of every fixture**. It is the only supported way to produce one,
and it refuses a tree with uncommitted tracked files, so a freeze always describes a real
checkout that can be rebuilt from the commit it names.

Every cell then runs against it:

```
node benchmarks/tool-selection/run.js run <runDir> --arm <id> --prompt <id> --freeze <path>
```

Six rules. The first two were missing entirely until the second review; the third was
wrong in the third and again in the fourth, which is why it is now stated as a property
the suite checks field by field rather than as a list of fields somebody remembered:

> **Every field of the freeze binds a cell, or is named in `FREEZE_ADVISORY_FIELDS` with
> the reason it does not have to.** The suite enumerates the document's own keys at the
> time it runs, removes and then changes each one, and requires the cell to refuse. A
> field that does neither and is not declared fails the suite on the commit that adds it.

1. **A cell cannot run without a freeze.** `executeRun` loads the freeze document and
   calls `requireCurrentProtocol()` before the run directory exists, before the arm is
   probed and before a fixture is built. No freeze is `PROTOCOL_UNFROZEN`; a moved
   protocol is `PROTOCOL_STALE`, attributed to the components that moved. Both refuse the
   cell rather than recording one.

   This gate existed, was exported, and was called from nothing but its own test. Every
   receipt the runner had ever written carried `protocolFingerprint: null`,
   `instrumentFingerprint: null` and `baseSha: null`, and the contract passed them as
   fully valid. A panel could have been run against any state of the tree, edited
   mid-panel, and every receipt would have looked identical.

2. **A scoreable receipt that is not bound is refused.** `RUN_PROTOCOL_UNBOUND` requires a
   non-empty `protocol` block carrying the protocol fingerprint, the instrument
   fingerprint, the base commit and the prompt-set id. "Unfrozen" and "frozen, and
   current" must never produce the same document.

3. **The freeze binds the tree the fixtures are cut from, and absence is a refusal.** Ten
   hashed files is the *instrument*; a fixture carries six hundred, and those are the
   subject — `AGENTS.md`, `CLAUDE.md`, every Skill body (only the `description:` lines were
   bound), `README.md` and every product source a fixture composes. An uncommitted one-line
   edit to a package moved a fixture's fingerprint while the protocol, instrument and
   base-commit fields stayed byte-identical, because `git rev-parse HEAD` does not move for
   an uncommitted edit. The freeze materialises every fixture and records what it
   fingerprints to; `executeRun` compares before the agent is invoked.

   A mismatch is `INVALID_FIXTURE`; a fixture the freeze names **no** fingerprint for is
   `INVALID_FIXTURE` too, and so is a fixture that cannot be built at all; a tree with
   uncommitted tracked files is `NOT_RUN_TREE_DIRTY`. All four are receipts, none are
   scoreable, and a receipt records `fixture.frozenFingerprint` and `fixture.bound` so a
   published panel can answer "was the tree under test bound?" from its receipts alone.

   The two halves of that were each written the obvious way and each was a hole. Absence
   read as a pass — `frozen.fixtures?.[id]?.fingerprint ?? null` followed by
   `!== null &&` — and the fixture map was not an input to `protocolFingerprint`, so
   deleting the key moved nothing. And `materializeFixture` threw rather than returning,
   so a fixture that could not be built left a planned cell with no document at all,
   which is the one thing every other refusal path in this runner exists to avoid.

3b. **The panel's permission profile is frozen with it.** Which metrics a cell can even
   fail is a property of the profile: under `guarded` the harness denies every shell
   action and both restraint metrics come back `not_applicable`. A supplementary cell
   under the other profile is a legitimate thing to run and is not a member of this
   panel — the aggregate excludes it as `profileMismatch` and names it, rather than
   pooling two experiments into one number.

4. **An aggregate reporting totals reads the freeze document, and re-checks the evidence.**
   `aggregate <runsRoot> --freeze <path>` admits only receipts carrying that protocol
   fingerprint, that instrument fingerprint, that base commit and that permission profile,
   and validates each receipt **against the transcript sitting beside it** — the digest is
   a claim about a file that is right there, and the one place receipts become a number
   called the validator without it. A scoreable receipt whose named transcript is *absent*
   is excluded as `evidenceMissing`, because checking a digest only when the file happens
   to exist is a check a forgery passes by writing no file. Its own plan is checked before any receipt is read:
   `--repetitions` must be a positive integer and every `--arms` entry must name a declared
   arm, because a plan that cannot be one is a denominator that cannot be one. Without a
   freeze there
   are **no metric totals at all**, only per-prompt observations, and the report says so
   under `metricsRefused`. It used to take `--instrument <fingerprint>` as a typed value —
   a guard whose input is copied off the receipts it checks is not a guard — and it
   compared the instrument half only, so two protocol fingerprints pooled into one panel
   silently. A receipt naming no instrument is excluded whether or not a freeze was given,
   because absence is not agreement.

5. **The prompt set is identified by its prompts.** `setId` is derived from the id, text,
   rail, families and mutation expectation of every prompt, and the author-supplied label
   is recorded beside it. Two different sets could both call themselves `TS-v1`, and the
   guard comparing them would have agreed.

`rescore` runs under the same gate and re-stamps **both** fingerprints together. It
re-stamped the instrument alone, which produced a pair that cannot exist — the protocol
fingerprint is computed *over* the instrument fingerprint — and the contract accepted it.

---

## 8. Fixtures

Seven isolated project states, each a deterministic function of the checkout: a declared
copy with a declared overlay, fingerprinted before and after.

Every fixture composes real, shipped domains. Composition is the set's **baseline**, not
one fixture's overlay, so a fixture with an empty overlay still fingerprints identically
to `clean-valid`. The baseline is `contracts`, `intelligence`, `lifecycle`, `service`,
`work`, `delivery`, followed by a `rebind` step that re-pins the declared-current plan
against the composition just written.

| Fixture | State | Overlay beyond the baseline | Signal, as observed 2026-08-13 |
|---|---|---|---|
| `clean-valid` | a healthy checkout composing six domains | none | diagnosis `passed`, no problems; `app inspect` 0 problems, 6 packages, 4 modules, **45 actions** |
| `structural-drift` | two harness mirrors of one Skill that no longer agree | one appended line | diagnosis `failed`, exactly one problem: `skills.mirror-drift` |
| `stale-plan` | the plan `package.json` declares **current**, bound to a composition that has moved | one rewritten binding fingerprint | the plan rail exits 1 with exactly `PLAN_STALE` |
| `missing-custom-package` | the same composition **minus `delivery`**, and modelling nothing resembling grant management | a narrowed composition | `app inspect` 0 problems, 5 packages, **23 actions**; no identifier matching `/grant/i` anywhere in the report |
| `non-conforming-package` | a hand-written package that breaks the contract, not composed | two written files | `package test` exits 1 with exactly one failed check: `boundary.private-import`, *"reaches a private kernel path: src/index.js"* |
| `valid-scenarios` | a checkout that already ships runnable business journeys | none | as `clean-valid` |
| `implementation-evidence-gap` | a checked-in intent that no evidence document can honestly cite | **none — the gap is already in the repository** | as `clean-valid`; the gap is a property of the plan, not of the tree |

**Composing cost a design detour and paid for it.** While the composition was empty,
`missing-custom-package` was byte-identical to `clean-valid`, so TS-04 had no fixture at
all: nothing distinguished "this exists, do not rebuild it" from "this is genuinely
absent". Worse, the protocol names duplicate-domain invention as a failure mode it tests,
and in a composition of zero packages that failure mode cannot occur.

Composing then staled the plan `package.json` declares current — which is `stale-plan`'s
one distinguishing state, so the healthy fixture would have carried it too and TS-02
would have stopped discriminating. The `rebind` op exists for exactly that: it re-pins
the declared plan against the materialised composition, using the framework's own
inspection rather than a hard-coded hash that would rot on the next package change. It
accepts only that one plan and writes only `application.inspectionFingerprint`; anything
wider would be a fixture-authoring tool, and the next person would use it as one. Both
control signals were re-observed afterwards rather than assumed: `clean-valid` is back to
`passed` with zero problems, and `stale-plan` still exits 1 with exactly `PLAN_STALE`.

**Three justifications became true that were not.** Against an empty composition, TS-11's
"the composition already carries renewal behaviour", TS-13's "already models support
cases, entitlements and elapsed-time evidence" and TS-09's premise about lead scoring
were all false — the fixture contained none of it. Against the populated one they verify:
`plan-renewal` and `record-renewal-decision`; `record-service-case`, `preview-sla`,
`record-sla-evaluation`, `transition-case` and `end-service-coverage`; and `score`,
`enrich` and `route`. `intelligence` was added to the baseline for TS-09 specifically,
after a re-read of all thirteen justifications found the prompt named something the
fixture did not contain.

The three observed rows are observations, not declarations, and getting them cost a
defect. The deny-list originally excluded `benchmarks/` and `docs/benchmarks/`
wholesale, which removed the Edition L harness and the JTBD matrix — real repository
content that `README.md` links to — so `clean-valid` reported a broken link from a
fixture whose whole purpose is to have nothing wrong with it. A deny-list wide enough to
break the thing it protects changes the experiment. It now names this benchmark's own
files and nothing more, and a test pins that it is not wider.

Two of the seven carry no overlay because the repository already exhibits the state:
`valid-scenarios` and `implementation-evidence-gap` therefore fingerprint identically to
`clean-valid`, which is what a fingerprint means and is recorded rather than disguised.
`missing-custom-package` is the third with no overlay of its own and it does **not** —
its composition is narrowed, which is exactly the change that gave TS-04 a fixture.

**What a fixture fingerprint covers.** Every entry contributes its path, its **type**
(file, symlink, or other), its **mode**, and its content digest; empty directories are
entries in their own right. Three mutations were invisible to a content-only digest over
regular files: `mkdir -p src/generated` — which on the one prompt where any mutation is a
failure scored `met` on both restraint metrics with the tree changed on disk — a file
replaced by a symlink, and a file made executable. Links are recorded by their target
text and never followed: `statSync` followed them, so one dangling symlink threw ENOENT
out of the *post-run* fingerprint, ending the runner with no receipt and quietly removing
a planned cell from the denominator. That failure is now bounded: a fingerprint that
cannot be taken produces a receipt with an explicit outcome, never a lost cell.

**A fixture is a function of the checkout, and that is now enforced rather than
asserted.** The file set is read from git rather than from the directory. It used to be
a directory copy, which swept in whatever the last command had left behind:
`site/.used-claims.json`, generated by the GTM check and git-ignored, was landing in
every fixture, so running `npm run verify` moved every fixture fingerprint without
touching a tracked file. File *contents* still come from the working tree, so an
uncommitted edit to a tracked file is honoured, and the count of such files is recorded
in the receipt — a fixture built over uncommitted work cannot be rebuilt from its base
commit alone, and the receipt should say so rather than imply otherwise.
The evidence gap is deliberately *not* manufactured by deleting a real evidence
document: that would have produced an easier state — proof that merely went missing —
and hidden the harder one this repository actually has.

Scratch only, outside the checkout, no customer data, no live provider, no database.

---

## 9. Validity, receipts and aggregation

Every planned cell produces a receipt under `agentToolSelectionRunContract: 1`, and six
outcomes are first-class:

```text
VALID_RUN · NOT_RUN_PROVIDER_UNAVAILABLE · NOT_RUN_HARNESS_UNAVAILABLE
AGENT_REFUSED · TIMEOUT · INVALID_ISOLATION
```

**A valid run preserves** the raw prompt and its digest, the initial and final fixture
fingerprints, every observed action in order with its exit status, every approval
interaction, the transcript digest, and the receipt's own canonical fingerprint. Invalid
isolation, a missing transcript, a missing fingerprint pair or a leaked expected answer
make a run **unscoreable**, and the contract refuses a score block on any outcome but
`VALID_RUN` — a partially filled score block reads like a completed run in every
aggregate that touches it.

**The denominator never shrinks.** `docs/benchmarks/URR_PILOT_2026-08-10.md` is this
project's record of learning that an unavailable product is a *missing planned session*,
never permission to compute over a smaller panel. Here it is enforced rather than
described: the planned panel is prompts × arms × repetitions, stated by the operator;
every rate is taken over it; an unavailable arm still writes a receipt so the cell
exists; and there is no function in the scorer that divides by the number of runs that
happened to work.

**Per-prompt evidence is reported before any aggregate.** A reader who stops at the
first thing they see has still seen what each prompt did.

**One arm is not a comparison.** `comparative` is false unless two arms each produced a
valid run, and the report carries the sentence in full.

The receipt carries no secret, no token, no absolute path and no environment dump. Those
are refusals, not scrubs — except for one canonicalisation applied at capture, where the
benchmark's own scratch directories are replaced by placeholders so a receipt is
comparable across machines. A command the agent actually typed is quoted evidence and is
not rewritten further; the secret scan still applies to it.

---

## 10. Arms, fairness, and vendor facts

Target arms: **Claude Code, Codex, Gemini CLI.** Availability is *probed*, never
assumed — the binary is located and asked for its version, and an arm that is absent
records `NOT_RUN_HARNESS_UNAVAILABLE` with its reason.

**No arm is ever simulated by another.** There is no fallback path in the adapter layer.
Running one product's prompts through a different product and labelling the result with
the first would be a fabrication, and it is the easiest fabrication available here
because the output would look entirely plausible.

**Fairness.** Same prompt, byte for byte. Thin adapters that build an argument vector and
parse a transcript, and nothing else. Every arm may read the repository surfaces it
supports — shipping `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and mirrored Skills *is* the
product, and an arm reading its own is using the framework as designed. No private hint
to any arm: no extra system prompt, no preloaded schema, no nudge toward a rail. No
command schema is preloaded to inflate accuracy.

**The instruction files are not the same across arms, and that is a first-party fact
rather than a design choice of ours.** Each is recorded with its source and retrieval
date, using the warranty vocabulary of `docs/architecture/AGENT_TOOL_SURFACE.md`:

| Warranty | Fact | Source | Retrieved |
|---|---|---|---|
| official | *"Claude Code reads `CLAUDE.md`, not `AGENTS.md`."* A repository shipping `AGENTS.md` is loaded only if a `CLAUDE.md` imports it. Two paths bring it in outside session start and neither is loading: `/init` under `CLAUDE_CODE_NEW_INIT=1` reads it, and `/import` (v2.1.213+) appends a one-time copy | <https://code.claude.com/docs/en/memory> | 2026-08-13 |
| official | Claude Code instruction surfaces, in load order: managed policy `/etc/claude-code/CLAUDE.md` and the `claudeMd` managed setting · `~/.claude/CLAUDE.md` · `./CLAUDE.md` or `./.claude/CLAUDE.md` · `./CLAUDE.local.md` · `.claude/rules/*.md`, path-scoped by `paths:` frontmatter · `@path` imports to depth 4 | <https://code.claude.com/docs/en/memory> | 2026-08-13 |
| official | Claude Code auto memory is **on by default**, keyed per repository and **shared across all worktrees of it**, disabled with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | <https://code.claude.com/docs/en/memory> | 2026-08-13 |
| official | *"If you set `CLAUDE_CONFIG_DIR`, every `~/.claude` path on this page lives under that directory instead"* — and `projects/<project>/memory/` is one of those paths | <https://code.claude.com/docs/en/claude-directory> | 2026-08-13 |
| official | MCP tool search is on by default and defers schemas; only tool names and server instructions load at session start; up to five tools load per search. `ENABLE_TOOL_SEARCH` takes unset · `true` · `auto` (activates above 10% of the context window) · `auto:N` · `false` | <https://code.claude.com/docs/en/agent-sdk/tool-search> | 2026-08-13 |
| official | *"Tool selection accuracy degrades with more than 30-50 tools loaded at once."* A qualitative statement about **loaded** tools, not a cap | <https://code.claude.com/docs/en/agent-sdk/tool-search> | 2026-08-13 |
| official | Gemini CLI's default context filename is `GEMINI.md`; `AGENTS.md` is **not** read by default and appears only as an example value of the `context.fileName` setting, which accepts a list. Load order: `~/.gemini/GEMINI.md`, then workspace directories and parents, then a just-in-time scan | <https://github.com/google-gemini/gemini-cli> `docs/cli/gemini-md.md` | 2026-08-13 |
| **unverified** | Codex reads `AGENTS.md`. The canonical page `developers.openai.com/codex/guides/agents-md` is **blocked by this environment's egress proxy**, and the repository's own `docs/agents_md.md` is a stub redirecting to it. Re-check from an environment that can reach `developers.openai.com`. A search-engine summary of the blocked page was available and was **deliberately not** recorded as a first-party retrieval | <https://github.com/openai/codex> `docs/agents_md.md` (stub) | 2026-08-13 |

Three of these rows exist because a remembered fact turned out to be wrong when checked.

The auto-memory rows are not trivia: they are *why* a run needs a scratch
`CLAUDE_CONFIG_DIR`. Auto memory is keyed per repository and shared across every worktree
of it, so without isolation a second repetition would start with notes from the first.
The `claude-directory` row is what makes the scratch directory sufficient rather than
merely hopeful — it relocates `projects/<project>/memory/` along with everything else, and
the run harness sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` on top of it, so the feature is
both off and pointed somewhere else. This was verified by observation as well as by
documentation: a probe session's `transcript_path` resolved under the scratch directory.

The tool-count rows are quoted rather than paraphrased because this repository has been
burned by a remembered "30 tool limit". Note carefully what the correction is: an earlier
draft said no source supported it, and **that was also wrong**. A first-party source says
accuracy degrades above 30-50 tools *loaded at once*. It is a qualitative claim about
loaded tools, it is not a cap, and it licenses **no threshold and no pass mark here** —
`toolContextEconomy` stays counts-only. The fix was to quote the source, not to keep
denying it.

### The leak scan has two halves, because the first half created the second

The token ban refuses every *token* of every command name, including ordinary English
like `check`, `plan`, `run` and `test`. It works, and it had a cost nobody priced: with
every command word unusable, prompt-writing pressure went straight into the vocabulary
the framework's own help text uses to *describe* those commands. That is a stronger hint
than the banned token — it points at one command rather than at the framework — and the
token scan cannot see it, because every word in it is ordinary English.

TS-05 asked *"does it hold up when the framework actually loads it"*. The help text for
`package test` reads *"does it hold up when a real application composes it?"* Five words
verbatim, no banned token, and the prompt was effectively naming its own answer.

So prompts are also scanned for **word n-gram overlap against the framework's prose** —
the CLI's `helpText()` and every Skill description, both already read by
`readAccordoSurface`.

**This is a leakage guard, not a proof of semantic neutrality.** Four-gram overlap catches
borrowed *phrasing*. It establishes nothing about whether a prompt is semantically
neutral, and no mechanical scan can: a prompt can point squarely at one command without
reusing a single word of its description. **Human review of every expected rail and first
family therefore remains mandatory**, exactly as it was before this scan existed. The scan
reduces the reviewer's load; it does not replace the reviewer, and a green scan is not
grounds for skipping the read.

The threshold was **measured, not chosen**:

| Width | Prompts flagged across all thirteen |
|---|---|
| n=3 | too common to enforce — matches `it does not` and `the framework s` as readily as anything meaningful |
| **n=4** | **TS-05 only** — `does it hold up`, `it hold up when` |
| n=5 | TS-05 only — `does it hold up when` |
| n=6 | none |

Four is enforced. It is the stricter of the two widths that work, it costs nothing today
because it flags no other prompt, and the direction of the trade is the one the token ban
already takes: over-inclusion costs prompt-writing effort, under-inclusion silently
invalidates every number the set ever produces.

Two judgements are recorded rather than hidden. Three-word overlap additionally finds
`a bounded domain` in TS-05, which is the framework's term for what the prompt describes;
three-word grams are too common to enforce (`it does not` matches as readily), and a
prompt must be allowed to describe the situation it is about. And the scan has a negative
control of its own: an empty prose corpus is refused rather than passing every prompt,
and a test plants a verbatim borrowing to prove the scan still catches one.

### The protocol fingerprint, and what stales it

The freeze is mechanical. `protocolFingerprint()` covers thirteen inputs, and refuses to
compute at all if one is missing — an omitted input would silently declare itself free to
change mid-run, which is the single thing the freeze exists to prevent:

| Input | Why it is in the fingerprint |
|---|---|
| `promptSetId` | identity of the set |
| `prompts` | prompt bytes, expected rail, expected first families, allowed alternatives |
| `fixtures` | fixture definitions, including the composition baseline |
| `fixtureFingerprints` | **what each fixture actually hashes to** — the six hundred files under test |
| `panelProfile` | which permission profile the panel is a panel of |
| `ngramWidth` | changes what counts as a leak |
| `cliHelpFingerprint` | **the leak guard's own corpus** |
| `skillDescriptionsFingerprint` | **the leak guard's own corpus** |
| `milestoneIdentifiersFingerprint` | the milestone-identifier ban list, read from `docs/` |
| `writeSemantics` | the CLI source that decides what writes |
| `permissionProfiles` | decides which metrics a cell can falsify |
| `scoreabilityMatrix` | decides which metrics a cell may report at all |
| `instrumentFingerprint` | **the measurer itself** — see below |

The table is documentation; the suite does not read it. It derives the input list from the
fingerprint's own arguments and requires each one both to be mandatory and to move the
value, so an input added tomorrow is covered on the commit that adds it. That is the shape
`fixtureFingerprints` needed and did not have: the freeze *recorded* the fixture map, the
fingerprint did not cover it, and deleting three characters from the document unbound the
tree under test while every receipt still reported the protocol current.

### Freezing the measurer, not only what it measures

Every input above is something the instrument *reads*. None of it is the instrument. A
protocol frozen that way could have its parser changed between cell 3 and cell 4 while
every receipt still verified against a fingerprint that never noticed — the same shape as
the defects this instrument spent its first review fixing: a guarantee written over the
part that was easy to hash.

`instrumentFingerprint` therefore digests the modules that **decide outcomes**: the
transcript parser, the outcome classifier, the mutation classifier, permission-event
interpretation, the leak scan, scoring, the scoreability derivation, the run contract and
the fixture builder. A change to any one stales the protocol and invalidates the cells
those decisions affected.

**The circularity is decided, not avoided.** The fingerprint module cannot hash itself, so
`benchmarks/tool-selection/freeze.js` is excluded — and named as excluded, with its reason,
in `EXCLUDED_FROM_INSTRUMENT`, which is itself hashed so that quietly adding an exclusion
moves the value. That exclusion is also why the fingerprint does not live in `contract.js`:
the run contract decides whether a receipt is valid, which is an outcome, so it has to be
*inside* the digest set. One module holding both would have forced a choice between
excluding the validator and hashing the hasher.

**Granularity errs toward over-staleness.** Components are hashed whole, so a comment edit
stales the protocol. Over-staleness costs a re-run; under-staleness costs a silently wrong
measurement, and the trade only runs one way. To keep it workable the refusal is
**attributed**: it names which components moved, so an operator can tell a comment edit
from a scoring change and re-run a subset rather than the panel. An unattributed
"the protocol is stale" is a message the next person works around.

### The freeze document is sealed, and the profile is part of it

`loadFreeze()` refuses a document carrying a key this contract does not define, and one
missing a key it does. The enumeration test above mutates every field the document *has*
and requires a cell to refuse; it said nothing at all about a field the document should
not have — so a freeze could carry `permissionProfile: "guarded"` and
`permission_profile: "unguarded"` side by side, and two readers of the same document
would report two different experiments. `computeFreeze()` checks its own output against
the same key list, so the producer and the seal cannot drift apart.

`executeRun()` compares the profile it was asked for against the one the freeze names,
before the run directory exists. The aggregate already excluded a mismatched receipt, so
the panel number was never wrong; what was wrong was the cell, which ran a real agent for
up to eight minutes and wrote `VALID_RUN` on a receipt no panel would admit. A
supplementary cell under the *other* profile is still a legitimate thing to run — it is
the only way the two restraint metrics are falsifiable at all, because the guarded profile
suspends every shell action — so it is asked for with `--off-panel` rather than forbidden.
Deliberate off-panel, not accidental waste.

### The runner refuses, it does not warn

`requireCurrentProtocol()` recomputes the protocol before a cell runs and **throws**
`PROTOCOL_STALE` on any mismatch. A run that proceeds against a drifted protocol produces
receipts that look valid and are not, which is worse than no run. An absent freeze is
refused too, as `PROTOCOL_UNFROZEN`: a panel run against an unfrozen protocol cannot be
shown to have measured one thing.

Every receipt binds, at minimum: `protocolFingerprint` · `instrumentFingerprint` ·
repository base SHA · prompt hash · fixture fingerprint · permission profile · harness and
version · model id **when observable** · instruction files **actually loaded, with their
hashes** · transcript digest. The two *when observable* fields keep the rule the rest of
the instrument already follows — observed, or `unresolved`, and never a silent fallback to
declared.

The two corpus rows have a consequence worth stating plainly rather than discovering
later: **a future PR that edits `helpText()` or a Skill description stales the protocol.**
That is correct, not inconvenient. Those corpora are the surface every prompt was checked
against, and a prompt that was clean against the old help text has not been checked
against the new one. Staleness is detected by recomputing and comparing, never assumed —
and a test proves each input moves the value and that none of them may be omitted, over
the input list the fingerprint itself declares rather than over a list typed beside it.

After the full run, no scoring-rule change is allowed without invalidating and re-running
the affected cells.

---

## 11. What a result may never be used for

- No public claim, no site change, no GTM change, no auto-published percentage.
- No ranking, no superiority claim, no comparison between products from an incomplete
  panel, and none at all from a single arm.
- No percentage without the planned denominator beside it.
- No promotion of a JTBD row. This instrument measures agent behaviour, not framework
  capability, and the two vocabularies are deliberately disjoint.

---

## 12. Standing limitations

1. **The instrument is a pilot.** The panel is prompts × arms × repetitions; anything
   short of it is incomplete and says so.
2. **Repetitions disagree.** Two runs of one prompt on one arm produced opposite
   first-action verdicts on the first day this instrument existed. Any future rate needs
   repetitions and a stated spread, not a single pass.
3. **One metric is a person.** `truthfulFinalLimitation` is operator-graded and stays
   `unresolved` without a verdict. A heuristic for it would produce a structured claim
   with unstructured reliability.
4. **Instruction loading is observed for the Claude Code arm and declared for the
   others.** An earlier draft of this limitation said loading was declared everywhere and
   unobservable from inside an arm. That was wrong, and it was wrong in the direction
   that made the instrument look weaker than it is. Claude Code emits an
   `InstructionsLoaded` hook, and a probe run on 2026-08-13 confirmed the payload carries
   `file_path`, `memory_type` and `load_reason` per file — the reasons being
   `session_start`, `nested_traversal`, `path_glob_match`, `include` and `compact`. The
   same probe confirmed the negative case: a rule scoped to `**/*.ts` did **not** fire in
   a session that read no TypeScript, so the hook reports what actually loaded rather than
   what exists on disk. Codex and Gemini CLI remain declared from vendor documentation.

   **The hook is wired, and the empty case is the part that needed designing.** The
   adapter declares two hooks in the scratch config directory: `InstructionsLoaded`
   appends its per-file payload to a log, and `SessionStart` writes a liveness marker.
   An empty instruction log alone is ambiguous — "this session loaded nothing" and "the
   hook never ran" are opposite readings of the same absence, and a benchmark that picked
   the flattering one would be publishing a clean observation of nothing. So the marker
   decides: present, and an empty log is an **observation** that nothing loaded; absent,
   and the field is `unresolved` whatever the log says. Every receipt carries
   `surfaces.instructionsLoaded` with a status of `observed` or `unresolved` — **never
   `declared`**, which is the vendor's documented load order wearing the word a reader
   takes for an observation. The declared list stays beside it under its own key, so a
   disagreement between the two is legible rather than hidden.

   Two consequences are stated rather than left to be found. The apparatus lives in the
   scratch config directory, not in the fixture, so the tree under test stays
   byte-identical to what the freeze named — which is why `--setting-sources` is now
   `project,user`: `user` resolves under `CLAUDE_CONFIG_DIR`, which this harness creates
   empty per cell, so the source admits this harness's own hooks and nothing of the
   operator's. And neither hook writes to stdout, because a `SessionStart` hook's stdout is
   added to the session's context and an apparatus that echoed anything would be feeding
   its own subject; a probe recorded `stdout: ""` on the hook_response event.
5. **Execution is out of scope.** Fixtures are uninstalled; a correctly selected command
   usually fails to run. The fixture *signals* above are an exception and were observed
   directly, because the framework's own CLI needs no dependency tree to run.
6. **`familiesLoaded` is unobservable for *this* CLI arm**, and is `null` rather than
   guessed. It is not unobservable in general, and the earlier unqualified wording
   overstated it: MCP tool search defers tool definitions and loads up to five per search,
   so loaded-versus-available is directly observable for an MCP arm. Nothing loads an
   `accordo` CLI schema, which is why the field is null here — a statement about this
   transport, not about the concept.
7. **The `expectedFirstFamilies` column is a judgement.** It is reviewed, justified per
   prompt and revisable — but it is the protocol's opinion about what a good first move
   is, and a reader who disagrees with a row should argue with the justification rather
   than with the number it produces.
