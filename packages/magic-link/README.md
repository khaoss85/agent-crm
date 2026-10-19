# magic-link

Passwordless backoffice login (backlog:0cbae947, BO-F0-05): single-use links
valid for ten minutes, identical receipts for known and unknown addresses,
no passwords anywhere.

## What it owns

Two operations over an injected token store:

- `request-magic-link` (`app.requestMagicLink({ email, actor? })`) — validates
  one login email, records a single-use token, and enqueues the link through
  the deployment outbox edge under the deterministic key
  `magic-link:<tokenId>` with an actor (the login-service system actor unless
  the deployment names its own). The receipt is byte-identical for known and
  unknown addresses, and both branches do the same store work, so the receipt
  is not a timing oracle either.
- `consume-magic-link` (`app.consumeMagicLink({ token })`) — redeems one link
  exactly once within ten minutes of issue. A second use, an expired link and
  an unknown token are all refused; expiry is re-checked with a fresh clock
  reading after the claim wins, so a token that crosses its deadline between
  the check and the claim still refuses instead of redeeming late.

Token rows carry a hash of the address, never the address. The link travels
only through the outbox edge, never in an API response.

## What it needs

Three deployment-owned edges, passed to `createMagicLinkPackage()`:

- `directory.lookup(normalizedEmail)` → `{ subject } | null` — the operator
  directory (in production: the control plane). Every operation refuses until
  the edges are wired; a directory outage fails closed, never as a fake success.
- `outbox.enqueue({ key, actor, message: { to, token, expiresAtIso } })`
  → `{ jobId }` — the persistent, idempotent claim. In production this edge is
  the channels outbox (`channel-send` job): the first enqueue under a key
  creates the job, a re-enqueue under the same key returns it, never a second
  send. There is no second send path. When the enqueue fails, the package
  spends the just-saved row before throwing, so a failed send never leaves a
  live orphan. The package itself performs no network I/O and holds no
  credential.
- `store` (`save`/`find`/`spend`) — `createMemoryMagicLinkStore()` is the
  local/test default. A durable deployment backs it with its database, where
  `spend` MUST stay one conditional write
  (`UPDATE ... SET spent WHERE tokenId = ? AND spent = false`) so concurrent
  consumes still elect exactly one winner.

The deployment worker that executes the outbox job MUST re-read the token row
fresh (`store.find(tokenId)`) and send only while the row exists, is unspent
and is unexpired (`isMagicLinkExpired` in `src/rules.js`); otherwise it skips
the job without sending. That is the whole worker protocol — three lines —
and `tests/magic-link-outbox.test.js` proves each skip against a fake worker
that follows it.

## What it deliberately does not do

- No email transport, no SMTP, no provider call — the send is the `outbox`
  edge, proven in this package's own outbox suite
  (`tests/magic-link-outbox.test.js`), following the same claim-first rule as
  the appointment reminders (AGENTS.md «Invii verso canali esterni»).
- No Google sign-in. The framework owns no OAuth client and emits no Google
  request: "Continua con Google" targets the deployment's entry, which the
  control plane already serves. This package never touches that path.
- No per-address throttling, no durable backing, no server routes, no
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
    outbox: myChannelSendOutbox,
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
node --no-warnings --test tests/magic-link.test.js tests/magic-link-rules.test.js tests/magic-link-outbox.test.js tests/admin-login.test.js
```

`package test` proves this package satisfies the **framework contract**. It
proves nothing about whether the domain logic is right — that is what this
package's own tests are for, and the report says so as
`DOMAIN_CORRECTNESS_NOT_PROVEN`.

Guides (in the framework repository, not copied into projects): https://github.com/khaoss85/agent-crm/blob/main/docs/PACKAGE_AUTHORING.md and ADR-018 in https://github.com/khaoss85/agent-crm/blob/main/DECISIONS.md.
