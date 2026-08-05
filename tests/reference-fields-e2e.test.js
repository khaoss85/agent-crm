import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const partnerContactManifest = {
  manifestVersion: 1,
  name: 'partner-contact',
  description: 'A contact who belongs to a Partner.',
  table: 'partner_contacts',
  fields: [
    { name: 'fullName', type: 'string', required: true },
    { name: 'partnerId', type: 'reference', references: 'partners', required: true },
    { name: 'backupPartnerId', type: 'reference', references: 'partners' },
  ],
};

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-crm-ref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  writeFileSync(join(root, 'examples/modules/partner-contact.module.json'), `${JSON.stringify(partnerContactManifest, null, 2)}\n`);
  return root;
}

function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/agent-crm.js'), ...args, '--root', root], {
    encoding: 'utf8',
    cwd: root,
  });
}

test('reference fields end to end: migration, FK, runtime validation, restart', async (t) => {
  const root = project(t);

  // 1-3. Applying the contact before its target fails; after, it succeeds.
  const early = cli(root, ['module', 'create', join(root, 'examples/modules/partner-contact.module.json'), '--apply']);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /apply the target module first/);
  assert.equal(cli(root, ['module', 'create', join(root, 'examples/modules/partner.module.json'), '--apply']).status, 0);

  // 2. Plan shows dependency metadata (references summary is content-free).
  const plan = JSON.parse(cli(root, ['module', 'plan', join(root, 'examples/modules/partner-contact.module.json')]).stdout);
  assert.deepEqual(
    plan.references.map((r) => [r.field, r.targetModule, r.targetTable, r.required]),
    [['partnerId', 'partner', 'partners', true], ['backupPartnerId', 'partner', 'partners', false]],
  );

  assert.equal(cli(root, ['module', 'create', join(root, 'examples/modules/partner-contact.module.json'), '--apply']).status, 0);

  // 5. Generated foreign key.
  const migration = readFileSync(join(root, 'packages/modules/partner-contact/src/migration.js'), 'utf8');
  assert.match(migration, /partner_id TEXT NOT NULL REFERENCES partners\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /backup_partner_id TEXT REFERENCES partners\(id\)/);

  // 6-17. Boot on a file-backed DB and drive through a real server + SDK.
  const dbPath = join(root, 'data', 'ref.sqlite');
  const { createAgentCrmApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AgentCrmClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);

  async function boot() {
    const app = createAgentCrmApp({ dbPath });
    const server = createHttpServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const client = new AgentCrmClient({ baseUrl, actor: { type: 'user', id: 'e2e' } });
    return { app, client, close: () => new Promise((r) => server.close(r)).then(() => app.close()) };
  }

  let instance = await boot();
  let app = instance.app;
  const client = instance.client;
  const partners = client.module('partner');
  const contacts = client.module('partner-contact');

  const pA = await partners.create({ name: 'Partner A', tier: 'gold' });
  const pB = await partners.create({ name: 'Partner B' });

  const events = [];
  for (const name of ['partner-contact.created', 'partner-contact.updated']) app.events.subscribe(name, () => events.push(name));

  // 8-10. Create linked to A.
  const contact = await contacts.create({ fullName: 'Mario', partnerId: pA.id });
  assert.equal(contact.partnerId, pA.id);
  assert.equal((await contacts.get(contact.id)).partnerId, pA.id);
  assert.equal((await contacts.list()).items.length, 1);

  // 11-12. Update to B.
  const updated = await contacts.update(contact.id, { partnerId: pB.id });
  assert.equal(updated.partnerId, pB.id);

  // Optional reference set then cleared with null.
  const withBackup = await contacts.update(contact.id, { backupPartnerId: pA.id });
  assert.equal(withBackup.backupPartnerId, pA.id);
  const cleared = await contacts.update(contact.id, { backupPartnerId: null });
  assert.equal(cleared.backupPartnerId, null);

  // 13-15. Missing / blank required target → 400, no mutation/audit/event.
  const auditBefore = app.audit.list({ entityType: 'partner-contact' }).length;
  const eventsBefore = events.length;
  await assert.rejects(() => contacts.create({ fullName: 'X', partnerId: 'ghost' }), (e) => e.status === 400 && e.code === 'VALIDATION_ERROR' && e.details.field === 'partnerId');
  await assert.rejects(() => contacts.create({ fullName: 'X', partnerId: '' }), (e) => e.status === 400);
  await assert.rejects(() => contacts.update(contact.id, { partnerId: 'ghost' }), (e) => e.status === 400);
  assert.equal(app.audit.list({ entityType: 'partner-contact' }).length, auditBefore);
  assert.equal(events.length, eventsBefore);
  assert.equal((await contacts.list()).items.length, 1);

  // 16. Successful create/update produced exactly one audit + one event each.
  const actions = app.audit.list({ entityType: 'partner-contact' }).map((e) => e.action);
  assert.equal(actions.filter((a) => a === 'partner-contact.created').length, 1);

  // Schema exposes relationship metadata.
  const schema = await client.schema();
  const contactMeta = schema.generatedModules.find((m) => m.name === 'partner-contact');
  const refField = contactMeta.fields.find((f) => f.name === 'partnerId');
  assert.equal(refField.type, 'reference');
  assert.equal(refField.targetModule, 'partner');
  assert.equal(refField.targetKey, 'id');
  assert.equal(schema.generatedResourceContract, 1);

  // Defense in depth: the DB itself rejects a bad FK on a direct insert.
  assert.throws(() => {
    app.database.raw.prepare('INSERT INTO partner_contacts(id, full_name, partner_id, backup_partner_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('x', 'n', 'ghost', null, 't', 't');
  }, /FOREIGN KEY/i);

  await instance.close();

  // 17. Restart: the relationship persists.
  instance = await boot();
  t.after(() => instance.close());
  const survived = await instance.client.module('partner-contact').get(contact.id);
  assert.equal(survived.partnerId, pB.id);
  assert.equal((await instance.client.module('partner').get(pB.id)).name, 'Partner B');
});

