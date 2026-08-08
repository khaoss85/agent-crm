# DX4 — Package Conformance Kit (ExecPlan)

## The question the tool exists to answer

> **Does this package satisfy the framework's generic package contract and
> integration invariants?**

One question, one answer, and a boundary stated in the same breath: it proves
**nothing** about whether the domain logic is right.

Three commands, three different questions, no semantic overlap:

```text
crm package validate   is this package declaration structurally valid?
crm package inspect    what does this package declare, own, offer and need?
crm package test       does it hold up when a real application composes it?
```

`validate` and `inspect` read. `test` **composes and boots**. That is the whole
distinction, and it is why `test` could not be a flag on either of them.

## Three shapes compared

### Option 1 — hard-code the official packages' tests

Rejected. It answers "do contracts, delivery and service still work", which the
existing suites already answer, and it answers nothing at all for the customer
whose package this is meant to serve. A conformance harness that knows the names
of the packages it tests is a regression suite wearing a different hat.

The measurement that settles it: today `assertPackageConforms` is called exactly
three times — for `contracts`, `delivery` and `partner-scorecard`. The newest
package, `service`, has **no conformance coverage at all**. Hard-coding is how
that happened, and doing more of it produces more of it.

### Option 2 — a custom conformance-hook contract packages implement

Treated cautiously and **not built in v1**. It is the shape that looks right —
each package declares its own checks — and it is the shape that quietly turns a
conformance kit into a second test framework. A hook contract needs its own
versioning, its own sandbox story and its own answer to "what if the hook
lies", and none of the four packages that exist today has asked for one.

The rule applied: a new generic seam is added when **two real packages need the
same domain-neutral bounded behaviour**. Zero do. Revisit when one does.

### Option 3 — a framework-owned generic harness (chosen)

The framework already owns every rule worth checking: `validatePackageDefinition`,
`resolvePackageComposition`, `PackageRegistry`, the module factory, `readModuleState`
and AX1. DX4 does not re-derive a single one of them. It **arranges** them: it
builds a project, composes the package into it, boots it twice and asks the
existing authorities what they saw.

The smallest contract that works for all four learning packages —
`partner-scorecard`, `contracts`, `delivery`, `service` — is: *read what the
package declares, compose exactly what that declaration implies, and report what
the framework's own machinery says*. No domain semantics enter, and none is
forced into a universal DSL.

## What it must never do

- **Never special-case a package by name.** No `if (name === 'service')`
  anywhere in the harness. The official matrix is a *test*, not a code path.
- **Never fake a pass.** A check that cannot run is `skipped` or
  `not_applicable` with a reason code, never `passed`.
- **Never demote a failure to a limitation** to make an official package green.
- **Never claim to be a sandbox.** It imports and boots trusted source.
- **Never write to the caller's project**, and never open their database.

## The trust boundary, stated exactly

```text
child-process isolation  ≠  filesystem / network / OS sandbox
```

`crm package test` imports the package *and boots an application carrying it*.
Both happen in a child process, in its own process group, against a throwaway
copy of the project, under a timeout and byte bounds, with the report on file
descriptor 3 so a package that prints cannot corrupt the document. That protects
the operator's terminal, their project and their database from an accident. It
does not protect anything from a package that means harm, and the report says
so under `PACKAGE_SOURCE_TRUSTED` and `PROCESS_ISOLATION_BOUNDED`.

## What it composes, and why that is still generic

A package rarely boots alone, and the reasons are mechanical:

| Needed | Discovered from | Why |
|---|---|---|
| declared providers | `requires[]` | the capability edge the contract exists to express |
| **implied prerequisites** | another package's `resources[]` containing a record this package's action targets | the contract **cannot** express record-level coupling |
| project records | any `*.module.json` in the project declaring a needed record, closed over `targetModule` references | some records belong to the project, not to any package |

All three are closed **transitively**, and all three read only `requires`,
`resources`, `actions[].module`, manifest `name` and `fields[].targetModule`.
Nothing knows what a record means.

