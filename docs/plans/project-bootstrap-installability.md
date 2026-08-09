# Project Bootstrap — turning `create-accordo` into a real scaffold (ExecPlan)

## 1. Goal and user-visible outcome

> **Give me a new Accordo project from nothing, offline, and prove it runs.**

Today the only way to get a project built on this framework is to copy the
source tree by hand or to run
`examples/starters/b2b-lead-qualification/install.mjs`, which builds a
throwaway directory in order to assert five invariants and then deletes it. The
name `create-accordo` exists on the npm registry as an **empty placeholder**
that installs nothing (`site/brand.json` → `npm.status: names-reserved`).

The user-visible outcome of this plan is one command:

```bash
create-accordo my-crm --apply
```

which writes a **new, standalone, runnable Accordo project** into an empty
directory: no network access, no `npm install` required, and — proven by a test
that does exactly this — the result boots, passes its own declared checks,
reports `valid` from `accordo app inspect --json` and exits `0` from
`accordo project doctor --json`.

**What this plan does not do, stated in the same breath:** it does not publish
anything. `create-accordo` on the npm registry remains the empty placeholder it
was. The true sentence after this merges is *"`create-accordo` scaffolds a
working project **from this repository**"*. The sentence *"`npm create accordo`
works today"* stays false until a human publishes, and the bootstrap says so in
its own machine-readable output (`PUBLISHED_PLACEHOLDER_DOES_NOT_SCAFFOLD`).

## 2. Package Scaffold is not Project Scaffold

DX3 (`accordo package scaffold`) and this are adjacent rungs on the same ladder,
and conflating them is the reason the lower rung has been missing for so long.

| | DX3 — Package Scaffold | This — Project Bootstrap |
|---|---|---|
| Precondition | **an Accordo project already exists** | **nothing exists** — an empty directory |
| Where it is run from | inside the project, through the project's own CLI | from outside, through a package that carries the framework |
| What it produces | 2 files: an identity and five empty declarations | a project: the framework source, an application manifest, its own checks and its own README |
| What it needs to work | `packages/core/index.js` importable in the project | only Node and its own bytes — it may not import the framework, because the framework is what it is installing |
| Its acceptance test | `accordo package test <dir>` exits 0 | the generated project boots, `app inspect` is `valid`, `project doctor` exits 0, and the project's own `npm test` passes |
| What it composes | nothing — one line a human adds | nothing — the composition file ships empty, as in this repository |

**One cannot be the other, for a mechanical reason.** `accordo package scaffold`
is a subcommand of `accordo`. To run it you must already have `accordo` — which
means you must already have a project, which is exactly the thing the user does
not have. A rung that requires the ladder cannot be the bottom of the ladder.

The consequence runs the other way too, and it constrains the implementation:
**the bootstrap may not import `packages/core`.** Every other command in this
repository is free to reach for `canonicalJson`, `validatePackageDefinition` or
`safeMessage`; this one runs at the moment before the framework exists on the
user's disk, and a published placeholder with no framework beside it must still
be able to load, produce a report and say *why* it cannot proceed. So
`create-accordo` is standalone Node with a ~20-line local canonical-JSON
serializer, and that duplication is deliberate and recorded here.

## 3. Three approaches compared

### Option 1 — a template repository fetched at bootstrap time

The industry-standard shape: `create-x` downloads a tarball, a git ref or a
registry listing and expands it.

**Rejected, and it is not close.** `docs/CODER_TOOLING_ROADMAP.md` refuses
"remote package or provider installation" as a standing rule — *"nothing here
reaches the network, and no official package needs to"*. A bootstrap that
fetches is non-deterministic by construction (the same command yields different
projects on different days), unverifiable offline, untestable in this
repository's suite, and introduces a supply-chain seam into the one command a
user runs before they have read any of the source. Every other contract here —
AX1, AX2, DX1, DX3, DX4, DX5 — is deterministic and fingerprinted. A fetching
bootstrap would be the only surface in the framework that cannot be diffed.

### Option 2 — generate a thin project that depends on `accordo` from npm

The project would be a `package.json` with `"dependencies": {"accordo": "^0.1"}`
and a handful of composition files; `npm install` would bring the framework.

