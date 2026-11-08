import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createCustomerProfileCapability } from '../packages/customer-data/src/capability-profile.js';
import { ERASURE_REASONS } from '../packages/customer-data/src/erasure.js';

/**
 * Voce d271d723 (validazione B6): cancellare un cliente davvero (GDPR).
 *
 * What it must prove: erasing a customer with messages and appointments
 * takes a user actor with an explicit titolare confirmation and a recorded
 * reason; it refuses when signed business must be kept (the one status
 * rule); otherwise it anonymizes the contact, withdraws the channel
 * identities, purges enriched fields, blanks custom-field values, records
 * one append-only erasure-log row, and the customer disappears from the
 * customer list, the search, the direct profile link and the export.
 * A second erasure replays the stored row.
 */

const OPERATOR = { type: 'user', id: 'titolare-1' };
const AGENT = { type: 'agent', id: 'agent-1' };

async function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  assert.equal(typeof app.eraseCustomer, 'function', 'the customer-data package offers the erasure operation');
  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti',
    email: 'guido@palestra-esempio.it',
  });
  const other = await app.services.contacts.create({
    companyId: company.id, firstName: 'Maria', lastName: 'Rossi',
    email: 'maria@palestra-esempio.it',
  });
  await app.recordSubjectPhone({ resource: 'contact', id: contact.id, phone: '+393331234567', actor: OPERATOR });
  return { app, company, contact, other };
}

async function erasureRows(app, resource, id) {
  return app.modules.get('customer-erasure-log').service.listWhere({ subjectResource: resource, subjectId: id });
}

/** A signed-business stub: one order row naming this company makes the profile a cliente. */
function stubSignedBusiness(app, companyId) {
  app.modules.register({
    name: 'order',
    kind: 'generated',
    manifestVersion: 1,
    capabilities: ['list'],
    fields: [
      { name: 'id', type: 'string', required: true, unique: true },
      { name: 'companyId', type: 'string', required: false, unique: false },
    ],
    service: {
      list: async () => [{ id: 'order-1', companyId }],
    },
  });
}

test('erasing needs the titolare: agent actors, missing confirm and missing reason refuse', async (t) => {
  const { app, contact } = await scene(t);
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato', actor: AGENT }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED' && error?.status === 403,
    'an agent actor refuses: erasing is a titolare decision',
  );
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, reason: 'richiesta-interessato', actor: OPERATOR }),
    (error) => error?.name === 'ValidationError',
    'no explicit confirmation refuses',
  );
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, actor: OPERATOR }),
    (error) => error?.name === 'ValidationError',
    'no recorded reason refuses',
  );
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: 'ghost', confirm: true, reason: 'richiesta-interessato', actor: OPERATOR }),
    (error) => error?.code === 'ERASURE_SUBJECT_NOT_FOUND' && error?.status === 404,
    'an unknown customer reads 404',
  );
  assert.equal((await erasureRows(app, 'contact', contact.id)).length, 0, 'a refused erasure records nothing');
});

test('signed business blocks the erasure: a cliente is kept, never erased', async (t) => {
  const { app, company, contact } = await scene(t);
  stubSignedBusiness(app, company.id);
  const profile = await app.readCustomerProfile({ resource: 'contact', id: contact.id });
  assert.equal(profile.status.value, 'cliente', 'the stub order promotes the contact to cliente');
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR }),
    (error) => error?.code === 'ERASURE_BLOCKED_SIGNED_BUSINESS' && error?.status === 409,
    'signed business refuses with 409',
  );
  const reread = await app.services.contacts.get(contact.id);
  assert.equal(reread.email, 'guido@palestra-esempio.it', 'a blocked erasure rewrites nothing');
  assert.equal((await erasureRows(app, 'contact', contact.id)).length, 0, 'a blocked erasure records nothing');
});

