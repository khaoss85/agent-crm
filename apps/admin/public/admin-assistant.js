// @ts-check

// BO-F0-04 — Backoffice AI assistant: the "Chiedi o fai qualcosa" (⌘K) side
// panel. The topbar bar stays an entry (admin-shell.js); this module is the
// assistant behind it: deterministic per-screen suggestions, answers that
// cite clickable sources pointing at real records, linked actions that
// execute really, and dry-run gating for free questions.
//
// Conventions follow apps/admin/public/admin-shell.js: the model builders
// are pure and DOM-free (unit-tested under node:test without a browser) and
// the renderer uses DOM APIs only — createElement + textContent/setAttribute
// — never innerHTML with data, so hostile record strings are inert text,
// never markup.
//
// What it reuses, never duplicates (MEM_ACC_REUSE):
// - reads: the generic /api/modules/:module/records surface over the native
//   record modules of packages/interactions (conversation, interaction-call,
//   interaction-message), packages/intelligence (behavioral-signal) and
//   packages/llm (llm-call-audit), plus /api/opportunities;
// - writes: the same module action surface the handwritten views use
//   (mark-read, close — both input-free, actor-derived, internal
//   bookkeeping), and hash navigation for filtering/opening records;
// - money: formatMinorUnits from admin-core.js — amounts stay integer cents.
// Outbound sends to external channels stay in the channels outbox flow (no
// new send path is invented here): contacting a customer from the panel is a
// navigation into the thread and always needs an explicit per-action
// confirmation first.

import { formatMinorUnits } from './admin-core.js';
import { issueAdminKey } from './admin-submission.js';

/** Probe path for the future assistant backend (status + free-question ask). */
export const ASSISTANT_STATUS_PATH = '/api/assistant/status';

/**
 * The only free-question contract: questions POST exactly here. The probe and
 * the question path both check this constant — a status payload must never
 * steer the question POST at another backend route.
 */
const ASSISTANT_ASK_PATH = '/api/assistant/ask';

/**
 * Italian notice shown when free questions are unavailable: the panel stays
 * usable, only the free-question box is off, and the message says the
 * questions arrive with the key.
 */
export const FREE_QUESTION_DISABLED_NOTICE = 'Le domande libere arrivano con la chiave: finché la chiave OpenAI non è configurata, il pannello resta utilizzabile con i suggerimenti qui sotto, che leggono dati reali.';

/** Free-question box limits: one line of intent, never a pasted document. */
export const FREE_QUESTION_MAX_LENGTH = 500;

/** How many rows a suggestion reads at most, and how many sources it cites. */
export const SUGGESTION_READ_LIMIT = 50;
export const SUGGESTION_MAX_SOURCES = 4;
export const SUGGESTION_MAX_LISTED = 3;

/** Record ids travel in sources; the shape mirrors packages/llm. */
const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const MODULE_RE = /^[a-z][a-z0-9-]*$/;

/** @param {unknown} value */
export function isSafeRecordId(value) {
  return typeof value === 'string' && RECORD_ID_RE.test(value);
}

/** @param {unknown} value */
function isSafeModule(value) {
  return typeof value === 'string' && MODULE_RE.test(value);
}

/**
 * @param {unknown} text
 * @param {number} max
 */
