# ExecPlan — AX1: Deterministic application inspection

**Status: implemented, this PR.** A cross-cutting **platform** capability, not a
domain milestone: it does not renumber or delay the Delivery (M14b) or Marketing
(MK) tracks. Design context: `docs/strategy/OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md`
(AX0), `docs/strategy/EXECUTION_ROADMAP.md`. Contracts it reads: ADR-018 and its
addenda (the package contract), ADR-019 and addendum 1 (module evolution and
adoption), ADR-015 (declared-definition fingerprints).

## The job

A coding agent that is asked for a business outcome currently has to assemble
the application from five surfaces by hand: `crm package inspect` per package,
`GET /api/schema` from a running server, the checked-in composition file, each
package README, and `docs/PROJECT_STATUS.md` in prose. That is slow, and worse,
it is easy to get wrong in a direction that invents a capability.

AX1 replaces the assembly with one deterministic document:

```bash
npm run crm -- app inspect --json
```

It answers exactly eight questions: which packages are installed; which
package and capability versions resolve; which resources and actions exist;
which policies and providers are registered; which module revisions exist;
which Admin extensions exist; which dependencies are missing or incompatible;
and which discovery surfaces are still unavailable.

## What it is not

It does not choose an architecture, produce a SolutionPlan (that is AX2),
modify code, install a package, start a server, deploy, read a secret, execute
a business action, or aggregate JTBD/Quality-Gate evidence. AX0's roadmap text
implied AX1 would carry "the current Quality-Gate and JTBD status"; it does
not, and this PR corrects that claim rather than pretending otherwise.

## Three architectures compared

**1. Parse the Markdown and the source files ad hoc.** Cheapest to write and
wrong in the way that matters: `PROJECT_STATUS.md` and the JTBD matrix are
prose maintained by people, so parsing them produces *structured* claims with
*unstructured* reliability — and an agent trusts structure. It would also drift
the instant a heading changed. **Rejected**, and the report says explicitly that
those documents are referenced by path and never parsed.

**2. Boot the real application against its configured project database.**
Accurate about the running system, and unacceptable for a read-only discovery
command: booting runs migrations, persists definition fingerprints and writes to
whatever `CRM_DB_PATH` points at. An inspector that mutates the thing it
inspects is not an inspector. **Rejected.**

**3. Resolve the checked-in composition through a bounded read-only inspector
(chosen).** Read the same checked-in composition the application boots from —
`packages/domains/generated/index.js`, the module registry, the intelligence /
commercial / signature / pipeline composition files — validate it with **the
same validators the application uses**, and answer from that. Where a runtime
handle is genuinely required, use an isolated in-memory database that the
project never sees. The configured application database is never opened.

**What option 3 explicitly is not:** a second application boot path with its own
semantics. Every rule AX1 reports on is the rule the kernel already enforces; the
inspector adds no judgement of its own.

## The one kernel change

`PackageRegistry` throws on the **first** composition problem — a duplicate
name, a resource or capability collision, a missing dependency, a cycle. That is
correct for boot (fail closed, fast, one clear reason) and useless for
inspection, which must report *every* problem deterministically.

Rather than reimplement the rules in the inspector — two sources of truth for
what a valid composition is — the resolution moves into one pure function that
**collects** problems, and `PackageRegistry` calls it and throws on the first.
Boot behaviour is unchanged, and the inspector and the kernel can never disagree
about what is wrong, because they run the same code.

## The contract

`applicationInspectionContract: 1`, versioned like every other published
contract in this repository. Deterministic ordering everywhere; JSON-safe and
function-free; no secret, environment value, token, absolute path, timestamp,
random value, source body, migration SQL, database record or PII. Two runs over
the same checked-in state produce byte-identical output, and that is asserted,
not asserted-in-prose.

## Version taxonomy, kept separate

Five different things are called a version in this repository, and collapsing
them is how an agent installs the wrong thing:

| | What it versions |
|---|---|
| package version | the package's own release identity |
| package-contract version | the seam the kernel enforces (`packageContract: 1`) |
| capability version | one named cross-package interface |
| module revision | one record's schema generation (ADR-019) |
| policy / provider version | one immutable declared definition (ADR-015) |

The report carries all five under distinct keys.

## Trust boundary, stated rather than implied

Reading a code-first package definition means importing it, so the package's
module body runs with the inspector's authority. This is the same boundary
`crm package validate` already documents and the same one the checked-in
composition file has: repository source is trusted. AX1 therefore:

- runs the load in an **isolated subprocess**, so a package that mutates global
  state cannot pollute the reporting process;
- turns a throwing, hanging or malformed package into a deterministic entry in
  `problems[]` rather than a stack trace;
- downloads nothing and requires no network;
- **does not claim to sandbox anything**, and says so in `limitations[]`.

## Exit codes

```text
0   composition valid
1   composition has problems — the complete report is still printed
2   the project could not be loaded at all (fatal, diagnostics on stderr)
```

`problems[]` is always emitted when the project loads at all: a report that
crashes before describing what is wrong is the failure mode AX1 exists to
remove.

## Guarantees to prove

1. **Deterministic** — two runs, and two processes, produce byte-identical JSON.
2. **Read-only** — no file written, no configured database opened, no listener,
   no outbound connection; asserted by watching the project tree and the
   database path across a run.
3. **Complete under failure** — a missing capability, a wrong version, a
   duplicate package, a duplicate capability provider, a direct cycle, a
   transitive cycle, a resource collision and a malformed package each produce a
   useful report, not an exception.
4. **Safe** — no function, no secret-shaped config value, no absolute path, no
   SQL, no stack trace and no prototype pollution reaches the output, under
   hostile package metadata.
5. **Honest** — every gap is in `limitations[]` by name, and no Markdown
   document is parsed into structured truth.
6. **Non-invasive** — `package validate|inspect`, `/api/schema` and application
   boot are byte-for-byte unchanged, and every M0–M14a test still passes.
7. **Isolated** — two projects inspected in sequence share no state, and the
   inspector holds no hidden cache.
8. **Useful on the canonical goal** — for the Lead→Won acquisition objective it
   names the capabilities that exist and reports the missing ones as absent,
   without inventing them.

## Explicitly out of scope

The AX2 SolutionPlan runtime, any Marketing or Analytics runtime, Cloud,
package installation, auto-fix, remote inspection, provider login or health,
database or runtime inspection (what a particular database has applied),
machine-readable JTBD/Quality evidence, the generic Admin action-availability
fix, and M14b.

## Definition of done

The contract, the inspector, the CLI, the fixture matrix, the canonical
Lead→Won proof, the backward-compatibility assertions, the updated Skills and
docs, `npm run verify` and `npm run smoke` from a clean clone, the starter, and
green CI. Then per `docs/QUALITY_GATES.md` §5: the adversarial review, then a
human merge. **The AX1 PR is left open.**
