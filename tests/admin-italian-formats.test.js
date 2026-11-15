import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAdminBundle } from '../apps/server/src/admin-bundle.js';
import { MODULE_NAMES, moduleScreenLabel, plural } from '../apps/admin/public/admin-labels.js';
import { formatAmount } from '../apps/admin/public/admin-core.js';
import { createdWithin } from '../apps/admin/public/admin-pipeline.js';
import { pluralize } from '../apps/admin/public/admin-personalizzazione.js';
import { buildDashboardModel, formatMinor } from '../packages/analytics/src/dashboard.js';

/**
 * Famiglia F8 (backlog:9236684c96a7, 1d99c8207f90, 93e26f3d2cdc): money in
 * Italian from the single display helper formatAmount in admin-core.js
 * («1.080 €», cents only when non-zero), counts and screen names from the
 * shared helpers of admin-labels.js, and a scan of the served bundle and
 * the view sources so a new screen cannot bring back a second helper,
 * hand-made money («1080 €», «45.00 €») or an English label in capitals.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(root, 'apps/admin/public');
const source = (name) => readFileSync(join(PUBLIC_DIR, name), 'utf8');
/** Intl writes a no-break space before the symbol: compare what the eye reads. */
const seen = (text) => String(text).replace(/ | /g, ' ');

test('93e26f3d2cdc: one display helper — formatAmount groups the thousands, cents only when non-zero', () => {
  assert.equal(seen(formatAmount(108000, 'EUR')), '1.080 €', '1080 € reads «1.080 €», never «1080 €»');
  assert.equal(seen(formatAmount(2600000, 'EUR')), '26.000 €');
  assert.equal(seen(formatAmount(99900, 'EUR')), '999 €');
  assert.equal(seen(formatAmount(-108050, 'EUR')), '-1.080,50 €');
  assert.equal(seen(formatAmount(0, 'USD')), '0 USD');
  assert.equal(seen(formatAmount(108000, '')), '1.080', 'a missing code reads the bare grouped amount');
  for (const bad of [1.5, NaN, Infinity, '108000', null, undefined]) {
    assert.equal(formatAmount(bad, 'EUR'), '—', `never a guessed figure: ${bad}`);
  }
});

test('93e26f3d2cdc: formatAmount never throws on an unknown or malformed currency', () => {
  for (const code of ['XYZ', 'QQQ', 'E1R', 'EURO', 42, {}]) {
    assert.doesNotThrow(() => formatAmount(108000, code), `no throw for ${String(code)}`);
  }
  assert.equal(seen(formatAmount(108000, 'XYZ')), '1.080 XYZ', 'unknown code: grouped amount with the code, never a presumed €');
});

test('93e26f3d2cdc: Clienti, Reporting, Pipeline and the scheda read the same shape', () => {
  assert.equal(seen(formatAmount(108000, 'EUR')), '1.080 €');
  // Every screen that writes money renders through formatAmount (checked by
  // the source scan below), so the same cents read the same everywhere.
  assert.match(source('admin-clienti.js'), /formatAmount\(Number\(row\.offerValueCents\), row\.offerCurrency \?\? ''\)/);
  assert.match(source('admin-pipeline.js'), /formatAmount\(record\.valueCents, record\.currency\)/);
  assert.match(source('admin-customer-card.js'), /formatAmount\(first\.amountCents, first\.currency\)/);
  assert.match(source('admin-reporting.js'), /formatAmount\(entry\.minor, model\.currency\)/);
  // Oggi renders no amounts (no money helper, no cents, no €): nothing to unify.
  assert.doesNotMatch(source('admin-oggi.js'), /formatAmount|formatMoney|Cents\b/, 'Oggi shows no money');
  assert.doesNotMatch(source('admin-oggi.js'), /€/, 'Oggi shows no money');
});

