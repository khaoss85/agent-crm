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

### 11. Orchestrated project verification (DX5)

| | |
|---|---|
| **Technical fact** | One command orchestrates the framework's own authorities — project doctor as a blocking preflight, `app inspect`, the doctor's own verdicts on declared **current and required** Solution Plans, package conformance **executed** for every composed package with local source, and the project's **declared** test and smoke scripts — into a contract-versioned report with a semantic fingerprint that excludes duration and machine layout. It never guesses a command, bounds every child in time and output, settles each step on the child's exit rather than on its streams closing, refuses a nested `project verify` with a stable code instead of recursing, and samples the worktree **before and after** so it can name the paths the run itself changed — which it reports and never repairs. |
| **Evidence** | `npm run crm -- project verify --json`; `projectVerificationContract: 1`; `tests/project-verify.test.js` — including "one non-conforming composed package fails the verification", "every plan verdict is carried verbatim, and named for what it is", "all seven worktree transitions are attributed to the right party" and "a step settles on process exit under every leak shape" |
| **User value** | After a coding agent changes a project, one command produces the evidence a reviewer needs and names which authority refused. |
| **Allowed positioning** | "One command orchestrates the project's evidence and reports which authority refused — including which composed package failed conformance, which declared plan no longer binds, and which paths the verification itself changed." |
| **Do not claim** | that it proves the software works for a business scenario, that a green report means a plan is finished, or that it sandboxes anything. It publishes `BROWSER_EVIDENCE_NOT_AUTOMATED`, `SCENARIO_EVIDENCE_NOT_RUN`, `IMPLEMENTATION_EVIDENCE_NOT_MAPPED` and `PROJECT_COMMANDS_TRUSTED` in its own output. Business-scenario evidence is now a **separate** command (§12) — deliberately so, and re-examined when the second scenario landed: each scenario composes a whole application, so running them from Project Verify would make it silently multi-minute and unbounded in a project with many; **PROVE remains partial** (§13). Also do not present a run against **this repository** as evidence of package conformance: Accordo's default composition is empty by design, so that stage honestly reports `not_applicable` / `NO_PACKAGES_COMPOSED` and nothing is conformance-tested. The stage is demonstrated inside a composed project (`npm run tour -- --keep DIR`) — and today that run **fails**, for two reasons that are the project's, not the command's: `crm package test` re-applies manifests the starter installer has already applied and `module create` refuses to overwrite them (`modules.applied 0/8`), and the generated `package.json` declares `verify` and `smoke` scripts whose `scripts/` directory the installer never copies (`SCRIPT_TARGET_MISSING`). Do not quote a green composed-project run: there is not one yet. |
| **Status** | implemented |

---

### 12. Business-scenario evidence, with its honest negative (DX6)

| | |
|---|---|
| **Technical fact** | A checked-in declarative scenario document names a journey by id from a frozen registry in the runner's own source; the runner executes that journey, inspects the application it composed through AX1, answers observations drawn from a closed vocabulary, and resolves the scenario's claims against `docs/benchmarks/jobs.json`. The report is contract-versioned and byte-identical between runs: no duration, timestamp, temporary path or machine layout enters it at all. The set of JTBD rows the run did **not** establish is a counted, sectioned, fully enumerated field. A scenario can carry no command — no field in the shape could hold one, every string is refused if it looks like one, and there is no code path from a document value to an invocation — and a document with any problem starts nothing. **Two scenarios and two journeys ship**, deliberately unlike each other: a sales funnel on the wall clock over a six-package composition, and a service case → SLA evaluation → escalation story on an injected, stepped clock over a two-package one. Serving the second consumer changed the contract in three places — journey evidence gained stated **facts** beside numeric counts, the report now publishes **which clock** produced the evidence, and limitations gained a **scope** so a journey declares its own rather than every run carrying every disclaimer. |
| **Evidence** | `npm run crm -- scenario run lead-to-won --json`; `npm run crm -- scenario run service-sla-escalation --json`; `scenarioRunContract: 2`; `tests/scenario-document.test.js`, `tests/scenario-run.test.js`; `docs/SCENARIO_EVIDENCE.md`; `docs/plans/dx6-second-scenario.md` |
| **User value** | The question "which business jobs does this checkout actually support?" gets a machine-readable answer with linked evidence, including what the run could not speak to — instead of a 149-row Markdown table read hopefully. |
| **Allowed positioning** | "A business scenario runs against a real composed application, and reports which jobs it earned **and which it did not**." Two scenarios exist, so "the contract has been exercised by a second, materially different business process" is also allowed. |
| **Do not claim** | that it promotes or changes any JTBD status — it writes nothing, and a person decides under `docs/QUALITY_GATES.md` §3. Not that "not established" means unsupported: it means the scenario said nothing about the row. Not that coverage is discovered — it checks the rows a scenario *claims* (`COVERAGE_IS_CLAIMED_NOT_DISCOVERED`). Not that it is evidence about the Admin (`BROWSER_EVIDENCE_NOT_AUTOMATED`), about any other composition (`EVIDENCE_IS_ONE_COMPOSITION`), about a real external provider (`NO_PROVIDER_CONTACTED`), or about production readiness. It is not a sandbox (`JOURNEY_SOURCE_TRUSTED`). **Two** scenarios and two journeys ship today, which is not "broad coverage": five of the 149 rows are claimed by the second one and 144 are reported as not established. Do not claim autonomous goal completion, benchmark superiority or production readiness from either run. The service scenario in particular proves **no** notification, routing, escalation automation, business-hours calendar, RBAC or billing — Service ships without all of them, and the run publishes each as `false` rather than as silence. Its SLA states are elapsed wall-clock minutes, never a contractual or legal determination (`SLA_IS_ELAPSED_TIME_NOT_A_CONTRACTUAL_JUDGEMENT`). **PROVE is stronger and still partial** (§13). |
| **Status** | implemented |

