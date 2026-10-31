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

import { humanReadError, isNotComposedFailure, isUnsupportedContractFailure } from './admin-core.js';
import { CLIENTI_IMPORT_ROUTE } from './admin-clienti.js';
import { ACTIVE_SPACE_KEY, settingsTabs } from './admin-shell.js';
import { CONNECTOR_CATALOG } from './admin-connectors.js';
import { bindAdminMutations } from './admin-submission.js';

/** Canonical route of this screen. */
export const SYNC_ROUTE = '#/stato-sync';

/**
 * Health verdicts the activity payload carries, in display order of worry.
 * @param {unknown} health
 */
const SYNC_MARKS = Object.freeze({ whatsapp: 'WA', instagram: 'IG', facebook: 'FB', tiktok: 'TT', email: '@', gmail: '@', phone: 'TEL', voice: 'TEL', web: 'WEB', form: 'WEB', calendar: 'CAL', google_calendar: 'CAL', stripe: 'S' });
/** The prototype's channel tile mark, from a channel id or its label. */
function syncMark(value) {
  const key = String(value ?? '').toLowerCase().replace(/\s+/g, '_').split(':')[0];
  return SYNC_MARKS[key] ?? (String(value ?? '·').slice(0, 2).toUpperCase() || '·');
}

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
 * Short relative time for the hero subtitle: seconds while under a minute
 * (`22 s fa`, `adesso` just now), minutes while under an hour, then the
 * longer `timeAgo` wording.
 * @param {unknown} iso
 * @param {number} [nowMs]
 */
export function syncAgo(iso, nowMs = Date.now()) {
  if (typeof iso !== 'string' || iso === '') return '—';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '—';
  const deltaSec = Math.floor((nowMs - at) / 1000);
  if (deltaSec < 5) return 'adesso';
  if (deltaSec < 60) return `${deltaSec} s fa`;
  if (deltaSec < 3600) {
    const minutes = Math.floor(deltaSec / 60);
    return minutes === 1 ? '1 min fa' : `${minutes} min fa`;
  }
  return timeAgo(iso, nowMs);
}

/**
 * The always-visible honest indicator (BO-F6-16): the prototype hero titles
 * (`Quasi tutto sincronizzato` / `Tutto sincronizzato`, `Sincronizzazione
 * in corso` while a pull runs), with the subtitle
 * `Ultimo aggiornamento <tempo> · <n> eventi sincronizzati oggi, in entrata
 * e in uscita.` `<n>` sums the `received` counters the activity payload
 * carries — the only today-count the payload has; entries with no traffic
 * keep an honest fallback, never a zero posing as measured.
 * @param {any} activity
 * @param {number} [nowMs]
 * @param {{ syncing?: boolean, extraCount?: number }} [options]
 */
