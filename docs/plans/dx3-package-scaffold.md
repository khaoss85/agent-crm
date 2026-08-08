# DX3 — Package Scaffold (ExecPlan)

## The question the tool exists to answer

> **Give me a new domain package that already conforms, and nothing else.**

DX4 made conformance mechanical: `crm package test` says yes or no, generically,
with reasons. DX3 is the other half of the same job. Once a machine can tell you
whether a package conforms, the expensive step is no longer *checking* — it is
*starting*, because today starting means opening `packages/service`, copying
2,000 lines of somebody else's domain and deleting the parts that do not apply.

So the scaffold's job is narrow and its output is deliberately boring: an
identity, a contract version, five empty declarations and a README, in a package
that passes `validate`, `inspect` and `test` with no manual edit.

Four commands, four different questions, no semantic overlap:

```text
crm package scaffold   give me an empty package that already conforms
crm package validate   is this declaration structurally valid?
crm package inspect    what does this package declare, own, offer and need?
crm package test       does it hold up when a real application composes it?
```

`scaffold` takes a **name**; the other three take a **directory**. It is the
only one of the four that can write, and it writes only with `--apply`.

## Three shapes compared

### Option 1 — a rich domain template

Rejected for v1. The tempting version generates a record, an action, a policy, a
capability, a module manifest, a test and an Admin section, so the author gets
something that *does* something on the first run.

What settles it is who deletes it. A generated `partner`, `score` or `status`
field is a claim about a business nobody has described yet, and every one of
them must first be **noticed** and then removed. An agent is worse at this than
a human: it reads generated code as a decision already taken, and builds on top
of a domain model that was a placeholder. `docs/PACKAGE_AUTHORING.md` already
says a package that overstates what it does is a defect of the same kind as a
missing check — a scaffold that overstates by construction is that defect,
shipped by default.

The evidence from this repository: `partner-scorecard`, the one package written
specifically as a teaching example, is 1 resource / 1 action / 1 policy and
still had to be *designed*. The bytes were never the hard part.

### Option 2 — an interactive wizard

Rejected for v1 and probably permanently. A prompt-driven generator cannot be
driven by an agent, cannot be diffed, cannot be replayed in CI, and produces a
different package depending on how somebody answered on a Tuesday. Everything
this repository has built — Solution Plans (AX2), application inspection (AX1),
the conformance kit (DX4) — is deterministic, file-shaped and machine-readable.
A wizard is the opposite of all four.

If the guidance is worth having, it belongs in the README the scaffold writes and
in the `build-custom-domain-package` Skill, where an agent can read it.

### Option 3 — a minimal deterministic conforming skeleton (chosen)

Two files:

```text
packages/<name>/src/index.js    definePackage with five empty declarations
packages/<name>/README.md       what it owns, what it needs, what it does not
```

Every declaration is **present and empty**: present so an author edits a list
they can already see, empty so the framework never puts words in their mouth.
The generated source is mostly a comment explaining exactly where a record, an
action, a capability and a policy go, and which rules the package must keep.

The acceptance criterion is a single sentence: *the output of `scaffold` passes
`test` with zero failures, zero skips, and every not-applicable row naming the
declaration it would have needed.* Measured, not asserted — 16 passed, 0 failed,
0 skipped, 12 `not_applicable`.

## What it must never do

- **Never invent domain semantics.** No record, action, policy, capability,
  provider, Admin section, Solution Plan, MCP tool or Skill.
- **Never compose.** `packages/domains/generated/index.js` is untouched. Adding
  one import is a deliberate human act, and that is the framework's security
  model — not an oversight to automate away.
- **Never open a database or run a migration.** A package owns a record only
  once its manifest is applied through the ordinary module factory.
- **Never install, download, sign, publish or register anything.** There is no
  marketplace and no remote anything; a package is source in your own repository.
- **Never overwrite, and never rename.** An occupied target is refused. An
  invalid name is refused *with a suggestion*, because an author who asked for
  `Field Service` and silently received `field-service` has a package they did
  not name.

## Safety, stated exactly

| Attack | Refusal |
|---|---|
| target already exists | `TARGET_UNAVAILABLE` — `lstat`, so a dangling symlink counts |
| `--into ../..` or `--into /etc` | `TARGET_UNAVAILABLE` before any write |
| `--into <symlink out of the project>` | `TARGET_UNAVAILABLE`, resolved through `realpath` |
| the same, where the leaf does not exist yet | also refused — the check climbs to the nearest existing ancestor, because `mkdir -p` would otherwise follow the link on the way in |
| invalid, reserved or hostile name | `PACKAGE_NAME_INVALID`, from `validatePackageDefinition` itself |
| a previous run died mid-write | **nothing is blocked.** The corpse is reported as `staleStaging` and left alone |
| two concurrent applies | one `rename` wins; every loser gets `TARGET_CLAIMED` and nothing is overwritten |
| target appears between the plan and the commit | `TARGET_CLAIMED` — the plan reserves nothing, so `--apply` re-derives and re-checks |
| a write fails halfway | this run's staging is removed; no partial package is ever visible |