**Rejected on two independent grounds.** First, factually: `accordo@0.0.1` is an
**empty name reservation**. A generated project whose first act is
`npm install accordo` would install nothing and then fail to boot — the exact
failure this milestone exists to remove, dressed as a success. Second,
structurally: it requires the network at first run, which Option 1 already fails
on, and it would encode a version constraint against a package this repository
has never published and cannot verify. `site/concepts.json` and `site/claims.json`
already record the truth as **L-08**: *"ownership here means the source is yours
to keep, read and change, and today it means copying it."* A bootstrap that
pretends otherwise would make the site's own claims ledger wrong.

### Option 3 — vendor the checked-in framework source, deterministically (chosen)

`create-accordo` locates the framework source **relative to itself**, copies a
declared manifest of directories into a staging directory, writes a small set of
generated files (the project manifest, its README, its `AGENTS.md`, its own
tests and check scripts), and commits the whole thing with a single `rename`.

Why it wins:

- **It is already the repository's honest model of ownership.** `install.mjs`,
  `site/concepts.json`, `site/compare.json` and `site/claims.json` all say
  ownership means copying source. This makes that copy a first-class,
  fingerprinted, refusable operation instead of a `cp -r` in a starter script.
- **It needs no network and no install.** The framework has zero third-party
  runtime dependencies (`C-17`), so the generated project's `npm install` is a
  no-op and `node --test` runs immediately.
- **It is deterministic and diffable.** The same checkout produces a
  byte-identical project; the report carries a `source.fingerprint` over every
  copied file's content hash, so two bootstraps can be compared without
  comparing 200 files.
- **It degrades honestly when the source is absent.** The published placeholder
  has no framework beside it. Rather than crashing, the bootstrap reports
  `FRAMEWORK_SOURCE_UNAVAILABLE` and exits 2 — which is precisely, and
  truthfully, what `npm create accordo` does today.
- **Its limitation is stateable.** Vendoring means upgrading is merging, not
  bumping. That is published as `SOURCE_IS_A_COPY_NOT_A_DEPENDENCY` in the
  report itself, not buried in a doc.

## 4. The DX Simplicity Gate — all eight questions

**1. Which concrete agent failure mode does it prevent?**
*An agent asked to "build a CRM with Accordo" invents a project layout.* Today
there is nothing to run, so the agent copies directories by guesswork, produces
a tree that `app inspect` cannot read (`Not an accordo project: … has no
packages/core/index.js`) or that has a composition file but no kernel modules,
and then reports success. The second failure mode it prevents is subtler and is
the one currently in the repository: *an agent reads `npm create accordo` in a
document and believes a project can be created that way.* The bootstrap makes
the first true and forces the second to be stated precisely.

**2. Why are existing primitives insufficient? (show the attempt)**
Extending an existing command was tried first and is structurally impossible:

- `accordo package scaffold` — attempted, and rejected in §2. It is a subcommand
  of a CLI that only exists inside a project, and it writes a package into
  `packages/`, never a project around one. Making it also produce projects would
  give one verb two preconditions ("must be in a project" / "must not be").
- `examples/starters/b2b-lead-qualification/install.mjs` — the closest existing
  thing, and it was read line by line. It builds a project in `mkdtemp`, applies
  60+ module manifests, asserts five invariants and deletes the result. It is a
  **test fixture with a copy step inside it**: no name validation, no refusal
  vocabulary, no dry-run, no report, no fingerprint, and its output is not
  intended to be kept (`ACCORDO_KEEP_ROOT` is a debugging hatch). Turning it into
  a product surface would mean adding all six of those to a 1,492-line assertion
  script — i.e. writing this command inside it.
- `accordo module create` — writes one record into an existing project.

**3. Does it overlap semantically with an existing tool?**
No. The one-line difference from every neighbour: *`package scaffold` makes a
package inside a project; this makes the project.* It answers a question no
existing command answers, and it is the only command in the framework that is
runnable when the framework is not installed. To keep the overlap at zero it
deliberately adds **no** `accordo` subcommand — `accordo project bootstrap`
would be a second door to the same room, reachable only by people who do not
need it.

**4. Can it remain deferred or on-demand?**
It is the most deferred surface possible: it is run **once, before the project
exists**, and never again. It occupies no session context, adds no MCP tool, no
skill, and no `accordo` subcommand. `npm run surface:check` measures skills, MCP
tools and commands named in skills; this milestone moves none of those numbers.

