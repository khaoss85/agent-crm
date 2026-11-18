import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';

/**
 * Voce 4c8bd203b9e3: l'agente pilota «pulizia dei dati».
 *
 * Su dati di prova con un doppione (due schede con lo stesso nome
 * normalizzato) e una scheda senza prossimo passo, la scansione propone
 * l'unione e il passo: una riga `duplicate-candidate` irrisolta più un task
 * «Da fare» per l'unione, e un task «Da fare» per il passo mancante. Le
 * proposte non toccano mai le schede: i contatti, le aziende e le identità
 * restano identici prima e dopo, e l'unione vera passa dalle scritture
 * governate solo dopo la conferma umana (la riga resta `unresolved` con
 * `decidedBy` nullo).
 */

const AGENT = { type: 'agent', id: 'pulizia-test' };

async function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  assert.equal(typeof app.proposeDataCleanup, 'function', 'the customer-data package offers the cleanup operation');

  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const guido = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti',
    email: 'guido@palestra-esempio.it',
  });
  const guidoDup = await app.services.contacts.create({
    companyId: company.id, firstName: 'guido', lastName: '  PRESTI ',
    email: 'guido.presti@palestra-esempio.it',
  });
  const maria = await app.services.contacts.create({
    companyId: company.id, firstName: 'Maria', lastName: 'Rossi',
    email: 'maria@palestra-esempio.it',
  });

  // Guido ha già un prossimo passo (riga di fixture: la produzione apre i
  // task solo via follow-up@1, che la scansione sotto test usa davvero).
  const tasks = app.modules.get('work-task').service;
  await tasks.createManaged({
    sourceKey: 'fixture:existing-next-step',
    title: 'Richiama Guido per il rinnovo',
    status: 'open',
    dueAt: null,
    subjectResource: 'contact',
    subjectId: guido.id,
    subjectOwner: 'host',
    subjectOwnerPackage: null,
    subjectLabel: 'Guido Presti',
    sourcePackage: 'host',
    sourceAction: 'fixture',
    openedByType: 'user',
    openedById: 'fixture',
    openedAt: new Date().toISOString(),
    completedBy: null,
    completedAt: null,
    cancelledBy: null,
    cancelledAt: null,
    closingReason: null,
  }, { actor: { type: 'user', id: 'fixture' } });

  const snapshot = async () => JSON.stringify({
    contacts: await app.services.contacts.list({ limit: 500 }),
    companies: await app.services.companies.list({ limit: 500 }),
    identities: await app.modules.get('external-identity').service.list({ limit: 500 }),
  });
  return { app, company, guido, guidoDup, maria, snapshot };
}

const kindsFor = (receipt, subjectId) => receipt.proposals
  .filter((proposal) => proposal.subject?.id === subjectId)
  .map((proposal) => proposal.kind)
  .sort();

test('a duplicate pair proposes the merge and a card without a next step proposes the step', async (t) => {
  const { app, guido, guidoDup, maria, snapshot } = await scene(t);
  const before = await snapshot();

  const receipt = await app.proposeDataCleanup({ actor: AGENT });

  assert.equal(receipt.complete, true, 'the fixture fits in one scan window');
  assert.equal(receipt.tasksUnavailable, null, 'the reference composition wires the work edge');

  const merge = receipt.proposals.find((proposal) => proposal.kind === 'merge');
  assert.ok(merge, 'the duplicate pair proposes the merge');
  assert.equal(merge.rule, 'cleanup-same-name');
  assert.ok(merge.candidateId, 'the merge suspect is a stored duplicate-candidate row');
  assert.equal(merge.candidateReplayed, false, 'first run writes the candidate');
  assert.ok(merge.taskId, 'the merge is proposed in «Da fare»');
  assert.match(merge.title, /Possibile doppione da unire/);

  const candidates = await app.modules.get('duplicate-candidate').service
    .listWhere({ id: merge.candidateId });
  assert.equal(candidates.length, 1, 'exactly the proposed candidate row');
  assert.equal(candidates[0].status, 'unresolved', 'nothing is merged without a human decision');
  assert.equal(candidates[0].decidedByType, null, 'no decision is recorded by the scan');
  assert.equal(candidates[0].decidedById, null, 'no decider is recorded by the scan');

  assert.ok(kindsFor(receipt, maria.id).includes('next-step'), 'the card without a next step proposes the step');
  const step = receipt.proposals.find((proposal) => proposal.kind === 'next-step' && proposal.subject?.id === maria.id);
  assert.ok(step.taskId, 'the step is proposed in «Da fare»');
  assert.match(step.title, /Definisci il prossimo passo per Maria Rossi/);
  assert.ok(!kindsFor(receipt, guido.id).includes('next-step'), 'the card with an open task proposes no step');

  const mergeTask = (await app.modules.get('work-task').service.listWhere({ id: merge.taskId }))[0];
  assert.equal(mergeTask.status, 'open', 'the merge proposal waits in «Da fare»');
  assert.equal(mergeTask.sourcePackage, 'customer-data', 'provenance names the opener');
  const stepTask = (await app.modules.get('work-task').service.listWhere({ id: step.taskId }))[0];
  assert.equal(stepTask.subjectResource, 'contact');
  assert.equal(stepTask.subjectId, maria.id, 'the step names its own card');

  assert.equal(await snapshot(), before, 'the scan writes proposals only: no customer row moves');
});