### The commit point, and why staging is unique

Files are written into a staging directory named uniquely per run, and the
package becomes visible through **one `rename`** of that directory onto the
target. That rename is the commit point and the only race: before it nothing of
this run exists under the package's name, after it everything does. There is no
window in which a partial package is importable.

The first version of this command staged in a *fixed* `.scaffold-<name>`
directory and refused with `SCAFFOLD_IN_PROGRESS` when it was occupied. That is
a lock, and a lock a crashed process holds forever is a lock somebody has to
break with `rm -rf`. One `SIGKILL` and every later run in that project was
refused. Deleting the corpse automatically is not the fix either: this command
cannot tell a corpse from a live writer, and an age heuristic that guesses wrong
deletes a concurrent author's work. So each run stages under its own name,
nothing is ever blocked, and leftovers are **reported** — `staleStaging` in the
JSON, a named directory in the human view, and a line in `nextSteps`.

Measured: eight independent processes racing one target produce exactly one
`applied`, seven `TARGET_CLAIMED`, a complete package and zero leftover staging.

### Platform boundary

POSIX `rename(2)` refuses a file, a symlink and a non-empty directory — but
**replaces an empty one**. Windows refuses every existing destination. So the
commit point checks the target with `lstat` immediately before renaming, which
turns every target that exists when we look into a refusal and leaves only one
residual: a directory created empty in the gap between those two lines would be
replaced. Nothing is lost, because an empty directory has no content, and it is
recorded as `FINALIZATION_REPLACES_AN_EMPTY_DIRECTORY` rather than left for a
reader to discover.

### A plan reserves nothing

`--apply` does not trust a plan the caller is holding: it re-derives the target
from the filesystem as it is at that moment, and refuses a collision that
appeared in between. The `fingerprint` identifies the generated content so two
checkouts asking the same question agree — it is not a claim on a directory, and
it deliberately excludes transient filesystem state such as leftover staging or
whether the parent already exists. Recorded as `PLAN_IS_NOT_A_RESERVATION`.

Because `--apply` and a plan both exit 0, and an explicit `--dry-run` beats
`--apply` (matching `module:create`), every document carries a **`modeReason`**
saying which flag won, and the human view prints `NOTHING WAS WRITTEN` rather
than a polite suggestion. An agent that reads only the exit code would otherwise
conclude it wrote a package it did not write.

One thing it deliberately does **not** check is whether the *identity* is
already taken. The target directory is checked; the composed application is not,
because reading which package names are registered means importing the
composition, and this command runs no project code. `packages/<name>` covers the
case that actually happens, and a genuine duplicate is refused by the registry
at startup with the collision named. That is stated as a limitation
(`IDENTITY_UNIQUENESS_NOT_CHECKED`) rather than silently hoped for.

The name rule is the framework's own `validatePackageDefinition`, not a second
slugger written here. A name the application would refuse at registration is
refused at scaffold time, with the same message. That matters because the name is
interpolated into the generated source: validating it against the real rule is
what keeps a quote, a backtick or a newline from ever reaching a template.

Atomicity is a single `rename`. Files are staged in `packages/.scaffold-<name>`
and the package appears in one step, so there is no window in which a half-written
package is importable — which would otherwise be the one way this command could
break a project it never claimed to touch.

## Determinism

Same name, byte-identical bytes. The plan carries a `fingerprint` over the
generated content and the declared package, and nothing that varies by machine
enters it: no timestamp, no random id, no absolute path, no environment. The
paths that *do* appear in the output — the kernel import and the composition
line — are derived from `--into` and the name alone, never from the root
directory, which is why a scaffold in a checkout whose path contains a space
produces the same bytes as one that does not.

## Exit codes

```text
0  planned, or applied
1  refused
```

There is no third code. Unlike `package test`, the scaffold reads no package and
boots no application, so it has no "unreadable" case to distinguish.

## What this closes, and what it does not

It closes the *starting* gap in the authoring flow:

```text
AX1 app inspect  →  AX2 solution plan  →  DX3 scaffold  →  edit  →
validate  →  inspect  →  DX4 package test  →  your own domain tests  →
compose, deliberately, by hand
```

It does not close, and does not claim to close:

- **domain correctness** — the scaffold's output models nothing, and `package
  test` says `DOMAIN_CORRECTNESS_NOT_PROVEN` about it;
- **record creation** — a resource still needs a manifest and `crm module create`;
- **composition** — still one hand-written import;
- **package-contributed HTTP routes** — still open, tracked in DX4's ExecPlan;
- **distribution** — no marketplace, no registry, no remote install.
