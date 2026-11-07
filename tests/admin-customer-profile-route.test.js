// backlog:6542f55ecf8d — the old «Profilo cliente» page (English role lines,
// raw ids such as «canonical: contact eb32b811…») must not be reachable from
// the /bo: its route `#/customer-data/<resource>/<id>` now opens the customer
// scheda, and no link in the backoffice builds the old path any more.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'apps/admin/public');

test('the old profile route opens the customer scheda', () => {
  assert.deepEqual(parseModuleRoute('#/customer-data/contact/c1'),
    { view: 'customer-card', resource: 'contact', subjectId: 'c1' });
  assert.deepEqual(parseModuleRoute('#/customer-data/company/eb32b811-0000-4000-8000-000000000001'),
    { view: 'customer-card', resource: 'company', subjectId: 'eb32b811-0000-4000-8000-000000000001' });
  // Same result as the canonical scheda route.
  assert.deepEqual(parseModuleRoute('#/customer-data/contact/c1'), parseModuleRoute('#/customer-card/contact/c1'));
});

test('the Clienti list route stays the list, malformed profile paths stay invalid', () => {
  assert.deepEqual(parseModuleRoute('#/customer-data'), { view: 'customer-data' });
  for (const hash of [
    '#/customer-data/contact',
    '#/customer-data/contact/c1/extra',
    '#/customer-data//c1',
    '#/customer-data/Contact/c1',
  ]) {
    assert.equal(parseModuleRoute(hash).view, 'invalid', hash);
  }
});

test('the shell never dispatches the old profile view', () => {
  const app = readFileSync(join(publicDir, 'app.js'), 'utf8');
  assert.doesNotMatch(app, /customer-profile/);
  assert.doesNotMatch(app, /renderProfile/);
});

test('no /bo link points to the old profile path', () => {
  const files = readdirSync(publicDir).filter((name) => /\.(js|html)$/.test(name));
  assert.ok(files.includes('app.js') && files.includes('index.html'));
  const offenders = [];
  for (const name of files) {
    const source = readFileSync(join(publicDir, name), 'utf8');
    // Any hash link — literal, template or concatenation — that goes past
    // the list route: `#/customer-data/<segment>`. The list `#/customer-data`
    // alone is fine, and so is the bare prefix `'#/customer-data/'` the
    // router compares against when it rewrites the old path. Comments are
    // stripped line-wise so a doc mention is not a link.
    const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    if (/#\/customer-data\/(?!['"`])/.test(code)) offenders.push(name);
    if (/['"`]#\/customer-data\/?['"`]\s*\+/.test(code)) offenders.push(`${name} (concatenation)`);
  }
  assert.deepEqual(offenders, []);
});
