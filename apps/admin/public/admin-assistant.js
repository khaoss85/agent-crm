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
import { bindAdminMutations, issueAdminKey } from './admin-submission.js';
import {
  PHRASE_UNCLEAR_NOTE, assignAttempt, assignErrorText, assignToAgent, describeSchedule, findMentionedAgent,
  isPhraseUnclear, loadSpaceAgents,
} from './admin-agenti.js';
import { callOutcomeLabel, italianDateTime, romeClock } from './admin-labels.js';

/** Probe path for the future assistant backend (status + free-question ask). */
export const ASSISTANT_STATUS_PATH = '/api/assistant/status';

/**
 * The only free-question contract: questions POST exactly here. The probe and
 * the question path both check this constant — a status payload must never
 * steer the question POST at another backend route.
 */
const ASSISTANT_ASK_PATH = '/api/assistant/ask';

/**
 * Italian notices when free questions are unavailable. The panel never
 * blames the key by default: the pilot backend serves suggestions only, and
 * free questions are not part of the MVP. The key sentence appears only
 * when the status really reports a missing key (LLM_SECRET_UNAVAILABLE);
 * a disabled space (LLM_SPACE_DISABLED) says the assistant is off there
 * and who turns it on — never what it would do if it were on (voce
 * a684ecf5: il messaggio da spento non si contraddice).
 */
export const FREE_QUESTION_DISABLED_NOTICE = 'Le domande libere arrivano con la chiave: finché la chiave OpenAI non è configurata, il pannello resta utilizzabile con i suggerimenti (Suggerisci), che leggono dati reali.';
export const ASSISTANT_SPACE_DISABLED_NOTICE = 'Assistente non attivo in questo spazio: chiedi al titolare di attivarlo per questo spazio.';
export const ASSISTANT_SUGGEST_ONLY_NOTICE = 'In questo spazio l’assistente suggerisce le risposte ai messaggi (Suggerisci): le domande libere non sono attive.';

/** Free-question box limits: one line of intent, never a pasted document. */
export const FREE_QUESTION_MAX_LENGTH = 500;

/** How many rows a suggestion reads at most, and how many sources it cites. */
export const SUGGESTION_READ_LIMIT = 50;
export const SUGGESTION_MAX_SOURCES = 4;
export const SUGGESTION_MAX_LISTED = 3;

/**
 * How many past answers the panel keeps in-session (BO-F4-04): the trace of
 * every run stays inspectable until the page reloads. In-memory only, never
 * persisted — sources carry customer labels that must not rest on disk.
 */
