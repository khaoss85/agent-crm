# Coding-agent tool-selection benchmark (AX3 pilot)

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`,
`Decision Log` and `Outcome and Follow-up` current while the work proceeds.

This plan follows `.agent/PLANS.md`.

## Goal and User-visible Outcome

This repository has built seven rails — SEE, PLAN, BUILD, CHECK, PROVE, PRESERVE and the
package seam behind them — on the premise that a coding agent handed a normal business
goal will reach for the right one. Nothing checks the premise. `docs/benchmarks/` holds
a build benchmark and an unaided-recommendation protocol; neither observes rail
selection, and `docs/strategy/CODING_AGENT_DX_NORTH_STAR.md` names "drowning in tools,
then picking the wrong one" as a failure mode with **policy implemented, tools future**.

After this change there is a deterministic protocol, a machine-readable receipt, a
thirteen-prompt matrix that mechanically cannot name a command, seven isolated fixtures
and a runner that observes what an agent actually does — plus one honest pilot record.
No product command, MCP tool, runtime or routing layer is added, and no public claim
moves.

## Current Repository Context

- `docs/strategy/CODING_AGENT_DX_NORTH_STAR.md` — the rails and the DX Simplicity Gate.
- `docs/architecture/AGENT_TOOL_SURFACE.md` — the A/U/B/C warranty vocabulary for vendor
  facts, and B.1's rule that no numeric tool limit is written into a design document.
- `docs/benchmarks/PILOT_PROTOCOL.md`, `benchmarks/harness/` — the Edition L instrument
  whose operator discipline (verbatim prompt, no retry under one id, runs outside the
  checkout, `needs-operator` over a guess) this borrows wholesale.
- `docs/benchmarks/URR_PILOT_2026-08-10.md` — the invalid pilot that established the
  denominator rule this work enforces in code.
- `packages/core/src/solution-plan.js`, `packages/core/src/implementation-evidence.js`,
  `packages/cli/src/scenario-run-command.js` — the contract house style: canonical JSON,
  fingerprint over everything minus derived fields, closed problem vocabulary, bounded
  fields, refusals over truncation.
- `scripts/surface-check.js` — the budget this must not touch. The benchmark adds no
  Skill, no MCP tool and no command named in any Skill.

## Milestones

1. Derive the command surface from the CLI, define the rails, and build the prompt
   matrix with a mechanical leak scan.
2. Define `agentToolSelectionRunContract: 1` with six first-class outcomes and the
   scores-only-on-valid rule.
3. Build the fixture catalog with fingerprints, reset verification and an isolation scan
   that is the gate rather than the deny-list.
4. Build the thin arm adapters, the probe, the scorer and the aggregate that preserves
   the planned denominator.
5. Run a real pilot, record it honestly, and fix whatever it breaks.
6. Full verification battery, then a review PR left open.

## Validation

From the repository root, with Node 22.16.0 on PATH:

    npm install
    npm run verify
    npm run smoke
    npm run gtm:check
    node --no-warnings packages/cli/bin/accordo.js project doctor --json
    node --no-warnings packages/cli/bin/accordo.js project verify --json
    node benchmarks/tool-selection/run.js probe

Manual review must confirm: no prompt names a command and the check is a test rather
than a reading; an unavailable arm keeps its cell in the denominator; a wrong first
action is not repaired by a later right one; and no rate is published.

`node scripts/measure-suite.js --apply` is **not** run — this PR moves no public number.

## Progress

- [x] (2026-08-13) Derive the surface from `packages/cli/src/commands.js`, `package.json`
  scripts and the MCP tool list; write thirteen prompts; scan clean.
- [x] (2026-08-13) `agentToolSelectionRunContract: 1`, with the six outcomes, the
  no-scores-on-unscoreable refusal, secret and absolute-path refusals, and a canonical
  fingerprint.
- [x] (2026-08-13) Seven fixtures, deterministic and reset-verified; isolation scan
  proven by planting a marker after materialisation.
- [x] (2026-08-13) Probe: Claude Code available at 2.1.229; Codex and Gemini CLI absent
  from this machine and recorded as `NOT_RUN_HARNESS_UNAVAILABLE`.
- [x] (2026-08-13) Three valid Claude Code runs; nine receipts; pilot recorded in
  `docs/benchmarks/TOOL_SELECTION_PILOT_2026-08-13.md`.
- [x] (2026-08-13) Observe the declared fixture signals rather than declaring them:
  `clean-valid` passes diagnosis, `structural-drift` fails with exactly
  `skills.mirror-drift`, `stale-plan` exits 1 with `PLAN_STALE`.
- [x] (2026-08-13) Full battery on the branch.

## Surprises & Discoveries

- **The first real run broke the harness three ways, and every failure flattered
  somebody.** The outcome classifier scanned the transcript body for words like
  "authentication" and misreported a healthy run as an unavailable provider — the agent
  had merely *read a file containing the word*. The mutation classifier matched `rm -`
  inside `npm run crm -- app inspect`, so the correct first move scored as the run's
  first mutation. And a path placeholder written as `<fixture>` read as a shell redirect
  for the same detector. None of these would have shown up against a synthetic
  transcript.
- **A restraint metric can be structurally unfailable.** Under a guarded permission
  profile the harness denies every shell action, so the fixture cannot change and
  `noPrematureMutation` scored `met` on every run — measuring the guardrail, not the
  agent. Two declared profiles now exist and the suspended metrics report
  `not_applicable`.
- **A deny-list can break the fixture it protects.** Excluding `benchmarks/` and
  `docs/benchmarks/` wholesale removed the Edition L harness and the JTBD matrix, and
  `clean-valid` — the fixture defined by having nothing wrong with it — reported a broken
  `README.md` link. Found by actually running the diagnosis rail inside a materialised
  fixture rather than trusting the declared signal. The deny-list now names this
  benchmark's own files only, and a test pins that it is no wider.
- **Two repetitions of one prompt on one arm disagreed.** Same prompt, same fixture, same
  product, same day: one run reached `app inspect`, the other never ran an Accordo
  command at all. Any future rate from this instrument needs repetitions and a stated
  spread.
- **Most of the fixture states already exist in the repository.** The
  implementation-evidence gap is real (`govern-delivery-change` has no evidence document
  and the alignment matrix records the decision not to invent one), and manufacturing one
  by deleting a real evidence document would have produced an easier state.
- **Claude Code does not read `AGENTS.md`.** First-party documentation, read 2026-08-13.
  It reads `CLAUDE.md`, which in this repository points at `AGENTS.md` — so the arms do
  not start from identical context, and that is a vendor fact rather than a fairness
  choice of ours.

## Decision Log

- Decision: observe first real actions; reject self-report and reject a routing layer.
  Rationale: a stated intention is not a behaviour, and a router would make the benchmark
  the thing under test while adding an agent-facing runtime the DX Simplicity Gate
  refuses.
- Decision: derive the no-command-name lexicon from the CLI's help text rather than
  typing a list. Rationale: a hand-maintained list goes stale in the direction that makes
  the benchmark look better.
- Decision: refuse every *token* of every command name, with an empty exemption list.
  Rationale: over-inclusion costs prompt-writing effort; under-inclusion silently
  invalidates every number the set produces.
- Decision: `firstRelevantAction` is computed from the first Accordo family only, and
  recovery is a separate metric. Rationale: normalising a wrong first action away is the
  single most tempting way to make this instrument report better news than it has.
- Decision: an unavailable arm writes a receipt. Rationale: URR's lesson — a planned cell
  with no document is a planned cell that leaves the denominator.
- Decision: no numeric tool-count ceiling anywhere. Rationale: `AGENT_TOOL_SURFACE.md`
  B.1 — no source supports a universal number, and this project has been burned by a
  remembered one.
- Decision: do not commit raw transcripts. Rationale: they are large, they are mostly the
  fixture's own file contents, and `docs/QUALITY_GATES.md` §1.8 keeps logs out of the
  tree. Digests and fingerprints are committed instead, as the URR record does.

## Compatibility Backfill

**Not applicable, declared rather than skipped.** The Compatibility Backfill Rule covers
a *horizontal capability every domain could use*. This instrument observes coding-agent
behaviour against harnesses; no domain package has a status against it, no package
contract, capability, module-evolution path or agent-facing surface changes, and
`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` gains no row for the same reason the URR
measurement contract gained none.

## Outcome and Follow-up

Delivered: the protocol, the run contract, the prompt matrix and its mechanical leak
check, seven fixtures, thin adapters for three arms with only one runnable here, the
scorer and the denominator-preserving aggregate, the instrument freeze, and one pilot
record that is **void as measurement and kept as evidence about the instrument**.

That last point is the outcome, not a footnote. Exercising the instrument against a real
agent found nine defects, five of which inverted the meaning of a metric, and none of
which a green test suite had caught — a permission profile that denied every write it
claimed to permit, approvals stamped with the wrong action's ordinal, a refusal decided
by a regular expression over the agent's prose, a delegate's actions counted as the
agent's own, and a write flag matched anywhere in a command line. The receipts those runs
produced are excluded from every aggregate as `INVALID_INSTRUMENT_VERSION`. No panel has
been run under the corrected instrument.

Follow-up, none of it in this PR:

- run the remaining prompts, and run repetitions, once more than one arm is installable;
- a Codex arm needs its first-party facts verified from an environment that can reach
  `developers.openai.com`, per `AGENT_TOOL_SURFACE.md`'s open question 1;
- an MCP / tool-search arm stays separate work and is gated on DX13, which does not exist;
- `truthfulFinalLimitation` remains operator-graded and is the honest size of what is
  still a person reading a transcript.
