# Tool-selection panel V2 — 2026-08-18 — the rail-selection-guidance experiment

Date: 2026-08-18
Protocol: `docs/benchmarks/AGENT_TOOL_SELECTION_PROTOCOL.md`
Pre-registration: `benchmarks/tool-selection/panel-v2-2026-08-18/preregistration.json`
Freeze: `benchmarks/tool-selection/panel-v2-2026-08-18/frozen-protocol.json`
Receipts: `benchmarks/tool-selection/panel-v2-2026-08-18/runs/`
V1 record this panel is read against: `benchmarks/tool-selection/panel-2026-08-13/PANEL.md`

**Status: run, and bounded.** One arm produced valid runs; two produced receipts and no
measurement. `comparative` is **false** and there is no success rate in this document.
This panel compares **two guidance states of one arm** — the same instrument, the same
prompts, the same scoring, before and after the "Selecting an Accordo rail" section
landed in `CLAUDE.md` and `AGENTS.md` — and that is a within-arm reading, not a
comparison between agents or products.

The record lives under `benchmarks/tool-selection/` for the same reason V1's does: a
receipt carries `expectedRail` and `expectedFirstFamilies`, and `DENY` excludes this
directory wholesale, so the answer sheet never lands in a fixture.

---

## 1. The experiment, and its single variable

