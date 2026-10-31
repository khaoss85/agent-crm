// @ts-check

// Connettori (BO-F1-02): collegare un connettore in 3 passi.
//
// Ref "02 Personalizzazione": autorizza → cosa sincronizzare → fatto; l'AI
// propone l'unione dei duplicati; "cosa succede quando colleghi" finché il
// connettore non è collegato.
//
// The screen reuses what is already live instead of duplicating it: the
// channel connections and the progressive initial import of
// `packages/channels` (register → activate → start/advance, whose sender
// reconciliation files ambiguous contacts as unresolved `duplicate-candidate`
// rows through `packages/customer-data`, never merging silently), the
// duplicate-candidate queue the Stato sync screen already renders, and the
// adapter identities the composed application publishes on `/api/schema`.
// This file owns no storage and no merge: passo 1 authorizes through
// POST /api/connectors/authorize, passo 2 chooses the history import through
// POST /api/connectors/finish (the server pulls at most a few pages per
// request — no scheduler advances it later — and passo 3 resumes from Fatto
// until the import reports done), passo 3 reads the receipts back.
//
// Conventions follow apps/admin/public/admin-core.js: the catalog, the flow
// state machine and the status mapping are pure and DOM-free (unit-tested
// under node:test without a browser) and the renderer uses DOM APIs only —
// createElement + textContent/setAttribute — never innerHTML with data, so a
// hostile channel, account or adapter label is inert text, never markup.

import { humanReadError } from './admin-core.js';
import { ACTIVE_SPACE_KEY } from './admin-shell.js';
import { googleConnectionsCard } from './admin-profilo.js';
import { bindAdminMutations } from './admin-submission.js';

/** The three guided steps, in order. */
export const CONNECT_STEPS = Object.freeze(['autorizza', 'sincronizza', 'fatto']);

export const CONNECT_STEP_LABELS = Object.freeze({
  autorizza: '1 · Autorizza',
  sincronizza: '2 · Cosa sincronizzare',
  fatto: '3 · Fatto',
});

/**
 * Fixed presentation catalog, one entry per connectable channel. Adapter
 * identities (which adapter serves the channel in this composition) come
 * from the live schema, never from here — a hardcoded adapter name would
 * rot the moment a deployment registers its own.
 *
 * @typedef {{ channel: string, label: string, accountLabel: string, accountPlaceholder: string, syncLines: ReadonlyArray<string>, whatHappens: ReadonlyArray<string> }} ConnectorCatalogEntry
 */
