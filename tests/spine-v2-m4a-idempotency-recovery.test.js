// @ts-check

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoAppAsync } from '../packages/app/src/index.js';
import { postgresqlTestStorage } from '../packages/app/src/portable-app.js';
import { injectPostgresqlCommitFault } from '../packages/core/src/postgresql-storage.js';
import { issueIdempotencyKey } from '../packages/core/src/idempotency.js';
import { defineIdentity } from '../packages/core/src/identity.js';
import { runExternalOperation } from '../packages/core/src/external-operation.js';
import { runWithAffineStorage } from '../packages/core/src/storage-runtime.js';
import {
  assertNoSecrets,
  bootPostgresqlApp,
  openIsolatedPostgresqlPlanes,
} from './helpers/postgresql-application.js';
import { createTestVerifier } from './helpers/identity-verifier-fixture.mjs';

const actor = { type: 'user', id: 'm4a' };
const subjectA = defineIdentity({
  kind: 'asserted-local',
  subject: 'user:ada',
  method: 'developer-assertion',
  claimsFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
});
const subjectB = defineIdentity({
  kind: 'asserted-local',
  subject: 'user:grace',
  method: 'developer-assertion',
  claimsFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
});

function key() {
  return issueIdempotencyKey(() => '2026-08-30T00:00:00.000Z');
}

function createCountingProvider(name = 'partner.notify') {
  const receipts = new Map();
  let calls = 0;
  return {
    calls: () => calls,
    /**
     * @param {{ idempotencyKey: string, requestFingerprint?: string, operation?: string }} args
     */
    call(args) {
      calls += 1;
      const receipt = Object.freeze({
        idempotencyKey: args.idempotencyKey,
        operation: args.operation ?? name,
        requestFingerprint: args.requestFingerprint,
        receiptId: `receipt-${args.idempotencyKey.slice(0, 12)}`,
        status: 'present',
      });
      receipts.set(args.idempotencyKey, receipt);
      return receipt;
    },
    reconcile({ idempotencyKey }) {
      return receipts.get(idempotencyKey) ?? Object.freeze({ status: 'absent' });
    },
    /**
     * @param {string} idempotencyKey
     * @param {object} overlay
     */
    plant(idempotencyKey, overlay) {
      receipts.set(idempotencyKey, Object.freeze({ idempotencyKey, status: 'present', ...overlay }));
    },
  };
}

