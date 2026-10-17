# `interactions` — customer messages and calls

Six records, five actions and two declared capabilities.

| | |
|---|---|
| Owns | `conversation`, `interaction-message`, `interaction-call`, `conversation-assignment`, `conversation-read`, `conversation-thread-key` |
| Requires | **nothing** |
| Offers | `interaction-log@1`, `interaction-timeline@1` |
| Actions | `interaction-message.advance`, `conversation.close`, `conversation.open-opportunity`, `conversation.assign`, `conversation.mark-read` |
| Policies | none |
| ADR | ADR-030 (the subject envelope) |

## What it is

Native evidence of every customer exchange the first use case names: the chat
apps (WhatsApp, Instagram, Facebook, TikTok), the site form, email and the
company phones. A **Conversation** is one thread with one customer across
channels: WhatsApp, Instagram and email with the same customer stay one
conversation, read oldest first. A **Message** is one inbound or outbound
message with its delivery state. A **Call** is one inbound or outbound call
with its outcome and its duration in seconds. An **Assignment** is one
handover of a thread to a team member — the rows for one conversation are the
audit trail of who owned it. A **Read watermark** is one member's position on
one thread, from which that member's unread count is derived. A **Thread
key** is one channel key joined to one thread, so a retried open replays the
joined thread instead of opening a duplicate.

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
> scheduling, reminders or notifications · no call recording or consent.

Nothing in this package contacts a provider. Adapters log evidence here — the
channel credentials do not exist yet, so delivery outside the log is faked by
the consuming project's test kit, never by this package.

## Enable it

```bash
for m in conversation interaction-message interaction-call conversation-assignment conversation-read conversation-thread-key; do
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
- **Every log names its actor.** Opening a conversation, logging a message or
  logging a call without an actor is refused: anonymous evidence would store
  words the business sent with nobody accountable for them.
- **A retry replays only an identical claim.** The same source key with the
  same payload returns the stored row; a divergent payload — including a
  subject moved from host-owned to package-owned — is refused `409`, never
  adopted.
- **An advance re-reads before writing.** The action re-reads the authoritative
  status inside its transaction and refuses a move the message no longer
  allows, so a concurrent branch that committed first wins and the loser names
  it instead of silently writing last.

## The Call record

The outcome (`completed`, `missed`, `no-answer`, `failed`) is recorded once,
at log time, and never transitions: a call that happened with its outcome is
immutable evidence, not a lifecycle. `durationSec` is whole seconds, `0`
unless the outcome is `completed` — minutes on a missed call would read as
talk time in every report built on the row. A `failed` call carries a reason
code; any other outcome with one is refused.

## One thread per customer

`openConversation` joins the customer's open thread when there is one: the
same ADR-030 subject with a new source key returns the open conversation
(`joined: true`) instead of opening a second one, whatever channel the new
key arrived on — and the join leaves one `conversation-thread-key` row
behind, so retrying the joined key replays the joined thread instead of
opening a duplicate, even after the thread closed. The channel on the
conversation is where the thread started; every message keeps its own
channel, and the thread reads them all oldest first. A closed thread stays
resolved — a new key opens a fresh thread — and a different subject always
gets its own thread. Which channel handle names which customer is still
`customer-data`'s job: the join matches the exact subject envelope, never a
fuzzy handle.

## Ownership with audit

`assignConversation` hands a thread to one team member, or clears it when the
member is null. Every handover is one immutable row naming the new owner, the
previous owner, who decided it and when — the latest row is the current owner
and the rows together are the audit trail. The same source key with the same
handover replays; a divergent handover behind the same key is refused `409`.
The `conversation.assign` action does the same through the record runtime and
defaults its key to the handover itself — previous owner to next owner — so
repeating the current owner replays instead of writing audit noise, while a
return to a prior owner is a new row. Concurrent handovers on one thread run
serialized, so the waiter names the winner as its previous owner and the
trail never claims two predecessors. Each row stamps itself past its
predecessor, so bursts decided in the same instant still order
deterministically instead of tying for latest. The thread read
carries the current owner and the whole trail. A member id is an opaque team
string with no roster behind it: there is no team table here and none is
created.

## Read watermarks, not channel receipts

`markConversationRead` moves the acting member's watermark to now — one row
per conversation and member, updated in place, so nobody marks another member
read. `unreadCount` derives that member's unread: inbound messages later than
the watermark, nothing else. Outbound messages never count, and advancing a
message through its channel delivery (`sent → delivered → read`) moves no
team watermark: the two read meanings stay separate facts.

## The Timeline

`interaction-timeline@1` reads one subject's messages and calls plus the
`work-activity` entries on the same subject, oldest first — the history the
customer card reads. Every read that decides what the history contains is a
complete exact-match query, never a bounded display page. Without the work
package composed, the work section reads `available: false` with the reason,
never an empty list presented as no work.
