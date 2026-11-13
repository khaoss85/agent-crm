import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAdminBundle } from '../apps/server/src/admin-bundle.js';
import { MODULE_NAMES, euro, moduleScreenLabel, plainAmount, plural } from '../apps/admin/public/admin-labels.js';
import { createdWithin } from '../apps/admin/public/admin-pipeline.js';
import { formatMoney } from '../apps/admin/public/admin-reporting.js';
import { pluralize } from '../apps/admin/public/admin-personalizzazione.js';
import { buildDashboardModel, formatMinor } from '../packages/analytics/src/dashboard.js';

/**
 * Famiglia F8 (backlog:9236684c96a7, 1d99c8207f90): money, counts and screen
 * names in Italian from the shared helpers of admin-labels.js, and a scan of
 * the served bundle and the view sources so a new screen cannot bring back
 * «1080,00 €» or an English label shown in capitals.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(root, 'apps/admin/public');
const source = (name) => readFileSync(join(PUBLIC_DIR, name), 'utf8');
/** Intl writes a no-break space before the symbol: compare what the eye reads. */
const seen = (text) => String(text).replace(/ | /g, ' ');

test('9236684c96a7: euro() groups the thousands always, cents always shown', () => {
  assert.equal(seen(euro(108000)), '1.080,00 €', '1080 € reads «1.080,00 €», never «1080,00 €»');
  assert.equal(seen(euro(2600000, 'EUR')), '26.000,00 €');
  assert.equal(seen(euro(99900)), '999,00 €');
  assert.equal(seen(euro(-108050)), '-1.080,50 €');
  assert.equal(seen(euro(0, 'USD')), '0,00 USD');
  assert.equal(seen(euro(108000, 'eur')), '1.080,00 €', 'a lower-case code is the same currency');
  assert.equal(seen(euro(108000, 'not a code')), '1.080,00 €', 'an unreadable code falls back to EUR');
  for (const bad of [1.5, NaN, Infinity, '108000', null, undefined]) assert.equal(euro(bad), null, `never a guessed figure: ${bad}`);
});

test('9236684c96a7: Reporting (Valore pipeline aperto, Preventivi aperti) reads «1.080,00 €»', () => {
  assert.equal(seen(formatMoney(108000, 'EUR')), '1.080,00 €');
  assert.equal(seen(formatMoney(108000)), '1.080,00 €');
  assert.equal(formatMoney(1.5, 'EUR'), 'n.d.');
});

/** Dashboard rows as the registry returns them (stage, currency, close date). */
const dashRow = (stage, totalMinor, count, close = '2026-11-10') => ({
  'opportunity.owner': 'alice', 'opportunity.stage': stage, 'opportunity.currency': 'EUR',
  'opportunity.expectedCloseDate': close, totalMinor, count,
});
const QUERY_NOV = Object.freeze({ period: '2026-11', owner: null, currency: 'EUR' });

test('review #761: the Reporting top cards are served with «€» and grouped thousands', () => {
  // The cards print kpi.display as served: the server formatter must agree
  // with the client euro() — «1.080,00 €», never «1080,00 €» nor «EUR».
  assert.equal(seen(formatMinor(108000, 'EUR')), '1.080,00 €');
  assert.equal(seen(formatMinor(2600000, 'EUR')), '26.000,00 €');
  const rows = [dashRow('qualification', 108000, 1), dashRow('won', 108000, 1), dashRow('lost', 5000, 1)];
  const model = buildDashboardModel({ byStage: { rows }, schedule: { rows } }, [], QUERY_NOV, '2026-11-13T00:00:00.000Z');
  const byId = Object.fromEntries(model.kpis.map((kpi) => [kpi.id, kpi]));
  for (const id of ['open-value', 'won-period', 'closing-period']) {
    assert.equal(seen(byId[id].display), '1.080,00 €', `${id} reads «1.080,00 €»`);
    assert.doesNotMatch(byId[id].display, /EUR/, `${id} never shows the ISO code`);
  }
  assert.equal(seen(byId['open-count'].sub), '1.080,00 €');
  assert.equal(seen(formatMoney(108000)), seen(byId['open-value'].display), 'cards and charts read the same figure');
});

