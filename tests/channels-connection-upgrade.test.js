import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase } from '../packages/core/src/database.js';
import { AuditLog } from '../packages/core/src/audit.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';

/**
 * channel-connection revision 3 adopts main's revision 2 (backlog:ffce3d1cd636).
 *
 * Main already shipped revision 2 (the grantExpiresAt column, another PR,
 * already in production), while this branch added the calendar/stripe enum
 * as its own revision 2. The realignment keeps main's revision 2 as history
 * and ships this branch's change as revision 3. Every suite that composes
 * revision 3 on an empty table proves the manifest parses — not that a
 * database main migrated keeps its rows. So this test migrates a genuine
 * revision-2 database (the checked-in history entry, byte-identical to
 * main's manifest), stores a connection through the revision-2 service,
 * applies only the revision-3 evolution, and proves the row survived and
 * the new enum values register.
 */

const here = dirname(fileURLToPath(import.meta.url));
const modulesDir = join(here, '..', 'packages', 'channels', 'modules');
const history = JSON.parse(readFileSync(join(modulesDir, 'channel-connection.history.json'), 'utf8'));
const rev2 = history.previousManifests[1];
const rev3 = JSON.parse(readFileSync(join(modulesDir, 'channel-connection.module.json'), 'utf8'));

assert.equal(rev2.revision, 2);
assert.equal(rev3.revision, 3);

function serviceFor(database, manifest) {
  const audit = new AuditLog(database);
  const events = new EventBus();
  return createRecordModuleFromManifest(manifest, { database, audit, events, references: {} }).service;
}

test('a revision-2 database adopts revision 3 without losing its connections', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-connection-upgrade-'));
  t.after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  const database = createDatabase({ path: join(dir, 'upgrade.sqlite') });
  t.after(() => database.close());

  // Phase 1: the production shape — migrate exactly as main's revision 2
  // composes, then store a connection through the revision-2 service.
  const rev2Migrations = recordModuleMigrations([{ name: 'channel-connection', manifest: rev2 }]);
  assert.deepEqual(rev2Migrations.map((migration) => migration.name), [
    'create_channel_connections',
    'evolve_channel_connections_r2',
  ]);
  const applied = new Set();
  for (const migration of rev2Migrations) {
    database.raw.exec(migration.sql);
    applied.add(migration.name);
  }
  const before = serviceFor(database, rev2);
  const stored = await before.createManaged({
    sourceKey: 'wa:presti:+390200000099',
    spaceId: 'presti',
    channel: 'whatsapp',
    account: '+390200000099',
    adapter: 'whatsapp-cloud',
    adapterVersion: 1,
    adapterFingerprint: 'fake',
    status: 'active',
    statusReason: 'kit',
    secretRef: 'vault://presti/whatsapp-a',
    secretRotatedAt: '2026-10-01T10:00:00.000Z',
    createdBy: 'upgrade-kit',
  }, { actor: { type: 'user', id: 'upgrade-kit' } });
  assert.equal(stored.channel, 'whatsapp');

  // Phase 2: only the revision-3 evolution runs — the bootstrap and the
  // revision-2 evolution are already recorded, exactly like the ledger.
  const rev3Migrations = recordModuleMigrations([{ name: 'channel-connection', manifest: rev3 }]);
  const pending = rev3Migrations.filter((migration) => !applied.has(migration.name));
  assert.equal(pending.length, 1);
  assert.match(pending[0].name, /_r3$/);
  database.raw.exec(pending[0].sql);

  // The old row survived byte-for-byte, and the new enum values register.
  const after = serviceFor(database, rev3);
  const rows = after.listWhere({ sourceKey: 'wa:presti:+390200000099' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account, '+390200000099');
  assert.equal(rows[0].status, 'active');
  const added = await after.createManaged({
    sourceKey: 'stripe:presti:acct_presti',
    spaceId: 'presti',
    channel: 'stripe',
    account: 'acct_presti',
    adapter: 'stripe-webhook',
    adapterVersion: 1,
    adapterFingerprint: 'fake',
    status: 'pending',
    statusReason: 'kit',
    secretRef: 'vault://presti/stripe-a',
    secretRotatedAt: '2026-10-01T10:00:00.000Z',
    createdBy: 'upgrade-kit',
  }, { actor: { type: 'user', id: 'upgrade-kit' } });
  assert.equal(added.channel, 'stripe');
});
