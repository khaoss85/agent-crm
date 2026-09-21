# Accordo — Cloud C0 Foundation on the Private Platform Repository, or Remote-Safe MCP if C0 stays blocked

**Ready to run.** Two entry conditions, and the prompt branches on which holds.

## Entry condition

`khaoss85/accordo-platform` now exists — private, empty apart from a README,
created on the owner's explicit authorisation on 2026-09-01. So the entry
condition is **access**, not existence: check whether this session can read and
push to it.

- **It can** → run Track A (Cloud C0).
- **It cannot** → report `HUMAN_ACTION_REQUIRED: grant access to
  khaoss85/accordo-platform`, then run **Track B** instead. Do **not** build
  managed Cloud inside `agent-crm` in the meantime.

Either way, the rule that produced the original block stands: an agent does not
create repositories, grant access or configure branch protection on its own
initiative. A person did those, or they are still undone.

## Baseline

`khaoss85/agent-crm` at the head of `main` after the public-production-operations
campaign. Read first, in this order: `docs/plans/cloud-arvo-handoff.md`,
`docs/plans/public-production-operations-integration.md`, `AGENTS.md` §14 and
§17, `docs/REPOSITORY_TRUTH.md`, `TASKS.md` (the three follow-ups opened by the
integration).

## Track A — Cloud C0 foundation

Scope: the control-plane skeleton in the private repository only. C0 is a
foundation, not a product; C1–C3 are named here only so C0 does not design
against nothing.

1. **Deployment Receipt.** Twenty-three fields, of which exactly three are
   answerable today — `worker/job posture`, `traces reference or command`,
   `backup posture and last verified receipt`. Give the receipt a schema. Take
   the first from the composed handle's `status()`, whose shape is already
   bounded and identifier-free; do not widen it to make the receipt prettier.
   The other twenty stay explicitly unanswered, and the receipt says so.
2. **Operator read surface** over jobs and outbox state, sourced only from the
   bounded posture. No new query path into the tenant data plane.
3. **The boundary that must not move.** The framework authenticates nobody;
   actor headers are not authentication; managed secret custody, managed backup
   custody/scheduling/retention and an observability backend stay absent. An
   export contract is an interface, and an interface is not a backend.

**Non-negotiables.** No plaintext production secret in agent context. Never kill
or reuse an unidentified PostgreSQL instance. No secret in jobs, audit, trace,
backup manifests or telemetry. Do not modify, close, rebase or merge #134. No
autostart anywhere. No JTBD coverage row moves: coverage stays five
evidence-backed `partially supported` rows out of 600.

## Track B — remote-safe MCP (Streamable HTTP with authorization)

The other half of the v4 remainder, and the reason finishing v3/v4 did not open
the Cloud gate. It needs no private repository.

Deliver the transport and its authorization boundary as a bounded contract with
its own limitation code and its own truth fact — cited by a surface **in the
same PR**, which is the rule this campaign's predecessor learned twice.

## Two follow-ups either track should carry

- **repo:truth v2 — generate the sentence from its facts.** The evidence is in
  `TASKS.md`; it is the fix for a failure mode that bit the previous campaign
  twice and that attention demonstrably does not prevent.
- **Decide where `spine_scheduled_asks` lives** — promoted into both core
  schemas beside `spine_jobs`, which moves the PostgreSQL repository fingerprint
  and every deployment's ledger, or kept as an opt-in module migration and said
  so in the contract's own words. It is currently the second, by default rather
  than by decision.

## Method

Lead/Integrator plus at most two workers in sibling worktrees outside the repo,
one branch each. Plan before code. One exact measurement after integration, not
per slice. Any authority-file change runs characterization in the same push —
three red CI runs in the last campaign were exactly this.

**The thing worth carrying over.** Every serious defect in the previous campaign
came out of contact between two points of view, not out of anyone looking
harder: the reviewer had the right question without the map, the author had the
map without the question. Re-verifying your own claim is nearly always wasted;
only trying to falsify it pays. Send a reviewer the outcome where you were
wrong.
