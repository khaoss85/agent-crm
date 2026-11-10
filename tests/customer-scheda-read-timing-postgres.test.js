// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { openIsolatedPostgresqlPlanes, bootPostgresqlApp } from './helpers/postgresql-application.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Voce 908f2eb9bbfb (secondo ritorno, AC-3): la scheda si apre in meno di
 * 3 secondi in produzione. Il supervisore misura dal vivo; questa è la
 * misura che la precede sul server di test: card + timeline + profilo in
 * parallelo su Postgres vero, a caldo, sotto 1,5 s.
 *
 * Non è un test di cache: ogni lettura ricalcola davvero (singleflight, mai
 * oltre il calcolo), e il seme è di forma produzione (contatto + azienda +
 * identità WhatsApp + opportunità). Senza Postgres raggiungibile la suite
 * si salta in locale e gira sulla CI contro postgres:16.
 */

function packageManifests(packageName) {
  const dir = join(HERE, '..', 'packages', packageName, 'modules');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.module.json'))
    .map((file) => {
      const manifest = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      return { name: manifest.name, manifest };
    });
}

test('voce 908f2eb9bbfb: card, timeline e profilo in parallelo sotto 1,5 s su Postgres', { timeout: 300_000 }, async (t) => {
  const customerData = await import('../packages/customer-data/src/index.js');
  const work = await import('../packages/work/src/index.js');
  const interactions = await import('../packages/interactions/src/index.js');
  const appointments = await import('../packages/appointments/src/index.js');
  const commercial = await import('../packages/commercial/src/index.js');
  const hub = await import('../packages/customer-hub/src/index.js');

  const customerDataPkg = customerData.createCustomerDataPackageV2();
  const workPkg = work.createWorkPackageV2();
  const interactionsPkg = interactions.createInteractionsPackageV2();
  const appointmentsPkg = appointments.createAppointmentsPackageV2({ work: workPkg });
  const selected = {
    packageContract: 2,
    packages: [
      customerDataPkg,
      workPkg,
      interactionsPkg,
      appointmentsPkg,
      commercial.createCommercialDomainV2(),
      // Niente domini contracts, signature, service e delivery: la catena
      // service/delivery → contracts → signature porta a request-signature,
      // externalOperation 1, rifiutata dal boot PostgreSQL
      // (EXTERNAL_OPERATION_V2_REQUIRED). Le loro sezioni si leggono dai
      // moduli qui sotto, senza azioni.
      hub.createCustomerHubPackageV2({
        customerData: customerDataPkg, interactions: interactionsPkg, appointments: appointmentsPkg,
      }),
    ],
    actions: [],
    modules: [
      // Host services (companies, contacts, opportunities) ride the default
      // composition, like the profile-on-PostgreSQL test proves; only the
      // package-owned record manifests are listed here.
      ...packageManifests('customer-data'),
      ...packageManifests('work'),
      ...packageManifests('interactions'),
      ...packageManifests('appointments'),
      // Senza quote-term: dichiara reference fields e va generato con
      // module:create, non composto dal manifest grezzo; la lettura del
      // profilo non lo usa (la sezione quotes legge il modulo quote).
      ...packageManifests('commercial').filter((entry) => entry.name !== 'quote-term'),
      // Senza i manifest di contracts, service, signature e delivery: i loro
      // domini non avviano su PG (catena verso request-signature,
      // externalOperation 1). Follow-up: upgrade a externalOperation 2, poi
      // si ricompongono con le loro sezioni.
      'lead',
    ],
  };
  const booted = await bootPostgresqlApp(t, { selected });
  if (!booted) return;
  const { app } = booted;

  const company = await app.services.companies.create({ name: 'Presti Group' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Ada', lastName: 'Rossi', email: 'ada@presti.example',
  });
  await app.operations.run('apply-customer-import', {
    system: 'owner-csv',
    rows: [{ externalId: 'ADA1', email: 'ada@presti.example', firstName: 'Ada', lastName: 'Rossi' }],
    acceptance: 'partial',
  });
  await app.services.opportunities.create({
    companyId: company.id,
    name: 'Abbonamento annuale',
    type: 'new_business',
    valueCents: 120000,
    currency: 'EUR',
    stage: 'proposal',
    owner: 'guido',
    expectedCloseDate: '2026-12-31',
  });

  const subject = { resource: 'contact', id: contact.id };
  const readAll = () => Promise.all([
    app.operations.run('read-customer-card', subject),
    app.operations.run('read-customer-timeline', subject),
    app.operations.run('read-customer-profile', subject),
  ]);

  await readAll(); // warm: pool, piani e composizione a regime, come in produzione
  const start = Date.now();
  const [card, timeline, profile] = await readAll();
  const wallMs = Date.now() - start;

  assert.equal(card.name, 'Ada Rossi', 'the card reads the seeded customer');
  assert.equal(profile.customerProfileContract, 1, 'the profile reads on PostgreSQL');
  assert.equal(timeline.customerTimelineContract, 1, 'the timeline reads on PostgreSQL');
  assert.ok(
    wallMs < 1500,
    `card+timeline+profile in parallelo sotto 1,5 s su Postgres vero, a caldo: ${wallMs} ms`,
  );
});
