# Channels base — ExecPlan (backlog:e5532d1c9146, parte 1 di N)

## 1. Goal and user-visible outcome

Give Accordo a shared, space-scoped foundation for connecting messaging
channels (WhatsApp, Instagram, …): one `channel-connection` record per space
(channel, account, status, secret *reference* — never the secret), verified
per-space inbound webhooks (signature, dedup, quarantine), outbound sends
through the durable-jobs outbox (bounded retries, error queue), and a
contract-test kit a fake adapter passes today and every real adapter must
pass later. No real credentials exist yet (owner decision MEM_ACC_DECISIONS):
everything is proven against a fixture adapter.

This turn ships the smallest part that works alone: the `channels` domain
package in agent-crm. Remaining (supervisor opens child voices): platform
wiring of `secretRef` to runtime-vault custody, and the per-space inbound
endpoint on the shared app (accordo-arvo-pilot).

## 2. Current repository context

- Contract: `docs/strategy/INTEGRATION_RUNTIME.md` (connection shape,
  secret-ref-never-plaintext, webhook inbox, dead letter, kit).
- Reused, not duplicated: `packages/core` durable jobs
  (`createDurableJobStore/Worker/HandlerRegistry`, public), M11
  `packages/signature` inbox pattern (verify → DB-unique inbox →
  quarantine), provider-definition fingerprinting (ADR-015), module factory
  for records, ADR-032 app operations (`appMethod`).
- Naming check 2026-10-17: no `channel-connection`, `channel-inbox-event`,
  `channel-dead-letter`, `channel-send` record/handler exists on main —
  these are new; everything else below reuses.
- Package rules: `docs/PACKAGE_AUTHORING.md` + `.agents/skills/…/build-custom-domain-package/SKILL.md`;
  imports only from `packages/core/index.js`; no core change (ADR-018).

## 3. Milestones (each leaves the repo runnable)

1. Manifests `packages/channels/modules/*.module.json` (3 records, all
   evidence/managed except the operator-owned `secretRef` rotation field).
2. `src/adapter.js` + `src/crypto.js` + `src/connection.js`: adapter
   contract validation, HMAC verify, connection input validation.
3. `src/operations.js`: register / activate-suspend-revoke (actions) /
   ingest (verify→dedup→quarantine) / queue-send / durable-job send
   handler with dead letter / requeue.
4. `src/kit.js` + `src/fixture.js`: kit checks
   (receive, send, replay, bad signature, out-of-order, no-secrets,
   space isolation) + fixture adapter.
5. `src/index.js` + `README.md`: package definition, metadata with
   `notModeled`, no registration in `generated/index.js` (downstream
   projects compose it, like signature/commercial in this repo).
6. Tests `tests/channels-*.test.js` on real `:memory:` sqlite (real module
   services via `createRecordModuleFromManifest`, real durable-job store
   and worker): green + `npm run check` + `crm package validate`.

## 4. Validation

- `node --no-warnings --test tests/channels-contract.test.js tests/channels-operations.test.js`
- `npm run crm -- package validate packages/channels`
- `npm run crm -- package test packages/channels` (DX4 conformance)
- `npm run check` (heavy-job, < 5 min)
- Full suite: CI on the PR (never local).

## 5. Progress log

- 2026-10-17: plan written; verify-before-select done (nothing on main).
- 2026-10-17: manifests + src + tests written (see outcome row).

## 6. Decision log

- Secret resolution is an injected `resolveSecret(ref, {spaceId, purpose})`,
  never a core import: `secret-provider` is not on the public kernel
  surface, and the deployment (platform runtime-vault) owns custody.
- Ingest does not use the `runExternal` sequencer: v1 writes a single
  effect row (the inbox row carries the effect), so one transaction
  suffices; redelivery resumes unprocessed rows like M11.
- Outbound payloads carry `{spaceId, connectionKey, idempotencyKey,
  message}` only — the durable-jobs layer refuses `secret`-named keys
  anyway; the handler resolves the secret at execution time.
- Sends require `actor.type === 'user'` (M11 boundary); ingest is
  provider-driven (system actor).
- `secretRef` is the one public-writable field (operator rotation); every
  identity field is managed. `secretRotatedAt` is stamped at registration;
  the rotation flow is follow-up.
- No LEGACY_ALIGNMENT_MATRIX row: the kit is channels-scoped, not a
  horizontal kernel capability (rationale in PR body for review).

## 7. Outcome and follow-up

- PR with `backlog:e5532d1c` in title/body; outcome row names follow-ups:
  platform vault wiring, pilot per-space endpoint, secret rotation flow,
  reconciliation, observability per-connection.
