# GTM technical evidence handoff

Reconciled 2026-09-07 against framework source and executable authorities. This
is the engineering input to `../../site/claims.json`, not a second measurement
ledger. Current implementation authority is `../repository-truth.json` and
`../PROJECT_STATUS.md`; do not infer npm contents or private runtime validation
from repository tests. `DISTRIBUTION_SUBMISSIONS.md` records the installed-version
boundary and dated public receipts.

## Capabilities and the boundary beside each

| Capability | Runnable/source evidence | Permitted meaning and limitation |
|---|---|---|
| Discover composition | `npm run crm -- app inspect --json`, `tests/app-inspect.test.js` | Deterministic source-only structure, not database state, authorization or health. Default empty composition and an explicitly composed application are different inputs |
| Validate a plan | `npm run crm -- solution check <plan.json> --json`, `../SOLUTION_PLAN.md` | Binds intent to inspected composition and detects staleness; valid does not mean implemented |
| Scaffold and check a package | `npm run crm -- package scaffold <name> --json`, `npm run crm -- package test <path> --json`, `tests/package-scaffold.test.js`, `tests/package-test-command.test.js` | Dry-run skeleton and executable conformance; no invented business semantics or proof of domain correctness |
| Diagnose and verify a project | `npm run crm -- project doctor --json`, `npm run crm -- project verify --json` | Structural diagnostics and orchestrated declared checks; no implicit browser or deployment evidence |
| Prove a named journey / plan requirements | `npm run crm -- scenario run lead-to-won --json`, `npm run crm -- solution verify <plan.json> --evidence <evidence.json> --json`, `../SCENARIO_EVIDENCE.md` | Evidence for the named composition and declared requirements; manual, blocked and unverified requirements remain explicit. No autonomous completion or broad coverage claim |
| Preserve behaviour through extraction | `npm run characterize:intelligence`, `tests/characterization/`, `tests/intelligence-package-absence.test.js`, `tests/commercial-package-absence.test.js`, `tests/signature-package-absence.test.js`, `tests/work-package-absence.test.js` | Characterization and package absence tests demonstrate their named boundaries; do not say all legacy domains are characterized or none has been extracted |
| Optional domains and fail-closed capability graph | `tests/package-contract.test.js`, `tests/custom-package-e2e.test.js`, `../PACKAGE_AUTHORING.md` | Trusted checked-in packages declare dependencies and can be detached; no remote package marketplace, signing, hot loading or auto-update |
| Human approval and authorization | `tests/workflow.test.js`, `tests/commercial-e2e.test.js`, `tests/spine-route-authorization.test.js`, `packages/core/src/authorization.js` | Human-only decisions, RBAC and instance tenant isolation are enforced. Authentication is supplied by the deployment verifier; an asserted local actor is not authenticated. A discount headline cites the commercial approval refusal, not the renewal test |
| SQLite and PostgreSQL | `tests/spine-v2-m3c-postgresql-application.test.js`, ADR-001 addendum | `createAccordoApp()` is synchronous SQLite; `createAccordoAppAsync()` composes dedicated-database PostgreSQL. One tenant per application instance, no shared-row tenancy; driver dependency is required for the PostgreSQL path |
| Durable jobs, transactional outbox, timers | `tests/spine-v3a-durable-jobs-postgresql.test.js`, `tests/spine-v3b-transactional-outbox-postgresql.test.js`, `tests/spine-v3c-timer-consumers-postgresql.test.js` | Bounded self-host contracts; the application explicitly starts its worker. A timer opens a request and cannot approve a commercial decision. No general managed worker service or automatic renewal guarantee |
| Self-host production operations | `tests/spine-integration-production-operations.test.js`, `tests/spine-v4b-backup-restore-postgresql.test.js`, `tests/spine-v4c-observability-export-postgresql.test.js` | Explicit operation composition, secret-provider interface, PostgreSQL backup/verify/restore and telemetry export. No managed custody, retention schedule or observability backend |
| Customer Data Foundation | `tests/customer-data-foundation.test.js`, `tests/customer-data-complete-reads.test.js`, `packages/customer-data/src/index.js` | Bounded preview/apply imports with receipts and idempotency, deterministic duplicate candidates and human-governed canonical links. No full CDP, physical record merge, general bulk operations, complete export/erasure or compliance guarantee |
| Governed lifecycle amendments | `tests/lifecycle-amendment-execution.test.js`, `tests/lifecycle-amendment-execution-e2e.test.js`, `packages/lifecycle/src/amendment.js` | Governed amendment execution and a commercial successor; no automatic renewals, billing, payment collection or implied notifications |
| Audit and trace | `tests/commercial-e2e.test.js`, `tests/workflow.test.js`, ADR-011/012/015 | Named decisions retain evidence, actor and policy context; no regulatory compliance or tamper-proof audit claim |
| Project bootstrap | `tests/project-bootstrap.test.js`, `tests/create-accordo-package.test.js` | CLI and packed payload can scaffold vendored source. npm `create-accordo@0.1.0` is published; current source capabilities require a verified current release. Ownership is a source copy, not a library dependency upgrade |