---

### 13. Requirement-level implementation evidence (DX10)

| | |
|---|---|
| **Technical fact** | One command answers, for a checked-in Solution Plan, which of its requirements are proven, partial, blocked, unevidenced, stale or unverified. A **requirement** is a plan step or an acceptance check, addressed by an identifier **derived** from the plan — `step:<stepId>` reuses the id its author wrote, `check:<32 hex>` content-addresses the statement — which adds nothing to `solutionPlanContract: 1` and moves no plan's fingerprint, so every historical plan became addressable with no migration. A checked-in `implementationEvidenceContract: 1` document declares **where to look** and has **no status field anywhere**; its only author-writable shapes are downgrades (`blocked`, `partial`) that each need a reason and can never raise a status. The verifier obtains current facts from authorities that ran in the same invocation — AX1 once, the plan binding derived from that one report, `project verify` at most once and only when something references it, and each explicitly referenced scenario exactly once — and decides. The sufficiency matrix is enforced, not declared: a behavioural requirement needs a **runtime** observation whose kind is read from DX6's report, so `file exists` and `the action is declared` can never satisfy one; and because `solutionPlanContract: 1` cannot type an acceptance check, every one of them is graded at a behavioural floor, so an author's declared category may only ask for more proof and never less. A requirement whose authority did not run is reported as `unverifiable`, never as an author-declared block, and an observation from a scenario that composed a different application is refused outright. |
| **Evidence** | `npm run crm -- solution verify examples/solution-plans/lead-to-won.plan.json --evidence examples/implementation-evidence/lead-to-won.evidence.json --json`; the same for `activate-support-and-manage-cases`; `implementationEvidenceContract: 1`, `solutionVerificationContract: 1`; `tests/implementation-evidence.test.js`, `tests/solution-verify.test.js`; `docs/IMPLEMENTATION_EVIDENCE.md`; `DECISIONS.md` ADR-031 |
| **User value** | "Is this plan finished?" stops being prose an agent writes about its own work and becomes an exit code over evidence an agent cannot fabricate. |
| **Allowed positioning** | "Every requirement in a checked-in plan is mapped to machine-checkable evidence, and the command reports what is still unproven." Also allowed, and stronger: **its first real answer on this repository is that the one plan declared current is not implemented** — `solution check` exits 0 on it, the doctor passes, `project verify` is green, both scenarios pass, and five of its six requirements are blocked, manual or partial. That gap was invisible to every other rung. |
| **Do not claim** | that PROVE is complete, or that any plan here verifies. **Both shipped evidence documents exit 1**, and that is the true state of both plans. Do not claim it writes, executes or completes a plan — it has no write mode, no `--fix` and no generation command, and `promotion.performed` is `false` on every report. Do not claim it proves a test ran: there is deliberately **no `test` evidence kind**, because no authority publishes which tests ran, so a test name would be a claim dressed as a citation. **Manual evidence is never proof** — it resolves to `unverified` and forbids exit 0 on its own (`MANUAL_EVIDENCE_IS_NOT_PROOF`). Do not claim browser, provider, database, deployment or live-system evidence: it publishes `BROWSER_EVIDENCE_NOT_AUTOMATED` and `PRODUCTION_EVIDENCE_ABSENT`. It is not a sandbox (`VERIFICATION_SOURCE_TRUSTED`). It reports the requirements a plan *wrote down* and cannot catch one a plan omitted (`COVERAGE_IS_THE_PLAN_ONLY`). And do not claim autonomous goal completion: nothing here authors a plan, and nothing here says an agent finished anything by itself. |
| **Status** | implemented; **PROVE stays partial** |

---

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
| **SEE** | App Inspect | implemented | `accordo app inspect --json` |
| **PLAN** | Solution Plan | implemented | `accordo solution check --json` |
| **BUILD** | Package Scaffold + the coding agent | implemented | `crm package scaffold` |
| **CHECK** | Project Doctor + Package Conformance | implemented | `accordo project doctor --json`, `crm package test --json` |
| **PROVE** | Quality Gates, Project Verify (DX5), Scenario Evidence (DX6, two consumers) and Implementation Evidence (DX10, two plan consumers) | **partial** | `docs/QUALITY_GATES.md`; `accordo project verify --json`; `accordo scenario run lead-to-won --json` and `accordo scenario run service-sla-escalation --json`; `accordo solution verify <plan.json> --evidence <evidence.json> --json`. A plan's requirements are now mapped to machine-checkable evidence, and **partial is still the honest word**: no checked-in plan exits 0, a manual requirement stays unverified whatever else passes, coverage is *claimed* rather than discovered, and no browser, provider, deployment or live system is observed anywhere |
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