function shortText(text, max = 80) {
  const str = text === null || text === undefined ? '' : String(text);
  const clean = str.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().replace(/\s+/g, ' ');
  if (clean === '') return '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Deterministic suggestion catalog: every backoffice screen offers different
 * suggestions. Unknown screens fall back to the generic pair, never to an
 * empty panel.
 * @typedef {{ id: string, title: string, detail: string }} Suggestion
 * @type {Record<string, ReadonlyArray<Suggestion>>}
 */
/**
 * Capped reads headline page bounds, never totals: reaching the cap means the
 * server may hold more rows than the page shows (pipeline board honest-bounds
 * rule, admin-pipeline.js BOARD_LIMIT). OPPORTUNITY_SERVER_DEFAULT_LIMIT is
 * the /api/opportunities default when no limit is sent
 * (opportunity-service.js:229).
 */
const CALL_READ_LIMIT = 100;
const SIGNAL_READ_LIMIT = 100;
const OPPORTUNITY_SERVER_DEFAULT_LIMIT = 100;

export const SUGGESTION_CATALOG = Object.freeze({
  oggi: Object.freeze([
    { id: 'bo04:oggi:urgenti', title: 'Cosa è più urgente oggi?', detail: 'Thread aperti e problemi di qualità, dai record reali.' },
    { id: 'bo04:oggi:chiamate', title: 'Com’è andato il telefono?', detail: 'Esiti delle chiamate registrate.' },
  ]),
  clienti: Object.freeze([
    { id: 'bo04:clienti:ricontattare', title: 'Chi devo ricontattare?', detail: 'Thread aperti con il messaggio più recente in cima.' },
    { id: 'bo04:clienti:segnali', title: 'Quali lead mostrano segnali caldi?', detail: 'Segnali comportamentali raggruppati per lead.' },
  ]),
  pipeline: Object.freeze([
    { id: 'bo04:pipeline:chiusura', title: 'Quanto posso chiudere questo mese?', detail: 'Opportunità aperte per fase, con importi.' },
  ]),
  calendario: Object.freeze([
    { id: 'bo04:calendario:slot', title: 'Trova 45 minuti con Marco e Sara', detail: 'Appuntamenti già fissati e prossimi passi onesti.' },
  ]),
  sequenze: Object.freeze([
    { id: 'bo04:sequenze:lead-sito', title: 'Crea una sequenza per i lead del sito', detail: 'Ultimi messaggi dal form del sito, pronti da lavorare.' },
  ]),
  reporting: Object.freeze([
    { id: 'bo04:reporting:call', title: 'Chi ha gestito più call questo mese?', detail: 'Chiamate registrate per operatore ed esito.' },
  ]),
  'nuovo-modulo': Object.freeze([
    { id: 'bo05:nuovo-modulo:crea-ai', title: 'Come creo un modulo con l’AI?', detail: 'Il percorso guidato: descrizione, manifest, comandi veri.' },
  ]),
  impostazioni: Object.freeze([
    { id: 'bo04:impostazioni:ai-puo', title: 'Cosa può fare l’AI senza chiedermi?', detail: 'Cosa fa da sola, cosa chiede, cosa dicono i registri.' },
  ]),
});

/** Generic fallback for screens outside the backoffice prototype. */
const FALLBACK_SUGGESTIONS = Object.freeze([
  { id: 'bo04:oggi:urgenti', title: 'Cosa è più urgente oggi?', detail: 'Thread aperti e problemi di qualità, dai record reali.' },
  { id: 'bo04:impostazioni:ai-puo', title: 'Cosa può fare l’AI senza chiedermi?', detail: 'Cosa fa da sola, cosa chiede, cosa dicono i registri.' },
]);

/**
 * The suggestions for one screen. Different screens get different
 * suggestions; unknown screens get the generic pair, never nothing.
 * @param {unknown} screenId
 * @returns {ReadonlyArray<Suggestion>}
 */
export function suggestionsFor(screenId) {
  if (typeof screenId === 'string' && Object.hasOwn(SUGGESTION_CATALOG, screenId)) {
    return SUGGESTION_CATALOG[screenId];
  }
  return FALLBACK_SUGGESTIONS;
}

/**
 * @typedef {{ kind: 'record', module: string, id: string, label: string, href: string }} Source
 * @typedef {{ id: string, label: string, kind: 'navigate' | 'api', href?: string, request?: { path: string, method: string, body?: unknown }, customerFacing: boolean, confirmLabel?: string }} AssistantAction
 * @typedef {{ suggestionId: string, title: string, lines: string[], sources: Source[], actions: AssistantAction[], unavailable: string[] }} Answer
 */

/**
 * @param {string} module
 * @param {unknown} id
 * @param {unknown} label
 */
function recordSource(module, id, label) {
  if (!isSafeModule(module) || !isSafeRecordId(id)) return null;
  const text = shortText(label, 80) || id;
  return {
    kind: 'record',
    module,
    id,
    label: text,
    href: `#/modules/${module}/${encodeURIComponent(id)}`,
  };
}

/**
 * A customer subject resolving to the customer card when the envelope names
 * a record, else to the module detail of the conversation itself.
 * @param {{ subjectResource?: unknown, subjectId?: unknown, subjectLabel?: unknown }} row
 * @param {unknown} fallbackId
 */
function subjectHref(row, fallbackId) {
  const resource = row?.subjectResource;
  const subjectId = row?.subjectId;
  if (isSafeModule(resource) && isSafeRecordId(subjectId)) {
    return `#/customer-card/${resource}/${encodeURIComponent(/** @type {string} */ (subjectId))}`;
  }
  if (isSafeRecordId(fallbackId)) {
    return `#/modules/conversation/${encodeURIComponent(/** @type {string} */ (fallbackId))}`;
  }
  return null;
}

/** @param {unknown} row */
function conversationLabel(row) {
  return shortText(row?.subjectLabel, 80)
    || shortText(row?.remoteHandle, 80)
    || shortText(row?.id, 80);
}

/**
 * Read one module list best-effort: rows when the module is composed and the
 * read succeeds, null when it is not — an unavailable section names itself
 * instead of failing the whole answer.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {string} module
 * @param {number} limit
 */
async function readRecords(client, module, limit = SUGGESTION_READ_LIMIT) {
  try {
    const body = await client.request(`/api/modules/${module}/records?limit=${limit}`);
    if (!body || !Array.isArray(body.items)) return null;
    return body.items.filter((row) => row !== null && typeof row === 'object');
  } catch {
    return null;
  }
}

/**
 * @param {Array<any>} rows
 * @param {string} module
 * @param {(row: any) => unknown} labelOf
 * @param {number} max
 */
function takeSources(rows, module, labelOf, max = SUGGESTION_MAX_SOURCES) {
  /** @type {Source[]} */
  const sources = [];
  for (const row of rows) {
    if (sources.length >= max) break;
    const source = recordSource(module, row?.id, labelOf(row));
    if (source !== null) sources.push(source);
  }
  return sources;
}

/** @param {unknown} value */
function rowTime(value) {
  if (typeof value !== 'string' || value === '') return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** @param {Array<any>} rows newest first by updatedAt, openedAt, then observedAt (signals). */
function newestFirst(rows) {
  return rows.slice().sort((a, b) => {
    const at = Math.max(rowTime(a?.updatedAt), rowTime(a?.openedAt), rowTime(a?.observedAt));
    const bt = Math.max(rowTime(b?.updatedAt), rowTime(b?.openedAt), rowTime(b?.observedAt));
    return bt - at;
  });
}

/**
 * @param {string} suggestionId
 * @param {string} title
 */
function emptyAnswer(suggestionId, title) {
  return {
    suggestionId, title, lines: [], sources: [], actions: [], unavailable: [],
  };
}

/** Urgenti oggi: thread aperti + problemi di qualità aperti, dai record reali. */
async function answerUrgenti(client) {
  const answer = emptyAnswer('bo04:oggi:urgenti', 'Cosa è più urgente oggi?');
  const [conversations, issues] = await Promise.all([
    readRecords(client, 'conversation'),
    readRecords(client, 'data-quality-issue'),
  ]);
  if (conversations === null) {
    answer.unavailable.push('Thread: modulo conversation non leggibile in questo spazio.');
  } else {
    const open = conversations.filter((row) => row?.status === 'open');
    answer.lines.push(`${open.length} thread aperti${conversations.length !== open.length ? ` su ${conversations.length} letti` : ''}.`);
    for (const row of newestFirst(open).slice(0, SUGGESTION_MAX_LISTED)) {
      answer.lines.push(`• ${conversationLabel(row)}${row?.channel ? ` (${shortText(row.channel, 20)})` : ''}`);
    }
    answer.sources.push(...takeSources(newestFirst(open), 'conversation', conversationLabel));
  }
  if (issues === null) {
    answer.unavailable.push('Qualità dati: modulo data-quality-issue non leggibile in questo spazio.');
  } else {
    const open = issues.filter((row) => row?.status === 'open');
    answer.lines.push(`${open.length} problemi di qualità aperti.`);
    answer.sources.push(...takeSources(open, 'data-quality-issue', (row) => row?.title ?? row?.code ?? row?.id));
  }
  answer.actions.push({ id: 'bo04:apri-clienti', label: 'Apri Clienti', kind: 'navigate', href: '#/customer-data', customerFacing: false });
  const first = answer.sources[0];
  if (first) {
    answer.actions.push({ id: 'bo04:apri-primo', label: `Apri: ${first.label}`, kind: 'navigate', href: first.href, customerFacing: false });
  }
  return answer;
}

/** Telefono: esiti delle chiamate registrate in interaction-call. */
async function answerChiamate(client) {
  const answer = emptyAnswer('bo04:oggi:chiamate', 'Com’è andato il telefono?');
  const calls = await readRecords(client, 'interaction-call', CALL_READ_LIMIT);
  if (calls === null) {
    answer.unavailable.push('Chiamate: modulo interaction-call non leggibile in questo spazio.');
    return answer;
  }
  /** @type {Map<string, number>} */
  const byOutcome = new Map();
  for (const row of calls) {
    const outcome = typeof row?.outcome === 'string' && row.outcome !== '' ? row.outcome : 'sconosciuto';
    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
  }
  // Honest bounds: at the read cap the page may hide more rows — the
  // headline says which page it counts, never a total.
  const capped = calls.length >= CALL_READ_LIMIT;
  answer.lines.push(`${calls.length} chiamate registrate${capped ? ` (prime ${calls.length} lette)` : ''}.`);
  for (const [outcome, count] of [...byOutcome.entries()].sort((a, b) => b[1] - a[1]).slice(0, SUGGESTION_MAX_LISTED)) {
    answer.lines.push(`• ${outcome}: ${count}`);
  }
  const labelOf = (row) => `${shortText(row?.outcome, 20) || 'chiamata'} ${shortText(row?.remoteHandle, 40) || shortText(row?.id, 24)}`.trim();
  answer.sources.push(...takeSources(newestFirst(calls), 'interaction-call', labelOf));
  const first = answer.sources[0];
  if (first) {
    answer.actions.push({ id: 'bo04:apri-primo', label: `Apri: ${first.label}`, kind: 'navigate', href: first.href, customerFacing: false });
  }
  return answer;
}

/** Da ricontattare: thread aperti, messaggio più recente in cima. */
async function answerRicontattare(client) {
  const answer = emptyAnswer('bo04:clienti:ricontattare', 'Chi devo ricontattare?');
  const conversations = await readRecords(client, 'conversation');
  if (conversations === null) {
    answer.unavailable.push('Thread: modulo conversation non leggibile in questo spazio.');
    return answer;
  }
  // The headline counts every open thread on the read page; only the
  // listed lines and cited sources are sliced to the newest few.
  const openAll = newestFirst(conversations.filter((row) => row?.status === 'open'));
  const open = openAll.slice(0, 5);
  if (openAll.length === 0) {
    answer.lines.push('Nessun thread aperto: niente da ricontattare.');
    return answer;
  }
  answer.lines.push(`${openAll.length} thread aperti da ricontattare${conversations.length !== openAll.length ? ` (tra ${conversations.length} letti)` : ''}:`);
  for (const row of open.slice(0, SUGGESTION_MAX_LISTED)) {
    answer.lines.push(`• ${conversationLabel(row)}${row?.channel ? ` (${shortText(row.channel, 20)})` : ''}`);
  }
  answer.sources.push(...takeSources(open, 'conversation', conversationLabel));
  const first = open[0];
  const cardHref = subjectHref(first, first?.id);
  if (cardHref !== null) {
    answer.actions.push({ id: 'bo04:apri-scheda', label: 'Apri scheda cliente', kind: 'navigate', href: cardHref, customerFacing: false });
  }
  if (isSafeRecordId(first?.id)) {
    const conversationId = /** @type {string} */ (first.id);
    answer.actions.push({
      id: `bo04:segna-letta:${conversationId}`,
      label: 'Segna come letta',
      kind: 'api',
      request: { path: `/api/modules/conversation/records/${encodeURIComponent(conversationId)}/actions/mark-read`, method: 'POST', body: {} },
      customerFacing: false,
    });
    if (first?.status === 'open') {
      // Irreversible (CONVERSATION_TRANSITIONS has no reopen): single click
      // must never close a thread. customerFacing routes it through the
      // two-step confirmation gate, and the effect gate in
      // actionNeedsConfirmation covers close even with the flag off; the
      // label names the thread so the operator confirms exactly what closes.
      answer.actions.push({
        id: `bo04:chiudi:${conversationId}`,
        label: `Chiudi il thread di ${conversationLabel(first)}`,
        kind: 'api',
        request: { path: `/api/modules/conversation/records/${encodeURIComponent(conversationId)}/actions/close`, method: 'POST', body: {} },
        customerFacing: true,
        confirmLabel: `Chiudere il thread di ${conversationLabel(first)}? Non si può riaprire: i nuovi messaggi aprono un altro thread.`,
      });
    }
    answer.actions.push({
      id: `bo04:contatta:${conversationId}`,
      label: 'Contatta il cliente',
      kind: 'navigate',
      href: `#/modules/conversation/${encodeURIComponent(conversationId)}`,
      customerFacing: true,
      confirmLabel: `Aprire il thread con ${conversationLabel(first)} per contattare il cliente?`,
    });
  }
  return answer;
}

/** Segnali caldi: behavioral-signal di packages/intelligence, per lead. */
async function answerSegnali(client) {
  const answer = emptyAnswer('bo04:clienti:segnali', 'Quali lead mostrano segnali caldi?');
  const signals = await readRecords(client, 'behavioral-signal', SIGNAL_READ_LIMIT);
  if (signals === null) {
    answer.unavailable.push('Segnali: modulo behavioral-signal non leggibile in questo spazio.');
    return answer;
  }
  /** @type {Map<string, Array<any>>} */
  const byLead = new Map();
  for (const row of signals) {
    if (typeof row?.leadId !== 'string' || row.leadId === '') continue;
    const list = byLead.get(row.leadId) ?? [];
    list.push(row);
    byLead.set(row.leadId, list);
  }
  const ranked = [...byLead.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, SUGGESTION_MAX_LISTED);
  if (ranked.length === 0) {
    answer.lines.push('Nessun segnale registrato sui lead.');
    return answer;
  }
  // Honest bounds: at the read cap the page may hide more rows — the
  // headline says which page it counts, never a total.
  const capped = signals.length >= SIGNAL_READ_LIMIT;
  answer.lines.push(`${signals.length} segnali su ${byLead.size} lead${capped ? ` (prime ${signals.length} lette)` : ''}:`);
  const sourceRows = [];
  for (const [leadId, list] of ranked) {
    const latest = newestFirst(list)[0];
    answer.lines.push(`• ${shortText(leadId, 40)}: ${list.length} segnali (ultimo: ${shortText(latest?.signalType, 30) || '?'})`);
    sourceRows.push(latest);
  }
  answer.sources.push(...takeSources(sourceRows, 'behavioral-signal', (row) => `${shortText(row?.signalType, 30)} su ${shortText(row?.leadId, 40)}`));
  const first = answer.sources[0];
  if (first) {
    answer.actions.push({ id: 'bo04:apri-primo', label: `Apri: ${first.label}`, kind: 'navigate', href: first.href, customerFacing: false });
  }
  return answer;
}

/**
 * The pipeline board definition behind opportunity records
 * (`#/pipelines/<name>`, admin-pipeline.js): name plus stage keys, labels
 * and types. Records render there, never on the generated-module detail
 * route — core modules are not served by the generic records surface
 * (admin-modules.js resolves schema.generatedModules only, so
 * `#/modules/opportunity/<id>` lands on 'Module not found').
 * Null when no board covers opportunities, or when the schema entry carries
 * no usable stage definition: then answers fall back to the legacy stage,
 * never to an invented grouping.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @returns {Promise<{ name: string, stages: Array<{ key: string, label?: string, type?: string }> } | null>}
 */
async function opportunityBoard(client) {
  try {
    const schema = await client.request('/api/schema');
    const pipeline = Array.isArray(schema?.pipelines)
      ? schema.pipelines.find((entry) => entry !== null && typeof entry === 'object'
        && entry.module === 'opportunity'
        && typeof entry.name === 'string' && /^[a-z][a-z0-9-]*$/.test(entry.name))
      : undefined;
    if (!pipeline || !Array.isArray(pipeline.stages)) return null;
    return pipeline;
  } catch {
    return null;
  }
}

/**
 * Open pipeline only: terminal stages (won/lost) and server-closed rows
 * (closedAt) are never counted as closable this month — the copy promises
 * the open pipeline, not the archive.
 * @param {any} row
 */
function isOpenPipeline(row) {
  if (row?.stage === 'won' || row?.stage === 'lost') return false;
  return row?.closedAt === null || row?.closedAt === undefined;
}

/**
 * Legacy stage of a row no board covers: the stored stage, then status.
 * @param {any} row
 */
function legacyStageOf(row) {
  return typeof row?.stage === 'string' && row.stage !== '' ? row.stage
    : typeof row?.status === 'string' && row.status !== '' ? row.status : 'senza fase';
}

/**
 * @param {any} row
 * @param {Map<string, number>} stageCount
 * @param {Map<string, { stage: string, currency: string, cents: number }>} stageTotals
 * @param {(row: any) => string} stageOf
 */
function accumulateStage(row, stageCount, stageTotals, stageOf) {
  const stage = stageOf(row);
  stageCount.set(stage, (stageCount.get(stage) ?? 0) + 1);
  if (Number.isSafeInteger(row?.valueCents)) {
    const currency = typeof row?.currency === 'string' ? row.currency : '';
    const key = JSON.stringify([stage, currency]);
    const total = stageTotals.get(key) ?? { stage, currency, cents: 0 };
    if (Number.isSafeInteger(total.cents + /** @type {number} */ (row.valueCents))) {
      total.cents += /** @type {number} */ (row.valueCents);
      stageTotals.set(key, total);
    }
  }
}

/**
 * @param {{ lines: string[] }} answer
 * @param {Map<string, number>} stageCount
 * @param {Map<string, { stage: string, currency: string, cents: number }>} stageTotals
 * @param {Map<string, string>} [stageLabels]
 */
function pushStageLines(answer, stageCount, stageTotals, stageLabels = new Map()) {
  const topStages = [...stageCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, SUGGESTION_MAX_LISTED);
  for (const [stage, count] of topStages) {
    const shown = stageLabels.get(stage) ?? stage;
    answer.lines.push(`• ${shortText(shown, 30)}: ${count}`);
    for (const total of [...stageTotals.values()]
      .filter((entry) => entry.stage === stage)
      .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0))) {
      answer.lines.push(`• ${shortText(shown, 30)} — totale ${formatMinorUnits(total.cents, total.currency)}`);
    }
  }
}

