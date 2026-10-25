// @ts-check

// Stato sync (BO-F1-03, backlog:63af493dea0a): the backoffice screen behind
// reference "03 Stato sync" — the always-visible honest indicator (ok / da
// sistemare), the "da sistemare" section and the channel table with the last
// outcome per channel. A broken channel says what to do, never just that it
// is broken: every fix item names a real destination (the guided connect
// flow, the connector detail, the quality queue, or the Sincronizza ora
// button on this same screen).
//
// The screen reuses what is already live instead of duplicating it: the
// per-connection activity `packages/channels` publishes on
// GET /api/connectors/activity (counters read from the real inbox and
// dead-letter rows, never invented, never provider text), the pull behind
// "Sincronizza ora" on POST /api/connectors/sync-now, and the Italian channel
// labels of CONNECTOR_CATALOG in admin-connectors.js. This file owns no
// storage and no write of its own.
//
// Conventions follow apps/admin/public/admin-core.js: the indicator, the fix
// items, the rows and the labels are pure and DOM-free (unit-tested under
// node:test without a browser) and the renderer uses DOM APIs only —
// createElement + textContent/setAttribute — never innerHTML with data, so a
// hostile channel, account or adapter label is inert text, never markup.

import { ACTIVE_SPACE_KEY } from './admin-shell.js';
import { CONNECTOR_CATALOG } from './admin-connectors.js';
import { bindAdminMutations } from './admin-submission.js';

/** Canonical route of this screen. */
export const SYNC_ROUTE = '#/stato-sync';

/**
 * Health verdicts the activity payload carries, in display order of worry.
 * @param {unknown} health
 */
export function healthTone(health) {
  if (health === 'down') return 'down';
  if (health === 'attention') return 'fix';
  if (health === 'idle') return 'wait';
  return 'ok';
}

/**
 * Italian label for one activity health verdict. Unknown values read as ok
 * only when the entry says so — anything else names the raw value, never a
 * calmer word.
 * @param {unknown} health
 */
export function healthLabel(health) {
  if (health === 'ok') return 'A posto';
  if (health === 'idle') return 'In attesa';
  if (health === 'attention') return 'Da sistemare';
  if (health === 'down') return 'Bloccato';
  return typeof health === 'string' && health !== '' ? health : '—';
}

/**
 * Authority badge for one health verdict. Colours name who must act, never a
 * severity (BO-F0-01): accord while everything agrees, policy while a binding
 * waits, human as soon as a person must decide, fault when a binding broke.
 * Every variant reuses the `.badge[data-authority]` pairs styles.css already
 * renders — no new colour, no literal value.
 * @param {unknown} health
 */
export function healthAuthority(health) {
  if (health === 'down') return 'fault';
  if (health === 'attention') return 'human';
  if (health === 'idle') return 'policy';
  return 'accord';
}

/**
 * Italian label for one observed direction, with the legend arrows of the
 * reference (← entra · → esce · ↔ entrambi).
 * @param {unknown} direction
 */
export function directionLabel(direction) {
  if (direction === 'in') return '← entra';
  if (direction === 'out') return '→ esce';
  if (direction === 'both') return '↔ entrambi';
  return '—';
}

/**
 * Italian label for one channel: the catalog entry when the channel is one
 * of the eight connectable ones, the raw id otherwise — never blank.
 * @param {unknown} channel
 * @param {ReadonlyArray<{ channel?: unknown, label?: unknown }>} [catalog]
 */
export function channelLabel(channel, catalog = CONNECTOR_CATALOG) {
  if (typeof channel === 'string' && channel !== '') {
    const entry = Array.isArray(catalog)
      ? catalog.find((row) => row != null && row.channel === channel)
      : undefined;
    if (entry != null && typeof entry.label === 'string' && entry.label !== '') return entry.label;
    return channel;
  }
  return 'Canale';
}

