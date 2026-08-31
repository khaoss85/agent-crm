# Spine v4B — tenant-bound PostgreSQL backup, verify and restore

## Goal and user-visible outcome

Accordo gains one provider-neutral, PostgreSQL-only runtime contract that creates
an atomic backup bundle, verifies it without trusting its manifest as expected
intent, and restores only into an explicitly empty target. The built-in native
provider uses PostgreSQL 16 `pg_dump`/`pg_restore`; a restored data plane earns
writer authority only by passing the existing normal startup attestation,
tenant/resource binding and migration checks.

This slice adds no CLI, MCP or application operator facade, scheduler, managed
storage service, retention policy, clone promotion, automatic rebind, SQLite
production-backup claim, JTBD promotion or production-readiness claim.

## Current repository context

- `packages/core/src/postgresql-bootstrap.js` owns PostgreSQL migration identity,
  repository fingerprinting, startup audit, the data-plane binding marker and
  writer-lease authority. Backup code must consume its evidence, not duplicate
  startup or grant authority.
- `packages/core/src/startup-attestation.js` owns resource and migration-set
  fingerprints. Restore verification supplies expected intent independently;
  boot remains the final authority after bytes are restored.
- `packages/core/src/deployment-storage.js`, `packages/core/src/secret-provider.js`
  and `packages/app/src/create-app-async.js` keep connection credentials behind
  V4A secret leases. Backup manifests and errors never receive connection
  locators, secret references or values.
- `packages/core/src/trusted-file.js` and the existing child-process test helpers
  establish no-follow file handling, bounded lifecycle and credential-free
  refusal conventions.
- Repository Truth currently distinguishes the implemented bounded secret
  provider from the absent backup/restore remainder. This causal slice updates
  its executable authority but leaves managed backups and general readiness
  absent.

## Approaches considered

1. Implement a logical SQL exporter/importer in JavaScript. Rejected: it would
   duplicate PostgreSQL type, ownership, sequence, extension and DDL semantics
   and create a second database protocol.
2. Stream a native dump directly to a caller-selected file. Rejected: a crash
   can leave an apparently complete artifact with no committed manifest, and a
   manifest beside it can race independently.
3. Use an injected provider contract with a built-in native PostgreSQL 16
   implementation and stage a closed directory bundle before atomic rename.
   Chosen: native tools own database fidelity, injection gives deterministic
   tests without vendor coupling, and directory rename commits artifact plus
   manifest as one local bundle.

## Milestones

1. Add the closed backup contract, manifest parser/fingerprinter, SHA-256
   artifact verification, trusted bundle reads and stable SQLite/tool/version
   refusals. Add a bounded injected process runner whose timeout kills and
   observes the child without exposing arguments, environment or stderr.
2. Implement native PostgreSQL create and verify. Create stages `artifact.dump`
   and `manifest.json` in a sibling temporary directory, fsyncs/closes them,
   then atomically renames into a previously absent destination. The manifest
   contains contract, adapter, created instant, binding/resource/tenant,
   migration/repository fingerprints, artifact digest and the exact tool
   identity/version only.
3. Implement restore into an explicitly empty target. Verification compares
   the bundle against separately supplied expected tenant/resource/binding,
   migration and repository intent before `pg_restore`; the target emptiness
   probe runs before mutation. Partial failure leaves a stable failed receipt
   and never presents the target as promoted or rebound. Normal application
   boot is the final executable proof and may still refuse clone/resource
   mismatch.
4. Add deterministic fixture tests plus the mandatory PostgreSQL 16 hosted
   create → verify → restore → normal-boot scenario, tamper/wrong-intent/
   non-empty/missing-tool/timeout/leak cases, ADR and Legacy Alignment Matrix.
   Update executable Repository Truth only for the bounded self-host contract;
   reserve final combined status and measurement for integration.

## Validation

Use Node 22.16.0 through `fnm`.

- `node --test tests/spine-v4b-backup-restore.test.js`
- `node --test tests/spine-v4b-backup-restore-postgresql.test.js`
  - hosted CI must run PostgreSQL 16 with matching client tools and no skip;
  - representative data survives create/verify/restore and normal boot;
  - wrong tenant/resource/binding/migration/repository intent refuses before
    restore; a non-empty target refuses before mutation;
  - tampered bytes or manifest refuse; missing/wrong-major/hung tools return
    stable codes; partial failure stays visibly failed;
  - sentinel connection values/references/locators never occur in manifest,
    errors, diagnostics or child output.
- affected M3/M4/V4A startup and binding suites
- `npm run check`
- `npm run repo:truth -- --check`
- `npm run verify`
- `git diff --check`

## Progress log

- 2026-08-31: clean worktree verified; branch
  `claude/spine-v4b-backup-restore` created from exact
  `7993a05a9692601b5748075ce3bd565d81ca55aa`. Repository authorities and the
  V4A secret/pre-connect, M3 migration, attestation, binding and lease seams
  inspected. Selected approach 3 above.

## Decision log

- Contract v1 supports PostgreSQL only. SQLite returns a stable unsupported
  result; no file-copy path is labelled a production backup.
- Expected restore intent is caller-owned and closed. A bundle manifest is
  evidence to compare, never authority to choose a tenant or target.
- A native tool gets its connection environment directly from a short-lived
  secret consumer at execution time. That environment and the tool command
  line are never captured in receipts or errors.
- Restore never overwrites a live target and never grants writer authority.
  Successful byte import is followed by ordinary startup/attestation; failure
  there remains a refusal, not a promoted clone.

## Outcome and follow-up

Implementation pending. The integration campaign will later add the smallest
operator/app lifecycle surface and final combined truth. Managed scheduling,
retention, remote artifact custody, PITR, Cloud APIs and Arvo execution remain
future work.
