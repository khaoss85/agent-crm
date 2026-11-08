import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { ERASURE_INVENTORY } from '../packages/customer-data/src/erasure.js';

/**
 * Voce d271d723 (validazione B6), giro 6: one test per row of the erasure
 * inventory, plus failure injection. Each test seeds personal data of the
 * erased subject in ONE place, erases, and proves the PII is gone from that
 * place — including the export and the views of a kept customer — or that
 * the place is counted on the receipt as retained with its reason. The
 * failure tests prove the erasure is all or nothing: a failed read or write
 * leaves every row as it was, no registry row and no receipt.
 */

const OPERATOR = { type: 'user', id: 'titolare-1' };
const NAME = 'Guido';
const SURNAME = 'Presti';
const EMAIL = 'guido@palestra-esempio.it';
const PHONE = '+393331234567';

async function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const company = await app.services.companies.create({ name: 'Palestra Esempio', domain: 'palestra-esempio.it' });
  const erased = await app.services.contacts.create({
    companyId: company.id, firstName: NAME, lastName: SURNAME, email: EMAIL, role: 'Titolare',
  });
  const kept = await app.services.contacts.create({
    companyId: company.id, firstName: 'Maria', lastName: 'Rossi', email: 'maria@palestra-esempio.it',
  });
  return { app, company, erased, kept };
}

const svc = (app, name) => app.modules.get(name).service;
const envelope = (contact, prefix = 'subject', label = `${NAME} ${SURNAME} <${EMAIL}>`) => ({
  [`${prefix}Resource`]: 'contact', [`${prefix}Id`]: contact.id,
  [`${prefix}Owner`]: 'host', [`${prefix}OwnerPackage`]: null, [`${prefix}Label`]: label,
});

function erase(app, contact) {
  return app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta del cliente', actor: OPERATOR });
}

/** No trace of the erased person's name, email or phone anywhere in a value. */
function assertNoPii(value, where) {
  const text = JSON.stringify(value);
  for (const needle of [SURNAME, EMAIL, PHONE, '333 123', 'Guido Presti']) {
    assert.ok(!text.includes(needle), `${where} still carries «${needle}»`);
  }
}

async function registryRows(app, contact) {
  return svc(app, 'customer-erasure-log').listWhere({ subjectResource: 'contact', subjectId: contact.id });
}

test('the inventory names every place and an action for each', () => {
  const places = ERASURE_INVENTORY.map((entry) => entry.place);
  for (const place of ['contact', 'company', 'external-identity', 'enriched-field', 'custom-field-value',
    'canonical-link', 'duplicate-candidate', 'data-quality-issue', 'customer-import-row', 'enrichment-opt-out',
    'customer-bulk-item', 'customer-erasure-log', 'opportunity', 'other-package-rows', 'core-audit-trace']) {
    assert.ok(places.includes(place), `the inventory has a row for ${place}`);
  }
  for (const entry of ERASURE_INVENTORY) {
    assert.ok(['anonymize', 'exclude', 'retain'].includes(entry.action), `${entry.place} has a known action`);
  }
});

test('inventory: contact — name, email and role are anonymized', async (t) => {
  const { app, erased } = await scene(t);
  await erase(app, erased);
  const row = await app.services.contacts.get(erased.id);
  assertNoPii(row, 'the contact row');
  assert.equal(row.role, null);
});

test('inventory: company — a last contact takes its company name and domain with it', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const company = await app.services.companies.create({ name: 'Studio Presti', domain: 'studio-presti.it' });
  const only = await app.services.contacts.create({ companyId: company.id, firstName: NAME, lastName: SURNAME, email: EMAIL });
  const receipt = await erase(app, only);
  assert.ok(receipt.erasedSubjects.some((entry) => entry.resource === 'company' && entry.id === company.id));
  const row = await app.services.companies.get(company.id);
  assert.equal(row.name, 'Azienda cancellata', 'the company name is rewritten, not only hidden');
  assert.equal(row.domain, null);
  assertNoPii(row, 'the company row');
});

test('inventory: company erasure — the company and every contact are anonymized', async (t) => {
  const { app, company, erased, kept } = await scene(t);
  await app.eraseCustomer({ resource: 'company', id: company.id, confirm: true, reason: 'richiesta', actor: OPERATOR });
  assert.equal((await app.services.companies.get(company.id)).name, 'Azienda cancellata');
  assertNoPii(await app.services.contacts.get(erased.id), 'the cascaded contact');
  assert.equal((await app.services.contacts.get(kept.id)).firstName, 'Cliente');
});

