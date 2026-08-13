# Tool-selection panel — 2026-08-13

Date: 2026-08-13
Protocol: `docs/benchmarks/AGENT_TOOL_SELECTION_PROTOCOL.md`
Pre-registration: `docs/benchmarks/PANEL_PREREGISTRATION_2026-08-13.json`
Freeze: `benchmarks/tool-selection/frozen-protocol.json`
Receipts: `docs/benchmarks/panel-2026-08-13/runs/`

**Status: run, and bounded.** One arm produced valid runs; two produced receipts and no
measurement. `comparative` is **false** and there is no success rate in this document,
because a pilot with one arm is a pilot and not a comparison.

---

## 1. The freeze, computed before the first cell and verified rather than trusted

| Field | Value |
|---|---|
| protocol fingerprint | `b20e70877202c64cac29edb9ea6bd6faae7bb7f3318abbfc0fd34381c782e556` |
| instrument fingerprint | `8411b00e07fa45a2c82e3ee222be3d6c32fc06d5f834f5df4d5a4b1cf017a5d8` |
| base commit | `8c6766eca591dc372c657a92f86f02989c8ce291` |
| prompt set | `TS-f560c257a824` (label `TS-v1`) |
| panel permission profile | `guarded` (`manual`) |
| frozen at | 2026-08-13T23:13:55.961Z |

Per-decision component digests, the eleven the instrument fingerprint covers:

| Decision | Digest (16) |
|---|---|
| transcript-parser | `ef969f3628f7dec7` |
| outcome-classifier | `ef969f3628f7dec7` |
| permission-event-interpretation | `ef969f3628f7dec7` |
| claude-code-adapter | `ef969f3628f7dec7` |
| mutation-classifier | `8cd5f29d493a9939` |
| leak-scan | `f68fa1796388400b` |
| scoring | `790abfbcbb5f3ab3` |
| scoreability-derivation | `790abfbcbb5f3ab3` |
| run-contract | `162798fc5bbb9de0` |
| fixture-builder | `5470b5b23ab3f62f` |
| run-orchestration | `5aeb8c5db3be763e` |

The tree under test, bound by what each fixture actually hashes to:

| Fixture | Fingerprint (16) | Files | Bytes |
|---|---|---|---|
| `clean-valid` | `fcd1e7758954af1d` | 616 | 8 050 325 |
| `structural-drift` | `c141003b59000f89` | 616 | 8 050 461 |
| `stale-plan` | `862145de7659a30c` | 616 | 8 050 325 |
| `missing-custom-package` | `de0f587bc7fb2d99` | 616 | 8 050 229 |
| `non-conforming-package` | `d24c5140c121b1ae` | 618 | 8 052 224 |
| `valid-scenarios` | `fcd1e7758954af1d` | 616 | 8 050 325 |
| `implementation-evidence-gap` | `fcd1e7758954af1d` | 616 | 8 050 325 |

Three fixtures share a fingerprint because two of them carry no overlay — the repository
already exhibits the state — and that is what a fingerprint means. It is recorded rather
than disguised.

### The refusal was tested before it was trusted

Eleven ways of running a cell against a protocol that is not this one were tried. Every
one refused, and the first ten refused **before the run directory existed**:

| Attempt | Result |
|---|---|
| no freeze document at all | `PROTOCOL_UNFROZEN`, exit 2 |
| an unknown key added to the freeze | `PROTOCOL_UNFROZEN`, naming the key |
| the `fixtures` map deleted | `PROTOCOL_UNFROZEN`, naming the missing key |
| one fixture fingerprint altered | `PROTOCOL_STALE` |
| the panel profile swapped | `PROTOCOL_STALE` |
| the base commit altered | `PROTOCOL_STALE`, naming both commits |
| the protocol fingerprint altered | `PROTOCOL_STALE` |
| the scoreability matrix altered | `PROTOCOL_STALE` |
| a cell asked for the other profile without `--off-panel` | `PROTOCOL_STALE`, naming both profiles |
| a comment appended to `score.js` | `PROTOCOL_STALE`, **attributed**: *"Components that moved: scoring, scoreability-derivation"* |
| a dirty tracked file | a **receipt**, `NOT_RUN_TREE_DIRTY`, `scores: null` |

No run directory was created by any of the first ten. The eleventh is a receipt by design:
a planned cell always leaves a document.

---

## 2. Two instrument defects found while freezing, fixed before the first cell

Both are the same shape — a guarantee written where nothing could check it — and both are
in `8c6766e`, so they are inside the frozen instrument rather than applied to it later.

