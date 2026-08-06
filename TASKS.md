# Tasks

The first unchecked item is the default next task for Codex.

- [x] Introduce a declarative module manifest and generate SQLite migrations from it (`docs/MODULE_MANIFEST.md`, `agent-crm module:validate` / `module:migration`).
- [x] Generate an Admin form and table from module metadata (Milestone 4, `docs/ADMIN.md`).
- [x] Add code-first record actions with atomic execution, post-commit events and trace, proven by the Lead Qualification starter (Milestone 6, `docs/ACTIONS.md`, `examples/starters/b2b-lead-qualification/`).
- [ ] Add Activity and a first-class Task module with a general automatic follow-up workflow. Partially explored: the Lead starter ships a Task module and creates one follow-up inside the qualify action, but scheduling, reminders and a reusable task engine are not built.
- [x] Add lead conversion (lead → Company/Contact/Opportunity) on top of record actions, via declared core-module adapters (Milestone 7, ADR-013, `examples/starters/b2b-lead-qualification/actions/convert.js`).
- [x] Add configurable code-first Opportunity pipelines with a server-authoritative move-stage action and an Admin board (Milestone 8, ADR-014, `docs/plans/milestone-8-opportunity-pipeline.md`).
- [x] Add Lead Intelligence v1: enrichment provider contract with immutable snapshots, behavioral signals, versioned explainable scoring and deterministic routing with assignment history (Milestone 9, ADR-015, `docs/LEAD_INTELLIGENCE.md`).
- [x] Add Commercial Operations v1: catalog provider sync into immutable products/price books, server-priced quotes with immutable versions, and a versioned discount policy with human approval (Milestone 10, ADR-016, `docs/COMMERCIAL_OPERATIONS.md`).
- [x] Add Signature and Order v1: a bounded signature provider contract, a persisted envelope/event state machine with verified webhooks and explicit reconciliation, signed-artifact evidence and immutable Orders built from an approved Quote Version (Milestone 11, ADR-017, `docs/SIGNATURE_ORDER.md`).
- [x] Take the Platform Alignment Gate: core-versus-domain boundary (ADR-018), the capability model, the corrected M12–M16 sequence, the Integration Runtime / Jobs / Data Governance / Design-to-CRM tracks, permanent quality gates and one project-status source (`docs/strategy/PLATFORM_ALIGNMENT_GATE.md`). Documentation and architecture only.
- [x] Add Contract & Subscription Activation v1: turn a signed immutable Order into a Commercial Contract, its immutable version and lines, a Subscription with its lines and explicit pending delivery/service obligations, classified by a versioned Order Activation Policy that refuses to guess — built as the first optional domain package under ADR-018 (Milestone 12, ADR-018 addendum, `docs/CONTRACT_ACTIVATION.md`).
- [x] Add Custom Package Authoring v1 and Delivery Handover v1: a public domain-package contract with declared cross-package capabilities, a read-only `crm package validate|inspect` CLI, an authoring guide and mirrored Skill, a customer-authored conformance package, and the package-native delivery handover that plans a delivery project, work packages, milestones and an optional partner engagement from the contract's pending delivery obligations (Milestone 13, ADR-018 addendum 3, `docs/PACKAGE_AUTHORING.md`, `docs/DELIVERY_HANDOVER.md`).
- [ ] Add a provider adapter example for MailUp-compatible list enrollment.
- [ ] Add tenant and role boundaries before exposing remote write tools.
- [ ] Add Streamable HTTP transport for MCP with authorization.
- [ ] Add PostgreSQL storage adapter behind the existing database contract.

- [ ] **MK0 — Marketing & Growth Operations roadmap (documentation only).** Strategy (`docs/strategy/MARKETING_GROWTH_OPERATIONS.md`, `CAMPAIGNS_JOURNEYS.md`, `EXPERIMENTATION_ATTRIBUTION.md`), the MK0–MK7 track in `EXECUTION_ROADMAP.md`, 43 JTBD-MK rows (all **not supported**) and five planned E2E-M benchmark scenarios. Opened as a documentation-only PR (#18) targeting `main`. **No Marketing runtime is implemented, and MK1 does not start in it.**