/**
 * Italian relative time for one ISO instant. Unparseable instants read '—',
 * never "now": an unknown time must not pose as fresh.
 * @param {unknown} iso
 * @param {number} [nowMs]
 */
export function timeAgo(iso, nowMs = Date.now()) {
  if (typeof iso !== 'string' || iso === '') return '—';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '—';
  const deltaSec = Math.floor((nowMs - at) / 1000);
  if (deltaSec < 60) return 'adesso';
  if (deltaSec < 3600) {
    const minutes = Math.floor(deltaSec / 60);
    return minutes === 1 ? '1 minuto fa' : `${minutes} minuti fa`;
  }
  if (deltaSec < 86400) {
    const hours = Math.floor(deltaSec / 3600);
    return hours === 1 ? '1 ora fa' : `${hours} ore fa`;
  }
  const days = Math.floor(deltaSec / 86400);
  if (days === 1) return 'ieri';
  if (days < 7) return `${days} giorni fa`;
  const date = new Date(at);
  return `il ${date.getDate()} ${['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'][date.getMonth()]}`;
}

/**
 * @param {any} activity the GET /api/connectors/activity payload, possibly null.
 */
function entriesOf(activity) {
  if (activity === null || typeof activity !== 'object') return [];
  return Array.isArray(activity.connections) ? activity.connections : [];
}

/**
 * The always-visible honest indicator: `fix` with the count as soon as one
 * fix item exists, `ok` otherwise. The detail never invents an event count —
 * the payload carries none — only the freshest movement it actually saw.
 * @param {any} activity
 * @param {number} [nowMs]
 */
export function syncIndicator(activity, nowMs = Date.now()) {
  // A null payload is an unread state, never an ok one: unknown must not
  // pose as fresh. The view only calls this with a loaded payload; the
  // empty-space case below (a real object with no connections) stays ok.
  if (activity === null || typeof activity !== 'object') {
    return { tone: 'wait', title: 'Stato non letto', detail: 'Ricarica la pagina per leggere lo stato.', count: 0 };
  }
  const items = syncFixItems(activity);
  const entries = entriesOf(activity);
  let lastAt = null;
  if (activity !== null && typeof activity === 'object'
    && typeof activity.lastActivityAt === 'string' && activity.lastActivityAt !== '') {
    lastAt = activity.lastActivityAt;
  }
  const received = entries.reduce((total, entry) => total
    + (entry !== null && typeof entry === 'object' && entry.inbox !== null && typeof entry.inbox === 'object'
      && Number.isSafeInteger(entry.inbox.received) && entry.inbox.received > 0 ? entry.inbox.received : 0), 0);
  const detail = entries.length === 0
    ? 'Nessun connettore collegato: collega il primo da Connettori.'
    : lastAt === null
      ? 'Ancora nessun movimento registrato.'
      : `Ultimo aggiornamento ${timeAgo(lastAt, nowMs)} · ${received} messaggi entrati`;
  if (items.length > 0) {
    return {
      tone: 'fix',
      title: items.length === 1 ? '1 cosa da sistemare' : `${items.length} cose da sistemare`,
      detail,
      count: items.length,
    };
  }
  return { tone: 'ok', title: 'Tutto a posto', detail, count: 0 };
}

/**
 * @param {any} entry one activity connection entry.
 */
function accountOf(entry) {
  const account = entry !== null && typeof entry === 'object' ? entry.account : null;
  return typeof account === 'string' && account !== '' ? account : null;
}

/**
 * @param {any} entry one activity connection entry.
 */
function lastErrorOf(entry) {
  const sync = entry !== null && typeof entry === 'object' && entry.sync !== null && typeof entry.sync === 'object'
    ? entry.sync : null;
  const code = sync !== null && typeof sync.lastErrorCode === 'string' && sync.lastErrorCode !== ''
    ? sync.lastErrorCode : null;
  const outbox = entry !== null && typeof entry === 'object' && entry.outbox !== null && typeof entry.outbox === 'object'
    ? entry.outbox : null;
  const dead = outbox !== null && Number.isSafeInteger(outbox.openDeadLetters) && outbox.openDeadLetters > 0
    ? outbox.openDeadLetters : 0;
  return { code, dead };
}

