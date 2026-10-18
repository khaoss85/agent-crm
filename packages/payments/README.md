# Payments

Stripe payments for commercial packages (backlog:1972e16d33f2).

## What it owns

- `payment-connection` — one Stripe account bound to one space (provider,
  account, status, secret *reference*). The secret itself is never stored:
  the deployment resolves it at call time through `resolveSecret`.
  A revoked binding returns only through the explicit `rebind-connection`
  action (new secret, back to pending, then activate): re-registering the
  same account is refused.
- `payment-request` — one payment intent from a quote (proposal) or an
  offer to its provider outcome: `open` (intent) → `pending` (checkout or
  payment link minted) → `paid` | `failed`; `open` | `pending` →
  `canceled`. Terminal states never regress. Amounts are integer minor
  units (ADR-014).
- `payment-event` — one verified provider webhook item per row, DB-unique
  per (space, connection, provider event id). A replay resolves
  identically; a different payload under the same id is a provider
  contract violation (409), never a second payment. Stripe sends one
  event per webhook delivery and never batches: `normalizeInbound`
  returns a single object, and a list-shaped body is refused (422),
  never silently mapped.

## What it needs

An adapter (`paymentAdapters`) and the deployment's secret custody
(`resolveSecret`). Both are optional at composition so validation and
conformance compose empty; every secret resolution refuses until wired.

```js
import { createPaymentsPackage } from './packages/payments/src/index.js';
import { createFixtureStripeAdapter } from './packages/payments/src/stripe.js';

const { definition } = createFixtureStripeAdapter({ secret: 'test-only' });
createPaymentsPackage({ paymentAdapters: [definition], resolveSecret });
```

Every payment-request state change goes through one function
(`advancePaymentRequest` in `src/transitions.js`): it re-reads the request
and its connection inside one transaction and derives the move from the
lifecycle table, so a mint racing another mint resolves to the same
checkout and a suspend racing a delivery quarantines instead of applying.
A suspend racing a mint holds the minted checkout reference on the open
intent instead of dropping it: the retry with the same key resumes that
session (no second mint), and its webhook still matches after
reactivation — a minted session is never left orphaned.

A deployment that renamed the record modules maps the canonical record
names to its own; anything else is refused, never silently ignored:

```js
createPaymentsPackage({ paymentAdapters: [definition], resolveSecret, modules: { 'payment-request': 'shop-payment-request' } });
```

## How to enable it

A project composes it like any domain package (docs/PACKAGE_AUTHORING.md
§8): one static import in its composition file. The customer card and the
sales pipeline read `getPaymentStatus` / `listPayments` — rendering those
surfaces is a follow-up voice.

## What it deliberately does not do

- Invoices: the request record is the payment, never a fiscal document.
- The per-space HTTP route: the pilot owns it and passes `spaceId` from
  the verified path.
- Real Stripe calls: the fixture models Checkout until credentials exist
  (owner decision MEM_ACC_DECISIONS).
- Retry of a failed request: a failed intent is terminal; a new
  `requestKey` starts a new intent.
- Reconciliation against provider truth.
