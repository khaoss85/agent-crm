import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const supplierManifest = {
  manifestVersion: 1,
  name: 'supplier',
  description: 'Suppliers with a unique code.',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'code', type: 'string', required: true, unique: true },
    { name: 'active', type: 'boolean' },
  ],
};

test('end-to-end: applied modules are served over HTTP and usable via client.module()', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-crm-api-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  writeFileSync(join(root, 'examples/modules/supplier.module.json'), `${JSON.stringify(supplierManifest, null, 2)}\n`);

  // 1. Generate and apply both modules from their manifests via the copy's CLI.
  for (const manifest of ['examples/modules/partner.module.json', 'examples/modules/supplier.module.json']) {
    const run = spawnSync(
      process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/agent-crm.js'), 'module', 'create', join(root, manifest), '--apply', '--root', root],
      { encoding: 'utf8', cwd: root },
    );
    assert.equal(run.status, 0, run.stderr);
  }

  // 2. Boot the copy's app on a file-backed database and start a real server.
  const dbPath = join(root, 'data', 'e2e.sqlite');
  const { createAgentCrmApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AgentCrmClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);

  async function startServer() {
    const app = createAgentCrmApp({ dbPath });
    const server = createHttpServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    return {
      app,
      baseUrl,
      close: async () => {
        await new Promise((resolve) => server.close(resolve));
        app.close();
      },
    };
  }

  let instance = await startServer();
  try {
    // 3-4. Schema discovery: both generated modules with fields and capabilities.
    const schema = await fetch(`${instance.baseUrl}/api/schema`).then((response) => response.json());
    const generatedNames = schema.generatedModules.map((module) => module.name);
    assert.deepEqual(generatedNames, ['partner', 'supplier']);
    const partnerSchema = schema.generatedModules[0];
    assert.deepEqual(partnerSchema.capabilities, ['create', 'get', 'list', 'update']);
    assert.deepEqual(
      partnerSchema.fields.find((field) => field.name === 'tier').values,
      ['silver', 'gold', 'platinum'],
    );
    assert.equal(partnerSchema.paths.collection, '/api/modules/partner/records');
    assert.ok(!JSON.stringify(schema).includes(root), 'schema leaks machine paths');

    // 5. Metadata endpoint.
    const client = new AgentCrmClient({
      baseUrl: instance.baseUrl,
      actor: { type: 'agent', id: 'claude-code' },
    });
    const partners = client.module('partner');
    const metadata = await partners.metadata();
    assert.equal(metadata.manifestVersion, 1);
    assert.deepEqual(metadata.immutableFields, ['id', 'createdAt', 'updatedAt']);

    // 6-10. SDK CRUD through the real server.
    const events = [];
    for (const name of ['partner.created', 'partner.updated', 'supplier.created']) {
      instance.app.events.subscribe(name, () => events.push(name));
    }
    const created = await partners.create({ name: 'Acme Partners', tier: 'gold', territory: 'Italy' });
    assert.ok(created.id);
    const fetched = await partners.get(created.id);
    assert.equal(fetched.tier, 'gold');
    const list = await partners.list({ limit: 50 });
    assert.equal(list.items.length, 1);
    const updated = await partners.update(created.id, { tier: 'platinum' });
    assert.equal(updated.tier, 'platinum');

    const suppliers = client.module('supplier');
    const supplier = await suppliers.create({ name: 'Bolts SpA', code: 'BOLT', active: true });
    assert.equal((await suppliers.list()).items.length, 1);

    // 11-12. Actor identity in audit; domain events for create/update.
    const partnerAudit = instance.app.audit.list({ entityType: 'partner' });
    assert.deepEqual(partnerAudit.map((event) => event.action).sort(), ['partner.created', 'partner.updated']);
    assert.ok(partnerAudit.every((event) => event.actorType === 'agent' && event.actorId === 'claude-code'));
    assert.deepEqual(events, ['partner.created', 'partner.updated', 'supplier.created']);

    // Reads emit no audit.
    const auditCount = instance.app.audit.list({ limit: 500 }).length;
    await partners.list();
    await partners.get(created.id);
    assert.equal(instance.app.audit.list({ limit: 500 }).length, auditCount);

    // 13. Error contract, via SDK (status + code preserved) and raw fetch.
    await assert.rejects(() => client.module('nope').list(), (error) => error.status === 404 && error.code === 'NOT_FOUND');
    await assert.rejects(() => client.module('company').list(), (error) => error.status === 404);
    await assert.rejects(() => partners.get('missing-id'), (error) => error.status === 404);
    await assert.rejects(
      () => partners.create({ name: 'X', tier: 'diamond' }),
      (error) => error.status === 400 && error.code === 'VALIDATION_ERROR',
    );
    await assert.rejects(
      () => suppliers.create({ name: 'Dup', code: 'BOLT' }),
      (error) => error.status === 409 && error.code === 'CONFLICT',
    );
    assert.throws(() => partners.list({ limit: 1.5 }), /integer limit/);
    for (const limit of ['abc', '0', '-5', '1.5', 'NaN', '9999']) {
      const response = await fetch(`${instance.baseUrl}/api/modules/partner/records?limit=${limit}`);
      assert.equal(response.status, 400, `limit=${limit}`);
      assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
    }
    // Failed mutations produced neither audit nor events beyond the earlier ones.
    assert.equal(instance.app.audit.list({ limit: 500 }).length, auditCount);
    assert.equal(events.length, 3);

    // 14. Core module endpoints still work and are separate from the generic surface.
    const companies = await fetch(`${instance.baseUrl}/api/companies`).then((response) => response.json());
    assert.deepEqual(companies.items, []);

    // 15-16. Restart: both modules and the data survive from checked-in state + db file.
    await instance.close();
    instance = await startServer();
    const clientAfter = new AgentCrmClient({ baseUrl: instance.baseUrl, actor: { type: 'agent', id: 'claude-code' } });
    const schemaAfter = await clientAfter.schema();
    assert.deepEqual(schemaAfter.generatedModules.map((module) => module.name), ['partner', 'supplier']);
    const survivors = await clientAfter.module('partner').list();
    assert.equal(survivors.items.length, 1);
    assert.equal(survivors.items[0].tier, 'platinum');
    assert.equal((await clientAfter.module('supplier').get(supplier.id)).code, 'BOLT');
  } finally {
    await instance.close();
  }
});