/** Chiusura mese: opportunità aperte per fase, importi in centesimi interi. */
async function answerChiusura(client) {
  const answer = emptyAnswer('bo04:pipeline:chiusura', 'Quanto posso chiudere questo mese?');
  /** @type {any} */
  let body = null;
  try {
    body = await client.request('/api/opportunities');
  } catch {
    body = null;
  }
  const items = body !== null && Array.isArray(body?.items)
    ? body.items.filter((row) => row !== null && typeof row === 'object')
    : null;
  if (items === null) {
    answer.unavailable.push('Opportunità: elenco non leggibile in questo spazio.');
    return answer;
  }
  const labelOf = (row) => shortText(row?.name ?? row?.companyName ?? row?.title, 60) || shortText(row?.id, 24);
  // Honest bounds: /api/opportunities without a limit serves the server
  // default page (OPPORTUNITY_SERVER_DEFAULT_LIMIT) — at the cap the headline
  // says which page it counts, never a total.
  const capped = items.length >= OPPORTUNITY_SERVER_DEFAULT_LIMIT;
  const pageNote = capped ? ` (prime ${OPPORTUNITY_SERVER_DEFAULT_LIMIT} lette)` : '';
  const board = await opportunityBoard(client);
  if (board === null) {
    // No board covers opportunities in this space: legacy stage grouping,
    // records named as text, never a link to a board that does not exist.
    const open = items.filter(isOpenPipeline);
    /** @type {Map<string, number>} */
    const stageCount = new Map();
    /** @type {Map<string, { stage: string, currency: string, cents: number }>} */
    const stageTotals = new Map();
    for (const row of open) accumulateStage(row, stageCount, stageTotals, legacyStageOf);
    answer.lines.push(open.length === 1
      ? `1 opportunità aperta in pipeline${items.length !== 1 ? ` su ${items.length} lette` : ''}${pageNote}.`
      : `${open.length} opportunità aperte in pipeline${items.length !== open.length ? ` su ${items.length} lette` : ''}${pageNote}.`);
    pushStageLines(answer, stageCount, stageTotals);
    for (const row of open.slice(0, SUGGESTION_MAX_LISTED)) {
      answer.lines.push(`• ${labelOf(row) || shortText(row?.id, 24)}`);
    }
    return answer;
  }
  // Board-aware scope, like admin-pipeline.js renderAll: only rows placed on
  // this pipeline (pipelineKey match) group by pipelineStage; open vs
  // terminal comes from the pipeline definition stage types (won/lost), plus
  // server-closed rows (closedAt). Rows no board covers keep the legacy
  // stage, are named as text, and are never linked to a board that hides
  // them; rows with a stage outside the definition are disclosed, never
  // misclassified into a column.
  const boardHref = `#/pipelines/${board.name}`;
  const stageType = new Map(board.stages
    .filter((stage) => stage !== null && typeof stage === 'object' && typeof stage.key === 'string')
    .map((stage) => [stage.key, stage.type]));
  const stageKeys = new Set(stageType.keys());
  const stageLabels = new Map(board.stages
    .filter((stage) => stage !== null && typeof stage === 'object'
      && typeof stage.key === 'string' && typeof stage.label === 'string')
    .map((stage) => [stage.key, stage.label]));
  const isTerminalKey = (key) => stageType.get(key) === 'won' || stageType.get(key) === 'lost';
  const onBoard = items.filter((row) => row?.pipelineKey === board.name);
  const offBoard = items.filter((row) => row?.pipelineKey !== board.name);
  const openPlaced = onBoard.filter((row) => stageKeys.has(row?.pipelineStage)
    && !isTerminalKey(row?.pipelineStage)
    && (row?.closedAt === null || row?.closedAt === undefined));
  const drift = onBoard.filter((row) => !stageKeys.has(row?.pipelineStage));
  const offOpen = offBoard.filter(isOpenPipeline);
  /** @type {Map<string, number>} */
  const stageCount = new Map();
  /** @type {Map<string, { stage: string, currency: string, cents: number }>} */
  const stageTotals = new Map();
  // Counts per pipelineStage; money per (stage, currency) — currencies are
  // never summed together, one formatMinorUnits line per currency like the
  // pipeline board (admin-pipeline.js renderColumn).
  for (const row of openPlaced) {
    accumulateStage(row, stageCount, stageTotals, (candidate) => candidate?.pipelineStage);
  }
  answer.lines.push(openPlaced.length === 1
    ? `1 opportunità aperta in pipeline ${board.name}${items.length !== 1 ? ` su ${items.length} lette` : ''}${pageNote}.`
    : `${openPlaced.length} opportunità aperte in pipeline ${board.name}${items.length !== openPlaced.length ? ` su ${items.length} lette` : ''}${pageNote}.`);
  pushStageLines(answer, stageCount, stageTotals, stageLabels);
  if (drift.length > 0) {
    answer.lines.push(`${drift.length} con fase fuori definizione${capped ? ' tra le lette' : ''} (la board le mostra a parte, mai in colonna).`);
  }
  if (offOpen.length > 0) {
    /** @type {Map<string, number>} */
    const offCount = new Map();
    /** @type {Map<string, { stage: string, currency: string, cents: number }>} */
    const offTotals = new Map();
    for (const row of offOpen) accumulateStage(row, offCount, offTotals, legacyStageOf);
    answer.lines.push(`${offOpen.length} fuori pipeline ${board.name}${capped ? ' tra le lette' : ''} (la board non le mostra, senza link).`);
    pushStageLines(answer, offCount, offTotals);
    for (const row of offOpen.slice(0, SUGGESTION_MAX_LISTED)) {
      answer.lines.push(`• ${labelOf(row) || shortText(row?.id, 24)}`);
    }
  }
  for (const row of openPlaced) {
    if (answer.sources.length >= SUGGESTION_MAX_SOURCES) break;
    if (!isSafeRecordId(row?.id)) continue;
    const label = labelOf(row) || row.id;
    answer.sources.push({ kind: 'record', module: 'opportunity', id: row.id, label, href: boardHref });
  }
  const first = answer.sources[0];
  if (first) {
    answer.actions.push({ id: 'bo04:apri-primo', label: `Apri: ${first.label}`, kind: 'navigate', href: first.href, customerFacing: false });
  }
  return answer;
}