**5. Does it preserve Claude / Codex / Gemini portability?**
Yes. The behaviour is a bin with arguments, a JSON contract
(`projectBootstrapContract: 1`) and stable exit codes. No harness-specific
logic. The generated project ships the published `skills/` bundle — the
tier-declared, portable subset — so any AGENTS-compatible agent arriving in the
new project gets the same semantics.

**6. What machine-readable evidence proves its value?**
`projectBootstrapContract: 1`; a `fingerprint` over the generated content and a
`source.fingerprint` over every copied file; exit codes `0 | 1 | 2`; a closed
problem-code vocabulary; a published limitation list; and the end-to-end test
that creates a temp directory, bootstraps into it, and then runs
`app inspect --json`, `project doctor --json` and the generated project's own
`npm test` and `npm run smoke` against the result.

**7. Does horizontal impact update the Compatibility Backfill and the Legacy
Alignment Matrix?**
**This capability is judged _not horizontal_, and the justification is recorded
in the matrix so a reviewer can disagree with it in one place.** The rule's test
is *"one every domain could use"*. Project Bootstrap sits one level **above**
domains: it creates the container domains live in, composes none of them
(`generatedDomains` ships empty, exactly as in this repository), and there is no
per-domain status to record — "is Commercial Operations aligned with project
bootstrap?" has no meaning, in the way "is it aligned with the package seam?"
does. Contrast DX1/DX3/DX4, which each declared a horizontal answer because each
introduced a rule or a check that every domain is measured against. This
introduces none. A short section is nonetheless added to
`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` recording the decision and its
reasoning, because the rule's failure mode is silence, and an unrecorded "not
horizontal" is indistinguishable from a forgotten one.

**8. Does the end-user goal flow become simpler, not more manual?**
Yes, and it is the only rung that removes a step rather than adding one. Before:
*clone the framework repository, work out which directories are the framework
and which are its own tests and site, copy them, write a `package.json`, hope*.
After: one command, one report, and a project whose health is already
machine-checked. The agent has **nothing** more to run in an existing project —
this command is invisible to every session after the first.

## 5. Current repository context

Verified in this worktree at branch point `0c8a29d`, not taken on trust:

- Root package is `accordo@0.1.0`, `private: true`, `bin.accordo →
  ./packages/cli/bin/accordo.js`. There is no `bin/crm.js` and no
  `bin/agent-crm.js`.
- **`create-accordo` does not exist as source anywhere in the repository.**
  `grep -rn "create-accordo"` returns only documentation and `site/brand.json`.
- `site/brand.json` → `npm.status: "names-reserved"`, and states: *"Neither
  placeholder installs a working project — `npm create accordo` is a name
  reservation, not a scaffold, and no document may present it as one until
  create-accordo actually scaffolds."*
- `packages/domains/generated/index.js` exports `generatedDomains = []` — the
  repository's own default composition is the kernel only.
- `packages/cli/src/app-inspect.js` requires `packages/core/index.js` to exist,
  loads six composition files, and loads four handwritten kernel modules
  (`approval`, `company`, `contact`, `opportunity`) from
  `packages/modules/<name>/src/index.js`.
- `packages/cli/src/project-doctor-checks.js`: `projectKind` returns
  `framework-repository` when `packages/core` and `packages/cli` are both
  directories; `hygieneChecks` is `not_applicable` outside a git repository;
  `skillChecks` is `not_applicable` unless **both** `.claude/skills` and
  `.agents/skills` exist; `docsChecks` scans `docs/`, `.claude/skills`,
  `.agents/skills` plus six root documents and fails on unresolved
  repository-relative links; `planChecks` grades a plan only when `package.json`
  declares it under `agentCrm.solutionPlans`.
- `docs/SKILL_PACKAGING.md` states that **no** repository Markdown ships into a
  generated project, and the published `skills/` bundle declares
  `tier: generated-project | any-project` with a `degradesTo` — i.e. it is
  designed for exactly the project this command creates.
- `scripts/surface-check.js` budgets skills, MCP tools and commands **named in
  skills**. Adding neither leaves all four measures unchanged.
- `packages/` is 1.9 MB / 168 files; `apps/` 312 KB / 14 files; `skills/`
  160 KB; `examples/modules/` 12 KB. A vendored project is ~2.4 MB.

## 6. Design

