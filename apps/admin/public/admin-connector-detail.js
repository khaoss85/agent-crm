// @ts-check

// Dettaglio connettore (BO-F5-03, backlog:398ef7073cfc).
//
// Ref "02 Personalizzazione" del prototipo: cosa entra, anteprima in scheda,
// impostazioni account, interruttori, chi risponde, dettagli tecnici, skill
// che lo usano.
//
// The detail reuses what already exists instead of duplicating it: the
// channel catalog (`CONNECTOR_CATALOG` in `admin-connectors.js`), the live
// connection rows of GET /api/connectors (projections of the
// `channel-connection` record of `packages/channels`, one account bound to
// one space), the grant expiries of GET /api/connectors/activity (the same
// ones the Stato sync yellow card reads) and the unit catalog of
// GET /api/space-packages/catalog (only for display labels of the declared
// consumers). The single write this file owns is the grant renewal through
// the existing `renew-connection-grant` record action (P2 Codex su #415):
// every other change still goes through the guided `#/connettori` flow
// (BO-F1-02), which the detail links to.
//
// Acceptance contract, enforced by tests/admin-connector-detail.test.js:
// every section reads the SAME `channel-connection` row (each section
// carries that row's connectionKey, and the test proves all seven match),
// and "skill che lo usano" lists only declared dependencies (each row cites
// the repo file and the verbatim string that declares the use, and the test
// proves the string is there).
//
// Conventions follow apps/admin/public/admin-core.js: the section builders
// are pure and DOM-free (unit-tested under node:test without a browser) and
// the renderer uses DOM APIs only — createElement + textContent/setAttribute
// — never innerHTML with data, so a hostile account or adapter label is
// inert text, never markup.

import { humanReadError } from './admin-core.js';
import { CONNECTOR_CATALOG, connectorStatus, matchAdapters, matchConnections } from './admin-connectors.js';
import { ACTIVE_SPACE_KEY } from './admin-shell.js';
import { PROFILO_CONNECTORS, googleConnectionsCard } from './admin-profilo.js';
import { bindAdminMutations } from './admin-submission.js';
import { grantExpiring, grantExpiryWording } from './admin-sync.js';

/** Every channel the detail can render, in catalog order. */
export const CONNECTOR_DETAIL_CHANNELS = Object.freeze(CONNECTOR_CATALOG.map((entry) => entry.channel));

/**
 * Grammar plus catalog membership: the route checks the grammar, the view
 * checks this. An unknown slug renders an honest note without ever fetching
 * for it — a hostile hash never becomes a request path.
 * @param {unknown} value
 */
export function isConnectorDetailChannel(value) {
  return typeof value === 'string' && CONNECTOR_DETAIL_CHANNELS.includes(value);
}

/**
 * @param {string} channel
 */
export function catalogFor(channel) {
  return CONNECTOR_CATALOG.find((entry) => entry.channel === channel) ?? null;
}

// Direction from the channel matrix of packages/channels/README.md (BO-F1-01):
// the five channels that send through the outbox, and the three catalog
// channels that are inbound-only by contract (CHANNEL_SEND_UNSUPPORTED).
// `sms` has no dedicated adapter in packages/channels, so its direction is
// undeclared here — the detail says so instead of guessing.
export const DIRECTION_BY_CHANNEL = Object.freeze({
  whatsapp: 'in-out',
  instagram: 'in-out',
  telegram: 'in-out',
  facebook: 'in-out',
  email: 'in-out',
  tiktok: 'in-only',
  voice: 'in-only',
  'site-form': 'in-only',
});

/**
 * @param {string} channel
 * @returns {'in-out' | 'in-only' | null} null when the matrix declares none.
 */
export function directionOf(channel) {
  const direction = /** @type {Record<string, string>} */ (DIRECTION_BY_CHANNEL)[channel];
  return direction === 'in-out' || direction === 'in-only' ? direction : null;
}

/**
 * One declared consumer of a connector: a real framework unit plus the
 * dependency it declares in the repo. `evidence` is the proof a reader (or
 * the test) can check: the file and the verbatim string that declares the
 * use. Nothing here is invented copy — remove the row when the declaration
 * moves, never the other way round.
 *
 * @typedef {{ unit: string, kind: 'package' | 'skill', edge: string, via: string, evidence: { file: string, needle: string } }} ConnectorConsumer
 */

