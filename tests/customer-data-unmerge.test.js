import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROWS, boot, project } from './helpers/customer-data-project.js';
import { stripGeneratedModules } from './helpers/apply-module.js';
import { buildCustomerDataActions } from '../packages/customer-data/src/actions.js';
import { SPACE_AI_PERMISSION_DEFAULTS } from '../packages/space-permissions/src/permissions.js';

const ACTOR = { type: 'user', id: 'a3' };
const AGENT = { type: 'agent', id: 'bot' };

async function refusal(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, code: error.code ?? null, status: error.status ?? null, message: String(error.message) };
  }
}

async function scene(t, tag) {
  const root = project(t, {});
  stripGeneratedModules(root, []);
  const context = await boot(root, join(root, 'data', `${tag}.sqlite`));
  t.after(() => context.close());
  return context;
}

test('merge-duplicates is on by default and both merge and unmerge ask for confirmation', async () => {
  assert.equal(SPACE_AI_PERMISSION_DEFAULTS['merge-duplicates'], true, 'merge-duplicates defaults on');
  const actions = buildCustomerDataActions({});
  const link = actions.find((entry) => entry.name === 'link-canonical-identity');
  const unlink = actions.find((entry) => entry.name === 'unlink-canonical-identity');
  assert.ok(link, 'link action is declared');
  assert.ok(unlink, 'unlink action is declared');
  assert.equal(link.confirm, true, 'uncertain merges ask for confirmation');
  assert.equal(unlink.confirm, true, 'undoing a merge asks for confirmation');
  assert.deepEqual(link.fromStates, ['unresolved']);
  assert.deepEqual(unlink.fromStates, ['linked']);
});

test('dalla scheda si annulla un\u2019unione sbagliata: le due schede tornano separate', async (t) => {
  const { app } = await scene(t, 'unmerge-a3');
  const first = await app.services.companies.create({ name: 'Globex Srl', domain: 'globex.example' }, { actor: ACTOR });
  const second = await app.services.companies.create({ name: 'Globex Srl', domain: 'globex.example' }, { actor: ACTOR });
  await app.applyCustomerImport({ system: 'crm-export', rows: [{ companyName: 'Globex Srl', domain: 'globex.example' }], actor: ACTOR });

  const candidate = app.modules.get('duplicate-candidate').service.list({ limit: 10 })[0];
  assert.ok(candidate, 'ambiguity becomes a candidate, never an auto-merge');
  assert.equal(candidate.status, 'unresolved');

  const linked = await app.runAction({
    module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: candidate.id,
    input: { canonicalResource: 'company', canonicalId: first.id, reason: 'stessa azienda, importata due volte' }, actor: ACTOR,
  });
  assert.equal(linked.result.candidate.status, 'linked');

  const mergedFirst = await app.readCustomerProfile({ resource: 'company', id: first.id });
  const mergedSecond = await app.readCustomerProfile({ resource: 'company', id: second.id });
  assert.equal(mergedFirst.canonicalIdentity.linked, true, 'after merge both cards read one cluster');
  assert.equal(mergedSecond.canonicalIdentity.linked, true);
  assert.equal(mergedFirst.canonicalIdentity.members.length, 2);
  assert.equal(mergedSecond.canonicalIdentity.members.length, 2);
  assert.equal(mergedFirst.canonicalIdentity.clusterKey, mergedSecond.canonicalIdentity.clusterKey);

  const byAgent = await refusal(app.runAction({
    module: 'duplicate-candidate', action: 'unlink-canonical-identity', recordId: candidate.id,
    input: { reason: 'bot tries' }, actor: AGENT,
  }));
  assert.equal(byAgent.ok, false);
  assert.equal(byAgent.code, 'HUMAN_APPROVAL_REQUIRED');

  const undone = await app.runAction({
    module: 'duplicate-candidate', action: 'unlink-canonical-identity', recordId: candidate.id,
    input: { reason: 'due aziende diverse, stesso nome' }, actor: ACTOR,
  });
  assert.equal(undone.result.candidate.status, 'unresolved');
  assert.equal(undone.result.withdrawn, 2);

  const links = app.modules.get('canonical-link').service.list({ limit: 10 });
  assert.equal(links.length, 2, 'undoing withdraws, never deletes');
  assert.equal(links.every((row) => row.status === 'withdrawn'), true);
  assert.equal(links.every((row) => row.withdrawnReason === 'due aziende diverse, stesso nome'), true);

  const afterFirst = await app.readCustomerProfile({ resource: 'company', id: first.id });
  const afterSecond = await app.readCustomerProfile({ resource: 'company', id: second.id });
  assert.equal(afterFirst.canonicalIdentity.linked, false, 'first card stands alone again');
  assert.equal(afterSecond.canonicalIdentity.linked, false, 'second card stands alone again');
  assert.equal(afterFirst.canonicalIdentity.members.length, 1);
  assert.equal(afterSecond.canonicalIdentity.members.length, 1);

  const both = app.database.raw.prepare('SELECT COUNT(*) AS n FROM companies').get().n;
  assert.equal(both, 2, 'both records survive the merge and its undo');

  const again = await refusal(app.runAction({
    module: 'duplicate-candidate', action: 'unlink-canonical-identity', recordId: candidate.id,
    input: { reason: 'twice' }, actor: ACTOR,
  }));
  assert.equal(again.ok, false, 'an unmerged candidate cannot be unmerged twice');

  void ROWS;
});