/** Slot: appuntamenti fissati; la proposta resta un passo dell’operatore. */
async function answerSlot(client) {
  const answer = emptyAnswer('bo04:calendario:slot', 'Trova 45 minuti con Marco e Sara');
  const appointments = await readRecords(client, 'appointment');
  if (appointments === null) {
    answer.unavailable.push('Appuntamenti: modulo appointment non leggibile in questo spazio.');
    answer.lines.push('Il pannello non sposta la calendarizzazione da solo: apri il thread e proponi gli slot al cliente.');
    return answer;
  }
  // Fissati means really fixed: booked plus confirmed (appointment module
  // status enum). Done is history, not a slot to propose; cancelled and
  // no-show are out; a missing status is never counted as booked.
  const booked = appointments.filter((row) => row?.status === 'booked' || row?.status === 'confirmed');
  answer.lines.push(`${booked.length} appuntamenti fissati letti. Il blocco da 45 minuti si propone al cliente nel thread, dopo conferma.`);
  const labelOf = (row) => `${shortText(row?.startsAt ?? row?.date, 24) || 'appuntamento'} ${shortText(row?.subjectLabel, 40) || ''}`.trim();
  answer.sources.push(...takeSources(newestFirst(booked), 'appointment', labelOf));
  const firstThread = answer.sources[0];
  if (firstThread) {
    answer.actions.push({ id: 'bo04:apri-primo', label: `Apri: ${firstThread.label}`, kind: 'navigate', href: firstThread.href, customerFacing: false });
  }
  return answer;
}

