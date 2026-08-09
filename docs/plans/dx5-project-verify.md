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

## Trust boundary

Project Verify executes **trusted checked-in project commands with the
operator's authority**. Child isolation bounds a hang and captures output; it is
**not a filesystem, network or OS sandbox**, and the report says so. Timeouts,
output caps and process-group termination are bounded. A package that floods
stdout must not be able to corrupt the JSON document, and no secret or
environment value reaches the report.

## Determinism

The semantic fingerprint covers check identities and statuses plus the source,
inspection, package, plan and suite evidence. It excludes duration, absolute
paths, PIDs, timestamps and raw log ordering.

## The dirty-worktree rule

Verify does not intentionally edit source. If tracked source changed after the
run, the report says `WORKTREE_DIRTY_AFTER_VERIFY` and names the paths. It
**does not** `git reset`, stash or hide it: a verification command that silently
repairs the thing it is verifying is worse than one that reports the problem.

## Out of scope, deliberately

DX10's requirement→implementation mapping. This command reports what passed,
what failed, what was **not proven**, and which package or plan needs attention.
It does not decide whether a plan was implemented.
