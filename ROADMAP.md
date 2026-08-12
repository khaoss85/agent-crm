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
(DX9) and implementation evidence (DX10) do not exist. The **production spine** —
authentication, tenancy, RBAC, PostgreSQL, a scheduler, a durable outbox and
secret management — has shipped **nothing**, and gates everything that would act
on real customer data.

Each of those three sentences is checkable in `docs/PROJECT_STATUS.md`, which is
updated in the same PR as every milestone merge.