The middle row is the finding. `partner-scorecard` acts on
`delivery-partner-engagement`; `requires` has no way to say so; without
`delivery` composed the application refuses to start. DX4 composes the owner
anyway and reports `UNDECLARED_RECORD_COUPLING` — because failing a package for
violating a rule the framework never made would be dishonest in the other
direction.

## Prerequisite de-duplication, done first

Three pieces of shipped logic existed twice or were unreachable. DX4 would have
made each of them worse, so each moved before anything new was written:

| Was | Now |
|---|---|
| `PRIVATE_IMPORT_RE` + the source walk, copy-pasted byte-identical in `packages/cli/src/package-commands.js` and `tests/helpers/package-conformance.js` | `packages/cli/src/package-sources.js`, imported by all three callers |
| `safeMessage`/`repoRelative`, module-private inside `app-inspect.js` | `packages/cli/src/safe-text.js` |
| the bounded fd-3 child reader, inline in `app-inspect-command.js` | `packages/cli/src/child-report.js`, used by AX1 and DX4 |

A defect in the private-import rule has already had to be fixed in two places
once (ADR-018 addendum 4). Copy three was not acceptable.

## Guarantees to prove

1. **Generic** — no package name appears in harness code; the four learning packages run through one code path.
2. **Honest** — every non-passing check carries a reason; no failure is reported as a limitation.
3. **Deterministic** — byte-identical JSON across runs, processes, working directories and a path containing spaces.
4. **Leak-free** — no absolute path, scratch location, stack frame, SQL, source or secret in the report.
5. **Safe** — the caller's project gains no file; the scratch is removed on success, failure and timeout.
6. **Bounded** — a package that hangs, floods a stream or calls `process.exit` produces a stable outcome and never hangs the parent.
7. **Stable exit codes** — `0` conforms, `1` conformance failures, `2` package or project unreadable.
8. **Additive** — `package validate`, `package inspect`, `app inspect`, `solution validate|check` and every M0–M15 test behave exactly as before.

## Deliberately not built

DX3 package scaffold · DX1 project doctor · DX2 skill sync · legacy-domain
extraction · package HTTP-route contribution · a conformance-hook contract ·
action execution · data-bearing upgrade coverage · tracked-file hygiene scanning
(no such check exists anywhere in the repository today; building one is separate
work, not a DX4 consolidation).

## Is DX3 (Package Scaffold) now justified?

**Yes — and DX4 defined its output, which is the reason it was deferred.**

DX3 was deferred "until Delivery and Service settle the file shape". They have,
and DX4 turned that shape from a convention into a checked one: a scaffold is
now justified precisely because there is a command that can tell you whether
what it produced is right. A generator whose output nothing can grade is a
liability; a generator whose output passes `crm package test` on the first run is
a real head start.

The minimum skeleton, taken from what DX4 actually requires rather than from what
the existing packages happen to contain:

```text
packages/<name>/
  README.md                     what it owns, needs, and deliberately does not do
  src/index.js                  create<Name>Package() → definePackage({ … })
    packageContract: 1          the constant, not a literal
    name, version, label        canonical name, positive integer, non-empty label
    description                 ≤ 400 characters
    resources: []               every record this package owns
    requires: []                every capability edge, or an explicit empty array
    capabilities: []            every capability offered, each with create()
    actions: []                 each targeting a record in resources
    policies: []                each versioned, each with declared config
    metadata()                  function-free, deterministic, bounded
  modules/<record>.module.json  one per entry in resources
  src/<name>-actions.js         actions, importing only packages/core/index.js
```

Plus two files DX4 does not check but every reviewed package has needed:
a `.claude/skills/build-<name>/SKILL.md` entry, and a package-specific test
suite — because DX4's first limitation is `DOMAIN_CORRECTNESS_NOT_PROVEN`.

The acceptance criterion writes itself, and it is why this is a proposal rather
than a build: **`crm package test` on freshly scaffolded output must exit 0 with
zero failures and no skip other than the honestly-empty ones**
(`NO_DEPENDENCIES_DECLARED`, `NO_CAPABILITIES_OFFERED`, `NO_POLICIES_DECLARED`).
A scaffold that cannot clear its own conformance bar has not saved anybody time.

**Not implemented here.** This section is the specification DX3 would start from.
