# Skill packaging and portability

A skill is the part of this framework that installs into somebody else's agent.
It travels further than anything else here — further than the CLI, the MCP
server or the documentation — because `npx skills add <org>/<repo>` copies it
into a project nobody in this repository has ever seen.

This page states what a skill may assume about that project, how it declares
what it needs, and what happens when the assumption is wrong.

## The failure this prevents

A skill that says *"read `ARCHITECTURE.md` and `docs/COMMERCIAL_OPERATIONS.md`
first"* behaves in exactly two ways. Inside this repository it works. Installed
into a stranger's project it loads, announces itself, finds no such files, and
then produces confident instructions about a codebase it never read. The user
sees a skill that triggered and answered — not a skill that failed — which is
strictly worse than shipping nothing, because a silent no-op is indistinguishable
from a wrong answer until the code is wrong too.

The fix is not to delete the paths. It is to make the skill reach the project
through a **command** rather than a path, and to state the paths as background
that may or may not be there.

```bash
npm run crm -- app inspect --json
```

That command answers what the documents were being read for: which packages are
installed, which capabilities resolve, which records exist and at which
revision, which actions and policies and providers are composed, what is broken
(`problems[]`) and what the report itself cannot know (`limitations[]`). It is
deterministic, source-only, and it works in any project that has this framework
in it — which is the definition of the audience a shipped skill has.

## The portability contract

1. **A skill reaches the project through a command, never through a fixed
   repository path.** The command is the seam; a path is an assumption.
2. **Every skill opens with the same orientation block.** Run `app inspect`,
   read `valid`, then `problems[]`, then `limitations[]`. Every limitation is a
   hard boundary on what may be claimed. That block is byte-identical in all
   eleven skills on purpose: an agent should not have to learn a new preamble
   per skill.
3. **A named document is background, not a prerequisite.** Path references stay
   — inside this repository they are correct and they are the deeper source —
   but they are framed so that their absence is an expected state, not an error
   and not something to work around by guessing at their contents.
4. **A skill declares what it needs in frontmatter**, including what it degrades
   to when the repository surface is missing. A skill that cannot state its own
   degraded mode has not thought about being installed.
5. **A skill never claims a capability the inspection report does not list.**
   The report is the source of truth about the project; the skill is the source
   of truth about the method.

## What a skill may assume

- Node 22.16+ and a shell that can run one command and read its stdout and exit
  code (`docs/AGENT_HARNESS_COMPATIBILITY.md`).
- That `crm app inspect --json` either answers or fails loudly with exit code
  `2`. A silent absence is not one of the outcomes.
- That the JSON it gets back has a declared contract version
  (`applicationInspectionContract: 1`) and a stable top-level shape.
- That the report is honest about its own blindness: it never opens a database,
  contacts a provider, reads a secret or aggregates evidence, and it says so in
  `limitations[]`.

## What a skill may not assume

- **That any Markdown document exists.** Not `ARCHITECTURE.md`, not
  `DECISIONS.md`, not `AGENTS.md`, not anything under `docs/`. None of them ship
  into a project built from this framework.
- **That the project is this repository.** No git remote, no branch name, no PR,
  no ExecPlan, no ADR numbering, no `docs/plans/`.
- **That a package exists because the skill is about it.** `build-signature-order`
  installed into a project with no signature package must say so from
  `packages[]`, not proceed.
- **That a capability resolves.** `capabilities[]` reports `resolved`, `missing`
  and `provider-mismatch`. The unresolved edge is usually the answer.
- **That a provider is usable.** A `providers[]` entry means a definition was
  composed in source. It is never evidence of a credential, a network route or a
  healthy remote service (`PROVIDER_HEALTH_UNKNOWN`, `SECRETS_NOT_INSPECTED`).
- **That the report knows what is supported.** `EVIDENCE_NOT_AGGREGATED` is a
  declared limitation: jobs and quality-gate status live in Markdown maintained
  by people, referenced by path and never parsed into structured claims.

## The three tiers