test('review #761: Reporting card counts take the singular only for exactly one', () => {
  const one = [dashRow('qualification', 1000, 1), dashRow('won', 1000, 1), dashRow('lost', 1000, 1)];
  const model = buildDashboardModel({ byStage: { rows: one }, schedule: { rows: one } }, [], QUERY_NOV, '2026-11-13T00:00:00.000Z');
  const byId = Object.fromEntries(model.kpis.map((kpi) => [kpi.id, kpi]));
  assert.equal(byId['win-rate'].sub, '1 vinta, 1 persa');
  assert.equal(byId['open-value'].sub, '1 preventivo aperto');
  assert.equal(byId['won-period'].sub, '1 chiusura');
  assert.equal(byId['closing-period'].sub, '1 preventivo');
  const many = [dashRow('won', 1000, 2), dashRow('lost', 1000, 1)];
  const mixed = buildDashboardModel({ byStage: { rows: many }, schedule: { rows: many } }, [], QUERY_NOV, '2026-11-13T00:00:00.000Z');
  assert.equal(mixed.kpis.find((kpi) => kpi.id === 'win-rate').sub, '2 vinte, 1 persa');
});

test('famiglia F8: plural() takes the singular only for exactly one', () => {
  assert.equal(plural(1, 'appuntamento', 'appuntamenti'), '1 appuntamento');
  assert.equal(plural(0, 'riga', 'righe'), '0 righe');
  assert.equal(plural(3, 'chiamata registrata', 'chiamate registrate'), '3 chiamate registrate');
  assert.equal(pluralize(1, 'voce', 'voci'), '1 voce', 'Personalizzazione reads the shared rule');
});

test('1d99c8207f90: the breadcrumb of Nuova offerta names the screen in Italian, never «OPPORTUNITY»', () => {
  assert.equal(moduleScreenLabel('new', 'opportunity'), 'Nuova offerta');
  assert.equal(moduleScreenLabel('detail', 'opportunity'), 'Offerta');
  assert.equal(moduleScreenLabel('list', 'opportunity'), 'Offerte');
  assert.equal(moduleScreenLabel('new', 'company'), 'Nuova azienda');
  assert.equal(moduleScreenLabel('list', 'sonde-kpi'), 'Sonde kpi', 'a generated module reads the name the operator gave it');
  assert.equal(moduleScreenLabel('list', ''), 'Modulo');
  for (const names of Object.values(MODULE_NAMES)) {
    for (const word of Object.values(names)) assert.ok(!ENGLISH.test(word), `Italian module name: ${word}`);
  }
  const app = source('app.js');
  assert.ok(app.includes('label: moduleScreenLabel(target.view, target.moduleName)'), 'the shell crumb reads moduleScreenLabel');
  assert.ok(!/label:\s*target\.moduleName\b/.test(app), 'never the raw module key as the crumb');
});

/** English words a screen showed in capitals (kicker, eyebrow, crumb). */
const ENGLISH = /\b(?:module|generated|lifecycle|work|package|task|opportunit(?:y|ies)|company|contact|quote|order|contract|settings|overview|details?|new|edit|state|selected|run|observability|loading|error|save|cancel|update|reload)\b/i;

/**
 * The framework demo page (admin-demo.js and the demo cards of app.js) is the
 * English standalone page at the domain root, outside /bo: not scanned for
 * labels. Everything else the bundle serves is.
 */
const NOT_BO = new Set(['admin-demo.js', 'app.js']);

