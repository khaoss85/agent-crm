// @ts-check

// backlog:0d2d8f2e — Backoffice «Squadre»: the teams of agents with their
// objective, metric, members, phases and spending cap. One screen under
// `#/squadre`, in the shell menu next to Agenti.
//
// Read-only on purpose (supervisor 18/11): `POST /api/squads/create` exists
// in agent-crm (apps/server/src/http-server.js) but the /bo bridge of the
// pilot (accordo-arvo-pilot src/shared/bo-crm-writes.js) maps no «squads»
// write, so «Crea da modello» would answer 4xx in production (rule S344,
// cases #1005/#1016). The creation form returns with the bridge mapping
// plus its shell→bridge contract test — until then this screen reads.
//
// What it reuses, never duplicates (MEM_ACC_REUSE):
// - reads: the checked-in catalogue at `GET /api/squads/catalog` (whose 404
//   means «the agents package is not composed here») and the managed
//   `teammate-squad` module at `GET /api/modules/teammate-squad/records`,
//   scoped with `filter.spaceId` — zero rows is the true empty state, said
//   out loud, never a fake list.
// - writes: none from here (see above).
//
// Honest gaps, said on screen and never faked (follow-ups, named in the PR):
// - backlog A (assignments to do), backlog B (runs to verify), routines and
//   advisor proposals of each squad live in `GET /api/squads/overview` and
//   get their own section once the screen grows past this first slice;
// - owner approvals from here reuse the existing approve/reject/revise
//   routes of the deployment, like Agenti does.
//
// Conventions follow apps/admin/public/admin-agenti.js: pure DOM-free model
// builders (unit-tested under node:test with the fake DOM), and a renderer
// with createElement + textContent only — hostile squad names or objectives
// stay inert text.

import { el, uiButton, uiEmpty, uiLoading } from './admin-ui.js';

/** The true empty state: the server read ran and answered zero squads. */
export const SQUADRE_EMPTY_TITLE = 'Nessuna squadra per ora';

/** One page of squad rows: said out loud, like Agenti does. */
export const SQUADRE_READ_LIMIT = 200;

/**
 * The Italian line under one squad: objective and advisor metric, each
 * only when the row names it — a missing value is never printed as text.
 * @param {{ objective?: unknown, metricName?: unknown, metricTarget?: unknown, metricUnit?: unknown }} row
 */
export function squadDetailLine(row) {
  const parts = [];
  if (typeof row?.objective === 'string' && row.objective.trim() !== '') parts.push(row.objective.trim());
  const metric = typeof row?.metricName === 'string' ? row.metricName.trim() : '';
  if (metric !== '') {
    const target = row?.metricTarget === null || row?.metricTarget === undefined || row?.metricTarget === ''
      ? ''
      : ` ${String(row.metricTarget)}`;
    const unit = typeof row?.metricUnit === 'string' && row.metricUnit.trim() !== '' ? ` ${row.metricUnit.trim()}` : '';
    parts.push(`Obiettivo: ${metric}${target}${unit}`);
  }
  return parts.join(' — ');
}

/**
 * @param {{ doc?: any, mount: any, client: { request: (path: string, options?: any) => Promise<any> }, submissions?: any, storage?: any, spaceId?: string | (() => string | null), navigate?: (hash: string) => void }} options
 */
export function createSquadreView({ doc = null, mount, client, spaceId, navigate = () => {} } = {}) {
  const documentNode = doc ?? (typeof document !== 'undefined' ? document : null);
  const readSpace = typeof spaceId === 'function' ? spaceId : () => (typeof spaceId === 'string' ? spaceId : null);
  let renderToken = 0;

  function invalidate() {
    renderToken += 1;
  }

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  function title() {
    const head = el(documentNode, 'h2', 'bo-screen-title', 'Squadre');
    mount.appendChild(head);
  }

  function note(text) {
    const line = el(documentNode, 'p', 'ui-note', text);
    mount.appendChild(line);
    return line;
  }

  function paintSquads(rows) {
    const list = el(documentNode, 'ul', 'squadre-list');
    for (const row of rows) {
      const item = el(documentNode, 'li', 'squadre-row');
      const name = typeof row?.name === 'string' && row.name.trim() !== '' ? row.name.trim() : 'Squadra senza nome';
      item.appendChild(el(documentNode, 'strong', 'squadre-name', name));
      const detail = squadDetailLine(row);
      if (detail !== '') item.appendChild(el(documentNode, 'span', 'squadre-detail', detail));
      list.appendChild(item);
    }
    mount.appendChild(list);
  }

  async function render() {
    const mine = ++renderToken;
    clear();
    title();
    const space = readSpace();
    if (!space) {
      note('Scegli prima uno spazio di lavoro: le squadre vivono lì.');
      return;
    }
    mount.appendChild(uiLoading(documentNode, { label: 'squadre' }));
    let rows = null;
    try {
      const [catalogAnswer, recordsAnswer] = await Promise.all([
        client.request('/api/squads/catalog'),
        (() => {
          const query = new URLSearchParams({ limit: String(SQUADRE_READ_LIMIT + 1) });
          query.set('filter.spaceId', space);
          return client.request(`/api/modules/teammate-squad/records?${query.toString()}`);
        })(),
      ]);
      if (mine !== renderToken) return;
      void catalogAnswer; // read for its 404 (not composed), never painted while read-only
      const items = Array.isArray(recordsAnswer?.items) ? recordsAnswer.items : [];
      rows = items.slice(0, SQUADRE_READ_LIMIT);
    } catch (error) {
      if (mine !== renderToken) return;
      clear();
      title();
      const status = error?.status ?? null;
      if (status === 404) {
        mount.appendChild(uiEmpty(documentNode, {
          title: SQUADRE_EMPTY_TITLE,
          text: 'Le squadre non sono attive in questo spazio: chiedi a un operatore di comporre il pacchetto agenti.',
        }));
      } else {
        mount.appendChild(uiEmpty(documentNode, {
          title: 'Le squadre non si sono lette',
          text: 'La lettura è fallita: niente è andato perso, riprova.',
        }));
        const retry = uiButton(documentNode, { label: 'Riprova' });
        retry.addEventListener('click', () => { void render(); });
        mount.appendChild(retry);
      }
      return;
    }
    clear();
    title();
    if (rows.length === 0) {
      mount.appendChild(uiEmpty(documentNode, {
        title: SQUADRE_EMPTY_TITLE,
        text: 'In questo spazio non c\u2019è ancora nessuna squadra. La creazione dai modelli torna quando il ponte /bo del pilota accetta la scrittura.',
      }));
    } else {
      paintSquads(rows);
    }
  }

  return { render, invalidate };
}
