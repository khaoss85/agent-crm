# DX1 — Project Doctor (ExecPlan)

## The question the tool exists to answer

> **What is structurally inconsistent or stale in this project, before I edit it
> or pay for a full verification run?**

An agent arriving at an unfamiliar checkout — or a human returning after a merge
— has one expensive way to find out whether the repository is coherent:
`npm run verify`, which takes about **156 seconds** here. Most of what goes
wrong before you edit anything is not a failing test. It is a composition that
no longer resolves, a Solution Plan written against an application that has
since moved, a Skill whose two mirrors disagree, a documentation link that lost
its file in a rename, a module state file somebody hand-edited, a `.env` that
got committed. Every one of those is provable from source in well under a
second, and none of them needs a test to run.

Five commands, five questions, and the boundaries are the whole design:

```text
crm app inspect       what is composed?
crm project doctor    what is inconsistent or stale in the source?
crm package test      does one package satisfy the framework contract?
crm solution check    is this plan still compatible with the application?
npm run verify        does everything actually work?          (the expensive one)
```

## Naming: why not `crm doctor`

`crm doctor` already exists and means something else: it boots the application,
opens the database and reports runtime counts, providers and modules. It cannot
run on a project that does not boot.

This one reads source, opens nothing, and works precisely when the application
will not start — which is when a diagnostic is worth having. Overloading the
existing name would have made a command that sometimes needs a database and
sometimes does not, so the new one is `crm project doctor`. It also matches the
`project.doctor` / `app.doctor` split the Agent Tool Surface already anticipates.

## Three shapes compared

### Option 1 — a wrapper around `npm run verify`

Rejected. It answers the same question more slowly and adds a name for it. The
value here is *not* running the tests: a check you can afford before every edit
is a different tool from a check you run before a merge. The moment the doctor
starts executing suites it becomes DX5 with a worse name, people stop running it
because it is slow, and the fast pre-edit check is gone.

### Option 2 — heuristics: fuzzy generated-source comparison, lint-like opinions

Rejected, and this is the failure mode worth naming. A diagnostic that invents
its own opinion becomes a second source of truth, and the first time it
disagrees with the runtime, the runtime is right and the tool is noise. DX4 was
merged and then immediately had to be fixed for exactly this — checks that
failed packages for rules no framework component enforced.

Two concrete refusals follow from it:

- **No fuzzy generated-source comparison.** A hand-edited generated service is
  not detected by diffing against a re-render, because the re-render differs for
  a dozen innocent reasons and a check that cries wolf is one people silence.
  Drift is reported only where a *checked-in generator contract* proves it.
- **No anchor parsing in documentation links.** Heading-to-slug is a guess, and
  a wrong guess in a link checker trains readers to skip the whole category.

### Option 3 — a deterministic source-consistency doctor (chosen)

Every check delegates to an authority that already exists, and says which one:

| Check | Authority | What it proves |
|---|---|---|
| `composition.valid`, `composition.problem.*` | `app-inspect` | AX1's own problems, verbatim, each as its own row |
| `packages.source-boundary` | `authoring-rule` | no package imports `packages/core/src` |
| `packages.composed` | `app-inspect` | which discovered packages are actually composed |
| `modules.state` | `module-evolution` | `readModuleState` refuses a hand-edited state file, a fingerprint that disagrees with its own manifest, a revision mismatch, a tampered migration checksum |
| `modules.migration-history` | `module-evolution` | inventory only — what the authority above already verified |
| `plans.*` | `solution-plan` | `bindSolutionPlan` against this project's one AX1 report |
| `skills.mirror-drift`, `skills.mirror-coverage` | `skill-mirror` | declared mirrors that disagree, or exist on one side only |
| `docs.links` | `docs-link` | repository-relative Markdown links that do not resolve |
| `hygiene.tracked-artifacts` | `git` | forbidden paths that are *tracked* |

`AUTHORITIES` is a closed list and `check()` throws on an unknown one, so a
future check cannot be added without naming who refuses it.

## What it must never do

- **Never invent a rule.** If no existing authority refuses it, it is not a
  finding. `modules.migration-history` was written twice for this reason: the
  first version re-derived every migration checksum, which `readModuleState`
  already does — so the row could never fire, and if it ever had, this command
  would have been disagreeing with the runtime that enforces it.
- **Never mutate.** No `--fix` in v1. Every finding carries the existing command
  that would fix it.
- **Never import project source in-process.** Composition health needs the
  checked-in composition loaded, and that is delegated to AX1's isolated child.
  Everything else reads text, JSON and `git ls-files`.
- **Never claim what it cannot see.** No database is opened, no network call is
  made, no file content is read for secrets.
- **Never require framework-only files from a customer project.** Everything
  absent is `not_applicable` with a reason.

## Trust posture, stated exactly

```text
read-only  ·  isolated where it must execute  ·  NOT a sandbox
```