test('erasing anonymizes, records and excludes: list, search, profile and export lose the customer', async (t) => {
  const { app, contact } = await scene(t);
  await app.defineCustomField({ label: 'Amico', type: 'si-no', actor: OPERATOR });
  const defs = await app.listCustomFields({});
  const amico = defs.find((def) => def.label === 'Amico');
  assert.ok(amico, 'the custom field exists');
  await app.setCustomFieldValue({ resource: 'contact', id: contact.id, key: amico.key, value: true, actor: OPERATOR });

  const receipt = await app.eraseCustomer({
    resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
  });
  assert.equal(receipt.outcome, 'erased');
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.reason, 'richiesta-interessato');

  const reread = await app.services.contacts.get(contact.id);
  assert.equal(reread.firstName, 'Cliente');
  assert.equal(reread.lastName, 'cancellato');
  assert.match(reread.email, /^cancellato-.*@cancellato\.invalid$/, 'the email is non-identifying and never deliverable');

  const identities = await app.modules.get('external-identity').service
    .listWhere({ subjectResource: 'contact', subjectId: contact.id });
  assert.ok(identities.length > 0, 'the identity rows stay (append-only) but withdrawn');
  for (const row of identities) {
    assert.equal(row.status, 'superseded', 'no active identity names the erased customer');
    assert.match(String(row.externalId), /^cancellato:/, 'the held identifier is redacted');
  }

  const values = await app.modules.get('custom-field-value').service
    .listWhere({ subjectResource: 'contact', subjectId: contact.id });
  for (const row of values) {
    assert.equal(row.value, null, 'personal custom-field values are blanked');
  }

  const logged = await erasureRows(app, 'contact', contact.id);
  assert.equal(logged.length, 1, 'one append-only registry row');
  assert.equal(logged[0].reason, 'richiesta-interessato');
  assert.equal(logged[0].erasedById, 'titolare-1');

  const list = await app.listCustomers({ pageSize: 50 });
  assert.ok(!list.items.some((row) => row.id === contact.id), 'the erased customer leaves Clienti');
  const search = await app.listCustomers({ q: 'Presti', pageSize: 50 });
  assert.ok(!search.items.some((row) => row.id === contact.id), 'the erased customer leaves the search');

  await assert.rejects(
    () => app.readCustomerProfile({ resource: 'contact', id: contact.id }),
    (error) => error?.code === 'CUSTOMER_ERASED' && error?.status === 404,
    'the direct link reads 404',
  );

  const exported = await app.exportCustomerRecords({ resource: 'external-identity' });
  assert.ok(
    !exported.rows.some((row) => row.subjectResource === 'contact' && row.subjectId === contact.id),
    'the export carries no row naming the erased customer',
  );

  const replay = await app.eraseCustomer({
    resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
  });
  assert.equal(replay.replayed, true, 'a second erasure replays the stored row');
  assert.equal((await erasureRows(app, 'contact', contact.id)).length, 1, 'no second registry row');
  assert.deepEqual(
    replay.erasedSubjects,
    [{ resource: 'contact', id: contact.id }],
    'the replay names the requested subject, so membership reads never throw',
  );
  assert.ok(!('counts' in replay) && !('notes' in replay), 'a replay invents no tallies: branch on replayed');
});

test('the erasure registry itself still exports: the accountability proof is never filtered', async (t) => {
  const { app, contact } = await scene(t);
  await app.eraseCustomer({
    resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
  });
  const exported = await app.exportCustomerRecords({ resource: 'customer-erasure-log' });
  assert.equal(exported.erasedExcluded, 0, 'the registry is exempt from erased-subject exclusion');
  assert.ok(
    exported.rows.some((row) => row.subjectResource === 'contact' && row.subjectId === contact.id),
    'the registry row exports: the proof of the erasure leaves the export',
  );
});

test('erasing clears the job title: no role survives the anonymization', async (t) => {
  const { app, company } = await scene(t);
  const director = await app.services.contacts.create({
    companyId: company.id, firstName: 'Anna', lastName: 'Bianchi',
    email: 'anna@palestra-esempio.it', role: 'Amministratore Delegato',
  });
  await app.eraseCustomer({
    resource: 'contact', id: director.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
  });
  const reread = await app.services.contacts.get(director.id);
  assert.equal(reread.role, null, 'the job title goes with the rest of the PII');
  assert.equal(reread.firstName, 'Cliente');
});

test('the reason is a code from a closed list: a name in free text never reaches the registry or the export', async (t) => {
  const { app, contact } = await scene(t);
  for (const reason of [
    'cancellare Mario Rossi su sua richiesta',
    'cancellare Mario Rossi mario@x.it su sua richiesta',
    'richiamare il +39 333 123 4567 poi cancellare',
    'richiesta del 08/11/2026',
  ]) {
    await assert.rejects(
      () => app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason, actor: OPERATOR }),
      (error) => error?.name === 'ValidationError' && error?.details?.field === 'reason',
      `free text refuses: «${reason}»`,
    );
  }
  assert.equal((await erasureRows(app, 'contact', contact.id)).length, 0, 'a refused erasure records nothing');
  assert.equal((await app.services.contacts.get(contact.id)).lastName, 'Presti', 'and rewrites nothing');

  const receipt = await app.eraseCustomer({
    resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
  });
  assert.equal(receipt.reason, 'richiesta-interessato', 'the receipt carries the code only');
  const exported = await app.exportCustomerRecords({ resource: 'customer-erasure-log' });
  for (const row of exported.rows) {
    assert.ok(ERASURE_REASONS.includes(row.reason), 'every registry reason is a closed-list code');
  }
  const text = JSON.stringify({ receipt, rows: exported.rows });
  assert.ok(!text.includes('Mario') && !text.includes('Rossi'), 'no name reaches the registry, its export or the receipt');
});

