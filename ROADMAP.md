# Roadmap

This file is a **pointer, not a ledger.** It used to carry a four-milestone plan
written at Milestone 0, and most of that plan has since shipped under different
identifiers — so a reader could find the same capability described as *planned*
here and as *merged* three documents away. Nothing in this repository may read as
both implemented and planned, so the lists live in one place each:

| Question | File |
|---|---|
| What is merged today, and at which commit? | `docs/PROJECT_STATUS.md` |
| What is the next product task? | `TASKS.md` |
| How are the milestones sequenced, and what depends on what? | `docs/strategy/EXECUTION_ROADMAP.md` |
| Which coding-agent surfaces exist, and which do not? | `docs/CODER_TOOLING_ROADMAP.md` |
| Which business jobs does the framework actually earn? | `docs/benchmarks/CRM_JTBD_MATRIX.md` |
| Category, positioning, distribution, launch, metrics | `docs/strategy/MASTER_PLAN.md` |

## The shape, in one paragraph

The **domain** track has shipped the commercial chain end to end — lead capture
through intelligence, pipeline, quotes, signature, order, contract activation,
delivery handover, execution, economics, change and acceptance; service
operations; and renewal & expansion as recorded intent that renews nothing. The
**coding-agent DX** track has shipped application inspection, Solution Plans,
Project Doctor, Package Scaffold, Package Conformance, Legacy Characterization,
Project Verify and Scenario Evidence. The **production spine** has shipped
identity, organizations, memberships, authorization and one-tenant-per-instance
isolation (v1); dedicated-database PostgreSQL and the storage contract (v2);
durable jobs, a transactional outbox and timer consumers (v3); and self-host
operations contracts — secrets, backup/restore, observability export (v4).
**Accordo Cloud** (a separate, private repository) hosts free Blueprint-configured
workspaces, and `crm cloud` carries a project's Blueprint to one.

## What is still open

Each line is checkable against `docs/PROJECT_STATUS.md` ("Not implemented") and
`TASKS.md` (unchecked items); this list does not add to them.

- **Runtime services, not contracts:** an autostarted or managed worker service, a
  managed jobs service, managed secret and backup custody, an observability backend.
- **Deployment authentication** — the framework still authenticates nobody.
- **Shared-database row-level tenancy** — deliberately not the v1 model.
- **Business domains not built:** billing, invoicing and revenue recognition;
  Interactions (email, calls); Marketing and Analytics, including campaigns
  (`docs/strategy/CAMPAIGNS_JOURNEYS.md` is strategy only).
- **Customer Data Operations v2:** search, saved views, bulk actions, export,
  merge, retention and erasure.
- **Remote agent surfaces:** tenant and role boundaries before remote write
  tools, MCP over Streamable HTTP with authorization, a remote package registry.
- **Factory integration** (`docs/strategy/FACTORY_ACCORDO_INTEGRATION_ROADMAP.md`):
  FA1 Builder Pack, then one supervised business initiative (FA2) before any
  operational packs such as outbound or campaigns (FA3).