| Tier | Value in `requires.tier` | Runs where | Needs |
|---|---|---|---|
| 1 | `any-project` | any project with this framework installed | commands, the HTTP API and the MCP tools only |
| 2 | `generated-project` | a project built from this framework | the composed source tree (`packages/…`, `examples/…`) and the CLI |
| 3 | `repository` | this framework's own repository | documents and artifacts that exist only here |

The boundary between tier 1 and tier 2 is whether the skill needs to *open a
source file*. The boundary between tier 2 and tier 3 is whether it needs to open
a *document a human wrote about this project's history* — an ADR, a quality-gate
list, an ExecPlan, a jobs matrix.

Tier 2 is not hypothetical. A project produced by
`examples/starters/b2b-lead-qualification/install.mjs` carries `packages/`,
`apps/`, `examples/`, `tests/` and `package.json` — and carries no
`ARCHITECTURE.md`, no `DECISIONS.md`, no `AGENTS.md` and no `docs/` at all. In
that project `crm app inspect --json` reports `valid: true`, nine packages, 76 records, 64 actions,
fourteen resolved capabilities, zero problems and the eleven standing limitations. Every
`projectSurface` path declared by a tier-2 skill resolves there; every
`repositorySurface` path it declares does not. That asymmetry is the whole point
of separating the two fields.

Note the direction of the surprise: this repository's **default** composition
reports zero packages, zero capabilities, zero actions and zero providers,
because the composed application here exists only as a test helper. A skill that
inferred what exists from source layout would be more wrong in the framework
repository than in a customer's project. The command is right in both.

## Which skill is in which tier today

| Skill | Tier | Why |
|---|---|---|
| `debug-crm-run` | 1 — `any-project` | reaches the project only through `npm run doctor`, `GET /api/traces/:id` and the `crm_get_trace` MCP tool |
| `create-crm-module` | 2 — `generated-project` | drives `crm module validate\|plan\|create`; the manifest example and `packages/modules/` are source, its guides are background |
| `create-crm-workflow` | 2 — `generated-project` | reads the workflow engine and an existing workflow in the project's own source |
| `build-lead-intelligence` | 2 — `generated-project` | registers a provider or policy in `packages/intelligence/generated/index.js` |
| `build-commercial-operations` | 2 — `generated-project` | composes `createCommercialDomain` in `packages/domains/generated/index.js` and uses the package's pricing helpers |
| `build-signature-order` | 2 — `generated-project` | composes `createSignatureDomain` in `packages/domains/generated/index.js` |
| `build-contract-activation` | 2 — `generated-project` | authors a domain package against `packages/core/index.js` and the static composition file |
| `build-delivery-handover` | 2 — `generated-project` | needs the `contracts/delivery-obligations@1` capability to resolve, which the report tells it |
| `build-custom-domain-package` | 2 — `generated-project` | authors and then runs `crm package validate` — the same validator startup runs |
| `solve-business-goal` | 2 — `generated-project` | its loop is `app inspect` then `solution validate\|check`; the strategy documents are background |
| `adversarial-review` | 3 — `repository` | reviews a pull request against `AGENTS.md`, `docs/QUALITY_GATES.md`, an ExecPlan under `docs/plans/`, the ADRs and the jobs matrix — none of which ship anywhere else |

One tier-1 skill, nine tier-2, one tier-3.

Two tier-2 skills carry a **tier-3 fragment**, and each says so in place rather
than pretending otherwise: `build-custom-domain-package` asks for a jobs-matrix
update and reuses a conformance helper that lives only in this repository's
`tests/`, and `solve-business-goal` cites strategy documents and the quality
gates. A fragment is acceptable where the skill's main job completes without it.
A skill whose *main job* needs a repository document is tier 3, not tier 2 with a
caveat.

## The `requires` block

Frontmatter, after `description`, five fields, all required:

```yaml
---
name: build-lead-intelligence
description: …
requires:
  tier: generated-project
  command: "crm app inspect"
  projectSurface: ["packages/intelligence/generated/index.js"]
  repositorySurface: ["ARCHITECTURE.md", "DECISIONS.md", "docs/LEAD_INTELLIGENCE.md"]
  degradesTo: "the composed providers, policies and actions reported by `crm app inspect --json`"
---
```

