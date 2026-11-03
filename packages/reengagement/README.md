# Re-engagement agent

Presti's first teammate agent ([f50ad5c9]): every day it finds the customers
who arrived from WhatsApp, Instagram or email and were never answered — or
not contacted for N days — and prepares one message each.

## What it does

`scanReengagement({ customers, quietDays, nowMs, draftText })` returns
`{ proposals, skipped }`:

- one proposal per silent customer, with the sendable route and the drafted
  knock;
- one skip reason per other customer (`replied`, `recent`, `opted-out`,
  `consent-unknown`, `no-inbound`, `unsupported-channel`,
  `no-sendable-route`).

Outside the 24-hour Meta window a proposal is an approved template or
another connected channel — never free text. The window itself is observed
by the caller from the channels inbox (`windowState` per customer); the rule
stays in `packages/channels` and is never re-declared here.

## What it reuses (nothing is duplicated)

| Need | Home |
|---|---|
| 24-hour window rule | `packages/channels` (`checkMetaServiceWindow`) |
| message wording | `packages/llm` (`draftCustomerMessage`, injected as `draftText`) |
| approval rows | `packages/space-permissions` (`space-ai-proposal`, values already fit) |
| follow-up tasks | `packages/work` (`work-task`, recorded by the caller) |
| autonomy switch | `send-without-approval` permission (existing, no new switch) |
| customer identity | `packages/customer-data` (only `customerId` travels) |

## What it deliberately does not do

The daily timer, the inbox and window reads, the approval recording and the
send. The deployment owns the schedule; the caller records the returned
proposal values with `space-ai-proposal.propose-action` when the space
switch is off and sends them (through the channels outbox, which re-checks
the window) when it is on. Executing an approved proposal stays the
caller's job.

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