### 6.1 Where it lives

```text
packages/create-accordo/
  package.json          name: create-accordo, type: module, private: true, bin
  bin/create-accordo.js the executable `npm create accordo` would run
  src/project-bootstrap.js  plan + apply, the contract, the vocabulary
  src/project-files.js      the generated file contents
  README.md             what it is, and that publishing is a human decision
```

`private: true` is deliberate and load-bearing: **npm refuses to publish a
private package**, so this branch cannot cause an accidental publication. A human
removes that field, adds a `files` array covering the vendored source, and
publishes. That is written in the package README rather than left implicit.

`"type": "module"` is required, not cosmetic: a `package.json` under
`packages/` without it would make every `.js` file beneath it CommonJS.

### 6.2 Command surface

```text
create-accordo <directory> [--name <project-name>] [--apply] [--json] [--help]
```

- `<directory>` — where the project goes. Relative or absolute; it is the
  user's own machine and an absolute target is ordinary usage.
- `--name` — the npm package name written into the generated `package.json`.
  Defaults to the directory's basename. If the basename is not a valid name the
  command **refuses with a suggestion** and never renames silently.
- `--apply` — the only thing that writes. Dry-run is the default.
- `--json` — the contract. The text view is a convenience.

### 6.3 Locating the framework source

Walk up from this module's own directory until a directory contains **all** of
`packages/core/index.js`, `packages/cli/bin/accordo.js`,
`packages/app/src/index.js`, `packages/domains/generated/index.js`. In this
repository that resolves to the repository root at the second step. If no
ancestor qualifies, the answer is `FRAMEWORK_SOURCE_UNAVAILABLE`, exit 2 — which
is what the published empty placeholder would do, honestly, rather than crashing.

There is no `--from` flag. A flag that lets a caller point the copy at an
arbitrary directory is a foot-gun with no use case the test suite needs.

### 6.4 What is copied, and what is generated

Copied verbatim from the resolved source (declared as a manifest in code, not a
glob of "everything"):

| Path | Why |
|---|---|
| `packages/` | the framework — kernel, CLI, MCP, modules, domain packages, SDK |
| `apps/` | the HTTP server and the generated Admin |
| `skills/` | the published, tier-declared agent skills, designed for this audience |
| `examples/modules/` | the two manifest examples `create-crm-module` names in its `projectSurface` |

Excluded everywhere: `node_modules`, `.git`, `data`, `*.sqlite*`,
`.scaffold-*`, and `packages/create-accordo` itself — a project is not a
bootstrapper. Symlinks are refused rather than followed.

Generated (nine files, none copied):

```text
package.json      name, engines, bin: accordo, scripts: crm/test/check/smoke/verify/doctor/dev
README.md         what the project is, and every limitation in the same breath
AGENTS.md         the rules a coding agent must keep in THIS project
.gitignore        node_modules, .env, data/*.sqlite
.env.example      PORT, CRM_DB_PATH, APPROVAL_THRESHOLD_CENTS
.mcp.json         the project's own stdio MCP server
data/.gitkeep     the database directory, empty
scripts/check.js  syntax check over the project's own JavaScript
scripts/smoke.js  boot, run the demo, assert the counts
tests/project.test.js   the project's own declared check (see 6.6)
```

No `docs/` directory is generated. `docs/SKILL_PACKAGING.md` already decides
that no repository Markdown ships into a generated project, and every extra
Markdown file is another surface `project doctor`'s link check can fail on. The
limitations live in the generated `README.md`, which the doctor does scan.

### 6.5 The contract

`projectBootstrapContract: 1`, matching the shape of
`project-verify-command.js`, `project-doctor-command.js` and
`package-scaffold.js` rather than inventing a new one: dry-run by default,
`--apply` to write, canonical ordering, a fingerprint, a published limitation
list, repository-relative paths only, and `safeMessage`-style scrubbing of any
error that carries an absolute path.

```jsonc
{
  "projectBootstrapContract": 1,
  "command": "project:bootstrap",
  "ok": true,
  "mode": "plan" | "applied" | "refused",
  "modeReason": "no --apply was given, so nothing was written",
  "project": { "name", "directory", "kind", "composedPackages": [],
               "databaseBackend", "productionPosture" },
  "source": { "resolved", "entries": [...], "excluded": [...], "files", "bytes",
              "fingerprint" },
  "files":  [ { "relativePath", "operation": "create", "bytes", "contentHash" } ],
  "checks": { "declared": [...], "expectation": "..." },
  "nextSteps": [...],
  "problems": [ { "code", "message" } ],
  "limitations": [ { "code", "message" } ],
  "fingerprint": "sha256(...)"
}
```

