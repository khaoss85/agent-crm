# Delivery handover (Milestone 13, the delivery domain package)

Turning the pending Delivery Obligations of an activated contract into a
**planned** delivery project: one work package per obligation, a milestone
plan, and an optional third-party partner engagement.

**This milestone plans and records a handover. It does not execute delivery.**
Nothing starts, progresses, completes, schedules, staffs, costs, bills or
grants anyone access. A Delivery Project here is `pending_kickoff` and stays
that way until a later milestone gives it a lifecycle.

It is also the **second** domain package, and the first one that depends on
another: `packages/delivery` reaches `packages/contracts` only through the
declared capability `delivery-obligations@1`. Neither package imports the
other's source, and the kernel imports neither.

## The flow

```text
signed Order (M11)
→ activated Contract + pending Delivery Obligations (M12)
→ plan-delivery-handover     read-only: who delivers what, and why
→ decide anything the policy would not guess (human, with a reason)
→ create-delivery-handover   ONE transaction: handover run + delivery project
                             + work packages + milestones + optional partner
                             + the obligations marked handed over
→ inspect                    project / work packages / milestones / partner / audit / trace
```

```js
// read-only; safe for an agent to prepare
const { plan } = (await client.module('commercial-contract')
  .action(contractId, 'plan-delivery-handover', { policy: 'b2b-delivery-handover', policyVersion: 1 })).result;

// the human decision (an agent actor is refused 403 HUMAN_APPROVAL_REQUIRED)
await client.module('commercial-contract').action(contractId, 'create-delivery-handover', {
  policy: 'b2b-delivery-handover',
  policyVersion: 1,
  projectName: 'Acme — onboarding and migration',
  targetStartDate: '2026-09-20',      // planning data, not a commitment
  targetEndDate: '2026-12-20',
  partner: { partnerRef: 'partner:abc-consulting', partnerName: 'ABC Consulting', reason: 'they run our migrations' },
  modeOverrides: [{ obligationId, deliveryMode: 'internal', reason: 'our own team loads this data' }],
});
```

## Who delivers it is a decision, not an inference

A component's label does not say who performs the work, and the framework never
guesses from one. The Delivery Handover Policy decides from identity the
obligation already carries — component key, SKU, product, provider — and
returns `ambiguous` when it cannot:

| Mode | Meaning |
|---|---|
| `internal` | our own team performs this work package |
| `partner` | a named third party performs it; the project needs a partner engagement |
| `ambiguous` | **blocks the handover** until a human decides, with a reason |

The policy also proposes the work-package label and which milestones the
project needs (`kickoff`, `delivery`, `go-live` in the starter). Those are
planning proposals: nobody signed them.

A human override records both answers — `policyDeliveryMode` (what the policy
said), `deliveryMode` (what applies), `modeOverrideReason` and `overriddenBy` —
so the handover explains itself years later.

## The partner is a reference, not an account

M13 models **at most one** delivery partner per project, as a business
reference and a name snapshot:

- it grants **no** account, login, portal, invitation, permission or role;
- there is **no** fee, revenue share, invoice, SLA or acceptance;
- nothing notifies the partner, and nothing can be sent to them from here.

A partner is required exactly when some work package is partner-delivered
(`409 PARTNER_REQUIRED`), and refused when none is (`409 PARTNER_NOT_APPLICABLE`).
Multiple partners per project are deliberately not modelled: a project that
needs two is a later milestone, not an unreviewed array.

## Planning dates

Calendar dates, `YYYY-MM-DD`, round-trip validated. Both window dates are
supplied together or not at all — "starts 2026-09-01, ends when it ends" is not
a plan anyone can read. The window must sit inside the contract's operational
term, and the whole window is optional: a handover can be planned before the
schedule is known.

Every record carries `datesSource: "post-sale-delivery-planning"`. These dates
were not signed, they are not a customer commitment, and **nothing fires on
them** — there is no scheduler in this framework.

## Plan versus create

| | `plan-delivery-handover` | `create-delivery-handover` |
|---|---|---|
| Writes | nothing — no delivery record, no business audit, no event | everything, in one transaction |
| Actor | any, including agents | `user` only; an agent is `403 HUMAN_APPROVAL_REQUIRED` |
| Undecided mode | reported per obligation | refused (`409 DELIVERY_MODE_AMBIGUOUS`) |
| Trust in the caller | — | none: the plan is recomputed inside the transaction |

## Records

All five are read-only publicly (`get`/`list`) and exist only through the
handover action.

| Module | Notes |
|---|---|
| `delivery-handover-run` | the audited run: actor, time, source contract and activation, policy version and fingerprint, every decision and override, and the records it created |
| `delivery-project` | one per contract, `delivery-project:contract:<contractId>`, `pending_kickoff`, with its own customer snapshot |
| `delivery-work-package` | one per source obligation, with the commercial snapshot and the delivery-mode evidence |
| `delivery-milestone` | the canonical milestone plan, ordered, with the work packages it covers |
| `delivery-partner-engagement` | at most one, `planned`, naming the partner and the work packages it covers |

## The cross-package boundary

```text
delivery  ──requires──▶  contracts/delivery-obligations@1
   │                              │
   └── never imports contracts source, never reads its tables
```

The capability offers exactly three methods — read the contract's public facts,
list its pending obligations, mark selected ones handed over — created with the
**caller's** runtime handles so the obligation update commits inside the
delivery transaction. A package that did not declare the requirement is refused
even though the capability exists.

Failure is atomic across the boundary: inject a failure after any write,
including the obligation update, and no delivery record survives while every
obligation stays `pending_handover`. The retry produces exactly one complete
handover.

## Not modeled — stated, not implied

Delivery execution, progress, status transitions, time tracking, expenses,
cost, margin, resource scheduling, capacity, change requests, customer
acceptance, billing milestones, invoicing, partner access, partner portal,
revenue share, service contracts, entitlements, SLA and support cases.

The Admin says so on the screen, the schema says so in `notModeled`, and the
plan payload carries its own list.

## Evidence

`tests/delivery-handover-e2e.test.js`, `tests/admin-delivery.test.js`,
`tests/package-contract.test.js`, `packages/delivery/README.md`,
`examples/starters/b2b-lead-qualification/install.mjs`,
`docs/plans/milestone-13-delivery-handover.md`. Agent instructions:
`.claude/skills/build-delivery-handover/SKILL.md` (this file is the
Codex-readable mirror).
