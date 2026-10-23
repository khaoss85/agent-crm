# Channels

The shared, space-scoped foundation every messaging channel builds on
(backlog:e5532d1c9146; contract: `docs/strategy/INTEGRATION_RUNTIME.md`).

## What it owns

- `channel-connection` — one channel account bound to one space:
  `{spaceId, channel, account, adapter, adapterVersion, status, secretRef,
  grantExpiresAt}`. Every field is managed: registration is the only writer
  and every later change (activate, suspend, revoke, secret rotation, grant
  renewal) is an audited action. `grantExpiresAt` is the provider-stated
  expiry of the grant, recorded as observed (null when the provider states
  none); `renew-connection-grant` records the new expiry after the human
  re-authorizes at the provider (BO-F1-04).
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
- `propose-channel-reply` / `send-approved-reply` / `read-channel-reply`
  — the backoffice reply flow (BO-F1-07): a human answer on the space
  connection for the preferred channel (or the named connection), drafted
  by the caller or the workspace LLM ("Scrivi con AI"), gated on the
  space's `send-without-approval` switch (off by default). With the switch
  off the reply waits as a `space-ai-proposal` row and nothing is
  enqueued; the approval authorizes exactly the proposed bytes (routing
  plus a text fingerprint), and the approved send rides the outbox with a
  provider receipt. The read model reports `pending-approval`,
  `approved`, `queued` (in consegna), `sent` (consegnato), `failed` or
  `refused`.

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

The reply flow (BO-F1-07) needs two more definitions composed beside
channels — `spacePermissions` (`space-permission-gate@1`) for the
approval gate and `llm` (`llm-complete@1`) for "Scrivi con AI" drafts:

```js
createChannelsPackage({
  channelAdapters: [whatsappDefinition],
  resolveSecret, tenantId, customerData,
  spacePermissions, // createSpacePermissionsDomain()
  llm, // createLlmPackage({ adapters, spaces, secretRef, resolveSecret })
});
```

Both stay optional at composition: without `spacePermissions` every
reply refuses (`CHANNEL_REPLY_GATE_MISSING`) instead of sending past the
approval; without `llm` only AI drafts refuse
(`CHANNEL_LLM_UNAVAILABLE`) while caller-drafted replies work as before.

- Registration is one static import in the project's composition file
  (this repository's `packages/domains/generated/index.js` stays empty —
  downstream projects compose what they need, like signature/commercial).
- Outbound delivery needs a running durable-job worker with the handlers
  from `registerChannelSendHandlers(registry, bindings)`; the kit drives
  one attempt at a time instead.

## Channel matrix (BO-F1-01, backlog:ffce3d1cd636)

Every backoffice channel rides the adapter contract above — one named,
versioned, fingerprinted definition per channel protocol, fake-backed
until the provider decision (no credentials exist yet, none are
invented). The five channels the space never sends through are
inbound-only by contract: both halves of their outbound path refuse
with `CHANNEL_SEND_UNSUPPORTED` (one shared definition in
`src/adapter.js`), which the queue path hands back intact and the kit
asserts instead of a delivery.

