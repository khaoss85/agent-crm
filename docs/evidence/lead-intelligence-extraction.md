# Extraction evidence — Lead Intelligence

**What this is.** The rails an agent actually used to move a legacy domain into
a package, in the order it used them, with the command and the answer at each
step.

**What this is not.** A manual workflow. A user does not run these; a user gives
a goal. `solve-business-goal` chooses the minimum rails internally, and for a
refactor that set includes PRESERVE. This file exists so the choice is
inspectable, not so it becomes a checklist somebody follows by hand.

```text
GOAL     "extract Lead Intelligence without changing what it decides"
  → SEE       what exists                      crm app inspect
  → PRESERVE  freeze behaviour BEFORE touching npm run characterize:intelligence
  → PLAN      decide what to build             ADR-021, ADR-022, the ExecPlan
  → BUILD     move it                          the staged extraction
  → CHECK     find inconsistencies             crm project doctor · crm package test
  → PROVE     prove it works                   npm run verify · LA0 comparison
```

## SEE — what exists

`crm app inspect` reported Intelligence as a **fixed composition slot**, not as
a package: a hard-coded row in `app-inspect.js` pointing at
`packages/intelligence/generated/index.js`. That is what made it legacy, and
seeing it named was the first evidence that the target was a package rather
than a tidier file layout.

## PRESERVE — freeze before touching

`npm run characterize:intelligence`, run **before** any code moved: 151
observations, 822 individually asserted values, over HTTP, the SDK, `/api/schema`,
actions, audit, events, trace, restart, >500 exact reads, concurrency and
hostile input.

This is the step a refactor cannot skip and the one most likely to be skipped.
Without it, "the tests still pass" is the only available proof, and that is the
proof that misses a boundary violation.

## PLAN — decide, then write it down

ADR-021 (declared capability, never an ambient field) and ADR-022 (reuse the
provider and policy contracts; routing targets are declared configuration; no
new registry seam) were **accepted before** the build, on measured evidence
rather than preference. `docs/plans/extract-lead-intelligence-package.md` names
the two approaches rejected — a cosmetic file move and a big-bang rewrite — and
why.

## BUILD — staged, so a failure localizes

Seam fix · package created · records moved byte-identically · composition
replaces the fixed slot · capability replaces the ambient field · absence proved.
Each stage independently verifiable; the stages that break something last.

## CHECK — the rules, mechanically

| Command | Answer |
|---|---|
| `crm package test packages/intelligence --json` | `ok: true` — 24 checks passed, 0 failed |
| `crm project doctor --json` | exit 0, status `warning` (the known DX2 mirror gap) |

DX4 caught a real defect here: the entry point was at `index.js`, and every
package in this repository exports from `src/index.js`. A convention an agent
would otherwise have got subtly wrong, refused by a command rather than by a
reviewer's memory.

## PROVE — the dual gate

| Gate | Result |
|---|---|
| **LA0** — does it still *decide* identically? | **zero** asserted observations moved. The five that changed are all `pre_extraction_evidence` measuring the legacy architecture: the ambient field is gone, the fixed slot is gone, the importer list is the package's own |
| **DX4** — is the result a *well-formed package*? | `ok: true` |
| `npm run verify` | 606 passing, 0 failing |
| `npm run smoke` | exit 0 — the starter installs and the full demo runs |

Neither gate substitutes for the other. LA0 cannot tell you the result is a
package; DX4 cannot tell you it still decides correctly. An extraction that
passes one and not the other has failed.

## The claim this evidence supports, and the one it does not

**Supported:** a legacy domain in this framework can be moved into a package and
the move can be *proved* not to change any externally observable decision.

**Not supported:** that this generalizes to a domain LA0 has not characterized.
One domain is characterized and one is extracted. Commercial Operations and
Signature & Order are still in the kernel and still need the route seam that
Intelligence did not.