export function syncIndicator(activity, nowMs = Date.now(), { syncing = false, extraCount = 0 } = {}) {
  // A null payload is an unread state, never an ok one: unknown must not
  // pose as fresh. The view only calls this with a loaded payload; the
  // empty-space case below (a real object with no connections) stays ok.
  if (activity === null || typeof activity !== 'object') {
    return { tone: 'wait', title: 'Stato non letto', detail: 'Ricarica la pagina per leggere lo stato.', count: 0 };
  }
  const items = syncFixItems(activity);
  const grantCards = syncGrantCards(activity, nowMs);
  // Unresolved identity candidates need a human on this same screen, so
  // they count like the channel fix items (the purple cards below).
  const extra = Number.isSafeInteger(extraCount) && extraCount > 0 ? extraCount : 0;
  const total = items.length + grantCards.length + extra;
  const entries = entriesOf(activity);
  let lastAt = null;
  if (activity !== null && typeof activity === 'object'
    && typeof activity.lastActivityAt === 'string' && activity.lastActivityAt !== '') {
    lastAt = activity.lastActivityAt;
  }
  const received = entries.reduce((total, entry) => total
    + (entry !== null && typeof entry === 'object' && entry.inbox !== null && typeof entry.inbox === 'object'
      && Number.isSafeInteger(entry.inbox.received) && entry.inbox.received > 0 ? entry.inbox.received : 0), 0);
  const tempo = syncing ? 'in corso…' : (lastAt === null ? null : syncAgo(lastAt, nowMs));
  const detail = entries.length === 0
    ? 'Nessun connettore collegato: collega il primo da Connettori.'
    : tempo === null
      ? 'Ancora nessun movimento registrato.'
      : `Ultimo aggiornamento ${tempo} · ${received} eventi sincronizzati oggi, in entrata e in uscita.`;
  if (syncing) {
    return { tone: 'syncing', title: 'Sincronizzazione in corso', detail, count: total };
  }
  if (total > 0) {
    return { tone: 'fix', title: 'Quasi tutto sincronizzato', detail, count: total };
  }
  return { tone: 'ok', title: 'Tutto sincronizzato', detail, count: 0 };
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
        title: `L\u2019importazione di ${who} si è fermata.`,
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
        action: { kind: 'route', label: 'Apri la coda qualità', route: CLIENTI_IMPORT_ROUTE },
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
 * The prototype's nine fixed channels (BO-F6-16, fetta 2): the rows the
 * `Canali` card always lists, whatever the space connected. `sms` is
 * connectable in the catalog but outside the prototype's nine: a connected
 * sms binding still renders, appended after the nine, never in their place.
 * Directions are the prototype's fixed row lines: `← in entrata` only where
 * the adapter matrix refuses outbound (TikTok) or the channel only ever
 * delivers (site forms); `↔ pagamenti e link` for Stripe; `↔ bidirezionale`
 * everywhere else (DECISION to be confirmed: the mapping is presentation,
 * the binding state stays in the activity payload).
 */
export const SYNC_CHANNELS = Object.freeze([
  { id: 'whatsapp', name: 'WhatsApp', mark: 'WA', direction: '↔ bidirezionale' },
  { id: 'instagram', name: 'Instagram', mark: 'IG', direction: '↔ bidirezionale' },
  { id: 'facebook', name: 'Facebook', mark: 'FB', direction: '↔ bidirezionale' },
  { id: 'tiktok', name: 'TikTok', mark: 'TT', direction: '← in entrata' },
  { id: 'email', name: 'Email', mark: '@', direction: '↔ bidirezionale' },
  { id: 'voice', name: 'Telefono', mark: 'TEL', direction: '↔ bidirezionale' },
  { id: 'site-form', name: 'Form sito', mark: 'WEB', direction: '← in entrata' },
  { id: 'calendar', name: 'Google Calendar', mark: 'CAL', direction: '↔ bidirezionale' },
  { id: 'stripe', name: 'Stripe', mark: 'S', direction: '↔ pagamenti e link' },
]);

/** Days before expiry that light the `Permesso in scadenza` pill and card. */
export const SYNC_GRANT_EXPIRING_DAYS = 7;

/**
 * Whole days from now until one ISO instant. Past instants read 0 or less,
 * never a negative countdown.
 * @param {unknown} iso
 * @param {number} [nowMs]
 */
export function grantDaysLeft(iso, nowMs = Date.now()) {
  if (typeof iso !== 'string' || iso === '') return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.floor((at - nowMs) / 86400000);
}

/**
 * Whether one stated grant expiry counts as expiring: known, and within
 * the pill window (past expiries count — an expired grant needs the same
 * renewal, louder).
 * @param {unknown} iso
 * @param {number} [nowMs]
 */
export function grantExpiring(iso, nowMs = Date.now()) {
  const days = grantDaysLeft(iso, nowMs);
  return days !== null && days <= SYNC_GRANT_EXPIRING_DAYS;
}

/**
 * One aggregated channel row for the fixed nine-row card. Several bindings
 * of one channel aggregate honestly: events sum, the update is the latest
 * instant seen, the health is the worst verdict, expiry is the soonest
 * stated one, and every syncable binding stays pullable. Channels outside
 * the nine render after them with the catalog label, never in their place.
 * @param {any} activity the GET /api/connectors/activity payload, possibly null.
 * @param {number} [nowMs]
 */
export function syncChannelTable(activity, nowMs = Date.now()) {
  const entries = entriesOf(activity);
  const byChannel = new Map();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const channel = typeof entry.channel === 'string' ? entry.channel : '';
    if (channel === '') continue;
    if (!byChannel.has(channel)) byChannel.set(channel, []);
    byChannel.get(channel).push(entry);
  }
  const rank = { down: 0, attention: 1, idle: 2, ok: 3 };
  const aggregate = (channel, list) => {
    let received = 0;
    let lastAt = null;
    let worst = 'ok';
    let expiringAt = null;
    let importing = false;
    const keys = [];
    for (const entry of list) {
      const inbox = entry.inbox !== null && typeof entry.inbox === 'object' ? entry.inbox : null;
      if (inbox !== null && Number.isSafeInteger(inbox.received) && inbox.received > 0) received += inbox.received;
      for (const at of [inbox !== null ? inbox.lastReceivedAt : null,
        entry.outbox !== null && typeof entry.outbox === 'object' ? entry.outbox.lastFailedAt : null]) {
        if (typeof at === 'string' && at !== '' && (lastAt === null || at > lastAt)) lastAt = at;
      }
      const health = typeof entry.health === 'string' ? entry.health : 'idle';
      if ((rank[health] ?? 2) < (rank[worst] ?? 3)) worst = health;
      if (entry.status === 'active' && typeof entry.grantExpiresAt === 'string' && entry.grantExpiresAt !== ''
        && (expiringAt === null || entry.grantExpiresAt < expiringAt)) expiringAt = entry.grantExpiresAt;
      const sync = entry.sync !== null && typeof entry.sync === 'object' ? entry.sync : null;
      if (sync !== null && sync.status === 'running') importing = true;
      if (entry.importable === true && entry.status === 'active'
        && typeof entry.connectionKey === 'string' && entry.connectionKey !== '') keys.push(entry.connectionKey);
    }
    return { channel, list, received, lastAt, worst, expiringAt, importing, keys };
  };
  const rows = SYNC_CHANNELS.map((fixed) => {
    const agg = aggregate(fixed.id, byChannel.get(fixed.id) ?? []);
    const connected = agg.list.length > 0;
    // A blocked binding never poses as importing: the expiry and the
    // running import read only on bindings that are otherwise calm.
    const pill = connected
      ? (agg.expiringAt !== null && grantExpiring(agg.expiringAt, nowMs)
        ? { text: 'Permesso in scadenza', tone: 'permesso' }
        : agg.importing && agg.worst === 'ok'
          ? { text: 'Importazione', tone: 'importazione' }
          : agg.worst === 'ok'
            ? { text: 'Attivo', tone: 'attivo' }
            : { text: healthLabel(agg.worst), tone: 'altro' })
      : null;
    return {
      channel: fixed.id,
      label: fixed.name,
      mark: fixed.mark,
      direction: fixed.direction,
      connected,
      received: agg.received,
      lastAt: agg.lastAt,
      pill,
      keys: agg.keys,
      detailRoute: `#/connettori/${fixed.id}`,
    };
  });
  for (const [channel, list] of byChannel) {
    if (SYNC_CHANNELS.some((fixed) => fixed.id === channel)) continue;
    const agg = aggregate(channel, list);
    const pill = agg.expiringAt !== null && grantExpiring(agg.expiringAt, nowMs)
      ? { text: 'Permesso in scadenza', tone: 'permesso' }
      : agg.importing && agg.worst === 'ok'
        ? { text: 'Importazione', tone: 'importazione' }
        : agg.worst === 'ok'
          ? { text: 'Attivo', tone: 'attivo' }
          : { text: healthLabel(agg.worst), tone: 'altro' };
    rows.push({
      channel,
      label: channelLabel(channel),
      mark: syncMark(channel),
      direction: directionLabel(list[0]?.direction ?? null),
      connected: true,
      received: agg.received,
      lastAt: agg.lastAt,
      pill,
      keys: agg.keys,
      detailRoute: `#/connettori/${channel}`,
    });
  }
  return rows;
}