export const CONNECTOR_CATALOG = Object.freeze([
  {
    channel: 'whatsapp',
    label: 'WhatsApp',
    accountLabel: 'Numero aziendale collegato',
    accountPlaceholder: '+39 333 1234567',
    syncLines: Object.freeze(['Nuovi messaggi in arrivo e in uscita', 'Cronologia passata, piano piano (facoltativa)']),
    whatHappens: Object.freeze([
      'Colleghi il numero: i nuovi messaggi entrano da soli nelle conversazioni.',
      'Se scegli la cronologia, il passato arriva a pagine: da Fatto continui finché è completa.',
      'I contatti che sembrano doppioni diventano proposte da decidere in Stato sync, mai uniti da soli.',
    ]),
  },
  {
    channel: 'instagram',
    label: 'Instagram',
    accountLabel: 'Account aziendale collegato',
    accountPlaceholder: 'palestra.esempio',
    syncLines: Object.freeze(['Nuovi messaggi direct in arrivo e in uscita', 'Cronologia passata, piano piano (facoltativa)']),
    whatHappens: Object.freeze([
      'Colleghi l\u2019account: i nuovi direct entrano da soli nelle conversazioni.',
      'Se scegli la cronologia, il passato arriva a pagine: da Fatto continui finché è completa.',
      'I contatti che sembrano doppioni diventano proposte da decidere in Stato sync, mai uniti da soli.',
    ]),
  },
  {
    channel: 'telegram',
    label: 'Telegram',
    accountLabel: 'Bot collegato',
    accountPlaceholder: '@nome_del_bot',
    syncLines: Object.freeze(['Nuovi messaggi di chat e bot in arrivo e in uscita']),
    whatHappens: Object.freeze([
      'Colleghi il bot: i nuovi messaggi entrano da soli nelle conversazioni.',
      'Le chat Telegram non hanno una cronologia da importare: parte tutto da qui.',
      'I contatti che sembrano doppioni diventano proposte da decidere in Stato sync, mai uniti da soli.',
    ]),
  },
  {
    channel: 'facebook',
    label: 'Facebook',
    accountLabel: 'Pagina aziendale collegata',
    accountPlaceholder: 'Palestra Esempio',
    syncLines: Object.freeze(['Nuovi messaggi della pagina in arrivo e in uscita', 'Cronologia passata, piano piano (facoltativa)']),
    whatHappens: Object.freeze([
      'Colleghi la pagina: i nuovi messaggi entrano da soli nelle conversazioni.',
      'Se scegli la cronologia, il passato arriva a pagine: da Fatto continui finché è completa.',
      'I contatti che sembrano doppioni diventano proposte da decidere in Stato sync, mai uniti da soli.',
    ]),
  },
  {
    channel: 'tiktok',
    label: 'TikTok',
    accountLabel: 'Account aziendale collegato',
    accountPlaceholder: 'palestra.esempio',
    // In-only by the channels matrix (CHANNEL_SEND_UNSUPPORTED): the entry
    // must never promise outbound, in the wizard or in the detail.
    syncLines: Object.freeze(['Nuovi messaggi in arrivo (solo entrata: gli invii rifiutano)', 'Cronologia passata, piano piano (facoltativa)']),
    whatHappens: Object.freeze([
      'Colleghi l\u2019account: i nuovi messaggi entrano da soli nelle conversazioni.',
      'Se scegli la cronologia, il passato arriva a pagine: da Fatto continui finché è completa.',
      'I contatti che sembrano doppioni diventano proposte da decidere in Stato sync, mai uniti da soli.',
    ]),
  },
  {
    channel: 'sms',
    label: 'SMS',
    accountLabel: 'Numero mittente collegato',
    accountPlaceholder: '+39 333 1234567',
    syncLines: Object.freeze(['Nuovi SMS in arrivo e in uscita']),
    whatHappens: Object.freeze([
      'Colleghi il numero: i nuovi SMS entrano da soli nelle conversazioni.',
      'Gli SMS non hanno una cronologia da importare: parte tutto da qui.',
      'I contatti che sembrano doppioni diventano proposte da decidere in Stato sync, mai uniti da soli.',
    ]),
  },
  {
    channel: 'email',
    label: 'Email',
    accountLabel: 'Casella collegata',
    accountPlaceholder: 'info@palestra-esempio.it',
    syncLines: Object.freeze(['Nuove email in arrivo e risposte nello stesso filo', 'Cronologia passata, piano piano (facoltativa)']),
    whatHappens: Object.freeze([
      'Colleghi la casella (anche Gmail): le nuove email entrano da sole, le risposte restano nello stesso filo.',
      'Se scegli la cronologia, il passato arriva a pagine: da Fatto continui finché è completa.',
      'I contatti che sembrano doppioni diventano proposte da decidere in Stato sync, mai uniti da soli.',
    ]),
  },
  {
    channel: 'voice',
    label: 'Chiamate',
    accountLabel: 'Numero aziendale collegato',
    accountPlaceholder: '+39 02 1234567',
    syncLines: Object.freeze(['Registro delle nuove chiamate con riepilogo']),
    whatHappens: Object.freeze([
      'Colleghi il numero: le nuove chiamate arrivano con riepilogo e segnali.',
      'Le chiamate non hanno una cronologia da importare: parte tutto da qui.',
      'I contatti che sembrano doppioni diventano proposte da decidere in Stato sync, mai uniti da soli.',
    ]),
  },
  {
    channel: 'site-form',
    label: 'Form del sito',
    accountLabel: 'Form collegato',
    accountPlaceholder: 'modulo-contatti',
    syncLines: Object.freeze(['Ogni invio apre conversazione e contatto nello spazio']),
    whatHappens: Object.freeze([
      'Colleghi il form: ogni invio apre da solo conversazione e contatto.',
      'Non c\u2019è una cronologia da importare: parte tutto da qui.',
      'I contatti che sembrano doppioni diventano proposte da decidere in Stato sync, mai uniti da soli.',
    ]),
  },
]);