test('the company with other contacts stays: only the erased contact leaves', async (t) => {
  const { app, company, contact, other } = await scene(t);
  await app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR });
  const list = await app.listCustomers({ pageSize: 50 });
  assert.ok(list.items.some((row) => row.id === other.id), 'the other contact still lists');
  assert.ok(list.items.some((row) => row.company?.id === company.id), 'the shared company still shows beside its contact');
  assert.equal((await erasureRows(app, 'company', company.id)).length, 0, 'no registry row for a kept company');
});

test('nobody authorizes an erasure: a missing or malformed actor refuses and records nothing', async (t) => {
  const { app, contact } = await scene(t);
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato' }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED' && error?.status === 403,
    'no actor refuses: the fail-closed anonymous authorizes nothing',
  );
  await assert.rejects(
    () => app.eraseCustomer({
      resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato', actor: { type: 'user' },
    }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED' && error?.status === 403,
    'an actor without an id refuses too',
  );
  const reread = await app.services.contacts.get(contact.id);
  assert.equal(reread.email, 'guido@palestra-esempio.it', 'a refused erasure rewrites nothing');
  assert.equal((await erasureRows(app, 'contact', contact.id)).length, 0, 'a refused erasure records nothing');
});

test('uncertain evidence blocks the erasure: an empty bounded page proves nothing', async (t) => {
  const { app, contact } = await scene(t);
  app.modules.register({
    name: 'order',
    kind: 'generated',
    manifestVersion: 1,
    capabilities: ['list'],
    fields: [
      { name: 'id', type: 'string', required: true, unique: true },
    ],
    service: {
      list: async () => [],
    },
  });
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR }),
    (error) => error?.code === 'ERASURE_EVIDENCE_UNREADABLE' && error?.status === 409,
    'a list-only page refuses even when empty: a page is not a count',
  );
  const reread = await app.services.contacts.get(contact.id);
  assert.equal(reread.email, 'guido@palestra-esempio.it', 'a blocked erasure rewrites nothing');
  assert.equal((await erasureRows(app, 'contact', contact.id)).length, 0, 'a blocked erasure records nothing');
});

test('uncertain evidence blocks the erasure: a failed evidence read refuses', async (t) => {
  const { app, contact } = await scene(t);
  app.modules.register({
    name: 'order',
    kind: 'generated',
    manifestVersion: 1,
    capabilities: ['list'],
    fields: [
      { name: 'id', type: 'string', required: true, unique: true },
    ],
    service: {
      list: async () => { throw new Error('order store down'); },
    },
  });
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR }),
    (error) => error?.code === 'ERASURE_EVIDENCE_UNREADABLE' && error?.status === 409,
    'an unreadable evidence package refuses instead of risking signed business',
  );
  assert.equal((await erasureRows(app, 'contact', contact.id)).length, 0, 'a blocked erasure records nothing');
});

test('erasing a company cascades to its contacts: no name or email survives in Clienti', async (t) => {
  const { app, company, contact, other } = await scene(t);
  const receipt = await app.eraseCustomer({
    resource: 'company', id: company.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
  });
  assert.equal(receipt.outcome, 'erased');
  assert.equal(receipt.counts.subjects, 3, 'the company and both linked contacts go together');
  for (const erased of [contact, other]) {
    const reread = await app.services.contacts.get(erased.id);
    assert.equal(reread.firstName, 'Cliente');
    assert.equal(reread.lastName, 'cancellato');
    assert.match(reread.email, /^cancellato-.*@cancellato\.invalid$/, 'no identifying email survives the cascade');
    assert.equal((await erasureRows(app, 'contact', erased.id)).length, 1, 'one registry row per cascaded contact');
  }
  assert.equal((await erasureRows(app, 'company', company.id)).length, 1, 'one registry row for the company');
  const list = await app.listCustomers({ pageSize: 50 });
  assert.ok(!list.items.some((row) => row.id === contact.id || row.id === other.id), 'cascaded contacts leave Clienti');
  const search = await app.listCustomers({ q: 'Presti', pageSize: 50 });
  assert.ok(!search.items.some((row) => row.id === contact.id), 'the erased name leaves the search');
});