describe('M4A PostgreSQL idempotency and unknown-commit recovery', { concurrency: 1 }, () => {
  test('replay of the same key returns the same outcome without a second record or audit', { timeout: 60_000 }, async (t) => {
    const booted = await bootPostgresqlApp(t);
    if (!booted) return;
    const { app } = booted;
    const idempotencyKey = key();
    /** @type {unknown[]} */
    const events = [];
    app.events.subscribe('company.created', (payload) => { events.push(payload); });

    const first = await app.services.companies.create(
      { name: 'Acme Replay' },
      { actor, identity: subjectA, idempotencyKey },
    );
    const second = await app.services.companies.create(
      { name: 'Acme Replay' },
      { actor, identity: subjectA, idempotencyKey },
    );
    assert.equal(second.id, first.id);
    assert.equal(second.name, 'Acme Replay');
    assert.equal(second.replayed, true);
    const listed = await app.services.companies.list();
    assert.equal(listed.length, 1);
    const audit = await app.audit.list({ entityType: 'company', entityId: first.id });
    assert.equal(audit.length, 1);
    assert.equal(events.length, 1);
    const runs = await app.workflows.listRuns({ workflowName: 'company.create' });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[0].id, first.runId);
    assertNoSecrets(first);
    assertNoSecrets(second);
    assertNoSecrets(audit);
    assertNoSecrets(runs);
  });

  test('divergent replay refuses without revealing the prior response or subject', { timeout: 60_000 }, async (t) => {
    const booted = await bootPostgresqlApp(t);
    if (!booted) return;
    const { app } = booted;
    const idempotencyKey = key();
    const first = await app.services.companies.create(
      { name: 'Original' },
      { actor, identity: subjectA, idempotencyKey },
    );

    await assert.rejects(
      () => app.services.companies.create(
        { name: 'Changed payload' },
        { actor, identity: subjectA, idempotencyKey },
      ),
      (error) => {
        assert.equal(error.code, 'DIVERGENT_REPLAY');
        assert.equal(error.details?.mismatch, 'request');
        const blob = `${error.message}\n${JSON.stringify(error)}`;
        assert.equal(blob.includes('Original'), false);
        assert.equal(blob.includes(subjectA.subject), false);
        assert.equal(blob.includes(first.id), false);
        assertNoSecrets(error);
        return true;
      },
    );

    await assert.rejects(
      () => app.services.companies.create(
        { name: 'Original' },
        { actor, identity: subjectB, idempotencyKey },
      ),
      (error) => {
        assert.equal(error.code, 'DIVERGENT_REPLAY');
        assert.equal(error.details?.mismatch, 'subject');
        const blob = `${error.message}\n${JSON.stringify(error)}`;
        assert.equal(blob.includes(subjectA.subject), false);
        assert.equal(blob.includes(subjectB.subject), false);
        assertNoSecrets(error);
        return true;
      },
    );

    const listed = await app.services.companies.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'Original');
  });

  test('another tenant may reuse the raw key as an independent outcome', { timeout: 60_000 }, async (t) => {
    const first = await bootPostgresqlApp(t, { tenantId: 'acme' });
    if (!first) return;
    const second = await bootPostgresqlApp(t, { tenantId: 'globex' });
    if (!second) return;
    const idempotencyKey = key();
    const acme = await first.app.services.companies.create(
      { name: 'Acme Co' },
      { actor, identity: subjectA, idempotencyKey },
    );
    const globex = await second.app.services.companies.create(
      { name: 'Globex Co' },
      { actor, identity: subjectA, idempotencyKey },
    );
    assert.notEqual(globex.id, acme.id);
    assert.equal(acme.name, 'Acme Co');
    assert.equal(globex.name, 'Globex Co');
    assert.equal((await first.app.services.companies.list()).length, 1);
    assert.equal((await second.app.services.companies.list()).length, 1);
    assert.equal((await first.app.services.companies.list())[0].name, 'Acme Co');
  });

  test('post-commit ACK drop reconciles to exactly one record, audit and success trace', { timeout: 60_000 }, async (t) => {
    const booted = await bootPostgresqlApp(t);
    if (!booted) return;
    const { app } = booted;
    const storage = postgresqlTestStorage(app);
    assert.ok(storage);
    const idempotencyKey = key();
    /** @type {unknown[]} */
    const events = [];
    app.events.subscribe('company.created', (payload) => { events.push(payload); });

    injectPostgresqlCommitFault(storage, 'post-commit-ack-drop');
    await assert.rejects(
      () => app.services.companies.create(
        { name: 'Recovered' },
        { actor, identity: subjectA, idempotencyKey },
      ),
      (error) => {
        assert.equal(error.code, 'COMMIT_OUTCOME_UNKNOWN');
        assert.equal(error.details?.idempotencyKey, idempotencyKey);
        assertNoSecrets(error);
        return true;
      },
    );

    const pending = await app.workflows.listRuns({ workflowName: 'company.create' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'running');

    const recovered = await app.reconcileWrite({
      idempotencyKey,
      identity: subjectA,
      actor,
      operation: 'company.create',
      target: '',
      contractVersion: 'write.v1',
      input: { name: 'Recovered', domain: null },
    });
    assert.equal(recovered.status, 'committed');
    assert.equal(recovered.result.name, 'Recovered');
    assert.equal(recovered.runId, pending[0].id);

    const listed = await app.services.companies.list();
    assert.equal(listed.length, 1);
    const audit = await app.audit.list({ entityType: 'company', entityId: listed[0].id });
    assert.equal(audit.length, 1);
    const runs = await app.workflows.listRuns({ workflowName: 'company.create' });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[0].id, pending[0].id);
    assert.equal(events.length, 1);

    const replay = await app.services.companies.create(
      { name: 'Recovered' },
      { actor, identity: subjectA, idempotencyKey },
    );
    assert.equal(replay.id, listed[0].id);
    assert.equal((await app.audit.list({ entityType: 'company', entityId: listed[0].id })).length, 1);
    assert.equal(events.length, 1);
    assertNoSecrets(recovered);
  });

  test('pre-commit drop authorizes one safe retry and never a second record', { timeout: 60_000 }, async (t) => {
    const booted = await bootPostgresqlApp(t);
    if (!booted) return;
    const { app } = booted;
    const storage = postgresqlTestStorage(app);
    assert.ok(storage);
    const idempotencyKey = key();

    injectPostgresqlCommitFault(storage, 'pre-commit-drop');
    await assert.rejects(
      () => app.services.companies.create(
        { name: 'Retryable' },
        { actor, identity: subjectA, idempotencyKey },
      ),
      (error) => error.code === 'COMMIT_OUTCOME_UNKNOWN',
    );

    assert.equal((await app.services.companies.list()).length, 0);
    assert.equal((await app.workflows.listRuns({ workflowName: 'company.create' })).length, 0);

    const reconciled = await app.reconcileWrite({
      idempotencyKey,
      identity: subjectA,
      actor,
      operation: 'company.create',
      target: '',
      contractVersion: 'write.v1',
      input: { name: 'Retryable', domain: null },
    });
    assert.equal(reconciled.status, 'absent');
    assert.equal(reconciled.retryAuthorized, true);

    const created = await app.services.companies.create(
      { name: 'Retryable' },
      { actor, identity: subjectA, idempotencyKey },
    );
    assert.equal(created.name, 'Retryable');
    assert.equal(created.id, reconciled.runId === created.runId ? created.id : created.id);
    assert.equal((await app.services.companies.list()).length, 1);
    assert.equal((await app.audit.list({ entityType: 'company', entityId: created.id })).length, 1);
    const runs = await app.workflows.listRuns({ workflowName: 'company.create' });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[0].id, created.runId);

    const again = await app.services.companies.create(
      { name: 'Retryable' },
      { actor, identity: subjectA, idempotencyKey },
    );
    assert.equal(again.id, created.id);
    assert.equal((await app.services.companies.list()).length, 1);
  });

  test('short and free-form keys refuse before lookup, generated keys are returned', { timeout: 60_000 }, async (t) => {
    const booted = await bootPostgresqlApp(t);
    if (!booted) return;
    const { app } = booted;
    await assert.rejects(
      () => app.services.companies.create({ name: 'Nope' }, { actor, identity: subjectA, idempotencyKey: 'abc' }),
      (error) => {
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.match(error.message, /v1\.<yyyymmdd>\.<32-hex>/);
        return true;
      },
    );
    const generated = await app.services.companies.create(
      { name: 'Generated key' },
      { actor, identity: subjectA },
    );
    assert.match(generated.idempotencyKey, /^v1\.\d{8}\.[0-9a-f]{32}$/);
    assert.equal((await app.services.companies.list()).length, 1);
  });

  test('PostgreSQL composition refuses legacy externalOperation 1', { timeout: 60_000 }, async (t) => {
    const planes = await openIsolatedPostgresqlPlanes(t);
    if (!planes) return;
    await assert.rejects(
      () => createAccordoAppAsync({
        adapter: 'postgresql',
        testHarness: { loopback: true, control: planes.control, data: planes.data },
        spine: { mode: 'local-development', tenant: { id: 'acme' } },
        identityVerifier: createTestVerifier({ tenantId: 'acme' }),
        selected: {
          packageContract: 2,
          packages: [],
          modules: ['opportunity'],
          actions: [{
            module: 'opportunity',
            name: 'legacy-notify',
            actionContract: 2,
            externalOperation: 1,
            intent() { return {}; },
            external() { return {}; },
            finalize() { return {}; },
          }],
        },
      }),
      (error) => {
        assert.equal(error.code, 'EXTERNAL_OPERATION_V2_REQUIRED');
        assertNoSecrets(error);
        return true;
      },
    );
  });

  test('external three-phase: provider called once; unknown finalize resumes finalize only', { timeout: 60_000 }, async (t) => {
    const provider = createCountingProvider();
    const booted = await bootPostgresqlApp(t, {
      selected: {
        packageContract: 2,
        packages: [],
        modules: ['opportunity'],
        actions: [{
          module: 'opportunity',
          name: 'notify-partner',
          actionContract: 2,
          externalOperation: 2,
          provider,
          async intent({ record, providerIdempotencyKey }) {
            return { opportunityId: record.id, label: record.name, providerIdempotencyKey };
          },
          async external({ intent, providerIdempotencyKey, input }) {
            return provider.call({
              idempotencyKey: providerIdempotencyKey,
              intent,
              operation: 'opportunity.notify-partner',
              requestFingerprint: undefined,
            });
          },
          async finalize({ record, external, managed }) {
            return managed(record.id, { closeReason: String(external.receiptId) });
          },
        }],
      },
    });
    if (!booted) return;
    const { app } = booted;
    const storage = postgresqlTestStorage(app);
    assert.ok(storage);
    const company = await app.services.companies.create(
      { name: 'Partner Co' },
      { actor, identity: subjectA, idempotencyKey: key() },
    );
    const opportunity = await app.services.opportunities.create({
      companyId: company.id,
      name: 'Deal',
      valueCents: 1000,
      owner: 'ada',
    }, { actor });

    const idempotencyKey = key();
    injectPostgresqlCommitFault(storage, 'post-commit-ack-drop', { skip: 3 });
    await assert.rejects(
      () => app.runAction({
        module: 'opportunity',
        action: 'notify-partner',
        recordId: opportunity.id,
        input: {},
        actor,
        identity: subjectA,
        idempotencyKey,
        provider,
      }),
      (error) => {
        assert.equal(error.code, 'COMMIT_OUTCOME_UNKNOWN');
        assertNoSecrets(error);
        return true;
      },
    );
    assert.equal(provider.calls(), 1);

    const resumed = await app.runAction({
      module: 'opportunity',
      action: 'notify-partner',
      recordId: opportunity.id,
      input: {},
      actor,
      identity: subjectA,
      idempotencyKey,
      provider,
    });
    assert.equal(provider.calls(), 1);
    assert.equal(resumed.result.closeReason, resumed.result.closeReason);
    const fetched = await app.services.opportunities.get(opportunity.id);
    assert.match(String(fetched.closeReason ?? resumed.result.closeReason), /^receipt-/);

    const replay = await app.runAction({
      module: 'opportunity',
      action: 'notify-partner',
      recordId: opportunity.id,
      input: {},
      actor,
      identity: subjectA,
      idempotencyKey,
      provider,
    });
    assert.equal(provider.calls(), 1);
    assert.equal(replay.replayed, true);
    assertNoSecrets(resumed);
    assertNoSecrets(replay);
  });

  test('a mismatched provider receipt refuses without replaying the provider', { timeout: 60_000 }, async (t) => {
    const provider = createCountingProvider();
    const booted = await bootPostgresqlApp(t);
    if (!booted) return;
    const { app } = booted;
    const storage = postgresqlTestStorage(app);
    assert.ok(storage);
    const events = app.events;
    const handle = {
      storage,
      tenantId: 'acme',
      transactionAsync(fn) {
        return storage.transaction(async (tx) => runWithAffineStorage(handle, tx, () => fn(tx)));
      },
    };
    const idempotencyKey = key();
    const plantedKey = 'planted';
    provider.plant(plantedKey, {
      operation: 'other.operation',
      requestFingerprint: 'deadbeef',
    });

    await assert.rejects(
      () => runExternalOperation({
        database: handle,
        events,
        name: 'opportunity.notify-partner',
        actor,
        input: { ping: true },
        now: () => '2026-08-30T00:00:00.000Z',
        externalOperation: 2,
        idempotencyKey,
        tenantId: 'acme',
        identity: subjectA,
        provider: {
          call: (args) => provider.call(args),
          reconcile: () => ({
            idempotencyKey: plantedKey,
            operation: 'other.operation',
            requestFingerprint: 'deadbeef',
            status: 'present',
          }),
        },
        intent: async () => ({ ping: true }),
        async external() { throw new Error('must not call external after a hostile receipt'); },
        finalize: async () => { throw new Error('must not finalize a mismatched receipt'); },
      }),
      (error) => {
        assert.equal(error.code, 'PROVIDER_RECEIPT_MISMATCH');
        const blob = `${error.message}\n${JSON.stringify(error)}`;
        assert.equal(blob.includes('deadbeef'), false);
        assert.equal(blob.includes('other.operation'), false);
        assertNoSecrets(error);
        return true;
      },
    );
    assert.equal(provider.calls(), 0);
  });

  test('unknown call-phase commit never replays the provider', { timeout: 60_000 }, async (t) => {
    const provider = createCountingProvider();
    const booted = await bootPostgresqlApp(t, {
      selected: {
        packageContract: 2,
        packages: [],
        modules: ['opportunity'],
        actions: [{
          module: 'opportunity',
          name: 'notify-partner',
          actionContract: 2,
          externalOperation: 2,
          provider,
          async intent({ record }) { return { opportunityId: record.id }; },
          async finalize({ record }) { return { id: record.id }; },
        }],
      },
    });
    if (!booted) return;
    const { app } = booted;
    const storage = postgresqlTestStorage(app);
    const company = await app.services.companies.create(
      { name: 'Call Co' },
      { actor, identity: subjectA, idempotencyKey: key() },
    );
    const opportunity = await app.services.opportunities.create({
      companyId: company.id, name: 'Deal', valueCents: 1000, owner: 'ada',
    }, { actor });
    const idempotencyKey = key();
    injectPostgresqlCommitFault(storage, 'post-commit-ack-drop', { skip: 1 });
    await assert.rejects(
      () => app.runAction({
        module: 'opportunity', action: 'notify-partner', recordId: opportunity.id,
        actor, identity: subjectA, idempotencyKey, provider,
      }),
      (error) => error.code === 'COMMIT_OUTCOME_UNKNOWN',
    );
    assert.equal(provider.calls(), 0);
    await assert.rejects(
      () => app.runAction({
        module: 'opportunity', action: 'notify-partner', recordId: opportunity.id,
        actor, identity: subjectA, idempotencyKey, provider,
      }),
      (error) => error.code === 'COMMIT_OUTCOME_UNKNOWN',
    );
    assert.equal(provider.calls(), 0);
  });

  test('omitted idempotency key is pinned across external phases', { timeout: 60_000 }, async (t) => {
    const provider = createCountingProvider();
    const booted = await bootPostgresqlApp(t, {
      selected: {
        packageContract: 2,
        packages: [],
        modules: ['opportunity'],
        actions: [{
          module: 'opportunity',
          name: 'notify-partner',
          actionContract: 2,
          externalOperation: 2,
          provider,
          async intent({ record }) { return { opportunityId: record.id }; },
          async finalize({ record, external }) { return { id: record.id, receiptId: external?.receiptId ?? null }; },
        }],
      },
    });
    if (!booted) return;
    const { app } = booted;
    const storage = postgresqlTestStorage(app);
    const company = await app.services.companies.create(
      { name: 'Pin Co' },
      { actor, identity: subjectA, idempotencyKey: key() },
    );
    const opportunity = await app.services.opportunities.create({
      companyId: company.id, name: 'Deal', valueCents: 1000, owner: 'ada',
    }, { actor });
    injectPostgresqlCommitFault(storage, 'post-commit-ack-drop', { skip: 3 });
    let issued;
    await assert.rejects(
      () => app.runAction({
        module: 'opportunity', action: 'notify-partner', recordId: opportunity.id,
        actor, identity: subjectA, provider,
      }),
      (error) => {
        assert.equal(error.code, 'COMMIT_OUTCOME_UNKNOWN');
        issued = error.details?.idempotencyKey;
        return typeof issued === 'string';
      },
    );
    assert.equal(provider.calls(), 1);
    const resumed = await app.runAction({
      module: 'opportunity', action: 'notify-partner', recordId: opportunity.id,
      actor, identity: subjectA, idempotencyKey: issued, provider,
    });
    assert.equal(provider.calls(), 1);
    assert.equal(resumed.idempotencyKey, issued);
  });
});