/** @type {Record<string, ReadonlyArray<ConnectorConsumer>>} */
const CONSUMERS_BY_CHANNEL = {
  whatsapp: [
    {
      unit: 'appointments', kind: 'package', edge: 'channel-template-send@1',
      via: 'Promemoria con template WhatsApp (reminderChannel → outbox del canale).',
      evidence: { file: 'packages/appointments/src/index.js', needle: 'channel-template-send@1' },
    },
    {
      unit: 'sequences', kind: 'package', edge: 'channels outbox (queueTemplate)',
      via: 'Passi giorno+canale accodati nell\u2019outbox; lo stop alla risposta legge l\u2019inbox.',
      evidence: { file: 'packages/sequences/src/index.js', needle: 'queueTemplate' },
    },
    {
      unit: 'skill:build-custom-domain-package', kind: 'skill', edge: 'channels outbox',
      via: 'Regola «Invii verso canali esterni»: ogni invio accodato nell\u2019outbox esistente.',
      evidence: { file: 'skills/build-custom-domain-package/SKILL.md', needle: 'channels outbox' },
    },
    {
      unit: 'channels', kind: 'package', edge: 'propose-channel-reply',
      via: 'Risposta multicanale con approvazione (BO-F1-07): proposta umana, invio approvato.',
      evidence: { file: 'packages/channels/README.md', needle: 'propose-channel-reply' },
    },
    {
      unit: 'customer-data', kind: 'package', edge: 'channel-sender@1',
      via: 'Riconciliazione dei mittenti importati con le schede (mai unioni silenziose).',
      evidence: { file: 'packages/customer-data/src/sender-capability.js', needle: 'channel-sender@1' },
    },
  ],
  instagram: [
    {
      unit: 'sequences', kind: 'package', edge: 'channels outbox (queueTemplate)',
      via: 'Passi giorno+canale accodati nell\u2019outbox; lo stop alla risposta legge l\u2019inbox.',
      evidence: { file: 'packages/sequences/src/index.js', needle: 'queueTemplate' },
    },
    {
      unit: 'skill:build-custom-domain-package', kind: 'skill', edge: 'channels outbox',
      via: 'Regola «Invii verso canali esterni»: ogni invio accodato nell\u2019outbox esistente.',
      evidence: { file: 'skills/build-custom-domain-package/SKILL.md', needle: 'channels outbox' },
    },
    {
      unit: 'channels', kind: 'package', edge: 'propose-channel-reply',
      via: 'Risposta multicanale con approvazione (BO-F1-07): proposta umana, invio approvato.',
      evidence: { file: 'packages/channels/README.md', needle: 'propose-channel-reply' },
    },
    {
      unit: 'customer-data', kind: 'package', edge: 'channel-sender@1',
      via: 'Riconciliazione dei mittenti importati con le schede (mai unioni silenziose).',
      evidence: { file: 'packages/customer-data/src/sender-capability.js', needle: 'channel-sender@1' },
    },
  ],
  facebook: [
    {
      unit: 'sequences', kind: 'package', edge: 'channels outbox (queueTemplate)',
      via: 'Passi giorno+canale accodati nell\u2019outbox; lo stop alla risposta legge l\u2019inbox.',
      evidence: { file: 'packages/sequences/src/index.js', needle: 'queueTemplate' },
    },
    {
      unit: 'channels', kind: 'package', edge: 'propose-channel-reply',
      via: 'Risposta multicanale con approvazione (BO-F1-07): proposta umana, invio approvato.',
      evidence: { file: 'packages/channels/README.md', needle: 'propose-channel-reply' },
    },
    {
      unit: 'customer-data', kind: 'package', edge: 'channel-sender@1',
      via: 'Riconciliazione dei mittenti importati con le schede (mai unioni silenziose).',
      evidence: { file: 'packages/customer-data/src/sender-capability.js', needle: 'channel-sender@1' },
    },
  ],
  email: [
    {
      unit: 'sequences', kind: 'package', edge: 'channels outbox (queueTemplate)',
      via: 'Passi giorno+canale accodati nell\u2019outbox; lo stop alla risposta legge l\u2019inbox.',
      evidence: { file: 'packages/sequences/src/index.js', needle: 'queueTemplate' },
    },
    {
      unit: 'skill:build-custom-domain-package', kind: 'skill', edge: 'channels outbox',
      via: 'Regola «Invii verso canali esterni»: ogni invio accodato nell\u2019outbox esistente.',
      evidence: { file: 'skills/build-custom-domain-package/SKILL.md', needle: 'channels outbox' },
    },
    {
      unit: 'channels', kind: 'package', edge: 'propose-channel-reply',
      via: 'Risposta multicanale con approvazione (BO-F1-07): proposta umana, invio approvato.',
      evidence: { file: 'packages/channels/README.md', needle: 'propose-channel-reply' },
    },
    {
      unit: 'customer-data', kind: 'package', edge: 'channel-sender@1',
      via: 'Riconciliazione dei mittenti importati con le schede (mai unioni silenziose).',
      evidence: { file: 'packages/customer-data/src/sender-capability.js', needle: 'channel-sender@1' },
    },
  ],
  sms: [
    {
      unit: 'skill:build-custom-domain-package', kind: 'skill', edge: 'channels outbox',
      via: 'Regola «Invii verso canali esterni»: ogni invio accodato nell\u2019outbox esistente.',
      evidence: { file: 'skills/build-custom-domain-package/SKILL.md', needle: 'channels outbox' },
    },
    {
      unit: 'customer-data', kind: 'package', edge: 'channel-sender@1',
      via: 'Riconciliazione dei mittenti con le schede quando l\u2019adattatore esiste.',
      evidence: { file: 'packages/customer-data/src/sender-capability.js', needle: 'channel-sender@1' },
    },
  ],
  telegram: [
    {
      unit: 'channels', kind: 'package', edge: 'propose-channel-reply',
      via: 'Risposta multicanale con approvazione (BO-F1-07): proposta umana, invio approvato.',
      evidence: { file: 'packages/channels/README.md', needle: 'propose-channel-reply' },
    },
    {
      unit: 'skill:build-custom-domain-package', kind: 'skill', edge: 'channels outbox',
      via: 'Regola «Invii verso canali esterni»: ogni invio accodato nell\u2019outbox esistente.',
      evidence: { file: 'skills/build-custom-domain-package/SKILL.md', needle: 'channels outbox' },
    },
  ],
  tiktok: [
    {
      unit: 'sequences', kind: 'package', edge: 'reply stop (inbox)',
      via: 'Solo lettura: lo stop alla risposta legge l\u2019inbox; gli invii rifiutano (solo entrata).',
      evidence: { file: 'packages/sequences/src/index.js', needle: 'reply stop' },
    },
    {
      unit: 'customer-data', kind: 'package', edge: 'channel-sender@1',
      via: 'Riconciliazione dei mittenti importati con le schede (mai unioni silenziose).',
      evidence: { file: 'packages/customer-data/src/sender-capability.js', needle: 'channel-sender@1' },
    },
  ],
  voice: [
    {
      unit: 'sequences', kind: 'package', edge: 'reply stop (inbox)',
      via: 'Solo lettura: lo stop alla risposta legge l\u2019inbox; gli invii rifiutano (solo entrata).',
      evidence: { file: 'packages/sequences/src/index.js', needle: 'reply stop' },
    },
    {
      unit: 'customer-data', kind: 'package', edge: 'channel-sender@1',
      via: 'Riconciliazione dei mittenti importati con le schede (mai unioni silenziose).',
      evidence: { file: 'packages/customer-data/src/sender-capability.js', needle: 'channel-sender@1' },
    },
  ],
  'site-form': [
    {
      unit: 'sequences', kind: 'package', edge: 'reply stop (inbox)',
      via: 'Solo lettura: lo stop alla risposta legge l\u2019inbox; gli invii rifiutano (solo entrata).',
      evidence: { file: 'packages/sequences/src/index.js', needle: 'reply stop' },
    },
    {
      unit: 'customer-data', kind: 'package', edge: 'channel-sender@1',
      via: 'Riconciliazione dei mittenti importati con le schede (mai unioni silenziose).',
      evidence: { file: 'packages/customer-data/src/sender-capability.js', needle: 'channel-sender@1' },
    },
  ],
};

