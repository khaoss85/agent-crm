# Service operations (Milestone 15)

The **third** domain package built under ADR-018, and the second that depends on
another package. M12 raised pending Service Obligations when a contract
activated and then stopped; this turns them into an operational support
relationship.

**It is not a second contract.** A **Service Coverage** is operational: nobody
signed it, it has no envelope, signer or artifact, and it neither amends nor
replaces the Commercial Contract it was activated from. The concept is called
*coverage* precisely so that nothing here reads as a signed agreement.

Package README: `packages/service/README.md`. Authoring a package of your own:
`docs/PACKAGE_AUTHORING.md`.

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

## In the Admin

`apps/admin/public/admin-service.js` renders a **Service operations** section
under an activated contract, on the quote detail route. It is **package-scoped,
not package-owned**: the framework has no seam for a package to contribute an
Admin extension — AX1 publishes that as `ADMIN_EXTENSIONS_UNSUPPORTED` — so the
file lives in the Admin app and renders only while `/api/schema` publishes
`domains.service`. Remove the package and the section disappears rather than
degrading into a broken control.

It is state-aware in both directions. Before activation it offers planning and
nothing else, and while any obligation is undecided there is **no coverage form
and no activation control at all** — the screen never offers what the server
would refuse. After activation there is no second activation path. A case shows
exactly the transitions the declared table allows for its current state, a first
response is offered until it is stamped and never again, and a closed case shows
no transition control and says why.

The section carries the claims a reader would otherwise make on the framework's
behalf: that a ServiceCoverage is operational evidence and amends no commercial
record, that a listed channel does not mean a provider is connected, that no
notification was sent, and that an SLA state is elapsed wall-clock time rather
than a contractual or legal determination. Current SLA and recorded SLA are two
separate blocks, and previewing writes nothing.

`docs/ADMIN_SMOKE.md` carries the 24-check real-Chromium checklist for this
section — Service-specific, manual, and outside CI.

## What it does not do

Billing, invoicing, payment or billing eligibility · a second legal contract or
any contract amendment · renewal or expansion · an authenticated customer or
agent portal · RBAC or tenancy · email, chat, WhatsApp or telephony · a contact
centre · attachment or file storage · a knowledge base · business-hours
calendars · a scheduler, automatic escalation or notification · customer-success
health scoring · Analytics Studio.

## Why not a ServiceContract

Three shapes were compared in `docs/plans/milestone-15-service-operations.md`.
Hanging support off the Commercial Contract would mix a mutable operational
lifecycle into a record whose whole value is that it does not move. A second
legal `ServiceContract` would be a legal claim the framework cannot support:
this repository has exactly one signature path, producing exactly one signed
Order and one Commercial Contract, and a second "contract" nobody signed — with
no envelope, no signer and no artifact — would invite the question "which one is
authoritative?" that neither could answer.

The name is the trap. Anything called *Contract* here will be read as signed, so
the concept is **ServiceCoverage** and the first paragraph of every document
about it says what it is not.

## Evidence

`tests/service-operations-e2e.test.js` (the paths),
`tests/service-operations-evidence.test.js` (fault injection on every write,
two-connection races, exact reads past 500 rows, exact audit/event/trace counts,
the SLA boundaries, hostile input),
`tests/service-operations-integration.test.js` (AX1, AX2, detach),
`tests/admin-service.test.js` (the Admin section's claims and the controls it
must not offer), `docs/ADMIN_SMOKE.md` (24 real-Chromium checks),
`examples/starters/b2b-lead-qualification/install.mjs` (the full journey, from a
pending obligation to a closed case, with the commercial rows fingerprinted
before and after),
`examples/solution-plans/activate-support-and-manage-cases.plan.json`,
`packages/service/src/`,
`docs/plans/milestone-15-service-operations.md`.