test('inventory: external-identity — identifier, key and snapshot are redacted', async (t) => {
  const { app, erased } = await scene(t);
  await app.recordSubjectPhone({ resource: 'contact', id: erased.id, phone: PHONE, actor: OPERATOR });
  await erase(app, erased);
  const rows = await svc(app, 'external-identity').listWhere({ subjectResource: 'contact', subjectId: erased.id });
  assert.ok(rows.length > 0);
  assertNoPii(rows, 'the identity rows');
  const exported = await app.exportCustomerRecords({ resource: 'external-identity' });
  assertNoPii(exported.rows, 'the identity export');
});

test('inventory: enriched-field — value, detail, key and snapshot are purged', async (t) => {
  const { app, erased } = await scene(t);
  await svc(app, 'enriched-field').createManaged({
    sourceKey: `aiex:contact:${erased.id}:phone:note:${PHONE}`, ...envelope(erased),
    field: 'phone', value: PHONE, source: 'note', sourceDetail: `nota: chiamare ${NAME} ${SURNAME}`,
    observedAt: new Date().toISOString(), status: 'proposed', decisionReason: `${SURNAME} ha confermato`,
  }, { actor: OPERATOR });
  await erase(app, erased);
  const rows = await svc(app, 'enriched-field').listWhere({ subjectResource: 'contact', subjectId: erased.id });
  assert.equal(rows[0].status, 'purged');
  assertNoPii(rows, 'the enriched rows');
});

test('inventory: custom-field-value — the value is blanked', async (t) => {
  const { app, erased } = await scene(t);
  await svc(app, 'custom-field-value').createManaged({
    sourceKey: `cfv:contact:${erased.id}:nota`, subjectResource: 'contact', subjectId: erased.id,
    fieldKey: 'nota', value: JSON.stringify(`${NAME} ${SURNAME}, ${PHONE}`), updatedBy: 'titolare-1',
  }, { actor: OPERATOR });
  await erase(app, erased);
  const rows = await svc(app, 'custom-field-value').listWhere({ subjectResource: 'contact', subjectId: erased.id });
  assert.equal(rows[0].value, null);
  assertNoPii(rows, 'the custom-field values');
});

test('inventory: canonical-link — snapshot and reasons go, also on the kept member of an undone link (P1 label snapshots)', async (t) => {
  const { app, erased, kept } = await scene(t);
  const links = svc(app, 'canonical-link');
  const decided = { decisionId: 'd-1', decidedByType: 'user', decidedById: 'titolare-1', decidedAt: new Date().toISOString() };
  await links.createManaged({
    sourceKey: 'canonical-link:k1:a', clusterKey: 'k1', ...envelope(erased), role: 'alias', ...decided,
    reason: `${NAME} ${SURNAME} è la stessa persona`, status: 'withdrawn', withdrawnReason: `${SURNAME} non è Rossi`,
  }, { actor: OPERATOR });
  await links.createManaged({
    sourceKey: 'canonical-link:k1:b', clusterKey: 'k1', ...envelope(kept, 'subject', 'Maria Rossi'), role: 'canonical', ...decided,
    reason: `${NAME} ${SURNAME} è la stessa persona`, status: 'withdrawn', withdrawnReason: `${SURNAME} non è Rossi`,
  }, { actor: OPERATOR });
  await erase(app, erased);
  const rows = await links.listWhere({ clusterKey: 'k1' });
  assertNoPii(rows, 'the canonical-link rows');
  const keptRow = rows.find((row) => row.subjectId === kept.id);
  assert.equal(keptRow.subjectLabel, 'Maria Rossi', 'the kept member keeps its own snapshot');
  assertNoPii(await app.readCustomerProfile({ resource: 'contact', id: kept.id }), 'the kept contact profile');
  assertNoPii((await app.exportCustomerRecords({ resource: 'canonical-link' })).rows, 'the canonical-link export');
});

