# ExecPlan — DX5 Project Verify

**The question it answers:**

> **Can you prove this project is healthy enough to hand back after a
> coding-agent change?**

Not "is the source coherent" — that is DX1, and it is cheap on purpose. This is
the expensive one: the command that *runs the evidence* and produces a document
a reviewer can act on.

```text
crm app inspect       what is composed?
crm project doctor    what is inconsistent or stale in the source?     cheap
crm package test      does one package satisfy the framework contract?
crm solution check    is this plan still compatible?
crm project verify    can we PROVE it works?                           expensive
```

DX5 is the **PROVE** rail. PROVE stays **partial** after it ships: scenario
proof (DX6) and implementation evidence (DX10) do not exist, and the report must
say so rather than implying completeness.

---

## Two designs rejected

**A wrapper around `npm run verify`.** It would add a JSON envelope to a number
somebody already has. It answers nothing DX1 could not, it hides which authority
failed behind one exit code, and the first project whose script is named
something else breaks it. The value is not "run the tests" — it is *orchestrating
the framework's own authorities and reporting which one refused*.

**A user-supplied shell-command runner.** "Declare your verification steps and
we run them" makes the framework a task runner with a JSON output, and makes the
report meaningless across projects: two reports would share a schema and nothing
else. It also turns an arbitrary string into an executed command, which is a
different security posture from executing a project's own declared scripts.

**Chosen: a framework-owned orchestrator of existing authorities.** Every check
delegates to something that already decides — Project Doctor, App Inspect,
Solution Plan binding, Package Conformance, the project's own declared scripts —
and DX5 owns only the sequencing, the evidence and the refusal shape.

---

## The contract

`projectVerificationContract: 1`, with `project`, `inspectionFingerprint`,
`status`, `checks[]`, `problems[]`, `limitations[]`, `evidence[]`, `fingerprint`.

A check carries `code`, `category`, `status`, `authority`, `required`,
`evidence`. Duration is diagnostic and is **excluded from the semantic
fingerprint** — a report that changes because a machine was busy is not a
comparable document.

```text
exit 0   every required check passed
exit 1   verification evidence failed
exit 2   the project or the verification infrastructure is unreadable
```

## The v1 catalog

| Stage | Authority | Rule |
|---|---|---|
| structural preflight | `crm project doctor --json` | a doctor **failure blocks** verification; warnings are carried into the report |
| application | `crm app inspect --json` | record the inspection fingerprint and any problems |
| solution plans | DX1's applicability rules | only plans the project declares **current** are graded |
| package conformance | `crm package test` | composed local packages only, where source and prerequisites exist. A project-owned core module is never treated as a package |
| project suite | the project's **declared** script | run it only if declared; never guess `npm test` |
| smoke | the project's **declared** script | same rule |
| browser | — | not automated here; reported as `BROWSER_EVIDENCE_NOT_AUTOMATED`. DX6 may own scenario and browser proof |

### Which packages, and what `required` means

The conformance targets are exactly the paths Project Doctor already resolved
into `project.packagesComposed`. DX5 does not re-derive them, does not consult a
list of first-party names, and has no allowlist: a customer-authored package is
selected on the same rule as a framework one, and a composed package whose
source directory is absent is simply not a target.

**Accordo's own default composition is empty by design** —
`packages/domains/generated/index.js` ships as a comment and an empty array, and
`scripts/tour.js` exists because of it. So `accordo project verify` *run against
this repository* reports `packages.conformance: not_applicable` with
`NO_PACKAGES_COMPOSED`, and proves nothing about conformance. To exercise that
stage, run it inside a composed project (`npm run tour -- --keep DIR`, or a
starter install).

`required: true` on a check means **"if this check runs and fails, the run
fails"**. It does not mean the check must run: `not_applicable` — no packages
composed, no `verify` script declared — leaves the overall verdict `passed`.
That is deliberate (DX5 never guesses a command), but it means a green exit code
alone does not say *which* evidence was gathered. `counts` and the semantic
fingerprint do, and they differ between a run that conformance-tested six
packages and one that had none to test.