test('a rerun replays the stored proposals and writes nothing twice', async (t) => {
  const { app, maria } = await scene(t);
  const first = await app.proposeDataCleanup({ actor: AGENT });
  assert.ok(first.counts.tasksWritten > 0, 'first run opens tasks');
  assert.ok(first.counts.candidatesWritten > 0, 'first run records the duplicate');

  const tasksBefore = (await app.modules.get('work-task').service.list({ limit: 500 })).length;
  const candidatesBefore = (await app.modules.get('duplicate-candidate').service.list({ limit: 500 })).length;

  const second = await app.proposeDataCleanup({ actor: AGENT });
  assert.equal(second.counts.tasksWritten, 0, 'no second task for the same finding');
  assert.equal(second.counts.candidatesWritten, 0, 'no second candidate for the same pair');
  assert.ok(second.counts.tasksReplayed > 0, 'the rerun replays');
  assert.ok(second.proposals.every((proposal) => proposal.taskReplayed === true || proposal.candidateReplayed === true),
    'every proposal answers its stored row');

  assert.equal((await app.modules.get('work-task').service.list({ limit: 500 })).length, tasksBefore);
  assert.equal((await app.modules.get('duplicate-candidate').service.list({ limit: 500 })).length, candidatesBefore);
  assert.ok(second.proposals.some((proposal) => proposal.kind === 'merge'
    && proposal.taskReplayed === true && proposal.candidateReplayed === true),
    'the rerun replays the merge proposal instead of writing it twice');
});

/**
 * Seguito backlog:088b639d96a2 (supervisore 17/11, prova del Mac): in
 * Presti restano due mittenti commerciali doppi con maiuscole diverse, che
 * la normalizzazione di #955 non copre. I due si LEGGONO con lo stesso
 * nome senza le maiuscole («MailUp» e «MAILUP», dopo il taglio del
 * qualificatore di #955), ma la scansione confronta le stringhe
 * memorizzate («mailup | teamsystem» contro «mailup») e resta muta.
 * La cura confronta i nomi letti della stessa famiglia
 * persona-identificativi, senza maiuscole. Rosso prima della cura (nessuna
 * unione proposta), verde dopo.
 */
