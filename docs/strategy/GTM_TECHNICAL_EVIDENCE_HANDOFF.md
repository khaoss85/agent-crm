# GTM technical evidence handoff

**This is not marketing copy, and it does not replace the GTM claims ledger.**

It is the engineering side of the wall: for each technical fact, what proves it,
what a user gets from it, what may be said about it, and what must not be said.
The GTM track may consume this later. Nothing here modifies GTM assets, and
nothing here is a launch decision.

Every row's **Status** is one of `implemented`, `partial` or `planned`, and the
Evidence column is a command or a test somebody can run. A row with no runnable
evidence does not belong in this document.

---

## Implemented — evidence-backed today

### 1. Deterministic application discovery

| | |
|---|---|
| **Technical fact** | An application's composition — packages, capability edges, resources, actions, policies, providers, modules — is reported as a contract-versioned JSON document, produced without opening a database, in an isolated child process. |
| **Evidence** | `npm run crm -- app inspect --json`; `applicationInspectionContract: 1`; `inspectionFingerprint`; `tests/app-inspect*.test.js` |
| **User value** | A coding agent can find out what a project already is before proposing to change it, instead of guessing from file names. |
| **Allowed positioning** | "Agents can discover an application's real structure deterministically, before they change it." |
| **Do not claim** | that it verifies behaviour, reads a database, or proves the application works. |
| **Status** | implemented |

### 2. Machine-readable Solution Plan validation

| | |
|---|---|
| **Technical fact** | A plan is a contract-versioned document that can be validated standalone and *bound* to a specific application inspection; a plan written against a composition that has since moved reports `PLAN_STALE`. |
| **Evidence** | `npm run crm -- solution validate\|check <plan.json> --json`; `solutionPlanContract: 1`; `examples/solution-plans/` |
| **User value** | The gap between "the plan an agent wrote" and "the application it will run against" becomes a checkable fact, not a hope. |
| **Allowed positioning** | "Plans are machine-checkable against the real application, and go stale visibly." |
| **Do not claim** | that plans are executed, or that a valid plan means the work was done. Nothing executes a plan. |
| **Status** | implemented |

### 3. Source-level project diagnostics

| | |
|---|---|
| **Technical fact** | Composition health, package source boundaries, module state and migration drift, Solution Plan currency, Skill mirror agreement, repository-relative documentation links and forbidden tracked artifacts are reported read-only in well under a second on this repository, each finding naming the existing authority that refuses it. |
| **Evidence** | `npm run crm -- project doctor --json`; `projectDoctorContract: 1`; `tests/project-doctor.test.js` |
| **User value** | An agent arriving at an unfamiliar checkout learns what is already broken before it edits anything, without paying for a full verification run — sub-second against minutes. |
| **Allowed positioning** | "A fast, read-only structural health check an agent can afford to run before every change." |
| **Do not claim** | that it replaces tests, checks a database, checks provider health, or assesses production readiness. It states all four limits in its own output. |
| **Status** | implemented |

### 4. Deterministic package scaffolding

| | |
|---|---|
| **Technical fact** | `crm package scaffold <name>` produces two files — an identity and five empty declarations — whose output passes validate, inspect and conformance with no manual edit. Dry-run by default; never overwrites; refuses an invalid name with a suggestion instead of renaming. |
| **Evidence** | `npm run crm -- package scaffold <name> --json`; `packageScaffoldContract: 1`; `tests/package-scaffold.test.js` |
| **User value** | A new domain starts from a known-good baseline instead of a copy of somebody else's domain that has to be subtracted. |
| **Allowed positioning** | "New domains start conforming, not hoping to conform." |
| **Do not claim** | that it generates a working domain. It deliberately generates **no** business capability. |
| **Status** | implemented |

### 5. Generic package conformance

