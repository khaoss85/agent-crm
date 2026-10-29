// @ts-check

// BO-F3-03 — Backoffice "10 Sequenze": elenco + dettaglio.
//
// Reference: the approved backoffice prototype, screen "10 Sequenze" (an
// elenco of sequences with state and metrics, a detail with day+channel
// steps, people with states, pause/resume). Structure only: no copy from
// the prototype ever enters this file.
//
// What it reuses, never duplicates (MEM_ACC_REUSE):
// - reads: the generic `/api/modules/:module/records` surface over the
//   `sequence`, `sequence-step`, `sequence-enrollment` and `sequence-send`
//   managed modules, like every other admin view;
// - writes: the `activate` / `pause` code-first actions of the sequences
//   package (the only way a sequence changes state), with the screen asking
//   twice before either, posted through the bound submission client so the
//   Admin mutation gate sees its Idempotency-Key;
// - space scope: reads carry `filter.spaceId` from the shell accessor like
//   the customer scheda, and a failed read renders as unavailable — never
//   as a genuine zero;
// - channel labels: CONNECTOR_CATALOG of admin-connectors.js.
// Metrics are counted from the rows just read — people by enrollment
// state, fires by send state — never stored, never invented. A space
// without the sequences package gets the story named, never a blank page.
//
// Conventions follow apps/admin/public/admin-oggi.js: the model builders
// are pure and DOM-free (unit-tested under node:test with the fake DOM)
// and the renderer uses DOM APIs only — createElement + textContent /
// setAttribute — never innerHTML with data, so hostile sequence, step or
// person names are inert text, never markup.

import { CONNECTOR_CATALOG } from './admin-connectors.js';
import { bindAdminMutations } from './admin-submission.js';

/** How many rows each module read takes: one page, said out loud. */
export const SEQUENZE_READ_LIMIT = 200;

/** Sequence states in the order the package publishes them. */
export const SEQUENCE_STATUS_LABEL = Object.freeze({
  draft: 'Bozza',
  active: 'Attiva',
  paused: 'In pausa',
});

/** Enrollment states in the order the package publishes them. */
export const ENROLLMENT_STATUS_LABEL = Object.freeze({
  active: 'Attiva',
  paused: 'In pausa',
  'stopped-replied': 'Fermata alla risposta',
  completed: 'Completata',
});

/** Send states in the order the package publishes them. */
export const SEND_STATUS_LABEL = Object.freeze({
  queued: 'In coda',
  'waiting-approval': 'Aspetta il tuo ok',
  sent: 'Inviato',
  'dead-letter': 'Non recapitato',
  skipped: 'Saltato',
});

/**
 * @param {unknown} value
 */
function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * @param {object} doc DOM document (real or fake).
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
import { el, uiAddOption, uiButton } from './admin-ui.js'; // BO-F6-02: the single component library.

/**
 * Italian label for a sequence state; unknown states say so, never blank.
 * @param {unknown} status
 */
export function sequenceStatusLabel(status) {
  const label = typeof status === 'string' ? SEQUENCE_STATUS_LABEL[status] : undefined;
  return label ?? 'Stato sconosciuto';
}

/**
 * Italian label for an enrollment state; unknown states say so.
 * @param {unknown} status
 */
export function enrollmentStatusLabel(status) {
  const label = typeof status === 'string' ? ENROLLMENT_STATUS_LABEL[status] : undefined;
  return label ?? 'Stato sconosciuto';
}

/**
 * Italian label for a send state; unknown states say so.
 * @param {unknown} status
 */
export function sendStatusLabel(status) {
  const label = typeof status === 'string' ? SEND_STATUS_LABEL[status] : undefined;
  return label ?? 'Stato sconosciuto';
}

/**
 * Channel labels from the same catalog the connectors screen renders, so a
 * step channel reads the same everywhere. Unknown channels say their own
 * name instead of vanishing.
 * @param {unknown} channel
 */
export function sequenceChannelLabel(channel) {
  const name = nonEmptyText(channel);
  if (name === null) return 'Canale sconosciuto';
  const entry = CONNECTOR_CATALOG.find((item) => item?.channel === name);
  return entry?.label ?? name;
}

/**
 * The prototype's person pill: `In corso` / `Da approvare` / `Completata` /
 * `Programmata`. A terminal enrollment (`completed`, `stopped-replied`) reads
 * `Completata` even when a leftover send still waits for approval — the reply
 * already exited the person, so the stale send must not resurrect them; a
 * send waiting for a human on a live enrollment reads `Da approvare`; a held
 * (paused) enrollment reads `Programmata`, never `In corso`; an unknown state
 * says so instead of borrowing a live pill.
 * @param {any} enrollment
 * @param {{ waitingApproval?: boolean, nowMs?: number }} [options]
 */