test('two commercial senders reading the same name ignoring case propose the merge', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());

  const brand = await app.services.companies.create({ name: 'Palestra Esempio' });
  const first = await app.services.contacts.create({
    companyId: brand.id, firstName: 'MailUp | TeamSystem', lastName: '—',
    email: 'info@mailup.it',
  });
  const second = await app.services.contacts.create({
    companyId: brand.id, firstName: 'MAILUP', lastName: '—',
    email: 'info@mailup.com',
  });
  const other = await app.services.contacts.create({
    companyId: brand.id, firstName: 'Marco', lastName: 'Bianchi',
    email: 'marco@palestra-esempio.it',
  });
  const coFirst = await app.services.companies.create({ name: 'MailUp | TeamSystem' });
  const coSecond = await app.services.companies.create({ name: 'MAILUP' });

  // Two machine senders with no usable stored name both read «Google»
  // from their address: an email-fallback label never pairs strangers.
  const bounceA = 'aaa111bbb222ccc333-abc@identity-reachout.bounces.google.com';
  const bounceB = 'zzz999yyy888xxx777-def@identity-reachout.bounces.google.com';
  const ghostA = await app.services.contacts.create({
    companyId: brand.id, firstName: 'Mittente:', lastName: bounceA, email: bounceA,
  });
  const ghostB = await app.services.contacts.create({
    companyId: brand.id, firstName: 'Mittente:', lastName: bounceB, email: bounceB,
  });

  const receipt = await app.proposeDataCleanup({ actor: AGENT });

  const merges = receipt.proposals.filter((proposal) => proposal.kind === 'merge');
  const contactMerge = merges.find((proposal) => proposal.rule === 'cleanup-same-name'
    && (proposal.subject?.id === first.id || proposal.subject?.id === second.id));
  assert.ok(contactMerge, 'the two senders reading the same name ignoring case propose the merge');
  assert.ok(contactMerge.candidateId, 'the merge suspect is a stored duplicate-candidate row');
  assert.match(contactMerge.evidence, /ignoring case/, 'the evidence says the match ignores case');
  assert.ok(contactMerge.title.includes('MailUp') && contactMerge.title.includes('MAILUP'),
    'the proposal names the two readings the Mac sees double');

  const companyMerge = merges.find((proposal) => proposal.rule === 'cleanup-same-company'
    && (proposal.subject?.id === coFirst.id || proposal.subject?.id === coSecond.id));
  assert.ok(companyMerge, 'the two companies reading the same name ignoring case propose the merge');

  const namesOthers = merges.filter((proposal) => proposal.rule === 'cleanup-same-name'
    && (proposal.subject?.id === other.id || proposal.subject?.id === ghostA.id || proposal.subject?.id === ghostB.id));
  assert.equal(namesOthers.length, 0, 'no merge names an unrelated card or an email-fallback label');
});

/**
 * Review rev-agent-crm-1034-4e5a7669 (P2, backlog:088b639d96a2): the guard
 * above only drops stored names that read null, so two strangers whose
 * stored names are machine tokens of their own technical address — or the
 * materialised «Google —» the lead path stores from it — both read the
 * email fallback «Google» and pair as duplicates. Rosso prima della cura
 * (unione proposta tra estranei), verde dopo (nessuna unione).
 */
test('two strangers reading the same email-fallback label propose no merge', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());

  const brand = await app.services.companies.create({ name: 'Palestra Esempio' });
  const bounce = (local) => `${local}@identity-reachout.bounces.google.com`;
  // Token-derived stored names: the lead path splits the machine local
  // part, so readableName(stored) is non-null while contactDisplayName
  // discards it (isTokenName) and falls back to the domain label.
  const tokenA = await app.services.contacts.create({
    companyId: brand.id, firstName: 'Aaa111bbb222ccc333', lastName: 'Abc',
    email: bounce('aaa111bbb222ccc333-abc'),
  });
  const tokenB = await app.services.contacts.create({
    companyId: brand.id, firstName: 'Zzz999yyy888xxx777', lastName: 'Def',
    email: bounce('zzz999yyy888xxx777-def'),
  });
  // Materialised form: both stored as «Google —» from different bounce
  // addresses, reading the same email fallback.
  const storedA = await app.services.contacts.create({
    companyId: brand.id, firstName: 'Google', lastName: '—',
    email: bounce('qwer1234tyui5678opas-ghi'),
  });
  const storedB = await app.services.contacts.create({
    companyId: brand.id, firstName: 'Google', lastName: '—',
    email: bounce('mnbv0987lkjh6543zxcv-poi'),
  });

  const receipt = await app.proposeDataCleanup({ actor: AGENT });

  const ghosts = [tokenA.id, tokenB.id, storedA.id, storedB.id];
  const ghostMerges = receipt.proposals.filter((proposal) => proposal.rule === 'cleanup-same-name'
    && (ghosts.includes(proposal.subject?.id) || ghosts.some((id) => proposal.evidence?.includes(id))));
  assert.equal(ghostMerges.length, 0, 'no merge pairs strangers sharing only the email-fallback label');
});

test('a card with no phone proposes the completion, with the customer rows untouched', async (t) => {
  const { app, maria, snapshot } = await scene(t);
  const before = await snapshot();

  const receipt = await app.proposeDataCleanup({ actor: AGENT });
  const completion = receipt.proposals.find(
    (proposal) => proposal.kind === 'missing-phone' && proposal.subject?.id === maria.id,
  );
  assert.ok(completion, 'the phoneless card proposes the completion');
  assert.ok(completion.taskId, 'the completion is proposed in «Da fare»');
  assert.match(completion.title, /Completa i contatti di Maria Rossi: manca il telefono/);

  assert.equal(await snapshot(), before, 'a completion proposal writes no customer row');
});