/**
 * The yellow permission cards (BO-F6-16, fetta 3): one per active binding
 * whose provider-stated grant expires within the pill window, soonest first.
 * The renewal itself happens where the guided flow lives (the connector
 * detail the action names): the flow records `renew-connection-grant` with
 * the provider-stated expiry, which this card can never invent. Prototype
 * wording: Instagram keeps its DM line, every other channel renews "i nuovi
 * arrivi" (DECISION to be confirmed).
 * @param {any} activity the GET /api/connectors/activity payload, possibly null.
 * @param {number} [nowMs]
 */
export function syncGrantCards(activity, nowMs = Date.now()) {
  const cards = [];
  for (const entry of entriesOf(activity)) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.status !== 'active') continue;
    if (typeof entry.grantExpiresAt !== 'string' || entry.grantExpiresAt === '') continue;
    if (!grantExpiring(entry.grantExpiresAt, nowMs)) continue;
    const channel = typeof entry.channel === 'string' && entry.channel !== '' ? entry.channel : null;
    const fixed = channel !== null ? SYNC_CHANNELS.find((row) => row.id === channel) : undefined;
    const label = fixed !== undefined ? fixed.name : channelLabel(channel);
    const days = grantDaysLeft(entry.grantExpiresAt, nowMs);
    const diffMs = Date.parse(entry.grantExpiresAt) - nowMs;
    const when = diffMs <= 0 ? 'è scaduto'
      : diffMs < 86400000 ? 'scade oggi'
        : days === 1 ? 'scade domani' : `scade tra ${days} giorni`;
    cards.push({
      key: typeof entry.connectionKey === 'string' && entry.connectionKey !== '' ? entry.connectionKey : label,
      channel,
      label,
      title: when === 'è scaduto' ? `Il permesso di ${label} è scaduto` : `Il permesso di ${label} ${when}`,
      detail: channel === 'instagram'
        ? 'Rinnovalo ora per continuare a ricevere i DM nelle schede clienti.'
        : 'Rinnovalo ora per non perdere i nuovi arrivi nelle schede clienti.',
      route: channel === null ? '#/connettori' : `#/connettori/${channel}`,
      expiresAt: entry.grantExpiresAt,
    });
  }
  cards.sort((left, right) => (left.expiresAt < right.expiresAt ? -1 : left.expiresAt > right.expiresAt ? 1 : 0));
  return cards;
}