**Exit codes.** Three, and every one still prints a full report under `--json`:

```text
0   the plan is clean, or --apply wrote the project
1   refused because of the request      (bad name, non-empty target, …)
2   refused because of the environment  (no framework source, no target given)
```

**Problem vocabulary**, closed and stable:

| Code | Exit | Meaning |
|---|---|---|
| `TARGET_MISSING` | 2 | no directory argument |
| `TARGET_PATH_INVALID` | 1 | empty, a null byte, or a control character |
| `TARGET_NOT_A_DIRECTORY` | 1 | the path exists as a file, or a symlink |
| `TARGET_NOT_EMPTY` | 1 | the directory exists and has entries |
| `TARGET_INSIDE_FRAMEWORK_SOURCE` | 1 | bootstrapping the framework onto itself |
| `PROJECT_NAME_INVALID` | 1 | not an npm package name — carries a suggestion |
| `FRAMEWORK_SOURCE_UNAVAILABLE` | 2 | no ancestor carries the framework |
| `FRAMEWORK_SOURCE_INCOMPLETE` | 2 | a declared manifest entry is missing |
| `SOURCE_NOT_READABLE` | 2 | a symlink or an unreadable entry inside the manifest |
| `TARGET_CLAIMED` | 1 | the commit rename lost a race |
| `BOOTSTRAP_NOT_WRITTEN` | 2 | a filesystem failure; staging removed, nothing left behind |

**Limitations**, published by the command itself:

`NO_AUTHENTICATION` · `NO_TENANCY` · `NO_RBAC` · `SQLITE_ONLY` ·
`LOCAL_DEVELOPMENT_ONLY` · `NO_DOMAIN_PACKAGES_COMPOSED` · `NO_NETWORK_ACCESS` ·
`SOURCE_IS_A_COPY_NOT_A_DEPENDENCY` · `PROVIDERS_ARE_OFFLINE_FIXTURES` ·
`NO_SCHEDULER_OR_OUTBOX` · `SOURCE_IS_TRUSTED` ·
`CONFORMANCE_IS_NOT_CORRECTNESS` · `PUBLISHED_PLACEHOLDER_DOES_NOT_SCAFFOLD` ·
`FINALIZATION_REPLACES_AN_EMPTY_DIRECTORY`

The last two matter most. `PUBLISHED_PLACEHOLDER_DOES_NOT_SCAFFOLD` is the
npm-versus-source distinction, stated by code in the one place nobody can forget
to update. `FINALIZATION_REPLACES_AN_EMPTY_DIRECTORY` is inherited verbatim from
DX3's analysis of POSIX `rename(2)`, because this command commits the same way.

### 6.6 Name validation

npm package-name rules, applied deterministically and offline: 1–214
characters, lowercase only, first character `[a-z0-9]`, remainder
`[a-z0-9._-]`, no `..`, no path separator, no `node_modules`, no `favicon.ico`,
no Node core module name, and an explicit refusal of `__proto__`,
`constructor` and `prototype`. A refusal carries a canonical **suggestion** that
is never applied.

### 6.7 Writing, atomically

Identical in shape to DX3, for the same reasons: files are written into a
staging directory unique to this run (`.accordo-bootstrap-<uuid8>`) beside the
target, and the project becomes visible through **one `rename`**. Before it,
nothing of this run exists at the target; after it, everything does. Staging is
unique rather than fixed so a crashed run holds no lock, and it is removed on
any failure path.

### 6.8 The generated project's own checks

`tests/project.test.js` asserts, in-process, on a temp SQLite file:

1. the application boots and the demo produces the two renewals and exactly one
   pending approval;
2. **an agent actor cannot approve** — the framework's central claim, re-proved
   inside the new project rather than inherited from a document;
3. the composition file is present and composes zero domain packages, so the
   project's starting point is a fact the project itself asserts.

`scripts/smoke.js` boots, runs the demo and asserts the counts. `scripts/check.js`
runs `node --check` over the project's own JavaScript. `npm run verify` is
`check && test`, matching the framework's own vocabulary so an agent that knows
one knows the other.

