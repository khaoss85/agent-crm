import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { renderUnknownRoute } from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Rotta sconosciuta (backlog:55985e25ddd2).
 *
 * What it must prove: a backoffice hash the router cannot open shows plain
 * Italian with a way back to Oggi — never the old English «That module route
 * is not valid.» — and #/clienti, the natural Italian name, opens Clienti.
 */

// Words that only English router copy would carry.
const ENGLISH = /\b(the|that|this|is|not|valid|invalid|route|module|page|found|error|go to)\b/i;

test('an unknown route shows Italian copy with a link to Oggi', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  mount.appendChild(doc.createElement('p')).textContent = 'schermata precedente';
  renderUnknownRoute({ doc, mount });
  assert.ok(mount.textContent.includes('Questa pagina non esiste.'), mount.textContent);
  assert.ok(!mount.textContent.includes('schermata precedente'), 'the previous screen is cleared');
  assert.doesNotMatch(mount.textContent, ENGLISH);
  const links = mount.findAll('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), '#/');
  assert.equal(links[0].textContent, 'Vai a Oggi');
});

test('#/clienti opens the Clienti list; other clienti paths keep their meaning', () => {
  assert.deepEqual(parseModuleRoute('#/clienti'), { view: 'customer-data' });
  assert.deepEqual(parseModuleRoute('#/clienti/'), { view: 'customer-data' });
  assert.deepEqual(parseModuleRoute('#/clienti/nuovo'), { view: 'customer-new' });
  assert.deepEqual(parseModuleRoute('#/clienti/altro'), { view: 'invalid' });
});

test('the router error copy carries no English', () => {
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('async function route()');
  const end = app.indexOf("window.addEventListener('hashchange', route);");
  assert.ok(start !== -1 && end > start, 'the router is found in app.js');
  const router = app.slice(start, end);
  assert.ok(!app.includes('route is not valid'), 'the old English message is gone');
  assert.ok(router.includes('renderUnknownRoute('), 'the invalid branch paints the shared Italian panel');
  // Every human sentence the router writes (a quoted literal with a space)
  // reads in Italian.
  const sentences = [...router.matchAll(/'([^'\n]*\s[^'\n]*)'/g)].map((match) => match[1]);
  for (const sentence of sentences) assert.doesNotMatch(sentence, ENGLISH, sentence);
  const shell = readFileSync(new URL('../apps/admin/public/admin-shell.js', import.meta.url), 'utf8');
  const helper = shell.slice(shell.indexOf('export function renderUnknownRoute'));
  const copy = [...helper.slice(0, helper.indexOf('\n}\n')).matchAll(/'([^'\n]*\s[^'\n]*)'/g)].map((match) => match[1]);
  assert.ok(copy.length > 0, 'the panel copy is found');
  for (const sentence of copy) assert.doesNotMatch(sentence, ENGLISH, sentence);
});
