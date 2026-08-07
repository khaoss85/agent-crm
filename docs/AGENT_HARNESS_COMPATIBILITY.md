# Agent harness compatibility

Agent CRM is not built for one coding agent. AX1 (`app inspect`) and AX2
(`solution inspect|validate|check`) are the two surfaces an agent needs, and both
are plain commands over plain JSON. This page states what a harness must provide
to use them, and — more usefully — what it does **not** need to.

## What a harness needs

| Requirement | Why |
|---|---|
| run a shell command and read its stdout | both surfaces are CLI commands |
| read the process exit code | `0` / `1` / `2` are the contract, not the prose |
| parse JSON | `--json` on either command |
| read and write files in the repository | a plan is a checked-in file |

That is the whole list. Node 22+ and a checkout; nothing else.

## What a harness does not need

- **No MCP server.** The repository ships one (`docs/MCP.md`), and neither AX1
  nor AX2 requires it. A harness with no MCP support loses nothing here.
- **No network.** Neither command fetches anything. No official package needs
  the network.
- **No credentials.** Neither command reads a secret, an environment value or a
  provider configuration, and neither reports one.
- **No database.** Both are source-only. `app inspect` never opens the
  configured database; `solution` never opens one at all.
- **No long-lived process.** Both commands start, answer and exit.
- **No agent-specific format.** The reports are JSON with a declared contract
  version, not a prompt.

## Exit codes, identically in both

```text
0   valid
1   problems — the complete report or problem list is still printed
2   could not be read at all (diagnostics on stderr)
```

A harness that branches only on "zero or non-zero" still behaves correctly; one
that distinguishes `1` from `2` can tell "your project is wrong" from "I could
not read your project", which is the difference between fixing a composition and
fixing a path.

## Where the output goes

`app inspect` runs the project's composition in an isolated child process, so a
package that prints during import cannot corrupt the report: the report travels
on **file descriptor 3**, and the child's stdout and stderr are forwarded to
*your* stderr under a label. A harness that captures stdout gets the report and
nothing else; a harness that captures stderr sees the project's own noise,
clearly marked as such.

`solution check` runs `app inspect` internally and captures it, so its stdout is
the plan and only the plan.

## Determinism, which matters more than it sounds

Two runs over the same checked-in state produce byte-identical output from both
commands, and the suite asserts that rather than promising it. No timestamp, no
random value, no absolute path and no locale-dependent ordering appears in
either report. A harness can therefore cache a report, diff two of them, or
commit one, and a difference always means the project changed.

## Skills and their mirrors

Agent instructions live in `.claude/skills/` for Claude Code and are mirrored
verbatim in `.agents/skills/` for harnesses that read that convention. The
mirrors are byte-identical and the check script enforces it, so no harness reads
a stale copy.

## The trust boundary, stated once

`app inspect` imports the project's checked-in composition, and importing a
code-first definition runs its module body. That is the framework's normal
boundary — **repository source is trusted** — and the isolated child process
exists to keep a hung or noisy import from damaging the invoking process, not to
contain hostile code. It is **isolation, not a sandbox**, and the report says so
(`PACKAGE_SOURCE_TRUSTED`, `PROCESS_ISOLATION_BOUNDED`).

AX2 imports nothing: a plan is data, and the validator never evaluates it.

## What is deliberately not offered

No agent runtime, no orchestrator, no plan executor, no code generation from a
plan, no remote install, no deploy, and no harness-specific integration. An
agent that wants to act on a plan does so with its own tools, under its own
approvals — and the plan says which of its steps need a human.

## Evidence

`docs/APPLICATION_INSPECTION.md`, `docs/SOLUTION_PLAN.md`,
`tests/app-inspect.test.js`, `tests/solution-plan.test.js`, `scripts/check.js`.