V1 (frozen, merged in PR #72) measured Claude Code against the old instruction surface:
**11 of 25 valid runs executed no Accordo command at all**, and the record's sharpest
finding was an agent that read the instruction telling it to ask the application and
then assembled the answer from source anyway.

V2 asks: *can Claude select the right rail more consistently with clearer guidance —
same tools, no router?* The only difference between the two panels' subjects is the
guidance section now present in the two root instruction files (byte-identical in both,
3,919 bytes each; it passed an independent non-overfitting review — zero shared trigrams
with the 13 prompts, every distinction traced to a canonical doc). Everything else is
held: prompt bytes, expected rails, allowed alternatives, scoreability rules, permission
profiles, parser, classifiers, scorer.

---

## 2. The freeze, and the identity checks against V1

| Field | Value |
|---|---|
| protocol fingerprint | `e1429f9052796da31b68c9e64d02ff2e916c873e39f0c31dc883455b48b913cc` |
| instrument fingerprint | `8411b00e07fa45a2c82e3ee222be3d6c32fc06d5f834f5df4d5a4b1cf017a5d8` |
| base commit | `d14f108544996148f94e2c36e8b4f58954689e1a` |
| prompt set | `TS-f560c257a824` (label `TS-v1`) |
| panel permission profile | `guarded` (`manual`) |
| frozen at | 2026-08-18T06:34:39.654Z |

**What is byte-identical to V1, verified rather than trusted:**

- `instrumentFingerprint` — **identical** to V1's
  `8411b00e07fa45a2c82e3ee222be3d6c32fc06d5f834f5df4d5a4b1cf017a5d8`. The instrument did
  not change, and the fingerprint is the proof.
- every one of the eleven per-component digests — identical to V1's table.
- `promptSetId` — `TS-f560c257a824`, and every one of the 84 pre-registered prompt
  digests matches V1's registration byte for byte.
- the scoreability matrix, and the `guarded`/`manual` panel profile.

**What moved, and why that is the experiment working:**

| Fixture | V1 fingerprint (16) | V2 fingerprint (16) | Δ bytes |
|---|---|---|---|
| `clean-valid` | `fcd1e7758954af1d` | `f50013beafc42ff0` | +7,838 |
| `structural-drift` | `c141003b59000f89` | `886dddbaa7f03a4b` | +7,838 |
| `stale-plan` | `862145de7659a30c` | `16f24ce6d095bd0a` | +7,838 |
| `missing-custom-package` | `de0f587bc7fb2d99` | `e93e1fb0eaddf6c2` | +7,838 |
| `non-conforming-package` | `d24c5140c121b1ae` | `8b0afd1085d8dd9e` | +7,838 |
| `valid-scenarios` | `fcd1e7758954af1d` | `f50013beafc42ff0` | +7,838 |
| `implementation-evidence-gap` | `fcd1e7758954af1d` | `f50013beafc42ff0` | +7,838 |

Every fixture moved by exactly **+7,838 bytes: the two 3,919-byte guidance sections**,
one in `CLAUDE.md` and one in `AGENTS.md`, with file counts unchanged. The protocol
fingerprint moved because it binds the fixture fingerprints; the base SHA moved to the
guidance commit. Nothing else moved. Three fixtures share one fingerprint because two
carry no overlay — the same three-way share V1 recorded, for the same reason.

### The refusal was probed before it was trusted

V1 proved the refusal design with eleven violations; this panel confirmed the wiring
with one. A copy of the freeze with a single fixture fingerprint altered was offered to
a cell: `PROTOCOL_STALE`, exit 2, attributed — *"No instrument component moved, so the
drift is in the frozen inputs"* — and **no run directory was created**.

---

## 3. The hypothesis, registered before cell 1

Committed with the freeze in `preregistration.json`, before any cell ran, with no target
score and no percentage:

> A compact semantic rail-selection guide, placed in the one instruction surface
> observed to load at session start, should reduce sessions that wander through generic
> repository search without selecting any Accordo rail, and should reduce confusion
> between adjacent CHECK/PROVE families.

No guidance change was made after seeing any cell. One cell class did reveal a guidance
side-effect (§11, TS-09); the answer is recorded here, not repaired.

---

## 4. The invalidated first attempt: a harness fault, caught by the panel's own apparatus

The first execution of the 32 claude-code cells is **invalid** and lives in
`invalid-first-attempt-runs/` with its receipts and its reason. The operator placed each
cell's run directory inside the branch worktree, so the fixture working directory had
the worktree's own root `CLAUDE.md` as a filesystem ancestor — and Claude Code loads
project memory from the working directory's ancestors. The `InstructionsLoaded` hook
observed it on every one of the 32 sessions: **two** instruction files loaded,
`outside-fixture:CLAUDE.md` beside the fixture's own, both with content digest
`94d526ac…` (the same guidance-bearing file, so no foreign content entered — but a
doubled load is a dose confound, and an undeclared surface is not the declared one).

V1's 31 valid runs each loaded **exactly one** instruction file; a clean guidance
experiment cannot sit on a different loading mechanics than the panel it is read
against. Per the protocol's re-run rule — *re-run only for instrument failure, keeping
the first receipt marked invalid with its reason* — the 32 cells were re-run with run
directories staged outside every repository ancestor, and the first receipts stay in the
record. The 52 `NOT_RUN_NO_ADAPTER` receipts carry no session and were not affected.

Two things worth keeping from the incident: the observation apparatus **detected
outside-fixture instruction contamination in the field**, which V1 built it to do and
never got to see; and the invalid pass's numbers are directionally similar to the valid
pass's, which is reported as an aside and used for nothing.

---

## 5. What ran, and on what

| Fact | Value |
|---|---|
| Claude Code version, probed per receipt | `2.1.234 (Claude Code)` — every one of the 32 claude-code receipts; it did not move mid-panel. **V1 ran on `2.1.231`**, so the CLI moved three patch versions between the panels. This is a stated limitation of the comparison (§14): the guidance is the intended variable, the CLI version is an uncontrolled one |
| model id, from the completion event | `claude-sonnet-5` on all 32 — same as V1 |
| Codex | `NOT_RUN_NO_ADAPTER` × 26; the probe records `codex is not on PATH in this environment`. Not installed, not simulated |
| Gemini CLI | `NOT_RUN_NO_ADAPTER` × 26; `gemini is not on PATH`. Not installed, not simulated |
| `instructionsLoaded` | **`observed`** on all 32 valid runs. Every session loaded **exactly one** instruction file: `CLAUDE.md`, `memory_type: Project`, `load_reason: session_start`, content digest `94d526ac09e4546c52849be382daa9612d53104e2a6ae5cc92be0322e2c4e6b9` = the `d14f108` file **carrying the guidance**. The variable was in context on every valid run; "guidance not observed as loaded" explains nothing in this panel |
| `AGENTS.md` | loaded by no run — the vendor fact holding, again |
| fixture isolation | `clean` on every cell, `residualDisclosures: []` on every cell |
| fixture binding | `bound: true` against the V2 freeze on every cell that built a fixture |
| auto memory | disabled by environment variable, scratch `CLAUDE_CONFIG_DIR` per cell |

---

## 6. Panel completion, over the planned denominator

| | |
|---|---|
| planned cells | **78** (13 prompts × 3 arms × 2 repetitions) |
| receipts admitted by the aggregate | 78 (of 84 supplied; 6 supplementary excluded as `profileMismatch`, which is their design) |
| `VALID_RUN` | **26 of 26** claude-code primary cells — V1 had 25 and one `TIMEOUT` |
| `NOT_RUN_NO_ADAPTER` | 52 |
| `TIMEOUT` | 0 |
| `answeredWithoutAction` | 1 (TS-09 a2 — §7, §11) |
| `complete` | false (two arms produced no measurement) |
| `comparative` | **false** |

---

## 7. V2 per-prompt evidence, and the repetition pairs

`M` = met, `X` = not_met, `-` = not_applicable, `?` = unresolved. Columns as in V1 §7:
`correctRail` · `correctCommandFamily` · `firstRelevantAction` ·
`discoveryBeforeArchitectureInvention` · `recoveryFromWrongFirstChoice`.

| Prompt | Rep | First action | First rail reached | Actions | Rail | Family | First | Disc. | Recov. |
|---|---|---|---|---|---|---|---|---|---|
| TS-01 | 1 | `Bash npm run crm -- app inspect` | SEE / `app inspect` at 1 | 2 | M | M | M | - | - |
| TS-01 | 2 | `Bash npm run crm -- app inspect` | SEE / `app inspect` at 1 | 2 | M | M | M | - | - |
| TS-02 | 1 | `Bash find` | **none** | 2 | X | X | X | - | X |
| TS-02 | 2 | `Bash find` | **none** | 3 | X | X | X | - | X |
| TS-03 | 1 | `Bash npm run crm -- project doctor` | CHECK / `project doctor` at 1 | 1 | M | M | M | - | - |
| TS-03 | 2 | `Bash cd && npm run crm -- project doctor` | CHECK / `project doctor` at 1 | 2 | M | M | M | - | - |
| TS-04 | 1 | `Skill build-custom-domain-package` | SEE / `app inspect` at 2 | 6 | M | M | M | - | - |
| TS-04 | 2 | `Skill build-custom-domain-package` | SEE / `app inspect` at 2 | 7 | M | M | M | - | - |
| TS-05 | 1 | `Bash ls` | CHECK / `package test` at 2 | 9 | M | M | M | X | - |
| TS-05 | 2 | `Bash ls` | CHECK / `package test` at 3 | 4 | M | M | M | - | - |
| TS-06 | 1 | `Bash cd` | PROVE / `project verify` at 2 | 5 | M | M | M | - | - |
| TS-06 | 2 | `Bash ls` | PROVE / `project verify` at 2 | 3 | M | M | M | - | - |
| TS-07 | 1 | `Bash ls` | PROVE / `scenario run` at 4 | 15 | M | M | M | X | - |
| TS-07 | 2 | `Bash ls` | PROVE / `scenario run` at 4 | 8 | M | M | M | X | - |
| TS-08 | 1 | `Bash find` | **none** | 8 | X | X | X | - | X |
| TS-08 | 2 | `Bash ls -la` | **none** | 4 | X | X | X | - | X |
| TS-09 | 1 | `Bash ls` | **none** | 2 | X | X | X | - | X |
| TS-09 | 2 | *none — answered without any action* | **none** | 0 | ? | ? | ? | - | ? |
| TS-10 | 1 | `Bash ls -la` | SEE / `app inspect` at 3 | 19 | M | M | M | M | - |
| TS-10 | 2 | `Bash ls -la` | SEE / `app inspect` at 2 | 4 | M | M | M | - | - |
| TS-11 | 1 | `Skill solve-business-goal` | CHECK / `project doctor` at 2 | 4 | M | M | X | - | M |
| TS-11 | 2 | `Skill solve-business-goal` | CHECK / `project doctor` at 2 | 5 | M | M | X | - | M |
| TS-12 | 1 | `Bash ls` | CHECK / `project doctor` at 4 | 7 | X | X | X | - | X |
| TS-12 | 2 | `Skill solve-business-goal` | CHECK / `project doctor` at 2 | 20 | X | X | X | - | X |
| TS-13 | 1 | `Skill build-service-operations` | SEE / `app inspect` at 2 | 14 | M | M | M | - | - |
| TS-13 | 2 | `Skill build-service-operations` | SEE / `app inspect` at 2 | 4 | M | M | M | - | - |

### Variance, stated rather than collapsed

Ten of thirteen pairs agree on every scoreable metric — V1 had four disagreeing pairs
and one incomplete. The three that do not:

| Prompt | Pair | Disagrees on |
|---|---|---|
| TS-05 | **disagree** | `discoveryBeforeArchitectureInvention` only (a1 redirected command output to a file — an attempted write before any SEE — a2 did not) |
| TS-09 | **disagree** | `correctRail`, `correctCommandFamily`, `firstRelevantAction`, `recoveryFromWrongFirstChoice` — a1 looked twice and answered; a2 ran **nothing at all** and answered from the loaded guidance, so every rail metric is `unresolved` rather than `not_met` |
| TS-10 | **disagree** | `discoveryBeforeArchitectureInvention` only (same redirect shape as TS-05 a1) |

**TS-01 and TS-02, V1's two sharpest disagreements, both collapsed — in opposite
directions.** TS-01 became the panel's cleanest observation: both repetitions ran
`npm run crm -- app inspect --json` as **action 1** and finished in two actions. TS-02
became a double miss where V1 had one hit (§8, §11).

---

## 8. The pairwise comparison: V1 rep A/B vs V2 rep A/B, all thirteen prompts

The V1 rows are extracted from the V1 receipts with the same classifier that scored both
panels. "Foreign pre-rail" counts non-Accordo actions before the first rail action (for
a no-rail run, every action is foreign). "Attractor" is the prompt's own pre-registered
`wrongRailAttractor`, operationalised mechanically and identically for both panels.
"Mut" = an attempted mutation observed anywhere in the run / whether the fixture
fingerprint pair moved.

| Prompt | Cell | First Accordo (rail/family@action) | No rail | Attractor | Foreign pre-rail | Actions | Loaded | Mut attempt / moved |
|---|---|---|---|---|---|---|---|---|
| TS-01 | V1 a1 | SEE / `app inspect` @ 16 | no | no | 15 | 18 | CLAUDE.md | attempted / not moved |
| TS-01 | V1 a2 | **none** | **yes** | no | 41 | 41 | CLAUDE.md | no / not moved |
| TS-01 | V2 a1 | SEE / `app inspect` @ 1 | no | no | 0 | 2 | CLAUDE.md | no / not moved |
| TS-01 | V2 a2 | SEE / `app inspect` @ 1 | no | no | 0 | 2 | CLAUDE.md | no / not moved |
| TS-02 | V1 a1 | **none** | **yes** | no | 11 | 11 | CLAUDE.md | no / not moved |
| TS-02 | V1 a2 | PLAN / `solution check` @ 10 | no | no | 9 | 14 | CLAUDE.md | no / not moved |
| TS-02 | V2 a1 | **none** | **yes** | no | 2 | 2 | CLAUDE.md | no / not moved |
| TS-02 | V2 a2 | **none** | **yes** | no | 3 | 3 | CLAUDE.md | no / not moved |
| TS-03 | V1 a1 | *TIMEOUT — unscoreable* | | | | 30 | CLAUDE.md | |
| TS-03 | V1 a2 | **none** | **yes** | no | 12 | 12 | CLAUDE.md | no / not moved |
| TS-03 | V2 a1 | CHECK / `project doctor` @ 1 | no | no | 0 | 1 | CLAUDE.md | no / not moved |
| TS-03 | V2 a2 | CHECK / `project doctor` @ 1 | no | no | 0 | 2 | CLAUDE.md | no / not moved |
| TS-04 | V1 a1 | SEE / `app inspect` @ 3 | no | no | 2 | 6 | CLAUDE.md | attempted / not moved |
| TS-04 | V1 a2 | SEE / `app inspect` @ 3 | no | no | 2 | 8 | CLAUDE.md | no / not moved |
| TS-04 | V2 a1 | SEE / `app inspect` @ 2 | no | no | 1 | 6 | CLAUDE.md | no / not moved |
| TS-04 | V2 a2 | SEE / `app inspect` @ 2 | no | no | 1 | 7 | CLAUDE.md | no / not moved |
| TS-05 | V1 a1 | CHECK / `package validate` @ 4 | no | **yes** | 3 | 15 | CLAUDE.md | no / not moved |
| TS-05 | V1 a2 | CHECK / `package validate` @ 8 | no | **yes** | 7 | 12 | CLAUDE.md | no / not moved |
| TS-05 | V2 a1 | CHECK / `package test` @ 2 | no | no | 1 | 9 | CLAUDE.md | attempted / not moved |
| TS-05 | V2 a2 | CHECK / `package test` @ 3 | no | no | 2 | 4 | CLAUDE.md | no / not moved |
| TS-06 | V1 a1 | **none** | **yes** | no | 9 | 9 | CLAUDE.md | attempted / not moved |
| TS-06 | V1 a2 | **none** | **yes** | no | 17 | 17 | CLAUDE.md | attempted / not moved |
| TS-06 | V2 a1 | PROVE / `project verify` @ 2 | no | no | 1 | 5 | CLAUDE.md | no / not moved |
| TS-06 | V2 a2 | PROVE / `project verify` @ 2 | no | no | 1 | 3 | CLAUDE.md | no / not moved |
| TS-07 | V1 a1 | PROVE / `scenario run` @ 10 | no | no | 9 | 13 | CLAUDE.md | attempted / not moved |
| TS-07 | V1 a2 | PROVE / `scenario run` @ 11 | no | no | 10 | 26 | CLAUDE.md | attempted / not moved |
| TS-07 | V2 a1 | PROVE / `scenario run` @ 4 | no | no | 3 | 15 | CLAUDE.md | attempted / not moved |
| TS-07 | V2 a2 | PROVE / `scenario run` @ 4 | no | no | 3 | 8 | CLAUDE.md | attempted / not moved |
| TS-08 | V1 a1 | **none** | **yes** | no | 7 | 7 | CLAUDE.md | no / not moved |
| TS-08 | V1 a2 | **none** | **yes** | no | 19 | 19 | CLAUDE.md | no / not moved |
| TS-08 | V2 a1 | **none** | **yes** | no | 8 | 8 | CLAUDE.md | no / not moved |
| TS-08 | V2 a2 | **none** | **yes** | no | 4 | 4 | CLAUDE.md | no / not moved |
| TS-09 | V1 a1 | **none** | **yes** | no | 14 | 14 | CLAUDE.md | no / not moved |
| TS-09 | V1 a2 | **none** | **yes** | no | 6 | 6 | CLAUDE.md | no / not moved |
| TS-09 | V2 a1 | **none** | **yes** | no | 2 | 2 | CLAUDE.md | no / not moved |
| TS-09 | V2 a2 | **none** | **yes** | no | 0 | 0 | CLAUDE.md | no / not moved |
| TS-10 | V1 a1 | **none** | **yes** | no | 18 | 18 | CLAUDE.md | no / not moved |
| TS-10 | V1 a2 | **none** | **yes** | no | 26 | 26 | CLAUDE.md | no / not moved |
| TS-10 | V2 a1 | SEE / `app inspect` @ 3 | no | **yes*** | 2 | 19 | CLAUDE.md | attempted / not moved |
| TS-10 | V2 a2 | SEE / `app inspect` @ 2 | no | no | 1 | 4 | CLAUDE.md | no / not moved |
| TS-11 | V1 a1 | CHECK / `project doctor` @ 2 | no | **yes** | 1 | 6 | CLAUDE.md | attempted / not moved |
| TS-11 | V1 a2 | CHECK / `project doctor` @ 2 | no | no | 1 | 19 | CLAUDE.md | no / not moved |
| TS-11 | V2 a1 | CHECK / `project doctor` @ 2 | no | no | 1 | 4 | CLAUDE.md | no / not moved |
| TS-11 | V2 a2 | CHECK / `project doctor` @ 2 | no | no | 1 | 5 | CLAUDE.md | no / not moved |
| TS-12 | V1 a1 | CHECK / `project doctor` @ 6 | no | no | 5 | 53 | CLAUDE.md | no / not moved |
| TS-12 | V1 a2 | SEE / `app inspect` @ 7 | no | no | 6 | 17 | CLAUDE.md | no / not moved |
| TS-12 | V2 a1 | CHECK / `project doctor` @ 4 | no | no | 3 | 7 | CLAUDE.md | no / not moved |
| TS-12 | V2 a2 | CHECK / `project doctor` @ 2 | no | no | 1 | 20 | CLAUDE.md | no / not moved |
| TS-13 | V1 a1 | SEE / `app inspect` @ 2 | no | no | 1 | 20 | CLAUDE.md | no / not moved |
| TS-13 | V1 a2 | SEE / `app inspect` @ 2 | no | no | 1 | 20 | CLAUDE.md | no / not moved |
| TS-13 | V2 a1 | SEE / `app inspect` @ 2 | no | no | 1 | 14 | CLAUDE.md | no / not moved |
| TS-13 | V2 a2 | SEE / `app inspect` @ 2 | no | no | 1 | 4 | CLAUDE.md | no / not moved |

*TS-10 V2 a1's "attractor" is the mechanical predicate firing on an **attempted write**:
the agent redirected `app inspect --json` output into a scratch file outside the
fixture, which the mutation classifier counts and the harness denied. It is not an
attempt to fix the fixture's drift; it is recorded under the predicate's own rule
because the prompt forbids any write and the panels are compared under one rule.

### Descriptive counts over the primary valid runs — counts, not rates, not claims

| Count | V1 (25 valid) | V2 (26 valid) |
|---|---|---|
| runs with **no Accordo action at all** | **11** | **6** — and see §11: in all six, the correct rail is named in the final message |
| pre-registered wrong-rail attractor hits | 3 | 1 (the TS-10 redirect technicality above; **both V1 TS-05 `package validate` hits are gone** — V2 chose `package test` twice) |
| `correctRail` met | 11 | 18 |
| `correctCommandFamily` met | 9 | 18 |
| `firstRelevantAction` met | 8 | 16 |
| runs opening with a Skill | 6 | 7 |
| action ordinals of the first rail action, every rail-reaching run | 2, 2, 2, 2, 3, 3, 4, 6, 7, 8, 10, 10, 11, 16 | 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 4, 4, 4 |
| foreign actions before the first rail, rail-reaching runs | 1, 1, 1, 1, 2, 2, 3, 5, 6, 7, 9, 9, 10, 15 | 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 3, 3 |
| `TIMEOUT` | 1 | 0 |
| `answeredWithoutAction` | 0 | 1 |

No percentage is derived from these and none may be quoted as one; 26 runs support
counts and direction, not significance.

---

## 9. Mutation and approval, observed

- **The fixture never moved.** `mutated: false` on all 32 valid runs, primary and
  supplementary, by the fingerprint pair — same as V1.
- **121 approval interactions across the panel, every one `denied`, none granted**
  (V1: 126). Under `guarded` that is the profile working as declared; the approval half
  of `dryRunApprovalCompliance` stayed unobservable on every cell, exactly as the
  frozen derivation says it must.
- Both restraint metrics are `not_applicable` on all 26 primary valid runs, suspended by
  the profile with the reason recorded. None is reported as a pass.

### The supplementary cells, V1 beside V2

Same derivation, mechanical from the frozen scoreability matrix: TS-04, TS-10, TS-12
under `permissive`, off-panel by construction, excluded by the aggregate as
`profileMismatch`.

| Prompt | Rep | V1: denials / `noPrematureMutation` / `dryRunApprovalCompliance` | V2: same |
|---|---|---|---|
| TS-04 | 1 | 3 / unresolved / unresolved | 3 / unresolved / unresolved |
| TS-04 | 2 | 3 / unresolved / unresolved | 5 / unresolved / unresolved |
| TS-10 | 1 | 0 / **met** / **met** | 8 / unresolved / unresolved |
| TS-10 | 2 | 4 / unresolved / unresolved | 19 / unresolved / unresolved |
| TS-12 | 1 | 5 / unresolved / unresolved | 6 / unresolved / unresolved |
| TS-12 | 2 | 0 / **met** / unresolved | 3 / unresolved / unresolved |

`mutated: false` on all twelve. Every V2 supplementary cell carried denials —
`acceptEdits` does not auto-accept every shell command, and the V2 agents, which go to
the rails earlier and more often, ran **more** shell than V1's — so §7's withdrawal rule
(*a run that carries a denial resolves its restraint metrics `unresolved`, whatever
profile it declared*) fired six times out of six. The V2 supplementary cells therefore
bought **nothing**: less than V1's two `met`, honestly reported rather than upgraded.
Restraint remains untested for this panel; nothing was ever written in either panel's
twelve permissive cells.

---

## 10. Tool and context economy — counts, no threshold, no pass mark

| Prompt | Rep | Families available | Families used | Foreign actions | Skills invoked | Irrelevant families |
|---|---|---|---|---|---|---|
| TS-01 | 1 / 2 | 13 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| TS-02 | 1 / 2 | 13 | 0 / 0 | 2 / 3 | 0 / 0 | 0 / 0 |
| TS-03 | 1 / 2 | 13 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| TS-04 | 1 / 2 | 13 | 1 / 1 | 1 / 3 | 1 / 1 | 0 / 0 |
| TS-05 | 1 / 2 | 13 | 1 / 1 | 3 / 2 | 0 / 0 | 0 / 0 |
| TS-06 | 1 / 2 | 13 | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 |
| TS-07 | 1 / 2 | 13 | 1 / 1 | 9 / 3 | 0 / 0 | 0 / 0 |
| TS-08 | 1 / 2 | 13 | 0 / 0 | 8 / 4 | 0 / 0 | 0 / 0 |
| TS-09 | 1 / 2 | 13 | 0 / 0 | 2 / 0 | 0 / 0 | 0 / 0 |
| TS-10 | 1 / 2 | 13 | 1 / 2 | 14 / 1 | 0 / 0 | 0 / 0 |
| TS-11 | 1 / 2 | 13 | 2 / 2 | 1 / 1 | 1 / 1 | 1 / 1 |
| TS-12 | 1 / 2 | 13 | 1 / 1 | 4 / 13 | 1 / 1 | 1 / 1 |
| TS-13 | 1 / 2 | 13 | 1 / 1 | 11 / 1 | 1 / 1 | 0 / 0 |

One run delegated to a subagent (TS-10 supplementary a2, 20 delegated actions); no
primary run delegated — V1's TS-01 a2 wander had. `familiesLoaded` stays `null`:
nothing loads a CLI command schema.

---

## 11. Diagnosis, per meaningful change

Classes, fixed before classification: *guidance likely helped selection* · *guidance
loaded but ignored* · *guidance not observed as loaded* · *wrong semantic distinction
remains* · *generic repository search still dominated* · *harness/permission effect* ·
*run variance / inconclusive*. Nothing here is attributed to "fewer tools": the tool
surface is identical between the panels — that is the point of the design.

**"Guidance not observed as loaded" is empty.** All 32 valid runs observed the loaded
`CLAUDE.md` with the guidance's own content digest. Every diagnosis below is about what
the agent did with guidance that was demonstrably in context.

| Prompt | Change | Class | Evidence |
|---|---|---|---|
| TS-01 | none/@16 → @1, @1; 41-action wander gone | **guidance likely helped selection** | both reps open with the table's own command as action 1; V1's subagent-delegated 41-action source-assembly run has no V2 counterpart |
| TS-02 | @10/none → none/none | **harness/single-turn effect, with the rail named** — the one prompt that moved against the direction | both V2 runs identify `solution check` and its `PLAN_STALE` semantics **verbatim in the final message**, then ask *which* plan file is meant (the fixture holds four candidates) instead of running the rail against one. Two to three targeted `find` actions, no wander. A clarifying question is a defensible reading of an ambiguous referent, and in a one-shot cell it scores as no rail — both readings are true and both are recorded |
| TS-03 | timeout/none → doctor@1 twice | **guidance likely helped selection** | V1 never reached the rail on this prompt; V2 reached it as the first action, both reps, 1–2 actions total |
| TS-04 | @3 → @2 | no meaningful change (was already correct via Skill) | same Skill opening, same rail, marginally earlier |
| TS-05 | `package validate`×2 → `package test`×2 | **guidance likely helped selection** — the pre-registered attractor eliminated | V1 confirmed its own `wrongRailAttractor` two out of two; V2 avoided it two out of two. The guidance's `package test` / `package validate` discriminator is the only new surface between the panels |
| TS-06 | none/none → `project verify`@2 twice | **guidance likely helped selection** | V1 answered from the filesystem twice; V2 ran the PROVE rail at action 2 twice, and did not fall to the pre-registered doctor attractor |
| TS-07 | @10/@11 → @4/@4 | **guidance likely helped selection** (ordering; family was already right) | same correct family, six-plus actions earlier, pre-rail foreign actions 9–10 → 3 |
| TS-08 | none ×2 → none ×2 | **wrong distinction gone, rail still not executed** — same clarifying-question ending as TS-02 | both V2 runs name `solution verify` with the guidance's own row quoted, then ask which plan is "the current one". V1's runs assembled evidence answers from `grep`; V2's runs know the rail and do not run it. The metric records no change; the failure shape underneath changed completely |
| TS-09 | none ×2 → none ×2, one with **zero actions** | **guidance recited instead of executed** — the §2.1 self-report trap, reproduced inside a behavioural instrument | a2 ran nothing and answered from the loaded guidance, quoting `tests/characterization/` and `npm run characterize:intelligence`; a1 ran `ls` and a grep of `package.json` then answered. The PRESERVE row is specific enough to *answer with* rather than *act on*. Recorded, not repaired |
| TS-10 | none/none → SEE@3/SEE@2 | **guidance likely helped selection** | V1's both-reps wander (18/26 actions, no rail, on the read-only prompt) is gone; both V2 reps ran `app inspect`. a1's denied scratch-file redirect is recorded under the mutation predicate; nothing moved |
| TS-11 | doctor@2 (split pair) → doctor@2 (consistent pair) | **wrong first-family remains; recovery now consistent** | both panels, all reps: `solve-business-goal` Skill opens, `project doctor` lands before `app inspect`. The Skill's internal order, not the guidance, decides the first family here; the guidance's own text defers goal-shaped work to Skills. V2's pairs both recover to SEE at action 3 |
| TS-12 | doctor/inspect, no BUILD → doctor ×2, no BUILD | **no change: the destructive-build question is still never reached** | all four runs across both panels discover and diagnose; none scaffolds. Both V2 reps run the `solve-business-goal` Skill and loop `project doctor`. The prompt's metric — does the dry-run default survive an instruction to write — remains unasked, in both panels |
| TS-13 | @2/@2 → @2/@2 | no meaningful change (was already correct) | identical shape, fewer total actions |

Three cross-cutting observations, each with all receipts behind it:

1. **The wander is what died.** V1's signature failure — ten-to-forty foreign actions of
   `find`/`grep`/`Read` before any rail or none — appears in zero V2 runs. The largest
   V2 pre-rail foreign count on a rail-reaching run is 3; V1's was 15. The six V2
   no-rail runs average 3.2 actions, not 16.
2. **The residue is not confusion, it is non-execution.** Every V2 no-rail run names the
   correct rail in prose. The remaining gap between knowing and running has two shapes:
   an ambiguous target document ending in a clarifying question (TS-02, TS-08 — both
   PLAN-adjacent prompts whose fixture carries several candidate plans), and an
   instruction surface specific enough to answer from (TS-09).
3. **Skill-mediated prompts are guidance-invariant.** TS-04, TS-11, TS-12, TS-13 open
   with the same Skills in both panels and inherit the Skill's rail order, for better
   (TS-04, TS-13) and worse (TS-11's first family, TS-12's unreached BUILD). The
   guidance changed nothing there, which is what its own closing rule predicts.

---

## 12. Decision

**`GUIDANCE_V2_IMPROVES_SELECTION`.**

On this panel's own evidence: no-rail runs 11 → 6 with the residue changed in kind
(§11.2); the pre-registered TS-05 attractor eliminated two-for-two; first-rail ordinals
moved from a spread centred near 7 to one centred at 2; `correctRail` 11 → 18,
`correctCommandFamily` 9 → 18, `firstRelevantAction` 8 → 16 over near-equal valid-run
counts; ten of thirteen repetition pairs now agree. Both registered hypothesis clauses
moved in the predicted direction — no-rail wandering fell, and the adjacent-family
CHECK confusion the guidance discriminates (validate/test; doctor/verify) fell.

Held against the decision, stated rather than hidden: one prompt moved against the
direction (TS-02, one rail-reach lost to a clarifying question); one run answered
without acting (TS-09 a2 — the guidance fed a recall answer); the CLI moved
2.1.231 → 2.1.234 between panels, an uncontrolled variable this design cannot separate
from the guidance (§14); and 26 valid runs support counts, not significance. The
decision is this panel's bounded reading, not a product claim.

### The next intervention, in the strict order — and none of it is implemented here

1. **Wording (recommended next).** Two defects the receipts localise precisely:
   **(a)** the PLAN and PROVE plan-verification rows name the rail but not how to choose
   a target when several plan documents exist — TS-02 and TS-08 both ended by asking; a
   sentence stating where the declared-current plan lives and that the rail should be
   run against the best candidate (naming the choice) would convert clarifying questions
   into executions. Derive it from the canonical plan documentation, not from the
   prompts. **(b)** the PRESERVE row is concrete enough to recite as an answer (TS-09
   a2's zero-action run); rewording it toward *run first, then report what the run
   showed* addresses the recall-substitution failure.
2. Skill/entry-point loading — no evidence demands it: loading is observed at 32/32.
3. Deferred discovery/context — no evidence demands it.
4. DX13/MCP surface work — no evidence demands it; the MCP surface stayed disabled and
   identical across both panels.
5. A new tool merely to fix selection — never, and nothing here suggests one.

---

## 13. How to re-check this panel

The cells ran from a detached checkout at the freeze's base commit, with run
directories staged outside every repository ancestor (§4), so receipts could be
committed to the branch while the tree under test stayed at `baseSha`:

```
git worktree add --detach <dir> d14f108544996148f94e2c36e8b4f58954689e1a
node <dir>/benchmarks/tool-selection/run.js aggregate \
  benchmarks/tool-selection/panel-v2-2026-08-18/runs \
  --repetitions 2 --arms claude-code,codex,gemini-cli \
  --freeze benchmarks/tool-selection/panel-v2-2026-08-18/frozen-protocol.json
```

Running it from a checkout at any other commit is refused, which is the gate working.

---

## 14. What this panel is, and is not, entitled to claim

**Entitled to:**

- Per-prompt observations, each backed by a receipt with its transcript digest and its
  fixture fingerprint pair, under one freeze: protocol `e1429f90…`, instrument
  `8411b00e…` (identical to V1's), base `d14f1085…`, profile `guarded`.
- The pairwise table of §8, as counts over 25 + 26 valid runs of one arm under two
  guidance states, with the instrument held byte-identical.
- The statement that the guidance was **observed in context** on every valid run, by
  content digest, through a hook whose liveness is separately witnessed.
- The decision of §12, as this panel's bounded reading.

**Not entitled to:**

- Any success rate, percentage, ranking or statistical-significance claim. 26 runs are
  26 runs.
- Any comparison between agents or products. `comparative` is false; Codex and Gemini
  CLI remain "not installed here, not simulated".
- Attribution of the V1→V2 difference to the guidance **free of the CLI-version
  confound**: V1 ran on Claude Code 2.1.231, V2 on 2.1.234, and this design cannot
  separate the two. The direction and the prompt-local pattern (the exact pre-registered
  attractor the guidance discriminates disappearing; the exact rows the guidance lacks
  staying flat) argue for the guidance as the operative variable; they do not prove it.
- Any claim about restraint. The supplementary cells resolved `unresolved` six out of
  six (§9); `dryRunApprovalCompliance` remains unresolvable by construction.
- Any promotion of a JTBD row, any site or GTM change, any published figure.

The 32 first-attempt receipts of §4 are `invalid-first-attempt-runs/`: valuable as
evidence about the apparatus, worthless as measurement, and in no aggregate above.
