import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMountGate, paintScreenLoading } from '../apps/admin/public/admin-navigation.js';
import { createOggiView } from '../apps/admin/public/admin-oggi.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Cambio schermata (production verification 07/11).
 *
 * What it must prove: on a slow or sleeping web the breadcrumb moved at once
 * while the old screen stayed under it for 5–25 s, and Oggi showed only its
 * shortcut list for ~10 s. Now every navigation clears the shared mount in
 * the same tick and shows a neutral loading line for the new screen; a
 * screen left behind that answers late never paints over the new one; and
 * Oggi shows the loading line, not the shortcuts, while its reads pend.
 */

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const busyNodes = (mount) => mount.findAll('div').filter((node) => node.getAttribute('aria-busy') === 'true');

/**
 * A view in the shape most /bo views have: read first, then clear the mount
 * and paint — with no guard of its own.
 */
function slowView(doc, mount, text, read) {
  return async () => {
    await read;
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    const panel = doc.createElement('div');
    panel.textContent = text;
    mount.appendChild(panel);
    return mount.querySelector('div');
  };
}

test('navigation clears the old screen in the same tick and shows the loading state', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  mount.appendChild(doc.createElement('p')).textContent = 'Pipeline: 12 offerte aperte';
  paintScreenLoading({ doc, mount, label: 'Stato sync' });
  assert.ok(!mount.textContent.includes('Pipeline'), 'the old screen is gone at once');
  assert.equal(mount.textContent, 'Carico Stato sync…');
  const [busy] = busyNodes(mount);
  assert.ok(busy, 'the loading line is marked busy');
  assert.equal(busy.getAttribute('role'), 'status');
  assert.ok(busy.getAttribute('class').includes('ui-loading'));
});

test('a slow previous view resolving late never paints over the new screen', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const gate = createMountGate(mount);
  const pipelineRead = deferred();
  const syncRead = deferred();
  const renderPipeline = slowView(doc, gate.owned('pipeline'), 'Pipeline: 12 offerte aperte', pipelineRead.promise);
  const renderSync = slowView(doc, gate.owned('sync'), 'Stato sync: tutto in ordine', syncRead.promise);

  // Pipeline opens; its read hangs (the web is asleep).
  gate.activate('pipeline');
  paintScreenLoading({ doc, mount, label: 'Pipeline' });
  const pipelineDone = renderPipeline();
  // The operator moves to Stato sync before the Pipeline answers.
  gate.activate('sync');
  paintScreenLoading({ doc, mount, label: 'Stato sync' });
  assert.equal(mount.textContent, 'Carico Stato sync…');

  // The Pipeline answers while Stato sync still loads: the loading line stays.
  pipelineRead.resolve();
  const lateQuery = await pipelineDone;
  assert.equal(lateQuery, null, 'the late view sees an empty mount, not the new screen');
  assert.equal(mount.textContent, 'Carico Stato sync…');
  assert.equal(busyNodes(mount).length, 1);

  syncRead.resolve();
  await renderSync();
  assert.equal(mount.textContent, 'Stato sync: tutto in ordine');
  assert.equal(busyNodes(mount).length, 0, 'the screen paint replaces the loading line');
});

test('a late view that answers after the new screen painted leaves it untouched', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const gate = createMountGate(mount);
  const sequenzeRead = deferred();
  const renderSequenze = slowView(doc, gate.owned('sequenze'), 'Sequenze', sequenzeRead.promise);
  const renderSpazi = slowView(doc, gate.owned(['spazi-accessi']), 'Spazi e accessi', Promise.resolve());

  gate.activate('sequenze');
  const sequenzeDone = renderSequenze();
  gate.activate('spazi-accessi');
  paintScreenLoading({ doc, mount, label: 'Spazi e accessi' });
  await renderSpazi();
  sequenzeRead.resolve();
  await sequenzeDone;
  assert.equal(mount.textContent, 'Spazi e accessi');
  // Back on Sequenze its handle paints again.
  gate.activate('sequenze');
  await renderSequenze();
  assert.equal(mount.textContent, 'Sequenze');
});

test('the routed view handle passes straight through to the real mount', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const gate = createMountGate(mount);
  const handle = gate.owned(['list', 'detail']);
  gate.activate('detail');
  const row = doc.createElement('p');
  handle.appendChild(row);
  assert.equal(row.parentNode, mount);
  assert.equal(handle.firstChild, row);
  assert.deepEqual(Array.from(handle.childNodes), [row]);
  handle.removeChild(row);
  assert.equal(mount.firstChild, null);
  // The router's own screens (null) leave every handle inert.
  gate.activate(null);
  handle.appendChild(doc.createElement('p'));
  assert.equal(mount.firstChild, null);
});

test('Oggi shows the loading state, not the shortcuts, while its reads are pending', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const reads = deferred();
  const client = {
    request: async (path) => {
      await reads.promise;
      if (path === '/api/schema') return { domains: {} };
      return { items: [] };
    },
  };
  const view = createOggiView({ doc, mount, client, navigate: () => {} });
  const done = view.render({
    spaceName: 'Spazio',
    userName: 'Elena',
    links: [{ id: 'clienti', label: 'Clienti', route: '#/clienti' }],
    now: new Date(2026, 10, 7, 9),
  });
  assert.ok(mount.textContent.includes('Elena'), 'the greeting frame paints at once');
  assert.ok(mount.textContent.includes('Carico la tua giornata…'), mount.textContent);
  assert.equal(busyNodes(mount).length, 1);
  assert.ok(!mount.textContent.includes('Le schermate pronte del tuo spazio'), 'no shortcut list while loading');
  assert.equal(mount.findAll('a').length, 0, 'no shortcut link while loading');
  reads.resolve();
  await done;
  assert.equal(busyNodes(mount).length, 0, 'the real home replaces the loading line');
  assert.ok(!mount.textContent.includes('Carico la tua giornata'));
});

test('the router clears the mount before any await and hands every view a gated handle', () => {
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('async function route()');
  const end = app.indexOf("window.addEventListener('hashchange', route);");
  const router = app.slice(start, end);
  const sync = router.indexOf('syncShell(target);');
  const paint = router.indexOf('paintScreenLoading(');
  const firstAwait = router.indexOf('await ');
  assert.ok(sync !== -1 && paint > sync, 'the loading state follows the breadcrumb');
  assert.ok(paint < firstAwait, 'the loading state paints before any read');
  assert.ok(router.indexOf('mountGate.activate(routedView)') < paint, 'the routed view is named before the clear');
  // Only the router's own synchronous screens touch the real mount.
  const realMountViews = [...app.matchAll(/(create[A-Za-z]+)\(\{\s*doc: document,\s*mount: moduleView\b/g)].map((m) => m[1]);
  assert.deepEqual(realMountViews, ['createUiCatalogView'], 'every async view paints through its gated handle');
});