test('an erased company reads as gone through the shared capability, not only the direct profile', async (t) => {
  const { app, company } = await scene(t);
  await app.eraseCustomer({
    resource: 'company', id: company.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
  });
  await assert.rejects(
    () => app.readCustomerProfile({ resource: 'company', id: company.id }),
    (error) => error?.code === 'CUSTOMER_ERASED' && error?.status === 404,
    'the direct link reads 404 for the kept-but-erased company row',
  );
  // The hub card and timeline read through customer-profile@1 (the hub
  // forwards to capability.readProfile with the provider's own names),
  // so the gate lives on the capability every reader shares.
  const capability = createCustomerProfileCapability({}).create({ modules: app.modules });
  await assert.rejects(
    () => capability.readProfile({ subject: { resource: 'company', id: company.id } }),
    (error) => error?.code === 'CUSTOMER_ERASED' && error?.status === 404,
    'the shared capability reads 404 for the erased company: card and timeline go through here',
  );
});

test('a company with more than one display page still cascades fully: no PII survives past the old bound', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const company = await app.services.companies.create({ name: 'Grande Palestra' });
  const ids = [];
  for (let i = 0; i < 101; i += 1) {
    const contact = await app.services.contacts.create({
      companyId: company.id, firstName: 'Socio', lastName: `Numero${i}`,
      email: `socio${i}@grande-palestra.it`,
    });
    ids.push(contact.id);
  }
  const receipt = await app.eraseCustomer({
    resource: 'company', id: company.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
  });
  assert.equal(receipt.counts.subjects, 102, 'the company and all 101 linked contacts go together');
  for (const id of ids) {
    const reread = await app.services.contacts.get(id);
    assert.equal(reread.firstName, 'Cliente');
    assert.match(reread.email, /^cancellato-.*@cancellato\.invalid$/, 'no identifying email survives the cascade');
    assert.equal((await erasureRows(app, 'contact', id)).length, 1, 'one registry row per cascaded contact');
  }
});

test('a full company page refuses the erasure instead of erasing half: a truncated read never decides', async (t) => {
  const { app, company, contact } = await scene(t);
  const original = app.services.contacts.list.bind(app.services.contacts);
  app.services.contacts.list = async () => Array.from(
    { length: 500 }, (_, index) => ({ id: `ghost-${index}` }),
  );
  let refusal = null;
  try {
    await app.eraseCustomer({
      resource: 'company', id: company.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
    });
  } catch (error) {
    refusal = error;
  } finally {
    app.services.contacts.list = original;
  }
  assert.equal(refusal?.code, 'ERASURE_CASCADE_INCOMPLETE', 'a possibly-truncated page refuses with 409');
  assert.equal(refusal?.status, 409);
  const reread = await app.services.contacts.get(contact.id);
  assert.equal(reread.email, 'guido@palestra-esempio.it', 'a refused erasure rewrites nothing');
  assert.equal((await erasureRows(app, 'company', company.id)).length, 0, 'a refused erasure records nothing');
});

test('a company erasure with an unreadable contacts list refuses: no half-erasure behind a success receipt', async (t) => {
  const { app, company, contact, other } = await scene(t);
  const original = app.services.contacts.list.bind(app.services.contacts);
  app.services.contacts.list = async (filters) => {
    if (filters?.companyId) throw new Error('contacts store down');
    return original(filters);
  };
  let refusal = null;
  try {
    await app.eraseCustomer({
      resource: 'company', id: company.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
    });
  } catch (error) {
    refusal = error;
  } finally {
    app.services.contacts.list = original;
  }
  assert.equal(refusal?.code, 'ERASURE_CASCADE_UNREADABLE', 'a failed cascade read refuses with 409');
  assert.equal(refusal?.status, 409);
  for (const erased of [contact, other]) {
    const reread = await app.services.contacts.get(erased.id);
    assert.equal(reread.firstName === 'Cliente' ? 'erased' : 'kept', 'kept', 'a refused cascade rewrites no contact');
    assert.equal((await erasureRows(app, 'contact', erased.id)).length, 0, 'a refused cascade records no contact row');
  }
  assert.equal((await erasureRows(app, 'company', company.id)).length, 0, 'a refused cascade records no receipt');
});

test('an unreadable siblings list keeps the company: absence unproven never excludes', async (t) => {
  const { app, company, contact, other } = await scene(t);
  const original = app.services.contacts.list.bind(app.services.contacts);
  app.services.contacts.list = async (filters) => {
    if (filters?.companyId) throw new Error('contacts store down');
    return original(filters);
  };
  let receipt = null;
  try {
    receipt = await app.eraseCustomer({
      resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
    });
  } finally {
    app.services.contacts.list = original;
  }
  assert.equal(receipt?.outcome, 'erased', 'the contact erasure itself still proceeds');
  assert.equal((await erasureRows(app, 'company', company.id)).length, 0, 'no registry row for a company that stays');
  const list = await app.listCustomers({ pageSize: 50 });
  assert.ok(list.items.some((row) => row.id === other.id), 'the other contact still lists');
  assert.ok(list.items.some((row) => row.company?.id === company.id), 'the possibly-shared company still shows');
});

