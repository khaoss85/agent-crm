// @ts-check
/**
 * BO-F6-02 — one visual system for the /bo backoffice. The single component
 * library lives in `apps/admin/public/admin-ui.js` with the single stylesheet
 * `apps/admin/public/styles.css`; every /bo view renders its controls through
 * it, so no view renders a raw browser button, select, input or textarea.
 *
 * This test fails while any of that is untrue:
 * - a builder emits a control without a `ui-*` system class;
 * - a view module defines its own local `el` instead of the shared library;
 * - a rendered view (or the component catalog) contains a control whose
 *   class list carries no `ui-*` system class.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UI_AUTHORITIES,
  UI_CHANNELS,
  el,
  elFor,
  uiBadge,
  uiButton,
  uiCard,
  uiChannelChip,
  uiEmpty,
  uiIcon,
  uiSearchField,
  uiSecondaryButton,
  uiSecretField,
  uiSection,
  uiSegmented,
  uiSelect,
  uiSwitch,
  uiTable,
  uiTabs,
  uiToast,
} from '../apps/admin/public/admin-ui.js';
import { createUiCatalogView } from '../apps/admin/public/admin-ui-catalog.js';
import { createConnectorsView } from '../apps/admin/public/admin-connectors.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_PUBLIC = join(HERE, '..', 'apps', 'admin', 'public');

const CONTROL_TAGS = new Set(['button', 'select', 'input', 'textarea']);

/** Every control under root must carry at least one `ui-*` system class. */
function rawControls(root) {
  const out = [];
  const walk = (node) => {
    if (CONTROL_TAGS.has(String(node.tagName ?? '').toLowerCase())) {
      const classes = String(node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
      if (!classes.some((cls) => cls === 'ui' || cls.startsWith('ui-'))) {
        out.push(`${String(node.tagName).toLowerCase()}[${classes.join('.')}]`);
      }
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(root);
  return out;
}

test('el() normalizes every control onto the system, keeping legacy hooks', () => {
  const doc = createFakeDocument();
  const primary = el(doc, 'button', 'primary', 'Approve');
  assert.ok(primary.getAttribute('class').split(/\s+/).includes('ui-btn'));
  assert.ok(primary.getAttribute('class').split(/\s+/).includes('ui-btn-primary'));
  assert.ok(!primary.getAttribute('class').split(/\s+/).includes('ui-btn-cta'));
  assert.ok(primary.getAttribute('class').split(/\s+/).includes('primary'));
  const raw = el(doc, 'button', undefined, 'Cerca');
  assert.ok(raw.getAttribute('class').split(/\s+/).includes('ui-btn'));
  const field = el(doc, 'input', undefined, undefined);
  assert.ok(field.getAttribute('class').split(/\s+/).includes('ui-field'));
  const picked = el(doc, 'button', 'ui-btn-primary', 'Ok');
  assert.deepEqual(
    picked.getAttribute('class').split(/\s+/).filter((cls) => cls.startsWith('ui-btn')),
    ['ui-btn', 'ui-btn-primary'],
    'an explicit variant gains the base without doubling',
  );
});

test('an explicit ui-btn-* variant wins over the legacy mapping, never doubling', () => {
  const doc = createFakeDocument();
  const explicit = el(doc, 'button', 'bo-clienti-menubutton ui-btn-primary', 'Aggiungi cliente');
  const classes = explicit.getAttribute('class').split(/\s+/).filter(Boolean);
  assert.ok(classes.includes('ui-btn'), 'the base stays');
  assert.ok(classes.includes('ui-btn-primary'), 'the explicit primary stays');
  assert.ok(!classes.includes('ui-btn-secondary'), 'the legacy secondary is not added beside an explicit variant');
  const legacy = el(doc, 'button', 'bo-clienti-menubutton', 'Filtri');
  assert.ok(legacy.getAttribute('class').split(/\s+/).includes('ui-btn-secondary'), 'without an explicit variant the legacy mapping still applies');
});

test('el() supports the options-object signature of the migrated views', () => {
  const doc = createFakeDocument();
  const node = el(doc, 'select', { className: 'bo-filter', attrs: { name: 'stato' } });
  assert.equal(node.tagName, 'SELECT');
  assert.equal(node.getAttribute('name'), 'stato');
  assert.ok(node.getAttribute('class').split(/\s+/).includes('ui-field'));
});

test('elFor(doc) keeps the closure signature of the migrated views', () => {
  const doc = createFakeDocument();
  const local = elFor(doc);
  const chip = local('button', 'bo-clienti-item active', 'Tutti');
  assert.ok(chip.getAttribute('class').split(/\s+/).includes('ui-chip'));
  assert.ok(chip.getAttribute('class').split(/\s+/).includes('bo-clienti-item'));
});

test('no view module defines its own el: the library is single', () => {
  const offenders = [];
  for (const entry of readdirSync(ADMIN_PUBLIC)) {
    if (!entry.endsWith('.js') || entry === 'admin-ui.js' || entry === 'admin-ui-catalog.js') continue;
    const source = readFileSync(join(ADMIN_PUBLIC, entry), 'utf8');
    // A local definition builds its own element helper; `const el = elFor(doc)`
    // is the shared library under an alias, not a definition.
    if (/(^|\n)\s*function el\(/.test(source)) offenders.push(entry);
    else if (/(^|\n)\s*const el = (?!\s*elFor\()/.test(source)) offenders.push(entry);
  }
  assert.deepEqual(offenders, [], 'every view imports el from admin-ui.js');
});

test('builders emit system classes with text-only content', () => {
  const doc = createFakeDocument();
  assert.ok(uiButton(doc, { variant: 'primary', label: 'Invia follow-up' }).getAttribute('class').includes('ui-btn-primary'));
  assert.ok(uiButton(doc, { variant: 'cta', label: 'Aggiungi' }).getAttribute('class').includes('ui-btn-cta'));
  assert.ok(uiSecondaryButton(doc, 'Annulla').getAttribute('class').includes('ui-btn-secondary'));
  const hostile = uiButton(doc, { variant: 'primary', label: '<img src=x onerror=1>' });
  assert.equal(hostile.textContent, '<img src=x onerror=1>');
  assert.equal(hostile.childNodes.length, 0, 'labels travel as text, never markup');
  const tabs = uiTabs(doc, [{ id: 'a', label: 'Skill AI' }, { id: 'b', label: 'Connettori', active: true }]);
  assert.deepEqual(rawControls(tabs), []);
  const segmented = uiSegmented(doc, [{ id: 'mine', label: 'I tuoi' }, { id: 'discover', label: 'Scopri', active: true }]);
  assert.deepEqual(rawControls(segmented), []);
  const search = uiSearchField(doc, { placeholder: 'Cerca', value: '' });
  assert.deepEqual(rawControls(search), []);
  const select = uiSelect(doc, { name: 'stato', options: [{ value: 'all', label: 'Tutti' }] });
  assert.deepEqual(rawControls(select), []);
  const onSwitch = uiSwitch(doc, { name: 'sync', checked: true, label: 'Sincronizza' });
  assert.deepEqual(rawControls(onSwitch), []);
  const table = uiTable(doc, { columns: ['Nome', 'Stato'], rows: [['Ada', 'attivo']] });
  assert.deepEqual(rawControls(table), []);
  assert.ok(uiCard(doc, {}).getAttribute('class').includes('ui-card'));
  assert.ok(uiEmpty(doc, { title: 'Nessun elemento.' }).getAttribute('class').includes('ui-empty'));
  assert.ok(uiToast(doc, { text: 'Salvato.' }).getAttribute('class').includes('ui-toast'));
  assert.ok(uiSection(doc, { title: 'Oggi' }).getAttribute('class').includes('ui-section'));
  const secret = uiSecretField(doc, { name: 'token', label: 'Token' });
  assert.deepEqual(rawControls(secret), []);
});

test('channel chips cover the ten prototype channels', () => {
  const doc = createFakeDocument();
  assert.deepEqual([...UI_CHANNELS].sort(), ['@', 'CAL', 'FB', 'IG', 'S', 'TEL', 'TG', 'TT', 'WA', 'WEB']);
  const expectedTint = {
    IG: 'ui-chip-ig',
    WA: 'ui-chip-wa',
    TEL: 'ui-chip-tel',
    '@': 'ui-chip-at',
    CAL: 'ui-chip-cal',
    S: 'ui-chip-s',
    FB: 'ui-chip-fb',
    TT: 'ui-chip-tt',
    WEB: 'ui-chip-web',
    TG: 'ui-chip-tg',
  };
  for (const channel of UI_CHANNELS) {
    const chip = uiChannelChip(doc, channel);
    const classes = chip.getAttribute('class').split(/\s+/);
    assert.ok(classes.includes('ui-chip'), `${channel} is a system chip`);
    assert.ok(classes.includes(expectedTint[channel]), `${channel} has its own tint, not the plain fallback`);
  }
});

test('authority badges name the five prototype authorities, red for faults only', () => {
  const doc = createFakeDocument();
  assert.deepEqual([...UI_AUTHORITIES].sort(), ['accord', 'agent', 'data', 'evidence', 'human', 'pending']);
  for (const authority of UI_AUTHORITIES) {
    const badge = uiBadge(doc, { authority, text: 'approved' });
    assert.ok(badge.getAttribute('class').includes(`ui-badge-${authority}`));
    assert.equal(badge.textContent, 'approved', 'badges show the machine string unmodified');
  }
  const icon = uiIcon(doc, 'clienti');
  assert.equal(String(icon.tagName).toLowerCase(), 'svg');
  assert.ok(String(icon.getAttribute('class')).includes('ui-icon'));
  // Unknown ids (custom modules) share the neutral 'nuovo' glyph, never Oggi's sun.
  assert.equal(
    uiIcon(doc, 'module-xyz').getAttribute('data-paths'),
    uiIcon(doc, 'nuovo').getAttribute('data-paths'),
  );
});

test('the component catalog renders no raw control', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  createUiCatalogView({ doc, mount }).render();
  const raw = rawControls(mount);
  assert.deepEqual(raw, [], 'every catalog control carries a ui-* class');
  assert.ok(mount.textContent.includes('Primario scuro'), 'the catalog shows the dark primary');
  assert.ok(mount.textContent.includes('CTA verde'), 'the catalog shows the green CTA');
});

test('the connectors view renders no raw control', async () => {
  // BO-F6-02 AC-3 "dopo" for /bo connectors: the existing view paints its
  // channel rows through the single library, so no button, select or input
  // reaches the DOM without a ui-* system class (the row opener is a plain
  // link wearing the row words, not a control). The Collega count below
  // proves the rows painted instead of an honest empty note.
  const doc = createFakeDocument();
  const mount = createMount();
  const channels = ['whatsapp', 'instagram', 'facebook', 'tiktok', 'sms', 'email', 'voice', 'site-form'];
  const client = {
    async request(path) {
      if (path === '/api/schema') {
        return {
          domains: {
            channels: {
              metadata: {
                channelsContract: 1,
                adapters: channels.map((channel) => ({ channel, name: `${channel}-fake`, version: 1 })),
              },
            },
          },
        };
      }
      if (path.startsWith('/api/connectors?')) return { connectors: [] };
      throw new Error(`unexpected request ${path}`);
    },
  };
  const storage = { getItem: () => 'locale', setItem: () => {}, removeItem: () => {} };
  await createConnectorsView({ doc, mount, client, navigate: () => {}, storage }).render();
  const flows = mount.findAll('button').filter((node) => node.textContent === 'Collega').length;
  assert.equal(flows, 8, 'all eight connectable channel rows offer Collega (Telegram has no adapter)');
  assert.deepEqual(rawControls(mount), [], 'every connectors control carries a ui-* class');
});