/**
 * The "da sistemare" section: one item per connection that needs a human,
 * each with a title, a detail and an action that names a real destination —
 * the guided flow, the connector detail, the quality queue or the pull button
 * on this screen. Entries that are merely waiting (idle) are not broken and
 * stay out; duplicates proposals keep living in the quality queue (BO-F1-04
 * owns that UI), linked from here, never duplicated.
 * @param {any} activity the GET /api/connectors/activity payload, possibly null.
 */
export function syncFixItems(activity) {
  const items = [];
  for (const entry of entriesOf(activity)) {
    if (entry === null || typeof entry !== 'object') continue;
    const key = typeof entry.connectionKey === 'string' && entry.connectionKey !== '' ? entry.connectionKey : null;
    if (key === null) continue;
    const label = channelLabel(entry.channel);
    const account = accountOf(entry);
    const who = account === null ? label : `${label} (${account})`;
    const status = typeof entry.status === 'string' ? entry.status : '';
    if (status === 'suspended') {
      items.push({
        key, channel: entry.channel,
        title: `${who} è sospeso`,
        detail: 'I messaggi restano fermi finché non lo riattivi.',
        action: { kind: 'route', label: 'Riattiva da Connettori', route: '#/connettori' },
      });
      continue;
    }
    if (status === 'revoked') {
      items.push({
        key, channel: entry.channel,
        title: `${who} è scollegato`,
        detail: 'Ricollega l\u2019account per far ripartire gli arrivi.',
        action: { kind: 'route', label: 'Ricollega da Connettori', route: '#/connettori' },
      });
      continue;
    }
    if (status === 'pending') {
      items.push({
        key, channel: entry.channel,
        title: `${who} aspetta di essere completato`,
        detail: 'Finisci il collegamento in tre passi: senza, niente entra.',
        action: { kind: 'route', label: 'Completa da Connettori', route: '#/connettori' },
      });
      continue;
    }
    if (status !== 'active') {
      items.push({
        key, channel: entry.channel,
        title: `${who} è in uno stato da guardare (${status === '' ? 'sconosciuto' : status})`,
        detail: 'Apri il dettaglio per capire cosa è successo.',
        action: {
          kind: 'route',
          label: `Vedi il dettaglio di ${label}`,
          route: typeof entry.channel === 'string' && entry.channel !== '' ? `#/connettori/${entry.channel}` : '#/connettori',
        },
      });
      continue;
    }
    const { code, dead } = lastErrorOf(entry);
    const inbox = entry.inbox !== null && typeof entry.inbox === 'object' ? entry.inbox : null;
    const quarantined = inbox !== null && Number.isSafeInteger(inbox.quarantined) && inbox.quarantined > 0
      ? inbox.quarantined : 0;
    if (code !== null) {
      items.push({
        key, channel: entry.channel,
        title: `L\u2019importazione di ${who} si è fermata (${code})`,
        detail: 'Riprova con Sincronizza ora qui sotto: riprende da dove si è fermata.',
        action: { kind: 'sync-now', label: 'Sincronizza ora', connectionKey: key },
      });
    }
    if (quarantined > 0) {
      items.push({
        key: `${key}:quarantena`, channel: entry.channel,
        title: quarantined === 1
          ? `1 messaggio di ${who} aspetta una decisione`
          : `${quarantined} messaggi di ${who} aspettano una decisione`,
        detail: 'Decidili nella coda qualità: nessuno viene unito da solo.',
        action: { kind: 'route', label: 'Apri la coda qualità', route: '#/customer-data' },
      });
    }
    if (dead > 0) {
      items.push({
        key: `${key}:invii`, channel: entry.channel,
        title: dead === 1
          ? `1 invio di ${who} non è partito`
          : `${dead} invii di ${who} non sono partiti`,
        detail: 'Apri il dettaglio per leggere l\u2019ultimo errore e riprovare.',
        action: {
          kind: 'route',
          label: `Vedi il dettaglio di ${label}`,
          route: typeof entry.channel === 'string' && entry.channel !== '' ? `#/connettori/${entry.channel}` : '#/connettori',
        },
      });
    }
  }
  return items;
}

