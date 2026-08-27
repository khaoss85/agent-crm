// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createDatabase } from '../packages/core/src/database.js';
import { TRANSACTION_PROOF, proveCallerTransaction } from '../packages/core/index.js';
import { activatedContract, boot, project, signedOrder } from './helpers/contracts-project.js';

/**
 * **Production Spine v2 M2D — proving the caller's transaction without the driver.**
 *
 * `packages/work/src/follow-up.js` used to read the SQLite driver's
 * `isTransaction` flag off the module service's database handle. One boolean,
 * bought by a business package holding the raw driver: `exec`, `prepare` and
 * every table in the application. It was the last business-consumer raw-driver
 * reach in the repository, and it survived three milestones because a plain
 * `database.raw` token scan does not see `tasks?.database?.raw`.
 *
 * Removing it turned out to be the smaller half of the milestone. Looking for a
 * second consumer found three more capabilities making the *same* atomicity
 * promise in their doc comments with **nothing checking it**, and all three were
 * measured committing partial writes outside a transaction:
 *
 *   - `contracts/delivery-obligations@1`.markHandedOver — one obligation left
 *     `handed_over`, carrying a `handoverRef` to a delivery project that would
 *     never exist, permanently un-handoverable because
 *     `OBLIGATION_ALREADY_HANDED_OVER` is terminal;
 *   - `contracts/service-obligations@1`.markActivated — the same defect wearing
 *     a different status column;
 *   - `contracts/contracts-successor-activation@1`.executeSuccession — a
 *     committed successor commercial agreement with **no lineage row**, so
 *     nothing on disk said which agreement it replaced.
 *
 * Those probes are the reason this file exists, and each is a test below. They
 * assert the post-fix guarantee — refuses, and commits nothing — because after
 * the fix the partial commit is unreachable; the measurements themselves are
 * recorded in `docs/plans/spine-v2-m2d-transaction-context.md` §2.
 */

/* ------------------------------------------------------------------ */
/* The structural guard                                               */
/* ------------------------------------------------------------------ */

/**
 * **What this guard is, stated exactly.**
 *
 * A *token scan* for the known spellings of direct driver access in the files
 * M2D migrated. It catches regression by editing — someone reaching for the
 * driver again — which is how the driver actually comes back.
 *
 * **It does not prove unreachability and must not be read as proving it.** No
 * regex can; the last test in this section pins three escapes it misses, so a
 * reader who assumes otherwise can run it and see.
 *
 * The list is deliberately identical to the one in
 * `tests/spine-v2-m2b-definition-version-store.test.js`. Two milestones scan for
 * the same thing, and a spelling added to one must be added to the other —
 * including the destructured forms, which the M2D search itself initially
 * missed until a planted synthetic match proved the first regex blind to them.
 */
