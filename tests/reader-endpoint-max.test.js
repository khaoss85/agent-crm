// @ts-check

/**
 * The reader pool share (backlog:a4cc9c96b266).
 *
 * A deployment that shares one role-limited login between several pools —
 * the shared web holds a direct tenant pool plus this reader composition on
 * the same reader role — names each pool's share in `selection.connection.max`.
 * The bootstrap already honoured `max`; the wiring dropped it, so every reader
 * opened the default 4 and the role limit fired. The share travels only when
 * it is a positive integer: absent or invalid means the default, never zero
 * (a zero-client pool would refuse every read).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readerArgumentsFrom } from '../packages/app/src/create-app-async.js';

const secretResolver = {
  resolveSecret: async () => ({ use: async (fn) => fn('pool-password') }),
};

function argsFor(connection) {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-reader-max-'));
  try {
    const caFile = join(directory, 'ca.pem');
    writeFileSync(caFile, 'fake-ca-for-wiring-test');
    chmodSync(caFile, 0o600);
    return readerArgumentsFrom(
      {
        deployment: {
          selection: {
            adapter: 'postgresql',
            access: 'read-only',
            spine: { mode: 'managed-cloud', tenant: { id: 'tenant-1' } },
            connection: {
              host: 'db.example.test',
              database: 'data',
              user: 'reader',
              passwordSecret: 'DATA_PLANE_PASSWORD',
              tls: { caFile },
              ...connection,
            },
          },
          secretResolver,
        },
      },
      { selected: {}, listenMode: 'managed-cloud' },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a4cc9c96b266: the reader pool share in the selection reaches the pool', () => {
  assert.equal(argsFor({ max: 1 }).data.max, 1, 'the share travels');
  assert.ok(!('max' in argsFor({}).data), 'absent means the default, not zero');
  for (const bad of [0, -2, 2.5, '4', null]) {
    assert.ok(!('max' in argsFor({ max: bad }).data), `invalid share ${String(bad)} is dropped`);
  }
});