test('inventory: duplicate-candidate — the erased side, the evidence and the open pair go; the kept side stays (P1 pair export + P1 label snapshots)', async (t) => {
  const { app, erased, kept } = await scene(t);
  const candidates = svc(app, 'duplicate-candidate');
  await candidates.createManaged({
    sourceKey: `duplicate:contact:${erased.id}|contact:${kept.id}`,
    ...envelope(erased, 'left'), ...envelope(kept, 'right', 'Maria Rossi'),
    rule: 'cleanup-same-name', evidence: `external identity email:${EMAIL} already names this record`,
    status: 'unresolved', detectedAt: new Date().toISOString(),
  }, { actor: OPERATOR });
  const before = await app.readCustomerProfile({ resource: 'contact', id: kept.id });
  assert.ok(JSON.stringify(before).includes(EMAIL), 'the seeded pair shows on the kept card before the erasure');

  await erase(app, erased);
  const exported = await app.exportCustomerRecords({ resource: 'duplicate-candidate' });
  assert.equal(exported.rows.length, 0, 'a pair naming an erased subject on either side leaves the export');
  assert.equal(exported.erasedExcluded, 1, 'and the exclusion is counted');
  const [row] = await candidates.listWhere({ leftResource: 'contact', leftId: erased.id });
  assertNoPii(row, 'the stored candidate');
  assert.equal(row.rightLabel, 'Maria Rossi', 'the kept side keeps its own snapshot');
  assert.equal(row.status, 'dismissed', 'an open pair with an erased record is closed');
  assertNoPii(await app.readCustomerProfile({ resource: 'contact', id: kept.id }), 'the kept contact profile');
});

test('inventory: data-quality-issue — snapshot and evidence go, the open finding closes', async (t) => {
  const { app, erased } = await scene(t);
  await svc(app, 'data-quality-issue').createManaged({
    sourceKey: `issue:conflicting_external_identity:contact:${erased.id}`, kind: 'conflicting_external_identity',
    ...envelope(erased), evidence: `external identity phone:${PHONE} is active against more than one record`,
    detector: 'test', detectorVersion: 1, detectedAt: new Date().toISOString(), status: 'open',
  }, { actor: OPERATOR });
  await erase(app, erased);
  const rows = await svc(app, 'data-quality-issue').listWhere({ subjectResource: 'contact', subjectId: erased.id });
  assert.equal(rows[0].status, 'dismissed');
  assertNoPii(rows, 'the quality issues');
});

test('inventory: customer-import-row — snapshot and match evidence go', async (t) => {
  const { app, erased } = await scene(t);
  await svc(app, 'customer-import-row').createManaged({
    sourceKey: 'customer-import-row:r1:0', runId: 'r1', rowIndex: 0, inputDigest: 'x', outcome: 'accepted',
    reasonCode: 'MATCHED', reason: `external identity email:${EMAIL} already names this record`,
    matchRule: 'external-id', ...envelope(erased), createdSubject: false,
  }, { actor: OPERATOR });
  await erase(app, erased);
  const rows = await svc(app, 'customer-import-row').listWhere({ subjectResource: 'contact', subjectId: erased.id });
  assertNoPii(rows, 'the import receipts');
});

test('inventory: enrichment-opt-out — the instruction stays, its email snapshot goes', async (t) => {
  const { app, erased } = await scene(t);
  await svc(app, 'enrichment-opt-out').createManaged({
    sourceKey: `optout:contact:${erased.id}`, ...envelope(erased, 'subject', EMAIL),
    reason: `${NAME} non vuole`, optedOutAt: new Date().toISOString(),
  }, { actor: OPERATOR });
  await erase(app, erased);
  const rows = await svc(app, 'enrichment-opt-out').listWhere({ subjectResource: 'contact', subjectId: erased.id });
  assert.equal(rows.length, 1, 'the opt-out row stays');
  assertNoPii(rows, 'the opt-out');
});

test('inventory: customer-bulk-item — a failed decision on the subject loses its error text', async (t) => {
  const { app, erased } = await scene(t);
  const issue = await svc(app, 'data-quality-issue').createManaged({
    sourceKey: `issue:invalid_email:contact:${erased.id}`, kind: 'invalid_email', ...envelope(erased),
    evidence: 'x', detector: 'test', detectorVersion: 1, detectedAt: new Date().toISOString(), status: 'open',
  }, { actor: OPERATOR });
  await svc(app, 'customer-bulk-item').createManaged({
    sourceKey: 'customer-bulk-item:b1:0:x', runId: 'b1', itemIndex: 0, recordModule: 'data-quality-issue',
    recordId: issue.id, outcome: 'failed', code: 'CONFLICT', reason: `A contact already uses ${EMAIL}`,
    decidedAt: new Date().toISOString(),
  }, { actor: OPERATOR });
  await erase(app, erased);
  const rows = await svc(app, 'customer-bulk-item').listWhere({ recordId: issue.id });
  assert.equal(rows[0].reason, null);
  assertNoPii(rows, 'the bulk receipts');
});

