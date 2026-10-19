# magic-link

Passwordless backoffice login (backlog:0cbae947, BO-F0-05): single-use links
valid for ten minutes, identical receipts for known and unknown addresses,
no passwords anywhere.

## What it owns

Two operations over injected edges:

- `request-magic-link` (`app.requestMagicLink({ email })`) — validates
  one login email, records a single-use token, and enqueues the link through
  the deployment outbox edge under the deterministic key
  `magic-link:<tokenId>` with the deployment send actor. A caller-supplied
  actor is never read: the request is unauthenticated, so `actor` is a
  server-controlled key — forgery in the request is stripped, never trusted.
  The receipt is byte-identical for known and unknown addresses, and both
  branches do the same work: mint, save, then one enqueue under the row's
  own key. The unknown branch spends its row BEFORE the enqueue, so its
  dummy job is never delivered (the worker below skips spent rows) — but an
  enqueue failure throws the same stable code on both branches. The receipt
  BODY cannot enumerate; timing can, so a latency oracle remains until
  per-address throttling lands (follow-up).
- `consume-magic-link` (`app.consumeMagicLink({ token })`) — redeems one link
  exactly once within ten minutes of issue. A second use, an expired link and
  an unknown token are all refused; expiry is re-checked with a fresh clock
  reading after the claim wins, so a token that crosses its deadline between
  the check and the claim still refuses instead of redeeming late.

Token rows carry only the HMAC of the address under a deployment-held
secret, never the address and never a fast unsalted hash. The link travels
only through the outbox edge, never in an API response. The outbox job
message IS delivery material — exactly `{ to, token, expiresAtIso }`,
nothing else — carrying a live Bearer [REDACTED] beside the mailbox for ten minutes:
the deployment MUST treat job payloads as transient secrets (never log
them, delete the job after settle, scope backups accordingly).

## What it needs

Five deployment-owned edges, passed to `createMagicLinkPackage()`:

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
- `store` (async `save`/`find`/`spend`) — `createMemoryMagicLinkStore()` is
  the local/test default. A durable deployment backs it with its database,
  where `spend` MUST stay one conditional write
  (`UPDATE ... SET spent WHERE tokenId = ? AND spent = false`), awaiting
  nothing between check and mark, so concurrent consumes still elect exactly
  one winner.
- `emailHashSecretRef` — the email-hash secret locator
  (`vault://<space>/<name>`, never the value; same shape as `site-forms`
  `ipHashSecretRef`), plus `resolveSecret(reference, { purpose })` to resolve
  it at call time. Without the secret there is no hash, and without the hash
  there is no row: missing custody refuses fail-closed, never with a receipt.
- `sendActor` (optional) — the actor the send runs under, validated with
  `requireActor` at wiring. Unset, the send runs under the login service
  system actor.

The deployment worker that executes the outbox job MUST re-read the token row
fresh (`await store.find(tokenId)`) and send only while the row exists, is unspent
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
    emailHashSecretRef: 'vault://production/magic-link-email-hash',
    resolveSecret: myVaultResolve,
    sendActor: myLoginServiceActor, // optional; unset means the login service system actor
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