const RAW_DRIVER_SPELLINGS = Object.freeze([
  // `database.raw`, `database?.raw`, `this.database.raw`
  /database\s*\??\.\s*raw\b/,
  // `.raw.prepare(`, `?.raw?.exec(`
  /\??\.\s*raw\s*\??\.\s*(?:prepare|exec)\s*\(/,
  // `database['raw']`, `database?.["raw"]`
  /database\s*\??\.?\s*\[\s*['"]raw['"]\s*\]/,
  // `const { raw } = database`, `const { raw, storage } = this.database`
  /\{[^{}]*\braw\b[^{}]*\}\s*=\s*[^;\n]*\bdatabase\b/i,
  // the driver constructor itself
  /\bDatabaseSync\b/,
]);

/** @param {string} source */
const rawDriverSpelling = (source) => RAW_DRIVER_SPELLINGS.find((pattern) => pattern.test(source)) ?? null;

/**
 * The files M2D moved off the driver, and only those.
 *
 * `packages/workflows/src/engine.js`, `packages/core/src/action-runtime.js`,
 * `packages/core/src/core-adapters.js` and `packages/core/src/spine-store.js`
 * still reach the driver deliberately — they are the kernel, not business
 * consumers — and this assertion makes no claim about them.
 */
const M2D_SLICE = Object.freeze([
  'packages/work/src/follow-up.js',
  'packages/work/src/index.js',
  'packages/contracts/src/capabilities.js',
  'packages/contracts/src/service-capability.js',
  'packages/contracts/src/succession.js',
  'packages/core/src/transaction-witness.js',
]);

test('no migrated file carries any known spelling of direct driver access', () => {
  for (const path of M2D_SLICE) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const found = rawDriverSpelling(source);
    assert.equal(found, null,
      `${path} must prove transactional context through the storage seam, but matched ${found}`);
  }
});

/**
 * **A guard nobody has watched fail is not a guard.** Every spelling the scan
 * claims to cover is pinned here, and each was additionally verified by
 * construction: written into `packages/work/src/follow-up.js`, the guard above
 * watched failing on that exact spelling, the file restored.
 */
test('the scan catches every spelling it claims to cover', () => {
  const escapes = [
    'const raw = tasks.database.raw;',
    'const raw = tasks?.database?.raw;',
    'const raw = tasks?.database.raw;',
    'const flag = deps.database ?. raw.isTransaction;',
    'const select = database.raw.prepare(sql);',
    'const select = database?.raw?.exec(sql);',
    "const raw = database['raw'];",
    'const raw = database["raw"];',
    "const raw = database?.['raw'];",
    'const { raw } = database;',
    'const { raw } = tasks.database;',
    'const { raw, storage } = this.database;',
    'const { raw: driver } = database;',
    'const db = new DatabaseSync(":memory:");',
  ];
  for (const escape of escapes) {
    assert.notEqual(rawDriverSpelling(escape), null, `the scan must catch: ${escape}`);
  }
  // …and it does not fire on the seam these files legitimately use, nor on
  // unrelated identifiers that merely contain the word.
  for (const allowed of [
    'const storage = service?.database?.storage;',
    'proveCallerTransaction([tasks, activities]);',
    'storage.activeTransaction();',
    'this.database.storage.sync.savepoint(name, fn);',
    'const rawBody = Buffer.from(params.rawBody);',
    "const kinds = ['raw', 'cooked'];",
  ]) {
    assert.equal(rawDriverSpelling(allowed), null, `the scan must allow: ${allowed}`);
  }
});

test('the scan is a token scan, and cannot prove unreachability', () => {
  for (const undetected of [
    "const d = database; const r = d['r' + 'aw'];",
    'const key = "raw"; const r = handle[key];',
    'const r = Reflect.get(database, "ra" + "w");',
  ]) {
    assert.equal(rawDriverSpelling(undetected), null,
      `this guard is a token scan and does not claim to catch: ${undetected}`);
  }
});

/* ------------------------------------------------------------------ */
/* The witness contract, at the level where a mistake is cheap to find */
/* ------------------------------------------------------------------ */

/**
 * A module service is `{database}` plus its write methods, so a service bound
 * to a handle is exactly that much. These fabricate the shapes the proof must
 * refuse — including the ones a real caller could not build by accident, which
 * is the point: the check must not be satisfiable by a stand-in.
 *
 * @param {any} database @param {{onWrite?: () => void}} [spy]
 */
function serviceOn(database, spy = {}) {
  return {
    database,
    createManaged: async () => { spy.onWrite?.(); return { id: 'written' }; },
    listWhere: () => { spy.onWrite?.(); return []; },
  };
}

test('the witness lives exactly as long as the transaction that minted it', (t) => {
  const db = createDatabase({ path: ':memory:' });
  t.after(() => db.close());
  const service = serviceOn(db);

  assert.equal(db.storage.activeTransaction(), null, 'nothing is open before a transaction');
  assert.equal(proveCallerTransaction([service]), TRANSACTION_PROOF.NO_TRANSACTION);

  let captured = null;
  db.transaction(() => {
    captured = db.storage.activeTransaction();
    assert.notEqual(captured, null, 'a transaction mints a witness');
    assert.equal(proveCallerTransaction([service]), TRANSACTION_PROOF.ACTIVE);
  });

  // Committed. The witness that was genuine one line ago names a transaction
  // that is over, and the handle no longer offers it.
  assert.equal(db.storage.activeTransaction(), null, 'a committed transaction drops its witness');
  assert.equal(proveCallerTransaction([service]), TRANSACTION_PROOF.NO_TRANSACTION);

  // …and the same after a rollback, which is the path a failure takes.
  assert.throws(() => db.transaction(() => { throw new Error('rolled back'); }), /rolled back/);
  assert.equal(db.storage.activeTransaction(), null, 'a rolled-back transaction drops its witness');
  assert.equal(proveCallerTransaction([service]), TRANSACTION_PROOF.NO_TRANSACTION);

  // A witness is opaque: there is nothing on it to read, copy or reconstruct.
  assert.deepEqual(Object.keys(/** @type {any} */ (captured)), []);
  assert.equal(Object.isFrozen(captured), true);
});

test('a different database handle proves nothing about this one', (t) => {
  const a = createDatabase({ path: ':memory:' });
  const b = createDatabase({ path: ':memory:' });
  t.after(() => { a.close(); b.close(); });

  // A transaction open on B says nothing about a write that will land on A.
  b.transaction(() => {
    assert.notEqual(b.storage.activeTransaction(), null, 'B genuinely has one open');
    assert.equal(proveCallerTransaction([serviceOn(a)]), TRANSACTION_PROOF.NO_TRANSACTION,
      'a transaction on another connection is not this connection\'s transaction');
  });

  // Two services that must commit together, on two connections, with a real
  // transaction open on the first: refused because they would commit into two
  // different transactions, which is not atomicity.
  a.transaction(() => {
    assert.equal(proveCallerTransaction([serviceOn(a), serviceOn(b)]), TRANSACTION_PROOF.SPLIT_STORAGE);
    assert.equal(proveCallerTransaction([serviceOn(a), serviceOn(a)]), TRANSACTION_PROOF.ACTIVE);
  });
});

test('a witness the core never minted is refused, whatever shape it wears', (t) => {
  const db = createDatabase({ path: ':memory:' });
  t.after(() => db.close());

  /** A handle that answers the question with something it made up. */
  const faking = (answer) => serviceOn({
    storage: { activeTransaction: () => answer },
  });

  for (const [label, answer] of [
    ['a plain boolean', true],
    ['the number one', 1],
    ['a non-empty string', 'active'],
    ['a bare object', {}],
    ['a frozen empty object, exactly the shape of a real one', Object.freeze({})],
    ['an object that dresses up as the old driver flag', { isTransaction: true }],
    ['a function', () => true],
    ['an array', []],
  ]) {
    assert.equal(proveCallerTransaction([faking(answer)]), TRANSACTION_PROOF.FORGED_WITNESS,
      `${label} must not satisfy the proof`);
  }

  // A genuine witness, minted for a REAL handle, presented by a fake one. This
  // is the closest a caller can get, and it is still refused: the witness is
  // bound to the handle it was minted for.
  db.transaction(() => {
    const genuine = db.storage.activeTransaction();
    assert.equal(proveCallerTransaction([faking(genuine)]), TRANSACTION_PROOF.FORGED_WITNESS);
    // …while the handle it belongs to is satisfied by it.
    assert.equal(proveCallerTransaction([serviceOn(db)]), TRANSACTION_PROOF.ACTIVE);
  });

  // A handle with no witness API at all, and one whose answer throws. Both are
  // "cannot prove", never "probably fine".
  assert.equal(proveCallerTransaction([serviceOn({ storage: {} })]), TRANSACTION_PROOF.NO_WITNESS_API);
  assert.equal(
    proveCallerTransaction([serviceOn({ storage: { activeTransaction: () => { throw new Error('nope'); } } })]),
    TRANSACTION_PROOF.NO_WITNESS_API,
  );
  // No handle at all.
  assert.equal(proveCallerTransaction([{}]), TRANSACTION_PROOF.NO_STORAGE);
  assert.equal(proveCallerTransaction([serviceOn(db), {}]), TRANSACTION_PROOF.NO_STORAGE);
  assert.equal(proveCallerTransaction([]), TRANSACTION_PROOF.NO_STORAGE);
});

/* ------------------------------------------------------------------ */
/* Work — the five negative evidences                                  */
/* ------------------------------------------------------------------ */

const WORK_REQUEST = Object.freeze({
  sourceKey: 'm2d:probe:1',
  title: 'Follow up',
  dueAt: null,
  subject: { resource: 'lead', id: 'lead-1', owner: 'host' },
  source: { package: 'host', action: 'qualify' },
});

/**
 * `createFollowUp` against fabricated services, so the refusal can be observed
 * with a write spy. The real composed application is exercised separately
 * below; this is where "before the first write" is actually provable.
 *
 * @param {string} root @param {any} tasksDb @param {any} activitiesDb @param {{onWrite: () => void}} spy
 */
async function callFollowUp(root, tasksDb, activitiesDb, spy) {
  const { createFollowUp } = await import(pathToFileURL(join(root, 'packages/work/src/index.js')).href);
  const tasks = serviceOn(tasksDb, spy);
  const activities = serviceOn(activitiesDb, spy);
  const modules = {
    get: (name) => ({ service: name === 'work-task' ? tasks : activities }),
  };
  return createFollowUp({ modules, actor: { type: 'user', id: 'e2e' } }, WORK_REQUEST);
}

test('Work refuses outside a transaction, on a foreign handle, after one ends, and to a forgery', async (t) => {
  // The package source is loaded from this checkout and the databases are made
  // here, so both share one core instance — the composition a deployment has.
  const root = new URL('..', import.meta.url).pathname;
  const a = createDatabase({ path: ':memory:' });
  const b = createDatabase({ path: ':memory:' });
  t.after(() => { a.close(); b.close(); });

  let writes = 0;
  const spy = { onWrite: () => { writes += 1; } };

  // 1. Outside a transaction — refused BEFORE the first write.
  await assert.rejects(
    () => callFollowUp(root, a, a, spy),
    (error) => {
      assert.equal(error.code, 'WORK_TRANSACTION_REQUIRED');
      assert.equal(error.status, 500);
      assert.match(error.message, /must be called inside the caller's transaction/);
      return true;
    },
  );
  assert.equal(writes, 0, 'it refused before touching storage — not after a partial write');

  // 2. A different database handle. The transaction is real; it is just not on
  //    the connection the write would land on.
  await b.transactionAsync(async () => {
    await assert.rejects(() => callFollowUp(root, a, a, spy), (error) => {
      assert.equal(error.code, 'WORK_TRANSACTION_REQUIRED');
      assert.match(error.message, /must be called inside the caller's transaction/);
      return true;
    });
  });
  assert.equal(writes, 0);

  // 3. The Task and the Activity on two connections, inside a real transaction
  //    on the first. Two handles cannot be one transaction.
  await a.transactionAsync(async () => {
    await assert.rejects(() => callFollowUp(root, a, b, spy), (error) => {
      assert.equal(error.code, 'WORK_TRANSACTION_REQUIRED');
      assert.match(error.message, /cannot prove it is running inside the caller's transaction/);
      assert.equal(error.details.proof, TRANSACTION_PROOF.SPLIT_STORAGE);
      return true;
    });
  });
  assert.equal(writes, 0);

  // 4. A transaction that has finished. The handle is genuine and was inside
  //    one moments ago; it is not now.
  let ended = false;
  await a.transactionAsync(async () => { ended = true; });
  assert.equal(ended, true);
  await assert.rejects(() => callFollowUp(root, a, a, spy), (error) => {
    assert.equal(error.code, 'WORK_TRANSACTION_REQUIRED');
    return true;
  });
  assert.equal(writes, 0);

  // 5. A forged witness: a handle that simply says yes.
  const forging = { storage: { activeTransaction: () => Object.freeze({}) } };
  await assert.rejects(() => callFollowUp(root, forging, forging, spy), (error) => {
    assert.equal(error.code, 'WORK_TRANSACTION_REQUIRED');
    assert.match(error.message, /cannot prove it is running inside the caller's transaction/);
    assert.equal(error.details.proof, TRANSACTION_PROOF.FORGED_WITNESS);
    return true;
  });
  assert.equal(writes, 0, 'no shape of forgery reached storage');
});

/**
 * The B2B starter's Lead path — the host consumer — with the Work records only.
 * @param {any} t @param {string} file
 */
async function leadProject(t, file) {
  const root = project(t, { withDomain: false, withWorkTables: true });
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    '// @ts-check',
    "import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';",
    'export const generatedActions = [qualifyLead];',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createWorkPackage } from '../../work/src/index.js';",
    'export const generatedDomains = [createWorkPackage()];',
    '',
  ].join('\n'));
  const { spawnSync } = await import('node:child_process');
  const applied = spawnSync(process.execPath, [
    '--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create',
    join(root, 'examples/starters/b2b-lead-qualification/lead.module.json'), '--apply', '--root', root,
  ], { encoding: 'utf8', cwd: root });
  assert.equal(applied.status, 0, applied.stderr);
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  return { root, context };
}

test('a fault between the Task and the Activity rolls both back, in the real application', async (t) => {
  const { root, context } = await leadProject(t, 'm2d-fault.sqlite');
  const { app } = context;
  const { createFollowUp } = await import(pathToFileURL(join(root, 'packages/work/src/index.js')).href);
  const lead = await app.modules.get('lead').service.create(
    { firstName: 'Fault', lastName: 'Client', email: 'fault@x.example' }, { actor: { type: 'user', id: 'e2e' } },
  );
  const tasks = app.modules.get('work-task').service;
  const activities = app.modules.get('work-activity').service;

  // The Activity write fails after the Task write has already landed on its own
  // SAVEPOINT. Only the enclosing transaction can undo the Task.
  const realCreate = activities.createManaged.bind(activities);
  activities.createManaged = async () => { throw new Error('injected fault between the pair'); };
  t.after(() => { activities.createManaged = realCreate; });

  await assert.rejects(
    () => app.database.transactionAsync(() => createFollowUp(
      { modules: app.modules, actor: { type: 'user', id: 'e2e' }, now: () => '2026-08-01T00:00:00.000Z' },
      { ...WORK_REQUEST, subject: { resource: 'lead', id: lead.id, owner: 'host' } },
    )),
    /injected fault between the pair/,
  );

  assert.equal(tasks.list().length, 0, 'the task rolled back with the activity that failed');
  assert.equal(activities.list().length, 0, 'and no half pair survives');
});

/* ------------------------------------------------------------------ */
/* Contracts — the three measured partial commits, now refused         */
/* ------------------------------------------------------------------ */

const OFFERS = ['fixture:offer:enterprise', 'fixture:offer:setup', 'fixture:offer:support-annual'];
const ACTOR = { type: 'user', id: 'e2e' };
const FOREIGN = 'not-an-obligation-of-this-contract';

test('delivery-obligations@1 refuses a handover outside a transaction, and commits nothing', async (t) => {
  const root = project(t, { withDelivery: true });
  const context = await boot(root, join(root, 'data', 'm2d-handover.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'M2D Handover', offers: OFFERS });

  const capability = app.domains.capability({
    consumer: 'delivery', capability: 'delivery-obligations', version: 1,
    context: { modules: app.modules, actor: ACTOR },
  });
  const service = app.modules.get('delivery-obligation').service;
  const pending = capability.listPending(contract.id);
  assert.ok(pending.length >= 1);

  // Outside a transaction this used to mark obligation[0] handed over and THEN
  // refuse, leaving it pointing at a delivery project that would never exist.
  await assert.rejects(
    () => capability.markHandedOver({
      contractId: contract.id, obligationIds: [pending[0].id, FOREIGN],
      handoverRef: 'outside', actor: ACTOR,
    }),
    (error) => {
      assert.equal(error.code, 'CONTRACT_TRANSACTION_REQUIRED');
      assert.equal(error.status, 500);
      return true;
    },
  );
  assert.deepEqual(
    service.get(pending[0].id).status, pending[0].status,
    'nothing was committed: the refusal lands before the first write, not after it',
  );
  assert.equal(service.get(pending[0].id).handoverRef, null);

  // Inside a transaction the same shape of failure still rolls back whole, and
  // a valid handover still succeeds — the refusal is about context, not input.
  await assert.rejects(
    () => app.database.transactionAsync(() => capability.markHandedOver({
      contractId: contract.id, obligationIds: [pending[0].id, FOREIGN],
      handoverRef: 'inside', actor: ACTOR,
    })),
    (error) => error.code === 'OBLIGATION_NOT_OF_CONTRACT',
  );
  assert.equal(service.get(pending[0].id).status, pending[0].status, 'rolled back whole');

  const marked = await app.database.transactionAsync(() => capability.markHandedOver({
    contractId: contract.id, obligationIds: pending.map((row) => row.id),
    handoverRef: 'a-real-project', actor: ACTOR,
  }));
  assert.equal(marked, pending.length, 'a legitimate handover inside a transaction is untouched');
});

test('service-obligations@1 refuses an activation outside a transaction, and commits nothing', async (t) => {
  const root = project(t, { withService: true });
  const context = await boot(root, join(root, 'data', 'm2d-service.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'M2D Service', offers: OFFERS });

  const capability = app.domains.capability({
    consumer: 'service', capability: 'service-obligations', version: 1,
    context: { modules: app.modules, actor: ACTOR },
  });
  const service = app.modules.get('service-obligation').service;
  const pending = capability.listPending(contract.id);
  assert.ok(pending.length >= 1);

  await assert.rejects(
    () => capability.markActivated({
      contractId: contract.id, obligationIds: [pending[0].id, FOREIGN],
      coverageRef: 'outside', actor: ACTOR,
    }),
    (error) => error.code === 'CONTRACT_TRANSACTION_REQUIRED',
  );
  assert.equal(service.get(pending[0].id).status, pending[0].status, 'nothing was committed');
  assert.equal(service.get(pending[0].id).coverageRef, null);

  await assert.rejects(
    () => app.database.transactionAsync(() => capability.markActivated({
      contractId: contract.id, obligationIds: [pending[0].id, FOREIGN],
      coverageRef: 'inside', actor: ACTOR,
    })),
    (error) => error.code === 'SERVICE_OBLIGATION_NOT_OF_CONTRACT',
  );
  assert.equal(service.get(pending[0].id).status, pending[0].status, 'rolled back whole');

  const marked = await app.database.transactionAsync(() => capability.markActivated({
    contractId: contract.id, obligationIds: pending.map((row) => row.id),
    coverageRef: 'a-real-coverage', actor: ACTOR,
  }));
  assert.equal(marked, pending.length, 'a legitimate activation inside a transaction is untouched');
});

test('contracts-successor-activation@1 refuses outside a transaction, and writes no successor', async (t) => {
  const root = project(t, { withLifecycle: true });
  const context = await boot(root, join(root, 'data', 'm2d-successor.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  const source = await activatedContract(root, app, { name: 'M2D Source', offers: OFFERS });
  const successor = await signedOrder(root, app, {
    name: 'M2D Renewal', offers: OFFERS,
    term: { effectiveDate: '2027-09-01', termStartDate: '2027-09-01', termEndDate: '2028-08-31' },
    company: source.company, contact: source.contact,
    quantities: { 'fixture:offer:enterprise': 30 },
  });
  const { POLICY } = await import('./helpers/contracts-project.js');

  const contracts = app.modules.get('commercial-contract').service;
  const successions = app.modules.get('contract-succession').service;
  const before = contracts.list({ limit: 100 }).length;

  const open = () => app.domains.capability({
    consumer: 'lifecycle', capability: 'contracts-successor-activation', version: 1,
    context: { modules: app.modules, domains: app.domains, actor: ACTOR },
  });
  const request = {
    sourceContractId: source.contract.id, successorOrderId: successor.order.id,
    ...POLICY, executionRef: 'm2d-outside', actor: ACTOR,
  };

  // Outside a transaction this used to commit the whole successor agreement and
  // then lose the lineage row to any failure after it.
  await assert.rejects(
    () => open().executeSuccession(request),
    (error) => {
      assert.equal(error.code, 'CONTRACT_TRANSACTION_REQUIRED');
      assert.equal(error.status, 500);
      return true;
    },
  );
  assert.equal(contracts.list({ limit: 100 }).length, before, 'no successor agreement was written');
  assert.equal(successions.list({ limit: 100 }).length, 0, 'and no lineage row either');

  // Inside a transaction, a fault after the agreement writes still rolls the
  // whole thing back — the guarantee `translateRace` has always claimed.
  const realCreate = successions.createManaged.bind(successions);
  successions.createManaged = async () => { throw new Error('injected fault before the lineage row'); };
  await assert.rejects(
    () => app.database.transactionAsync(() => open().executeSuccession({ ...request, executionRef: 'm2d-inside' })),
    /injected fault before the lineage row/,
  );
  successions.createManaged = realCreate;
  assert.equal(contracts.list({ limit: 100 }).length, before, 'rolled back whole');

  // …and the legitimate path is untouched.
  const executed = await app.database.transactionAsync(
    () => open().executeSuccession({ ...request, executionRef: 'm2d-real' }),
  );
  assert.equal(contracts.list({ limit: 100 }).length, before + 1);
  assert.equal(successions.list({ limit: 100 }).length, 1);
  assert.equal(executed.succession.sourceContractId, source.contract.id);
});
