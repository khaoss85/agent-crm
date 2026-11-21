// @ts-check

/**
 * Portable sender tombstones (voce 91c92940274c, review P1 giro 6).
 *
 * The portable facade (`packages/app/src/portable-app.js`) carries its own
 * `findContactByEmail`. When it omitted the tombstone columns, the
 * policy guard (`contact.archivedAt/deletedAt != null`) never fired on that
 * runtime: an archived contact kept its email by design, new inbound mail
 * matched it and the conversation was linked to a row no view ever lists.
 *
 * What it must prove, on the production-shaped portable app (real sqlite,
 * no `database` handle): archiving a contact and then resolving an inbound
 * sender for its address answers `unresolved` with the contact as the
 * human's candidate — never a silent reuse — exactly like the core path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccordoAppAsync } from '../packages/app/src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const customerData = await import(join(repoRoot, 'packages/customer-data/src/index.js'));

const ACTOR = { type: 'user', id: 'test-sender-portable' };

function recordManifests(packageName) {
  return readdirSync(join(repoRoot, 'packages', packageName, 'modules'))
    .filter((file) => file.endsWith('.module.json'))
    .map((file) => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages', packageName, 'modules', file), 'utf8'));
      return { name: manifest.name, manifest };
    });
}

async function portableApp(t) {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-sender-portable-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = await createAccordoAppAsync({
    dbPath: join(directory, 'portable.sqlite'),
    selected: {
      packageContract: 2,
      packages: [customerData.createCustomerDataPackageV2()],
      actions: [],
      modules: recordManifests('customer-data'),
    },
  });
  t.after(() => app.close());
  return app;
}

test('voce 91c92940274c: new mail on an archived address stays undecided on the portable runtime', async (t) => {
  const app = await portableApp(t);

  const company = await app.services.companies.create(
    { name: 'Presti Group', domain: 'prestigroup.example' }, { actor: ACTOR },
  );
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Apple', lastName: 'Reply', email: 'apple.reply@prestigroup.example',
  }, { actor: ACTOR });

  await app.services.contacts.archive(contact.id, { actor: ACTOR });

  const answer = await app.operations.run('resolve-channel-sender', {
    channel: 'email', handle: 'apple.reply@prestigroup.example', email: 'apple.reply@prestigroup.example',
    firstName: 'Apple', lastName: 'Reply', companyName: 'Presti Group', domain: 'prestigroup.example',
    actor: ACTOR,
  });
  assert.equal(answer.outcome, 'unresolved', 'new mail on the archived address never reuses the invisible contact');
  assert.equal(answer.contact, null);
  assert.equal(answer.rule, 'contact-email');
  assert.deepEqual(answer.candidates.map((candidate) => candidate.id), [contact.id],
    'the archived contact stays a candidate for a human');
});
