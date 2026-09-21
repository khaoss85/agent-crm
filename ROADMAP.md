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
Project Verify and Scenario Evidence; skill-mirror sync (DX2), the context pack
(DX9) and implementation evidence (DX10) do not exist. The **production spine** has shipped its
**first slice** (v1, ADR-038): verified identity, organizations, memberships,
authorization, and **tenant isolation enforced by binding one instance to one
tenant** — one application, one tenant data plane, one storage binding, with a
configuration naming two tenants refused at startup. Shared-database row-level
tenancy is deliberately not that fix and is not implemented. Storage, execution
and operations are still absent, and are split into
named milestones below rather than left as one undifferentiated blocker.

Each of those three sentences is checkable in `docs/PROJECT_STATUS.md`, which is
updated in the same PR as every milestone merge.

## The Production Spine, split into milestones

v1 (ADR-038) deliberately closed identity, tenancy and authorization and nothing
else. What remains was previously a scattered list of blockers appearing in a
dozen limitation strings; it is three milestones, and each has an owner so that
"the spine is missing" stops being a sentence anybody can say without owning.

| Milestone | Scope | Gates | Owner |
|---|---|---|---|
| **Spine v1 — identity and tenancy** *(shipped, ADR-038)* | Verified identity contract, organizations, memberships, permissions and role bundles, server-authoritative authorization, explicit local-development mode, and **one-tenant-per-instance storage isolation**: the CRM data plane comes from the tenant binding, the control plane is a separate database with a separate schema, and a configuration naming two tenants is refused at startup | — | delivered |
| **Spine v2 — storage** | PostgreSQL, and **shared-database row-level tenancy**: the `organization_id` migration across 86+ tables that v1 deliberately did not attempt, with the backfill, the reworked unique constraints and the rescoped reads. v1's model is not a step toward this one — it is the alternative that does not need it, and it is why this is not urgent | Cross-tenant reporting · many tenants per process · anything that needs one database | **unassigned — integrator to assign** |
| **Spine v3 — execution** | Durable jobs, an outbox and a scheduler | Retention and erasure workflows · reminders and due-date alerts · renewal automation · any "and then, later, do X" | **unassigned — integrator to assign** |
| **Spine v4 — operations** | Secret manager, backups and restore, deploy and rollback, remote-safe adapters and MCP | Any remote deployment · any claim about recovery · the remote MCP mutation surface | **unassigned — integrator to assign** |

**Ordering is not arbitrary.** v2 before v3, because a durable job queue on
per-tenant SQLite files would have to be rebuilt the moment storage moves. v4
last, because backups and rollback describe whatever storage v2 settles on.

**None of this is production readiness, and v1 does not claim it.** Until v2,
v3 and v4 land, the honest statement is that identity, tenancy and
authorization exist while storage, execution and operations do not.

