# Calendar sync — Accordo / Google Calendar, both directions

Backlog: `bf0351325a8c` — «Calendario allineato con Google nei due sensi».

The hybrid story: the user works in Accordo, in Google Calendar, or in
both. Future Google events import as appointment rows; Accordo bookings
export as Google events; each side sees the other's changes after one
sync cycle. Push notifications only say «something changed» — the sync
then pulls incrementally on its stored sync token.

Fake-backed on purpose (owner decision MEM_ACC_DECISIONS: no Google
credentials exist yet, and none are invented here):
`src/google-fake.js` speaks sync tokens, tombstones and push channels,
so every acceptance bullet is proven against the fake. The real adapter
implements the same four provider functions against Google's API.

## Reuse, not duplication

- Appointment rows, overlap, idempotency and lifecycle stay in
  `packages/appointments`, written only through its `appointment-book@1`
  capability (declared in `requires`, opened per call with this package
  as consumer). No second booking path exists here.
- No customer master table, no roster, no catalog: customer, team
  member, service and price are the deployment's `mapping` functions,
  validated fail-closed — without them the sync refuses rather than
  booking against a fabricated identity.
- Link rows (`calendar-link`) and sync state (`calendar-sync-state`)
  are the only records this package owns.

## Conflict rule

Two halves, two owners. Accordo owns **lifecycle**; Google owns
**schedule**. The link row joins them.

1. A Google slot change on an **open** local row (`booked`,
   `confirmed`) moves the booking **atomically**: the old row is
   cancelled with reason «Rescheduled in Google Calendar» only with
   its rebook under a revisioned key (`gcal:<id>:r<n>`), carrying a
   `confirmed` forward. A refused rebook (slot held) keeps the valid
   row and is retried — never sacrificed to the retry. The old row
   stays as evidence.
2. A Google change on a **terminal** row (`done`, `no-show`,
   `cancelled`) is ignored: a happened visit is never rewritten. The
   sync acknowledges the token so it is not re-reported.
3. A Google edit that moves **no slot** (notes/summary only) is
   acknowledged without a local write: appointment rows are
   evidence-immutable outside lifecycle, and say so in the entry.
4. A **local cancellation wins** over any concurrent Google change:
   the sync pushes the cancellation to Google so both sides converge
   on the freed slot, and the pending conflict clears.
5. An import overlapping a held slot is **refused 409 and reported**:
   the no-double-booking invariant is never booked over.
6. An event with **no customer mapping** is skipped and reported,
   never booked against a fabricated contact.
7. An **expired sync token** never guesses: the sync reconciles fully
   (list, match by link, converge) and resumes from the new token.
8. A remote change that **cannot apply yet is never lost**: a move
   refused onto a held slot, or an import refused with no link yet,
   keeps the valid local row and is kept as a pending snapshot on the
   link and retried on every pull — the token moves on, the retry does
   not depend on it. The pending conflict is reported until it
   converges.
9. A **full import reads tombstones**: a cancellation made on Google
   between two imports applies locally before the token moves past
   it — never skipped past. A tombstone for an event never imported
   is ignored, never booked.
10. A move that **overlaps its own old slot needs a storage
    transaction** to converge: without one the prove-before-cancel
    fallback proves the new slot against the still-held old row, so
    the move stays pending and is retried — waited on, never
    sacrificed. Atomic commit (cancel with rebook) is the supported
    path for self-overlapping moves.
11. The **newest Google version always wins** over an older pending
    snapshot: when the event in hand carries a newer `updated` stamp
    than the outstanding envelope, the envelope is replaced and the
    event is decided through the tracked path — never retried stale
    first, never skipped past by the advancing token. A snapshot older
    than the link's known version is not retried.

## How to prove it

`tests/calendar-sync.test.js` runs the whole story against the fake:
import with no duplicates on re-run, Google-side edit visible locally,
local cancellation visible on Google, two consecutive `syncOnce` runs
changing nothing, the cancellation-wins convergence, push delivery
applying remotely-made changes, token-expiry recovery, overlap refusal,
terminal-row immunity, tombstone-between-imports convergence, a refused
move keeping the valid row (and converging once the slot frees), a
self-overlapping move applying atomically, a settled retry still
applying the newer Google move on a full import, a newer move
superseding a still-conflicted pending on a pull (with no resurrection
when the old blocker frees), and the package factory forwarding an
explicit database handle. No test dials Google.