test('famiglia F8: no English label in a kicker, eyebrow or crumb of the /bo views', () => {
  const built = buildAdminBundle(PUBLIC_DIR);
  const views = built.order.filter((name) => name.endsWith('.js') && !NOT_BO.has(name));
  assert.ok(views.length > 30, `the scan covers the bundled views (${views.length})`);
  const offenders = [];
  const label = /(?:'(?:bo-)?(?:kicker|eyebrow)'|class:\s*'[^']*\b(?:kicker|eyebrow)\b[^']*'|eyebrow:)\s*,?\s*(?:text:\s*)?'([^']+)'/g;
  let scanned = 0;
  for (const name of views) {
    for (const match of source(name).matchAll(label)) {
      scanned += 1;
      if (ENGLISH.test(match[1])) offenders.push(`${name}: «${match[1]}»`);
    }
  }
  assert.ok(scanned > 10, `kicker/eyebrow literals found (${scanned})`);
  assert.deepEqual(offenders, [], 'English labels shown in capitals');
});

test('9236684c96a7: the served bundle has no money formatter without thousands separator', () => {
  const { jsBody } = buildAdminBundle(PUBLIC_DIR);
  // Every Italian currency formatter groups always: it-IT leaves «1080» bare.
  const formatters = [...jsBody.matchAll(/new Intl\.NumberFormat\(\s*'it-IT'\s*,\s*\{([^}]*)\}/g)];
  const currency = formatters.filter((match) => /style:\s*'currency'/.test(match[1]));
  assert.ok(currency.length >= 1, 'the shared euro() formatter is in the bundle');
  for (const match of currency) assert.match(match[1], /useGrouping:\s*'always'/, `grouping always: ${match[0]}`);
  // Hand-made money: a number turned to text by locale or toFixed and glued to €.
  assert.doesNotMatch(jsBody, /toLocaleString\(\s*'it-IT'\s*,\s*\{\s*minimumFractionDigits/, 'no ungrouped toLocaleString money');
  assert.doesNotMatch(jsBody, /\$\{[^}`]*(?:toFixed\(2\)|priceText\([^)]*\)|formatPriceCents\([^)]*\))[^}`]*\}\s*€/, 'no «45.00 €» glued by hand');
  // The views that write money read the shared helpers.
  assert.match(source('admin-reporting.js'), /return euro\(minor, currency\) \?\? 'n\.d\.'/);
  assert.match(source('admin-clienti.js'), /euro\(cents, code\)/);
  assert.match(source('admin-calendario.js'), /\$\{entry\.name\} · \$\{euro\(entry\.priceCents\) \?\? '—'\}/);
});

// Review #761 (P2): an offer with no currency must not read as euros: the
// amount stays grouped and bare, as main wrote it.
test('review #761: plainAmount groups without a symbol; Clienti never presumes €', () => {
  assert.equal(plainAmount(120000), '1.200,00');
  assert.equal(plainAmount(1.5), null);
  const clienti = source('admin-clienti.js');
  assert.match(clienti, /code === '' \? plainAmount\(cents\) : euro\(cents, code\)/, 'no currency: bare grouped amount');
  assert.doesNotMatch(clienti, /offerCurrency \?\? 'EUR'/, 'never a presumed EUR');
});

// Review #761 (P2): the «Creata» filter counts Rome days, like the column.
test('review #761: the Creata filter reads the Rome day the column shows', () => {
  const now = new Date('2026-11-11T10:00:00.000Z');
  // 23:30Z on 3 nov is 4 nov in Rome: inside «ultimi 7 giorni» (cutoff 4 nov).
  assert.equal(createdWithin('2026-11-03T23:30:00.000Z', 7, now), true, 'the Rome day, not the UTC day');
  assert.equal(createdWithin('2026-11-03T22:30:00.000Z', 7, now), false, '3 nov in Rome is out');
  // Rome after midnight while UTC is still the day before.
  const lateNight = new Date('2026-11-10T23:30:00.000Z'); // 11 nov 00:30 in Rome
  assert.equal(createdWithin('2026-11-04T12:00:00.000Z', 7, lateNight), true, 'today is the Rome today');
  assert.equal(createdWithin('2026-11-04', 7, lateNight), true, 'a bare day keeps its day');
  assert.equal(createdWithin('not a day', 7, now), false);
  assert.equal(createdWithin('2026-11-10T10:00:00.000Z', 0, now), false);
});