/**
 * One table row per connection, in the payload order (sorted by connection
 * key server-side, so two reads agree). "Ultimo esito" is the freshest
 * movement the payload saw for that channel — the latest arrival wins over
 * an older failed send, an older failure over silence — with its instant;
 * '—' before any traffic, never a guess.
 * @param {any} activity the GET /api/connectors/activity payload, possibly null.
 */
export function syncChannelRows(activity) {
  const rows = [];
  for (const entry of entriesOf(activity)) {
    if (entry === null || typeof entry !== 'object') continue;
    const key = typeof entry.connectionKey === 'string' && entry.connectionKey !== '' ? entry.connectionKey : null;
    if (key === null) continue;
    const inbox = entry.inbox !== null && typeof entry.inbox === 'object' ? entry.inbox : null;
    const outbox = entry.outbox !== null && typeof entry.outbox === 'object' ? entry.outbox : null;
    const receivedAt = inbox !== null && typeof inbox.lastReceivedAt === 'string' && inbox.lastReceivedAt !== ''
      ? inbox.lastReceivedAt : null;
    const failedAt = outbox !== null && typeof outbox.lastFailedAt === 'string' && outbox.lastFailedAt !== ''
      ? outbox.lastFailedAt : null;
    const received = inbox !== null && Number.isSafeInteger(inbox.received) ? inbox.received : 0;
    const quarantined = inbox !== null && Number.isSafeInteger(inbox.quarantined) ? inbox.quarantined : 0;
    const dead = outbox !== null && Number.isSafeInteger(outbox.openDeadLetters) ? outbox.openDeadLetters : 0;
    const health = typeof entry.health === 'string' ? entry.health : 'idle';
    rows.push({
      key,
      channel: typeof entry.channel === 'string' ? entry.channel : '',
      label: channelLabel(entry.channel),
      account: accountOf(entry) ?? '—',
      direction: directionLabel(entry.direction),
      last:
        receivedAt !== null && (failedAt === null || receivedAt >= failedAt)
          ? { kind: 'arrivo', at: receivedAt }
          : failedAt !== null
            ? { kind: 'invio fallito', at: failedAt }
            : null,
      received,
      quarantined,
      deadLetters: dead,
      health,
      canSyncNow: entry.importable === true && entry.status === 'active',
    });
  }
  return rows;
}

/**
 * Italian text for one feed event. The feed carries no subject, no payload
 * and no provider wording — only the effect the inbox recorded, or the
 * normalized code of an open dead letter.
 * @param {unknown} kind
 * @param {unknown} code
 */
export function feedKindLabel(kind, code) {
  if (kind === 'dead-letter') {
    return typeof code === 'string' && code !== '' ? `invio fermo (${code})` : 'invio fermo';
  }
  if (kind === 'applied') return 'registrato';
  if (kind === 'quarantined') return 'in attesa di decisione';
  if (kind === 'ignored') return 'ignorato';
  if (kind === 'duplicate') return 'doppione';
  if (kind === 'pending') return 'in attesa';
  return typeof kind === 'string' && kind !== '' ? kind : 'evento';
}

/**
 * The "in tempo reale" feed, newest first as the payload delivers it.
 * @param {any} activity the GET /api/connectors/activity payload, possibly null.
 */
