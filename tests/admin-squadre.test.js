import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { buildShellNav, shellScreenFor } from '../apps/admin/public/admin-shell.js';
import { createSquadreView, SQUADRE_EMPTY_TITLE } from '../apps/admin/public/admin-squadre.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Voce 0d2d8f2e (VERIFIER_BACK 2026-11-17): nel /bo non c'è nessuna
 * schermata delle squadre — `#/squadre` risponde «Questa pagina non
 * esiste» mentre il lato server esiste (0 squadre).
 *
 * What it must prove, red on the code before the cure and green after:
 * `#/squadre` routes to the Squadre screen, the shell names the voice in
 * the menu, and the screen paints the true empty state (never a fake
 * list, never a dead link).
 */

const SPACE = 'spazio-di-prova';

function viewClient({ catalog = [], records = [], catalogStatus = 200 } = {}) {
  return {
    async request(path, options = {}) {
      if (path === '/api/squads/catalog') {
        if (catalogStatus !== 200) {
          const error = new Error(`Request failed with status ${catalogStatus}`);
          error.status = catalogStatus;
          error.code = catalogStatus === 404 ? 'SQUAD_NOT_COMPOSED' : 'SQUAD_READ_FAILED';
          throw error;
        }
        return { squads: catalog };
      }
      if (path.startsWith('/api/modules/teammate-squad/records')) {
        assert.ok(path.includes(`filter.spaceId=${SPACE}`), `the read is space-scoped: ${path}`);
        return { items: records };
      }
      if (path === '/api/squads/create' && (options.method ?? 'GET') === 'POST') {
        return { squad: { sourceKey: `squad:${SPACE}:nuova`, name: 'Nuova' } };
      }
      throw new Error(`unexpected request: ${options.method ?? 'GET'} ${path}`);
    },
  };
}

test('#/squadre apre la schermata delle squadre, mai «Questa pagina non esiste»', () => {
  assert.deepEqual(parseModuleRoute('#/squadre'), { view: 'squadre' });
  assert.deepEqual(parseModuleRoute('#/squadre/'), { view: 'squadre' });
  assert.deepEqual(parseModuleRoute('#/squadre/altro'), { view: 'invalid' });
  assert.deepEqual(shellScreenFor({ view: 'squadre' }), { id: 'squadre', label: 'Squadre' });
});

test('la voce Squadre sta nel menu quando il pacchetto agenti è composto', () => {
  const on = buildShellNav({ agentsAvailable: true, squadsAvailable: true });
  const voice = on.find((item) => item.id === 'squadre');
  assert.ok(voice, 'the Squadre voice is in the shell');
  assert.equal(voice.route, '#/squadre');
  assert.equal(voice.available, true);
  const off = buildShellNav({ agentsAvailable: false, squadsAvailable: false });
  const muted = off.find((item) => item.id === 'squadre');
  assert.ok(muted, 'the voice stays named while disabled');
  assert.equal(muted.available, false);
  assert.equal(muted.route, null);
});

test('zero squadre dipinge lo stato vuoto vero, con i modelli tra cui scegliere', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const catalog = [
    { slug: 'lead-generation', name: 'Acquisizione lead', objective: 'Più lead buoni' },
    { slug: 'social-posting', name: 'Post social', objective: 'Presenza costante' },
  ];
  const view = createSquadreView({
    doc,
    mount,
    client: viewClient({ catalog, records: [] }),
    spaceId: () => SPACE,
  });
  await view.render();
  assert.ok(mount.textContent.includes(SQUADRE_EMPTY_TITLE), mount.textContent);
  assert.ok(mount.textContent.includes('Acquisizione lead'), mount.textContent);
  assert.ok(!mount.textContent.includes('Questa pagina non esiste'), 'never the unknown-route panel');
});

test('una squadra esistente si legge per nome e obiettivo', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSquadreView({
    doc,
    mount,
    client: viewClient({
      catalog: [],
      records: [{ sourceKey: `squad:${SPACE}:lead-1`, name: 'Acquisizione lead', objective: 'Più lead buoni' }],
    }),
    spaceId: () => SPACE,
  });
  await view.render();
  assert.ok(mount.textContent.includes('Acquisizione lead'), mount.textContent);
  assert.ok(mount.textContent.includes('Più lead buoni'), mount.textContent);
});
