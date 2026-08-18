# First-attempt claude-code receipts — INVALID, and why

**Every receipt in this directory is invalid as a panel measurement and is excluded
from the V2 aggregate. The reason is an operator harness fault, not agent behaviour.**

The operator placed each cell's run directory inside the branch worktree
(`.../guide-v2/benchmarks/tool-selection/panel-v2-2026-08-18/runs/<cell>`), so the
fixture working directory had the worktree's own root `CLAUDE.md` as a filesystem
ancestor. Claude Code loads project memory from the working directory's ancestors, and
the `InstructionsLoaded` apparatus observed exactly that on every one of these 32
sessions: **two** instruction files loaded at session start —

- `outside-fixture:CLAUDE.md` (`/home/user/agent-crm-worktrees/guide-v2/CLAUDE.md`), and
- the fixture's own `CLAUDE.md`,

both with content digest `94d526ac09e4546c52849be382daa9612d53104e2a6ae5cc92be0322e2c4e6b9`
(the V2 guidance-bearing file at `d14f108`). The leaked file carries the same bytes as
the fixture's own, so no answer and no different guidance entered the context — but the
session surface was not the declared one: V1's 31 valid runs each loaded **exactly one**
instruction file, and a doubled guidance load is a dose confound a clean guidance
experiment cannot carry.

Per the protocol's re-run rule, a cell is re-run only for instrument failure, keeping
the first receipt marked invalid with its reason. This is that case: the harness handed
the agent a surface the protocol did not declare. The 52 `NOT_RUN_NO_ADAPTER` receipts
carry no session and are unaffected; they remain in `runs/`.

The re-run cells stage their run directories outside every repository ancestor
(scratch, `/tmp`), which reproduces the V1 mechanics; their receipts record exactly one
loaded instruction file, which is the check that the fault is gone.

These directories remain in the record because a planned cell always leaves a document,
and because they are themselves evidence that the `InstructionsLoaded` apparatus detects
outside-fixture contamination in the field.
