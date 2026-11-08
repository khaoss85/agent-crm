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

async function makeCandidate(app, left, right, tag) {
  const now = new Date().toISOString();
  return await app.modules.get('duplicate-candidate').service.createManaged({
    sourceKey: `duplicate:${left.resource}:${left.id}|${right.resource}:${right.id}:${tag}`,
    leftResource: left.resource,
    leftId: left.id,
    leftOwner: 'host',
    leftOwnerPackage: null,
    leftLabel: left.name,
    rightResource: right.resource,
    rightId: right.id,
    rightOwner: 'host',
    rightOwnerPackage: null,
    rightLabel: right.name,
    policy: 'test-overlap',
    policyVersion: 1,
    policyFingerprint: 'test',
    rule: 'test-overlap',
    evidence: '{}',
    status: 'unresolved',
    detectedByRunId: 'test',
    detectedAt: now,
  }, { actor: ACTOR });
}

test('disciplina delle sourceKey: una tabella per ogni caso deciso nei round', async (t) => {
  const { app } = await scene(t, 'unmerge-sourcekey-table');
  const alpha = await app.services.companies.create({ name: 'Alpha Srl', domain: 'alpha.example' }, { actor: ACTOR });
  const beta = await app.services.companies.create({ name: 'Beta Srl', domain: 'beta.example' }, { actor: ACTOR });
  const gamma = await app.services.companies.create({ name: 'Gamma Srl', domain: 'gamma.example' }, { actor: ACTOR });
  const subject = (company) => ({ resource: 'company', id: company.id, name: company.name });

  const links = () => app.modules.get('canonical-link').service.list({ limit: 50 });
  const baseKey = (canonId, memberId) => `canonical-link:cluster:company:${canonId}:company:${memberId}`;
  const rowsOf = (decisionId) => links().filter((row) => row.decisionId === decisionId);

  const link = (candidate, canonicalId, reason) => app.runAction({
    module: 'duplicate-candidate', action: 'link-canonical-identity', recordId: candidate.id,
    input: { canonicalResource: 'company', canonicalId, reason }, actor: ACTOR,
  });
  const unlink = (candidate, reason) => app.runAction({
    module: 'duplicate-candidate', action: 'unlink-canonical-identity', recordId: candidate.id,
    input: { reason }, actor: ACTOR,
  });

  // Coppia 1 (Alpha, Beta) e coppia 2 (Alpha, Gamma): stesso canonico,
  // chiavi base coincidenti sul membro condiviso Alpha.
  const first = await makeCandidate(app, subject(alpha), subject(beta), 'pair1');
  const second = await makeCandidate(app, subject(alpha), subject(gamma), 'pair2');
  const decision1 = `decision:${first.id}`;
  const decision2 = `decision:${second.id}`;
  const alphaBase = baseKey(alpha.id, alpha.id);

  // Riga 1 (round precedente): la prima unione crea le chiavi base.
  await link(first, alpha.id, 'stessa azienda');
  assert.equal(links().length, 2, 'riga 1: due righe con chiave base');
  assert.ok(links().every((row) => row.decisionId === decision1 && row.status === 'active'));

  // Riga 2 (round precedente): annullare ritira senza cancellare.
  await unlink(first, 'controllo sbagliato');
  assert.ok(links().every((row) => row.status === 'withdrawn'), 'riga 2: righe ritirate, mai cancellate');

  // Riga 3 (round precedente): riunire la stessa coppia riusa le chiavi base.
  await link(first, alpha.id, 'stessa azienda, confermato');
  assert.equal(links().length, 2, 'riga 3: nessun duplicato, la storia si riattiva');
  assert.ok(links().every((row) => row.sourceKey === baseKey(alpha.id, row.subjectId)
    && row.decisionId === decision1 && row.status === 'active'));
  await unlink(first, 'riprovo con altra coppia');

  // Riga 4 (questo round): la coppia sovrapposta non tocca la storia dell'altra.
  await link(second, alpha.id, 'stessa sede, ragione sociale diversa');
  assert.equal(links().length, 4, 'riga 4: due righe nuove, non due riusi rubati');
  const alphaSecond = links().find((row) => row.decisionId === decision2 && row.subjectId === alpha.id);
  assert.ok(alphaSecond, 'riga 4: il membro condiviso ha una sua riga');
  assert.equal(alphaSecond.sourceKey, `${alphaBase}:${decision2}`, 'riga 4: chiave distinta con suffisso di decisione');
  assert.equal(alphaSecond.status, 'active');
  const alphaFirst = links().find((row) => row.decisionId === decision1 && row.subjectId === alpha.id);
  assert.equal(alphaFirst.sourceKey, alphaBase, 'riga 4: la chiave base resta della prima decisione');
  assert.equal(alphaFirst.status, 'withdrawn', 'riga 4: la storia ritirata non si riattiva sotto altri');
  assert.equal(alphaFirst.withdrawnReason, 'riprovo con altra coppia', 'riga 4: motivo del ritiro intatto');

  // Riga 5 (questo round): i profili seguono solo le righe attive.
  const readAlpha = await app.readCustomerProfile({ resource: 'company', id: alpha.id });
  const readBeta = await app.readCustomerProfile({ resource: 'company', id: beta.id });
  const readGamma = await app.readCustomerProfile({ resource: 'company', id: gamma.id });
  assert.equal(readAlpha.canonicalIdentity.linked, true);
  assert.equal(readGamma.canonicalIdentity.linked, true);
  assert.equal(readAlpha.canonicalIdentity.clusterKey, readGamma.canonicalIdentity.clusterKey);
  assert.deepEqual(
    readAlpha.canonicalIdentity.members.map((member) => member.id).sort(),
    [alpha.id, gamma.id].sort(),
    'riga 5: Beta resta fuori dal cluster riattivato per sbaglio',
  );
  assert.equal(readBeta.canonicalIdentity.linked, false, 'riga 5: la scheda ritirata resta separata');

  // Riga 6 (questo round): annullare la seconda coppia ritira solo le sue righe.
  await unlink(second, 'altra sede, omonimia');
  assert.equal(rowsOf(decision1).filter((row) => row.status === 'withdrawn').length, 2);
  assert.equal(rowsOf(decision2).filter((row) => row.status === 'withdrawn').length, 2);
  assert.equal(links().filter((row) => row.status === 'active').length, 0, 'riga 6: niente attivo da nessuna parte');

  // Riga 7 (questo round): riunire la coppia sovrapposta riusa le SUE chiavi.
  await link(second, alpha.id, 'stessa sede, confermato');
  assert.equal(links().length, 4, 'riga 7: ancora quattro righe, nessun duplicato');
  assert.equal(rowsOf(decision2).filter((row) => row.status === 'active').length, 2);
  assert.ok(rowsOf(decision2).some((row) => row.sourceKey === `${alphaBase}:${decision2}`));
  assert.equal(rowsOf(decision1).filter((row) => row.status === 'withdrawn').length, 2,
    'riga 7: la prima storia resta ritirata');
  await unlink(second, 'lascio posto alla prima coppia');

  // Riga 8 (entrambi i round insieme): la prima coppia riusa ancora le basi.
  await link(first, alpha.id, 'prima coppia confermata');
  assert.equal(links().length, 4, 'riga 8: quattro righe in tutto, mai una di più');
  assert.equal(rowsOf(decision1).filter((row) => row.status === 'active').length, 2);
  assert.ok(rowsOf(decision1).every((row) => !row.sourceKey.endsWith(decision1)
    && !row.sourceKey.endsWith(decision2), 'riga 8: le basi non prendono suffissi'));
  assert.equal(rowsOf(decision2).filter((row) => row.status === 'withdrawn').length, 2);

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