**`run.js freeze` could never run.** The verb read an `options` that is defined in neither
its own branch nor an enclosing scope, so it threw `options is not defined` on every
invocation it has ever had. The protocol names it as *the only supported way to produce a
freeze document*, and the suite reached `computeFreeze()` directly — so the gate that
refuses to run a cell without a freeze sat behind a command that could not produce one.

**`instructionFiles: 'declared'` reported the vendor's documented load order in the field a
reader takes for an observation.** It is now the hook or nothing. The adapter declares an
`InstructionsLoaded` hook and reads back what the session actually loaded, per file, with a
content digest. The empty case is the part that needed designing: an empty log means either
*nothing loaded* or *the hook never ran*, so a `SessionStart` hook writes a liveness marker
and decides between them — present, and an empty log is an **observation**; absent, and the
field is `unresolved`. It is never `declared` again.

The apparatus lives in the scratch config directory rather than in the fixture, so the tree
under test stays byte-identical to what the freeze named. That is why `--setting-sources` is
now `project,user`: `user` resolves under `CLAUDE_CONFIG_DIR`, which this harness creates
empty for every cell, so the source admits this harness's own hooks and nothing of the
operator's. Neither hook writes to stdout, because a `SessionStart` hook's stdout is added
to the session's context and an apparatus that echoed anything would be feeding its own
subject; a probe recorded `stdout: ""` on the hook_response event.

---

## 3. The scoreability matrix, and the panel shape derived from it

`deriveScoreabilityMatrix()` over the two declared profiles:

| Metric | `guarded` (panel) | `permissive` |
|---|---|---|
| `correctRail` | scoreable | scoreable |
| `correctCommandFamily` | scoreable | scoreable |
| `firstRelevantAction` | scoreable | scoreable |
| `discoveryBeforeArchitectureInvention` | scoreable | scoreable |
| `noPrematureMutation` | **suspended** | **scoreable** |
| `dryRunApprovalCompliance` | **suspended** | **partial** |
| `irrelevantCommandsUsed` | counts_only | counts_only |
| `recoveryFromWrongFirstChoice` | scoreable | scoreable |
| `truthfulFinalLimitation` | operator_graded | operator_graded |
| `toolContextEconomy` | counts_only | counts_only |

The supplementary cells are **derived in three steps**, each reading the freeze rather than
anybody's judgement, and the derivation is recorded in the pre-registration document:

**(a) Which metrics cannot fail under the panel profile.** Two: `noPrematureMutation` and
`dryRunApprovalCompliance`, both `suspended` under `guarded` because the harness denies
every shell action and the fixture therefore cannot move.

**(b) Of those, which the alternative profile makes genuinely falsifiable.** One:
`noPrematureMutation`, which is `scoreable` under `permissive`. `dryRunApprovalCompliance`
is `partial` under `permissive` **too** — one half of it is unobservable under *every*
profile this instrument has, because no profile emits a granted decision — so a cell bought
under the alternative buys nothing. It is recorded **unresolvable-by-construction**:

> the plan half is observable; the approval half is not, because no profile emits a granted
> decision

Approval coverage cannot be bought with machine time, and no cell was spent pretending
otherwise.

**(c) Which prompts put the surviving metric under test.** Read from each prompt's own
pre-registered `mutationExpected`: `none` is the protocol's statement that the prompt makes
no claim about mutation, and the other two values are exactly the ones the restraint metrics
branch on. Three prompts qualify — **TS-04** and **TS-12** (`dry-run-or-approval`) and
**TS-10** (`forbidden`).

That is **6 supplementary cells**, off-panel by construction: the aggregate excludes them as
`profileMismatch`, and the exclusion is the point rather than a surprise. Nine prompts get
no supplementary cell, which is the derivation refusing to add by symmetry.

---

## 4. The pre-registered panel

| | Cells |
|---|---|
| primary, `claude-code`, `guarded` | 26 (13 prompts × 2 repetitions) |
| primary, `codex`, `guarded` | 26 |
| primary, `gemini-cli`, `guarded` | 26 |
| **planned panel (the denominator)** | **78** |
| supplementary, `claude-code`, `permissive`, off-panel | 6 |

Every cell was registered before any of them ran, with its expected first family, allowed
alternatives, mutation expectation, approval expectation, fixture, fixture fingerprint,
permission profile and per-metric scoreable status. The pre-registration was committed in
`0ad3258`; the first cell ran afterwards. **No expectation was edited after a run.**

---

## 5. What was observed

*(filled in below from the receipts)*
