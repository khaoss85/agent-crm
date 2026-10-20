# Sequences (BO-F3-03)

One space's follow-up sequences: an ordered list of day+channel steps with
personalized templates, a trigger that enrolls people, and an automatic stop
at the first recorded reply (backlog:22bb154a72ea).

## What it reuses, never duplicates (MEM_ACC_REUSE)

- The timer beats the advance: the deployment calls
  `advance-sequences` on its own interval, like the appointment reminder
  sweep. No scheduler lives here.
- Sends queue into the channels outbox through the composition-provided
  `queueTemplate` seam (the same durable enqueue as every channel send, with
  the same deterministic idempotency key) — the sweep never calls a provider.
- The reply stop reads the `channel-inbox-event` rows with the connection's
  own reply window (`subjectForRecipient`/`isObservation` from the adapter
  definition) — the rule that tells a reply apart from a delivery report.
- The permission verdict comes from `space-permission-gate@1`
  (`send-without-approval`, off by default): without it a due step becomes
  a human-decided approval proposal (the permission notice) and waits.

## Composition

```js
import { createSequencesPackage } from './packages/sequences/src/index.js';

createSequencesPackage({
  spacePermissions,   // composed createSpacePermissionsDomain() definition
  queueTemplate,      // bound channels queueTemplateSend: (params) => ({ jobId, state, ... })
  replyWindows,       // { [connectionKey]: adapter.outboundWindow } (+ optional [channel] fallback)
  personalize,        // optional async (input) => string[] — the AI rewrite seam
});
```

`requires: [{ package: 'space-permissions', capability: 'space-permission-gate', version: 1 }]`
keeps a composition without the gate fail-closed at startup.

## The four guarantees

1. **Stop on reply.** Before a due step fires, the sweep looks for an
   applied inbox row from the enrolled recipient recorded after the
   enrollment. The first one moves the enrollment to `stopped-replied` and
   no further step fires. Caller timestamps never enter: only stored rows.
2. **Fail-closed permission.** Every fire passes the gate. On `proposal`
   the sweep records the approval proposal and stores a `waiting-approval`
   send row; the step stays due. A human approval recorded for that exact
   step unblocks it on the next sweep even while the global switch stays
   off; a refusal records the step `skipped` and moves past it. Nothing is
   ever queued without the gate or a recorded approval.
3. **Pause/resume without doubles.** A send row is keyed by the
   deterministic message key (`seq:<enrollment>:<stepOrder>`, bounded like
   every outbox key): a retry or a resume replays the stored row, and the
   outbox returns the same job for the same key. Pause fires nothing;
   resume re-fires only steps with no send row.
4. **Metrics from records.** `read-sequence-metrics` and `list-sequences`
   count enrollment and send rows on every read — people by state
   (`active`, `paused`, `stopped-replied`, `completed`) and fires by step
   (`queued`, `waiting-approval`, `sent`, `dead-letter`, `skipped`). No
   stored counters exist to drift after a crash or a race.

## Personalization

Step `templateVars` carry `{{placeholder}}` slots, substituted per person
from the enrollment `vars` (`{{name}}` falls back to the subject label).
A deployment plugs AI rewriting into `personalize(input)` —
`{ channel, template, variables, enrollment }` in, the final variables out;
without it the deterministic substitution stands (declared in `remaining`,
not faked).

## What is deliberately NOT here

Provider sends (the channels outbox owns them), the backoffice UI (the
pilot renders the elenco from `list-sequences`), stored counters, and step
edits on an active sequence (steps are append-only in `draft`).