/** Lead del sito: ultimi messaggi inbound dal form, pronti da lavorare. */
async function answerLeadSito(client) {
  const answer = emptyAnswer('bo04:sequenze:lead-sito', 'Crea una sequenza per i lead del sito');
  const messages = await readRecords(client, 'interaction-message', 100);
  if (messages === null) {
    answer.unavailable.push('Messaggi: modulo interaction-message non leggibile in questo spazio.');
    return answer;
  }
  // The headline counts every inbound form message on the read page;
  // only the listed lines and cited sources are sliced to the newest few.
  const inboundAll = newestFirst(messages.filter(
    (row) => row?.direction === 'inbound' && row?.channel === 'website-form',
  ));
  const inbound = inboundAll.slice(0, 5);
  if (inboundAll.length === 0) {
    answer.lines.push('Nessun messaggio dal form del sito tra gli ultimi letti.');
    return answer;
  }
  answer.lines.push(`${inboundAll.length} messaggi dal form del sito${messages.length !== inboundAll.length ? ` (tra ${messages.length} letti)` : ''}:`);
  for (const row of inbound.slice(0, SUGGESTION_MAX_LISTED)) {
    answer.lines.push(`• ${shortText(row?.body, 60) || '(senza testo)'}`);
  }
  answer.sources.push(...takeSources(inbound, 'interaction-message', (row) => shortText(row?.body, 60) || shortText(row?.id, 24)));
  const first = inbound[0];
  if (isSafeRecordId(first?.conversationId)) {
    const conversationId = /** @type {string} */ (first.conversationId);
    answer.actions.push({
      id: `bo04:segna-letta:${conversationId}`,
      label: 'Segna come letta',
      kind: 'api',
      request: { path: `/api/modules/conversation/records/${encodeURIComponent(conversationId)}/actions/mark-read`, method: 'POST', body: {} },
      customerFacing: false,
    });
  }
  const firstSource = answer.sources[0];
  if (firstSource) {
    answer.actions.push({ id: 'bo04:apri-primo', label: `Apri: ${firstSource.label}`, kind: 'navigate', href: firstSource.href, customerFacing: false });
  }
  return answer;
}

/** Nuovo modulo con l'AI (BO-F5-01): il percorso guidato, mai una generazione simulata. */
function answerNuovoAi() {
  const answer = emptyAnswer('bo05:nuovo-modulo:crea-ai', 'Come creo un modulo con l’AI?');
  answer.lines.push('1. Descrivi il modulo nella schermata Nuovo modulo (nome, campi, tipi).');
  answer.lines.push('2. L’agente di coding redige il manifest dalla descrizione (docs/MODULE_MANIFEST.md).');
  answer.lines.push('3. L’agente esegue bundle create --apply: file veri in bundles/<nome>/<versione>/, mai nel kernel.');
  answer.lines.push('4. bundle verify avvia l’app vera con il bundle composto e serve un record: se non si avvia e non serve, il bundle non esiste.');
  answer.lines.push('5. bundle install lo registra; l’host lo compone con createAccordoApp({ bundles }).');
  answer.actions.push({ id: 'bo05:apri-nuovo-modulo', label: 'Apri: Nuovo modulo', kind: 'navigate', href: '#/nuovo-modulo', customerFacing: false });
  answer.actions.push({ id: 'bo05:apri-reporting', label: 'Apri: Reporting', kind: 'navigate', href: '#/reporting', customerFacing: false });
  return answer;
}