| | |
|---|---|
| **Technical fact** | Any package is composed into a throwaway copy of the project and booted twice — with and without it — and checked against the framework's own authorities. No package is special-cased by name. |
| **Evidence** | `npm run crm -- package test <path> --json`; `packageConformanceContract: 1`; `tests/package-test-command.test.js`. The official matrix currently records `partner-scorecard` as **non-conforming**, recorded rather than patched. |
| **User value** | "Does this package satisfy the framework?" is a mechanical answer with a stable document, not a reviewer's judgement. |
| **Allowed positioning** | "Package conformance is mechanical, generic and honest about what it does not prove." |
| **Do not claim** | that conformance means correctness. The report says `DOMAIN_CORRECTNESS_NOT_PROVEN` itself. |
| **Status** | implemented |

### 6. Legacy behaviour characterization

| | |
|---|---|
| **Technical fact** | One legacy domain's externally observable behaviour is frozen as 151 classified observations / 822 individually asserted values, with 16 mutation probes proving the comparison can fail — including one that catches a score keeping its number under a different definition fingerprint. |
| **Evidence** | `npm run characterize:intelligence`; `legacyCharacterizationContract: 1`; `tests/characterization/` |
| **User value** | A risky refactor can be proved to change no observable behaviour, instead of argued about. |
| **Allowed positioning** | "Behaviour-preserving refactors can be proved from the outside, before they start." |
| **Do not claim** | that every legacy domain is characterized — **one** is. Commercial Operations and Signature & Order are not. Do not claim any extraction has happened; none has. |
| **Status** | implemented, for one domain |

### 7. Optional package-native domains

| | |
|---|---|
| **Technical fact** | A domain package is checked-in source registered by one static import; deleting that import removes the whole domain and the application still boots. Three first-party packages and one customer-authored example use the same contract. |
| **Evidence** | `packages/domains/generated/index.js`; ADR-018 and addenda; `docs/PACKAGE_AUTHORING.md`; the detach/reattach checks in `crm package test` |
| **User value** | Domains are opt-in and removable, and a customer's own package is not second-class. |
| **Allowed positioning** | "Domains are optional, removable, and authored through the same contract first-party ones use." |
| **Do not claim** | a marketplace, a registry, remote install, publication, signing, hot loading or auto-update. None exist. |
| **Status** | implemented |

### 8. Fail-closed capability graph

| | |
|---|---|
| **Technical fact** | A package reaches another only through a declared, versioned capability. A missing package, an undeclared reach, a version mismatch or a dependency cycle stops the application at startup with the offending edge named — never at runtime inside a transaction. |
| **Evidence** | `packages/core/src/package-registry.js`, `package-composition.js`; the refusal checks in `crm package test`; `tests/package-contract.test.js` |
| **User value** | Cross-domain coupling is visible and enforced, so an agent cannot quietly create a hidden dependency. |
| **Allowed positioning** | "Cross-domain dependencies are declared and fail closed at startup." |
| **Do not claim** | that it sandboxes anything. Checked-in source is trusted and runs with the operator's authority; the docs say so explicitly. |
| **Status** | implemented |

### 9. Audit, trace and evidence records

| | |
|---|---|
| **Technical fact** | Every mutation records audit and trace within the transaction that made it, and domain decisions persist evidence records — versioned policies, declared-definition fingerprints, target-set evidence, contribution breakdowns. |
| **Evidence** | ADR-011, ADR-012, ADR-015; `crm trace:list`; the exact audit-count assertions across the suites |
| **User value** | A past decision can be explained later with the inputs and the policy version that produced it. |
| **Allowed positioning** | "Decisions are explainable after the fact, with the versioned policy that made them." |
| **Do not claim** | regulatory compliance, tamper-proof audit, or immutability guarantees beyond what the schema enforces. |
| **Status** | implemented |

### 10. Human approval boundaries

| | |
|---|---|
| **Technical fact** | Specific decisions require `actor.type === 'user'` and are refused for a system or agent actor; approval thresholds are deterministic policy, and an AI recommendation cannot silently override them. |
| **Evidence** | the approval workflow tests, including "approval workflow rejects an agent pretending to make the human decision" |
| **User value** | The commercially consequential steps stay with a person. |
| **Allowed positioning** | "Consequential decisions are gated on a human actor by construction." |
| **Do not claim** | authentication, authorization, RBAC, tenancy or identity verification. **None exist** — actor headers are not authentication, and the HTTP server is local-development-only. |
| **Status** | implemented, within a local-development trust model |

