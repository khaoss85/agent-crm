import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldModule } from '../packages/cli/src/scaffold-module.js';

test('module scaffolding is dry-run unless apply is explicit', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-crm-scaffold-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const dryRun = scaffoldModule({ name: 'partner', rootDir: directory });
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(existsSync(join(directory, 'packages/modules/partner')), false);

  const applied = scaffoldModule({ name: 'partner', rootDir: directory, apply: true });
  assert.equal(applied.mode, 'applied');
  assert.equal(existsSync(join(directory, 'packages/modules/partner/src/partner-service.js')), true);
});
