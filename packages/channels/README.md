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
import { createCustomerDataPackage } from './packages/customer-data/src/index.js';
import { createChannelsPackage } from './packages/channels/src/index.js';

const customerData = createCustomerDataPackage();

createChannelsPackage({
  channelAdapters: [fixtureChannelAdapterDefinition],
  resolveSecret: async (ref, { spaceId, purpose }) => vault.resolve(ref, spaceId),
  tenantId: boundTenantId,
  customerData,
});
```

The `customerData` definition is the declared `customer-data /
channel-sender@1` edge: channels takes the created capability from its
published capabilities (the same handover appointments uses for work's
`follow-up@1`). Composing channels without customer-data refuses at boot
naming the edge; without the edge the history import refuses while
webhooks and sends keep working standalone.

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
  ships. The WhatsApp (`tests/channels-whatsapp.test.js`), Instagram
  (`tests/channels-instagram.test.js`) and Gmail
  (`tests/channels-gmail.test.js`) adapters pass it; for adapters
  behind a service window the kit seeds one windowed inbound before
  its send check, so the send proves the seeded window rather than an
  absent one.
- The WhatsApp Business Cloud adapter (`src/whatsapp.js`, fake-backed
  until the Meta decision): Meta inbound shapes (`messages[]`,
  `statuses[]`) normalized to a list with one inbox row per item in a
  single transaction (a batched webhook stores every item, never just
  the first); free text only inside the 24-hour window resolved
  server-side from the inbox (absent, future or stale observations
  refuse with `CHANNEL_TEMPLATE_REQUIRED`, intact through the queue
  path), approved templates outside it; the bound business line is
  required so self echoes and statuses to our own number quarantine;
  and the REST mapping as a pure function whose retained copy never
  holds the call-time secret.
- The Instagram Graph adapter (`src/instagram.js`,
  `tests/channels-instagram.test.js`): Graph webhook bodies
  (`object: 'instagram'` with `entry[].messaging[]`) with hub
  signatures, normalized to a list with one inbox row per message of
  every entry (echoes off our own account stay out); Graph replies
  with the 24-hour reply window (7 days with the `HUMAN_AGENT` tag)
  read from the inbox per space and connection — against a fake
  transport, no credentials.
- The Gmail API adapter (`src/gmail.js`,
  `tests/channels-gmail.test.js`): Gmail push notifications
  (`message.data` with the message id and thread id) with the channel
  HMAC scheme, normalized with the thread as the conversation subject
  (`email:<threadId>`, so a card reply with that thread id stays in
  the same thread); a sent copy looping back off the bound mailbox
  quarantines; email has no service window, so replies send at any
  time — against a fake transport, no credentials. It declares the
  history-import capability with the 90-day window: threads of the last
  90 days page oldest-first through the same normalizer the push path
  uses, each message carrying its sender for the import reconciliation.
- The progressive initial history import (`tests/channels-initial-import.test.js`,
  backlog:66282d13d81c): adapters that declare readable past (`historyImport`
  with `windowMs` and `listHistory`) import it one bounded page per advance
  call — one inbox row per event through the same deduped path webhooks
  use, so a replayed page stores nothing twice and an interrupted import
  resumes from its stored cursor. Every event writes one
  `channel-import-outcome` row under its unique (import, event) key and the
  progress counts those rows (one COUNT per state) instead of trusting hand
  tallies, so racing advances and crash retries converge to a clean run's
  numbers. Every applied sender reconciles through the composed
  `channel-sender@1` capability when present (matched, created, or an
  unresolved candidate for a human — never merged, never invented), and
  stays pending otherwise; quarantined rows stay evidence and invent no
  contact. Progress is the `channel-import-state` row (cursor, phase, error
  code) plus the outcome COUNTs, readable with `readInitialImport`.
- `npm run crm -- package validate packages/channels` and
  `npm run crm -- package test packages/channels` (DX4 conformance).

## What it deliberately does not do

- No real provider adapters beyond WhatsApp, Instagram and Gmail:
  fixture only until credentials exist. No credential is invented,
  requested or stored. All three are fake-backed until the provider
  decision: the same modes as the fixture, no provider edge (WhatsApp
  and Gmail share the channel HMAC scheme, Instagram verifies hub
  signatures).
- No per-space HTTP route: the pilot owns it and passes `spaceId` from
  the verified path, never from the body.
- No secret custody or rotation flow: the deployment resolves `secretRef`
  at call time; rotation replaces the referenced value without touching
  CRM data.
- No reconciliation against provider truth beyond the initial history
  import, and no per-connection observability aggregates yet (follow-ups).
  No automatic re-import of a completed connection, no calendar initial
  window, no Meta history adapters yet: those are the follow-up voices.
- No dead-letter requeue (human retry of an open letter): follow-up voice
  with its own state machine.
- Sends, registrations and status changes require
  `actor.type === 'user'`. Provider-driven ingest runs under a system
  actor after verification and ignores any caller-supplied actor.