---

### 11. Orchestrated project verification

| | |
|---|---|
| **Technical fact** | One command orchestrates the framework's own authorities — project doctor as a blocking preflight, `app inspect`, declared-current Solution Plans, package conformance for composed packages, and the project's **declared** test and smoke scripts — into a contract-versioned report with a semantic fingerprint that excludes duration and machine layout. It never guesses a command, bounds every child in time and output, and reports a worktree that changed rather than repairing it. |
| **Evidence** | `npm run crm -- project verify --json`; `projectVerificationContract: 1`; `tests/project-verify.test.js` |
| **User value** | After a coding agent changes a project, one command produces the evidence a reviewer needs and names which authority refused. |
| **Allowed positioning** | "One command orchestrates the project's evidence and reports which authority refused." |
| **Do not claim** | that it proves the software works for a business scenario, that a green report means a plan is finished, or that it sandboxes anything. It publishes `BROWSER_EVIDENCE_NOT_AUTOMATED`, `SCENARIO_EVIDENCE_NOT_RUN`, `IMPLEMENTATION_EVIDENCE_NOT_MAPPED` and `PROJECT_COMMANDS_TRUSTED` in its own output. **PROVE remains partial** until DX6 and DX10 exist. |
| **Status** | implemented |

### 12. Deterministic project bootstrap — **source only, never the registry**

| | |
|---|---|
| **Technical fact** | `create-accordo <dir> --apply` copies the framework into an empty directory and writes a standalone project that needs no install, boots on SQLite, reports `valid` from `app inspect --json` and exits 0 from `project doctor --json`. It reaches no network, composes no domain package, opens no database and imports no part of the framework — it is the one command that must run before the framework exists on disk. Dry-run by default; it refuses a non-empty target, a target overlapping the framework source, and an invalid project name, the last with a suggestion it never applies. |
| **Evidence** | `node packages/create-accordo/bin/create-accordo.js <dir> --apply --json`; `projectBootstrapContract: 1`; `tests/project-bootstrap.test.js`, which bootstraps into a temporary directory and then runs `app inspect`, `project doctor` and the generated project's own checks against the result |
| **User value** | "Give me a project built on this framework" becomes one deterministic offline step whose output is machine-checked, instead of a copy of a source tree and a guess at a `package.json`. |
| **Allowed positioning** | "A project can be created from nothing, offline and deterministically, and the result is verified rather than assumed — **from a checkout of the repository**." |
| **Do not claim** | **that `npm create accordo` works.** The published `create-accordo@0.0.1` is an empty name reservation and the registry state is unchanged by a locally verified publication candidate. "create-accordo scaffolds a working project from this repository" and "the assembled candidate packs and installs offline" are true; "`npm create accordo` creates a project" stays false until a human-approved staged publish has a live registry receipt. Do not claim the generated project is production-ready, deployable, or upgradeable by a version bump, or that it models any business: the command publishes `NO_AUTHENTICATION`, `NO_TENANCY`, `NO_RBAC`, `SQLITE_ONLY`, `LOCAL_DEVELOPMENT_ONLY`, `SOURCE_IS_A_COPY_NOT_A_DEPENDENCY`, `CONFORMANCE_IS_NOT_CORRECTNESS` and `SOURCE_ORIGIN_NOT_VERIFIED` in its own output. |
| **Status** | implemented and deterministically packaged; **not published** |

## Planned only — must never be positioned as available

| Capability | Status | Note |
|---|---|---|
| Context Pack (DX9) | planned | not built |
| Implementation Evidence (DX10) | planned | not built |
| Project Verify (DX5) | planned | not built |
| Scenario Runner (DX6) | planned | not built |
| Skill mirror sync (DX2) | planned | detection exists (diverging copies fail, one-sided skills warn); automatic reconciliation is not built |
| Full legacy alignment | planned | one domain characterized, **zero** extracted |
| Cloud | planned | no auth, tenancy, RBAC or production spine exists |
| MCP tool parity (DX13) | planned | policy written, tools not built |
| Marketing runtime, Analytics Studio | planned | documentation only |

