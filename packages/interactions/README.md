# `interactions` — customer messages and calls

Three records, two actions and two declared capabilities.

| | |
|---|---|
| Owns | `conversation`, `interaction-message`, `interaction-call` |
| Requires | **nothing** |
| Offers | `interaction-log@1`, `interaction-timeline@1` |
| Actions | `interaction-message.advance`, `conversation.close` |
| Policies | none |
| ADR | ADR-030 (the subject envelope) |

## What it is

Native evidence of every customer exchange the first use case names: the chat
apps (WhatsApp, Instagram, Facebook, TikTok), the site form, email and the
company phones. A **Conversation** is one thread with one customer on one
channel. A **Message** is one inbound or outbound message with its delivery
state. A **Call** is one inbound or outbound call with its outcome and its
duration in seconds.

The subject is the ADR-030 opaque envelope — the same shape `work` and
`customer-data` store — pointing at a contact or company the host application
owns. There is no master customer table here and none is created. Channel
identity (which handle names which record) stays in
`customer-data/external-identity`; `remoteHandle` on these rows is a display
snapshot, never an identifier. `work-activity` stays the record of human
follow-up work: this package never writes it, and the timeline reads it only
when the work package is composed.

## What it is not

Stated here, in `metadata().notModeled`, and asserted as absent by the tests:

> no provider integration · no sending, no delivery, no webhook, no polling ·
> no channel identity resolution · no duplicate detection across channels · no
> scheduling, reminders or notifications · no assignment or ownership · no call
> recording or consent · no cross-channel threading.

Nothing in this package contacts a provider. Adapters log evidence here — the
channel credentials do not exist yet, so delivery outside the log is faked by
the consuming project's test kit, never by this package.

## Enable it

```bash
for m in conversation interaction-message interaction-call; do
  npm run crm -- module create packages/interactions/modules/$m.module.json --apply
done
```

```js
// packages/domains/generated/index.js
import { createInteractionsPackage } from '../../interactions/src/index.js';

export const generatedDomains = [
  createInteractionsPackage(),
];
```

Removing the `createInteractionsPackage()` line removes the actions, the
capabilities and the schema block. **It leaves every row**: the framework never
drops your tables.

## The Message lifecycle

An explicit transition table, published in the schema and in `app inspect`:

```text
inbound:   received  (terminal — a message the customer wrote has no delivery lifecycle)
outbound:  sent → delivered → read
            sent → failed        (reason code required)
            delivered → failed    (reason code required)
```

- **Inbound messages never move.** A delivery state on a message the customer
  wrote would claim something about the customer's phone this package cannot
  observe, so `received` is terminal and any advance answers `409`.
- **There is no retry-in-place.** A repeated send is a new message under a new
  source key, which the idempotency rule already supports.
- **A failure without a reason code is refused.** A failed delivery nobody can
  diagnose is not evidence.
- **Outbound messages name their team author.** An outbound row without one
  names nobody for words the business sent; an inbound row with one would claim
  the team wrote the customer's message. Both are refused.

## The Call record

The outcome (`completed`, `missed`, `no-answer`, `failed`) is recorded once,
at log time, and never transitions: a call that happened with its outcome is
immutable evidence, not a lifecycle. `durationSec` is whole seconds, `0`
unless the outcome is `completed` — minutes on a missed call would read as
talk time in every report built on the row. A `failed` call carries a reason
code; any other outcome with one is refused.

## The Timeline

`interaction-timeline@1` reads one subject's messages and calls plus the
`work-activity` entries on the same subject, oldest first — the history the
customer card reads. Every read that decides what the history contains is a
complete exact-match query, never a bounded display page. Without the work
package composed, the work section reads `available: false` with the reason,
never an empty list presented as no work.