| Field | Meaning |
|---|---|
| `tier` | exactly one of `any-project`, `generated-project`, `repository` |
| `command` | the one command that makes the skill portable — its entry point. Every skill here declares `crm app inspect`; further commands a skill drives are named in its body and come from the same CLI |
| `projectSurface` | source paths the skill needs, which a project built from this framework has. Empty for tier 1 |
| `repositorySurface` | documents the skill names that ship only in this repository. Their absence is expected, never an error |
| `degradesTo` | what the skill falls back to, in one sentence, when `repositorySurface` is missing. For tier 3 this field says plainly that there is no substitute — a degraded mode nobody can name is a degraded mode nobody tested |

`name` and `description` are untouched by any of this. The description is the
only signal deciding whether a skill triggers at the right moment, and
`tests/skill-parity.test.js` asserts `name` matches its directory.

## Declaring a new skill

1. Write the body against **commands**. If a step needs to know what the project
   contains, that step reads the inspection report, not a file listing.
2. Put the shared orientation block at the top, byte-identical to the other ten.
   Do not paraphrase it: an agent that has seen it once should recognise it.
3. Name the documents that carry the deeper reasoning, under
   *Background, where they exist*. Do not turn them into step 1.
4. Fill in `requires`. Choose the tier by the honest question: *what breaks if
   this is installed into a project that has the framework and nothing else?*
   If the answer is "nothing", it is tier 1. If it is "the source paths are
   there but the guides are not", tier 2. If the skill's main job cannot
   complete, tier 3 — and say why in `degradesTo`.
5. Mirror it to `.agents/skills/<name>/SKILL.md` byte-for-byte.
   `tests/skill-parity.test.js` and `scripts/check.js` both fail on drift, and a
   Codex user installing a smaller product than a Claude user is a shipped
   asymmetry nobody announced.
6. Run `npm run verify` and `npm run gtm:check`.

## What this does not solve

- **`requires` is a declaration, not an enforced check.** Nothing parses it
  today. It is honest metadata that a future gate — or a human reading a diff —
  can act on. A skill can declare `tier: any-project` and still name a path;
  only review catches that.
- **`scripts/distribution-check.js` still classifies ten of eleven skills as
  repo-bound**, because its `repoBoundPattern` matches document paths anywhere in
  a skill body and cannot tell "prerequisite" from "background". That note stays
  accurate about the *text* and is now pessimistic about the *behaviour*. Making
  the check `requires`-aware is a change to a file this document does not own.
- **Tier 2 has a producer, and it is not published.** `packages/create-accordo`
  emits a customer's own repository from a checkout of this framework, ships
  **this** bundle into it, and deliberately ships none of the repository's own
  Markdown — which is exactly the assumption this document forbids a skill from
  making, now enforced by the bootstrap's tests rather than only by prose. What
  is still missing is distribution: the npm name is an empty reservation, so
  `npm create accordo` installs nothing. Tier 2 is real, testable and produced;
  it is not yet a supported *product* surface.
- **Gemini gets nothing.** Two harnesses have skill files — Claude Code and
  Codex — and a file written for a third by guessing at its conventions would
  look supported and silently never load
  (`docs/AGENT_HARNESS_COMPATIBILITY.md`).
- **Portability is not authorization.** None of this adds auth, tenancy or RBAC,
  and a skill that runs in a stranger's project runs with that user's full
  authority. `crm app inspect` imports the project's composition, which executes
  it: that is isolation, not a sandbox (`PACKAGE_SOURCE_TRUSTED`).

## Evidence

`.claude/skills/*/SKILL.md` and their `.agents/skills/` mirrors ·
`tests/skill-parity.test.js` (mirror parity, `name`, `description`) ·
`scripts/distribution-check.js` (skill loadability and the repo-bound note) ·
`docs/APPLICATION_INSPECTION.md` and `tests/app-inspect.test.js` (the report a
skill orients from) · `docs/AGENT_HARNESS_COMPATIBILITY.md` (what a harness must
provide) · `examples/starters/b2b-lead-qualification/install.mjs` (the tier-2
project, and the measurement quoted above).