/** Reporting call: chiamate registrate per operatore ed esito. */
async function answerCallReport(client) {
  const answer = emptyAnswer('bo04:reporting:call', 'Chi ha gestito più call questo mese?');
  const calls = await readRecords(client, 'interaction-call', CALL_READ_LIMIT);
  if (calls === null) {
    answer.unavailable.push('Chiamate: modulo interaction-call non leggibile in questo spazio.');
    return answer;
  }
  /** @type {Map<string, { total: number, completed: number }>} */
  const byMember = new Map();
  for (const row of calls) {
    const member = typeof row?.teamAuthorId === 'string' && row.teamAuthorId !== '' ? row.teamAuthorId : 'non assegnata';
    const entry = byMember.get(member) ?? { total: 0, completed: 0 };
    entry.total += 1;
    if (row?.outcome === 'completed') entry.completed += 1;
    byMember.set(member, entry);
  }
  // Honest bounds: at the read cap the page may hide more rows — the
  // headline says which page it counts, never a total.
  const capped = calls.length >= CALL_READ_LIMIT;
  answer.lines.push(`${calls.length} chiamate registrate${capped ? ` (prime ${calls.length} lette)` : ''}.`);
  for (const [member, entry] of [...byMember.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, SUGGESTION_MAX_LISTED)) {
    answer.lines.push(`• ${shortText(member, 30)}: ${entry.total} (${entry.completed} completate)`);
  }
  const labelOf = (row) => `${shortText(row?.teamAuthorId, 24) || 'call'} ${shortText(row?.outcome, 20) || ''}`.trim();
  answer.sources.push(...takeSources(newestFirst(calls), 'interaction-call', labelOf));
  const first = answer.sources[0];
  if (first) {
    answer.actions.push({ id: 'bo04:apri-primo', label: `Apri: ${first.label}`, kind: 'navigate', href: first.href, customerFacing: false });
  }
  return answer;
}

/**
 * Cosa può fare l’AI: capability deterministiche + i registri reali di
 * packages/llm (llm-call-audit) come prova di cosa è stato fatto.
 */
async function answerAiPuo(client) {
  const answer = emptyAnswer('bo04:impostazioni:ai-puo', 'Cosa può fare l’AI senza chiedermi?');
  answer.lines.push('Da sola: leggere record, filtrare elenchi, segnare thread come letti.');
  answer.lines.push('Chiede conferma prima di: chiudere un thread, aprire un thread per contattare un cliente, e di ogni invio verso un cliente.');
  answer.lines.push('Le domande libere arrivano con la chiave (vedi sotto).');
  const audit = await readRecords(client, 'llm-call-audit', 20);
  if (audit === null) {
    answer.unavailable.push('Registri AI: modulo llm-call-audit non leggibile in questo spazio.');
    return answer;
  }
  const dry = audit.filter((row) => row?.dryRun === true).length;
  answer.lines.push(`Ultime ${audit.length} chiamate AI registrate: ${dry} dry-run, ${audit.length - dry} live.`);
  const labelOf = (row) => `${shortText(row?.purpose, 24) || 'chiamata'} ${shortText(row?.model, 30) || ''} ${row?.dryRun === true ? '(dry-run)' : '(live)'}`.trim();
  answer.sources.push(...takeSources(newestFirst(audit), 'llm-call-audit', labelOf, SUGGESTION_MAX_LISTED));
  return answer;
}

/**
 * Run one deterministic suggestion against the real API: every source id in
 * the answer was read from a record in this call, never invented.
 * @param {{ request: (path: string, options?: object) => Promise<any> }} client
 * @param {unknown} suggestionId
 * @returns {Promise<Answer>}
 */
export async function runSuggestion(client, suggestionId) {
  if (client === null || typeof client !== 'object' || typeof client.request !== 'function') {
    throw new Error('L’assistente ha bisogno del client API per leggere i record.');
  }
  switch (suggestionId) {
    case 'bo04:oggi:urgenti': return answerUrgenti(client);
    case 'bo04:oggi:chiamate': return answerChiamate(client);
    case 'bo04:clienti:ricontattare': return answerRicontattare(client);
    case 'bo04:clienti:segnali': return answerSegnali(client);
    case 'bo04:pipeline:chiusura': return answerChiusura(client);
    case 'bo04:calendario:slot': return answerSlot(client);
    case 'bo04:sequenze:lead-sito': return answerLeadSito(client);
    case 'bo04:reporting:call': return answerCallReport(client);
    case 'bo05:nuovo-modulo:crea-ai': return answerNuovoAi();
    case 'bo04:impostazioni:ai-puo': return answerAiPuo(client);
    default: throw new Error(`Suggerimento sconosciuto: ${shortText(suggestionId, 60) || '?'}`);
  }
}

/**
 * The assistant backend probe: live only when the server publishes the
 * assistant status with free questions enabled. Anything else — 404, a
 * disabled flag, a network failure — is dry-run: the panel stays usable and
 * only the free-question box is off, with the key message.
 * @param {{ request: (path: string) => Promise<any> }} client
 */
export async function probeAssistantBackend(client) {
  try {
    const status = await client.request(ASSISTANT_STATUS_PATH);
    // Exact contract only: the question POST goes to ASSISTANT_ASK_PATH and
    // nowhere else. A prefix allowlist would let a status payload steer the
    // question text (potentially PII) at a dot-segment sibling such as
    // '/api/assistant/../modules/.../actions/close', or at any other
    // '/api/assistant/*' suffix, query or fragment — all stay dry-run.
    if (status !== null && typeof status === 'object'
      && status.freeQuestions === 'enabled'
      && status.endpoint === ASSISTANT_ASK_PATH) {
      return { mode: 'live', freeQuestions: 'enabled', endpoint: status.endpoint, notice: '' };
    }
  } catch {
    // Absent backend (today): dry-run, never a failure.
  }
  return { mode: 'dry-run', freeQuestions: 'disabled', endpoint: null, notice: FREE_QUESTION_DISABLED_NOTICE };
}

/**
 * One free question. In dry-run the question is refused with the key message
 * before any request leaves the panel — zero requests, never a silent call.
 * @param {{ request: (path: string, options?: object) => Promise<any> }} client
 * @param {{ mode: string, endpoint?: string | null }} status
 * @param {unknown} question
 */