export const ASSISTANT_HISTORY_LIMIT = 20;

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
  // Voce d525f4aa48b2: the customer card's own proposals behind
  // «✦ Chiedi all'AI» in Dettagli. The card opens the panel with the
  // customer already in the context; these read that live card, never
  // invent, and every write still confirms — on the panel gate for the
  // linked actions, on Salva/Invia for the scheda forms.
  'scheda-cliente': Object.freeze([
    { id: 'bo04:scheda:cambia-telefono', title: 'Cambia il telefono in …', detail: 'Il numero collegato al cliente, letto dalla scheda, e dove cambiarlo.' },
    { id: 'bo04:scheda:aggiungi-nota', title: 'Aggiungi una nota: …', detail: 'Le note del cliente, lette dalla scheda, e dove scriverne una.' },
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
/**
 * The suggestion closest to a question typed in the top bar (Dan 05/11):
 * free questions are off in the MVP, so «chi devo ricontattare oggi?»
 * runs «Chi devo ricontattare?» instead of being dropped. Plain word
 * overlap on title and detail (words of 4+ letters, accents folded);
 * null when nothing overlaps.
 * @param {string} screenId
 * @param {unknown} question
 */
export function closestSuggestion(screenId, question) {
  if (typeof question !== 'string' || question.trim() === '') return null;
  const words = (text) => new Set(String(text ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter((word) => word.length >= 4));
  const asked = words(question);
  // Highest overlap wins; a tie on the best score is ambiguous and runs
  // nothing — the panel then asks the operator to pick (review #596 P3).
  let best = null;
  let bestScore = 0;
  let tied = false;
  for (const suggestion of suggestionsFor(screenId)) {
    const own = words(`${suggestion.title} ${suggestion.detail ?? ''}`);
    let score = 0;
    for (const word of asked) if (own.has(word)) score += 1;
    if (score > bestScore) { best = suggestion; bestScore = score; tied = false; }
    else if (score > 0 && score === bestScore) tied = true;
  }
  return tied ? null : best;
}

const CHANNEL_NAMES = Object.freeze({
  phone: 'Telefono', email: 'Email', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook',
  messenger: 'Messenger', tiktok: 'TikTok', sms: 'SMS', telegram: 'Telegram',
  // One channel under three ids across packages: the site form reads the same everywhere.
  web: 'Form sito', webform: 'Form sito', 'website-form': 'Form sito',
});

/** Channel ids read in Italian in the answers (Dan 05/11: «(phone)» → «Telefono»). */
export function channelName(channel) {
  const key = String(channel ?? '').toLowerCase();
  return CHANNEL_NAMES[key] ?? shortText(String(channel ?? ''), 20);
}

export function suggestionsFor(screenId) {
  if (typeof screenId === 'string' && Object.hasOwn(SUGGESTION_CATALOG, screenId)) {
    return SUGGESTION_CATALOG[screenId];
  }
  return FALLBACK_SUGGESTIONS;
}

/**
 * @typedef {{ kind: 'record', module: string, id: string, label: string, href: string }} Source
 * @typedef {{ id: string, label: string, kind: 'navigate' | 'api', href?: string, request?: { path: string, method: string, body?: unknown }, customerFacing: boolean, confirmLabel?: string }} AssistantAction
 * @typedef {{ suggestionId: string, title: string, lines: string[], sources: Source[], actions: AssistantAction[], unavailable: string[], trace: AnswerTrace, context?: { kind: string, day?: string | null, dayWord?: string | null, ids: Array<{ module: string, id: string, label: string }> } | null }} Answer
 * A single read behind an answer: which surface was hit, with which bound,
 * and how many rows it returned. `status` is 'missing' when the module is
 * not composed or the read fails — the answer names it in `unavailable`
 * instead of failing — and 'invalid' when the payload has no usable rows.
 * @typedef {{ target: string, limit: number | null, status: 'ok' | 'missing' | 'invalid', rows: number }} TraceRead
 * A single action step through the confirmation gate: requested, gated, or
 * run. Recorded by runAssistantAction when the caller passes `trace`.
 * @typedef {{ actionId: string, at: string, outcome: 'needs-confirmation' | 'executed' | 'failed', detail: string }} TraceExecution
 * The execution trace of one answer (BO-F4-04): every read the builders
 * performed plus every action step the operator took on it. It lives on the
 * answer and in the panel session history — never in localStorage, so
 * customer labels in sources never persist on disk beyond the session.
 * @typedef {{ suggestionId: string, title: string, at: string, reads: TraceRead[], executions: TraceExecution[] }} AnswerTrace
 */

// An ISO-8601 instant inside a label: date, time and an explicit zone.
const ISO_INSTANT_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;

/**
 * Backlog 5a1e6d8dc42e: a source label (and the «Apri:» action built from
 * it) never shows a raw ISO stamp — every instant inside it reads as
 * «7 nov, 14:30» in Europe/Rome, whoever wrote the label (a suggestion
 * builder or the server's free answer).
 * @param {unknown} label
 * @returns {string}
 */
export function italianDates(label) {
  const text = label === null || label === undefined ? '' : String(label);
  return text.replace(ISO_INSTANT_RE, (stamp) => italianDateTime(stamp) ?? stamp);
}

/**
 * @param {string} module
 * @param {unknown} id
 * @param {unknown} label
 */
function recordSource(module, id, label) {
  if (!isSafeModule(module) || !isSafeRecordId(id)) return null;
  // Voce a684ecf5: la fonte mostra il nome, mai l'id grezzo — l'ultima
  // rete resta neutra invece di ripiegare sull'id.
  const text = shortText(italianDates(label), 80) || 'Record senza nome';
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

/**
 * Masked channel reference of one thread (voce 34fd687c): the customer
 * handle on the channel with the middle hidden (es. «+39 333 …4567»),
 * never a raw record id. Short handles stay whole; long ones keep the
 * first 4 and the last 4 characters so two different handles stay
 * different without leaking the full reference.
 * @param {unknown} handle
 */
function maskChannelRef(handle) {
  const text = shortText(handle, 40);
  if (text === '' || text.length <= 7) return text;
  return `${text.slice(0, 4)} …${text.slice(-4)}`;
}

/**
 * Last-activity stamp of one thread (voce 34fd687c): the newest of
 * updatedAt/openedAt/observedAt in Italian «06/11/2026, 10:15» form, ''
 * when the row carries no readable time.
 * @param {unknown} row
 */
function threadStamp(row) {
  const ts = Math.max(rowTime(row?.updatedAt), rowTime(row?.openedAt), rowTime(row?.observedAt));
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const day = italianDay(localDayOf(date));
  if (day === '') return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${day}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The display name of one thread. Names the customer (the subject
 * snapshot), else the masked channel reference plus the last-activity
 * date — never a raw record id (voce 34fd687c: «Chiudi il thread di
 * 712e1f90-…» non deve più comparire). Ids travel only in hrefs, never
 * in lines, labels or buttons.
 * @param {unknown} row
 */
function conversationLabel(row) {
  const named = shortText(row?.subjectLabel, 80);
  if (named !== '') return named;
  const channel = channelName(row?.channel) || 'Conversazione';
  const ref = maskChannelRef(row?.remoteHandle);
  const stamp = threadStamp(row);
  if (ref !== '' && stamp !== '') return `${channel} · ${ref} · ${stamp}`;
  if (ref !== '') return `${channel} · ${ref}`;
  if (stamp !== '') return `${channel} · ${stamp}`;
  return channel;
}

/**
 * One ordinal disambiguator for every listed label (voce 34fd687c, unica
 * fonte di verità): equal bases get a stable ordinal (« · 1», « · 2») so
 * two rows with the same display text never share one identical label —
 * threads and leads alike. Unique bases pass through untouched.
 * @param {Array<string>} bases
 */
function uniqueLabels(bases) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  /** @type {Map<string, number>} */
  const seen = new Map();
  return bases.map((base) => {
    if ((counts.get(base) ?? 0) <= 1) return base;
    const position = (seen.get(base) ?? 0) + 1;
    seen.set(base, position);
    return `${base} · ${position}`;
  });
}

/**
 * One source of truth for thread labels in a list (voce 34fd687c): every
 * listed line, source and close/confirm label of the same answer shares
 * these strings. Rows are already ordered (newest first).
 * @param {Array<any>} rows
 */
function uniqueConversationLabels(rows) {
  return uniqueLabels(rows.map((row) => conversationLabel(row)));
}

/**
 * The listed line of one thread: a named thread keeps its channel in
 * parentheses, an unnamed one already carries it in its label.
 * @param {unknown} row
 * @param {string} label the unique label of this row in its answer
 */
function conversationLine(row, label) {
  if (shortText(row?.subjectLabel, 80) !== '' && row?.channel) {
    return `• ${label} (${channelName(row.channel)})`;
  }
  return `• ${label}`;
}

/**
 * Read one module list best-effort: rows when the module is composed and the
 * read succeeds, null when it is not — an unavailable section names itself
 * instead of failing the whole answer. Every attempt lands in `traceReads`
 * (BO-F4-04) so the answer can show which records it really read.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {string} module
 * @param {number} limit
 * @param {Array<TraceRead>} [traceReads]
 */
async function readRecords(client, module, limit = SUGGESTION_READ_LIMIT, traceReads) {
  try {
    const body = await client.request(`/api/modules/${module}/records?limit=${limit}`);
    if (!body || !Array.isArray(body.items)) {
      traceRead(traceReads, module, limit, 'invalid', 0);
      return null;
    }
    const rows = body.items.filter((row) => row !== null && typeof row === 'object');
    traceRead(traceReads, module, limit, 'ok', rows.length);
    return rows;
  } catch {
    traceRead(traceReads, module, limit, 'missing', 0);
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
 * Record one read in the answer trace, when the caller keeps a trace.
 * @param {Array<TraceRead> | undefined} traceReads
 * @param {string} target
 * @param {number | null} limit
 * @param {'ok' | 'missing' | 'invalid'} status
 * @param {number} rows
 */
function traceRead(traceReads, target, limit, status, rows) {
  if (!Array.isArray(traceReads)) return;
  traceReads.push({ target, limit, status, rows });
}

/**
 * @param {string} suggestionId
 * @param {string} title
 */
function emptyAnswer(suggestionId, title) {
  const trace = {
    suggestionId,
    title,
    at: new Date().toISOString(),
    reads: [],
    executions: [],
  };
  return {
    suggestionId, title, lines: [], sources: [], actions: [], unavailable: [], trace,
  };
}

/** Urgenti oggi: thread aperti + problemi di qualità aperti, dai record reali. */
async function answerUrgenti(client) {
  const answer = emptyAnswer('bo04:oggi:urgenti', 'Cosa è più urgente oggi?');
  const [conversations, issues] = await Promise.all([
    readRecords(client, 'conversation', SUGGESTION_READ_LIMIT, answer.trace.reads),
    readRecords(client, 'data-quality-issue', SUGGESTION_READ_LIMIT, answer.trace.reads),
  ]);
  if (conversations === null) {
    answer.unavailable.push('Thread: modulo conversation non leggibile in questo spazio.');
  } else {
    const ordered = newestFirst(conversations.filter((row) => row?.status === 'open'));
    answer.lines.push(`${ordered.length} thread aperti${conversations.length !== ordered.length ? ` su ${conversations.length} letti` : ''}.`);
    const sourced = ordered.slice(0, SUGGESTION_MAX_SOURCES);
    const labels = uniqueConversationLabels(sourced);
    sourced.slice(0, SUGGESTION_MAX_LISTED).forEach((row, index) => {
      answer.lines.push(conversationLine(row, labels[index]));
    });
    sourced.forEach((row, index) => {
      const source = recordSource('conversation', row?.id, labels[index]);
      if (source !== null) answer.sources.push(source);
    });
  }
  if (issues === null) {
    answer.unavailable.push('Qualità dati: modulo data-quality-issue non leggibile in questo spazio.');
  } else {
    const open = issues.filter((row) => row?.status === 'open');
    answer.lines.push(`${open.length} problemi di qualità aperti.`);
    answer.sources.push(...takeSources(open, 'data-quality-issue', (row) => row?.title ?? row?.code ?? 'Segnalazione senza titolo'));
  }
  answer.actions.push({ id: 'bo04:apri-clienti', label: 'Apri Clienti', kind: 'navigate', href: '#/customer-data', customerFacing: false });
  const first = answer.sources[0];
  if (first) {
    answer.actions.push({ id: 'bo04:apri-primo', label: `Apri: ${first.label}`, kind: 'navigate', href: first.href, customerFacing: false });
  }
  return answer;
}

/**
 * Customer names behind call rows (voce 52854fd292a3). interaction-call
 * carries no name, only its conversationId; the conversation row carries the
 * subject snapshot (subjectLabel). One conversation page is read, and only
 * when some call names a conversation — a call outside that page keeps its
 * masked number, a name is never guessed.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {Array<any>} calls
 * @param {Array<TraceRead>} traceReads
 */
async function callCustomerNames(client, calls, traceReads) {
  /** @type {Map<string, string>} */
  const names = new Map();
  if (!calls.some((row) => isSafeRecordId(row?.conversationId))) return names;
  const conversations = await readRecords(client, 'conversation', SUGGESTION_READ_LIMIT, traceReads);
  for (const row of conversations ?? []) {
    const name = shortText(row?.subjectLabel, 60);
    if (name !== '' && isSafeRecordId(row?.id)) names.set(/** @type {string} */ (row.id), name);
  }
  return names;
}

/**
 * The display label of one call (voce 52854fd292a3): the customer name when
 * there is one («Mario Rossi · chiamata riuscita»), else the masked number,
 * never the raw outcome key, the full number or a record id.
 * @param {any} row
 * @param {Map<string, string>} names
 */
function callLabel(row, names) {
  const what = `chiamata ${callOutcomeLabel(row?.outcome)}`;
  const who = names.get(row?.conversationId) ?? maskChannelRef(row?.remoteHandle);
  return who !== '' ? `${who} · ${what}` : `${what.charAt(0).toUpperCase()}${what.slice(1)}`;
}

/**
 * Sources of a call answer: newest first, one distinct label each.
 * @param {Array<any>} calls
 * @param {Map<string, string>} names
 */
function callSources(calls, names) {
  const rows = newestFirst(calls).filter((row) => isSafeRecordId(row?.id)).slice(0, SUGGESTION_MAX_SOURCES);
  const labels = uniqueLabels(rows.map((row) => callLabel(row, names)));
  /** @type {Source[]} */
  const sources = [];
  rows.forEach((row, index) => {
    const source = recordSource('interaction-call', row.id, labels[index]);
    if (source !== null) sources.push(source);
  });
  return sources;
}

/** Telefono: esiti delle chiamate registrate in interaction-call. */
async function answerChiamate(client) {
  const answer = emptyAnswer('bo04:oggi:chiamate', 'Com’è andato il telefono?');
  const calls = await readRecords(client, 'interaction-call', CALL_READ_LIMIT, answer.trace.reads);
  if (calls === null) {
    answer.unavailable.push('Chiamate: modulo interaction-call non leggibile in questo spazio.');
    return answer;
  }
  /** @type {Map<string, number>} */
  const byOutcome = new Map();
  for (const row of calls) {
    const outcome = callOutcomeLabel(row?.outcome);
    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
  }
  // Honest bounds: at the read cap the page may hide more rows — the
  // headline says which page it counts, never a total.
  const capped = calls.length >= CALL_READ_LIMIT;
  answer.lines.push(`${calls.length} chiamate registrate${capped ? ` (prime ${calls.length} lette)` : ''}.`);
  for (const [outcome, count] of [...byOutcome.entries()].sort((a, b) => b[1] - a[1]).slice(0, SUGGESTION_MAX_LISTED)) {
    answer.lines.push(`• ${outcome}: ${count}`);
  }
  const names = await callCustomerNames(client, calls, answer.trace.reads);
  answer.sources.push(...callSources(calls, names));
  const first = answer.sources[0];
  if (first) {
    answer.actions.push({ id: 'bo04:apri-primo', label: `Apri: ${first.label}`, kind: 'navigate', href: first.href, customerFacing: false });
  }
  return answer;
}

/** Da ricontattare: thread aperti, messaggio più recente in cima. */
async function answerRicontattare(client) {
  const answer = emptyAnswer('bo04:clienti:ricontattare', 'Chi devo ricontattare?');
  const conversations = await readRecords(client, 'conversation', SUGGESTION_READ_LIMIT, answer.trace.reads);
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
  const sourced = open.slice(0, SUGGESTION_MAX_SOURCES);
  const labels = uniqueConversationLabels(sourced);
  const labelById = new Map(sourced.map((row, index) => [row?.id, labels[index]]));
  sourced.slice(0, SUGGESTION_MAX_LISTED).forEach((row, index) => {
    answer.lines.push(conversationLine(row, labels[index]));
  });
  sourced.forEach((row, index) => {
    const source = recordSource('conversation', row?.id, labels[index]);
    if (source !== null) answer.sources.push(source);
  });
  const first = open[0];
  const firstLabel = labelById.get(first?.id) ?? conversationLabel(first);
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
        label: `Chiudi il thread di ${firstLabel}`,
        kind: 'api',
        request: { path: `/api/modules/conversation/records/${encodeURIComponent(conversationId)}/actions/close`, method: 'POST', body: {} },
        customerFacing: true,
        confirmLabel: `Chiudere il thread di ${firstLabel}? Non si può riaprire: i nuovi messaggi aprono un altro thread.`,
      });
    }
    answer.actions.push({
      id: `bo04:contatta:${conversationId}`,
      label: 'Contatta il cliente',
      kind: 'navigate',
      href: `#/modules/conversation/${encodeURIComponent(conversationId)}`,
      customerFacing: true,
      confirmLabel: `Aprire il thread con ${firstLabel} per contattare il cliente?`,
    });
  }
  return answer;
}

/**
 * Customer names behind signal lead ids (voce a684ecf5): leadId is a
 * contact or company record id, so the panel reads those modules and
 * names the customer — never the raw id. Unknown ids stay neutral.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {Array<TraceRead>} traceReads
 */
async function signalLeadNames(client, traceReads) {
  /** @type {Map<string, string>} */
  const names = new Map();
  const [contacts, companies] = await Promise.all([
    readRecords(client, 'contact', FREE_DATA_READ_LIMIT, traceReads),
    readRecords(client, 'company', FREE_DATA_READ_LIMIT, traceReads),
  ]);
  for (const row of contacts ?? []) {
    const name = contactDisplayName(row);
    if (name !== '' && isSafeRecordId(row?.id)) names.set(/** @type {string} */ (row.id), name);
  }
  for (const row of companies ?? []) {
    const name = companyDisplayName(row);
    if (name !== '' && isSafeRecordId(row?.id)) names.set(/** @type {string} */ (row.id), name);
  }
  return names;
}

/** Segnali caldi: behavioral-signal di packages/intelligence, per lead. */
async function answerSegnali(client) {
  const answer = emptyAnswer('bo04:clienti:segnali', 'Quali lead mostrano segnali caldi?');
  const signals = await readRecords(client, 'behavioral-signal', SIGNAL_READ_LIMIT, answer.trace.reads);
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
  // Voce a684ecf5: ogni riga nomina il cliente, mai l'id grezzo
  // (contact/<uuid>). Stessa fonte di verità per righe, fonti e «Apri:».
  const leadNames = await signalLeadNames(client, answer.trace.reads);
  const leadLabel = (leadId) => leadNames.get(leadId) ?? 'Lead senza nome';
  const distinct = uniqueLabels(ranked.map(([leadId]) => leadLabel(leadId)));
  const labelByLead = new Map(ranked.map(([leadId], index) => [leadId, distinct[index]]));
  // Honest bounds: at the read cap the page may hide more rows — the
  // headline says which page it counts, never a total.
  const capped = signals.length >= SIGNAL_READ_LIMIT;
  answer.lines.push(`${signals.length} segnali su ${byLead.size} lead${capped ? ` (prime ${signals.length} lette)` : ''}:`);
  const sourceRows = [];
  for (const [leadId, list] of ranked) {
    const latest = newestFirst(list)[0];
    answer.lines.push(`• ${labelByLead.get(leadId)}: ${list.length} segnali (ultimo: ${shortText(latest?.signalType, 30) || '?'})`);
    sourceRows.push(latest);
  }
  answer.sources.push(...takeSources(sourceRows, 'behavioral-signal', (row) => `${shortText(row?.signalType, 30) || 'segnale'} · ${labelByLead.get(row?.leadId) ?? 'Lead senza nome'}`));
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
 * @param {Array<TraceRead>} [traceReads]
 * @returns {Promise<{ name: string, stages: Array<{ key: string, label?: string, type?: string }> } | null>}
 */
async function opportunityBoard(client, traceReads) {
  try {
    const schema = await client.request('/api/schema');
    traceRead(traceReads, 'schema', null, 'ok', Array.isArray(schema?.pipelines) ? schema.pipelines.length : 0);
    const pipeline = Array.isArray(schema?.pipelines)
      ? schema.pipelines.find((entry) => entry !== null && typeof entry === 'object'
        && entry.module === 'opportunity'
        && typeof entry.name === 'string' && /^[a-z][a-z0-9-]*$/.test(entry.name))
      : undefined;
    if (!pipeline || !Array.isArray(pipeline.stages)) return null;
    return pipeline;
  } catch {
    traceRead(traceReads, 'schema', null, 'missing', 0);
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
    traceRead(answer.trace.reads, 'opportunities', null, body === null ? 'missing' : 'invalid', 0);
    answer.unavailable.push('Opportunità: elenco non leggibile in questo spazio.');
    return answer;
  }
  traceRead(answer.trace.reads, 'opportunities', null, 'ok', items.length);
  // Voce a684ecf5: il nome dell'opportunità, mai l'id grezzo.
  const labelOf = (row) => shortText(row?.name ?? row?.companyName ?? row?.title, 60) || 'Opportunità senza titolo';
  // Honest bounds: /api/opportunities without a limit serves the server
  // default page (OPPORTUNITY_SERVER_DEFAULT_LIMIT) — at the cap the headline
  // says which page it counts, never a total.
  const capped = items.length >= OPPORTUNITY_SERVER_DEFAULT_LIMIT;
  const pageNote = capped ? ` (prime ${OPPORTUNITY_SERVER_DEFAULT_LIMIT} lette)` : '';
  const board = await opportunityBoard(client, answer.trace.reads);
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
      answer.lines.push(`• ${labelOf(row)}`);
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
      answer.lines.push(`• ${labelOf(row)}`);
    }
  }
  for (const row of openPlaced) {
    if (answer.sources.length >= SUGGESTION_MAX_SOURCES) break;
    if (!isSafeRecordId(row?.id)) continue;
    const label = labelOf(row);
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
  const appointments = await readRecords(client, 'appointment', SUGGESTION_READ_LIMIT, answer.trace.reads);
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
  // Backlog 5a1e6d8dc42e: the slot reads «7 nov, 14:30», never the ISO
  // stamp; a bare day keeps its day and never invents a time.
  const whenOf = (row) => italianDateTime(row?.startsAt) || italianDay(row?.date) || shortText(row?.date, 24) || 'appuntamento';
  const labelOf = (row) => `${whenOf(row)} ${shortText(row?.subjectLabel, 40) || ''}`.trim();
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
  const messages = await readRecords(client, 'interaction-message', 100, answer.trace.reads);
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
  answer.sources.push(...takeSources(inbound, 'interaction-message', (row) => shortText(row?.body, 60) || '(senza testo)'));
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
  answer.lines.push('4. Il modulo viene provato davvero: si apre e mostra un record, altrimenti non esiste.');
  answer.lines.push('5. bundle install lo registra; l’host lo compone con createAccordoApp({ bundles }).');
  answer.actions.push({ id: 'bo05:apri-nuovo-modulo', label: 'Apri: Nuovo modulo', kind: 'navigate', href: '#/nuovo-modulo', customerFacing: false });
  answer.actions.push({ id: 'bo05:apri-reporting', label: 'Apri: Reporting', kind: 'navigate', href: '#/reporting', customerFacing: false });
  return answer;
}

/** Reporting call: chiamate registrate per operatore ed esito. */
async function answerCallReport(client) {
  const answer = emptyAnswer('bo04:reporting:call', 'Chi ha gestito più call questo mese?');
  const calls = await readRecords(client, 'interaction-call', CALL_READ_LIMIT, answer.trace.reads);
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
    answer.lines.push(`• ${shortText(member, 30)}: ${entry.total} (${entry.completed} riuscite)`);
  }
  const names = await callCustomerNames(client, calls, answer.trace.reads);
  answer.sources.push(...callSources(calls, names));
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
  const audit = await readRecords(client, 'llm-call-audit', 20, answer.trace.reads);
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
/**
 * Voce d525f4aa48b2: the customer the card handed to the panel, validated
 * like every record identity the panel touches — a hostile or missing
 * context reads as no customer, never as a request to a crafted route.
 * @param {unknown} input
 */
function schedaCustomer(input) {
  const resource = input?.resource;
  const id = input?.id;
  if (!isSafeModule(resource) || !isSafeRecordId(id)) return null;
  return { resource, id };
}

/**
 * Read the live customer card behind a scheda proposal. Null when the
 * server does not serve it — the proposal then names the missing read,
 * never invents the number or the notes.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {{ resource: string, id: string }} who
 * @param {Array<TraceRead>} traceReads
 */
async function readSchedaCard(client, who, traceReads) {
  try {
    const body = await client.request(
      `/api/customer-hub/card/${encodeURIComponent(who.resource)}/${encodeURIComponent(who.id)}`);
    if (body !== null && typeof body === 'object') {
      traceRead(traceReads, 'customer-hub/card', null, 'ok', 1);
      return body;
    }
    traceRead(traceReads, 'customer-hub/card', null, 'invalid', 0);
    return null;
  } catch {
    traceRead(traceReads, 'customer-hub/card', null, 'missing', 0);
    return null;
  }
}

/**
 * Voce d525f4aa48b2: «Cambia il telefono in …» — the linked number read
 * from the live card, with where to change it. The change itself stays on
 * the scheda forms (Dettagli → Modifica, Azioni rapide → Aggiungi
 * telefono), each behind its own Salva; the linked action only brings the
 * operator back to the card, and being customer-facing it confirms first.
 */
async function answerSchedaTelefono(client, customer) {
  const answer = emptyAnswer('bo04:scheda:cambia-telefono', 'Cambia il telefono in …');
  const who = schedaCustomer(customer);
  if (!who) {
    answer.unavailable.push('Nessun cliente nel contesto: apri la barra con «✦ Chiedi all\u2019AI» dalla scheda del cliente.');
    return answer;
  }
  const card = await readSchedaCard(client, who, answer.trace.reads);
  if (!card) {
    answer.unavailable.push('Scheda non leggibile in questo spazio.');
    return answer;
  }
  const name = shortText(card?.name, 60) || 'Il cliente';
  const phone = card?.phone?.available === true
    && typeof card.phone.value === 'string' && card.phone.value.trim() !== ''
    ? card.phone.value.trim() : null;
  if (phone) {
    answer.lines.push(`Telefono collegato a ${name}: ${phone}.`);
    answer.lines.push('Per cambiarlo: Dettagli → Modifica, oppure «Aggiungi telefono» nelle Azioni rapide. La modifica chiede Salva.');
  } else {
    answer.lines.push(`${name} non ha un telefono collegato.`);
    answer.lines.push('Per aggiungerlo: «Aggiungi telefono» nelle Azioni rapide. Il salvataggio chiede Salva.');
  }
  answer.sources.push({
    kind: 'record', module: who.resource, id: who.id, label: name,
    href: `#/customer-card/${who.resource}/${encodeURIComponent(who.id)}`,
  });
  answer.actions.push({
    id: `bo04:scheda:telefono:${who.id}`, label: `Apri la scheda di ${name}`,
    kind: 'navigate', href: `#/customer-card/${who.resource}/${encodeURIComponent(who.id)}`,
    customerFacing: true, confirmLabel: `Apri la scheda di ${name} per cambiare il numero?`,
  });
  return answer;
}

/**
 * Read the live customer timeline behind a scheda proposal. Null when the
 * server does not serve it — the proposal then names the missing read,
 * never invents the notes the scheda itself renders from these entries.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {{ resource: string, id: string }} who
 * @param {Array<TraceRead>} traceReads
 */
async function readSchedaTimeline(client, who, traceReads) {
  try {
    const body = await client.request(
      `/api/customer-hub/timeline/${encodeURIComponent(who.resource)}/${encodeURIComponent(who.id)}`);
    if (body !== null && typeof body === 'object') {
      traceRead(traceReads, 'customer-hub/timeline', null, 'ok', 1);
      return body;
    }
    traceRead(traceReads, 'customer-hub/timeline', null, 'invalid', 0);
    return null;
  } catch {
    traceRead(traceReads, 'customer-hub/timeline', null, 'missing', 0);
    return null;
  }
}

/**
 * Voce d525f4aa48b2: «Aggiungi una nota: …» — the customer notes read from
 * the live timeline (the same entries the scheda cronologia renders), with
 * where to write one. The production card never serves notes (card.notes is
 * always {available:false}), so a card-backed count would stay dead. The
 * note itself is written only in the scheda cronologia («Aggiungi nota»,
 * behind its own save); the linked action only brings the operator back to
 * the card, and being customer-facing it confirms first.
 */
async function answerSchedaNota(client, customer) {
  const answer = emptyAnswer('bo04:scheda:aggiungi-nota', 'Aggiungi una nota: …');
  const who = schedaCustomer(customer);
  if (!who) {
    answer.unavailable.push('Nessun cliente nel contesto: apri la barra con «✦ Chiedi all\u2019AI» dalla scheda del cliente.');
    return answer;
  }
  const card = await readSchedaCard(client, who, answer.trace.reads);
  if (!card) {
    answer.unavailable.push('Scheda non leggibile in questo spazio.');
    return answer;
  }
  const name = shortText(card?.name, 60) || 'Il cliente';
  const timeline = await readSchedaTimeline(client, who, answer.trace.reads);
  const items = Array.isArray(timeline?.entries?.items) ? timeline.entries.items : null;
  if (items === null) {
    answer.lines.push(`Le note di ${name} non sono leggibili in questo spazio.`);
  } else {
    const count = items.filter((item) => item?.entry === 'note').length;
    answer.lines.push(timeline.entries.truncated === true
      ? `Note registrate per ${name}: almeno ${count} (cronologia troncata).`
      : `Note registrate per ${name}: ${count}.`);
  }
  answer.lines.push('Per scriverne una: cronologia → «Aggiungi nota». La nota resta nella cronologia, non viene inviata a nessuno.');
  answer.sources.push({
    kind: 'record', module: who.resource, id: who.id, label: name,
    href: `#/customer-card/${who.resource}/${encodeURIComponent(who.id)}`,
  });
  answer.actions.push({
    id: `bo04:scheda:nota:${who.id}`, label: `Apri la scheda di ${name}`,
    kind: 'navigate', href: `#/customer-card/${who.resource}/${encodeURIComponent(who.id)}`,
    customerFacing: true, confirmLabel: `Apri la scheda di ${name} per scrivere la nota?`,
  });
  return answer;
}

/**
 * Deterministic free data questions (voce 34fd687c, ownerTitle: domande
 * libere su più turni con i nomi dei clienti). No key, no backend, no
 * spend: pure reads over records the panel already renders, so «quanti
 * lead oggi?» is answered even in dry-run. Anything this parser does not
 * recognize returns null and the caller falls back to the backend-or-notice
 * path — never a silent call, never an invented number.
 *
 * Multi-turn context is the previous answer's `context` (kept in the panel
 * session, never persisted): «e ieri?» shifts the last lead-day question,
 * «chi è il primo?» names the first entry of its list.
 */
const FREE_DATA_READ_LIMIT = 50;

/** Folded lowercase words of a question: accents and punctuation never matter. */
function freeWords(question) {
  return String(question ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Operator-local calendar day of an Instant, `YYYY-MM-DD`. NaN-safe. */
function localDayOf(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DD` shifted by whole days, for «e ieri?». */
function shiftDay(day, delta) {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** Italian `06/11/2026` for a `YYYY-MM-DD` day. */
function italianDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '');
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

/** Display name of a contact row: never an id. */
function contactDisplayName(row) {
  const full = `${shortText(row?.firstName, 40)} ${shortText(row?.lastName, 40)}`.trim();
  return full !== '' ? full : shortText(row?.email, 60) || '';
}

/** Display name of a company row: never an id. */
function companyDisplayName(row) {
  return shortText(row?.name, 80) || '';
}

/**
 * Fallback label of a lead row without a displayable name (voce 34fd687c):
 * the masked channel reference when the row carries one (never the raw
 * reference, never a raw id), else the neutral «Lead senza nome». The
 * caller counts the row either way — the headline total is always the
 * true measured total.
 * @param {unknown} row
 */
function fallbackLeadLabel(row) {
  const handle = row !== null && typeof row === 'object'
    ? (row.email ?? row.phone ?? row.remoteHandle ?? row.handle)
    : null;
  const masked = maskChannelRef(handle);
  return masked !== '' ? masked : 'Lead senza nome';
}

/**
 * One lead-day answer: contacts and companies created on one local day,
 * oldest first, named (never UUIDs) and linked to their customer card.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {string} title the original question, shown on the card
 * @param {string} day `YYYY-MM-DD`, operator-local
 * @param {string} dayWord 'oggi' or 'ieri'
 */
async function answerLeadDay(client, title, day, dayWord) {
  const answer = emptyAnswer('bo04:domanda-libera', title);
  const [contacts, companies] = await Promise.all([
    readRecords(client, 'contact', FREE_DATA_READ_LIMIT, answer.trace.reads),
    readRecords(client, 'company', FREE_DATA_READ_LIMIT, answer.trace.reads),
  ]);
  const readable = [];
  if (contacts !== null) readable.push(['contact', contacts]);
  else answer.unavailable.push('Lead: modulo contact non leggibile in questo spazio.');
  if (companies !== null) readable.push(['company', companies]);
  else answer.unavailable.push('Aziende: modulo company non leggibile in questo spazio.');
  /** @type {Array<{ module: string, id: string, label: string, at: number }>} */
  const entries = [];
  for (const [module, rows] of readable) {
    const labelOf = module === 'contact' ? contactDisplayName : companyDisplayName;
    for (const row of rows) {
      const at = Date.parse(row?.createdAt);
      if (Number.isNaN(at) || localDayOf(at) !== day) continue;
      if (!isSafeRecordId(row?.id)) continue;
      // Every day-matching row counts, named or not: a missing label gets
      // the masked-reference fallback, never a silent drop from the total.
      const label = labelOf(row) || fallbackLeadLabel(row);
      entries.push({ module, id: row.id, label, at });
    }
  }
  entries.sort((a, b) => a.at - b.at);
  // Same ordinal gate as the thread labels: two rows with the same display
  // text never share one identical label in this answer.
  const distinct = uniqueLabels(entries.map((entry) => entry.label));
  distinct.forEach((label, index) => { entries[index].label = label; });
  const when = `${dayWord} (${italianDay(day)})`;
  const capped = readable.some(([, rows]) => rows.length >= FREE_DATA_READ_LIMIT);
  const bound = capped ? ' (prime 50 lette)' : '';
  if (readable.length === 0) {
    answer.lines.push(`I lead ${when} non sono leggibili in questo spazio${bound}.`);
    answer.context = {
      kind: 'lead-day', day, dayWord, ids: [], unreadable: true, unavailable: [...answer.unavailable],
    };
    return answer;
  }
  if (entries.length === 0) {
    answer.lines.push(`Nessun lead nuovo ${when}${bound}.`);
    answer.context = { kind: 'lead-day', day, dayWord, ids: [] };
    return answer;
  }
  answer.lines.push(entries.length === 1
    ? `1 lead nuovo ${when}${bound}:`
    : `${entries.length} lead nuovi ${when}${bound}:`);
  for (const entry of entries.slice(0, SUGGESTION_MAX_LISTED)) {
    answer.lines.push(`• ${entry.label}`);
  }
  for (const entry of entries.slice(0, SUGGESTION_MAX_SOURCES)) {
    answer.sources.push({
      kind: 'record', module: entry.module, id: entry.id, label: entry.label,
      href: `#/customer-card/${entry.module}/${encodeURIComponent(entry.id)}`,
    });
  }
  const first = entries[0];
  answer.actions.push({
    id: `bo04:lead:apri:${first.id}`, label: `Apri la scheda di ${first.label}`,
    kind: 'navigate', href: `#/customer-card/${first.module}/${encodeURIComponent(first.id)}`,
    customerFacing: false,
  });
  answer.context = {
    kind: 'lead-day', day, dayWord,
    ids: entries.map((entry) => ({ module: entry.module, id: entry.id, label: entry.label })),
  };
  return answer;
}

/**
 * «Chi è il primo?»: the first entry of the last lead-day list, named and
 * linked. Without that context the panel says which question to ask first —
 * in Italian, never a refusal code. An unreadable day stays unreadable
 * (never re-reported as a measured zero), carrying the same unavailable
 * notes as the day answer.
 * @param {string} title the original question, shown on the card
 * @param {unknown} context the previous free answer's context
 * @param {unknown} inherit an Answer whose trace reads and unavailable notes
 * this primo answer reuses instead of discarding (voce 34fd687c P1: the
 * «primo lead» path reads the day, so it keeps the day's trace)
 */
function answerPrimo(title, context, inherit = null) {
  const answer = emptyAnswer('bo04:domanda-libera', title);
  if (inherit !== null && typeof inherit === 'object') {
    if (Array.isArray(inherit.trace?.reads)) answer.trace.reads = inherit.trace.reads;
    if (Array.isArray(inherit.unavailable)) answer.unavailable = [...inherit.unavailable];
  }
  const ids = Array.isArray(context?.ids) ? context.ids.filter((entry) => entry !== null && typeof entry === 'object'
    && isSafeModule(entry.module) && isSafeRecordId(entry.id) && typeof entry.label === 'string' && entry.label !== '') : [];
  if (ids.length === 0) {
    const day = typeof context?.day === 'string' ? context.day : null;
    const word = typeof context?.dayWord === 'string' ? context.dayWord : null;
    const inherited = Array.isArray(context?.unavailable) ? context.unavailable.filter((note) => typeof note === 'string' && note !== '') : [];
    if (context?.unreadable === true && day !== null && day !== '') {
      const when = word !== null && word !== '' ? ` ${word} (${italianDay(day)})` : ` del ${italianDay(day)}`;
      answer.lines.push(`Non riesco a leggere i lead${when} in questo spazio: non so dire chi è il primo.`);
      for (const note of inherited) {
        if (!answer.unavailable.includes(note)) answer.unavailable.push(note);
      }
      answer.context = {
        kind: 'lead-day', day, dayWord: word, ids: [], unreadable: true, unavailable: [...inherited],
      };
    } else if (day !== null && day !== '') {
      const when = word !== null && word !== '' ? ` ${word} (${italianDay(day)})` : ` del ${italianDay(day)}`;
      answer.lines.push(`Nessun lead${when}: non c'è un primo da mostrare.`);
      answer.context = { kind: 'lead-day', day, dayWord: word, ids: [] };
    } else {
      answer.lines.push('Dimmi prima «quanti lead oggi?»: poi ti dico chi è il primo.');
      answer.context = { kind: 'lead-day', day, dayWord: word, ids: [] };
    }
    return answer;
  }
  const first = ids[0];
  const when = typeof context?.day === 'string' && context.day !== '' ? ` del ${italianDay(context.day)}` : '';
  answer.lines.push(`Il primo${when} è ${first.label}.`);
  answer.sources.push({
    kind: 'record', module: first.module, id: first.id, label: first.label,
    href: `#/customer-card/${first.module}/${encodeURIComponent(first.id)}`,
  });
  answer.actions.push({
    id: `bo04:lead:apri:${first.id}`, label: `Apri la scheda di ${first.label}`,
    kind: 'navigate', href: `#/customer-card/${first.module}/${encodeURIComponent(first.id)}`,
    customerFacing: false,
  });
  answer.context = { kind: 'lead-day', day: context.day ?? null, dayWord: context.dayWord ?? null, ids };
  return answer;
}

/**
 * Try one free question locally. An Answer when the question is a data
 * question over space records (lead-day, day shift, primo), null when it is
 * not — the caller then uses the backend-or-notice path.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {string} title the validated question text
 * @param {unknown} context the previous free answer's context
 * @returns {Promise<Answer | null>}
 */
export async function answerFreeLocal(client, title, context = null) {
  if (client === null || typeof client !== 'object' || typeof client.request !== 'function') return null;
  const folded = freeWords(title);
  if (folded === '') return null;
  const hasLead = /\blead\b/.test(folded)
    || (/\bnuov[oi]\b/.test(folded) && (/\bclient/.test(folded) || /\bcontatt/.test(folded) || /\baziend/.test(folded)));
  const wantsPrimo = /\bprim[oi]\b/.test(folded);
  const dayWord = /\bieri\b/.test(folded) ? 'ieri' : 'oggi';
  const today = localDayOf(Date.now());
  const isShiftOnly = /^(e|ed)\s+(ieri|oggi)\??$/.test(folded);
  if (isShiftOnly) {
    if (context?.kind !== 'lead-day' || typeof context?.day !== 'string' || context.day === '') return null;
    // «e ieri?» after «quanti lead oggi?» reads yesterday; after a
    // yesterday list it stays there. «e oggi?» always reads today.
    const target = dayWord === 'ieri'
      ? (context.day === today ? shiftDay(today, -1) : context.day)
      : today;
    return answerLeadDay(client, title, target, dayWord);
  }
  // «il primo lead» / «chi è il primo lead di oggi|ieri?» names one person,
  // never the whole list: primo wins over the lead-day list, reading the
  // explicit day (or the previous lead-day context, or today) and then
  // formatting only its first entry through the primo path.
  if (wantsPrimo && hasLead) {
    const hasIeri = /\bieri\b/.test(folded);
    const hasOggi = /\boggi\b/.test(folded);
    const target = hasIeri ? shiftDay(today, -1)
      : hasOggi ? today
      : (context?.kind === 'lead-day' && typeof context?.day === 'string' && context.day !== '' ? context.day : today);
    const word = hasIeri ? 'ieri' : hasOggi ? 'oggi'
      : (typeof context?.dayWord === 'string' && context.dayWord !== '' ? context.dayWord : (target === today ? 'oggi' : 'ieri'));
    const dayAnswer = await answerLeadDay(client, title, target, word);
    return answerPrimo(title, dayAnswer.context, dayAnswer);
  }
  if (hasLead) {
    const day = dayWord === 'ieri' ? shiftDay(today, -1) : today;
    return answerLeadDay(client, title, day, dayWord);
  }
  if (wantsPrimo) return answerPrimo(title, context);
  return null;
}

export async function runSuggestion(client, suggestionId, customer = null) {
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
    case 'bo04:scheda:cambia-telefono': return answerSchedaTelefono(client, customer);
    case 'bo04:scheda:aggiungi-nota': return answerSchedaNota(client, customer);
    default: throw new Error(`Suggerimento sconosciuto: ${shortText(suggestionId, 60) || '?'}`);
  }
}

