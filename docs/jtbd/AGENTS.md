# JTBD catalog instructions for coding agents

Root `AGENTS.md`, `docs/QUALITY_GATES.md`, ADRs and Accordo rails are authoritative. This file only narrows how to use the desired-state catalog.

## Non-negotiable distinction

- Catalog record = desired job/use case and acceptance boundary.
- Repository evidence = what exists at a pinned SHA.
- Coverage overlay = conclusion supported by evidence.
- Roadmap = prioritization of demonstrated gaps.

Never reverse that order.

## Before a Phase D audit

1. `python docs/jtbd/tools/verify_catalog.py`
2. Record repository, branch, target SHA, assessor and constraints.
3. Read `coverage/STATUS_CROSSWALK.md`.
4. Select the smallest relevant slice; do not load 600 records when a persona/capability slice answers the question.

## Evidence discipline

Use the smallest Accordo rail that directly answers the claim (`app inspect`, `project doctor`, `project verify`, `scenario run`, `solution verify`, characterization). Source and prose may locate evidence but do not promote status by themselves.

Every positive coverage conclusion must name exact evidence and exact residual limitation. A missing end-to-end proof cannot be averaged away by many partial primitives.

## Coverage vocabulary

For repository overlays use only:

`not supported | partially supported | technically supported | validated end to end`

as defined by `docs/QUALITY_GATES.md`. The richer status enum inside the portable catalog is not the repository's publication vocabulary.

## Agentic jobs

For any job involving autonomous action or platform evolution, separately verify tool scope, actor/tenant authorization, policy/approval boundary, managed-action/service boundary, idempotency/retry/compensation, audit/trace, evaluation and rollback. An LLM prompt or agent declaration without these boundaries is not agentic capability coverage.
