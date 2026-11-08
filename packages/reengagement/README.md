# Re-engagement agent

A teammate agent ([f50ad5c9]): every day it finds the customers
who arrived from WhatsApp, Instagram or email and were never answered — or
not contacted for N days — and prepares one message each.

## What it does

`scanReengagement({ customers, quietDays, nowMs, draftText })` returns
`{ proposals, skipped }`:

- one proposal per silent customer, with the sendable route and the drafted
  knock;
- one skip reason per other customer (`replied`, `recent`, `opted-out`,
  `consent-unknown`, `no-inbound`, `unsupported-channel`,
  `no-sendable-route`, `no-draft` — the last when the wording edge
  returns no usable text for a free-text route).

Outside the 24-hour Meta window a proposal is an approved template or
another connected channel — never free text. The window itself is observed
by the caller from the channels inbox (`windowState` per customer); the rule
stays in `packages/channels` and is never re-declared here.

## What it reuses (nothing is duplicated)

| Need | Home |
|---|---|
| 24-hour window rule | `packages/channels` (`checkMetaServiceWindow`) |
| message wording | `packages/llm` (`draftCustomerMessage`, injected as `draftText`) |
| approval rows | `packages/agents` (`teammate-run`, the «Da fare» queue) |
| follow-up tasks | `packages/work` (`work-task`, recorded by the caller) |
| autonomy switch | `send-without-approval` permission (existing, no new switch) |
| customer identity | `packages/customer-data` (only `customerId` travels) |

## What it deliberately does not do

The daily timer, the inbox and window reads, and the send. The deployment
owns the schedule; the agents package records the run; the deployment's
`applyAction` seam sends an approved proposal through the channels outbox,
which re-checks the window.

## Into «Da fare» (backlog:fd36da512b0e)

The backoffice «Da fare» lists teammate runs with outcome `proposed`, so
the proposals travel as one run of the agents package, never as
`space-ai-proposal` rows:

```js
import { createReengagementExecutor } from './packages/reengagement/src/index.js';

const execute = createReengagementExecutor({
  loadCustomers: ({ agent, assignment }) => silentCustomersOf(spaceId), // channels + customer-data
  draftText,
});
await app.operations.run('run-due', { spaceId, actor, execute });
```

Each knock becomes one `reengagement-message` action of the run (payload =
the proposal values; at most 25 per run, the rest stay silent for the next
run). The human then acts on that row: `approve-run` applies the actions
through `applyAction`, `revise-run` edits one message before approving,
`reject-run` closes the run as `rejected` with nothing sent. A run with
nobody to knock is an `artifact` counting the skips by reason.
`loadCustomers` should leave out customers already waiting in «Da fare».

## Wiring

```js
import { createReengagementPackage } from './packages/reengagement/src/index.js';
import { draftCustomerMessage } from './packages/llm/src/message-draft.js';

// ... inside the host worker, with complete/history/window from channels:
const pkg = createReengagementPackage({
  draftText: ({ candidate, route, intent }) => draftCustomerMessage({
    complete, spaceId, actor,
    customerName: candidate.displayName,
    history: candidate.history,
    intent,
    connectedChannels: [route.channel],
  }).then((draft) => ({ text: draft.corta })),
});
```

Without `draftText` the operation refuses with
`REENGAGEMENT_DRAFT_UNAVAILABLE` instead of proposing blind. Consent
`unknown` skips fail-closed: the caller resolves it from the customer-data
opt-out before the scan.
