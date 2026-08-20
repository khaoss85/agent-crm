import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindTenantStorage } from '../packages/core/src/tenant-storage.js';

/**
 * **The two planes may not be one file, however that file is named.**
 *
 * Review finding. `bindTenantStorage` refuses a control plane that resolves to
 * the tenant's own database, because that would put `spine_memberships` inside
 * the data a tenant's own users can reach — the whole reason the planes are
 * separate. The check compared the two resolved path *strings*.
 *
 * `resolve()` normalizes `.` and `..`. It does not follow a symbolic link, and
 * it cannot see a hard link at all. So a `controlPlanePath` pointing at the
 * tenant file through either kind of link had a different string and the same
 * bytes, and the collision check reported two planes where there was one file.
 *
 * A control that the most ordinary filesystem indirection defeats is worse than
 * no control, because it is relied upon. These hold all three forms.
 */

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plane-collision-'));
  mkdirSync(join(root, 'tenants'), { recursive: true });
  const tenantFile = join(root, 'tenants', 'tenant-a.sqlite');
  writeFileSync(tenantFile, '');
  return { root, tenantFile };
}

const collides = (options) => {
  try {
    bindTenantStorage(options);
    return null;
  } catch (error) {
    return error.code;
  }
};

test('the planes may not be the same file by path', () => {
  const { root, tenantFile } = fixture();
  assert.equal(collides({ root, tenantId: 'tenant-a', controlPlanePath: tenantFile }),
    'TENANT_PLANES_COLLIDE');
});

test('the planes may not be the same file through a symlink', () => {
  const { root, tenantFile } = fixture();
  const link = join(root, 'control-symlink.sqlite');
  symlinkSync(tenantFile, link);
  assert.equal(collides({ root, tenantId: 'tenant-a', controlPlanePath: link }),
    'TENANT_PLANES_COLLIDE',
    'a symlinked control plane is the tenant file wearing another name');
});

test('the planes may not be the same file through a hard link', () => {
  const { root, tenantFile } = fixture();
  const link = join(root, 'control-hardlink.sqlite');
  linkSync(tenantFile, link);
  assert.equal(collides({ root, tenantId: 'tenant-a', controlPlanePath: link }),
    'TENANT_PLANES_COLLIDE',
    'a hard link has its own real path and the same inode');
});

test('the planes may not collide through a traversal that normalizes onto the tenant file', () => {
  const { root } = fixture();
  const sneaky = join(root, 'tenants', '..', 'tenants', 'tenant-a.sqlite');
  assert.equal(collides({ root, tenantId: 'tenant-a', controlPlanePath: sneaky }),
    'TENANT_PLANES_COLLIDE');
});

test('a genuinely separate control plane still binds, and exposes no path resolver', () => {
  const { root } = fixture();
  const binding = bindTenantStorage({ root, tenantId: 'tenant-a' });
  assert.notEqual(binding.dataPlanePath, binding.controlPlanePath);
  assert.equal(typeof binding.databasePathFor, 'undefined',
    'a bound handle cannot name a second tenant at all');
  assert.ok(Object.isFrozen(binding));

  // And the check must not fire merely because neither file exists yet, which
  // is the ordinary case at first boot.
  const fresh = mkdtempSync(join(tmpdir(), 'plane-fresh-'));
  const first = bindTenantStorage({ root: fresh, tenantId: 'tenant-a' });
  assert.notEqual(first.dataPlanePath, first.controlPlanePath);
});