export async function askFreeQuestion(client, status, question) {
  const text = typeof question === 'string' ? question.trim().replace(/\s+/g, ' ') : '';
  if (text === '') throw new Error('Scrivi una domanda prima di inviarla.');
  if (text.length > FREE_QUESTION_MAX_LENGTH) {
    throw new Error(`La domanda è troppo lunga (massimo ${FREE_QUESTION_MAX_LENGTH} caratteri).`);
  }
  if (status?.mode !== 'live' || typeof status?.endpoint !== 'string') {
    return { ok: false, disabled: true, notice: FREE_QUESTION_DISABLED_NOTICE };
  }
  // Re-validate the contract here instead of trusting status.endpoint: a
  // direct caller passing { mode: 'live', endpoint: '/api/...' } must never
  // steer the question text at an arbitrary route. Anything off-contract is
  // dry-run, with zero requests.
  if (status.endpoint !== ASSISTANT_ASK_PATH) {
    return { ok: false, disabled: true, notice: FREE_QUESTION_DISABLED_NOTICE };
  }
  // One fresh submission-owned key per question: keys come from the Admin
  // submission controller (KEY_RE) so the real client gate accepts them, and
  // the full question text is never truncated into a colliding identity.
  const body = await client.request(status.endpoint, {
    method: 'POST',
    body: { question: text },
    idempotencyKey: issueAdminKey(),
  });
  const lines = Array.isArray(body?.lines) ? body.lines.map((line) => String(line)).filter((line) => line !== '') : [];
  /** @type {Source[]} */
  const sources = [];
  if (Array.isArray(body?.sources)) {
    for (const item of body.sources.slice(0, SUGGESTION_MAX_SOURCES)) {
      const source = recordSource(item?.module, item?.id, item?.label ?? item?.id);
      if (source !== null) sources.push(source);
    }
  }
  return {
    ok: true,
    disabled: false,
    answer: {
      suggestionId: 'bo04:domanda-libera',
      title: text,
      lines: lines.length > 0 ? lines : ['Risposta vuota dal backend: riprova.'],
      sources,
      actions: [],
      unavailable: [],
    },
  };
}

/**
 * Whether an action closes a conversation thread. Close is irreversible
 * (CONVERSATION_TRANSITIONS has no reopen), so it always needs confirmation
 * no matter what flag its builder set — the gate is per effect, never per
 * caller-supplied flag.
 * @param {AssistantAction} action
 */
function isCloseAction(action) {
  const path = action?.request?.path;
  if (action?.kind !== 'api' || typeof path !== 'string') return false;
  const match = /^\/api\/modules\/conversation\/records\/([^/]+)\/actions\/(mark-read|close)$/.exec(path);
  return match !== null && match[2] === 'close';
}

/**
 * Whether an action needs the two-step confirmation: every customer-facing
 * action, plus every close by effect even when a (forged or future) builder
 * left customerFacing false. Mark-read stays single-step: internal
 * bookkeeping, reversible, never customer-facing.
 * @param {AssistantAction} action
 */
function actionNeedsConfirmation(action) {
  return action?.customerFacing === true || isCloseAction(action);
}

/**
 * Execute one linked action for real. The confirmation gate is per action,
 * not per sweep: a gated action runs only when confirmedActionId
 * names exactly that action id. Without confirmation nothing is requested
 * and nothing navigates — the refusal carries the confirm label the panel
 * shows on the second step.
 * @param {{ request: (path: string, options?: object) => Promise<any> }} client
 * @param {AssistantAction} action
 * @param {{ navigate?: (href: string) => void, confirmedActionId?: string | null, idempotencyKey?: string }} options
 */