| Channel (BO-F1-01) | `channel` | Adapter (fake-backed) | Direction | Kit + test |
| --- | --- | --- | --- | --- |
| WhatsApp | `whatsapp` | `whatsapp-cloud@1` (`src/whatsapp.js`) | in + out (24-hour window, templates outside it) | `runChannelAdapterKit`, `tests/channels-whatsapp.test.js` |
| Instagram | `instagram` | `instagram-graph@1` (`src/instagram.js`) | in + out (24-hour window, 7 days with `HUMAN_AGENT`) | `runChannelAdapterKit`, `tests/channels-instagram.test.js` |
| Facebook (Messenger) | `facebook` | `messenger-graph@1` (`src/messenger.js`) | in + out (24-hour window, 7 days with `HUMAN_AGENT`) | `runChannelAdapterKit`, `tests/channels-messenger.test.js` |
| TikTok | `tiktok` | `tiktok-inbox@1` (`src/tiktok.js`) | in only — sends refuse `CHANNEL_SEND_UNSUPPORTED` | `runChannelAdapterKit`, `tests/channels-tiktok.test.js` |
| Email | `email` | `gmail-api@1` (`src/gmail.js`) | in + out (no service window; 90-day history import) | `runChannelAdapterKit`, `tests/channels-gmail.test.js` |
| Telefono/centralino | `voice` | `voice-pbx@1` (`src/voice.js`) | in only — sends refuse `CHANNEL_SEND_UNSUPPORTED` | `runChannelAdapterKit`, `tests/channels-voice.test.js` |
| Form sito | `site-form` | `site-form-inbox@1` (`src/site-form.js`) | in only — sends refuse `CHANNEL_SEND_UNSUPPORTED` | `runChannelAdapterKit`, `tests/channels-site-form.test.js` |
| Google Calendar | `calendar` | `calendar-push@1` (`src/calendar.js`) | in only — sends refuse `CHANNEL_SEND_UNSUPPORTED` | `runChannelAdapterKit`, `tests/channels-calendar.test.js` |
| Stripe | `stripe` | `stripe-webhook@1` (`src/stripe.js`) | in only — sends refuse `CHANNEL_SEND_UNSUPPORTED` | `runChannelAdapterKit`, `tests/channels-stripe.test.js` |

## How it is proven

- `tests/channels-contract.test.js` — pure contract: adapter validation,
  connection validation, HMAC verification, fingerprints.
