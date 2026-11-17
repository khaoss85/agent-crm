// @ts-check

// backlog:0d2d8f2e — Backoffice «Squadre»: the teams of agents with their
// objective, metric, members, phases and spending cap. One screen under
// `#/squadre`, in the shell menu next to Agenti.
//
// What it reuses, never duplicates (MEM_ACC_REUSE):
// - reads: the checked-in catalogue at `GET /api/squads/catalog` (whose 404
//   means «the agents package is not composed here») and the managed
//   `teammate-squad` module at `GET /api/modules/teammate-squad/records`,
//   scoped with `filter.spaceId` — zero rows is the true empty state, said
//   out loud, never a fake list;
// - writes: `POST /api/squads/create` (create-teammate-squad: a template
//   slug, the caller key derived from the given name), posted through the
//   bound submission client so the Admin mutation gate sees an
//   Idempotency-Key. Nothing else writes from here.
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
// with createElement + textContent only — hostile squad names, objectives
// or template words stay inert text.

import { bindAdminMutations } from './admin-submission.js';
import { humanWriteError } from './admin-core.js';
import { el, uiButton, uiEmpty, uiHold, uiLoading } from './admin-ui.js';

/** The true empty state: the server read ran and answered zero squads. */
export const SQUADRE_EMPTY_TITLE = 'Nessuna squadra per ora';

/** One page of squad rows: said out loud, like Agenti does. */
export const SQUADRE_READ_LIMIT = 200;

/**
 * A safe caller key from a free name: lowercase alphanumerics, dots and
 * dashes, 8 to 80 chars (the server rule in packages/agents/src/squads.js).
 * Null when the name cannot make one — the form says so, never guessing.
 * @param {unknown} name @param {unknown} templateSlug
 */
export function squadCallerKey(name, templateSlug) {
  const words = String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part !== '');
  const slug = String(templateSlug ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part !== '')
    .join('-');
  const key = [...words, slug].filter((part) => part !== '').join('-').slice(0, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(key)) return null;
  return key;
}

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
export function createSquadreView({ doc = null, mount, client, submissions, storage, spaceId, navigate = () => {} } = {}) {
  const documentNode = doc ?? (typeof document !== 'undefined' ? document : null);
  const { client: bound } = bindAdminMutations(client, { submissions, storage });
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

  function paintForm(catalog) {
    const form = el(documentNode, 'form', 'squadre-create');
    const label = el(documentNode, 'label', 'squadre-create-label', 'Nuova squadra da un modello');
    const select = documentNode.createElement('select');
    select.setAttribute('name', 'modello');
    for (const entry of catalog) {
      const slug = typeof entry?.slug === 'string' ? entry.slug : '';
      if (slug === '') continue;
      const option = documentNode.createElement('option');
      option.setAttribute('value', slug);
      const name = typeof entry?.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : slug;
      const objective = typeof entry?.objective === 'string' && entry.objective.trim() !== '' ? ` — ${entry.objective.trim()}` : '';
      option.textContent = `${name}${objective}`;
      select.appendChild(option);
    }
    const nameInput = documentNode.createElement('input');
    nameInput.setAttribute('type', 'text');
    nameInput.setAttribute('name', 'nome');
    nameInput.setAttribute('maxlength', '80');
    nameInput.setAttribute('placeholder', 'Nome della squadra');
    nameInput.setAttribute('aria-label', 'Nome della squadra');
    const create = uiButton(documentNode, { label: 'Crea squadra', variant: 'primary' });
    const complaint = el(documentNode, 'p', 'ui-note');
    complaint.setAttribute('aria-live', 'polite');
    form.appendChild(label);
    form.appendChild(select);
    form.appendChild(nameInput);
    form.appendChild(create);
    form.appendChild(complaint);
    form.addEventListener('submit', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      void submit(select.value, nameInput.value, create, complaint);
    });
    mount.appendChild(form);
  }

  async function submit(templateSlug, name, button, complaint) {
    const space = readSpace();
    const key = squadCallerKey(name, templateSlug);
    if (!space || !key) {
      complaint.textContent = space
        ? 'Scegli un nome di almeno 8 lettere o numeri: diventa la chiave della squadra.'
        : 'Scegli prima uno spazio di lavoro.';
      return;
    }
    const release = uiHold(button, 'Creo…');
    try {
      await bound.request('/api/squads/create', {
        method: 'POST',
        body: { spaceId: space, key, templateSlug, name: String(name).trim() },
      });
      release();
      await render();
    } catch (error) {
      release();
      complaint.textContent = humanWriteError(error, {
        failed: 'Non sono riuscito a creare la squadra, riprova.',
        notComposed: 'Le squadre non sono attive in questo spazio.',
      });
    }
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
    let catalog = null;
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
      catalog = Array.isArray(catalogAnswer?.squads) ? catalogAnswer.squads : [];
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
        text: 'Crea la prima squadra da un modello qui sotto: obiettivo, agenti, fasi e tetto di spesa arrivano dal modello.',
      }));
    } else {
      paintSquads(rows);
    }
    paintForm(catalog);
  }

  return { render, invalidate };
}