/**
 * The channel badge of every list row, like the Google rows above it: a
 * 2–3 letter tile with a timeline tint (`apps/admin/public/admin-ui.js`
 * names the same tints for the timeline chips; Telegram has no timeline
 * tile yet, so it shares the data tint family — see `.ui-chip-tg`).
 * @typedef {{ tile: string, tint: string }} ConnectorBadge
 */
export const CONNECTOR_BADGES = Object.freeze({
  whatsapp: Object.freeze({ tile: 'WA', tint: 'ui-chip-wa' }),
  instagram: Object.freeze({ tile: 'IG', tint: 'ui-chip-ig' }),
  telegram: Object.freeze({ tile: 'TG', tint: 'ui-chip-tg' }),
  facebook: Object.freeze({ tile: 'FB', tint: 'ui-chip-fb' }),
  tiktok: Object.freeze({ tile: 'TT', tint: 'ui-chip-tt' }),
  sms: Object.freeze({ tile: 'S', tint: 'ui-chip-s' }),
  email: Object.freeze({ tile: '@', tint: 'ui-chip-at' }),
  voice: Object.freeze({ tile: 'TEL', tint: 'ui-chip-tel' }),
  'site-form': Object.freeze({ tile: 'WEB', tint: 'ui-chip-web' }),
});

/**
 * Adapters of the live schema serving one channel.
 * @param {string} channel
 * @param {unknown} adapters
 */
export function matchAdapters(channel, adapters) {
  if (!Array.isArray(adapters)) return [];
  return adapters.filter((entry) => entry !== null && typeof entry === 'object'
    && /** @type {{ channel?: unknown }} */ (entry).channel === channel
    && typeof /** @type {{ name?: unknown }} */ (entry).name === 'string'
    && Number.isSafeInteger(/** @type {{ version?: unknown }} */ (entry).version));
}

/**
 * Sync-state entries (GET /api/connectors) bound to one channel.
 * @param {string} channel
 * @param {unknown} entries
 */
export function matchConnections(channel, entries) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => entry !== null && typeof entry === 'object'
    && /** @type {{ channel?: unknown }} */ (entry).channel === channel
    && typeof /** @type {{ connectionKey?: unknown }} */ (entry).connectionKey === 'string');
}

/**
 * The screen status of one catalog connector: no composed adapter means the
 * connector honestly cannot connect here; no connection row means it shows
 * the "cosa succede" preview; otherwise the live row decides.
 * @param {{ entry: ConnectorCatalogEntry, adapters: Array<any>, connections: Array<any> }} input
 */
export function connectorStatus({ entry, adapters, connections }) {
  if (adapters.length === 0) {
    return Object.freeze({ status: 'non-disponibile', connections: Object.freeze([]) });
  }
  if (connections.length === 0) {
    return Object.freeze({ status: 'da-collegare', connections: Object.freeze([]) });
  }
  const active = connections.find((row) => row.status === 'active') ?? null;
  if (active !== null) {
    return Object.freeze({ status: 'collegato', connections: Object.freeze(connections) });
  }
  return Object.freeze({ status: 'da-completare', connections: Object.freeze(connections) });
}

/**
 * The 3-step flow state. Every transition returns a new frozen flow; a step
 * advances only through its own transition, so the UI cannot skip the
 * authorization nor finish without choosing what to sync.
 */
export function createConnectFlow({ channel, adapter }) {
  return Object.freeze({
    channel,
    adapter: adapter === undefined ? null : adapter,
    step: 0,
    account: '',
    history: true,
    busy: false,
    error: null,
    connection: null,
    finish: null,
  });
}

/** @param {any} flow @param {unknown} account */
export function flowSetAccount(flow, account) {
  return Object.freeze({ ...flow, account: typeof account === 'string' ? account : '' });
}

/** @param {any} flow @param {boolean} history */
export function flowChooseHistory(flow, history) {
  return Object.freeze({ ...flow, history: history !== false });
}