export function personStatusLabel(enrollment, { waitingApproval = false, nowMs = Date.now() } = {}) {
  const status = enrollment?.status;
  if (status === 'completed' || status === 'stopped-replied') return 'Completata';
  if (waitingApproval === true) return 'Da approvare';
  if (status === 'paused') return 'Programmata';
  if (status === 'active') {
    const raw = typeof enrollment?.nextDueAt === 'string' && enrollment.nextDueAt !== '' ? enrollment.nextDueAt : null;
    const ms = raw === null ? NaN : Date.parse(raw);
    if (Number.isFinite(ms) && ms > nowMs) return 'Programmata';
    return 'In corso';
  }
  return 'Stato sconosciuto';
}

/**
 * The prototype's progress tag: `Passo <n> di <m>`, `In attesa`, `Uscita`.
 * Terminal enrollments read `Uscita` even when they still carry a step
 * cursor; without a cursor the person reads `In attesa`; without the step
 * count (a failed steps read) the tag names the step without `di <m>`.
 * @param {any} enrollment
 * @param {unknown} totalSteps
 */
export function personStepLabel(enrollment, totalSteps) {
  const status = enrollment?.status;
  if (status === 'completed' || status === 'stopped-replied') return 'Uscita';
  if (!Number.isInteger(enrollment?.currentStep)) return 'In attesa';
  const step = enrollment.currentStep + 1;
  if (Number.isInteger(totalSteps) && totalSteps > 0) return `Passo ${step} di ${totalSteps}`;
  return `Passo ${step}`;
}

/**
 * The prototype's day tag for a step offset: `Subito`, `+1 giorno`,
 * `+N giorni`. A missing or out-of-range offset says so, never blank.
 * Negative offsets and `Scadenza` have no field behind them (dayOffset is
 * 0–365), so they stay unpainted: noted in the PR, not invented here.
 * @param {unknown} dayOffset
 */
export function sequenceDayLabel(dayOffset) {
  if (!Number.isInteger(dayOffset) || dayOffset < 0) return 'Giorno da decidere';
  if (dayOffset === 0) return 'Subito';
  if (dayOffset === 1) return '+1 giorno';
  return `+${dayOffset} giorni`;
}

/**
 * The elenco `Quando …` row from the sequence trigger label (BO-F6-12
 * fetta 1: `triggerLabel` rides the record, null when the operator never
 * named it). No label is an honest `Quando parte`, never an invented
 * trigger: the label varies per sequence, so it is data, never a constant.
 * @param {any} sequence
 */
export function sequenceQuandoLine(sequence) {
  const label = nonEmptyText(sequence?.triggerLabel);
  return label === null ? 'Quando parte' : `Quando ${label}`;
}

/**
 * Pills of the dettaglio head card. The stop falls back to the package
 * invariant (the sweep stops every enrollment at the first recorded reply),
 * the trigger falls back to an honest `da decidere`.
 * @param {any} sequence
 */
export function sequenceTriggerPills(sequence) {
  const trigger = nonEmptyText(sequence?.triggerLabel);
  const stop = nonEmptyText(sequence?.stopLabel);
  return Object.freeze({
    trigger: trigger === null ? 'Parte quando: da decidere' : `Parte quando: ${trigger}`,
    stop: stop === null ? 'Si ferma quando: alla prima risposta' : `Si ferma quando: ${stop}`,
  });
}

/**
 * Rome day+time for an instant, null when it is not a real instant.
 * Whoever uses the app always sees Rome time, never UTC or ISO.
 * @param {unknown} value
 */
