// @ts-check
/**
 * backlog:4ec1fe6d01c6 (verifica 13/11: aria-live solo sui messaggi) —
 * `#view-module` dipinge intere schermate, quindi non è una live region:
 * annunciarla rileggerebbe la pagina a ogni cambio. Gli annunci restano
 * solo sui messaggi: il toast `#toast` è `role="status"`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'admin', 'public');
const html = readFileSync(join(root, 'index.html'), 'utf8');

/** @param {string} id */
function tagFor(id) {
  const match = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(match, `index.html dipinge #${id}`);
  return match[0];
}

test('4ec1fe6d01c6: #view-module non è una live region', () => {
  const tag = tagFor('view-module');
  assert.ok(!/aria-live/i.test(tag), `#view-module non annuncia la pagina: ${tag}`);
  assert.ok(!/\brole="(status|alert|log)"/i.test(tag), `#view-module non ha ruolo live: ${tag}`);
});

test('4ec1fe6d01c6: i messaggi restano annunciati dal toast', () => {
  const tag = tagFor('toast');
  assert.ok(/\brole="status"/i.test(tag), `il toast annuncia i messaggi: ${tag}`);
});
