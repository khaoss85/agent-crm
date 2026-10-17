# Channels

The shared, space-scoped foundation every messaging channel builds on
(backlog:e5532d1c9146; contract: `docs/strategy/INTEGRATION_RUNTIME.md`).

## What it owns

- `channel-connection` — one channel account bound to one space:
  `{spaceId, channel, account, adapter, adapterVersion, status, secretRef}`.
  Every field is managed: registration is the only writer and every later
  change (activate, suspend, revoke, secret rotation) is an audited action.
- `channel-inbox-event` — append-only inbox of verified webhook
  deliveries: DB-unique per (space, connection, provider event id), payload
  fingerprint, explicit `effect` (`applied | ignored | quarantined |
  duplicate`), quarantine for unknown subjects and inactive connections.
- `channel-dead-letter` — failure inventory for sends that exhausted
  their bounded attempts: phase, normalized error code, payload
  fingerprint. Never the raw payload, never a secret.
- The adapter contract (`src/adapter.js`), the HMAC verification
  primitives (`src/crypto.js`), the operations (`src/operations.js`),
  the contract-test kit (`src/kit.js`) and the fixture adapter
  (`src/fixture.js`).

## What it needs

- Composition with adapters, a secret resolver and the bound tenant id:

```js
import { createChannelsPackage } from './packages/channels/src/index.js';

createChannelsPackage({
  channelAdapters: [fixtureChannelAdapterDefinition],
  resolveSecret: async (ref, { spaceId, purpose }) => vault.resolve(ref, spaceId),
  tenantId: boundTenantId,
});
```

- Registration is one static import in the project's composition file
  (this repository's `packages/domains/generated/index.js` stays empty —
  downstream projects compose what they need, like signature/commercial).
- Outbound delivery needs a running durable-job worker with the handlers
  from `registerChannelSendHandlers(registry, bindings)`; the kit drives
  one attempt at a time instead.

## How it is proven

- `tests/channels-contract.test.js` — pure contract: adapter validation,
  connection validation, HMAC verification, fingerprints.
- `tests/channels-operations.test.js` — behavior on real `:memory:`
  sqlite with real module services, the real durable-job store and the
  real worker: registration, activation, ingest (apply/replay/forgery/
  out-of-order/quarantine/verify-timeout/system-actor), send with retries
  and the dead-letter queue. Dead-letter requeue is deferred to a follow-up
  voice and has no test here.
- The kit: `runChannelAdapterKit({ adapter, secrets, harness })` — the
  same seven checks the acceptance names (receive, send, replay, bad
  signature, out-of-order) plus no-secrets and space isolation. The
  fixture adapter passes it; every real adapter must pass it before it
  ships.
- `npm run crm -- package validate packages/channels` and
  `npm run crm -- package test packages/channels` (DX4 conformance).

## What it deliberately does not do

- No real provider adapters (WhatsApp, Instagram, …): fixture only until
  credentials exist. No credential is invented, requested or stored.
- No per-space HTTP route: the pilot owns it and passes `spaceId` from
  the verified path, never from the body.
- No secret custody or rotation flow: the deployment resolves `secretRef`
  at call time; rotation replaces the referenced value without touching
  CRM data.
- No reconciliation against provider truth and no per-connection
  observability aggregates yet (follow-ups).
- No dead-letter requeue (human retry of an open letter): follow-up voice
  with its own state machine.
- Sends, registrations and status changes require
  `actor.type === 'user'`. Provider-driven ingest runs under a system
  actor after verification and ignores any caller-supplied actor.
