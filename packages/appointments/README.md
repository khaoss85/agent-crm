# Appointments

One booking between a customer and one team member, for one listino service in
one time slot, with the agreed price and the booking lifecycle. A capability,
not a calendar: it books, refuses double bookings and reminds through work.

## What it reuses (MEM_ACC_REUSE)

- The host contact/company (`packages/modules/contact|company`): the customer
  is the ADR-030 subject envelope on that record. No customer table is created
  and none is read beyond the envelope.
- The commercial listino (`packages/commercial`): the booking path resolves
  the service key and the agreed amount from the `product`/`price-book` records
  the catalog sync materializes and passes them in; this package stores the key
  plus an immutable snapshot. No parallel catalog, no pricing authority, no
  re-pricing: a later listino change never rewrites a booked price.
- The team member is an opaque team identity string — the same convention as
  the interactions package's `teamAuthorId`. No roster is read, none is
  created; the overlap check is what makes the identity load-bearing.
- The reminder is a work follow-up (`follow-up@1` from `packages/work`): one
  deterministic task with evidence-only `dueAt`, opened in the booking
  transaction. Work "schedules nothing, reminds nobody", so the reminder is a
  row, not a notification; a spine scheduled-ask timer may later open that
  follow-up at the instant (the timer owns *when*, this package owns *what*).

## Lifecycle

`booked -> confirmed -> done`, plus `booked -> cancelled` and
`confirmed -> no-show | cancelled`. `done`, `no-show` and `cancelled` are
terminal: no regress, no reopen — a repeated visit is a new booking under a
new source key. Cancelling always carries a reason; any other move carries
none. Every booking is idempotent by source key: same key with the same
payload replays the stored row, same key with a different payload is refused
409.

## One member, one slot

Half-open `[startsAt, endsAt)` overlap against the member's held bookings is
refused 409. Back-to-back slots share an endpoint and do not overlap. A
cancelled booking holds nothing — cancelling frees the slot. Every other
state holds its slot even after it ends, because the slot was real.

## Enablement per space

Composition, not a flag: a space whose project lists
`createAppointmentsPackage()` serves `appointment-book`; a space that does
not list it has no booking operation.

The package declares `requires: [{ package: 'work', capability: 'follow-up',
version: 1 }]` and opens the reminder through the provider's own created
handle, so there is exactly one name resolution: the provider's. Compose it
with the provider definition, side by side:

```js
const work = createWorkPackage();
export const generatedDomains = [
  work,
  createAppointmentsPackage({ work }),
];
```

The package imports no file from any other domain package. Without the
provider composed, the application refuses to start naming the unmet edge.

## Booking input

`sourceKey`, `subject` (the customer envelope), `teamMemberId`, `serviceKey`
(the listino product key), `priceCents` (integer minor units) + `currency`
(3-letter code), `startsAt`/`endsAt` (real ISO instants, at most 24 hours
apart), optional `notes` (bounded plain text) and optional `remindAt` (before
`startsAt`): one work follow-up reminder due at that instant.

A booking with `remindAt` must run inside the caller's
`database.transactionAsync`: the appointment and its reminder commit as one
pair, so a reminder refusal rolls the booking back with it. A booking without
`remindAt` is one atomic row and carries no such requirement. The reminder is
recorded with this package as its source (`appointments`), the identity the
follow-up handle is opened as. Replays answer with the same shape as the fresh
booking; the reminder intent (added, removed or moved) is part of the source-key
identity, so a retry that changes it is refused 409. An advance is enforced
against the row as stored, re-read inside the call — never against a stale
copy.

## Blueprint

This package is the `appointments` module of the workspace Blueprint: the
control plane allow-lists the module name and the shared app composes this
package for spaces that enable it (platform + pilot wiring, separate change).
Google Calendar two-way sync stays the consuming project's adapter work
against these rows — it is not modeled here.