## 7. Milestones

Each leaves the repository runnable.

1. **M1 — the package and its contract.** `packages/create-accordo/` with the
   planner, the file generator, the bin and its README. Dry-run only paths
   exercised by hand.
2. **M2 — apply, atomically.** Staging, commit rename, cleanup, refusals.
3. **M3 — the spine test.** `tests/project-bootstrap.test.js`: temp dir →
   bootstrap → `app inspect --json` → `project doctor --json` → the generated
   project's own `node --test` and smoke.
4. **M4 — refusal and hostile-input tests.** Every code in §6.5, plus
   `__proto__`, `constructor`, `..`, absolute paths, separators, null bytes,
   markup, backticks, `${…}`, newlines, Unicode separators, 300-character names.
5. **M5 — distribution honesty.** `site/brand.json`,
   `scripts/distribution-check.js`, `docs/PROJECT_STATUS.md`,
   `docs/CODER_TOOLING_ROADMAP.md`, `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`,
   and `README.md` — **source scaffolds; registry unchanged.**
6. **M6 — `npm run verify`, `npm run distribution:check`, `npm run site:check`.**

## 8. Validation

```bash
npm run verify                  # from this worktree
npm run distribution:check
npm run site:check
node --test tests/project-bootstrap.test.js

# and by hand, the thing the milestone claims:
D=$(mktemp -d)
node packages/create-accordo/bin/create-accordo.js "$D/demo-crm" --apply --json
node "$D/demo-crm/packages/cli/bin/accordo.js" app inspect --json --root "$D/demo-crm"
node "$D/demo-crm/packages/cli/bin/accordo.js" project doctor --json --root "$D/demo-crm"
cd "$D/demo-crm" && npm test && npm run smoke
```

Expected: `app inspect` → `"valid": true`, exit 0. `project doctor` → `"status":
"passed"`, exit 0. The project's own tests and smoke pass with no `npm install`.

## 9. Progress log

- **2026-08-09** — baseline established in this worktree before any change:
  `npm install` clean, `npm run smoke` green, and `npm run verify` **741 tests,
  739 passing, 2 failing** — see §11, which records what the two are and why they
  are not this branch's.
- **2026-08-09** — ExecPlan written before code, per `docs/QUALITY_GATES.md` §1.1.
- **2026-08-09** — M1–M4 implemented; the spine test drives a real temp-directory
  bootstrap and then runs `app inspect`, `project doctor` and the generated
  project's own tests and smoke against the result.
- **2026-08-09** — **four defects found by the tests, not by inspection**, each
  fixed with a regression test:
  1. **Infinite recursion in the name suggester.** `checkProjectName` produced a
     suggestion and then validated it by calling itself, so any input whose
     canonical form is *also* refused recursed until the stack blew — `__proto__`
     and `---` both hit it. Fixed by splitting the rules (`nameFailure`) out of
     the suggestion, making the dependency one-directional.
  2. **The generated `npm test` ran zero tests.** `--test tests/` silently finds
     nothing on Node 22 and `--test tests` tries to load a directory as a module.
     Fixed by matching the framework repository's own form — no path argument,
     Node's discovery — and asserting `pass 3 / fail 0` in the spine test.
  3. **Bootstrapping into a pre-created empty directory failed.**
     `mkdir my-crm && create-accordo my-crm --apply` is ordinary usage and
     `resolveTarget` explicitly allows it, but the commit step used a
     non-recursive `rmSync`, which throws `EISDIR` on a directory. Fixed with
     `rmdirSync`, which removes exactly an empty directory and refuses anything
     else.
  4. **The project name was derived against `process.cwd()`** rather than the
     caller's `cwd`, so `.` and `../thing` could name the project after the
     wrong directory. Invisible through the CLI, real through the module API.
- **2026-08-09** — a latent flake in the *generated* `scripts/check.js`, inherited
  from this repository's own: a failed `spawn` under load was counted as a syntax
  error. The generated version now retries three times and separates "this file
  does not parse" from "the check could not be run". (`scripts/check.js` in this
  repository still has the original behaviour; that is a pre-existing issue this
  branch deliberately does not touch.)