## Trust boundary

Project Verify executes **trusted checked-in project commands with the
operator's authority**. Child isolation bounds a hang and captures output; it is
**not a filesystem, network or OS sandbox**, and the report says so. Timeouts,
output caps and process-group termination are bounded. A package that floods
stdout must not be able to corrupt the JSON document, and no secret or
environment value reaches the report.

A step settles on the child's **exit**, not on its streams closing. A suite that
leaves a background process behind — a dev server, a watcher, a leaked worker —
has a grandchild holding the inherited stdout pipe open long after the suite
itself returned, so waiting for `close` turned an ordinary passing suite into a
fifteen-minute wait and then a *false* timeout failure. This is the same
correction `child-report.js` records having made in AX1.

## Recursion

A project's declared `verify` script may not re-enter this command. Every child
DX5 spawns carries `ACCORDO_PROJECT_VERIFY_DEPTH`; a run that sees it set
refuses to run declared scripts and reports `RECURSIVE_VERIFY_REFUSED`.

The bound is not cosmetic. DX5 runs **both** `verify` and `smoke`, so an
unguarded self-invocation doubles the process tree at every level — a measured
30 script invocations from one command before an externally imposed depth cap —
and each level holds its own fifteen-minute timer. The recursion is *refused*
rather than depth-limited, because a verification that verifies itself proves
nothing that the outer run was not already proving.

## Determinism

The semantic fingerprint covers **check identities and statuses**, the project's
kind, composed packages and declared scripts, the inspection fingerprint, and
the problem codes. It excludes duration, absolute paths, PIDs, timestamps, raw
log ordering, every `reason` and `evidence` string, and — deliberately — the
doctor's own fingerprint, so that DX5's value moves when a *decision* changes
rather than whenever any source byte does.

Two consequences a reader must not be misled about:

- two runs that both pass over **materially different source** carry the same
  DX5 fingerprint. `inspectionFingerprint` is the field that distinguishes the
  applications; the DX5 fingerprint distinguishes the verdicts.
- a suite that **failed**, one that **timed out**, and one that **could not be
  started** all decide `failed`, and therefore hash alike. The distinction lives
  in the check's `reason`, which is outside the fingerprint by design.

## The dirty-worktree rule

Verify does not intentionally edit source, and it proves that by **sampling the
worktree twice** — once before any delegate runs, once after — and reporting the
difference.

The single after-the-fact sample this started with could not tell a tree the
operator had already edited (the normal state of a coding-agent handover) from a
suite writing into source. It reported both as `WORKTREE_DIRTY_AFTER_VERIFY`, so
the check fired on nearly every real run and taught its reader to skim past the
one case it existed to catch.

- paths that appear during the run → `WORKTREE_DIRTY_AFTER_VERIFY`, named.
- paths dirty **before** the run and unchanged by it → the check passes, with
  `DIRTY_BEFORE_VERIFY` recorded so the reader still knows the evidence was
  gathered over uncommitted source.
- paths dirty before and **clean after** → `WORKTREE_REPAIRED_BY_VERIFY`. A
  delegate discarded the operator's uncommitted work; a tree that got *cleaner*
  during a verification is never a pass.

The sample is `git status --porcelain`, not `git diff --name-only HEAD`, so a
suite that writes a **new** file — a scratch database, a generated module — is
caught rather than invisible. `.gitignore`d build output stays excluded: build
output is not source.

DX5 **does not** `git reset`, stash, clean or checkout anything, and holds no
code that could. A verification command that silently repairs the thing it is
verifying is worse than one that reports the problem.

## Out of scope, deliberately

DX10's requirement→implementation mapping. This command reports what passed,
what failed, what was **not proven**, and which package or plan needs attention.
It does not decide whether a plan was implemented.
