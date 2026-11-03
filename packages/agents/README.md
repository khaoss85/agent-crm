# Agenti teammate

The automation engine (backlog:`8986f4459f0f`): named agents with roles and
working instructions, assignments created from a human phrase (recurring or
one-off), executions recorded with cost and outcome, a monthly spending cap
per agent, and action proposals that become writes only after a human
approval — or a versioned artifact that needs none.

## What it proves

- A phrase such as «ogni lunedì il report vendite» becomes a recurring
  assignment with a cadence and a next run. Pass an explicit `plan` (the
  fake-AI seam) or let the built-in Italian parser place the phrase; an
  unclear phrase refuses with `AGENT_PHRASE_UNCLEAR` instead of guessing.
- An execution either stores action proposals and waits (`proposed`), or
  stores a versioned artifact (`artifact`). Proposals are applied only by
  `approveRun`, with an identified human actor (plus the space permission
  gate when the deployment provides one), through the deployment-wired
  `applyAction` seam — the governed write path (MEM_ACC_REUSE: no duplicate
  of channels, work or commercial writes).
- The agent's monthly cap (cents, calendar month) is checked before the
  `execute` seam runs: over the cap the run is recorded as `capped`, says
  so in its note, costs nothing and never executes.
- Every run — due, capped, failed, proposed, applied, artifact — is a row
  with agent, assignment, cost and outcome.

## What it does not cover (follow-ups)

- Wiring the space-permission gate by default, the Blueprint activation per
  space, the backoffice UI and the worker-side `execute`/`applyAction`
  deployment (pilot worker) — the package exposes the seams, the deployment
  plugs them.
- A real AI planner: `plan` is the seam; the built-in parser covers daily,
  weekly, monthly and once in Italian.