export async function runAssistantAction(client, action, options = {}) {
  const { navigate = () => {}, confirmedActionId = null, idempotencyKey = null } = options;
  if (action === null || typeof action !== 'object' || typeof action.id !== 'string' || action.id === '') {
    throw new Error('Azione dell’assistente non valida.');
  }
  if (action.kind !== 'navigate' && action.kind !== 'api') {
    throw new Error(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: tipo sconosciuto.`);
  }
  if (actionNeedsConfirmation(action) && confirmedActionId !== action.id) {
    return {
      ok: false,
      needsConfirmation: true,
      confirmLabel: typeof action.confirmLabel === 'string' && action.confirmLabel !== ''
        ? action.confirmLabel
        : `Confermi “${shortText(action.label, 60) || action.id}”? L’azione riguarda un cliente.`,
    };
  }
  if (action.kind === 'navigate') {
    if (typeof action.href !== 'string' || !action.href.startsWith('#/')) {
      throw new Error(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: destinazione non valida.`);
    }
    navigate(action.href);
    return { ok: true, needsConfirmation: false };
  }
  // Exact allowlist: the panel only builds the two input-free conversation
  // record actions (mark-read, close). Any other /api/ path — outbox sends,
  // destructive routes, future actions — is rejected before any request, so
  // even a confirmed action can never execute a send path: outbound sends
  // stay in the channels outbox flow.
  const request = action.request;
  const actionMatch = request !== null && typeof request === 'object' && typeof request.path === 'string'
    ? /^\/api\/modules\/conversation\/records\/([^/]+)\/actions\/(mark-read|close)$/.exec(request.path)
    : null;
  if (actionMatch === null) {
    throw new Error(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: richiesta non consentita.`);
  }
  let actionConversationId;
  try {
    actionConversationId = decodeURIComponent(actionMatch[1]);
  } catch {
    throw new Error(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: richiesta non consentita.`);
  }
  if (!isSafeRecordId(actionConversationId)) {
    throw new Error(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: richiesta non consentita.`);
  }
  if ((request.method ?? 'POST') !== 'POST') {
    throw new Error(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: richiesta non consentita.`);
  }
  if (request.body !== undefined
    && (request.body === null || typeof request.body !== 'object'
      || Array.isArray(request.body) || Object.keys(request.body).length !== 0)) {
    throw new Error(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: richiesta non consentita.`);
  }
  // Mutations run on the real Admin client only with a submission-owned key
  // (admin-submission.js KEY_RE): an explicit caller key is honored, the
  // default is issued here so the panel never hand-rolls 'assistant:*' keys
  // the real gate rejects.
  const key = typeof idempotencyKey === 'string' && idempotencyKey !== '' ? idempotencyKey : issueAdminKey();
  const result = await client.request(request.path, {
    method: request.method ?? 'POST',
    body: request.body ?? {},
    idempotencyKey: key,
  });
  return { ok: true, needsConfirmation: false, result };
}

/**
 * @param {any} doc
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The ⌘K side panel: suggestions for the current screen, answers with
 * clickable sources, linked actions with the confirmation gate, and the
 * free-question box (disabled with the key message in dry-run).
 * @param {{ doc: any, mount: any, client: any, navigate?: (href: string) => void, notify?: (message: string) => void }} options
 */
export function createAssistantPanel({ doc, mount, client, navigate = () => {}, notify = () => {} } = {}) {
  if (!doc || !mount || !client) throw new Error('Il pannello assistente richiede doc, mount e client.');
  const state = {
    open: false,
    screenId: 'oggi',
    status: null,
    answer: null,
    busy: false,
    pendingConfirmId: null,
    error: '',
  };

  function clearMount() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  function renderSources(answer) {
    if (!Array.isArray(answer.sources) || answer.sources.length === 0) return null;
    const wrap = el(doc, 'div', 'bo-assistant-sources');
    wrap.appendChild(el(doc, 'p', 'bo-assistant-heading', 'Fonti'));
    const list = el(doc, 'ul', 'bo-assistant-source-list');
    for (const source of answer.sources) {
      if (!source || typeof source.href !== 'string' || !source.href.startsWith('#/')) continue;
      const item = el(doc, 'li', 'bo-assistant-source');
      const link = el(doc, 'a', 'bo-assistant-source-link', shortText(source.label, 80) || source.id);
      link.setAttribute('href', source.href);
      link.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        navigate(source.href);
      });
      item.appendChild(link);
      list.appendChild(item);
    }
    if (list.childNodes.length === 0) return null;
    wrap.appendChild(list);
    return wrap;
  }

  function renderActions(answer) {
    if (!Array.isArray(answer.actions) || answer.actions.length === 0) return null;
    const wrap = el(doc, 'div', 'bo-assistant-actions');
    wrap.appendChild(el(doc, 'p', 'bo-assistant-heading', 'Azioni collegate'));
    for (const action of answer.actions) {
      if (!action || typeof action.id !== 'string') continue;
      const pending = state.pendingConfirmId === action.id && actionNeedsConfirmation(action);
      const button = el(
        doc,
        'button',
        pending ? 'bo-assistant-confirm' : 'bo-assistant-action',
        pending
          ? `Conferma: ${shortText(action.confirmLabel ?? action.label, 90)}`
          : action.label,
      );
      button.addEventListener('click', () => {
        void executeAction(action);
      });
      wrap.appendChild(button);
      if (pending) {
        const cancel = el(doc, 'button', 'bo-assistant-cancel', 'Annulla');
        cancel.addEventListener('click', () => {
          state.pendingConfirmId = null;
          render();
        });
        wrap.appendChild(cancel);
      }
    }
    return wrap;
  }

  function renderAnswer() {
    const answer = state.answer;
    if (!answer) return null;
    const box = el(doc, 'div', 'bo-assistant-answer');
    box.appendChild(el(doc, 'h3', 'bo-assistant-title', answer.title));
    for (const line of answer.lines ?? []) {
      box.appendChild(el(doc, 'p', 'bo-assistant-line', String(line)));
    }
    const sources = renderSources(answer);
    if (sources) box.appendChild(sources);
    const actions = renderActions(answer);
    if (actions) box.appendChild(actions);
    for (const note of answer.unavailable ?? []) {
      box.appendChild(el(doc, 'p', 'bo-assistant-unavailable', String(note)));
    }
    return box;
  }

  async function executeAction(action) {
    if (state.busy) return;
    if (actionNeedsConfirmation(action) && state.pendingConfirmId !== action.id) {
      state.pendingConfirmId = action.id;
      render();
      return;
    }
    state.busy = true;
    state.error = '';
    render();
    try {
      const outcome = await runAssistantAction(client, action, {
        navigate,
        confirmedActionId: state.pendingConfirmId,
        idempotencyKey: issueAdminKey(),
      });
      state.pendingConfirmId = null;
      if (outcome.needsConfirmation === true) {
        state.pendingConfirmId = action.id;
      } else {
        notify(`Azione eseguita: ${action.label}`);
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Azione fallita.';
    } finally {
      state.busy = false;
      render();
    }
  }

  async function runSuggestionById(suggestionId) {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    state.pendingConfirmId = null;
    render();
    try {
      state.answer = await runSuggestion(client, suggestionId);
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Suggerimento fallito.';
    } finally {
      state.busy = false;
      render();
    }
  }

  async function submitFreeQuestion(question) {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    render();
    try {
      const outcome = await askFreeQuestion(client, state.status ?? { mode: 'dry-run' }, question);
      if (outcome.disabled === true) {
        state.error = outcome.notice;
      } else if (outcome.answer) {
        state.answer = outcome.answer;
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Domanda fallita.';
    } finally {
      state.busy = false;
      render();
    }
  }

  function render() {
    clearMount();
    if (!state.open) return;
    const panel = el(doc, 'aside', 'bo-assistant');
    const header = el(doc, 'div', 'bo-assistant-header');
    header.appendChild(el(doc, 'h2', 'bo-assistant-name', 'Assistente'));
    const close = el(doc, 'button', 'bo-assistant-close', 'Chiudi');
    close.setAttribute('aria-label', 'Chiudi assistente');
    close.addEventListener('click', () => {
      state.open = false;
      render();
    });
    header.appendChild(close);
    panel.appendChild(header);

    const list = el(doc, 'div', 'bo-assistant-suggestions');
    list.appendChild(el(doc, 'p', 'bo-assistant-heading', 'Suggerimenti'));
    for (const suggestion of suggestionsFor(state.screenId)) {
      const button = el(doc, 'button', 'bo-assistant-suggestion', suggestion.title);
      button.setAttribute('title', suggestion.detail);
      button.addEventListener('click', () => {
        void runSuggestionById(suggestion.id);
      });
      list.appendChild(button);
    }
    panel.appendChild(list);

    if (state.busy) {
      panel.appendChild(el(doc, 'p', 'bo-assistant-busy', 'Lavoro in corso…'));
    }
    const answer = renderAnswer();
    if (answer) panel.appendChild(answer);
    if (state.error !== '') {
      panel.appendChild(el(doc, 'p', 'bo-assistant-error', state.error));
    }

    const free = el(doc, 'form', 'bo-assistant-free');
    free.appendChild(el(doc, 'p', 'bo-assistant-heading', 'Domanda libera'));
    const input = doc.createElement('input');
    input.setAttribute('type', 'search');
    input.setAttribute('class', 'bo-assistant-input');
    input.setAttribute('aria-label', 'Domanda libera');
    if (state.status?.mode !== 'live') {
      input.setAttribute('disabled', 'true');
      input.setAttribute('placeholder', 'Le domande libere arrivano con la chiave');
    } else {
      input.setAttribute('placeholder', 'Scrivi una domanda…');
    }
    free.appendChild(input);
    const send = el(doc, 'button', 'bo-assistant-send', 'Chiedi');
    if (state.status?.mode !== 'live') send.setAttribute('disabled', 'true');
    free.appendChild(send);
    if (state.status?.mode !== 'live') {
      free.appendChild(el(doc, 'p', 'bo-assistant-notice', FREE_QUESTION_DISABLED_NOTICE));
    }
    free.addEventListener('submit', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      void submitFreeQuestion(typeof input.value === 'string' ? input.value : '');
    });
    panel.appendChild(free);

    mount.appendChild(panel);
  }

  return {
    /**
     * @param {unknown} screenId
     */
    async open(screenId) {
      state.open = true;
      if (typeof screenId === 'string' && screenId !== '') state.screenId = screenId;
      state.status = await probeAssistantBackend(client);
      render();
    },
    close() {
      state.open = false;
      render();
    },
    getState() {
      return {
        open: state.open,
        screenId: state.screenId,
        mode: state.status?.mode ?? null,
        suggestionCount: suggestionsFor(state.screenId).length,
        answerTitle: state.answer?.title ?? null,
        sourceCount: Array.isArray(state.answer?.sources) ? state.answer.sources.length : 0,
        pendingConfirmId: state.pendingConfirmId,
        error: state.error,
      };
    },
  };
}