/**
 * The purple identity cards (BO-F6-16, fetta 4): one per unresolved
 * duplicate candidate, oldest detection first. Titles name the people
 * involved — record labels, never rule ids or evidence codes. Nothing
 * merges here: `Sì, tienili entrambi` dismisses through the existing
 * `dismiss-duplicate-candidate` record action (the click is recorded as the
 * reason, with the operator's identity), `Decido io` opens the quality
 * queue where the link happens.
 * @param {unknown} candidates rows of GET /api/modules/duplicate-candidate/records, possibly null.
 */
export function syncIdentityCards(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const cards = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    if (row.status !== 'unresolved') continue;
    const id = typeof row.id === 'string' && row.id !== '' ? row.id : null;
    if (id === null) continue;
    const left = typeof row.leftLabel === 'string' && row.leftLabel.trim() !== ''
      ? row.leftLabel.trim() : (typeof row.leftId === 'string' && row.leftId !== '' ? row.leftId : null);
    const right = typeof row.rightLabel === 'string' && row.rightLabel.trim() !== ''
      ? row.rightLabel.trim() : (typeof row.rightId === 'string' && row.rightId !== '' ? row.rightId : null);
    const title = left !== null && right !== null
      ? (left.toLowerCase() === right.toLowerCase()
        ? `${left} potrebbe avere due schede`
        : `${left} e ${right} potrebbero essere la stessa persona`)
      : left !== null || right !== null
        ? `${left ?? right} potrebbe avere una seconda scheda`
        : 'Due schede potrebbero essere la stessa persona';
    cards.push({ id, title });
  }
  return cards;
}

/**
 * Rome clock for the live feed (`hh:mm:ss`, never UTC, never ISO).
 * Unparseable instants read '—', never "now".
 * @param {unknown} iso
 */
const SYNC_FEED_CLOCK = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
export function feedClockTime(iso) {
  if (typeof iso !== 'string' || iso === '') return '—';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '—';
  return SYNC_FEED_CLOCK.format(new Date(at));
}

/**
 * Italian text for one feed event. The feed carries no subject, no payload,
 * no provider wording and no error code — only the effect the inbox
 * recorded. `code` stays in the signature because callers pass the row
 * through, but it never renders (backlog:9da124e5).
 * @param {unknown} kind
 * @param {unknown} code
 */
export function feedKindLabel(kind, code) {
  void code;
  if (kind === 'dead-letter') {
    return 'invio fermo';
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
    // The prototype's `↔ entrambi` and `✦` markers have no source in the
    // channels-only feed (only arrivals and failed sends exist here): they
    // arrive with the multi-package union (interactions, appointments,
    // work), which is a follow-up, not invented arrows.
    const arrow = row.direction === 'out' ? '→' : row.direction === 'in' ? '←' : '·';
    items.push({
      at,
      clock: feedClockTime(at),
      arrow,
      channel: channelLabel(row.channel),
      text: feedKindLabel(row.kind, row.code),
    });
  }
  return items;
}