/** @param {any} flow */
export function flowAuthorizeStart(flow) {
  if (flow.step !== 0 || flow.busy) return flow;
  return Object.freeze({ ...flow, busy: true, error: null });
}

/** @param {any} flow @param {unknown} connection */
export function flowAuthorized(flow, connection) {
  if (flow.step !== 0) return flow;
  return Object.freeze({ ...flow, busy: false, step: 1, connection });
}

/** @param {any} flow */
export function flowFinishStart(flow) {
  if (flow.step !== 1 || flow.busy) return flow;
  return Object.freeze({ ...flow, busy: true, error: null });
}

/** @param {any} flow @param {unknown} finish */
export function flowFinished(flow, finish) {
  // A resume lands the same answer on step 2: it must be a continuation the
  // view started (busy), never a stray write onto a settled fatto step.
  if (flow.step !== 1 && !(flow.step === 2 && flow.busy === true)) return flow;
  return Object.freeze({ ...flow, busy: false, step: 2, finish });
}

/** @param {any} flow */
export function flowResumeImport(flow) {
  if (flow.step !== 2 || flow.busy) return flow;
  return Object.freeze({ ...flow, busy: true, error: null });
}

/** @param {any} flow @param {unknown} message */
export function flowFail(flow, message) {
  return Object.freeze({
    ...flow,
    busy: false,
    error: typeof message === 'string' && message !== '' ? message : 'La richiesta non è riuscita.',
  });
}

/** @param {any} flow */
export function flowBack(flow) {
  if (flow.busy || flow.step === 0 || flow.step === 2) return flow;
  return Object.freeze({ ...flow, step: 0, error: null });
}

import { el } from './admin-ui.js'; // BO-F6-02: the single component library.

function errorOf(error) {
  return humanReadError(error, { failed: 'La richiesta non è riuscita. Riprova più tardi.' });
}

/**
 * A view controller for the Connettori screen. Injecting `doc`, `mount`,
 * `client`, `storage` and `navigate` keeps it testable without a browser.
 */