/**
 * Which dry-run notice tells the truth about a non-live status: the key
 * sentence only for a really missing key, the off-in-this-space sentence
 * for a disabled space, the suggest-only line for anything else (absent
 * backend, unknown shape — the pilot serves suggestions only). Reads both
 * `code` and `reason`, mirroring packages/llm error codes.
 * @param {unknown} status
 */
export function assistantDisabledNotice(status) {
  const code = status !== null && typeof status === 'object'
    ? status.code ?? status.reason ?? status.errorCode
    : null;
  if (code === 'LLM_SECRET_UNAVAILABLE') return FREE_QUESTION_DISABLED_NOTICE;
  if (code === 'LLM_SPACE_DISABLED') return ASSISTANT_SPACE_DISABLED_NOTICE;
  return ASSISTANT_SUGGEST_ONLY_NOTICE;
}

/**
 * The assistant backend probe: live only when the server publishes the
 * assistant status with free questions enabled. Anything else — 404, a
 * disabled flag, a network failure — is dry-run: the panel stays usable,
 * the free-question box is hidden, and the notice names the real reason.
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
    return {
      mode: 'dry-run', freeQuestions: 'disabled', endpoint: null, notice: assistantDisabledNotice(status),
    };
  } catch (error) {
    // Absent backend (today): dry-run, never a failure. A refusal carrying
    // a stable code still names its reason.
    return {
      mode: 'dry-run', freeQuestions: 'disabled', endpoint: null, notice: assistantDisabledNotice(error),
    };
  }
}

/**
 * One free question. Data questions over space records («quanti lead
 * oggi?», «e ieri?», «chi è il primo?») are answered locally first — pure
 * reads, no key, no backend, no spend — in live and in dry-run alike. In
 * dry-run anything else is refused with the status notice (or the
 * suggest-only line when the status carries none) before any request
 * leaves the panel — zero requests, never a silent call.
 * @param {{ request: (path: string, options?: object) => Promise<any> }} client
 * @param {{ mode: string, endpoint?: string | null }} status
 * @param {unknown} question
 * @param {unknown} [context] the previous free answer's context, for follow-ups
 */
