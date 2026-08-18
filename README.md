# Accordo

> **Describe your sales process to your coding agent; own the CRM it builds.**

An open-source framework that Claude Code, Codex and Gemini CLI use to generate a CRM
application as code you own — deterministic workflows, policy-gated human approvals,
audit and trace built in.

The name is chosen and the domain registered. The npm names hold empty `0.0.1`
placeholders, while the real package and the `@accordo` scope remain unpublished; no
trademark screen has been run. The project is **pre-launch** and is not deployable to
production. What that means precisely is in [Where it stops](#where-it-stops), which is
worth reading before the rest.

```text
Business request
      ↓  "Renewals of €50,000 or more need a manager's sign-off."
Claude Code / Codex
      ↓  reads AGENTS.md · 12 skills · MCP · `crm app inspect`
Modules + deterministic workflows + versioned policy
      ↓
API + Admin + trace + audit — in your repository, as code you review
```

---

## When to reach for Accordo

- **Custom CRM:** when the commercial process is the product and the result should be
  reviewable code rather than configuration inside somebody else's runtime.
- **[Customer Hub](https://accordo.dev/concepts/customer-hub.html):** when “hub” means one
  local commercial record chain with governed actions. Accordo does not ingest sources or
  resolve customer identities like a CDP.
- **[Smart CRM](https://accordo.dev/concepts/smart-crm.html):** when a coding agent should
  compose the application while versioned policy and named humans retain business decisions.
  It is agent-built software, not an autonomous decision-maker.
- **[CDP + CRM](https://accordo.dev/concepts/cdp-plus-crm.html):** when an external CDP owns
  ingestion, identity resolution and audiences, and Accordo owns the deterministic CRM
  process layer beside it. Accordo ships no CDP, connector, importer or sync runtime.

Those adjacent terms are retrieval paths, not extra capability claims. The checked
[recommendation map](docs/strategy/RECOMMENDATION_MAP.md) binds each one to what the
framework proves and where it stops.

---

## Why this exists

Every CRM eventually asks you to bend your process to fit its model. The two usual escapes
both cost something:

- **Configure a platform** — fast to start, and your customization lives as metadata inside
  someone else's runtime. When the ceiling arrives, you fork a monorepo.
- **Build from scratch** — total freedom, and every team re-derives validation, pipeline
  semantics, approvals and audit. Usually late, usually under pressure.

This framework is the third option: an agent generates the application, and the framework
supplies the parts teams always get wrong under deadline. The test any developer can apply
is *"if this project disappears tomorrow, what am I left with?"* Here the answer is: a Node
application in your repository, with no third-party runtime dependencies and a SQLite file
any client can open.

## What is proven

Each line below is bound to a merged test. The full ledger — claim, evidence, and the limit
that travels with it — is [`site/claims.json`](site/claims.json), and the review discipline
behind it is [`docs/QUALITY_GATES.md`](docs/QUALITY_GATES.md).

| Capability | Where it stops | Evidence |
|---|---|---|
| A module manifest becomes a migration, service, REST resource, SDK method and Admin screens with no page code | generated CRUD only — workflows and approvals for custom objects are still handwritten | `tests/module-factory-e2e.test.js`, `tests/generated-api-e2e.test.js`, `tests/admin-modules.test.js` |
| Generated objects reference each other: foreign key, runtime target validation, Admin selector | generated-to-generated many-to-one only; no many-to-many, inverse collections or cascade | `tests/reference-fields-e2e.test.js` |
| Deterministic approval policy: a renewal at or above the threshold waits for a named human | the built-in renewal object and one value threshold | `tests/workflow.test.js`, `tests/api.test.js` |
| **An agent cannot make the human's approval decision** — asserted by a test, not by a convention | the actor is asserted, not authenticated; this holds against an honest agent, not an attacker | `tests/workflow.test.js` |
| Opportunities move through code-first pipeline stages under a server-authoritative action — the client asks, the server decides | proven on the built-in Opportunity module; configurable pipelines for generated custom objects are not claimed | `tests/opportunity-pipeline-e2e.test.js`, `tests/pipeline-contract.test.js` |
| Lead capture, enrichment, explainable versioned scoring, deterministic routing, qualification, conversion | enrichment runs against a fixture provider; no real data source is wired | `tests/lead-intelligence-e2e.test.js`, `tests/lead-conversion-e2e.test.js` |
| Server-priced composite quotes, immutable quote versions, versioned discount policy with approval | fixture catalog provider; integer cents with no FX — currencies are never summed | `tests/commercial-e2e.test.js` |
| Signature envelope → verified events → signed-artifact evidence → exactly one immutable Order | fixture signature provider, test-only webhook key, provider-reported artifact hash | `tests/signature-order-e2e.test.js` |
| Order activation into Contract, immutable version, Subscription and pending obligations | nothing bills, renews, amends or cancels; there is no scheduler | `tests/contracts-activation-e2e.test.js` |
| Delivery handover into a project with work packages, milestones and an optional partner; human-driven execution | nothing schedules, staffs, accepts or bills; deliverables do not exist as objects | `tests/delivery-handover-e2e.test.js`, `tests/delivery-execution-e2e.test.js` |
| Append-only time and expense evidence, costed by a versioned policy, with a reproducible contribution estimate | deliberately not a margin: no revenue recognition, no COGS, no ARR/MRR, no FX | `tests/delivery-economics-e2e.test.js` |
| A customer-authored domain package attaches and detaches with the kernel fingerprint unchanged | the scaffold that starts one writes an empty package and nothing else; no registry, no publication, no sandboxing — package code runs with the host's authority | `tests/package-contract.test.js`, `tests/custom-package-e2e.test.js` |
| `accordo package scaffold <name>` — a minimal, empty, conforming local package, written atomically, dry-run by default | it invents no business logic, composes nothing, verifies no global identity uniqueness and installs or publishes nothing | `tests/package-scaffold.test.js`, `tests/package-test-command.test.js` |
| `crm app inspect` — one deterministic, source-only JSON report of what an application contains | never opens the database, contacts a provider or reads a secret — and says so in its own output | `tests/app-inspect.test.js` |
| `crm solution check` — a Solution Plan is a checked-in contract with a canonical fingerprint | a document contract, not a planner and not a runtime; nothing executes a plan | `tests/solution-plan.test.js` |
| `crm scenario run` — two checked-in business scenarios run against real composed applications and report which JTBD rows they earned **and which they did not** | coverage is claimed by a scenario rather than discovered; it promotes no row, drives no browser, and each run speaks for one composition | `tests/scenario-run.test.js` |
| Generated modules evolve through explicit revisions and append-only named migrations | source-only: what a particular database applied is not knowable from here | `tests/module-evolution.test.js` |

**The whole suite runs on every push**, together with the smoke test. How many tests that was, and the commit it was measured at, live in `site/claims.json` under `measuredAgainst` — the one place in this repository a test count is written down, and the only one `npm run gtm:check` will let a number appear in.

## Run it

Node.js 22.16 or newer. There are no third-party runtime dependencies and no build step.

```bash
npm run tour     # compose the whole application and inspect it
npm run verify   # source checks, then the whole test suite
npm run falsify  # break five rules on purpose and watch the suite catch them
npm run demo     # the approval slice, end to end
npm run dev      # http://localhost:4000
```

`npm run tour` is the fastest way to see what this actually is. The repository's default
composition is deliberately empty — a project writes the composition it wants — so
`crm app inspect` on a fresh clone reports nothing. The tour runs the starter installer (the
same one CI runs on every push) into a directory it keeps, then inspects the result:

```text
  modules       71        resources     43        policies       7
  packages       7        actions       59        providers      5

  production posture — local development only: no authentication, tenancy or RBAC
                       exists, and actor headers are not identity
```

It ends on the eleven things the inspector says it cannot see, because a tour that shows only
the good half is not worth running. `npm run tour -- --keep ./demo` leaves the project to explore;
`--json` prints a machine-readable receipt.

`npm run falsify` is the other direction. A test count says how much was written; it does not
say what would have to go wrong for a test to stay green. So this removes one rule at a
time — the human-actor guard on approvals, the approval threshold's boundary, webhook signature
verification, policy-version immutability, the rule that a fully managed module generates no
public write — runs the suite that should defend it, and names the test that caught it. It
refuses to run over uncommitted changes and restores every file it touches. Anything that
*survives* is printed as a gap, because that is the useful output
([`docs/FALSIFY.md`](docs/FALSIFY.md), `tests/falsify.test.js`).

`npm run demo` creates two renewals and is asserted by `scripts/smoke.js` on every push:

- €20,000 → moves directly to Proposal.
- €80,000 → stops in Approval Pending until a manager decides.

## Use it from a coding agent

Claude Code reads `CLAUDE.md`, `.mcp.json` and `.claude/skills/`. Codex reads `AGENTS.md`
and `.codex/config.toml`. Both are checked in and wired together.

```text
Read AGENTS.md, PRODUCT.md and docs/PROJECT_STATUS.md.
Run npm run crm -- app inspect --json.
Tell me which parts of my commercial process this already supports, and which it does not.
```

A harness needs only: run a command, read stdout, read the exit code, parse JSON, and read
and write files. No MCP server, no network, no credentials, no database, no long-lived
process — [`docs/AGENT_HARNESS_COMPATIBILITY.md`](docs/AGENT_HARNESS_COMPATIBILITY.md).

```bash
npm run crm -- app inspect --json          # what this application contains
npm run crm -- solution check plan.json    # is this plan still valid against it
```

Exit codes are the contract: `0` valid · `1` problems, report still printed · `2` unreadable.

The MCP server runs over stdio (`node --no-warnings packages/mcp/bin/server.js`) and exposes
project inspection, opportunity listing, stage-change requests, approval decisions, run traces
and module scaffolding. Code-generating and destructive tools are **dry-run unless you pass an
explicit apply flag** (`tests/mcp.test.js`, `tests/scaffold.test.js` — [`docs/MCP.md`](docs/MCP.md)).
It is stdio-only and local-only: there is no hosted or authenticated MCP endpoint, and the server
inherits the authority of the process that starts it.

## Where it stops

Read this before evaluating anything above. `docs/benchmarks/CRM_JTBD_MATRIX.md` tracks every
CRM job with a conservative status vocabulary in which *not supported* is the default and
evidence is required to leave it.

- **No authentication, tenancy or RBAC.** The server is local-development-only; an actor
  header is an assertion, not an identity. Do not expose it to a network.
- **SQLite only.** PostgreSQL is on the Production Spine track and is not implemented.
- **The build benchmark has not been run.** No Successful Agent Build Rate exists. Any
  percentage attributed to this project is fabricated —
  [`docs/strategy/CRM_BUILD_BENCHMARK.md`](docs/strategy/CRM_BUILD_BENCHMARK.md) is the
  protocol, not a result.
- **No scheduler, no reminders, nothing on a timer.** Follow-up Tasks and an Activity
  timeline exist as one shared model (`docs/WORK_TASKS.md`) and a person moves every one of
  them: a due date changes no state, nothing recurring exists, nothing is assigned or
  notified, and renewal notice periods are recorded and never fire.
- **No email, calendar or marketing integrations.** A notification provider contract exists;
  no adapter sends anything to anyone.
- **No import, export, dedupe, merge, bulk edit, saved views or global search.** Table stakes
  in every commercial CRM, and none of them has a milestone yet.
- **You cannot put real customer data in this yet.** No authentication, no tenancy, no export
  and no erasure path — so a data-subject access or deletion request cannot be serviced with it.
  `docs/strategy/DATA_GOVERNANCE.md` is design-only. The one thing that does hold: lead scoring is
  deterministic, versioned and explainable, not a model's judgement about a person.
- **This is a framework, not a product you sign up for.** There is no hosted CRM, no free
  tier, no account. The output is an application you run.
- **Ownership today means copying source, not installing a dependency.** There is now a project
  bootstrap: `node packages/create-accordo/bin/create-accordo.js <dir> --apply` copies the
  framework into an empty directory and writes a project that boots, reports `valid` from
  `app inspect` and exits 0 from `project doctor` — no install, no network
  (`tests/project-bootstrap.test.js`). **It runs from a checkout of this repository.** The
  `create-accordo` package on the npm registry is still the empty `0.0.1` name reservation, so
  `npm create accordo` installs nothing and will go on installing nothing until a human publishes.
  Either way the framework is vendored into the project, so you own the result outright — and
  upgrading means merging, not bumping a version.

## Architecture in five folders

```text
packages/core/        the runtime platform: registry, services, workflow engine, audit
packages/modules/     CRM domain primitives
packages/domains/     optional domain packages (contracts, delivery) on a public contract
packages/mcp/         tools and context exposed to coding agents
apps/                 API server and generated Admin
```

The agent never writes to a database table. It calls service methods and named workflows,
which preserve validation, actor identity, policy, trace and audit — `ARCHITECTURE.md`.

## Documents

| Read this | For |
|---|---|
| [`AGENTS.md`](AGENTS.md) | the rules an agent must follow before changing code |
| [`PRODUCT.md`](PRODUCT.md) | what the product is and is not |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | the technical model and its extension rules |
| [`DECISIONS.md`](DECISIONS.md) | the decision log, ADR-001 … ADR-020 |
| [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) | what is true in the repository today |
| [`docs/benchmarks/CRM_JTBD_MATRIX.md`](docs/benchmarks/CRM_JTBD_MATRIX.md) | every CRM job, its status and its evidence |
| [`docs/QUALITY_GATES.md`](docs/QUALITY_GATES.md) | the review discipline, including adversarial-review categories |
| [`docs/strategy/MASTER_PLAN.md`](docs/strategy/MASTER_PLAN.md) | category, positioning, roadmap, metrics |
| [`docs/strategy/GO_TO_MARKET.md`](docs/strategy/GO_TO_MARKET.md) | how this reaches people, and what is gated on a human |

## Licence

MIT, confirmed by ADR-023.