- `tests/channels-operations.test.js` — behavior on real `:memory:`
  sqlite with real module services, the real durable-job store and the
  real worker: registration, activation, ingest (apply/replay/forgery/
  out-of-order/quarantine/verify-timeout/system-actor), send with retries,
  the dead-letter queue, and dead-letter requeue (one open letter retries
  with a human-supplied message; concurrent retries serialize — one wins,
  the other is refused without touching the winner's job).
- `tests/channels-reply.test.js` — the reply flow (BO-F1-07) on real
  `:memory:` sqlite with real channels and space-permissions modules, the
  real permission gate, the real outbox and worker, and the fixture LLM:
  switch off waits with nothing enqueued, approval sends the approved
  bytes with a provider receipt, refusal and pending never send,
  cross-space calls never touch another space, "Scrivi con AI" uses the
  composed adapter (and refuses without one), approval binds exact bytes
  (drift refuses), double approval sends once, failures read back failed.
- The kit: `runChannelAdapterKit({ adapter, secrets, harness })` — the
  checks the acceptance names (receive, send, replay, bad signature,
  out-of-order) plus no-secrets, space isolation and history. The
  fixture adapter passes it; every real adapter must pass it before it
  ships. The WhatsApp (`tests/channels-whatsapp.test.js`), Instagram
  (`tests/channels-instagram.test.js`), Messenger
  (`tests/channels-messenger.test.js`), Gmail
  (`tests/channels-gmail.test.js`), TikTok
  (`tests/channels-tiktok.test.js`), voice
  (`tests/channels-voice.test.js`), site-form
  (`tests/channels-site-form.test.js`), calendar
  (`tests/channels-calendar.test.js`) and Stripe
  (`tests/channels-stripe.test.js`) adapters pass it; for adapters
  behind a service window the kit seeds one windowed inbound before
  its send check, so the send proves the seeded window rather than an
  absent one; for inbound-only adapters the send check proves the
  contract refusal (`CHANNEL_SEND_UNSUPPORTED` through the real queue
  path, nothing reaching the provider) instead of a delivery.
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
- The Messenger Graph adapter (`src/messenger.js`,
  `tests/channels-messenger.test.js`): Page webhook bodies
  (`object: 'page'` with `entry[].messaging[]`) with hub
  signatures, on the same Meta app and the same shared module as
  Instagram — no copied rule. Subjects carry the `fb:` prefix on the
  `facebook` channel; echoes off our own page stay out of the inbox;
  replies ride the same 24-hour window (7 days with the
  `HUMAN_AGENT` tag) — against a fake transport, no credentials.
- The shared Meta webhook module (`src/meta-webhook.js`,
  `tests/channels-meta-webhook.test.js`): the one batch/echo/window
  logic every Meta adapter delegates to — full iteration of every
  `entry` in document order (Cloud API `changes[].value` and Graph
  `messaging[]`, so mixed deliveries never truncate to the first
  item), echo detection off the bound account (WhatsApp quarantines
  the echo as evidence, Instagram and Messenger leave it out of the
  inbox), the 24-hour window verdict over the server-resolved
  observation (absent/future/stale refuse, non-canonical is malformed),
  and the one hub-signature check every Meta adapter verifies before
  parsing.
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
- The five inbound-only adapters (`src/tiktok.js`, `src/voice.js`,
  `src/site-form.js`, `src/calendar.js`, `src/stripe.js` with their
  `tests/channels-*.test.js`): TikTok direct messages, PBX inbound
  calls, site submissions, calendar change pushes and Stripe event
  notifications, each with its subject rule (`tiktok:<handle>`,
  `tel:<E.164>`, `form:<submissionId>`, `calendar:<calendarId>`,
  `stripe:<type>`), each verified with the channel HMAC scheme, each
  refusing both outbound halves with the shared
  `CHANNEL_SEND_UNSUPPORTED` — against a fake transport, no credentials.
- The progressive initial history import (`tests/channels-initial-import.test.js`,
  backlog:66282d13d81c): adapters that declare readable past (`historyImport`
  with `windowMs` and `listHistory`) import it one bounded page per advance
  call — one inbox row per event through the same deduped path webhooks
  use, so a replayed page stores nothing twice and an interrupted import
  resumes from its stored cursor. An event's identity is its
  (connection, providerEventId): a re-listed event whose envelope drifted
  (a webhook-first echo later listed with its provider instant, a skewed
  redelivery) is adopted as a duplicate and the drift annotated on the
  outcome row with fixed package text — never a 409, so one drifted event
  can never brick the run. A poisoned event (a deterministic 4xx failure,
  whatever the attempt) is recorded failed and skipped while the page
  continues and the cursor advances; only transient failures abort with
  the cursor unmoved. Starting is idempotent: overlapping starts resolve
  to the single stored row. Every event writes one
  `channel-import-outcome` row under its unique (import, event) key and the
  progress counts those rows (one COUNT per state) instead of trusting hand
  tallies, so racing advances and crash retries converge to a clean run's
  numbers. Every applied sender reconciles through the composed
  `channel-sender@1` capability when present (matched, created, or an
  unresolved candidate for a human — never merged, never invented), and
  stays pending otherwise; a re-listed same event whose sender evidence
  now conflicts refines toward unresolved, reaching the same human
  confirm queue. Quarantined rows stay evidence and invent no
  contact. Progress is the `channel-import-state` row (cursor, phase, error
  code) plus the outcome COUNTs, readable per connection with
  `readInitialImport` and per space with `readSyncState`
  (backlog:f815763b7aa5): one entry per connection with its first-import
  progress plus the connected/completed totals. Only `active` connections
  whose adapter keeps a readable history count as connected
  (`importable: true`); an adapter without `historyImport` stays listed
  with `sync: null` and never holds the totals back. A connection whose
  import never started reads `sync: null`.
- `npm run crm -- package validate packages/channels` and
  `npm run crm -- package test packages/channels` (DX4 conformance).

## What it deliberately does not do

- No real provider adapters beyond WhatsApp, Instagram, Messenger,
  Gmail, TikTok, voice, site-form, calendar and Stripe: fixture only
  until credentials exist. No credential is invented, requested or
  stored. All nine are fake-backed until the provider decision: the same
  modes as the fixture, no provider edge (WhatsApp, Gmail, TikTok,
  voice, site-form, calendar and Stripe share the channel HMAC scheme;
  Instagram and Messenger verify hub signatures).
- No per-space HTTP route: the pilot owns it and passes `spaceId` from
  the verified path, never from the body.
- No secret custody or rotation flow: the deployment resolves `secretRef`
  at call time; rotation replaces the referenced value without touching
  CRM data.
- No reconciliation against provider truth beyond the initial history
  import. No automatic re-import of a completed connection, no calendar initial
  window, no Meta history adapters yet: those are the follow-up voices.
- No automatic retry of dead letters: every retry is a human-approved
  requeue of one open letter, never a silent loop.
- Sends, registrations, replies and status changes require
  `actor.type === 'user'`. Provider-driven ingest runs under a system
  actor after verification and ignores any caller-supplied actor.