<!-- truth: rail.app_inspect.implemented=implemented -->
<!-- truth: rail.solution_check.implemented=implemented -->
<!-- truth: rail.package_scaffold.implemented=implemented -->
<!-- truth: rail.package_test.implemented=implemented -->
<!-- truth: rail.project_doctor.implemented=implemented -->
<!-- truth: rail.project_verify.implemented=implemented -->
<!-- truth: rail.scenario_run.implemented=implemented -->
<!-- truth: rail.solution_verify.implemented=implemented -->
<!-- truth: domain.intelligence.package_native=package_native -->
<!-- truth: domain.commercial.package_native=package_native -->
<!-- truth: domain.signature.package_native=package_native -->
<!-- truth: domain.work.package_native=package_native -->
<!-- truth: domain.customer_data.package_native=package_native -->
<!-- truth: domain.lifecycle.package_native=package_native -->
<!-- truth: spine.authorization.enforced=enforced -->
<!-- truth: spine.authentication.framework_verifier=absent -->
<!-- truth: spine.tenant.isolation.mode=one_tenant_per_instance -->
<!-- truth: spine.postgresql.implemented=implemented -->
<!-- truth: spine.durable_job_store.implemented=implemented -->
<!-- truth: spine.transactional_outbox.implemented=implemented -->
<!-- truth: spine.timer_consumers.implemented=implemented -->
<!-- truth: spine.managed_jobs_service.implemented=absent -->
<!-- truth: spine.production_operations.implemented=implemented -->
<!-- truth: spine.secret_provider.implemented=implemented -->
<!-- truth: spine.backup_restore.implemented=implemented -->
<!-- truth: spine.observability_export.implemented=implemented -->
<!-- truth: cdf.full_cdp.implemented=absent -->
<!-- truth: billing.implemented=absent -->

## Keep proof types separate

The agent story is **see, plan, build, check and prove**. These are internal
choices made for a user's goal, not a checklist the user must learn. Evidence is
bounded to its actual composition and authority; PROVE remains partial wherever
requirements depend on manual review, browsers, real providers or live deployment.

The observation-only tool-selection panels under `../../benchmarks/tool-selection/`
measure command selection, not CRM build success. Public copy may describe their
method and limitations; no comparison, ranking or build-rate figure follows.
`CRM_BUILD_BENCHMARK.md` and `../benchmarks/PILOT_PROTOCOL.md` define a separate
instrument whose result must come from real sessions. Build rate is unmeasured.
<!-- truth: benchmark.tool_selection.comparative=false -->
<!-- truth: benchmark.build_rate.measured=not_measured -->

## Public/private and planned boundaries

This public repository supplies self-host framework contracts. The public Cloud
product specification in `AGENT_CRM_CLOUD.md` is not an available managed offer.
Private platform and pilot repositories own their own implementation, deployment
and acceptance receipts. Their work does not justify either "nothing has been
built anywhere" or "Cloud is publicly available".
<!-- truth: cloud_control_plane.implemented=absent -->

Marketing runtime remains absent; no marketing automation, billing, autonomous
selling, full CDP, universal model compatibility, comparative superiority or
production readiness follows from the framework test suite. Deployment security
and operation depend on the selected composition and external verifier. Public
directory availability for Docs MCP must not be confused with an application
package marketplace.
<!-- truth: marketing_runtime.implemented=absent -->

No prose test counts belong here. Cite `site/claims.json` `measuredAgainst` and
its exact source identity; an older measurement remains historical until the
measurement command produces a new record.