export function romeDayTime(value) {
  const instant = value instanceof Date ? value : typeof value === 'string' && value !== '' ? new Date(value) : null;
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return null;
  return instant.toLocaleString('it-IT', {
    timeZone: 'Europe/Rome',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * One elenco row per sequence, with people and fires counted from the rows
 * just read. Pure and total: a malformed row still renders, honestly.
 * @param {{ sequences?: Array<any>, enrollments?: Array<any>, sends?: Array<any> }} input
 */
export function buildSequenzeElenco({ sequences = [], enrollments = [], sends = [] } = {}) {
  const rows = Array.isArray(sequences) ? sequences : [];
  const people = Array.isArray(enrollments) ? enrollments : [];
  const fires = Array.isArray(sends) ? sends : [];
  return rows.map((sequence) => {
    const key = nonEmptyText(sequence?.sourceKey) ?? (sequence?.id !== undefined && sequence?.id !== null ? String(sequence.id) : '');
    const mine = (row) => {
      const owner = nonEmptyText(row?.sequenceSourceKey);
      return owner !== null && (owner === sequence?.sourceKey || (key !== '' && owner === key));
    };
    const myPeople = people.filter(mine);
    const myFires = fires.filter(mine);
    const active = myPeople.filter((row) => row?.status === 'active').length;
    const stopped = myPeople.filter((row) => row?.status === 'stopped-replied').length;
    const waiting = myFires.filter((row) => row?.status === 'waiting-approval').length;
    const sent = myFires.filter((row) => row?.status === 'sent').length;
    // The prototype's stats row: `in pausa` for a held sequence, otherwise
    // `<n> persone · <n>% risposte` with the reply share counted from the
    // rows just read — never stored, never invented. Zero people stay an
    // honest sentence, not a 0% share over a zero denominator.
    const stats = sequence?.status === 'paused'
      ? 'in pausa'
      : myPeople.length === 0
        ? 'Nessuna persona dentro per ora.'
        : `${myPeople.length} ${myPeople.length === 1 ? 'persona' : 'persone'} · ${Math.round((100 * stopped) / myPeople.length)}% risposte`;
    return Object.freeze({
      id: sequence?.id ?? null,
      sourceKey: key,
      name: nonEmptyText(sequence?.name) ?? 'Senza nome',
      status: sequence?.status ?? 'unknown',
      statusLabel: sequenceStatusLabel(sequence?.status),
      triggerLabel: nonEmptyText(sequence?.triggerLabel),
      stopLabel: nonEmptyText(sequence?.stopLabel),
      quando: sequenceQuandoLine(sequence),
      stats,
      replyPct: myPeople.length === 0 ? null : Math.round((100 * stopped) / myPeople.length),
      peopleActive: active,
      peopleTotal: myPeople.length,
      waitingApproval: waiting,
      sent,
    });
  });
}

/**
 * The detail of one sequence: ordered day+channel steps, people with their
 * state, and the counted metrics. Steps sort by stepOrder ascending; a step
 * without an order renders last with its order said missing. `stepsFailed`
 * marks a read that never arrived, so the renderer says unavailable instead
 * of painting a genuine zero.
 * @param {{ sequence?: any, steps?: Array<any>, stepsFailed?: boolean, enrollments?: Array<any>, sends?: Array<any> }} input
 */
export function buildSequenzaDettaglio({ sequence = null, steps = [], stepsFailed = false, enrollments = [], sends = [], nowMs = Date.now() } = {}) {
  const key = nonEmptyText(sequence?.sourceKey) ?? nonEmptyText(sequence?.id) ?? '';
  const ordered = [...(Array.isArray(steps) ? steps : [])].sort((a, b) => {
    const left = Number.isInteger(a?.stepOrder) ? a.stepOrder : Number.MAX_SAFE_INTEGER;
    const right = Number.isInteger(b?.stepOrder) ? b.stepOrder : Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    const leftId = String(a?.id ?? '');
    const rightId = String(b?.id ?? '');
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const people = [...(Array.isArray(enrollments) ? enrollments : [])].sort((a, b) => {
    const left = String(a?.subjectLabel ?? a?.subjectId ?? '');
    const right = String(b?.subjectLabel ?? b?.subjectId ?? '');
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const fireRows = Array.isArray(sends) ? sends : [];
  // Maps, never plain objects: a hostile row status like `__proto__` must
  // still count instead of hitting the prototype chain. `Object.fromEntries`
  // below creates own properties, so the frozen metrics stay honest.
  const byStatus = new Map();
  for (const row of people) {
    const status = typeof row?.status === 'string' ? row.status : 'unknown';
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }
  const firesByStatus = new Map();
  for (const row of fireRows) {
    const status = typeof row?.status === 'string' ? row.status : 'unknown';
    firesByStatus.set(status, (firesByStatus.get(status) ?? 0) + 1);
  }
  const pills = sequenceTriggerPills(sequence);
  const totalSteps = ordered.length;
  // The prototype's 3 KPI cards: `In corso` (active enrollments) and
  // `Risposte` (stopped at the first reply) counted from the rows just
  // read; `Call fissate` belongs to the appointments package, which this
  // view cannot read, so it stays an honest dash — never invented.
  const kpi = Object.freeze({
    inCorso: byStatus.get('active') ?? 0,
    risposte: byStatus.get('stopped-replied') ?? 0,
    callFissate: null,
  });
  return Object.freeze({
    sourceKey: key,
    name: nonEmptyText(sequence?.name) ?? 'Senza nome',
    status: sequence?.status ?? 'unknown',
    statusLabel: sequenceStatusLabel(sequence?.status),
    triggerLabel: nonEmptyText(sequence?.triggerLabel),
    stopLabel: nonEmptyText(sequence?.stopLabel),
    pills,
    stepsFailed: stepsFailed === true,
    steps: Object.freeze(ordered.map((step) => {
      let vars = [];
      try {
        const parsed = JSON.parse(step?.templateVars ?? '[]');
        if (Array.isArray(parsed)) vars = parsed.filter((v) => typeof v === 'string');
      } catch {
        vars = [];
      }
      const channelLabel = sequenceChannelLabel(step?.channel);
      const templateName = nonEmptyText(step?.templateName) ?? 'Modello da decidere';
      return Object.freeze({
        order: Number.isInteger(step?.stepOrder) ? step.stepOrder : null,
        dayLabel: sequenceDayLabel(step?.dayOffset),
        channel: nonEmptyText(step?.channel) ?? '',
        channelLabel,
        // The prototype's step title: `<Canale> · <titolo passo>`.
        title: `${channelLabel} · ${templateName}`,
        templateName,
        templateLanguage: nonEmptyText(step?.templateLanguage) ?? '',
        vars: Object.freeze(vars),
      });
    })),
    people: Object.freeze(people.map((row) => {
      const label = nonEmptyText(row?.subjectLabel) ?? nonEmptyText(row?.subjectId) ?? 'Persona senza nome';
      const next = romeDayTime(row?.nextDueAt);
      const waiting = typeof row?.sourceKey === 'string' && row.sourceKey !== ''
        && fireRows.some((fire) => fire?.enrollmentSourceKey === row.sourceKey && fire?.status === 'waiting-approval');
      return Object.freeze({
        initials: label.trim().slice(0, 2).toUpperCase(),
        name: label,
        stepLabel: personStepLabel(row, stepsFailed === true ? null : totalSteps),
        nextLabel: next ?? 'Prossimo invio da decidere',
        status: row?.status ?? 'unknown',
        statusLabel: personStatusLabel(row, { waitingApproval: waiting, nowMs }),
      });
    })),
    metrics: Object.freeze({
      peopleByStatus: Object.freeze(Object.fromEntries(byStatus)),
      firesByStatus: Object.freeze(Object.fromEntries(firesByStatus)),
      kpi,
    }),
  });
}

/**
 * Read one page of a module. Never throws for an unreadable module: the
 * caller marks that section unavailable instead of failing the screen.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {string} module
 * @param {Record<string, string>} [filters]
 */
async function readModulePage(client, module, filters = {}) {
  const query = new URLSearchParams({ limit: String(SEQUENZE_READ_LIMIT) });
  for (const [field, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) query.set(`filter.${field}`, String(value));
  }
  const answer = await client.request(`/api/modules/${module}/records?${query.toString()}`);
  if (!Array.isArray(answer?.items)) return { rows: [], capped: false };
  return { rows: answer.items, capped: answer.items.length >= SEQUENZE_READ_LIMIT };
}

/**
 * Load everything the Sequenze screen renders. Never throws for a missing
 * package: without the sequences contract the screen renders the story
 * that delivers it, never a blank page.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {string | null} [spaceId] the shell space to scope reads to, if any
 */
export async function loadSequenzeData(client, spaceId = null) {
  const outcome = {
    sequencesAvailable: false,
    sequences: [],
    enrollments: [],
    sends: [],
    capped: false,
    unavailable: [],
  };
  let domains = {};
  try {
    const schema = await client.request('/api/schema');
    domains = schema?.domains ?? {};
  } catch {
    return outcome;
  }
  if (domains?.sequences?.sequencesContract !== 1) return outcome;
  outcome.sequencesAvailable = true;
  const scoped = spaceId === null || spaceId === undefined || spaceId === ''
    ? {}
    : { spaceId };
  for (const [module, field] of [['sequence', 'sequences'], ['sequence-enrollment', 'enrollments'], ['sequence-send', 'sends']]) {
    try {
      const page = await readModulePage(client, module, scoped);
      outcome[field] = page.rows;
      if (page.capped) outcome.capped = true;
    } catch (error) {
      console.warn(`bo-sequenze ${field} unreadable:`, error instanceof Error ? error.name : 'unknown');
      outcome.unavailable.push(field);
    }
  }
  return outcome;
}

/**
 * Load the steps of one sequence, order-ascending. Steps are append-only in
 * draft and never edited once active, so the rows just read are the answer.
 * Never resolves a failed read as an empty list: `failed` tells the detail
 * to render steps-unavailable instead of a genuine zero.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {string} sequenceSourceKey
 * @param {string | null} [spaceId] the shell space to scope the steps read to, if any
 */
export async function loadSequenzaSteps(client, sequenceSourceKey, spaceId = null) {
  try {
    const scoped = spaceId === null || spaceId === undefined || spaceId === ''
      ? {}
      : { spaceId };
    const page = await readModulePage(client, 'sequence-step', { sequenceSourceKey, ...scoped });
    return { rows: page.rows, failed: false };
  } catch (error) {
    console.warn('bo-sequenze steps unreadable:', error instanceof Error ? error.name : 'unknown');
    return { rows: [], failed: true };
  }
}

// ---------------------------------------------------------------------------
// Rendering. The screen paints its frame first (header + lede, never blank)
// and fills the elenco once the records arrive; the dettaglio opens on the
// selected sequence. Every value from a record is textContent, never HTML.
// ---------------------------------------------------------------------------

/**
 * Which write the detail offers for a sequence state, if any.
 * @param {unknown} status
 */
export function sequenzaOfferedAction(status) {
  if (status === 'draft') return Object.freeze({ action: 'activate', button: 'Attiva', confirm: 'Attivare questa sequenza? I passi dovuti possono partire.' });
  if (status === 'paused') return Object.freeze({ action: 'activate', button: 'Riattiva', confirm: 'Riattivare questa sequenza? I passi dovuti possono partire.' });
  if (status === 'active') return Object.freeze({ action: 'pause', button: 'Metti in pausa', confirm: 'Mettere in pausa? Non parte più niente finché non la riattivi.' });
  return null;
}

/**
 * Render the elenco section into a node: one row per sequence with its
 * state and its counted people and fires. Pure DOM building over the data
 * builder above, so the tests drive it without a browser.
 * @param {object} doc
 * @param {Array<any>} sequences
 * @param {Array<any>} enrollments
 * @param {Array<any>} sends
 * @param {string} selectedKey
 * @param {(sourceKey: string) => void} onSelect
 */
const SEQ_CHANNEL_MARKS = Object.freeze({ whatsapp: 'WA', email: '@', instagram: 'IG', facebook: 'FB', tiktok: 'TT', sms: 'SMS', phone: 'TEL', voice: 'TEL' });
const channelMark = (channel) => SEQ_CHANNEL_MARKS[String(channel ?? '').toLowerCase()] ?? '·';
const VAR_WORDS = Object.freeze({ name: 'il nome', first_name: 'il nome', firstName: 'il nome', company: "l'azienda", city: 'la città', date: 'la data', time: "l'ora", amount: "l'importo" });
/** «il nome e l'azienda» from template variable names; never the raw names. */
function personalisedWith(vars) {
  const words = [...new Set(vars.map((name) => VAR_WORDS[name] ?? 'i dati del cliente'))];
  return words.length <= 1 ? (words[0] ?? 'i dati del cliente') : `${words.slice(0, -1).join(', ')} e ${words.at(-1)}`;
}

export function renderSequenzeElenco(doc, sequences, enrollments, sends, selectedKey, onSelect) {
  const box = el(doc, 'section', 'bo-seq-section');
  box.appendChild(el(doc, 'h3', undefined, 'Le tue sequenze'));
  const rows = buildSequenzeElenco({ sequences, enrollments, sends });
  if (rows.length === 0) {
    box.appendChild(el(doc, 'p', 'bo-muted', 'Nessuna sequenza: creane una con il pulsante in alto.'));
    return box;
  }
  const list = el(doc, 'div', 'bo-seq-list');
  for (const row of rows) {
    const item = el(doc, 'div', 'bo-seq-row');
    if (row.sourceKey !== '' && row.sourceKey === selectedKey) item.setAttribute('data-selected', 'true');
    const head = el(doc, 'div', 'bo-seq-head');
    head.appendChild(el(doc, 'p', 'bo-seq-name', row.name));
    head.appendChild(el(doc, 'p', 'bo-seq-status', row.statusLabel));
    item.appendChild(head);
    item.appendChild(el(doc, 'p', 'bo-seq-quando', row.quando));
    item.appendChild(el(doc, 'p', 'bo-seq-stats', row.stats));
    if (row.sourceKey !== '') {
      const button = el(doc, 'button', 'bo-seq-open', 'Vedi i passi');
      button.setAttribute('data-open', row.sourceKey);
      const key = row.sourceKey;
      button.addEventListener('click', () => onSelect(key));
      item.appendChild(button);
    }
    list.appendChild(item);
  }
  box.appendChild(list);
  return box;
}

/**
 * Render the dettaglio of one sequence: state with its write button, the
 * ordered day+channel steps, the people with their states, the counted
 * metrics. `confirming` is null or the action awaiting its second ask.
 * @param {object} doc
 * @param {any} detail — buildSequenzaDettaglio() output
 * @param {string | null} confirming
 * @param {(action: string) => void} onAsk
 * @param {() => void} onCancelConfirm
 * @param {(action: string) => void} onConfirm
 * @param {boolean} busy
 */
export function renderSequenzaDettaglio(doc, detail, confirming, onAsk, onCancelConfirm, onConfirm, busy) {
  const box = el(doc, 'section', 'bo-seq-section bo-seq-detail');
  const headCard = el(doc, 'div', 'bo-seq-card bo-seq-headcard');
  const headText = el(doc, 'div', 'bo-seq-headtext');
  headText.appendChild(el(doc, 'h3', undefined, detail.name));
  headText.appendChild(el(doc, 'p', 'bo-seq-status', detail.statusLabel));
  const pills = el(doc, 'div', 'bo-seq-pills');
  pills.appendChild(el(doc, 'p', 'bo-seq-pill bo-seq-pill-trigger', detail.pills.trigger));
  pills.appendChild(el(doc, 'p', 'bo-seq-pill bo-seq-pill-stop', detail.pills.stop));
  headText.appendChild(pills);
  headCard.appendChild(headText);
  const headActions = el(doc, 'div', 'bo-seq-headactions');
  headCard.appendChild(headActions);
  box.appendChild(headCard);
  const offered = sequenzaOfferedAction(detail.status);
  if (offered !== null) {
    if (confirming === offered.action) {
      headActions.appendChild(el(doc, 'p', 'bo-seq-confirm', offered.confirm));
      const row = el(doc, 'div', 'bo-seq-btns');
      const yes = el(doc, 'button', 'primary', 'Conferma');
      yes.setAttribute('data-confirm', offered.action);
      yes.addEventListener('click', () => onConfirm(offered.action));
      const no = el(doc, 'button', undefined, 'Annulla');
      no.addEventListener('click', () => onCancelConfirm());
      if (busy) yes.setAttribute('disabled', 'true');
      row.appendChild(yes);
      row.appendChild(no);
      headActions.appendChild(row);
    } else {
      const button = el(doc, 'button', 'primary', offered.button);
      button.setAttribute('data-action', offered.action);
      button.addEventListener('click', () => onAsk(offered.action));
      if (busy) button.setAttribute('disabled', 'true');
      headActions.appendChild(button);
    }
  }
  // The prototype's 3 KPI cards under the detail: each a label + a value.
  // `Call fissate` has no appointments read behind it, so it stays a dash.
  const kpi = el(doc, 'div', 'bo-seq-kpi');
  const kpiCards = [
    ['In corso', detail.metrics.kpi.inCorso],
    ['Risposte', detail.metrics.kpi.risposte],
    ['Call fissate', detail.metrics.kpi.callFissate],
  ];
  for (const [label, value] of kpiCards) {
    const card = el(doc, 'div', 'bo-seq-kpi-card');
    card.appendChild(el(doc, 'p', 'bo-seq-kpi-label', label));
    card.appendChild(el(doc, 'p', 'bo-seq-kpi-value', value === null || value === undefined ? '—' : String(value)));
    kpi.appendChild(card);
  }
  box.appendChild(kpi);
  const steps = el(doc, 'div', 'bo-seq-card bo-seq-steps');
  steps.appendChild(el(doc, 'h4', undefined, 'Passi'));
  if (detail.stepsFailed === true) {
    steps.appendChild(el(doc, 'p', 'bo-seq-error',
      'Non riesco a leggere i passi adesso: la lista manca, non è vuota. Riprova più tardi.'));
  } else if (detail.steps.length === 0) {
    steps.appendChild(el(doc, 'p', 'bo-muted', 'Questa sequenza non ha passi registrati.'));
  } else {
    for (const step of detail.steps) {
      // The prototype's timeline: day | channel badge on a rail | title and
      // message. The template language code is plumbing, never shown. The
      // message body lives with the channel templates (no read surface), so
      // the bubble quotes the operator's own message title — never invented.
      const item = el(doc, 'div', 'bo-seq-step');
      item.appendChild(el(doc, 'p', 'bo-seq-day', step.dayLabel));
      const rail = el(doc, 'div', 'bo-seq-rail');
      rail.appendChild(el(doc, 'span', `bo-seq-badge bo-tile-${String(step.channel ?? '').toLowerCase()}`, channelMark(step.channel)));
      item.appendChild(rail);
      const body = el(doc, 'div', 'bo-seq-stepbody');
      body.appendChild(el(doc, 'p', 'bo-seq-channel', step.title));
      body.appendChild(el(doc, 'p', 'bo-seq-template', `«${step.templateName}»`));
      if (step.vars.length > 0) {
        body.appendChild(el(doc, 'p', 'bo-seq-vars', `✦ Personalizzato con ${personalisedWith(step.vars)}`));
      }
      item.appendChild(body);
      steps.appendChild(item);
    }
  }
  steps.appendChild(el(doc, 'p', 'bo-seq-note',
    'Con «Inviare risposte senza approvazione» spento, ogni messaggio della sequenza aspetta il tuo ok prima di partire.'));
  box.appendChild(steps);
  const people = el(doc, 'div', 'bo-seq-card bo-seq-people');
  people.appendChild(el(doc, 'h4', undefined, 'Persone nella sequenza'));
  if (detail.people.length === 0) {
    people.appendChild(el(doc, 'p', 'bo-muted', 'Nessuna persona in questa sequenza.'));
  } else {
    for (const person of detail.people) {
      const item = el(doc, 'div', 'bo-seq-person');
      item.appendChild(el(doc, 'span', 'bo-seq-initials', person.initials));
      const who = el(doc, 'div', 'bo-seq-who');
      who.appendChild(el(doc, 'p', 'bo-seq-person-name', person.name));
      who.appendChild(el(doc, 'p', 'bo-seq-person-step', `${person.stepLabel} · ${person.nextLabel}`));
      item.appendChild(who);
      item.appendChild(el(doc, 'p', 'bo-seq-person-status', person.statusLabel));
      people.appendChild(item);
    }
  }
  box.appendChild(people);
  return box;
}

/**
 * The Sequenze screen: elenco + dettaglio, like every mounted admin view.
 * Writes go through the bound submission client, reads stay space-explicit
 * and follow the space switcher like the customer scheda does.
 * @param {{ doc?: object, mount: object, client: { request: (path: string, options?: any) => Promise<any> }, submissions?: any, storage?: any, spaceId?: () => string | null }} deps
 */
export function createSequenzeView({ doc = null, mount, client, submissions, storage, spaceId }) {
  const documentNode = doc ?? (typeof document !== 'undefined' ? document : null);
  const { client: bound } = bindAdminMutations(client, { submissions, storage });
  const readSpace = typeof spaceId === 'function' ? spaceId : () => null;
  const state = {
    available: false,
    sequences: [],
    enrollments: [],
    sends: [],
    capped: false,
    unavailable: [],
    stepsByKey: new Map(),
    selectedKey: '',
    confirming: null,
    busy: false,
    error: '',
    loaded: false,
    space: null,
    menuOpen: false,
    menuHint: '',
  };

  // One open menu at a time, Escape or an outside click closes it — the same
  // contract as the clienti add menu, scoped to this view's menu wrap.
  const isInsideMenuWrap = (node) => {
    let current = node ?? null;
    while (current) {
      const classes = typeof current.getAttribute === 'function'
        ? String(current.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
        : [];
      if (classes.includes('bo-seq-menuwrap')) return true;
      current = current.parentNode ?? null;
    }
    return false;
  };
  // Toggling the menu repaints the whole view, so the node that had keyboard
  // focus is gone after paint(): opening moves focus to the first menu entry,
  // closing returns it to the opener, and Tab continues from there. Only an
  // outside pointer click leaves focus where the user put it.
  function refocusMenu(intoMenu) {
    if (!mount || typeof mount.querySelector !== 'function') return;
    const target = mount.querySelector(
      intoMenu ? 'button[data-action="new-ai"]' : 'button[data-menu="nuova-sequenza"]',
    );
    if (target && typeof target.focus === 'function') target.focus();
  }
  if (documentNode && typeof documentNode.addEventListener === 'function') {
    documentNode.addEventListener('click', (event) => {
      if (state.menuOpen && !isInsideMenuWrap(event?.target ?? null)) {
        state.menuOpen = false;
        paint();
      }
    });
    // Fallback for focus that left the view (screen reader, devtools): the
    // button and menu listeners above stay reachable because refocusMenu
    // keeps focus on the opener or the first entry across repaints.
    documentNode.addEventListener('keydown', (event) => {
      if (event?.key === 'Escape' && state.menuOpen) {
        state.menuOpen = false;
        paint();
        refocusMenu(false);
      }
    });
  }

  /**
   * The prototype's `Nuova sequenza` menu: two entries, closed by default,
   * Escape or an outside click closes it. Creation itself belongs to the
   * pilot (manual → the package operations, AI → the assistant seam), so a
   * pick only names the next step in plain Italian — never a fake record.
   */
  function renderNewMenu() {
    const wrap = el(documentNode, 'div', 'bo-seq-menuwrap');
    // Green CTA like the prototype and like Calendario's «Nuovo appuntamento»:
    // only uiButton({ variant: 'cta' }) paints green.
    const button = uiButton(documentNode, {
      variant: 'cta',
      label: 'Nuova sequenza ⌄',
      attrs: {
        'data-menu': 'nuova-sequenza',
        'aria-haspopup': 'true',
        'aria-expanded': state.menuOpen ? 'true' : 'false',
      },
    });
    button.addEventListener('click', (event) => {
      event?.stopPropagation?.();
      state.menuOpen = !state.menuOpen;
      state.menuHint = '';
      paint();
      refocusMenu(state.menuOpen);
    });
    button.addEventListener('keydown', (event) => {
      if (event?.key === 'Escape' && state.menuOpen) {
        state.menuOpen = false;
        paint();
        refocusMenu(false);
      }
    });
    wrap.appendChild(button);
    const menu = el(documentNode, 'div', state.menuOpen ? 'bo-seq-menu ui-add-menu' : 'bo-seq-menu ui-add-menu hidden');
    menu.setAttribute('role', 'menu');
    const addItem = (action, label, hint, pick) => {
      const item = uiAddOption(documentNode, { kind: action === 'new-ai' ? 'ai' : 'manual', title: label, line: hint,
        attrs: { 'data-action': action } });
      item.addEventListener('click', () => {
        state.menuOpen = false;
        state.menuHint = pick;
        paint();
        refocusMenu(false);
      });
      menu.appendChild(item);
    };
    menu.addEventListener('keydown', (event) => {
      if (event?.key === 'Escape') {
        state.menuOpen = false;
        state.menuHint = '';
        paint();
        refocusMenu(false);
      }
    });
    menu.addEventListener('click', (event) => {
      event?.stopPropagation?.();
    });
    addItem(
      'new-ai',
      "Crea con l'AI",
      'Es. «lead dal sito: WhatsApp subito, email dopo 2 giorni»',
      'Descrivi la sequenza nella barra AI (✦ in alto): parte da sola quando succede qualcosa.',
    );
    addItem(
      'new-manual',
      'Compila manualmente',
      'Quando parte, passi e canali',
      'La nuova sequenza si crea dallo spazio con un nome, un trigger e i passi: la vedi qui appena è pronta.',
    );
    wrap.appendChild(menu);
    if (state.menuHint !== '') {
      wrap.appendChild(el(documentNode, 'p', 'bo-seq-hint', state.menuHint));
    }
    return wrap;
  }

  function paint() {
    if (!documentNode) return;
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    // Supervisor design pass: the prototype's 1240 px page, header, then the
    // list on the left and the selected sequence on the right.
    const page = el(documentNode, 'div', 'bo-seq');
    mount.appendChild(page);
    const top = el(documentNode, 'div', 'bo-seq-top');
    top.appendChild(el(documentNode, 'p', 'bo-kicker', 'MODULO NATIVO'));
    top.appendChild(el(documentNode, 'h2', 'bo-seq-title', 'Sequenze'));
    top.appendChild(el(documentNode, 'p', 'lede',
      'Follow-up che partono da soli quando succede qualcosa, sul canale giusto. Si fermano appena il cliente risponde.'));
    top.appendChild(renderNewMenu());
    page.appendChild(top);
    if (!state.loaded) {
      page.appendChild(el(documentNode, 'p', 'bo-muted', 'Leggo le sequenze…'));
      return;
    }
    if (!state.available) {
      page.appendChild(el(documentNode, 'p', 'bo-muted',
        'Le sequenze non sono composte in questo spazio: niente da mostrare, e niente di finto al loro posto.'));
      return;
    }
    const cols = el(documentNode, 'div', 'bo-seq-cols');
    const left = el(documentNode, 'div', 'bo-seq-left');
    const right = el(documentNode, 'div', 'bo-seq-right');
    cols.appendChild(left);
    cols.appendChild(right);
    page.appendChild(cols);
    left.appendChild(renderSequenzeElenco(
      documentNode, state.sequences, state.enrollments, state.sends,
      state.selectedKey, (key) => void selectSequence(key),
    ));
    if (state.capped) {
      right.appendChild(el(documentNode, 'p', 'bo-muted', `Mostro i primi ${SEQUENZE_READ_LIMIT} record per elenco.`));
    }
    if (state.unavailable.length > 0) {
      right.appendChild(el(documentNode, 'p', 'bo-seq-error',
        `Non riesco a leggere adesso: ${state.unavailable.join(', ')}. I numeri qui sotto contano solo quello che ho letto davvero.`));
    }
    if (state.error !== '') {
      right.appendChild(el(documentNode, 'p', 'bo-seq-error', state.error));
    }
    if (state.selectedKey !== '') {
      const sequence = state.sequences.find(
        (row) => row?.sourceKey === state.selectedKey || (row?.id !== undefined && row?.id !== null && String(row.id) === state.selectedKey),
      ) ?? null;
      if (sequence === null) {
        right.appendChild(el(documentNode, 'p', 'bo-muted', 'Questa sequenza non c’è più: scegline un’altra dall’elenco.'));
      } else {
        const outcome = state.stepsByKey.get(state.selectedKey) ?? { rows: [], failed: false };
        const detail = buildSequenzaDettaglio({
          sequence,
          steps: outcome.rows,
          stepsFailed: outcome.failed,
          enrollments: state.enrollments.filter((row) => row?.sequenceSourceKey === sequence?.sourceKey),
          sends: state.sends.filter((row) => row?.sequenceSourceKey === sequence?.sourceKey),
        });
        right.appendChild(renderSequenzaDettaglio(
          documentNode, detail, state.confirming,
          (action) => { state.confirming = action; state.error = ''; paint(); },
          () => { state.confirming = null; paint(); },
          (action) => void runSequenceAction(sequence, action),
          state.busy,
        ));
      }
    } else if (state.sequences.length > 0) {
      right.appendChild(el(documentNode, 'p', 'bo-muted', 'Scegli una sequenza per vedere i passi, giorno per giorno.'));
    }
  }

  async function selectSequence(key) {
    state.selectedKey = key;
    state.confirming = null;
    state.error = '';
    paint();
    if (key !== '' && !state.stepsByKey.has(key)) {
      const outcome = await loadSequenzaSteps(client, key, state.space);
      if (state.selectedKey === key) {
        state.stepsByKey.set(key, outcome);
        paint();
      }
    }
  }

  async function runSequenceAction(sequence, action) {
    state.busy = true;
    state.error = '';
    paint();
    try {
      const id = sequence?.id;
      if (id === undefined || id === null || String(id) === '') {
        throw new Error('Questa sequenza non ha un id stabile: ricarica e riprova.');
      }
      await bound.request(
        `/api/modules/sequence/records/${encodeURIComponent(String(id))}/actions/${encodeURIComponent(action)}`,
        { method: 'POST', body: {} },
      );
      state.confirming = null;
      await renderSequenze();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      const changed = /409|INVALID_STATE|not allowed from state/i.test(message);
      state.error = changed
        ? 'Lo stato è cambiato mentre decidevi: ho ricaricato, rileggi prima di agire.'
        : (message !== '' ? message : 'Il server ha rifiutato la richiesta.');
      state.confirming = null;
      state.busy = false;
      if (changed) {
        await renderSequenze();
        return;
      }
      paint();
    }
  }

  async function renderSequenze() {
    state.busy = false;
    if (!documentNode) return;
    paint();
    const space = readSpace();
    if (space !== state.space) {
      state.space = space;
      state.selectedKey = '';
      state.confirming = null;
      state.stepsByKey = new Map();
    }
    const data = await loadSequenzeData(client, state.space);
    state.available = data.sequencesAvailable;
    state.sequences = data.sequences;
    state.enrollments = data.enrollments;
    state.sends = data.sends;
    state.capped = data.capped;
    state.unavailable = data.unavailable;
    state.loaded = true;
    if (state.selectedKey !== '' && state.available) {
      const outcome = await loadSequenzaSteps(client, state.selectedKey, state.space);
      state.stepsByKey.set(state.selectedKey, outcome);
    }
    paint();
  }

  return { renderSequenze, paint, state };
}