- **2026-08-09** — M5 claims pass: only the *source* claim changed; the registry
  claim is untouched everywhere, and `scripts/distribution-check.js` now fails
  mechanically if the two ever drift. All three new gates were falsified by hand
  before being trusted.
- **2026-08-09** — M6 green; final numbers in §12.
- **2026-08-09 — adversarial review.** A fresh clone at PR head `a093b931`
  found two bootstrap-proof defects and two portability/concurrency defects in
  the quality gate. The copied bootstrap executable silently exited `0` when
  macOS canonicalized `/var` to `/private/var`, because its main-module guard
  compared URL spellings rather than file identity; it now compares real paths,
  and the existing isolated-placeholder test proves exit `2` with the complete
  refusal report. The package-rung proof reached back to the framework checkout
  and passed an absolute path instead of using the generated project's own CLI
  as its README instructs; it now proves that exact self-contained flow. The
  doctor mutation test used GNU-only `find -newermt @0`; it now inventories
  files with Node and also detects content-size or mtime changes. Finally, the
  package cleanup test compared the shared system temp directory while other
  suites used it concurrently; its real CLI subprocesses now receive a private
  temp root, preserving the success/failure cleanup assertion without treating
  another test's scratch as this command's leak. Focused evidence: 61/61
  bootstrap-and-doctor tests and the isolated cleanup regression pass.

## 10. Decision log

| Ambiguity | Decision | Why |
|---|---|---|
| Should this be an `accordo` subcommand as well? | **No.** One entry point only | A subcommand is unreachable in the zero state, and a second door to one room is the semantic overlap the DX gate forbids |
| May `create-accordo` import `packages/core`? | **No.** It is standalone Node with a local canonical-JSON serializer | It must load and report when the framework is absent — the published-placeholder case |
| Should the bootstrap compose domain packages? | **No.** `generatedDomains` ships empty | It matches this repository's own default, keeps the output deterministic, and is published as `NO_DOMAIN_PACKAGES_COMPOSED` with the exact command that adds one |
| Ship the repository's docs into the project? | **No** | `docs/SKILL_PACKAGING.md` already decides this, and every shipped Markdown file is another link the doctor can fail on |
| Ship `skills/`? | **Yes** | It is the published bundle whose declared tiers are `generated-project` and `any-project`; this project is precisely that audience |
| Is `--name` a rename or a refusal? | **Refusal with a suggestion** | DX3's discipline: an author who typed `My CRM` needs to know the canonical form, not to be handed something they did not ask for |
| `private: true` on the package manifest? | **Yes** | npm refuses to publish a private package, so this branch cannot cause an accidental publication. Removing it is the human's deliberate act |
| Is this horizontal under the Backfill Rule? | **No**, and the reasoning is recorded in the matrix | It sits above domains and introduces no rule a domain is measured against |

## 11. Baseline (before any change in this worktree)

Recorded here so no later failure can be blamed on `main`, and recorded
**honestly**: the branch point is not clean in this environment.

Measured on `0c8a29d` with an empty working tree, before any file was written:

- `npm install` — exit 0, 0 vulnerabilities.
- `npm run smoke` — green.
- `accordo project doctor --json` — `"status": "passed"`, exit 0.
- `npm run verify` — **741 tests, 739 passing, 2 failing**, exit 1.

The two failures are pre-existing and environmental. Both were re-run in
isolation on the untouched branch point:

| Failing test | Symptom | Assessment |
|---|---|---|
| `tests/delivery-change-acceptance-evidence.test.js` → "exact reads stay exact past the display bound" | `TypeError: fetch failed` / `ECONNRESET` on a loopback SDK call, in the sub-test that writes 520 + 510 records over HTTP | reproduces in isolation on the untouched branch point. Loopback `fetch` itself was verified working in this sandbox (5/5 requests to a scratch server), so this is the local HTTP server dropping a connection under that test's write volume in this environment — not a defect this branch introduced and not one it touches |
| `tests/package-test-command.test.js` → "the caller's project is never written to, and the scratch is always removed" | asserts that the set of `accordo-package-test-*` directories in `tmpdir()` is unchanged, and sees a different one | a cross-file interference flake: the assertion is global over the shared temp directory, so another test file's scratch project counts against it. On an isolated re-run this sub-test passed and a *different* one in the same file failed |

