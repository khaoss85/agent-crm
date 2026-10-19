# magic-link

Passwordless backoffice login (backlog:0cbae947, BO-F0-05): single-use links
valid for ten minutes, identical receipts for known and unknown addresses,
no passwords anywhere.

## What it owns

Two operations over an injected token store:

- `request-magic-link` (`app.requestMagicLink({ email })`) — validates one
  login email; when the deployment directory knows it, records a single-use
  token and hands the link to the delivery edge. The receipt is byte-identical
  for known and unknown addresses.
- `consume-magic-link` (`app.consumeMagicLink({ token })`) — redeems one link
  exactly once within ten minutes of issue. A second use, an expired link and
  an unknown token are all refused.

Token rows carry a hash of the address, never the address. The link travels
only through the delivery edge, never in an API response.

## What it needs

Three deployment-owned edges, passed to `createMagicLinkPackage()`:

- `directory.lookup(normalizedEmail)` → `{ subject } | null` — the operator
  directory (in production: the control plane). Every operation refuses until
  the edges are wired; a directory outage fails closed, never as a fake success.
- `deliver.send({ to, token, expiresAtIso })` — called AFTER the token row is
  persisted (claim first, send second). In production this edge enqueues through
  the channels outbox; the package itself performs no network I/O and holds no
  credential.
- `store` (`save`/`find`/`spend`) — `createMemoryMagicLinkStore()` is the
  local/test default. A durable deployment backs it with its database, where
  `spend` MUST stay one conditional write
  (`UPDATE ... WHERE tokenId = ? AND spent = false`) so concurrent consumes
  still elect exactly one winner.

## What it deliberately does not do

- No email transport, no SMTP, no provider call — the send is the `deliver`
  edge, and outbox conformance (`tests/helpers/outbound-send-conformance.js`)
  is proven in the wiring turn, not here.
- No Google sign-in. The framework owns no OAuth client and emits no Google
  request: "Continua con Google" targets the deployment's entry, which the
  control plane already serves. This package never touches that path.
- No rate limiting per address, no durable backing, no server routes, no
  session cookies — those are the follow-up turns (see `notModeled` in
  `metadata()`).

## Enabling it

Composition is deliberate and manual. Add one line to
`packages/domains/generated/index.js`:

```js
import { createMagicLinkPackage } from '../../magic-link/src/index.js';

export const generatedDomains = [
  createMagicLinkPackage({
    directory: myOperatorDirectory,
    deliver: myOutboxDeliver,
    store: myDurableStore,
  }),
];
```

Deleting that line removes the package. Composing it unwired changes nothing:
every operation refuses with `MAGIC_LINK_NOT_CONFIGURED` until the edges exist.

## Proving it

```bash
npm run crm -- package inspect packages/magic-link
npm run crm -- package validate packages/magic-link
npm run crm -- package test packages/magic-link --json
node --no-warnings --test tests/magic-link.test.js tests/magic-link-rules.test.js
```

`package test` proves this package satisfies the **framework contract**. It
proves nothing about whether the domain logic is right — that is what this
package's own tests are for, and the report says so as
`DOMAIN_CORRECTNESS_NOT_PROVEN`.

Guides (in the framework repository, not copied into projects): https://github.com/khaoss85/agent-crm/blob/main/docs/PACKAGE_AUTHORING.md and ADR-018 in https://github.com/khaoss85/agent-crm/blob/main/DECISIONS.md.