/** Dashboard rows as the registry returns them (stage, currency, close date). */
const dashRow = (stage, totalMinor, count, close = '2026-11-10') => ({
  'opportunity.owner': 'alice', 'opportunity.stage': stage, 'opportunity.currency': 'EUR',
  'opportunity.expectedCloseDate': close, totalMinor, count,
});
const QUERY_NOV = Object.freeze({ period: '2026-11', owner: null, currency: 'EUR' });

test('review #761: the Reporting top cards are served with «€» and grouped thousands', () => {
  // The cards print kpi.display as served by packages/analytics: that shape
  // («1.080,00 €») is the server contract and stays — the client rows and
  // the other screens read the single formatAmount shape («1.080 €»,
  // backlog:93e26f3d2cdc). Aligning the served shape is a server follow-up,
  // not this voice.
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

test('1d99c8207f90: the breadcrumb of Nuova offerta names the screen in Italian, never «OPPORTUNITY»', async () => {
  assert.equal(moduleScreenLabel('new', 'opportunity'), 'Nuova offerta');
  assert.equal(moduleScreenLabel('detail', 'opportunity'), 'Offerta');
  assert.equal(moduleScreenLabel('list', 'opportunity'), 'Offerte');
  assert.equal(moduleScreenLabel('new', 'company'), 'Nuova azienda');
  assert.equal(moduleScreenLabel('list', 'sonde-kpi'), 'Sonde kpi', 'a generated module reads the name the operator gave it');
  assert.equal(moduleScreenLabel('list', ''), 'Modulo');
  for (const names of Object.values(MODULE_NAMES)) {
    for (const word of Object.values(names)) assert.ok(!ENGLISH.test(word), `Italian module name: ${word}`);
  }
  // The shell crumb (shellScreenFor, moved from app.js to admin-shell.js
  // in backlog:8618ad3f72db) reads moduleScreenLabel, never the raw key.
  const { shellScreenFor } = await import('../apps/admin/public/admin-shell.js');
  assert.equal(shellScreenFor({ view: 'new', moduleName: 'opportunity' }).label, 'Nuova offerta', 'the shell crumb reads moduleScreenLabel');
  assert.notEqual(shellScreenFor({ view: 'list', moduleName: 'opportunity' }).label, 'opportunity', 'never the raw module key as the crumb');
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

test('93e26f3d2cdc: a single display helper — no currency formatter, no hand-made money', () => {
  const { jsBody } = buildAdminBundle(PUBLIC_DIR);
  // Display money goes through formatAmount (hand-rolled, pinned grouping):
  // no Intl currency formatter belongs to a /bo view. The only currency
  // formatter left in the bundle is the en-IE demo page (app.js, outside
  // /bo, excluded from the view scan like the other NOT_BO sources).
  const currency = [...jsBody.matchAll(/new Intl\.NumberFormat\(\s*'([^']+)'\s*,\s*\{([^}]*)\}/g)]
    .filter((match) => /style:\s*'currency'/.test(match[2]));
  assert.deepEqual(
    currency.map((match) => match[1]),
    ['en-IE'],
    'the only currency formatter is the app.js demo',
  );
  // Hand-made money: a number turned to text by locale or toFixed and glued to €.
  assert.doesNotMatch(jsBody, /toLocaleString\(\s*'it-IT'\s*,\s*\{\s*minimumFractionDigits/, 'no ungrouped toLocaleString money');
  assert.doesNotMatch(jsBody, /\$\{[^}`]*(?:toFixed\(2\)|priceText\([^)]*\)|formatPriceCents\([^)]*\))[^}`]*\}\s*€/, 'no «45.00 €» glued by hand');
  // Exactly one money-display helper is defined in apps/admin/public
  // (formatAmount in admin-core.js). Out of scope by design: the machine
  // form for exports/logs (formatMinorUnits), the form-prefill text
  // (formatPriceCents) and the input parsers (parseEuroToCents/euroToCents).
  const defined = [];
  for (const name of readdirSync(PUBLIC_DIR).filter((file) => file.endsWith('.js'))) {
    // Parsers (parseEuroToCents, euroToCents), the machine form
    // (formatMinorUnits) and the form-prefill text (formatPriceCents) are
    // inputs/exports, not display: the stems below are display only.
    for (const match of source(name).matchAll(/export (?:function|const) (formatAmount|formatMoney|euro|italianEuros|formatCurrency)\b/g)) {
      defined.push(`${name}#${match[1]}`);
    }
  }
  assert.deepEqual(defined, ['admin-core.js#formatAmount'], `one display helper, none elsewhere: ${defined}`);
  // The views that write money read it.
  assert.match(source('admin-reporting.js'), /formatAmount\(entry\.minor, model\.currency\)/);
  // Clienti and the Calendario service menu use main's grouped helper
  // (formatAmount, backlog:5c2f8bc67859 and c2f21b5debdd): same «1.080» grouping.
  assert.match(source('admin-clienti.js'), /formatAmount\(Number\(row\.offerValueCents\), row\.offerCurrency \?\? ''\)/);
  assert.match(source('admin-calendario.js'), /\$\{entry\.name\} · \$\{formatAmount\(cents, 'EUR'\)\}/);
});

// Review #761 (P2): an offer with no currency must not read as euros: the
// amount stays grouped and bare, as main wrote it.
test('review #761: no symbol without a currency; Clienti never presumes €', () => {
  assert.equal(formatAmount(120000, ''), '1.200');
  assert.equal(formatAmount(1.5, 'EUR'), '—');
  const clienti = source('admin-clienti.js');
  assert.match(clienti, /row\.offerCurrency \?\? ''/, 'no currency: bare grouped amount (formatAmount writes no unit)');
  assert.doesNotMatch(clienti, /offerCurrency \?\? 'EUR'/, 'never a presumed EUR');
});

// Review #761 (P2): the «Creata» filter counts Rome days, like the column.
test('review #761: the Creata filter reads the Rome day the column shows', () => {
  const now = new Date('2026-11-11T10:00:00.000Z');
  // 23:30Z on 4 nov is 5 nov in Rome: inside «ultimi 7 giorni» (cutoff 5 nov: today + 6 days back).
  assert.equal(createdWithin('2026-11-04T23:30:00.000Z', 7, now), true, 'the Rome day, not the UTC day');
  assert.equal(createdWithin('2026-11-04T22:30:00.000Z', 7, now), false, '4 nov in Rome is out');
  // Review #761 P1: an impossible bare day fails closed, never a guessed day.
  assert.equal(createdWithin('2026-99-99', 7, now), false, 'impossible month/day');
  assert.equal(createdWithin('2026-11-31', 7, now), false, '31 nov does not exist (V8 would roll it to 1 dic)');
  assert.equal(createdWithin('2026-11-10', 7, now), true, 'a real bare day still counts');
  // Rome after midnight while UTC is still the day before.
  const lateNight = new Date('2026-11-10T23:30:00.000Z'); // 11 nov 00:30 in Rome
  assert.equal(createdWithin('2026-11-05T12:00:00.000Z', 7, lateNight), true, 'today is the Rome today');
  assert.equal(createdWithin('2026-11-05', 7, lateNight), true, 'a bare day keeps its day');
  assert.equal(createdWithin('2026-11-04T12:00:00.000Z', 7, lateNight), false, '7 days back from 11 nov is 5 nov');
  assert.equal(createdWithin('2026-11-04', 7, lateNight), false, 'the 8th day stays out');
  assert.equal(createdWithin('not a day', 7, now), false);
  assert.equal(createdWithin('2026-11-10T10:00:00.000Z', 0, now), false);
});

test('review #761: Reporting cards share label/amount/sub rows, so a wrapped label never drops its amount', () => {
  const css = source('styles.css');
  assert.match(css, /\.bo-rep \.metric \{ display: grid; grid-row: span 3; grid-template-rows: subgrid;/);
});