test('inventory: customer-erasure-log — the registry row carries no personal data', async (t) => {
  const { app, erased } = await scene(t);
  await erase(app, erased);
  assertNoPii(await registryRows(app, erased), 'the registry');
});

test('inventory: opportunity and other-package rows — retained, counted with their reason', async (t) => {
  const { app, company, erased } = await scene(t);
  await app.services.opportunities.create({
    companyId: company.id, contactId: erased.id, name: 'Abbonamento palestra', valueCents: 10000, owner: 'titolare-1',
  });
  await svc(app, 'work-task').createManaged({
    sourceKey: 'task-1', title: 'richiamare', status: 'open', ...envelope(erased), openedByType: 'user', openedById: 'titolare-1',
  }, { actor: OPERATOR });
  const receipt = await erase(app, erased);
  const task = receipt.retained.find((entry) => entry.place === 'work-task');
  assert.equal(task?.rows, 1, 'the other package rows are counted, never silently left');
  assert.match(task.reason, /pacchetto proprietario/);
  assert.ok(receipt.retained.some((entry) => entry.place === 'opportunity' && entry.rows >= 1));
  assert.ok(receipt.retained.some((entry) => entry.place === 'core-audit-trace'), 'the core history is declared, never claimed erased');
  assertNoPii(receipt, 'the receipt');
});

/* ---------------------------------------------------------- fail closed */

test('fail closed (P1 swallowed read): a contact read that fails mid-erasure erases nothing and records nothing', async (t) => {
  const { app, erased } = await scene(t);
  const contacts = svc(app, 'contact');
  const original = contacts.get.bind(contacts);
  let calls = 0;
  contacts.get = async (id) => {
    calls += 1;
    if (calls > 1 && id === erased.id) throw new Error('SQLITE_IOERR: disk I/O error');
    return original(id);
  };
  await assert.rejects(
    () => erase(app, erased),
    (error) => error?.code === 'ERASURE_READ_FAILED' && error?.status === 409,
    'a failed read is never read as «not found»',
  );
  contacts.get = original;
  assert.equal((await registryRows(app, erased)).length, 0, 'no registry row, no success receipt');
  assert.equal((await app.services.contacts.get(erased.id)).email, EMAIL, 'nothing was rewritten');
});

test('fail closed: a failed inventory read after the contact rewrite rolls everything back', async (t) => {
  const { app, erased } = await scene(t);
  await app.recordSubjectPhone({ resource: 'contact', id: erased.id, phone: PHONE, actor: OPERATOR });
  const enriched = svc(app, 'enriched-field');
  const original = enriched.listWhere.bind(enriched);
  enriched.listWhere = async () => { throw new Error('SQLITE_BUSY'); };
  await assert.rejects(() => erase(app, erased), (error) => error?.code === 'ERASURE_READ_FAILED');
  enriched.listWhere = original;
  assert.equal((await registryRows(app, erased)).length, 0, 'no registry row');
  assert.equal((await app.services.contacts.get(erased.id)).lastName, SURNAME, 'the contact rewrite rolled back');
  const identities = await svc(app, 'external-identity').listWhere({ subjectResource: 'contact', subjectId: erased.id });
  assert.ok(identities.some((row) => row.status === 'active'), 'the identity rewrite rolled back');
});

test('fail closed: a failed inventory write rolls everything back', async (t) => {
  const { app, erased } = await scene(t);
  await svc(app, 'custom-field-value').createManaged({
    sourceKey: `cfv:contact:${erased.id}:nota`, subjectResource: 'contact', subjectId: erased.id,
    fieldKey: 'nota', value: JSON.stringify(NAME), updatedBy: 'titolare-1',
  }, { actor: OPERATOR });
  const values = svc(app, 'custom-field-value');
  const original = values.applyManaged.bind(values);
  values.applyManaged = async () => { throw new Error('SQLITE_FULL'); };
  await assert.rejects(() => erase(app, erased), (error) => error?.code === 'ERASURE_WRITE_FAILED');
  values.applyManaged = original;
  assert.equal((await registryRows(app, erased)).length, 0, 'no registry row');
  assert.equal((await app.services.contacts.get(erased.id)).firstName, NAME, 'the contact rewrite rolled back');
});
