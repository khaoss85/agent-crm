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

The check-then-act is serialized per team member: same-process bookings for
one member queue, so the loser re-reads the winner's committed row (409, or
a replay for the same source key). The re-read and the insert commit inside
one outer transaction — the caller's for a booking with `remindAt`, the
handle's own otherwise — so writers serialize across connections too. A held
row whose slot cannot be proven (unparseable or inverted) fails the booking
closed instead of reading as a free slot.

## Team week (BO-F3-01, backlog `3ec06fdee0e2`)

`readTeamWeek` (also `teamWeekFor` on `appointment-schedule@1`) renders the
"07 Calendario" team week: every appointment overlapping `[from, to)` for
each named member, grouped per person, soonest slot first. The person
filter is the member list itself — a subset is a filtered week, an empty
list is refused 400 rather than answered with everyone's bookings. Reads
are the same exact-match per-member `listWhere` the booking path
overlap-checks against, so a booking the overlap check saw is a booking
the week shows; members are bounded (32), never scanned, because there is
no roster. Each row carries the `sourceKey` (the join key the calendar
detail reads the sync state through) and the subject envelope (who the
slot is for). `tests/appointment-team-week.test.js` proves it with no
database.

## Booking flow (BO-F3-02, backlog `c1d05e6547fc`)

`"07 Calendario"`: the operator proposes slots, confirms once, the
customer books online from the business link. All on `appointment-book@1`,
all additive — `bookAppointment` is unchanged and `advanceAppointment` keeps its contract with the re-read and the write serialized per appointment.

- `suggestSlots({ teamMemberIds, from, to, slotMinutes })` reads free slots
  from the same held rows the booking path overlap-checks against. Read
  only: no row is written, no slot is invented; a held row whose slot cannot
  be proven fails the suggestion closed.
- `proposeBooking(request + spaceId)` validates, fails fast on a held slot,
  then reads the space `book-appointments` switch. Switch on: a draft is
  answered and nothing is written. Switch off: a `space-ai-proposal` is
  recorded and the booking stays a proposal. The proposal identity binds the
  whole booking claim (customer, member, service, price, slot, reminder,
  provenance) behind a digest: resubmitting the same source key with a
  changed field opens a distinct proposal, never a replay of the old one.
- `confirmBooking(request + spaceId + confirmed: true)` creates only on
  explicit confirmation. A named calendar is validated first (a miscomposed
  calendar edge fails before any row exists); then it re-checks the switch,
  books, advances `booked -> confirmed` and — when `calendar: { calendarId }`
  is named — pushes the event through the calendar-sync push handle. The advance is
  serialized per appointment (same process) and inside the storage
  transaction on a real database: two racing confirms advance once and the
  loser replays the winner; a confirm racing a cancellation never overwrites
  the winner. A push that fails at runtime never throws: the confirm answers
  `push: null` with `pushError: { code }` on the committed booking, and a
  retried confirm (same source key) replays it and exports the event once.
- `bookFromLink(request + spaceId + linkToken)` books from
  `accordo.dev/p/...`: the source key derives from the token and the
  canonical UTC slot, so a doubled submission replays the winner whatever
  spelling of the instant it carries (`Z`, `+02:00`, `-00:00` all derive one
  key). The link path reads the space `book-appointments` switch like
  propose/confirm: switch on books, switch off records a `space-ai-proposal`
  and stays a proposal.
- `parseBookingPhrase({ spaceId, phrase })` drafts parameters from one
  Italian sentence through `llm-complete@1` (purpose `suggest`). Without
  the handle it refuses with a named code; the model is strictly validated,
  the price never comes from it.

`tests/appointments-booking-flow.test.js` proves the flow with fakes and no
application boot, including the ten-racer link race. The backoffice UI
(week view, "Nuovo appuntamento", booking link page), the calendar invite
(attendees) and the approval-to-execution wiring are follow-ups, not this
package.

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