---

## The agent story, with status

The one shape GTM may use to describe what the framework does, with each stage's
honest state. **A stage marked partial must be described as partial.**

| Stage | Rail | State | Evidence |
|---|---|---|---|
| **SEE** | App Inspect | implemented | `crm app inspect --json` |
| **PLAN** | Solution Plan | implemented | `crm solution check --json` |
| **BUILD** | Package Scaffold + the coding agent | implemented | `crm package scaffold` |
| **CHECK** | Project Doctor + Package Conformance | implemented | `crm project doctor --json`, `crm package test --json` |
| **PROVE** | Quality Gates and Project Verify (DX5); Scenario Runner (DX6) and Implementation Evidence (DX10) still to come | **partial** | `docs/QUALITY_GATES.md`; `crm project verify --json`; DX6/DX10 **not built** |
| **PRESERVE** | LA0 Characterization | implemented | `npm run characterize:intelligence` |

Allowed positioning line:

> Accordo gives coding agents a way to see, plan, build, check and prove —
> instead of just generating code.

**Do not claim** that this is a workflow a user follows, or that PROVE is
complete. The rails are internal; a user states a goal. A worked example of the
whole story on one real refactor:
`docs/evidence/lead-intelligence-extraction.md`.

**Category note.** "CRM" is recorded as too narrow for the long-term
architecture, and two broader framings are being explored. **No public rename or
tagline change is authorized here** — see
`docs/strategy/CUSTOMER_REVENUE_OS_ROADMAP.md`.

**Competitor context.** AI-friendly docs, MCP servers, app scaffolding and
coding-agent guidance look like **table stakes** rather than differentiation.
That is a **strategy hypothesis supported by a bounded review** of four vendors'
published material on 2026-08-08 — not an exhaustive audit, and two of the four
were search-summary sourced because their docs hosts were unreachable. Treat it
as a planning assumption to re-test, never as a stated fact about the market.
Differentiation claims must rest on goal-first orchestration, deterministic
discovery and planning, architectural constraints that refuse, machine-readable
evidence, behavioural characterization, package conformance and approval
boundaries. **No parity or superiority claim against any named vendor.**

## The allowed thesis

Evidence-based, and the strongest form currently supportable:

> **Accordo is designed to make coding agents more reliable at building CRM
> solutions by constraining architecture, exposing deterministic contracts, and
> proving work rather than relying on agent self-report.**

Every clause maps to a row above: *constraining architecture* → 7 and 8;
*deterministic contracts* → 1, 2, 4, 5; *proving work* → 3, 5, 6, 9.

## Claims that are prohibited without separate proof

- "the best framework for coding agents" — no comparative benchmark exists
- "zero hallucinations" — unprovable and false in form
- "fully autonomous CRM generation" — a human approves, and the loop is not built
- "works with every model" — portability is a design target with **no**
  cross-model benchmark run
- benchmark superiority of any kind — `CRM_BUILD_BENCHMARK.md` is a design
  document, not results
- production-ready or cloud-ready — there is no auth, tenancy or RBAC
- marketplace availability — no registry, no publication, no remote install
- **that anything installs from npm** — `accordo@0.0.1` and `create-accordo@0.0.1`
  are empty name reservations. The project bootstrap is real *source* and is
  proven by a test; `npm create accordo` still installs nothing, and the two
  facts must never be merged into one sentence

If one of these becomes true, it becomes a new row in this table with a command
next to it, and only then may it be said.

## Related

`docs/strategy/CODING_AGENT_DX_NORTH_STAR.md` · `docs/QUALITY_GATES.md` ·
`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` ·
`docs/architecture/EXTRACTION_PREPARATION.md` · `DECISIONS.md`

Brand and naming are a human decision and are recorded on the GTM track. This
document deliberately does not restate them.