for (const rows of Object.values(CONSUMERS_BY_CHANNEL)) Object.freeze(rows);
export const CONNECTOR_CONSUMERS = Object.freeze(CONSUMERS_BY_CHANNEL);

/**
 * Declared consumers of one channel. Unknown channels have none — never an
 * invented row.
 * @param {string} channel
 * @returns {ReadonlyArray<ConnectorConsumer>}
 */
export function consumersForChannel(channel) {
  const rows = /** @type {Record<string, ReadonlyArray<ConnectorConsumer>>} */ (CONNECTOR_CONSUMERS)[channel];
  return Array.isArray(rows) ? rows : Object.freeze([]);
}

/**
 * @param {unknown} status
 */
export function statusLabel(status) {
  if (status === 'active') return 'Collegato';
  if (status === 'pending') return 'Da completare';
  if (status === 'suspended') return 'Sospeso';
  if (status === 'revoked') return 'Revocato';
  return 'Da collegare';
}

/**
 * @param {any} connection the single channel-connection row the detail reads.
 */
function accountOf(connection) {
  const account = connection !== null && typeof connection === 'object' ? connection.account : null;
  return typeof account === 'string' && account !== '' ? account : null;
}

/**
 * Every section of the connector detail, all read from the SAME
 * channel-connection row (`connection`, possibly null when the space never
 * connected this channel). Each section carries that row's connectionKey, so
 * the acceptance — "ogni voce del dettaglio legge lo stesso record" — is a
 * checkable fact, not copy.
 *
 * `spaceId` is the selected space, passed separately: live `readSyncState`
 * rows carry no spaceId (it lives on the response envelope), so reading it
 * off the row would print a false blank. A row that still carries one wins
 * for backward compatibility with older fixtures.
 *
 * @param {{ entry: any, connection: any, spaceId?: unknown }} input
 */