export function syncFeedItems(activity) {
  if (activity === null || typeof activity !== 'object') return [];
  if (!Array.isArray(activity.feed)) return [];
  const items = [];
  for (const row of activity.feed) {
    if (row === null || typeof row !== 'object') continue;
    const at = typeof row.at === 'string' && row.at !== '' ? row.at : null;
    if (at === null) continue;
    const arrow = row.direction === 'out' ? '→' : row.direction === 'in' ? '←' : '·';
    items.push({
      at,
      arrow,
      channel: channelLabel(row.channel),
      text: feedKindLabel(row.kind, row.code),
    });
  }
  return items;
}

function el(doc, tag, cls, text) {
  const node = doc.createElement(tag);
  if (cls) node.setAttribute('class', cls);
  if (text !== undefined) node.textContent = text; // safe: text, never HTML
  return node;
}

function errorOf(error) {
  if (error !== null && typeof error === 'object') {
    const body = /** @type {{ message?: unknown, code?: unknown }} */ (error).message
      ?? /** @type {{ message?: unknown }} */ (error).code;
    if (typeof body === 'string' && body !== '') return body;
  }
  if (typeof error === 'string' && error !== '') return error;
  return 'La richiesta non è riuscita.';
}

/**
 * A view controller for the Stato sync screen. Injecting `doc`, `mount`,
 * `client`, `storage` and `navigate` keeps it testable without a browser.
 * @param {{ doc: any, mount: any, client: { request: (path: string, options?: object) => Promise<any> }, navigate?: (hash: string) => void, storage?: any, toast?: (message: string, isError?: boolean) => void, submissions?: any }} deps
 */
