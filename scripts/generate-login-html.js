// @ts-check
/**
 * Write the backoffice login page from its single source of truth.
 *
 *   node scripts/generate-login-html.js          # regenerate apps/admin/public/login.html
 *   node scripts/generate-login-html.js --check  # fail when the file drifted
 *
 * `apps/admin/public/login.html` is generated, never edited by hand: every
 * shared byte (story column, greeting, Google entry) lives in
 * `packages/magic-link/src/login-page.js`, and `tests/login-page.test.js`
 * pins the file byte-for-byte so hand edits fail in CI, not in review.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backofficeLoginHtml } from '../packages/magic-link/src/login-page.js';

const root = join(import.meta.dirname, '..');
const target = join(root, 'apps/admin/public/login.html');

const checkOnly = process.argv.includes('--check');
const wanted = backofficeLoginHtml();

if (checkOnly) {
  const current = readFileSync(target, 'utf8');
  if (current !== wanted) {
    console.error('apps/admin/public/login.html drifted from packages/magic-link/src/login-page.js: regenerate with `node scripts/generate-login-html.js`.');
    process.exit(1);
  }
  console.log('apps/admin/public/login.html matches its source.');
} else {
  writeFileSync(target, wanted);
  console.log('wrote apps/admin/public/login.html');
}