export function detailSections({ entry, connection, spaceId = null }) {
  const label = typeof entry?.label === 'string' && entry.label !== '' ? entry.label : 'Connettore';
  const channel = typeof entry?.channel === 'string' ? entry.channel : '';
  const connectionKey = connection !== null && typeof connection === 'object'
    && typeof connection.connectionKey === 'string' ? connection.connectionKey : null;
  const account = accountOf(connection);
  const rowSpace = connection !== null && typeof connection === 'object'
    && typeof connection.spaceId === 'string' && connection.spaceId !== '' ? connection.spaceId : null;
  const space = typeof spaceId === 'string' && spaceId !== '' ? spaceId : rowSpace;
  const stato = connection !== null && typeof connection === 'object' ? statusLabel(connection.status) : 'Da collegare';
  const direction = directionOf(channel);
  const syncLines = Array.isArray(entry?.syncLines) ? entry.syncLines.filter((line) => typeof line === 'string') : [];
  const importable = connection !== null && typeof connection === 'object' && connection.importable === true;
  const sync = connection !== null && typeof connection === 'object' && connection.sync !== null
    && typeof connection.sync === 'object' ? connection.sync : null;

  const cosaEntraLines = [...syncLines];
  if (connection === null) {
    cosaEntraLines.push('Non collegato: collega per far entrare i nuovi messaggi.');
  } else if (importable) {
    cosaEntraLines.push('La cronologia passata si importa a pagine dal passo Fatto del collegamento.');
  } else {
    cosaEntraLines.push('Solo i nuovi messaggi: questo connettore non ha cronologia da importare.');
  }

  const anteprimaSchedaLines = connection === null
    ? ['Non collegato: in scheda non compare ancora nessun messaggio da questo connettore.']
    : [
        `In scheda compare come «${label} · ${account ?? 'senza account'} · ${stato}».`,
        'Ogni messaggio porta canale, direzione e stato sync.',
      ];

  const impostazioniAccountLines = connection === null
    ? ['Nessun account collegato in questo spazio.']
    : [
        `Account collegato: ${account ?? '—'}.`,
        `Adattatore: ${typeof connection.adapter === 'string' ? connection.adapter : '—'} v${Number.isSafeInteger(connection.adapterVersion) ? connection.adapterVersion : '—'}.`,
        `Chiave di collegamento: ${connectionKey ?? '—'}.`,
        `Spazio: ${space ?? '—'}.`,
      ];

  const interruttoriLines = connection === null
    ? ['Niente da accendere o spegnere: collega prima il connettore dal flusso guidato.']
    : [
        `Stato del collegamento: ${stato}. Si cambia solo dal flusso guidato (#/connettori), mai da qui.`,
        importable
          ? `Cronologia: ${sync !== null && typeof sync.status === 'string' ? sync.status : 'da avviare'} (Fatto del collegamento, a pagine).`
          : 'Cronologia: non disponibile su questo connettore.',
        direction === 'in-only'
          ? 'Invii: rifiutati per contratto, solo entrata (CHANNEL_SEND_UNSUPPORTED).'
          : direction === null
            ? 'Invii: direzione non dichiarata nel matrix dei canali (nessun adattatore dedicato nel pacchetto).'
            : 'Invii: passano dall\u2019outbox del canale con ricevuta; senza permesso di invio aspettano l\u2019ok.',
      ];

  const chiRispondeLines = connection === null
    ? ['Nessun mittente finché il connettore non è collegato.']
    : [
        `I messaggi escono dallo spazio «${space ?? '—'}» con l\u2019account «${account ?? '—'}»: mai dal numero sbagliato.`,
        'Ruoli e canali di risposta si assegnano in Spazi e accessi, non qui.',
      ];

  const dettagliTecniciLines = connection === null
    ? [
        `Canale: ${channel === '' ? '—' : channel}.`,
        direction === null
          ? 'Direzione: non dichiarata nel matrix dei canali (nessun adattatore dedicato nel pacchetto).'
          : `Direzione: ${direction === 'in-out' ? 'entrata e uscita' : 'solo entrata'}.`,
      ]
    : [
        `Canale: ${typeof connection.channel === 'string' ? connection.channel : channel}.`,
        `Adattatore: ${typeof connection.adapter === 'string' ? connection.adapter : '—'} v${Number.isSafeInteger(connection.adapterVersion) ? connection.adapterVersion : '—'}.`,
        `Chiave di collegamento: ${connectionKey ?? '—'}.`,
        `Stato: ${typeof connection.status === 'string' ? connection.status : '—'}.`,
        direction === null
          ? 'Direzione: non dichiarata nel matrix dei canali (nessun adattatore dedicato nel pacchetto).'
          : `Direzione: ${direction === 'in-out' ? 'entrata e uscita' : 'solo entrata'}.`,
        sync !== null && typeof sync.status === 'string'
          ? `Sincronizzazione: ${sync.status} · eventi ${Number(sync.importedEvents ?? 0)} · contatti creati ${Number(sync.createdContacts ?? 0)} · da decidere ${Number(sync.unresolvedContacts ?? 0)}.`
          : 'Sincronizzazione: nessuna importazione registrata.',
      ];

  const consumers = consumersForChannel(channel);
  const skillCheLoUsanoLines = consumers.length === 0
    ? ['Nessun uso dichiarato per questo canale.']
    : consumers.map((row) => `«${row.unit}» usa «${row.edge}»: ${row.via}`);

  const section = (key, title, lines) => Object.freeze({ key, title, connectionKey, lines: Object.freeze(lines) });
  // The renewal cure for the Stato sync yellow card (P2 Codex su #415):
  // the "Rinnova in un clic" route lands here, so an active binding with a
  // stated, expiring grant carries its own renewal section — never just a
  // link back to the list whose wizard serves no active connection.
  const renewal = renewalSection({ label, connection, grantExpiresAt: rowGrant(connection) });
  return Object.freeze({
    cosaEntra: section('cosa-entra', 'Cosa entra in Accordo', cosaEntraLines),
    anteprimaScheda: section('anteprima-scheda', 'Come appare nella scheda cliente', anteprimaSchedaLines),
    impostazioniAccount: section('impostazioni-account', 'Impostazioni', impostazioniAccountLines),
    interruttori: section('interruttori', 'Interruttori', interruttoriLines),
    chiRisponde: section('chi-risponde', 'Chi risponde', chiRispondeLines),
    dettagliTecnici: section('dettagli-tecnici', 'Dettagli tecnici', dettagliTecniciLines),
    skillCheLoUsano: section('skill-che-lo-usano', 'Skill e pacchetti che lo usano', skillCheLoUsanoLines),
    ...(renewal === null ? {} : { rinnovoPermesso: renewal }),
  });
}