export function createConnectorsView(deps) {
  const { doc, mount, navigate } = deps;
  // POSTs go through the submission controller with idempotency, like every
  // other admin view: the shared module client refuses a raw mutation without
  // an Idempotency-Key, so authorizing or finishing through it directly would
  // throw on the real code path. GETs stay on the raw client.
  const { client } = bindAdminMutations(deps.client, deps);
  const toast = deps.toast ?? (() => {});
  const storage = deps.storage ?? null;

  const readSpace = () => {
    try {
      const stored = storage !== null ? storage.getItem(ACTIVE_SPACE_KEY) : null;
      return typeof stored === 'string' ? stored : '';
    } catch {
      return '';
    }
  };

  // The shell space picker writes storage without telling this view: every
  // load and every mutation re-reads it, so switching spaces and then
  // opening Connettori never authorizes into the previously stored space.
  const refreshSpace = () => {
    state.spaceId = readSpace();
    return state.spaceId;
  };

  const state = {
    spaceId: readSpace(),
    adapters: /** @type {Array<any>} */ ([]),
    entries: /** @type {Array<any>} */ ([]),
    channelsReady: false,
    loaded: false,
    loadError: null,
    /** @type {any} */ flow: null,
    busyControls: /** @type {Array<any>} */ ([]),
    /** @type {any} */ google: null,
  };

  const setBusy = (busy) => {
    for (const control of state.busyControls) control.disabled = busy === true;
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
    if (!state.channelsReady || state.spaceId.trim() === '') return;
    try {
      const sync = await client.request(`/api/connectors?spaceId=${encodeURIComponent(state.spaceId.trim())}`);
      state.entries = Array.isArray(sync?.connectors) ? sync.connectors : [];
      state.loaded = true;
    } catch (error) {
      state.loadError = errorOf(error);
    }
  }

  function renderSteps(box, flow) {
    const steps = el(doc, 'ol', 'bo-connect-steps');
    CONNECT_STEPS.forEach((key, index) => {
      const item = el(doc, 'li', index === flow.step ? 'bo-connect-step-now' : undefined,
        /** @type {Record<string, string>} */ (CONNECT_STEP_LABELS)[key]);
      steps.appendChild(item);
    });
    box.appendChild(steps);
  }

  function renderAuthorize(box, catalog, flow) {
    box.appendChild(el(doc, 'p', 'bo-muted',
      `Passo 1: autorizzi ${catalog.label} a parlare con Accordo. Non chiede password né segreti: registra solo dove la custodia dello spazio troverà il riferimento.`));
    const adapters = matchAdapters(catalog.channel, state.adapters);
    if (adapters.length === 0) {
      box.appendChild(el(doc, 'p', 'field-error', 'Nessun adattatore composto per questo canale: non si può collegare qui.'));
      return;
    }
    const names = adapters.map((entry) => String(entry.label ?? entry.name)).join(', ');
    box.appendChild(el(doc, 'p', 'bo-muted', `Adattatore: ${names}`));
    const label = el(doc, 'label', 'bo-field');
    label.appendChild(el(doc, 'span', undefined, `${catalog.accountLabel}: `));
    const input = doc.createElement('input');
    input.setAttribute('class', 'ui-field'); // BO-F6-02: system field class.
    input.setAttribute('name', 'account');
    input.setAttribute('placeholder', catalog.accountPlaceholder);
    input.value = flow.account;
    input.addEventListener('input', () => { state.flow = flowSetAccount(state.flow, input.value); });
    label.appendChild(input);
    box.appendChild(label);
    const go = el(doc, 'button', undefined, 'Autorizza e collega');
    go.setAttribute('data-action', 'connect-authorize');
    state.busyControls.push(go);
    if (flow.busy) go.disabled = true;
    go.addEventListener('click', async () => {
      const account = String(input.value ?? '').trim();
      if (account === '') {
        state.flow = flowFail(state.flow, 'Scrivi l\u2019account da collegare.');
        render();
        return;
      }
      const picked = matchAdapters(catalog.channel, state.adapters)[0] ?? null;
      if (picked === null) {
        state.flow = flowFail(state.flow, 'Nessun adattatore composto per questo canale.');
        render();
        return;
      }
      state.flow = flowSetAccount(state.flow, account);
      state.flow = flowAuthorizeStart(state.flow);
      render();
      setBusy(true);
      try {
        const answer = await client.request('/api/connectors/authorize', {
          method: 'POST',
          body: {
            spaceId: refreshSpace().trim(),
            channel: catalog.channel,
            account,
            adapter: picked.name,
            adapterVersion: picked.version,
          },
        });
        state.flow = flowAuthorized(state.flow, answer?.connection ?? null);
        await load();
      } catch (error) {
        state.flow = flowFail(state.flow, errorOf(error));
      } finally {
        setBusy(false);
        render();
      }
    });
    box.appendChild(go);
  }

  function renderSyncChoice(box, catalog, flow) {
    const connection = flow.connection;
    const importable = connection?.importable === true;
    box.appendChild(el(doc, 'p', 'bo-muted',
      'Passo 2: scegli cosa sincronizzare. I nuovi messaggi fluiscono sempre, dal collegamento in poi.'));
    const list = el(doc, 'ul', 'bo-connect-sync');
    for (const line of catalog.syncLines) {
      list.appendChild(el(doc, 'li', undefined, line));
    }
    box.appendChild(list);
    const label = el(doc, 'label', 'bo-field');
    const check = doc.createElement('input');
    check.setAttribute('class', 'ui-check'); // BO-F6-02: system checkbox class.
    check.setAttribute('type', 'checkbox');
    check.checked = flow.history && importable;
    if (!importable) check.disabled = true;
    check.addEventListener('change', () => { state.flow = flowChooseHistory(state.flow, check.checked); });
    label.appendChild(check);
    label.appendChild(el(doc, 'span', undefined, importable
      ? 'Importa anche la cronologia passata, a pagine'
      : 'Questo connettore non ha cronologia da importare: partono solo i nuovi messaggi'));
    box.appendChild(label);
    const row = el(doc, 'p', undefined);
    const back = el(doc, 'button', undefined, 'Indietro');
    back.setAttribute('data-action', 'connect-back');
    state.busyControls.push(back);
    if (flow.busy) back.disabled = true;
    back.addEventListener('click', () => { state.flow = flowBack(state.flow); render(); });
    row.appendChild(back);
    const go = el(doc, 'button', undefined, 'Concludi il collegamento');
    go.setAttribute('data-action', 'connect-finish');
    state.busyControls.push(go);
    if (flow.busy) go.disabled = true;
    go.addEventListener('click', async () => {
      state.flow = flowFinishStart(state.flow);
      render();
      setBusy(true);
      try {
        const answer = await client.request('/api/connectors/finish', {
          method: 'POST',
          body: {
            spaceId: refreshSpace().trim(),
            connectionKey: connection?.connectionKey ?? '',
            history: importable ? state.flow.history !== false : false,
          },
        });
        state.flow = flowFinished(state.flow, answer ?? null);
        await load();
      } catch (error) {
        state.flow = flowFail(state.flow, errorOf(error));
      } finally {
        setBusy(false);
        render();
      }
    });
    row.appendChild(go);
    box.appendChild(row);
  }

  function renderDone(box, catalog, flow) {
    const finish = flow.finish;
    box.appendChild(el(doc, 'p', undefined, `${catalog.label} è collegato. Fatto.`));
    // One finish request pulls at most a few history pages, so a large past
    // reports its real progress with a button to continue — never a
    // background promise nothing keeps, and never an unconditional done.
    const summary = finish?.import ?? null;
    if (summary?.status === 'done' || finish?.done === true) {
      const imported = Number(summary?.importedEvents ?? 0);
      const created = Number(summary?.createdContacts ?? 0);
      const pending = Number(summary?.unresolvedContacts ?? 0);
      box.appendChild(el(doc, 'p', 'bo-muted',
        `Cronologia completata: ${imported} eventi importati, ${created} contatti creati, ${pending} da decidere.`));
    } else if (finish?.done === false && (finish?.started === true || finish?.resumed === true)) {
      const imported = Number(summary?.importedEvents ?? 0);
      box.appendChild(el(doc, 'p', 'bo-muted',
        `Cronologia in corso: ${imported} eventi importati finora. Continua per completarla.`));
      const more = el(doc, 'button', undefined, 'Continua l\u2019importazione');
      more.setAttribute('data-action', 'connect-resume');
      state.busyControls.push(more);
      if (flow.busy) more.disabled = true;
      more.addEventListener('click', async () => {
        state.flow = flowResumeImport(state.flow);
        render();
        setBusy(true);
        try {
          const answer = await client.request('/api/connectors/finish', {
            method: 'POST',
            body: {
              spaceId: refreshSpace().trim(),
              connectionKey: state.flow.connection?.connectionKey ?? '',
              history: state.flow.history !== false,
            },
          });
          state.flow = flowFinished(state.flow, answer ?? null);
          await load();
        } catch (error) {
          state.flow = flowFail(state.flow, errorOf(error));
        } finally {
          setBusy(false);
          render();
        }
      });
      const row = el(doc, 'p', undefined);
      row.appendChild(more);
      box.appendChild(row);
    } else {
      box.appendChild(el(doc, 'p', 'bo-muted',
        'Da qui in poi arrivano i nuovi messaggi. Niente cronologia: l\u2019hai saltata al passo 2.'));
    }
    box.appendChild(el(doc, 'p', 'bo-muted',
      'I contatti che sembrano doppioni diventano proposte da decidere in Stato sync: nessuno viene unito da solo.'));
    const row = el(doc, 'p', undefined);
    const sync = el(doc, 'a', undefined, 'Vedi lo stato in Stato sync');
    sync.setAttribute('href', '#/stato-sync');
    sync.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      navigate('#/stato-sync');
    });
    row.appendChild(sync);
    const close = el(doc, 'button', undefined, 'Chiudi');
    close.setAttribute('data-action', 'connect-close');
    close.addEventListener('click', () => { state.flow = null; render(); });
    row.appendChild(close);
    box.appendChild(row);
  }

  function renderFlow(box, catalog) {
    const flow = state.flow;
    if (flow === null || flow.channel !== catalog.channel) return;
    const panel = el(doc, 'div', 'bo-connect-flow');
    panel.appendChild(el(doc, 'h4', undefined, `Collega ${catalog.label}`));
    renderSteps(panel, flow);
    if (flow.error !== null) panel.appendChild(el(doc, 'p', 'field-error', flow.error));
    if (flow.step === 0) renderAuthorize(panel, catalog, flow);
    else if (flow.step === 1) renderSyncChoice(panel, catalog, flow);
    else renderDone(panel, catalog, flow);
    box.appendChild(panel);
  }

  function renderRow(box, catalog) {
    const adapters = matchAdapters(catalog.channel, state.adapters);
    const connections = matchConnections(catalog.channel, state.entries);
    const mapped = connectorStatus({ entry: catalog, adapters, connections });
    // One row like the Google rows above it (apps/admin/public/admin-profilo.js):
    // badge tile, bold name, one description line, status pill and Collega.
    // No underlined link and no bullet list: the row itself opens the detail.
    const row = el(doc, 'div', 'bo-profilo-conn bo-conn-row');
    row.setAttribute('data-channel', catalog.channel);
    const badge = Object.hasOwn(CONNECTOR_BADGES, catalog.channel)
      ? /** @type {Record<string, ConnectorBadge>} */ (CONNECTOR_BADGES)[catalog.channel]
      : { tile: '?', tint: 'ui-chip-plain' };
    row.appendChild(el(doc, 'span', `ui-chip ${badge.tint} bo-profilo-tile`, badge.tile));
    // The row opener is a link wearing the row's words — the same idiom as
    // the Oggi agenda rows (`.bo-oggi-agenda-row > a`): ink color, no
    // underline, never the old blue `Dettaglio …` link.
    const open = doc.createElement('a');
    open.setAttribute('class', 'bo-conn-open');
    open.setAttribute('href', `#/connettori/${catalog.channel}`);
    open.setAttribute('data-action', `open-${catalog.channel}`);
    open.appendChild(el(doc, 'span', 'bo-profilo-conn-name', catalog.label));
    const active = mapped.connections.find((item) => item !== null && typeof item === 'object'
      && /** @type {{ status?: unknown }} */ (item).status === 'active') ?? null;
    const account = active !== null && typeof /** @type {{ account?: unknown }} */ (active).account === 'string'
      && /** @type {{ account?: string }} */ (active).account.trim() !== ''
      ? /** @type {{ account?: string }} */ (active).account.trim() : null;
    open.appendChild(el(doc, 'span', 'bo-profilo-conn-line',
      account !== null ? `Collegato come ${account}` : String(catalog.syncLines[0] ?? catalog.accountLabel)));
    open.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      navigate(`#/connettori/${catalog.channel}`);
    });
    row.appendChild(open);
    const side = el(doc, 'div', 'bo-profilo-conn-side');
    const pill = mapped.status === 'collegato'
      ? { text: 'Collegato', tone: 'ok' }
      : mapped.status === 'da-completare'
        ? { text: 'Da completare', tone: 'warn' }
        : mapped.status === 'non-disponibile'
          ? { text: 'Non disponibile qui', tone: 'muted' }
          : { text: 'Da collegare', tone: 'muted' };
    side.appendChild(el(doc, 'span', `bo-profilo-pill bo-profilo-pill-${pill.tone}`, pill.text));
    if (mapped.status === 'da-collegare' || mapped.status === 'da-completare') {
      const go = el(doc, 'button', 'ui-btn ui-btn-cta ui-btn-small', 'Collega');
      go.setAttribute('data-action', 'connect-open');
      state.busyControls.push(go);
      go.addEventListener('click', async () => {
        // Completing an incomplete row re-authorizes with that row's own
        // adapter identity: picking adapters[0] under a multi-adapter
        // composition would rebind under a different adapter and fail with
        // CHANNEL_CONNECTION_CONFLICT instead of activating the row. The
        // schema fallback applies only when the row carries no identity.
        const candidates = matchAdapters(catalog.channel, state.adapters);
        const completing = mapped.status === 'da-completare'
          ? connections.find((item) => item.status === 'pending')
            ?? connections.find((item) => item.status === 'suspended')
            ?? connections[0] ?? null
          : null;
        const rowAdapter = completing !== null && typeof completing === 'object'
          && typeof completing.adapter === 'string'
          && Number.isSafeInteger(completing.adapterVersion)
          ? candidates.find((entry) => entry.name === completing.adapter
            && entry.version === completing.adapterVersion) ?? null
          : null;
        const picked = rowAdapter ?? candidates[0] ?? null;
        state.flow = createConnectFlow({ channel: catalog.channel, adapter: picked });
        if (mapped.status !== 'da-completare') {
          render();
          return;
        }
        // Collega on a da-completare row never finishes a non-active connection
        // directly: an active row can continue to the sync choice, but a
        // pending or suspended row goes through the authorize endpoint first
        // (which activates it and refuses a revoked row clearly), landing on
        // step 1 instead of failing step 2 with NOT_ACTIVE.
        const resumable = connections.find((item) => item.status === 'active') ?? null;
        if (resumable !== null) {
          state.flow = flowAuthorized(state.flow, resumable);
          render();
          return;
        }
        const next = connections.find((item) => item.status === 'pending')
          ?? connections.find((item) => item.status === 'suspended')
          ?? connections[0] ?? null;
        if (next === null || picked === null) {
          render();
          return;
        }
        state.flow = flowAuthorizeStart(state.flow);
        render();
        setBusy(true);
        try {
          const answer = await client.request('/api/connectors/authorize', {
            method: 'POST',
            body: {
              spaceId: refreshSpace().trim(),
              channel: catalog.channel,
              account: typeof next.account === 'string' ? next.account : '',
              adapter: picked.name,
              adapterVersion: picked.version,
            },
          });
          state.flow = flowAuthorized(state.flow, answer?.connection ?? null);
          await load();
        } catch (error) {
          state.flow = flowFail(state.flow, errorOf(error));
        } finally {
          setBusy(false);
          render();
        }
      });
      side.appendChild(go);
    }
    row.appendChild(side);
    renderFlow(row, catalog);
    box.appendChild(row);
  }

  async function render() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    state.busyControls = [];
    mount.appendChild(el(doc, 'p', 'bo-kicker', 'Backoffice'));
    mount.appendChild(el(doc, 'h2', undefined, 'Connettori'));
    mount.appendChild(el(doc, 'p', 'bo-muted',
      'Collega un connettore in 3 passi: autorizza, scegli cosa sincronizzare, fatto.'));
    // Google Calendar and Gmail connect per person through the pilot's
    // Google consent, not through the channels package: they show here
    // whether or not the channels are composed.
    if (state.google !== null) mount.appendChild(state.google.node);

    // No Spazio field and no Ricarica button here: the shell space picker
    // owns the active space through ACTIVE_SPACE_KEY, and every load and
    // every mutation re-reads it (see refreshSpace above).
    if (state.loadError !== null) {
      mount.appendChild(el(doc, 'p', 'field-error', state.loadError));
      return;
    }
    if (!state.channelsReady) {
      mount.appendChild(el(doc, 'p', 'empty', 'I canali non sono composti in questa applicazione: niente da collegare.'));
      return;
    }
    if (state.spaceId.trim() === '') {
      mount.appendChild(el(doc, 'p', 'empty', 'Scegli lo spazio per vedere i suoi collegamenti.'));
      return;
    }
    const card = el(doc, 'section', 'panel bo-profilo-card bo-canali-card');
    card.setAttribute('data-section', 'canali');
    card.appendChild(el(doc, 'h3', 'bo-profilo-card-title', 'Canali'));
    card.appendChild(el(doc, 'p', 'bo-profilo-card-lede',
      'Ogni canale si collega in 3 passi: autorizza, scegli cosa sincronizzare, fatto. Tocca la riga per il dettaglio.'));
    const list = el(doc, 'div', 'bo-profilo-conns');
    for (const catalog of CONNECTOR_CATALOG) {
      renderRow(list, catalog);
    }
    card.appendChild(list);
    mount.appendChild(card);
  }

  return {
    render: async () => {
      state.google = googleConnectionsCard({ doc, client: deps.client });
      await load();
      render();
    },
  };
}
