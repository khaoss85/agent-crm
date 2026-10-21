// @ts-check

/**
 * The call-transcript retention sweep in the shipped deployment (BO-F1-08,
 * backlog:588db7766206): composing `productionOperations.callRetention`
 * registers the purge handler on the composed registry, and a started worker
 * fires a deployment-seeded beat. Expiry is then enforced automatically —
 * without a seeded beat the worker fires nothing and expired transcripts
 * survive, which is the deployment's beat to own, not the framework's.
 *
 * Through the public async factory only: reaching into the portable starter
 * would prove the composition works where nobody composes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAccordoAppAsync } from '../packages/app/src/index.js';
import { trustedSystemActor } from '../packages/core/index.js';
import { seedCallTranscriptPurge } from '../packages/intelligence/src/call-intelligence.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const { createIntelligenceDomainV2 } = await import('../packages/intelligence/src/index.js');

/** The composing application claims the worker's system authority itself, for a reason it states. */
const WORKER_ACTOR = trustedSystemActor('running the call-retention sweep this application composed');
const OPERATOR = Object.freeze({ type: 'user', id: 'retention-operator' });
const TENANT = 'call-retention-tenant';
const SPACE = 'call-a';

function callManifests() {
  return ['call-notice', 'call-transcript', 'call-signal'].map((name) => ({
    name,
    manifest: JSON.parse(readFileSync(join(ROOT, 'packages', 'intelligence', 'modules', `${name}.module.json`), 'utf8')),
  }));
}

async function appWithRetention(t, productionOperations) {
  const app = await createAccordoAppAsync({
    dbPath: ':memory:',
    selected: {
      packageContract: 2,
      packages: [createIntelligenceDomainV2()],
      actions: [],
      modules: [...callManifests(), 'lead'],
    },
    productionOperations: {
      actor: WORKER_ACTOR, tenantId: TENANT, jobs: { pollIntervalMs: 25 }, ...productionOperations,
    },
  });
  t.after(() => app.close());
  return app;
}

const NOTICE = {
  spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1',
  callRef: 'call-old', channel: 'phone', noticedAt: '2025-09-01T09:00:00.000Z', actor: OPERATOR,
};

async function saveExpiredCall(app) {
  await app.operations.run('record-call-notice', NOTICE);
  await app.operations.run('save-call-transcript', {
    spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1',
    callRef: 'call-old', text: 'Cliente: il budget massimo è 800 euro.',
    recordedAt: '2025-09-01T10:00:00.000Z', actor: OPERATOR,
  });
}

async function readCall(app) {
  const read = await app.operations.run('read-customer-calls', {
    spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1',
  });
  assert.equal(read.calls.length, 1);
  return read.calls[0];
}

test('the posture names the composed retention sweep', async (t) => {
  const app = await appWithRetention(t, { callRetention: true });
  const posture = await app.productionOperations.status();
  assert.equal(posture.composed.callRetention, true, 'a receipt reads from the posture whether the sweep is composed');
});

test('a started worker fires a seeded beat: expiry is enforced automatically', async (t) => {
  const app = await appWithRetention(t, { callRetention: true });
  await saveExpiredCall(app);
  assert.equal((await readCall(app)).purgedAt ?? null, null, 'expired before any beat runs');

  const seeded = await seedCallTranscriptPurge({
    store: app.productionOperations.jobs, at: '2026-10-21T00:00:00.000Z', actor: WORKER_ACTOR,
  });
  assert.equal(seeded.seeded, true, 'the deployment owns the beat; the framework only runs it');

  app.productionOperations.start();
  let purged = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    purged = await readCall(app);
    if (purged.purgedAt) break;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  assert.ok(purged?.purgedAt, 'the sweep erased the expired transcript without an operator call');
  assert.equal(purged.transcript.available, false);
});

test('without a seeded beat the worker fires nothing: expired transcripts survive', async (t) => {
  const app = await appWithRetention(t, { callRetention: true });
  await saveExpiredCall(app);

  app.productionOperations.start();
  await new Promise((resolve) => { setTimeout(resolve, 500); });
  const call = await readCall(app);
  assert.equal(call.purgedAt ?? null, null, 'no beat, no purge: beats are deployment-owned');
  assert.equal(call.transcript.available, true, 'the text stays readable until a beat runs the sweep');
});

test('call retention without the intelligence records refuses at the wiring', async (t) => {
  await assert.rejects(
    () => createAccordoAppAsync({
      dbPath: ':memory:',
      selected: { packageContract: 2, packages: [], actions: [], modules: ['lead'] },
      productionOperations: {
        actor: WORKER_ACTOR, tenantId: TENANT, jobs: { pollIntervalMs: 25 }, callRetention: true,
      },
    }),
    (error) => error.code === 'PRODUCTION_OPERATIONS_INVALID' && /call-notice/.test(error.message),
    'the missing record is named at composition, not at the first beat',
  );
});