/**
 * The provider-stated grant expiry one live connection row carries, or null
 * when the row states none. `readSyncState` rows never carry it — only the
 * activity payload does — so the caller merges it in from there.
 * @param {any} connection
 */
function rowGrant(connection) {
  if (connection === null || typeof connection !== 'object') return null;
  return typeof connection.grantExpiresAt === 'string' && connection.grantExpiresAt !== ''
    ? connection.grantExpiresAt : null;
}

/**
 * The `Rinnovo del permesso` section: only an active binding with a stated,
 * expiring grant renews — anything else (pending, suspended, revoked, no
 * stated expiry, calm grant) has nothing to renew and gets no section.
 * The renewal records the provider-stated expiry through the existing
 * `renew-connection-grant` record action, which the card on Stato sync can
 * never invent. Pure and DOM-free, like every other section.
 * @param {{ label?: unknown, connection: any, grantExpiresAt?: unknown, nowMs?: number }} input
 */
export function renewalSection({ label, connection, grantExpiresAt = null, nowMs = Date.now() } = {}) {
  if (connection === null || typeof connection !== 'object') return null;
  if (connection.status !== 'active') return null;
  const connectionKey = typeof connection.connectionKey === 'string' && connection.connectionKey !== ''
    ? connection.connectionKey : null;
  if (connectionKey === null) return null;
  const expiresAt = typeof grantExpiresAt === 'string' && grantExpiresAt !== '' ? grantExpiresAt : rowGrant(connection);
  if (expiresAt === null || !grantExpiring(expiresAt, nowMs)) return null;
  const name = typeof label === 'string' && label !== '' ? label : 'Connettore';
  const when = grantExpiryWording(expiresAt, nowMs);
  return Object.freeze({
    key: 'rinnovo-permesso',
    title: 'Rinnovo del permesso',
    connectionKey,
    expiresAt,
    lines: Object.freeze([
      `Il permesso di ${name} ${when}.`,
      'Riautorizza presso il provider, poi registra qui la scadenza che il provider dichiara: solo una scadenza reale fa sparire l\u2019avviso.',
    ]),
  });
}

import { el } from './admin-ui.js'; // BO-F6-02: the single component library.

function errorOf(error) {
  return humanReadError(error, { failed: 'La richiesta non è riuscita. Riprova più tardi.' });
}

/**
 * A view controller for the connector detail. Same injectable shape as the
 * other Admin views (`doc`, `mount`, `client`, `storage`, `navigate`), so it
 * stays testable without a browser. The single write this view owns is the
 * grant renewal through the existing `renew-connection-grant` record action
 * (P2 Codex su #415) — every other change still goes through the guided
 * `#/connettori` flow, which the detail links to.
 * @param {{ doc: any, mount: any, client: { request: (path: string, options?: object) => Promise<any> }, navigate?: (hash: string) => void, storage?: any, role?: () => string | null, toast?: (message: string, isError?: boolean) => void }} deps
 */