import { el } from './admin-ui.js'; // BO-F6-02: the single component library.

function errorOf(error) {
  return humanReadError(error, { failed: 'La richiesta non è riuscita. Riprova più tardi.' });
}

/**
 * A view controller for the Stato sync screen. Injecting `doc`, `mount`,
 * `client`, `storage` and `navigate` keeps it testable without a browser.
 * `spaceId` names the live space (the session's space under a mount, the
 * same input every other space-scoped view takes); it wins over the stored
 * pick, and the stored pick still applies without it, so local development
 * reads exactly as today.
 * @param {{ doc: any, mount: any, client: { request: (path: string, options?: object) => Promise<any> }, navigate?: (hash: string) => void, storage?: any, spaceId?: () => string | null, role?: () => string | null, toast?: (message: string, isError?: boolean) => void, submissions?: any }} deps
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
    // The live session space wins (the badge counts it the same way in
    // admin-shell resolveBadgeSpaceId): under a space mount the stored
    // local pick is empty — or another identity's — and reading only it
    // leaves the current space's screen asking to choose one.
    try {
      const live = typeof deps.spaceId === 'function' ? deps.spaceId() : null;
      if (typeof live === 'string' && live !== '') return live;
    } catch {
      // A broken live reader never breaks the resolution: storage still
      // applies below, like a caller that passed nothing.
    }
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
    /** @type {Array<any>} */ candidates: [],
    candidatesError: /** @type {string | null} */ (null),
    loaded: false,
    loadError: null,
    /** @type {Set<string>} */ syncing: new Set(),
    syncingAll: false,
  };

  // The observer role watches without touching: every write control on
  // this screen (global and per-channel pulls, grant renewal, keep-both)
  // hides for observers, with one honest line saying so. Unknown or absent
  // roles keep the writer behavior local development always had.
  function readOnly() {
    try {
      return typeof deps.role === 'function' && deps.role() === 'observer';
    } catch {
      return false;
    }
  }

  async function load() {
    try {
      state.spaceId = readSpace();
    } catch {
      state.spaceId = '';
    }
    state.loaded = false;
    state.loadError = null;
    state.activity = null;
    state.candidates = [];
    state.candidatesError = null;
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
      return;
    }
    // Unresolved identity candidates for the purple cards: the same
    // records endpoint the shell badge counts (MEM_ACC_REUSE), narrowed to
    // the unresolved rows on the server — a resolved history beyond the
    // page bound must never hide an outstanding decision. The cards still
    // ignore anything but unresolved, so an unfiltered answer stays safe.
    try {
      const read = await client.request('/api/modules/duplicate-candidate/records?filter.status=unresolved&limit=100');
      state.candidates = Array.isArray(read?.items) ? read.items : [];
      state.candidatesError = null;
    } catch (error) {
      state.candidates = [];
      // An uncomposed module (or an older Admin) is an expected absence,
      // not a fault: zero cards, silent. A failed read is a distinct state:
      // the screen must not claim everything is fixed while the identity
      // decisions were never read. The technical cause goes only to the
      // log (AGENTS.md): error name or code with the workspace id, never
      // the message or personal data.
      if (isNotComposedFailure(error) || isUnsupportedContractFailure(error)) {
        state.candidatesError = null;
      } else {
        state.candidatesError = 'Le decisioni sulle doppie schede non si sono potute leggere. Riprova più tardi.';
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn(
            'bo-sync candidates unreadable:',
            error instanceof Error ? error.name : (error?.code ?? 'unknown'),
            `spaceId=${state.spaceId}`,
          );
        }
      }
    }
  }

  function renderNote(text, cls = 'bo-sync-note', { retry = false } = {}) {
    // BO-F6-16: the Impostazioni tabs are chrome, not data — they stay on
    // screen in every state, with no badge while nothing is counted.
    mount.appendChild(settingsTabs(doc, { activeId: 'stato-sync', fixCount: null, navigate: go }));
    mount.appendChild(el(doc, 'p', 'bo-kicker', 'Backoffice'));
    mount.appendChild(el(doc, 'h2', undefined, 'Stato sync'));
    mount.appendChild(el(doc, 'p', cls, text));
    if (retry) {
      const button = el(doc, 'button', 'bo-sync-fix-action', 'Riprova');
      button.setAttribute('type', 'button');
      button.setAttribute('data-action', 'retry');
      button.addEventListener('click', () => {
        render();
        void renderView();
      });
      mount.appendChild(button);
    }
  }

  async function renderView() {
    await load();
    if (state.loadError !== null) toast(state.loadError, true);
    render();
  }

  // The prototype hero (BO-F6-16): eyebrow, pulsing dot, big title, fresh
  // subtitle and the global pull on the right (full-width on a phone).
  // While a pull runs the dot turns blue, the button reads `Sincronizzo…`
  // with a spinner and ignores clicks, and the subtitle reads `in corso…`;
  // afterwards the previous title returns.
  function renderHero(box, activity) {
    const syncing = state.syncingAll || state.syncing.size > 0;
    const extraCount = syncIdentityCards(state.candidates).length;
    const indicator = syncIndicator(activity, Date.now(), { syncing, extraCount });
    box.appendChild(settingsTabs(doc, { activeId: 'stato-sync', fixCount: indicator.count, navigate: go }));
    box.appendChild(el(doc, 'p', 'bo-kicker', 'Stato sync'));
    const hero = el(doc, 'div', 'bo-sync-hero');
    const main = el(doc, 'div', 'bo-sync-hero-main');
    const head = el(doc, 'div', 'bo-sync-hero-head');
    const dot = el(doc, 'span', `bo-sync-hero-dot bo-sync-hero-dot-${indicator.tone}`);
    dot.setAttribute('aria-hidden', 'true');
    head.appendChild(dot);
    head.appendChild(el(doc, 'h1', 'bo-sync-hero-title', indicator.title));
    main.appendChild(head);
    main.appendChild(el(doc, 'p', 'bo-sync-hero-sub', indicator.detail));
    hero.appendChild(main);
    hero.appendChild(renderHeroPull(activity, syncing));
    box.appendChild(hero);
    if (readOnly()) {
      box.appendChild(el(doc, 'p', 'bo-sync-note', 'Sola lettura (Osservatore): i pulsanti di azione sono nascosti.'));
    }
  }

  // The global pull: every syncable connection through the same
  // `sync-now-channel` path as the per-row buttons (no new backend), one
  // toast at the end, a second click ignored while it runs.
  function renderHeroPull(activity, syncing) {
    const keys = syncChannelTable(activity).flatMap((row) => row.keys);
    const button = el(
      doc,
      'button',
      'bo-sync-hero-pull',
      syncing ? 'Sincronizzo…' : 'Sincronizza ora',
    );
    button.setAttribute('type', 'button');
    button.setAttribute('data-action', 'sync-all');
    if (syncing) {
      const spin = el(doc, 'span', 'bo-sync-spin');
      spin.setAttribute('aria-hidden', 'true');
      button.appendChild(spin);
    }
    // Observers never pull: the control hides for them instead of showing
    // disabled, so the read-only screen carries no dead button.
    if (readOnly()) {
      button.setAttribute('hidden', '');
      button.setAttribute('aria-hidden', 'true');
      return button;
    }
    if (syncing || keys.length === 0) button.setAttribute('disabled', '');
    button.addEventListener('click', () => {
      void syncAll(keys);
    });
    return button;
  }

  function renderRouteLink(card, label, route) {
    const link = el(doc, 'a', 'bo-sync-fix-action', label);
    link.setAttribute('href', route);
    link.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      go(route);
    });
    card.appendChild(link);
  }

  // "Sì, tienili entrambi": the click itself is the human decision, recorded
  // with the operator's identity through the existing record action — the
  // backend stamps decidedBy/decidedAt, nothing merges, nothing deletes.
  async function dismissCandidate(id, button) {
    if (typeof button?.setAttribute === 'function') button.setAttribute('disabled', '');
    try {
      await client.request(
        `/api/modules/duplicate-candidate/records/${encodeURIComponent(id)}/actions/dismiss-duplicate-candidate`,
        { method: 'POST', body: { reason: 'Scelta dalla schermata Stato sync: tenuti entrambi.' } },
      );
      toast('Registrato: restano due schede separate.');
      await load();
    } catch (error) {
      toast(errorOf(error), true);
    } finally {
      render();
    }
  }

  function renderFixes(box, activity) {
    const items = syncFixItems(activity);
    const grants = syncGrantCards(activity, Date.now());
    const identities = syncIdentityCards(state.candidates);
    const total = items.length + grants.length + identities.length;
    const locked = readOnly();
    // BO-F6-16: the section names its count like the prototype
    // (`Da sistemare <n>`); the quiet banner is the prototype wording.
    box.appendChild(el(doc, 'h3', undefined, total === 0 ? 'Da sistemare' : `Da sistemare ${total}`));
    if (total === 0 && state.candidatesError === null) {
      box.appendChild(el(doc, 'p', 'bo-sync-note', '✓ Niente da sistemare. Se qualcosa si blocca, ti avviso io.'));
      return;
    }
    const list = el(doc, 'div', 'bo-sync-fixes');
    for (const card of grants) {
      const node = el(doc, 'div', 'bo-sync-fix bo-sync-fix-grant');
      node.appendChild(el(doc, 'p', 'bo-sync-fix-title', card.title));
      node.appendChild(el(doc, 'p', 'bo-sync-fix-detail', card.detail));
      if (!locked) renderRouteLink(node, 'Rinnova in un clic', card.route);
      list.appendChild(node);
    }
    for (const card of identities) {
      const node = el(doc, 'div', 'bo-sync-fix bo-sync-fix-identity');
      node.appendChild(el(doc, 'p', 'bo-sync-fix-title', card.title));
      if (!locked) {
        const keep = el(doc, 'button', 'bo-sync-fix-action', 'Sì, tienili entrambi');
        keep.setAttribute('type', 'button');
        keep.setAttribute('data-action', 'dismiss-duplicate-candidate');
        keep.setAttribute('data-candidate-id', card.id);
        keep.addEventListener('click', () => {
          void dismissCandidate(card.id, keep);
        });
        node.appendChild(keep);
      }
      renderRouteLink(node, 'Decido io', CLIENTI_IMPORT_ROUTE);
      list.appendChild(node);
    }
    for (const item of items) {
      const card = el(doc, 'div', 'bo-sync-fix');
      card.appendChild(el(doc, 'p', 'bo-sync-fix-title', item.title));
      card.appendChild(el(doc, 'p', 'bo-sync-fix-detail', item.detail));
      if (item.action.kind === 'route') {
        renderRouteLink(card, item.action.label, item.action.route);
      } else if (!locked) {
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
    // A failed candidates read never hides behind the fixes: the section
    // names what it could not read, without counting it as a fix.
    if (state.candidatesError !== null) {
      box.appendChild(el(doc, 'p', 'bo-sync-note', state.candidatesError));
    }
  }

  // The prototype's `Canali` card (BO-F6-16, fetta 2): nine fixed rows with
  // the mark, the name plus the fixed direction line, `agg. …`, `<n> eventi
  // oggi` and the pill — or `Collega` for a channel with no binding. No
  // per-row pull: the prototype pulls globally from the hero, and the
  // per-row buttons would be a structural difference. No account column:
  // the prototype names the channel, never the binding handle.
  function renderTable(box, activity) {
    const rows = syncChannelTable(activity);
    const connected = rows
      .filter((row) => row.connected && SYNC_CHANNELS.some((fixed) => fixed.id === row.channel)).length;
    box.appendChild(el(doc, 'h3', undefined, 'Canali'));
    box.appendChild(el(doc, 'p', 'bo-sync-count', `${connected} di 9 collegati`));
    const wrap = el(doc, 'div', 'bo-sync-tablewrap');
    const table = doc.createElement('table');
    table.setAttribute('class', 'bo-sync-table');
    const head = doc.createElement('tr');
    for (const label of ['Canale', 'Aggiornamento', 'Eventi', 'Stato']) {
      const cell = el(doc, 'th', undefined, label);
      cell.setAttribute('scope', 'col');
      head.appendChild(cell);
    }
    table.appendChild(head);
    for (const row of rows) {
      const ago = row.lastAt === null ? null : syncAgo(row.lastAt);
      const line = doc.createElement('tr');
      const name = doc.createElement('td');
      name.setAttribute('class', 'bo-sync-name');
      const nameWrap = el(doc, 'div', 'bo-sync-namewrap');
      nameWrap.appendChild(el(doc, 'span', `bo-sync-tile bo-tile-${String(row.channel ?? '').toLowerCase()}`, row.mark));
      const nameText = el(doc, 'div', 'bo-sync-nametext');
      nameText.appendChild(el(doc, 'strong', undefined, row.label));
      nameText.appendChild(el(doc, 'span', 'bo-sync-dir', row.direction));
      nameWrap.appendChild(nameText);
      name.appendChild(nameWrap);
      line.appendChild(name);
      line.appendChild(el(
        doc,
        'td',
        undefined,
        !row.connected ? 'non collegato' : ago === null ? '—' : `agg. ${ago === 'adesso' ? 'ora' : ago}`,
      ));
      line.appendChild(el(doc, 'td', undefined, !row.connected ? '—' : `${row.received} eventi oggi`));
      const stateCell = doc.createElement('td');
      if (!row.connected) {
        if (!readOnly()) {
          const link = el(doc, 'a', 'bo-sync-fix-action', 'Collega');
          link.setAttribute('href', row.detailRoute);
          link.setAttribute('data-action', 'collega');
          link.setAttribute('data-channel', row.channel);
          link.addEventListener('click', (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            go(row.detailRoute);
          });
          stateCell.appendChild(link);
        } else {
          stateCell.appendChild(el(doc, 'span', 'bo-sync-muted', 'non collegato'));
        }
      } else {
        const pill = el(doc, 'span', 'bo-sync-pill', row.pill.text);
        pill.setAttribute('data-pill', row.pill.tone);
        stateCell.appendChild(pill);
      }
      line.appendChild(stateCell);
      table.appendChild(line);
    }
    wrap.appendChild(table);
    box.appendChild(wrap);
  }

  function renderFeed(box, activity) {
    const head = el(doc, 'div', 'bo-sync-cardhead');
    head.appendChild(el(doc, 'h3', undefined, 'In tempo reale'));
    head.appendChild(el(doc, 'p', 'bo-sync-legend', '← entra · → esce · ↔ entrambi'));
    box.appendChild(head);
    const items = syncFeedItems(activity);
    if (items.length === 0) {
      box.appendChild(el(doc, 'p', 'bo-sync-note', 'Nessuna attività sincronizzata oggi.'));
      return;
    }
    const list = el(doc, 'div', 'bo-sync-feed');
    for (const item of items) {
      const line = el(doc, 'p', 'bo-sync-feed-line');
      line.appendChild(el(doc, 'span', 'bo-sync-feed-time', item.clock));
      line.appendChild(el(doc, 'span', 'bo-sync-feed-arrow', item.arrow));
      line.appendChild(el(doc, 'span', 'bo-sync-feed-text', `${item.channel}: ${item.text}`));
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

  // The hero pull (BO-F6-16): one pass over every syncable connection
  // through the same mutation path as the per-row buttons, a single toast
  // at the end, and a second click ignored while it runs. A failed row
  // stays retryable — the next render rebuilds every button enabled.
  async function syncAll(keys) {
    if (state.syncingAll || keys.length === 0) return;
    state.syncingAll = true;
    for (const key of keys) state.syncing.add(key);
    render();
    let failed = 0;
    for (const key of keys) {
      try {
        await client.request('/api/connectors/sync-now', {
          method: 'POST',
          body: { spaceId: state.spaceId.trim(), connectionKey: key },
        });
      } catch {
        failed += 1;
      }
    }
    try {
      await load();
    } catch {
      // load() records its own error; render() below shows it honestly.
    }
    state.syncingAll = false;
    state.syncing.clear();
    if (failed === 0) toast('Sincronizzazione aggiornata.');
    else toast('Alcuni canali non si sono aggiornati: riprova con Sincronizza ora.', true);
    render();
  }

  function render() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    if (state.spaceId.trim() === '') {
      renderNote('Scegli uno spazio per vedere lo stato della sincronizzazione.');
      return;
    }
    if (state.loadError !== null) {
      // A failed read keeps its honest message and offers the retry on the
      // same screen — never a code, never English, never a dead end.
      renderNote(state.loadError, 'bo-sync-error', { retry: true });
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
    renderHero(box, state.activity);
    renderFixes(box, state.activity);
    // Supervisor design pass: channels and the live feed as the prototype's
    // two cards side by side (2:1).
    const cols = el(doc, 'div', 'bo-sync-cols');
    const channels = el(doc, 'section', 'bo-sync-card bo-sync-channels');
    const live = el(doc, 'section', 'bo-sync-card bo-sync-live');
    cols.appendChild(channels);
    cols.appendChild(live);
    box.appendChild(cols);
    renderTable(channels, state.activity);
    renderFeed(live, state.activity);
  }

  return { render: renderView };
}