export async function askFreeQuestion(client, status, question, context = null) {
  const text = typeof question === 'string' ? question.trim().replace(/\s+/g, ' ') : '';
  if (text === '') throw new Error('Scrivi una domanda prima di inviarla.');
  if (text.length > FREE_QUESTION_MAX_LENGTH) {
    throw new Error(`La domanda è troppo lunga (massimo ${FREE_QUESTION_MAX_LENGTH} caratteri).`);
  }
  // Voce 34fd687c: deterministic data answers need no backend — Dan's
  // «quanti lead oggi??» is answered from the space's own records even
  // while free questions stay off, with named sources and buttons.
  const local = await answerFreeLocal(client, text, context);
  if (local !== null) {
    return { ok: true, disabled: false, answer: local };
  }
  const refusal = typeof status?.notice === 'string' && status.notice !== ''
    ? status.notice
    : ASSISTANT_SUGGEST_ONLY_NOTICE;
  if (status?.mode !== 'live' || typeof status?.endpoint !== 'string') {
    return { ok: false, disabled: true, notice: refusal };
  }
  // Re-validate the contract here instead of trusting status.endpoint: a
  // direct caller passing { mode: 'live', endpoint: '/api/...' } must never
  // steer the question text at an arbitrary route. Anything off-contract is
  // dry-run, with zero requests.
  if (status.endpoint !== ASSISTANT_ASK_PATH) {
    return { ok: false, disabled: true, notice: refusal };
  }
  // One fresh submission-owned key per question: keys come from the Admin
  // submission controller (KEY_RE) so the real client gate accepts them, and
  // the full question text is never truncated into a colliding identity.
  const questionKey = issueAdminKey();
  const body = await client.request(status.endpoint, {
    method: 'POST',
    body: { question: text },
    idempotencyKey: questionKey,
    headers: { 'Idempotency-Key': questionKey },
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
  // The backend did the reading: the trace records its endpoint and what it
  // returned, so a free answer is inspectable exactly like a suggestion.
  const trace = {
    suggestionId: 'bo04:domanda-libera',
    title: text,
    at: new Date().toISOString(),
    reads: [{ target: 'assistant-ask', limit: null, status: 'ok', rows: lines.length }],
    executions: [],
  };
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
      trace,
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
 * @param {{ navigate?: (href: string) => void, confirmedActionId?: string | null, idempotencyKey?: string, trace?: Array<TraceExecution> }} options
 */
export async function runAssistantAction(client, action, options = {}) {
  const {
    navigate = () => {}, confirmedActionId = null, idempotencyKey = null, trace = null,
  } = options;
  const actionId = action !== null && typeof action === 'object' && typeof action.id === 'string' && action.id !== ''
    ? action.id
    : shortText(action?.label, 60) || '?';
  // Every gate step lands in the answer trace (BO-F4-04) when the caller
  // passes it: gated refusals and failures record before they return/throw,
  // so the trace shows the attempt, not only the successes.
  const recordExecution = (outcome, detail) => {
    if (Array.isArray(trace)) {
      trace.push({ actionId, at: new Date().toISOString(), outcome, detail: shortText(detail, 120) });
    }
  };
  /**
   * @param {string} message
   * @returns {never}
   */
  const fail = (message) => {
    recordExecution('failed', message);
    throw new Error(message);
  };
  if (action === null || typeof action !== 'object' || typeof action.id !== 'string' || action.id === '') {
    fail('Azione dell’assistente non valida.');
  }
  if (action.kind !== 'navigate' && action.kind !== 'api') {
    fail(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: tipo sconosciuto.`);
  }
  if (actionNeedsConfirmation(action) && confirmedActionId !== action.id) {
    recordExecution('needs-confirmation', typeof action.confirmLabel === 'string' && action.confirmLabel !== '' ? action.confirmLabel : 'conferma richiesta');
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
      fail(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: destinazione non valida.`);
    }
    navigate(action.href);
    recordExecution('executed', action.href);
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
    fail(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: richiesta non consentita.`);
  }
  let actionConversationId;
  try {
    actionConversationId = decodeURIComponent(actionMatch[1]);
  } catch {
    fail(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: richiesta non consentita.`);
  }
  if (!isSafeRecordId(actionConversationId)) {
    fail(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: richiesta non consentita.`);
  }
  if ((request.method ?? 'POST') !== 'POST') {
    fail(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: richiesta non consentita.`);
  }
  if (request.body !== undefined
    && (request.body === null || typeof request.body !== 'object'
      || Array.isArray(request.body) || Object.keys(request.body).length !== 0)) {
    fail(`Azione “${shortText(action.label, 60) || action.id}” non eseguibile: richiesta non consentita.`);
  }
  // Mutations run on the real Admin client only with a submission-owned key
  // (admin-submission.js KEY_RE): an explicit caller key is honored, the
  // default is issued here so the panel never hand-rolls 'assistant:*' keys
  // the real gate rejects.
  const key = typeof idempotencyKey === 'string' && idempotencyKey !== '' ? idempotencyKey : issueAdminKey();
  // A rejected request keeps its original error identity (status, code) for
  // the panel: the trace only notes the attempt before it propagates.
  let result;
  try {
    result = await client.request(request.path, {
      method: request.method ?? 'POST',
      body: request.body ?? {},
      idempotencyKey: key,
      headers: { 'Idempotency-Key': key },
    });
  } catch (error) {
    recordExecution('failed', error instanceof Error ? error.message : 'Azione fallita.');
    throw error;
  }
  recordExecution('executed', request.path);
  return { ok: true, needsConfirmation: false, result };
}

/**
 * @param {any} doc
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 */
import { el } from './admin-ui.js'; // BO-F6-02: the single component library.

/**
 * The ⌘K side panel: suggestions for the current screen, answers with
 * clickable sources, linked actions with the confirmation gate, the
 * execution trace of every answer (BO-F4-04, kept in the session history),
 * and the free-question box (disabled with the key message in dry-run).
 * @param {{ doc: any, mount: any, client: any, navigate?: (href: string) => void, notify?: (message: string) => void }} options
 */
export function createAssistantPanel({ doc, mount, client, navigate = () => {}, notify = () => {}, spaceId = null } = {}) {
  if (!doc || !mount || !client) throw new Error('Il pannello assistente richiede doc, mount e client.');
  // backlog:33782ba68747: «@Agente …» writes through the mutation-bound
  // client (Idempotency-Key), scoped to the shell's active space.
  const readSpace = typeof spaceId === 'function' ? spaceId : () => null;
  /** @type {any} */
  let boundClient = null;
  /** The «@Agente» intent in flight, kept until it succeeds (review #661 P1). @type {any} */
  let pendingAttempt = null;
  const bound = () => {
    if (boundClient === null) boundClient = bindAdminMutations(client).client;
    return boundClient;
  };
  const state = {
    /**
     * backlog:33782ba68747: the «@Agente …» request in flight, or null.
     * @type {null | { typed: string, status: string, agent?: any, instruction?: string, rest?: string, agents?: Array<any>, message?: string, busy?: boolean, once?: boolean, space?: string | null }}
     */
    mention: null,
    open: false,
    screenId: 'oggi',
    status: null,
    answer: null,
    history: [],
    busy: false,
    pendingConfirmId: null,
    error: '',
    draft: null,
    // Review #596 P2: a top-bar question asked while an answer is still
    // running waits here (only the newest one) and starts when it ends.
    queued: null,
    // Voce 34fd687c: the last free data answer's context (lead-day list),
    // so «e ieri?» and «chi è il primo?» keep the thread. In-session only,
    // like the history — never persisted.
    freeContext: null,
  };
  // Every open() takes a generation: a slow status probe never lets an older
  // opening overwrite a newer question.
  let openGeneration = 0;

  // Keep every finished answer for the session (BO-F4-04): conserved, newest
  // last, capped so a long shift never grows the panel without bounds.
  function pushHistory(answer) {
    if (!answer || typeof answer.suggestionId !== 'string') return;
    state.history.push(answer);
    while (state.history.length > ASSISTANT_HISTORY_LIMIT) state.history.shift();
  }

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

  /**
   * The execution trace of one answer (BO-F4-04): every read the builders
   * performed (surface, bound, rows) plus every action step the operator
   * took on it. Text only, through the same textContent-only renderer as
   * the rest of the panel — hostile strings stay inert here too.
   * @param {Answer} answer
   */
  function renderTrace(answer) {
    const trace = answer?.trace;
    if (!trace || !Array.isArray(trace.reads) || trace.reads.length === 0) return null;
    // Collapsed by default (Dan 04/11): the reads are proof for whoever
    // wants it, not the answer — «Come ho risposto» opens them.
    const wrap = el(doc, 'details', 'bo-assistant-trace');
    wrap.appendChild(el(doc, 'summary', 'bo-assistant-trace-summary', 'Come ho risposto · Traccia di esecuzione'));
    const list = el(doc, 'ul', 'bo-assistant-trace-list');
    for (const read of trace.reads) {
      if (!read || typeof read.target !== 'string') continue;
      const bound = typeof read.limit === 'number' ? ` (limite ${read.limit})` : '';
      const text = read.status === 'ok'
        ? `${read.target}: ${read.rows} righe lette${bound}`
        : read.status === 'invalid'
          ? `${read.target}: risposta non valida, ignorata`
          : `${read.target}: non leggibile in questo spazio`;
      const item = el(doc, 'li', 'bo-assistant-trace-read', text);
      list.appendChild(item);
    }
    if (list.childNodes.length === 0) return null;
    wrap.appendChild(list);
    const executions = Array.isArray(trace.executions) ? trace.executions : [];
    if (executions.length === 0) {
      wrap.appendChild(el(doc, 'p', 'bo-assistant-trace-empty', 'Azioni eseguite: nessuna finora.'));
    }
    for (const execution of executions) {
      if (!execution || typeof execution.actionId !== 'string') continue;
      const clock = romeClock(execution.at);
      const at = clock !== '' ? ` alle ${clock}` : '';
      const outcome = execution.outcome === 'executed'
        ? 'eseguita'
        : execution.outcome === 'needs-confirmation'
          ? 'in attesa di conferma'
          : `fallita: ${shortText(execution.detail, 80)}`;
      wrap.appendChild(el(doc, 'p', 'bo-assistant-trace-execution', `${execution.actionId}: ${outcome}${at}`));
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
    const trace = renderTrace(answer);
    if (trace) box.appendChild(trace);
    for (const note of answer.unavailable ?? []) {
      box.appendChild(el(doc, 'p', 'bo-assistant-unavailable', String(note)));
    }
    return box;
  }

  // Past answers of this session, newest last (BO-F4-04): reopening one
  // shows its conserved trace, it never reruns the reads.
  function renderHistory() {
    if (state.history.length < 2) return null;
    const wrap = el(doc, 'div', 'bo-assistant-history');
    wrap.appendChild(el(doc, 'p', 'bo-assistant-heading', 'Cronologia'));
    const list = el(doc, 'ul', 'bo-assistant-history-list');
    for (const entry of state.history) {
      if (!entry || typeof entry.title !== 'string') continue;
      // Local space time (Europe/Rome), never a UTC stamp (voce 52854fd292a3).
      const at = romeClock(entry.trace?.at);
      const item = el(doc, 'li', 'bo-assistant-history-item');
      const button = el(doc, 'button', 'bo-assistant-history-open', at !== '' ? `${entry.title} — ${at}` : entry.title);
      button.addEventListener('click', () => {
        state.answer = entry;
        state.pendingConfirmId = null;
        state.error = '';
        render();
      });
      item.appendChild(button);
      list.appendChild(item);
    }
    if (list.childNodes.length === 0) return null;
    wrap.appendChild(list);
    return wrap;
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
        trace: Array.isArray(state.answer?.trace?.executions) ? state.answer.trace.executions : null,
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
      releaseBusy();
    }
  }

  async function runSuggestionById(suggestionId) {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    state.pendingConfirmId = null;
    render();
    try {
      state.answer = await runSuggestion(client, suggestionId, state.customerCtx);
      pushHistory(state.answer);
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Suggerimento fallito.';
    } finally {
      releaseBusy();
    }
  }

  async function submitFreeQuestion(question) {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    state.draft = null;
    render();
    try {
      const outcome = await askFreeQuestion(client, state.status ?? { mode: 'dry-run' }, question, state.freeContext);
      if (outcome.disabled === true) {
        state.error = outcome.notice;
      } else if (outcome.answer) {
        state.answer = outcome.answer;
        state.freeContext = outcome.answer.context ?? null;
        pushHistory(state.answer);
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Domanda fallita.';
    } finally {
      releaseBusy();
    }
  }

  /**
   * The one way out of «busy» (review #596 P1): every busy owner — a
   * suggestion, a free question, a confirmed action — ends here, so a
   * question queued meanwhile always starts.
   */
  function releaseBusy() {
    state.busy = false;
    render();
    drainQueued();
  }

  /**
   * The one close (review #596 P2): the header ✕ and the public close()
   * both cancel what waits — no queued question and no slow probe may
   * reopen the panel afterwards.
   */
  function doClose() {
    state.open = false;
    state.queued = null;
    openGeneration += 1;
    render();
  }

  /** Start the question that waited for the running answer, if any. */
  function drainQueued() {
    if (state.queued === null || !state.open) return;
    const next = state.queued;
    state.queued = null;
    void openPanel(next.screenId, next.draft, next.customer, next.question);
  }

  async function openPanel(screenId, draft, customer, question) {
    const typed = typeof question === 'string' ? question.trim() : '';
    // Busy with an answer: the new question waits (newest wins) and the panel
    // says so — the running answer never lands under the wrong question.
    if (state.busy && typed !== '') {
      state.open = true;
      state.queued = { screenId, draft, customer, question: typed };
      render();
      return;
    }
    const generation = (openGeneration += 1);
    // Review #596 P2: nothing shared changes before the probe answers — a
    // run started meanwhile keeps its screen, draft and asked header.
    const status = await probeAssistantBackend(client);
    if (generation !== openGeneration) return;
    if (state.busy && typed !== '') {
      state.open = true;
      state.queued = { screenId, draft, customer, question: typed };
      render();
      return;
    }
    state.open = true;
    if (typeof screenId === 'string' && screenId !== '') state.screenId = screenId;
    state.draft = typeof draft === 'string' && draft !== '' ? draft : null;
    state.customerCtx = schedaCustomer(customer);
    state.asked = null;
    state.status = status;
    // A new question never shows the previous answer (review #596 P1).
    if (typed !== '') {
      state.answer = null;
      state.error = '';
      state.pendingConfirmId = null;
      state.mention = null;
    }
    if (typed === '') {
      render();
      return;
    }
    // backlog:33782ba68747: «@Nome …» talks to an agent of this space, in
    // every mode — it is an instruction to a colleague, not a question.
    if (typed.startsWith('@')) {
      await startMention(typed);
      return;
    }
    // A question typed in the top bar (Dan 05/11): live → the free
    // question; otherwise the closest suggestion runs, and the panel says
    // which one — the words are never silently dropped.
    if (state.status?.mode === 'live') {
      await submitFreeQuestion(typed);
      return;
    }
    // Voce 34fd687c: data questions («quanti lead oggi?») are answered
    // from the space's own records even in dry-run — named customers,
    // never UUIDs. Anything else falls through to the closest suggestion.
    state.busy = true;
    state.error = '';
    render();
    let local = null;
    try {
      local = await answerFreeLocal(client, typed, state.freeContext);
    } catch {
      local = null;
    }
    if (local !== null) {
      state.answer = local;
      state.freeContext = local.context ?? null;
      pushHistory(local);
      state.asked = null;
      releaseBusy();
      return;
    }
    state.busy = false;
    render();
    const match = closestSuggestion(state.screenId, typed);
    state.asked = { text: typed, matched: match ? match.title : null };
    if (match) {
      await runSuggestionById(match.id);
      return;
    }
    render();
    // No local answer and no suggestion match: the queued #596 question
    // still starts — this path drains like every other busy exit.
    drainQueued();
  }

  /** Resolve «@Nome …» against this space's agents (backlog:33782ba68747). */
  async function startMention(typed) {
    const space = readSpace();
    state.asked = null;
    state.mention = { typed, status: 'loading', space };
    render();
    const agents = await loadSpaceAgents(client, space);
    // A newer question or a space switch meanwhile wins (review #661 P3).
    if (state.mention === null || state.mention.typed !== typed || state.mention.space !== space) return;
    if (agents === null) {
      state.mention = { typed, status: 'unavailable', space };
    } else {
      const found = findMentionedAgent(typed, agents);
      if (!found || !found.agent) {
        const word = found?.typedName ?? '';
        state.mention = { typed, status: 'unknown', agents, rest: typed.slice(1 + word.length).trim(), space };
      } else if (found.instruction === '') {
        state.mention = { typed, status: 'empty', agent: found.agent, space };
      } else {
        state.mention = { typed, status: 'confirm', agent: found.agent, instruction: found.instruction, space };
      }
    }
    render();
  }

  /** Hand the instruction to the agent through create-assignment. */
  async function confirmMention(once) {
    const mention = state.mention;
    if (!mention || mention.busy || !mention.agent || !mention.instruction || !mention.space) return;
    // Review #661 P2: the space may have changed since the card resolved.
    // Never post to the space left behind: resolve again in the active one.
    if (readSpace() !== mention.space) {
      await startMention(mention.typed);
      return;
    }
    mention.busy = true;
    mention.once = once;
    // Review #661 P1: one intent keeps one sourceKey and key across retries.
    pendingAttempt = assignAttempt(pendingAttempt, {
      spaceId: mention.space, agentSourceKey: mention.agent.sourceKey, phrase: mention.instruction,
    });
    render();
    try {
      const made = await assignToAgent(bound(), pendingAttempt, { once });
      pendingAttempt = null;
      mention.status = 'done';
      mention.message = `Fatto: ${mention.agent.name} ha l’incarico «${mention.instruction}» (${made ? describeSchedule(made).toLowerCase() : 'registrato'}).`;
      // A card cancelled meanwhile stays quiet (review #661 P3).
      if (state.mention === mention) notify(`Incarico dato a ${mention.agent.name}`);
    } catch (error) {
      if (isPhraseUnclear(error)) {
        mention.status = 'unclear';
      } else {
        mention.status = 'error';
        mention.message = assignErrorText(error);
      }
    } finally {
      mention.busy = false;
      render();
    }
  }

  function agentsLink() {
    const link = el(doc, 'a', 'bo-assistant-source-link', 'Apri Agenti');
    link.setAttribute('href', '#/agenti');
    link.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      navigate('#/agenti');
    });
    return link;
  }

  /** The «@Agente» card: who, what, and one explicit confirm before writing. */
  function renderMention() {
    const mention = state.mention;
    if (!mention) return null;
    const box = el(doc, 'div', 'bo-assistant-answer bo-assistant-agent');
    box.appendChild(el(doc, 'p', 'bo-assistant-asked-text', `«${shortText(mention.typed, 140)}»`));
    const say = (line) => box.appendChild(el(doc, 'p', 'bo-assistant-line', line));
    switch (mention.status) {
      case 'loading':
        say('Cerco l’agente…');
        break;
      case 'unavailable':
        say('Gli agenti non sono ancora disponibili in questo spazio.');
        break;
      case 'unknown': {
        const agents = Array.isArray(mention.agents) ? mention.agents : [];
        if (agents.length === 0) {
          say('Non hai ancora agenti nel team: aggiungine uno dal catalogo.');
          box.appendChild(agentsLink());
          break;
        }
        say('Non trovo un agente con questo nome. Agenti del team:');
        const chips = el(doc, 'div', 'bo-assistant-chips');
        for (const agent of agents) {
          if (typeof agent?.name !== 'string' || agent.name.trim() === '') continue;
          const chip = el(doc, 'button', 'bo-assistant-suggestion', `@${agent.name}`);
          chip.setAttribute('type', 'button');
          chip.addEventListener('click', () => {
            void startMention(`@${agent.name} ${mention.rest ?? ''}`.trim());
          });
          chips.appendChild(chip);
        }
        box.appendChild(chips);
        break;
      }
      case 'empty':
        say(`Cosa deve fare ${mention.agent.name}? Scrivi «@${mention.agent.name}» e l’incarico nella barra in alto.`);
        break;
      case 'confirm':
      case 'unclear': {
        say(`Incarico per ${mention.agent.name}: «${shortText(mention.instruction, 200)}»`);
        if (mention.status === 'unclear') say(PHRASE_UNCLEAR_NOTE);
        const actions = el(doc, 'div', 'bo-assistant-actions');
        const go = el(doc, 'button', 'bo-assistant-confirm', mention.status === 'unclear'
          ? 'Fallo una volta, adesso'
          : `Affida a ${mention.agent.name}`);
        go.setAttribute('type', 'button');
        go.setAttribute('data-action', mention.status === 'unclear' ? 'agent-once' : 'agent-assign');
        go.disabled = mention.busy === true;
        go.addEventListener('click', () => { void confirmMention(mention.status === 'unclear'); });
        actions.appendChild(go);
        const cancel = el(doc, 'button', 'bo-assistant-cancel', 'Annulla');
        cancel.setAttribute('type', 'button');
        cancel.disabled = mention.busy === true;
        cancel.addEventListener('click', () => { state.mention = null; render(); });
        actions.appendChild(cancel);
        box.appendChild(actions);
        break;
      }
      case 'done':
        say(String(mention.message ?? ''));
        box.appendChild(agentsLink());
        break;
      default: {
        box.appendChild(el(doc, 'p', 'bo-assistant-error', String(mention.message ?? 'Qualcosa non è andato.')));
        // Retry the same intent: same sourceKey, never a second incarico.
        const retry = el(doc, 'button', 'bo-assistant-confirm', 'Riprova');
        retry.setAttribute('type', 'button');
        retry.setAttribute('data-action', 'agent-retry');
        retry.disabled = mention.busy === true;
        retry.addEventListener('click', () => { void confirmMention(mention.once === true); });
        box.appendChild(retry);
      }
    }
    return box;
  }

  function render() {
    clearMount();
    if (!state.open) return;
    const panel = el(doc, 'aside', 'bo-assistant');
    panel.setAttribute('aria-label', 'Assistente');
    const header = el(doc, 'div', 'bo-assistant-header');
    header.appendChild(el(doc, 'h2', 'bo-assistant-name', 'Assistente'));
    const live = state.status?.mode === 'live';
    header.appendChild(el(doc, 'span', 'bo-assistant-mode', live ? 'AI attiva' : 'solo suggerimenti'));
    const close = el(doc, 'button', 'bo-assistant-close', '✕');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Chiudi assistente');
    close.addEventListener('click', () => doClose());
    header.appendChild(close);
    panel.appendChild(header);

    // Conversation column (Dan 04/11, design): answer first as a card,
    // suggestions as chips, history and errors under it; the question box
    // stays pinned at the bottom like a chat.
    const scroll = el(doc, 'div', 'bo-assistant-scroll');
    if (state.asked && typeof state.asked.text === 'string') {
      const asked = el(doc, 'div', 'bo-assistant-asked');
      asked.appendChild(el(doc, 'p', 'bo-assistant-asked-text', `«${shortText(state.asked.text, 140)}»`));
      asked.appendChild(el(doc, 'p', 'bo-assistant-asked-note', state.asked.matched
        ? `Le domande libere non sono ancora attive: rispondo con «${state.asked.matched}».`
        : 'Le domande libere non sono ancora attive: scegli una delle domande qui sotto.'));
      scroll.appendChild(asked);
    }
    if (state.queued !== null) {
      const waiting = el(doc, 'div', 'bo-assistant-asked');
      waiting.setAttribute('data-queued', 'true');
      waiting.appendChild(el(doc, 'p', 'bo-assistant-asked-text', `«${shortText(state.queued.question, 140)}»`));
      waiting.appendChild(el(doc, 'p', 'bo-assistant-asked-note', 'Finisco la risposta in corso, poi rispondo a questa.'));
      scroll.appendChild(waiting);
    }
    const mentionBox = renderMention();
    if (mentionBox) scroll.appendChild(mentionBox);
    const answer = renderAnswer();
    if (!answer && !state.busy && !state.asked && !mentionBox) {
      const hello = el(doc, 'div', 'bo-assistant-hello');
      hello.appendChild(el(doc, 'p', 'bo-assistant-hello-title', 'Cosa vuoi sapere?'));
      hello.appendChild(el(doc, 'p', 'bo-assistant-hello-text', 'Rispondo leggendo i dati di questo spazio e ti porto alla scheda giusta.'));
      scroll.appendChild(hello);
    }
    if (answer) scroll.appendChild(answer);
    if (state.busy) {
      scroll.appendChild(el(doc, 'p', 'bo-assistant-busy', 'Lavoro in corso…'));
    }
    if (state.error !== '') {
      scroll.appendChild(el(doc, 'p', 'bo-assistant-error', state.error));
    }
    const list = el(doc, 'div', 'bo-assistant-suggestions');
    list.appendChild(el(doc, 'p', 'bo-assistant-heading', answer ? 'Altre domande' : 'Prova a chiedere'));
    const chips = el(doc, 'div', 'bo-assistant-chips');
    for (const suggestion of suggestionsFor(state.screenId)) {
      const button = el(doc, 'button', 'bo-assistant-suggestion', suggestion.title);
      button.setAttribute('type', 'button');
      button.setAttribute('title', suggestion.detail);
      button.addEventListener('click', () => {
        void runSuggestionById(suggestion.id);
      });
      chips.appendChild(button);
    }
    list.appendChild(chips);
    scroll.appendChild(list);
    const history = renderHistory();
    if (history) scroll.appendChild(history);
    panel.appendChild(scroll);

    // Free questions are not part of the MVP: without a live backend the
    // panel shows no free-question field at all — one honest line saying
    // the assistant here suggests replies (Suggerisci), with the reason the
    // status reported. The key sentence appears only for a really missing
    // key, never as the default.
    if (!live) {
      const notice = typeof state.status?.notice === 'string' && state.status.notice !== ''
        ? state.status.notice
        : ASSISTANT_SUGGEST_ONLY_NOTICE;
      panel.appendChild(el(doc, 'p', 'bo-assistant-notice bo-assistant-foot', notice));
      // BO-F5-01 draft handoff ("+ Nuovo modulo" -> assistant): with no live
      // backend there is no free-question field, but the caller's draft must
      // not vanish silently — show it as inert read-only text (text only via
      // el(), never markup, never a submit) next to the honest notice.
      if (typeof state.draft === 'string' && state.draft !== '') {
        panel.appendChild(el(doc, 'p', 'bo-assistant-draft bo-assistant-foot', state.draft));
      }
      mount.appendChild(panel);
      return;
    }
    const free = el(doc, 'form', 'bo-assistant-free');
    free.appendChild(el(doc, 'p', 'bo-assistant-heading bo-assistant-free-label', 'Domanda libera'));
    const row = el(doc, 'div', 'bo-assistant-free-row');
    const input = doc.createElement('input');
    input.setAttribute('type', 'search');
    input.setAttribute('class', 'bo-assistant-input ui-field'); // BO-F6-02: system field class.
    input.setAttribute('aria-label', 'Domanda libera');
    input.setAttribute('placeholder', 'Scrivi una domanda…');
    // A caller-drafted handoff (BO-F5-01 "+ Nuovo modulo"): the description
    // typed on the screen lands in the panel input, so the user never
    // retypes it. Text only — never markup, never a submit.
    if (typeof state.draft === 'string' && state.draft !== '') input.value = state.draft;
    row.appendChild(input);
    const send = el(doc, 'button', 'bo-assistant-send', 'Chiedi');
    send.setAttribute('type', 'submit');
    row.appendChild(send);
    free.appendChild(row);
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
     * @param {unknown} [draft] a caller-typed description: with a live
     * backend it prefills the free-question input (BO-F5-01), without one
     * it is shown as inert read-only text; anything else clears the draft.
     * @param {unknown} [customer] the customer in context
     * (`{ resource, id }`, validated like every record identity); anything
     * else clears the context, so a later screen never reuses a stale one.
     */
    open(screenId, draft, customer, question) {
      return openPanel(screenId, draft, customer, question);
    },
    close() {
      doClose();
    },
    getState() {
      return {
        open: state.open,
        screenId: state.screenId,
        customerCtx: state.customerCtx,
        mode: state.status?.mode ?? null,
        suggestionCount: suggestionsFor(state.screenId).length,
        answerTitle: state.answer?.title ?? null,
        sourceCount: Array.isArray(state.answer?.sources) ? state.answer.sources.length : 0,
        historyCount: state.history.length,
        traceReads: Array.isArray(state.answer?.trace?.reads) ? state.answer.trace.reads.length : 0,
        traceExecutions: Array.isArray(state.answer?.trace?.executions) ? state.answer.trace.executions.length : 0,
        pendingConfirmId: state.pendingConfirmId,
        error: state.error,
        mentionStatus: state.mention?.status ?? null,
      };
    },
  };
}