export function createConnectorDetailView(deps) {
  const { doc, mount, navigate } = deps;
  const { client } = bindAdminMutations(deps.client, deps);
  const storage = deps.storage ?? null;
  const toast = deps.toast ?? (() => {});

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
    adapters: /** @type {Array<any>} */ ([]),
    entries: /** @type {Array<any>} */ ([]),
    /** @type {Map<string, string>} */ grants: new Map(),
    units: /** @type {Array<any> | null} */ (null),
    catalogError: /** @type {string | null} */ (null),
    channelsReady: false,
    loaded: false,
    loadError: null,
    /** @type {any} */ google: null,
  };

  // The observer role watches without touching: the renewal write below
  // hides for observers, like every write control on Stato sync. Unknown or
  // absent roles keep the writer behavior local development always had.
  function readOnly() {
    try {
      return typeof deps.role === 'function' && deps.role() === 'observer';
    } catch {
      return false;
    }
  }

  const refreshSpace = () => {
    state.spaceId = readSpace();
    return state.spaceId;
  };

  async function load() {
    refreshSpace();
    state.loaded = false;
    state.loadError = null;
    let schema;
    try {
      schema = await client.request('/api/schema');
    } catch (error) {
      state.loadError = errorOf(error);
      return;
    }
    const meta = schema?.domains?.channels?.metadata ?? schema?.domains?.channels;
    state.channelsReady = Boolean(meta && meta.channelsContract === 1);
    state.adapters = Array.isArray(meta?.adapters) ? meta.adapters : [];
    state.units = null;
    state.catalogError = null;
    try {
      const catalog = await client.request('/api/space-packages/catalog');
      state.units = Array.isArray(catalog?.units) ? catalog.units : null;
    } catch (error) {
      // No silent fallback: the dependency list still renders with the
      // declared unit names, and the failure stays visible as a human
      // note — never with its code.
      state.units = null;
      state.catalogError = errorOf(error);
    }
    if (!state.channelsReady || state.spaceId.trim() === '') return;
    try {
      const sync = await client.request(`/api/connectors?spaceId=${encodeURIComponent(state.spaceId.trim())}`);
      state.entries = Array.isArray(sync?.connectors) ? sync.connectors : [];
      state.loaded = true;
    } catch (error) {
      state.loadError = errorOf(error);
      return;
    }
    // The provider-stated grant expiries live only in the activity payload
    // (the same one the Stato sync yellow card reads): without them the
    // detail cannot offer a renewal, so they merge onto the rows below.
    // A failed activity read degrades to no renewal section, never to a
    // fault — the detail's own rows above already decided the screen.
    state.grants = new Map();
    try {
      const activity = await client.request(
        `/api/connectors/activity?spaceId=${encodeURIComponent(state.spaceId.trim())}`,
      );
      for (const item of Array.isArray(activity?.connections) ? activity.connections : []) {
        if (item !== null && typeof item === 'object'
          && typeof item.connectionKey === 'string' && item.connectionKey !== ''
          && typeof item.grantExpiresAt === 'string' && item.grantExpiresAt !== '') {
          state.grants.set(item.connectionKey, item.grantExpiresAt);
        }
      }
    } catch {
      state.grants = new Map();
    }
  }

  function labelOfUnit(unit) {
    const found = (state.units ?? []).find((row) => row && row.name === unit);
    const label = found !== null && found !== undefined && typeof found.label === 'string' && found.label !== ''
      ? found.label
      : unit;
    return label;
  }

  function renderSection(box, section) {
    // The shipped `#/connettori` family draws blocks with bo-connector-row
    // (border, surface, radius from styles.css): the detail uses the same
    // tokens instead of an unstyled container of its own.
    const panel = el(doc, 'section', 'bo-connector-row');
    panel.appendChild(el(doc, 'h3', undefined, section.title));
    const list = el(doc, 'ul', undefined);
    for (const line of section.lines) {
      list.appendChild(el(doc, 'li', undefined, line));
    }
    panel.appendChild(list);
    box.appendChild(panel);
  }

  // The renewal cure (P2 Codex su #415): the screen the Stato sync yellow
  // card's "Rinnova in un clic" names. The human re-authorizes at the
  // provider first, then records here the expiry the provider stated —
  // through the existing `renew-connection-grant` record action, never an
  // invented date. Markup stays minimal: the same section block plus one
  // datetime field and one button.
  function renderRenewal(box, channel, section) {
    const panel = el(doc, 'section', 'bo-connector-row');
    panel.appendChild(el(doc, 'h3', undefined, section.title));
    const list = el(doc, 'ul', undefined);
    for (const line of section.lines) {
      list.appendChild(el(doc, 'li', undefined, line));
    }
    panel.appendChild(list);
    if (!readOnly()) {
      const field = el(doc, 'label', undefined, 'Nuova scadenza detta dal provider');
      const input = doc.createElement('input');
      input.setAttribute('type', 'datetime-local');
      input.setAttribute('data-action', 'renew-grant-expiry');
      field.appendChild(input);
      panel.appendChild(field);
      const button = el(doc, 'button', 'bo-sync-fix-action', 'Registra il rinnovo');
      button.setAttribute('type', 'button');
      button.setAttribute('data-action', 'renew-grant');
      button.addEventListener('click', () => {
        void renewGrant(channel, section, input, button);
      });
      panel.appendChild(button);
    }
    box.appendChild(panel);
  }

  async function renewGrant(channel, section, input, button) {
    const raw = input !== null && typeof input === 'object' && typeof input.value === 'string' ? input.value : '';
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) {
      toast('Scrivi la scadenza che il provider dichiara, poi registra.', true);
      return;
    }
    const grantExpiresAt = new Date(at).toISOString();
    if (button !== null && typeof button === 'object' && typeof button.setAttribute === 'function') {
      button.setAttribute('disabled', '');
    }
    try {
      // The record id never travels on the read rows: resolve it from the
      // same module endpoint the quality queue reads (MEM_ACC_REUSE),
      // narrowed to this binding's source key.
      const read = await client.request(
        `/api/modules/channel-connection/records?filter.sourceKey=${encodeURIComponent(section.connectionKey)}&limit=1`,
      );
      const record = Array.isArray(read?.items) ? read.items[0] : null;
      const id = record !== null && typeof record === 'object' && typeof record.id === 'string' && record.id !== ''
        ? record.id : null;
      if (id === null) {
        toast('Collegamento non trovato: ricarica e riprova.', true);
        render(channel);
        return;
      }
      await client.request(
        `/api/modules/channel-connection/records/${encodeURIComponent(id)}/actions/renew-connection-grant`,
        { method: 'POST', body: { grantExpiresAt } },
      );
      toast('Permesso rinnovato: la nuova scadenza è registrata.');
      await load();
    } catch (error) {
      toast(errorOf(error), true);
    }
    render(channel);
  }

  function renderConsumers(box, channel) {
    const rows = consumersForChannel(channel);
    const panel = el(doc, 'section', 'bo-connector-row');
    panel.appendChild(el(doc, 'h3', undefined, 'Skill e pacchetti che lo usano'));
    if (state.catalogError !== null) {
      // The failure stays visible, but never with its code: errorOf() already
      // reduced the technical detail to a human note (backlog:9da124e5).
      panel.appendChild(el(doc, 'p', 'bo-muted',
        'Etichette non caricate: uso i nomi dichiarati delle unità.'));
    }
    if (rows.length === 0) {
      panel.appendChild(el(doc, 'p', 'bo-muted', 'Nessun uso dichiarato per questo canale.'));
    } else {
      panel.appendChild(el(doc, 'p', 'bo-muted',
        'Dipendenze dichiarate nel repo: ogni voce cita la capacità o la regola che la dichiara.'));
      const list = el(doc, 'ul', undefined);
      for (const row of rows) {
        list.appendChild(el(doc, 'li', undefined, `«${labelOfUnit(row.unit)}» usa «${row.edge}»: ${row.via}`));
      }
      panel.appendChild(list);
    }
    box.appendChild(panel);
  }

  function render(channel, preferredConnectionKey = null) {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    const entry = catalogFor(channel);
    if (entry === null) {
      mount.appendChild(el(doc, 'p', 'bo-kicker', 'Backoffice'));
      mount.appendChild(el(doc, 'h2', undefined, 'Connettore sconosciuto'));
      mount.appendChild(el(doc, 'p', 'empty',
        'Questo connettore non esiste nel catalogo: niente da mostrare, nessuna richiesta inviata.'));
      const back = el(doc, 'a', undefined, 'Torna ai connettori');
      back.setAttribute('href', '#/connettori');
      back.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        navigate('#/connettori');
      });
      mount.appendChild(back);
      return;
    }
    mount.appendChild(el(doc, 'p', 'bo-kicker', 'Backoffice · Connettori'));
    mount.appendChild(el(doc, 'h2', undefined, `Connettore · ${entry.label}`));
    // Email: Gmail connects per person through the pilot's Google consent,
    // composed channels or not, so its Collega is always here.
    if (state.google !== null) mount.appendChild(state.google.node);
    if (state.loadError !== null) {
      mount.appendChild(el(doc, 'p', 'field-error', state.loadError));
      return;
    }
    if (!state.channelsReady) {
      mount.appendChild(el(doc, 'p', 'empty', 'I canali non sono composti in questa applicazione: niente da mostrare.'));
      return;
    }
    if (state.spaceId.trim() === '') {
      mount.appendChild(el(doc, 'p', 'empty', 'Scegli lo spazio per vedere il suo collegamento.'));
      return;
    }
    // The list's own contract: without a composed adapter the connector is
    // 'non-disponibile' with no connections, whatever stale rows exist. The
    // detail mirrors it exactly instead of re-deriving its own answer.
    const mapped = connectorStatus({
      entry,
      adapters: matchAdapters(channel, state.adapters),
      connections: matchConnections(channel, state.entries),
    });
    const available = mapped.status !== 'non-disponibile';
    const connections = available ? mapped.connections : [];
    // The Stato sync yellow card names its binding (backlog:3a3e6eaf): the
    // requested row wins over the first active one, so a renewal always
    // lands on the binding whose deadline the operator saw. Unknown keys
    // fall back to the first active row, as before.
    const preferred = typeof preferredConnectionKey === 'string' && preferredConnectionKey !== ''
      ? connections.find((row) => row !== null && typeof row === 'object'
        && row.connectionKey === preferredConnectionKey) ?? null
      : null;
    const connection = available
      ? (preferred ?? connections.find((row) => row.status === 'active') ?? connections[0] ?? null)
      : null;
    const badge = !available
      ? 'Non disponibile qui'
      : connection !== null ? statusLabel(connection.status) : 'Da collegare';
    mount.appendChild(el(doc, 'p', 'bo-muted',
      connection !== null && accountOf(connection) !== null
        ? `${entry.label} · ${accountOf(connection)} · ${badge}`
        : `${entry.label} · ${badge}`));
    if (!available) {
      mount.appendChild(el(doc, 'p', 'empty',
        'Nessun adattatore composto per questo canale: non si può collegare qui.'));
      // No row, no roster, no row-dependent sections: a stale connection row
      // must never surface an account, a key, or an outbox promise the list
      // honestly hides and the wizard cannot create. Declared consumers stay:
      // they need no row.
      renderConsumers(mount, channel);
      const back = el(doc, 'a', undefined, 'Torna ai connettori');
      back.setAttribute('href', '#/connettori');
      back.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        navigate('#/connettori');
      });
      const row = el(doc, 'p', undefined);
      row.appendChild(back);
      mount.appendChild(row);
      return;
    }
    // The grant expiry lives only in the activity payload (the same one the
    // Stato sync yellow card reads): merge it onto the row so the renewal
    // section and the card always name the same deadline.
    const statedGrant = connection !== null && connection !== undefined
      && typeof connection.connectionKey === 'string'
      ? state.grants.get(connection.connectionKey) ?? null : null;
    const bound = connection !== null && statedGrant !== null
      ? { ...connection, grantExpiresAt: statedGrant } : connection;
    const sections = detailSections({ entry, connection: bound, spaceId: state.spaceId.trim() });
    // The "Rinnova in un clic" route lands here: the renewal cures the
    // yellow card in place, above the how-it-works sections.
    if (sections.rinnovoPermesso !== undefined && sections.rinnovoPermesso !== null) {
      renderRenewal(mount, channel, sections.rinnovoPermesso);
    }
    renderSection(mount, sections.cosaEntra);
    renderSection(mount, sections.anteprimaScheda);
    renderSection(mount, sections.impostazioniAccount);
    renderSection(mount, sections.interruttori);
    renderSection(mount, sections.chiRisponde);
    renderSection(mount, sections.dettagliTecnici);
    if (connections.length > 1) {
      // One space can bind several accounts to the same channel (the
      // connection key is space+channel+account): the detail shows the active
      // row above, and every bound account stays visible here instead of an
      // arbitrary first row hiding the others.
      const roster = el(doc, 'section', 'bo-connector-row');
      roster.appendChild(el(doc, 'h3', undefined, 'Altri collegamenti di questo canale'));
      const list = el(doc, 'ul', undefined);
      for (const row of connections) {
        const key = row !== null && typeof row === 'object' && typeof row.connectionKey === 'string'
          ? row.connectionKey
          : '—';
        const who = row !== null && typeof row === 'object' && typeof row.account === 'string' && row.account !== ''
          ? row.account
          : 'senza account';
        const how = row !== null && typeof row === 'object' ? statusLabel(row.status) : statusLabel(null);
        list.appendChild(el(doc, 'li', undefined, `${who} · ${how} · ${key}`));
      }
      roster.appendChild(list);
      mount.appendChild(roster);
    }
    renderConsumers(mount, channel);
    const row = el(doc, 'p', undefined);
    if (connection === null) {
      const go = el(doc, 'a', undefined, 'Collega in 3 passi');
      go.setAttribute('href', '#/connettori');
      go.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        navigate('#/connettori');
      });
      row.appendChild(go);
    } else {
      const open = el(doc, 'a', undefined, 'Apri il flusso di collegamento');
      open.setAttribute('href', '#/connettori');
      open.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        navigate('#/connettori');
      });
      row.appendChild(open);
    }
    mount.appendChild(row);
  }

  return {
    render: async (channel, preferredConnectionKey = null) => {
      // Loading state: the mount never sits on stale content while the three
      // requests are in flight. render() clears it again on arrival.
      while (mount.firstChild) mount.removeChild(mount.firstChild);
      state.google = channel === 'email'
        ? googleConnectionsCard({ doc, client: deps.client,
          entries: PROFILO_CONNECTORS.filter((entry) => entry.connector === 'gmail') })
        : null;
      mount.appendChild(el(doc, 'p', 'bo-muted', 'Caricamento del connettore…'));
      await load();
      render(channel, preferredConnectionKey);
    },
  };
}