**Neither is in this branch's blast radius**, and neither is fixed here: this is
a feature PR, and repairing an unrelated environmental flake inside one is how a
feature PR stops being reviewable. The number that matters for review is the
**delta**, in §12.

## 12. Outcome and follow-up

**What shipped.** `packages/create-accordo` — five files — plus
`tests/project-bootstrap.test.js` (27 tests) and this plan. Contract
`projectBootstrapContract: 1`; eleven problem codes; fourteen published
limitations; exit codes `0 | 1 | 2`.

**The end-to-end proof.** `tests/project-bootstrap.test.js` creates a temporary
directory, runs the bootstrap bin into it as a real process, and then runs the
*result*: `accordo app inspect --json` (`valid: true`, exit 0),
`accordo project doctor --json` (`status: passed`, `failed: 0`, `warning: 0`,
exit 0), the project's own `scripts/check.js`, its own `node --test`
(`pass 3, fail 0`) and its own `scripts/smoke.js`. A second test then runs
`accordo package scaffold` **inside** the bootstrapped project and
`accordo package test` on the result — the rung above this one, landing on it.

**Numbers, measured in this worktree.**

| | Baseline (`0c8a29d`, clean tree) | After adversarial review |
|---|---|---|
| `npm run verify` | 741 tests, 739 passing, **2 failing** | **769 tests, 769 passing, 0 failing** |
| Delta | — | **+28 tests, +30 passing, -2 environmental failures** |
| Baseline failures | pre-existing and environmental (§11) | the package scratch assertion is now concurrency-safe; the high-volume delivery case passed during the first review run |
| `npm run smoke` | green | green |
| `accordo project doctor --json` | `passed`, 0 failed, 0 warning | `passed`, 0 failed, 0 warning |
| `npm run distribution:check` | passed | passed, with three new gates |
| `npm run site:check` | passed, 23 claims / 9 limitations | passed, 23 claims / 9 limitations |
| `npm run surface:check` | 1/1, 12/12, 9/10, 11/11 | **identical** — no skill, no MCP tool, no command added |

The final adversarial-review run completed in the fresh clone with `npm run
verify` green: syntax checked 252 JavaScript files and all 769 tests passed. A
separate empty-directory run used the generated project's own CLI and produced
`app inspect valid: true`, `project doctor passed` with 0 failed / 0 warning,
its own tests at 3 passed / 0 failed, and a green smoke, with no install step.

**Clean-clone verification** (`docs/QUALITY_GATES.md` §1.7). A fresh
`git clone` of this branch into a new directory, with no `npm install` anywhere:
the bootstrap ran from the clone into a temporary directory, and the resulting
project reported `app inspect valid: true`, `project doctor: passed, failed 0,
warning 0`, `pass 3 / fail 0` from its own tests, and a green smoke. The
`fingerprint` and `source.fingerprint` produced by the clone are **byte-identical**
to the ones produced by this worktree for the same request
(`aa3b0be7…` / `f12ae28d…`), which is the determinism claim measured rather than
asserted.

**Claims changed, and the line held.** Only the *source* claim moved. The npm
registry row in `docs/PROJECT_STATUS.md` is unchanged and now says so explicitly;
`site/brand.json` keeps `npm.status: names-reserved` and adds a separate
`npm.sourceScaffolds: true`; and `scripts/distribution-check.js` now **fails**
when the two drift, when the package manifest is publishable while the registry
says otherwise, or when the status claims `published` while the manifest is
private. All three gates were falsified by hand before being trusted.

**Deliberately not done, and why:**

- **Nothing is published.** `accordo@0.0.1` and `create-accordo@0.0.1` remain
  empty placeholders on the registry. No `npm publish`, no `npm version`, no
  dist-tag. Publication is the founder's decision, and the package manifest is
  `private: true` so it cannot happen by accident from this branch.
- **No domain composition, no starter content.** A project that arrives with
  somebody else's Lead model is the DX3 "rich template" mistake at project
  scale.
- **No upgrade path.** Vendored source means merging, not bumping. That is
  `SOURCE_IS_A_COPY_NOT_A_DEPENDENCY`, and closing it needs a published,
  versioned framework package — a human decision this plan does not pre-empt.
- **No PostgreSQL, auth, tenancy or RBAC.** The generated project inherits every
  production blocker in `docs/PROJECT_STATUS.md`, and says so in its own README
  and in the bootstrap report.