test('unire di nuovo la stessa coppia dopo averla separata: nessun conflitto sulla chiave', async (t) => {
  const { app } = await scene(t, 'unmerge-relink-a3');
  const first = await app.services.companies.create({ name: 'Initech Srl', domain: 'initech.example' }, { actor: ACTOR });
  const second = await app.services.companies.create({ name: 'Initech Srl', domain: 'initech.example' }, { actor: ACTOR });
  await app.applyCustomerImport({ system: 'crm-export', rows: [{ companyName: 'Initech Srl', domain: 'initech.example' }], actor: ACTOR });

  const candidate = app.modules.get('duplicate-candidate').service.list({ limit: 10 })[0];
  assert.ok(candidate, 'ambiguity becomes a candidate, never an auto-merge');

  const linkInput = { canonicalResource: 'company', canonicalId: first.id, reason: 'stessa azienda' };
  const linked = await app.runAction({
    module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: candidate.id,
    input: linkInput, actor: ACTOR,
  });
  assert.equal(linked.result.candidate.status, 'linked');

  const undone = await app.runAction({
    module: 'duplicate-candidate', action: 'unlink-canonical-identity', recordId: candidate.id,
    input: { reason: 'controllo sbagliato, riprovo' }, actor: ACTOR,
  });
  assert.equal(undone.result.candidate.status, 'unresolved');

  const relinked = await app.runAction({
    module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: candidate.id,
    input: { canonicalResource: 'company', canonicalId: first.id, reason: 'stessa azienda, confermato' },
    actor: ACTOR,
  });
  assert.equal(relinked.result.candidate.status, 'linked', 'the same pair relinks with the same canonical');

  const rows = app.modules.get('canonical-link').service.list({ limit: 10 });
  assert.equal(rows.length, 2, 'relink reactivates the withdrawn history, it creates no duplicate rows');
  assert.equal(rows.filter((row) => row.status === 'active').length, 2, 'exactly 2 active rows after relink');

  const rereadFirst = await app.readCustomerProfile({ resource: 'company', id: first.id });
  const rereadSecond = await app.readCustomerProfile({ resource: 'company', id: second.id });
  assert.equal(rereadFirst.canonicalIdentity.linked, true, 'both cards read one cluster again');
  assert.equal(rereadSecond.canonicalIdentity.linked, true);
  assert.equal(rereadFirst.canonicalIdentity.clusterKey, rereadSecond.canonicalIdentity.clusterKey);

  void ROWS;
});