`crm project doctor` does not intentionally mutate source or any database. The
one place it causes code to run is `crm app inspect`, which imports the
project's checked-in composition in a child process, in its own process group,
under a timeout and byte bounds, with the report on file descriptor 3. That
child holds this operator's authority: it is isolation against accidents —
a package that logs during import, mutates a global or never returns — and not a
filesystem, network or OS sandbox.

## `projectDoctorContract: 1`

```jsonc
{
  "projectDoctorContract": 1,
  "command": "project:doctor",
  "ok": true,
  "status": "passed" | "warning" | "failed",
  "project": { "kind", "composition", "packagesDiscovered", "solutionPlansDiscovered", "documentsScanned" },
  "inspectionFingerprint": "…",     // which application this was computed against
  "categories": [...],
  "counts": { "passed", "warning", "failed", "not_applicable" },
  "checks":  [{ "id", "category", "status", "authority", "subject", "evidence", "reason", "remediation" }],
  "problems": [{ "code", "subject", "authority", "evidence", "remediation" }],
  "limitations": [{ "code", "message" }],
  "evidence": { ... },
  "fingerprint": "…"
}
```

`project.composition` has **three** states, not two. An earlier draft said
`readable` whenever AX1 answered at all — which it does even for a composition
file that throws on import, because reporting that failure *is* AX1 working. The
field then said "readable" about a project that could not load, which is the
exact misreading this command exists to prevent. It is now `valid`, `invalid` or
`unreadable`.

**Exit codes.** `0` no failures · `1` inconsistencies · `2` not a readable
project. A **warning never fails the run**: a stale Solution Plan and a one-sided
Skill mirror are information owned by somebody else, and a doctor that failed the
build for them is a doctor people stop running.

Nothing in the document carries an absolute path, a stack frame, a source body,
a secret or a timestamp.

## Discovery is by convention, and says so

Packages: a directory under `packages/` or `examples/custom-packages/` whose
`src/index.js` calls `definePackage` — matched as text, because reading a
package must never mean importing it. That discriminator matters: an earlier
draft used "has a `src/index.js`", which swept in `packages/app`, `packages/sdk`,
`packages/mcp`, `packages/providers` and `packages/workflows` — kernel code,
which imports `core/src` because it *is* the core — and reported **eight
boundary violations in a repository that has none**. A diagnostic whose first
output is a false positive is a diagnostic people turn off.

Plans: `*.plan.json` under `examples/solution-plans/` or `docs/solution-plans/`.
Skills: `.claude/skills/` and `.agents/skills/`, and only when **both** exist —
a project with one harness owes nothing to another.
Documentation: `docs/`, the skill roots, and the canonical root-level Markdown.

All of it is recorded as `DISCOVERY_IS_BY_CONVENTION`: something kept elsewhere
is not seen, and its absence from this report is not a statement that it is fine.

## One AX1 load

`crm solution check` loads its own AX1 report per invocation, which is right for
one plan and would be the wrong shape here — this repository ships three plans,
and a customer project may ship more. The doctor loads the composition **once**
and reuses it for the composition checks, every plan binding and the
`inspectionFingerprint`. A test asserts the loader is called exactly once.

## Performance, measured rather than asserted

| Command | This repository |
|---|---|
| `crm app inspect --json` (the load the doctor reuses) | ~122 ms |
| **`crm project doctor --json`** — framework repository | **~155 ms** |
| **`crm project doctor --json`** — clean application | **~133 ms** |
| **`crm project doctor --json`** — application with the official packages | **~132 ms** |
| `crm package test packages/service --json` (one package) | ~1,710 ms |
| `npm run verify` | ~156,000 ms |

The soft target follows from the measurements rather than from an invented SLA:
**under one second on a project of this size, and within roughly 1.5× the single
`app inspect` it already performs.** Today it is about 1.3×, and the ~1,000×
gap to `verify` is the whole reason the command exists. If a future check cannot
be added inside that budget, it belongs in DX5, not here.

## What it deliberately does not prove

`DOMAIN_CORRECTNESS_NOT_PROVEN` · `NOT_A_SUBSTITUTE_FOR_VERIFY` ·
`DATABASE_NOT_INSPECTED` · `PROVIDER_HEALTH_UNKNOWN` · `SECRETS_NOT_INSPECTED` ·
`PRODUCTION_READINESS_NOT_ASSESSED` · `PACKAGE_CONFORMANCE_NOT_RUN` ·
`DISCOVERY_IS_BY_CONVENTION` · `GENERATED_SOURCE_DRIFT_LIMITED` · `NO_MUTATION`

Each is in the report itself, not only here.

## Context economy

`problems` is the compact view — every failure and nothing else, each entry
under a kilobyte, each carrying its authority and its remediation. That is the
shape a future **DX9 Context Pack** would include so an agent can carry "what is
wrong with this project" without carrying the project. Context Pack is not built
here; the output is simply kept small enough to be worth including.

## Out of scope for v1

No `--fix`, no auto-sync of Skill mirrors (DX2 owns that), no web link checking,
no anchor validation, no database or provider inspection, no package
conformance run, no MCP tool, no Context Pack.