test('optional self-reference: first record null, then can self-point, and persists', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-crm-self-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  writeFileSync(
    join(root, 'examples/modules/treenode.module.json'),
    `${JSON.stringify({ manifestVersion: 1, name: 'treenode', table: 'treenodes', fields: [{ name: 'label', type: 'string', required: true }, { name: 'parentId', type: 'reference', references: 'treenodes' }] }, null, 2)}\n`,
  );
  assert.equal(cli(root, ['module', 'create', join(root, 'examples/modules/treenode.module.json'), '--apply']).status, 0);

  const dbPath = join(root, 'data', 'self.sqlite');
  const { createAgentCrmApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const actor = { type: 'user', id: 'self' };
  let app = createAgentCrmApp({ dbPath });
  const nodes = app.modules.get('treenode').service;
  const rootNode = await nodes.create({ label: 'root' }, { actor });
  assert.equal(rootNode.parentId, null);
  const child = await nodes.create({ label: 'child', parentId: rootNode.id }, { actor });
  assert.equal(child.parentId, rootNode.id);
  const selfPointing = await nodes.update(rootNode.id, { parentId: rootNode.id }, { actor });
  assert.equal(selfPointing.parentId, rootNode.id);
  // Invalid self target → validation error, no write/audit/event.
  const auditBefore = app.audit.list({ entityType: 'treenode' }).length;
  await assert.rejects(() => nodes.create({ label: 'bad', parentId: 'ghost' }, { actor }), /parentId/);
  assert.equal(app.audit.list({ entityType: 'treenode' }).length, auditBefore);
  app.close();

  // Restart: the self-relation persists.
  app = createAgentCrmApp({ dbPath });
  t.after(() => app.close());
  assert.equal(app.modules.get('treenode').service.get(rootNode.id).parentId, rootNode.id);
});
