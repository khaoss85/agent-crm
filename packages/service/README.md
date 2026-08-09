# `packages/service` — the Service domain package

The **third** domain package built under ADR-018, and the second that depends on
another package. M12 raised pending Service Obligations when a contract
activated and then stopped; this turns them into an operational support
relationship.

**It is not a second contract.** A **Service Coverage** is operational: nobody
signed it, it has no envelope, signer or artifact, and it neither amends nor
replaces the Commercial Contract it was activated from. The concept is called
*coverage* precisely so that nothing here reads as a signed agreement.

Full guide: [`docs/SERVICE_OPERATIONS.md`](../../docs/SERVICE_OPERATIONS.md).
Authoring a package of your own:
[`docs/PACKAGE_AUTHORING.md`](../../docs/PACKAGE_AUTHORING.md).

## What it needs

One declared capability, and nothing else:

```text
contracts/service-obligations@1
```

It imports nothing from `packages/contracts/src` and nothing from
`packages/core/src`. Removing the one static import in
`packages/domains/generated/index.js` removes the domain, and everything else
keeps working — including `service-obligations@1`, which contracts goes on
providing to nobody.

## What ships

```text
service-coverage        planned → active → ended
service-entitlement     immutable: what one obligation entitles the customer to
service-activation-run  immutable: which obligations were consumed, under which policy
support-case            new → in_progress → waiting_customer → resolved → closed
support-case-activity   append-only: notes, transitions, recorded replies, escalations
service-sla-evaluation  immutable: an elapsed-time judgement with the inputs it used
service-escalation      immutable: a human recorded that this was escalated
```

Ten actions, on the records they belong to:

```text
commercial-contract.plan-service-activation   read-only; writes nothing at all
commercial-contract.activate-service          human-only; consumes the obligations
service-coverage.end-service-coverage         human-only; closes no case, bills nothing
service-entitlement.record-service-case       human-only; entitlement enforced server-side
support-case.record-first-response            human-only; stamped exactly once
support-case.transition-case                  human-only; over a declared table
support-case.record-case-activity             human-only; append-only
support-case.preview-sla                      read-only; an agent may call it
support-case.record-sla-evaluation            human-only; evidence about an instant
support-case.record-escalation                human-only; routes and notifies nothing
```

Three read-only capabilities: `service-coverage@1`,
`service-case-management@1`, `service-sla-evidence@1`.

## Supply an activation policy

What an obligation entitles a customer to is a business decision, so it lives in
a versioned, fingerprinted policy rather than in code that reads a label:

```js
createServicePackage({ policies: [myServiceActivationPolicy] })
```

A policy may answer **`ambiguous`**, and that is the interesting case: an
obligation it cannot classify refuses activation until a human supplies an
override with a stated reason. A defaulted support tier is a promise nobody in
the business made.

## The SLA contract, stated exactly

```text
firstResponseDueAt = openedAt + firstResponseTargetMinutes
resolutionDueAt    = openedAt + resolutionTargetMinutes
```

Elapsed wall-clock minutes against the injected UTC clock. There is **no
business-hours calendar, no holiday table, no timezone interpretation and no
paused clock** — `waiting_customer` does not stop it, because a
half-implemented pause understates a breach. A recorded evaluation stores the
instant and the input values it used, so it is never mistaken for current truth.

## What it does not do

Billing, invoicing, payment or billing eligibility · a second legal contract or
any contract amendment · renewal or expansion · an authenticated customer or
agent portal · RBAC or tenancy · email, chat, WhatsApp or telephony · a contact
centre · attachment or file storage · a knowledge base · business-hours
calendars · a scheduler, automatic escalation or notification · customer-success
health scoring · Analytics Studio.