test('the contacts-list gate decides every case the same way on both paths: one table', async (t) => {
  const ghosts = (n) => Array.from({ length: n }, (_, index) => ({ id: `ghost-${index}` }));
  const cases = [
    { name: 'empty list', rows: 'empty', company: { proceeds: true, subjects: 1 }, orphan: { keeps: false } },
    { name: 'partial list', rows: 'partial', company: { proceeds: true, subjects: 3 }, orphan: { keeps: true } },
    { name: 'full page', rows: 'full', company: { proceeds: false, code: 'ERASURE_CASCADE_INCOMPLETE' }, orphan: { keeps: true } },
    { name: 'failed read', rows: 'failed', company: { proceeds: false, code: 'ERASURE_CASCADE_UNREADABLE' }, orphan: { keeps: true } },
  ];
  for (const kase of cases) {
    const stubList = (app, contact, other) => {
      const original = app.services.contacts.list.bind(app.services.contacts);
      app.services.contacts.list = async (filters) => {
        if (!filters?.companyId) return original(filters);
        if (kase.rows === 'failed') throw new Error('contacts store down');
        if (kase.rows === 'full') return ghosts(500);
        if (kase.rows === 'partial') return [{ id: contact.id }, { id: other.id }];
        return [];
      };
      return original;
    };
    {
      const { app, company, contact, other } = await scene(t);
      const original = stubList(app, contact, other);
      try {
        if (kase.company.proceeds) {
          const receipt = await app.eraseCustomer({
            resource: 'company', id: company.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
          });
          assert.equal(receipt.counts.subjects, kase.company.subjects, `${kase.name}: the cascade carries its proven members`);
        } else {
          await assert.rejects(
            () => app.eraseCustomer({
              resource: 'company', id: company.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
            }),
            (error) => error?.code === kase.company.code && error?.status === 409,
            `${kase.name}: the cascade refuses instead of deciding on the page`,
          );
          const reread = await app.services.contacts.get(contact.id);
          assert.equal(reread.email, 'guido@palestra-esempio.it', `${kase.name}: a refused cascade rewrites nothing`);
          assert.equal((await erasureRows(app, 'company', company.id)).length, 0, `${kase.name}: a refused cascade records nothing`);
        }
      } finally {
        app.services.contacts.list = original;
      }
    }
    {
      const { app, company, contact, other } = await scene(t);
      const original = stubList(app, contact, other);
      try {
        const receipt = await app.eraseCustomer({
          resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
        });
        assert.equal(receipt.outcome, 'erased', `${kase.name}: the contact erasure itself proceeds`);
        const companyRows = await erasureRows(app, 'company', company.id);
        assert.equal(
          companyRows.length, kase.orphan.keeps ? 0 : 1,
          `${kase.name}: only a proven-empty siblings list excludes the company`,
        );
      } finally {
        app.services.contacts.list = original;
      }
    }
  }
});

test('purging enriched fields clears the email snapshot too: no PII copy survives beside the erased subject', async (t) => {
  const { app, contact } = await scene(t);
  await app.applyContactEnrichment({
    actor: OPERATOR, email: 'guido@palestra-esempio.it',
    fields: { role: 'Socio' }, source: 'email-signature', sourceDetail: 'msg-1',
  });
  const before = await app.modules.get('enriched-field').service
    .listWhere({ subjectResource: 'contact', subjectId: contact.id });
  assert.ok(before.length > 0, 'the enrichment row exists before the erasure');
  assert.ok(
    before.some((row) => row.subjectLabel === 'guido@palestra-esempio.it'),
    'the display snapshot carries the email before the erasure',
  );
  await app.eraseCustomer({
    resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta-interessato', actor: OPERATOR,
  });
  const after = await app.modules.get('enriched-field').service
    .listWhere({ subjectResource: 'contact', subjectId: contact.id });
  assert.ok(after.length > 0, 'the rows stay (append-only) but purged');
  for (const row of after) {
    assert.equal(row.status, 'purged', 'no active enrichment names the erased customer');
    assert.equal(row.value, null, 'the enriched value is blanked');
    assert.equal(row.subjectLabel, null, 'no email snapshot survives the purge');
  }
});
