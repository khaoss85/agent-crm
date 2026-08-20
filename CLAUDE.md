# Claude Code guidance

Read `AGENTS.md` first and follow it as the canonical repository guidance.

Before substantial work, also read `PRODUCT.md`, `ARCHITECTURE.md`, `DECISIONS.md` and the relevant skill under `.claude/skills/`.

## Selecting an Accordo rail

The application answers questions about itself through a small set of rails —
few tools, distinct jobs. When one of the questions below is the question in
front of you, run its rail rather than assembling the answer from `find`,
`grep` and source reading: hand-assembly is slower, and it tends to fail by
inventing a capability the application does not have
(`docs/APPLICATION_INSPECTION.md`).

| The question in front of you | Rail | Command |
|---|---|---|
| What has this project actually composed? | SEE | `npm run crm -- app inspect --json` |
| Is this plan valid, and still true of this application? | PLAN | `npm run crm -- solution check <plan.json>` |
| What is inconsistent or stale in this checkout? | CHECK | `npm run crm -- project doctor --json` |
| I need a minimal new package starting point. | BUILD | `npm run crm -- package scaffold <name>` |
| Does this one package conform to the framework? | CHECK | `npm run crm -- package test <dir> --json` |
| Is the whole project technically healthy? | PROVE | `npm run crm -- project verify --json` |
| Does this business journey actually work? | PROVE | `npm run crm -- scenario run <scenario> --json` |
| Is every requirement of the plan actually proven? | PROVE | `npm run crm -- solution verify <plan.json> --evidence <evidence.json>` |
| Will this refactor preserve behaviour? | PRESERVE | characterization — `tests/characterization/`, `npm run characterize:intelligence` |

**The selection rule.** Use the smallest rail that directly answers the current
question. Do not chain rails automatically, and no rail — `app inspect`
included — is an obligatory first step. Escalate only when the next question
needs a stronger kind of evidence: what exists → inspect · internally
consistent → doctor · technical health proven → project verify · this journey
proven → scenario run · the plan proven complete → solution verify.

The boundaries between neighbouring rails:

- `app inspect` describes what exists — composition, capabilities, records,
  actions, policies, providers — never health, domain correctness or runtime state.
- `project doctor` diagnoses source consistency and drift; it makes no claim
  about business behaviour.
- `solution check` asks whether the plan still matches the application
  (`PLAN_STALE`), not whether it is implemented: it can exit 0 on a plan
  nobody has built a line of.
- `project verify` proves technical health by orchestrating existing authorities
  — conformance, the doctor, the project's declared scripts; it runs no business
  scenario and maps no requirement to proof.
- `scenario run` proves one named business journey with linked evidence; it is
  not whole-project health, and it promotes no JTBD row.
- `solution verify` maps every plan requirement to machine-checked proof and
  may honestly exit 1 with work unproven; it executes no plan and writes
  nothing.
- `package scaffold` writes a minimal conforming skeleton with no invented
  domain semantics — dry-run by default, `--apply` to write.
- `package test` proves framework conformance by composing the package into a
  real application, never domain correctness; `package validate` checks only
  that the declaration is structurally valid, so a conformance question ends
  at `test`.
- characterization freezes a domain's externally observable behaviour before a
  boundary-preserving refactor, and replays it after.

SEE, PLAN, BUILD, CHECK, PROVE and PRESERVE are the agent's internal labels
for its own next action. A user states a goal and never needs to know a rail
exists; for goal-shaped work, the Skills choose the rails.

This section appears verbatim in both `AGENTS.md` and `CLAUDE.md`, because
each is the file a different harness loads at session start. If the copies
disagree, `AGENTS.md` is canonical. Parity is kept by hand — diff the two
sections when editing either.

Non-negotiable rules:

- All CRM mutations go through module services or named workflows.
- Preserve validation, actor identity, audit and trace.
- Keep commercial policy deterministic; AI may recommend but cannot silently override approval rules.
- Code-generating or destructive MCP actions must remain explicit and safe by default.
- Use an ExecPlan for multi-file work and finish with `npm run verify`.
- A sentence in a current document that states what the framework does or does not do is bound to a generated fact (ADR-039). When a PR moves a product boundary, a rail, a package contract or the spine, run `npm run repo:truth -- --check`; regenerate with `npm run repo:truth` and commit `docs/repository-truth.json` in the same PR. Rules: `docs/REPOSITORY_TRUTH.md` and `docs/QUALITY_GATES.md` §6.1. It is a repository-maintenance script, not a rail.