export function createSyncView(deps) {
  const { doc, mount, navigate } = deps;
  // POSTs go through the submission controller with idempotency, like every
  // other admin view: the shared module client refuses a raw mutation without
  // an Idempotency-Key, so pulling through it directly would throw on the
  // real code path. GETs stay on the raw client.
  const { client } = bindAdminMutations(deps.client, deps);
  const toast = deps.toast ?? (() => {});
  const storage = deps.storage ?? null;
  const go = typeof navigate === 'function' ? navigate : () => {};

  const readSpace = () => {
    try {
      const stored = storage !== null ? storage.getItem(ACTIVE_SPACE_KEY) : null;
      return typeof stored === 'string' ? stored : '';
    } catch {
      return '';
    }
  };

  const state = {
    spaceId: readSpace(),
    channelsReady: false,
    /** @type {any} */ activity: null,
    loaded: false,
    loadError: null,
    /** @type {Set<string>} */ syncing: new Set(),
  };

  async function load() {
    try {
      state.spaceId = readSpace();
    } catch {
      state.spaceId = '';
    }
    state.loaded = false;
    state.loadError = null;
    state.activity = null;
    let schema;
    try {
      schema = await client.request('/api/schema');
    } catch (error) {
      state.loadError = errorOf(error);
      return;
    }
    const meta = schema?.domains?.channels?.metadata ?? schema?.domains?.channels;
    state.channelsReady = Boolean(meta && meta.channelsContract === 1);
    if (!state.channelsReady || state.spaceId.trim() === '') return;
    try {
      state.activity = await client.request(
        `/api/connectors/activity?spaceId=${encodeURIComponent(state.spaceId.trim())}`,
      );
      state.loaded = true;
    } catch (error) {
      state.loadError = errorOf(error);
    }
  }

  function renderNote(text, cls = 'bo-sync-note') {
    mount.appendChild(el(doc, 'p', 'bo-kicker', 'Backoffice'));
    mount.appendChild(el(doc, 'h2', undefined, 'Stato sync'));
    mount.appendChild(el(doc, 'p', cls, text));
  }

  function renderIndicator(box, activity) {
    const indicator = syncIndicator(activity);
    const card = el(doc, 'div', 'bo-sync-indicator');
    const dot = el(doc, 'span', `bo-sync-dot bo-sync-dot-${indicator.tone}`);
    dot.setAttribute('aria-hidden', 'true');
    card.appendChild(dot);
    const textBox = el(doc, 'div', 'bo-sync-indicator-text');
    const titleRow = el(doc, 'p', 'bo-sync-title');
    titleRow.appendChild(el(doc, 'span', undefined, indicator.title));
    const badge = el(doc, 'span', 'badge', indicator.tone === 'fix' ? 'da sistemare' : indicator.tone === 'wait' ? 'in attesa' : 'ok');
    badge.setAttribute('data-authority', indicator.tone === 'fix' ? 'human' : indicator.tone === 'wait' ? 'policy' : 'accord');
    titleRow.appendChild(badge);
    textBox.appendChild(titleRow);
    textBox.appendChild(el(doc, 'p', 'bo-sync-detail', indicator.detail));
    card.appendChild(textBox);
    box.appendChild(card);
  }

  function renderFixes(box, activity) {
    box.appendChild(el(doc, 'h3', undefined, 'Da sistemare'));
    const items = syncFixItems(activity);
    if (items.length === 0) {
      box.appendChild(el(doc, 'p', 'bo-sync-note', 'Niente da sistemare. Se qualcosa si blocca, lo vedi qui.'));
      return;
    }
    const list = el(doc, 'div', 'bo-sync-fixes');
    for (const item of items) {
      const card = el(doc, 'div', 'bo-sync-fix');
      card.appendChild(el(doc, 'p', 'bo-sync-fix-title', item.title));
      card.appendChild(el(doc, 'p', 'bo-sync-fix-detail', item.detail));
      if (item.action.kind === 'route') {
        const link = el(doc, 'a', 'bo-sync-fix-action', item.action.label);
        link.setAttribute('href', item.action.route);
        link.addEventListener('click', (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          go(item.action.route);
        });
        card.appendChild(link);
      } else {
        const button = el(doc, 'button', 'bo-sync-fix-action', item.action.label);
        button.setAttribute('type', 'button');
        button.setAttribute('data-action', 'sync-now');
        button.setAttribute('data-connection-key', item.action.connectionKey);
        if (state.syncing.has(item.action.connectionKey)) button.setAttribute('disabled', '');
        button.addEventListener('click', () => {
          void syncNow(item.action.connectionKey, button);
        });
        card.appendChild(button);
      }
      list.appendChild(card);
    }
    box.appendChild(list);
  }

  function renderTable(box, activity) {
    box.appendChild(el(doc, 'h3', undefined, 'Canali'));
    const rows = syncChannelRows(activity);
    if (rows.length === 0) {
      const empty = el(doc, 'p', 'bo-sync-note', 'Nessun connettore collegato in questo spazio.');
      box.appendChild(empty);
      const link = el(doc, 'a', 'bo-sync-fix-action', 'Collega il primo');
      link.setAttribute('href', '#/connettori');
      link.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        go('#/connettori');
      });
      box.appendChild(link);
      return;
    }
    const wrap = el(doc, 'div', 'bo-sync-tablewrap');
    const table = doc.createElement('table');
    table.setAttribute('class', 'bo-sync-table');
    const head = doc.createElement('tr');
    for (const label of ['Canale', 'Account', 'Direzione', 'Ultimo esito', 'Eventi', 'Stato', '']) {
      const cell = el(doc, 'th', undefined, label);
      cell.setAttribute('scope', 'col');
      head.appendChild(cell);
    }
    table.appendChild(head);
    for (const row of rows) {
      const line = doc.createElement('tr');
      line.appendChild(el(doc, 'td', undefined, row.label));
      line.appendChild(el(doc, 'td', undefined, row.account));
      line.appendChild(el(doc, 'td', undefined, row.direction));
      line.appendChild(el(
        doc,
        'td',
        undefined,
        row.last === null ? '—' : `${row.last.kind} · ${timeAgo(row.last.at)}`,
      ));
      line.appendChild(el(
        doc,
        'td',
        undefined,
        `entrati ${row.received} · in attesa ${row.quarantined} · invii fermi ${row.deadLetters}`,
      ));
      const stateCell = doc.createElement('td');
      const badge = el(doc, 'span', 'badge', healthLabel(row.health));
      badge.setAttribute('data-authority', healthAuthority(row.health));
      stateCell.appendChild(badge);
      line.appendChild(stateCell);
      const pull = doc.createElement('td');
      if (row.canSyncNow) {
        const button = el(doc, 'button', undefined, 'Sincronizza ora');
        button.setAttribute('type', 'button');
        button.setAttribute('data-action', 'sync-now');
        button.setAttribute('data-connection-key', row.key);
        if (state.syncing.has(row.key)) button.setAttribute('disabled', '');
        button.addEventListener('click', () => {
          void syncNow(row.key, button);
        });
        pull.appendChild(button);
      } else {
        pull.appendChild(el(doc, 'span', 'bo-sync-muted', '—'));
      }
      line.appendChild(pull);
      table.appendChild(line);
    }
    wrap.appendChild(table);
    box.appendChild(wrap);
  }

  function renderFeed(box, activity) {
    box.appendChild(el(doc, 'h3', undefined, 'In tempo reale'));
    box.appendChild(el(doc, 'p', 'bo-sync-legend', '← entra · → esce · ↔ entrambi'));
    const items = syncFeedItems(activity);
    if (items.length === 0) {
      box.appendChild(el(doc, 'p', 'bo-sync-note', 'Ancora nessun movimento in questo spazio.'));
      return;
    }
    const list = el(doc, 'div', 'bo-sync-feed');
    for (const item of items) {
      const line = el(doc, 'p', 'bo-sync-feed-line');
      line.appendChild(el(doc, 'span', 'bo-sync-feed-time', timeAgo(item.at)));
      line.appendChild(el(doc, 'span', undefined, ` ${item.arrow} ${item.channel}: ${item.text}`));
      list.appendChild(line);
    }
    box.appendChild(list);
  }

  async function syncNow(connectionKey, button) {
    if (state.syncing.has(connectionKey)) return;
    state.syncing.add(connectionKey);
    if (button && typeof button.setAttribute === 'function') button.setAttribute('disabled', '');
    try {
      await client.request('/api/connectors/sync-now', {
        method: 'POST',
        body: { spaceId: state.spaceId.trim(), connectionKey },
      });
      toast('Sincronizzazione aggiornata.');
      await load();
    } catch (error) {
      toast(errorOf(error), true);
    } finally {
      // The guard releases on both outcomes before the rebuild: a
      // successful pull must not leave its own controls disabled for the
      // session, and a failed one stays retryable. The next render rebuilds
      // every button enabled (no removeAttribute needed), in the fake DOM
      // or the real one.
      state.syncing.delete(connectionKey);
    }
    render();
  }

  function render() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    if (state.spaceId.trim() === '') {
      renderNote('Scegli uno spazio per vedere lo stato della sincronizzazione.');
      return;
    }
    if (state.loadError !== null) {
      renderNote(state.loadError, 'bo-sync-error');
      return;
    }
    if (!state.channelsReady) {
      renderNote('I connettori non sono composti in questo ambiente: niente da sincronizzare.');
      return;
    }
    if (!state.loaded || state.activity === null) {
      renderNote('Lettura dello stato in corso…');
      return;
    }
    const box = el(doc, 'div', 'bo-sync');
    mount.appendChild(box);
    box.appendChild(el(doc, 'p', 'bo-kicker', 'Backoffice'));
    box.appendChild(el(doc, 'h2', undefined, 'Stato sync'));
    renderIndicator(box, state.activity);
    renderFixes(box, state.activity);
    renderTable(box, state.activity);
    renderFeed(box, state.activity);
  }

  return {
    render: async () => {
      await load();
      if (state.loadError !== null) toast(state.loadError, true);
      render();
    },
  };
}
