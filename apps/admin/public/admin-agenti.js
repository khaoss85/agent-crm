// @ts-check

// backlog:33782ba68747 — Backoffice «Agenti»: the screen where Sequenze
// were. Agents are colleagues: «I tuoi agenti» (name, role, status,
// autonomy, spend this month, their assignments, a box to give them an
// instruction), «Da fare» (proposals waiting for a human) and «Catalogo»
// (ready-made agents to add).
//
// What it reuses, never duplicates (MEM_ACC_REUSE):
// - reads: the generic `/api/modules/:module/records` surface over the
//   `teammate-agent`, `teammate-assignment` and `teammate-run` managed
//   modules of packages/agents, scoped with `filter.spaceId`, plus the
//   checked-in catalogue at `GET /api/agents/catalog` (whose 404 means
//   «the agents package is not composed here»);
// - writes: `POST /api/agents/create` (create-agent, catalogue slugs only)
//   and `POST /api/agents/assign` (create-assignment), posted through the
//   bound submission client so the Admin mutation gate sees an
//   Idempotency-Key. Nothing else writes from here.
//
// Honest gaps, said on screen and never faked:
// - backlog:31a76b6f19a3: Approva, Rifiuta and Modifica post
//   `POST /api/agents/approve` { spaceId, runId },
//   `POST /api/agents/reject` { spaceId, runId, reason? } and
//   `POST /api/agents/revise` { spaceId, runId, index, payload } — the
//   run's id, never its source key; the deployment routes them through its
//   worker to approve-run, reject-run and revise-run. A deployment that
//   does not route one yet (404/405) reads «Non ancora disponibile in
//   questo spazio», never a technical error;
// - the deployment's worker runs due assignments (pilot#458): proposals
//   land in «Da fare», and each assignment says how its last run went;
// - «autonomia» is the package invariant, not a setting: every proposal
//   waits for a human approval, so the card says exactly that;
// - spend this month is summed from the run rows with the package's own
//   rule (packages/agents spentSince: positive costCents decided since the
//   first instant of the UTC month), never a stored number.
//
// Conventions follow apps/admin/public/admin-sequenze.js: pure DOM-free
// model builders (unit-tested under node:test with the fake DOM), and a
// renderer with createElement + textContent only — hostile agent names,
// phrases or proposals stay inert text.

import { bindAdminMutations, issueAdminKey } from './admin-submission.js';
import { formatAmount, humanWriteError } from './admin-core.js';
import { el, uiBadge, uiButton, uiEmpty } from './admin-ui.js';

/** How many rows each module read takes: one page, said out loud. */
export const AGENTI_READ_LIMIT = 200;

export const AGENT_STATUS_LABEL = Object.freeze({ active: 'Attivo', paused: 'In pausa' });

/** The one autonomy the package supports: proposals always wait. */
export const AGENT_AUTONOMY_LABEL = 'Chiede sempre il tuo ok';

/** A decision route this deployment does not serve yet (404/405): neutral (backlog:31a76b6f19a3). */
export const DA_FARE_UNAVAILABLE_NOTE = 'Non ancora disponibile in questo spazio.';

/** What «Da fare» holds when it is empty (backlog:31a76b6f19a3: the agents do run now). */
export const AGENTS_IDLE_NOTE = 'Quando un agente propone qualcosa, la proposta arriva qui e aspetta il tuo ok. '
  + 'Sotto ogni incarico vedi com’è andato l’ultimo giro.';

/** A move the server still holds: neutral, never an error (backlog:31a76b6f19a3). */
export const DA_FARE_PENDING_NOTE = 'Non ancora confermato: ricarica tra poco per vedere l’esito.';

/** The last run of an assignment in the operator's words (backlog:31a76b6f19a3). */
export const RUN_OUTCOME_LABEL = Object.freeze({
  started: 'in corso',
  proposed: 'proposte in «Da fare»',
  applied: 'approvato e applicato',
  artifact: 'niente da proporre',
  capped: 'fermo, tetto di spesa raggiunto',
  failed: 'non riuscito',
  rejected: 'rifiutato',
});

export const ASSIGNMENT_STATUS_LABEL = Object.freeze({
  active: 'Attivo',
  paused: 'In pausa',
  completed: 'Fatto',
});

const WEEKDAY_NAMES = Object.freeze(['', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica']);

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The Italian schedule of one assignment, from the machine shape the
 * package stored (cadence, weekday 1–7, timeOfDay). Unknown says so.
 * @param {any} assignment
 */
export function describeSchedule(assignment) {
  const time = typeof assignment?.timeOfDay === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(assignment.timeOfDay)
    ? ` alle ${assignment.timeOfDay}`
    : '';
  switch (assignment?.cadence) {
    case 'once': return 'Una volta';
    case 'daily': return `Ogni giorno${time}`;
    case 'weekly': {
      const day = WEEKDAY_NAMES[Number(assignment.weekday)] ?? '';
      return day !== '' ? `Ogni ${day}${time}` : `Ogni settimana${time}`;
    }
    case 'monthly': return `Ogni mese${time}`;
    default: return 'Quando non è chiaro';
  }
}

/** First instant of the UTC month of `nowIso`, like packages/agents monthStartIso. @param {string} nowIso */
export function monthStartMs(nowIso) {
  const ms = Date.parse(nowIso);
  // Fail closed (review #661 P3): an unreadable clock is NaN, and every
  // comparison with NaN is false, so no run counts — never all of them.
  if (!Number.isFinite(ms)) return NaN;
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/**
 * Cents spent this month by one agent, summed from its run rows with the
 * package rule (spentSince): a run counts by decidedAt (else startedAt)
 * from the month start, and only a positive integer costCents counts.
 * @param {Array<any>} runs @param {string} agentSourceKey @param {string} nowIso
 */
export function spentThisMonthCents(runs, agentSourceKey, nowIso) {
  const start = monthStartMs(nowIso);
  if (!Number.isFinite(start)) return 0;
  let total = 0;
  for (const run of runs ?? []) {
    if (!run || typeof run !== 'object' || run.agentSourceKey !== agentSourceKey) continue;
    const raw = typeof run.decidedAt === 'string' && run.decidedAt !== '' ? run.decidedAt : run.startedAt;
    const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
    if (!Number.isFinite(at) || at < start) continue;
    if (Number.isInteger(run.costCents) && run.costCents > 0) total += run.costCents;
  }
  return total;
}

/** Two-letter avatar from the agent name. @param {unknown} name */
export function agentInitials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[1][0]}`;
  return letters.toUpperCase();
}

/**
 * The «I tuoi agenti» cards: one per agent row, with its assignments
 * (newest first), its spend this month and how many proposals wait.
 * @param {{ agents?: Array<any>, assignments?: Array<any>, runs?: Array<any>, nowIso: string }} input
 */
export function buildAgentCards({ agents = [], assignments = [], runs = [], nowIso }) {
  const cards = [];
  for (const agent of agents) {
    const key = text(agent?.sourceKey);
    const name = text(agent?.name);
    if (key === null || name === null) continue;
    const status = agent.status === 'paused' ? 'paused' : 'active';
    const own = assignments
      .filter((row) => row && row.agentSourceKey === key && text(row.phrase) !== null)
      .slice()
      .sort((a, b) => String(b.decidedAt ?? '').localeCompare(String(a.decidedAt ?? '')))
      .map((row) => ({
        sourceKey: String(row.sourceKey ?? ''),
        phrase: String(row.phrase).trim(),
        schedule: describeSchedule(row),
        status: assignmentStatusLabel(row, runs),
        lastRun: lastRunLine(runs, String(row.sourceKey ?? '')),
      }));
    const spentCents = spentThisMonthCents(runs, key, nowIso);
    cards.push({
      sourceKey: key,
      name,
      role: text(agent.role) ?? '',
      initials: agentInitials(name),
      status,
      statusLabel: AGENT_STATUS_LABEL[status],
      autonomy: AGENT_AUTONOMY_LABEL,
      spentCents,
      spentLabel: formatAmount(spentCents, 'EUR'),
      assignments: own,
      pending: runs.filter((run) => isDaFareRun(run) && run.agentSourceKey === key).length,
    });
  }
  return cards;
}

/**
 * Backlog 31a76b6f19a3: an active assignment reads «Attivo» once the worker
 * ran it at least once, or when it recurs with its next run scheduled;
 * «In attesa di partire» only while it never started.
 * @param {any} assignment @param {Array<any>} runs
 */
export function assignmentStatusLabel(assignment, runs) {
  if (assignment?.status !== 'active') return ASSIGNMENT_STATUS_LABEL[assignment?.status] ?? 'Stato sconosciuto';
  const key = String(assignment.sourceKey ?? '');
  const ran = key !== '' && (Array.isArray(runs) ? runs : []).some((run) => run && run.assignmentSourceKey === key);
  const recurring = assignment.cadence !== 'once' && Number.isFinite(Date.parse(String(assignment.nextRunAt ?? '')));
  return ran || recurring ? ASSIGNMENT_STATUS_LABEL.active : 'In attesa di partire';
}

/**
 * Backlog 31a76b6f19a3: how the last run of one assignment went —
 * «Ultimo giro: niente da proporre, 7 nov, 14:30» — so a run that found
 * nothing to propose is seen somewhere. Null when the assignment never ran.
 * @param {Array<any>} runs @param {string} assignmentSourceKey
 * @returns {string | null}
 */
export function lastRunLine(runs, assignmentSourceKey) {
  if (assignmentSourceKey === '') return null;
  const at = (run) => String(run?.decidedAt ?? run?.startedAt ?? '');
  const last = (Array.isArray(runs) ? runs : [])
    .filter((run) => run && run.assignmentSourceKey === assignmentSourceKey && Object.hasOwn(RUN_OUTCOME_LABEL, String(run.outcome)))
    .sort((a, b) => at(b).localeCompare(at(a)))[0];
  if (!last) return null;
  const stamp = romeStamp(at(last) || null);
  return `Ultimo giro: ${RUN_OUTCOME_LABEL[last.outcome]}${stamp === '' ? '' : `, ${stamp}`}`;
}

/**
 * One predicate for «waits in Da fare» (review #661): a proposed run with a
 * readable key. The card counter and the Da fare list both use it, so the
 * count never disagrees with the list.
 * @param {any} run
 */
export function isDaFareRun(run) {
  return Boolean(run && typeof run === 'object' && run.outcome === 'proposed' && text(run.sourceKey) !== null);
}

/**
 * The catalogue tiles: each ready-made agent, marked `added` when the
 * space already holds the agent its source key names.
 * @param {{ catalog?: Array<any>, agents?: Array<any> }} input
 */
export function buildCatalogItems({ catalog = [], agents = [] }) {
  const present = new Set(agents.map((row) => row?.sourceKey).filter((key) => typeof key === 'string'));
  return catalog
    .filter((entry) => text(entry?.slug) !== null && text(entry?.name) !== null)
    .map((entry) => ({
      slug: String(entry.slug),
      name: String(entry.name),
      role: text(entry.role) ?? '',
      instructions: text(entry.instructions) ?? '',
      examplePhrase: text(entry.examplePhrase) ?? '',
      added: typeof entry.agentSourceKey === 'string' && present.has(entry.agentSourceKey),
    }));
}

/**
 * One readable line for a stored proposal: its own summary or text when it
 * carries one, else the action key. Never parsed as markup.
 * @param {any} proposal
 */
function proposalLine(proposal) {
  const payload = proposal?.payload && typeof proposal.payload === 'object' ? proposal.payload : {};
  return text(payload.summary) ?? text(payload.text) ?? text(payload.title) ?? text(proposal?.action) ?? 'Azione senza nome';
}

/**
 * Backlog 31a76b6f19a3: the one text field «Modifica» edits in a proposal —
 * its text, else summary, else title — or null when it carries none.
 * @param {any} proposal
 * @returns {{ field: string, value: string } | null}
 */
function editableField(proposal) {
  const payload = proposal?.payload && typeof proposal.payload === 'object' ? proposal.payload : {};
  for (const field of ['text', 'summary', 'title']) {
    if (typeof payload[field] === 'string' && payload[field].trim() !== '') return { field, value: payload[field] };
  }
  return null;
}

/**
 * Whether a decision route is simply not served here (backlog
 * 31a76b6f19a3): a 405 from the mount, or a 404 that is not the agents
 * package refusing a known route (AGENT_RUN_UNKNOWN stays a real refusal).
 * @param {unknown} error
 */
export function isDecisionUnavailable(error) {
  const record = error && typeof error === 'object' ? /** @type {any} */ (error) : {};
  const code = typeof record.code === 'string' ? record.code : '';
  if (record.status === 405) return true;
  return record.status === 404 && !code.startsWith('AGENT_');
}

/**
 * «Da fare»: every run that proposed actions and waits for a human, newest
 * first, with the agent's name and the assignment phrase. Unreadable
 * stored proposals say so instead of vanishing.
 * @param {{ runs?: Array<any>, agents?: Array<any>, assignments?: Array<any> }} input
 */
export function buildDaFare({ runs = [], agents = [], assignments = [] }) {
  const names = new Map(agents.map((row) => [row?.sourceKey, text(row?.name)]));
  const phrases = new Map(assignments.map((row) => [row?.sourceKey, text(row?.phrase)]));
  return runs
    .filter(isDaFareRun)
    .slice()
    .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
    .map((run) => {
      let lines = [];
      /** @type {Array<{ index: number, field: string, value: string }>} */
      let edits = [];
      let unreadable = false;
      try {
        // Already-parsed arrays read as they are; any other shape is
        // unreadable, never an empty list (review #661 P3).
        const parsed = Array.isArray(run.proposals)
          ? run.proposals
          : JSON.parse(typeof run.proposals === 'string' ? run.proposals : (run.proposals == null ? '[]' : 'not-json'));
        lines = Array.isArray(parsed) ? parsed.map(proposalLine) : [];
        edits = Array.isArray(parsed) ? parsed.map(editableField).map((edit, index) => (edit ? { index, ...edit } : null)).filter(Boolean) : [];
        if (!Array.isArray(parsed)) unreadable = true;
      } catch {
        unreadable = true;
      }
      return {
        // Backlog 31a76b6f19a3: the run's id is what Approva sends — the
        // deployment refuses the source key (`run:<incarico>:<istante>`).
        runId: run.id == null || String(run.id).trim() === '' ? null : String(run.id).trim(),
        agentName: names.get(run.agentSourceKey) ?? 'Agente sconosciuto',
        phrase: phrases.get(run.assignmentSourceKey) ?? null,
        startedAt: typeof run.startedAt === 'string' ? run.startedAt : null,
        lines,
        edits,
        unreadable,
      };
    });
}

/** Lowercase, accents folded, spaces removed: «Report vendite» → «reportvendite». @param {string} value */
function foldName(value) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '');
}

/**
 * The @mention of a typed line: «@Riaggancio occupati dei lead…» →
 * { agent, instruction }. A name with spaces matches typed with or without
 * them («@Report vendite …», «@ReportVendite …»); the longest name wins.
 * Returns null when the line is not a mention; `agent: null` when it is a
 * mention of nobody in this space.
 * @param {unknown} line @param {Array<any>} agents
 */
export function findMentionedAgent(line, agents = []) {
  const typed = typeof line === 'string' ? line.trim() : '';
  if (!typed.startsWith('@')) return null;
  const rest = typed.slice(1);
  // A bare «@» names nobody: not a mention (review #661 P3).
  if (rest.trim() === '') return null;
  const candidates = agents
    .filter((row) => text(row?.name) !== null && text(row?.sourceKey) !== null)
    .slice()
    .sort((a, b) => String(b.name).length - String(a.name).length);
  for (const agent of candidates) {
    const wanted = foldName(String(agent.name));
    // Walk the typed text char by char, skipping spaces, until the folded
    // name is consumed; the next char must end the word.
    let consumed = '';
    let index = 0;
    while (index < rest.length && consumed.length < wanted.length) {
      const char = rest[index];
      if (!/\s/.test(char)) consumed += foldName(char);
      index += 1;
    }
    if (consumed !== wanted) continue;
    const next = rest[index] ?? '';
    if (next !== '' && /[\p{L}\p{N}]/u.test(next)) continue;
    const instruction = rest.slice(index).replace(/^[\s,:;.\-–—]+/, '').trim();
    return { agent, instruction };
  }
  const word = rest.split(/\s+/)[0] ?? '';
  return { agent: null, instruction: '', typedName: word };
}

/**
 * Read one page of a module. Throws on a failed read: the caller marks
 * that part unavailable instead of painting a fake zero.
 * @param {{ request: (path: string, options?: any) => Promise<any> }} client
 * @param {string} module @param {string | null} spaceId
 */
async function readModulePage(client, module, spaceId) {
  // One row past the page (review #661 P3): «capped» needs evidence that
  // something was left out, so exactly AGENTI_READ_LIMIT rows is not capped.
  const query = new URLSearchParams({ limit: String(AGENTI_READ_LIMIT + 1) });
  if (spaceId) query.set('filter.spaceId', spaceId);
  const answer = await client.request(`/api/modules/${module}/records?${query.toString()}`);
  const rows = Array.isArray(answer?.items) ? answer.items : [];
  return { rows: rows.slice(0, AGENTI_READ_LIMIT), capped: rows.length > AGENTI_READ_LIMIT };
}

/**
 * The agents of one space, for the @mention and the Team: `null` when the
 * package is not composed or the read failed (never an empty team).
 * @param {{ request: (path: string, options?: any) => Promise<any> }} client
 * @param {string | null} spaceId
 */
export async function loadSpaceAgents(client, spaceId) {
  if (!spaceId) return null;
  try {
    const page = await readModulePage(client, 'teammate-agent', spaceId);
    return page.rows;
  } catch {
    return null;
  }
}

/**
 * Everything the Agenti screen paints. Never throws: without the agents
 * package the screen says so; a failed part is named, never zeroed.
 * @param {{ request: (path: string, options?: any) => Promise<any> }} client
 * @param {string | null} spaceId
 */
export async function loadAgentiData(client, spaceId) {
  const outcome = {
    available: false,
    catalog: /** @type {Array<any>} */ ([]),
    agents: /** @type {Array<any>} */ ([]),
    assignments: /** @type {Array<any>} */ ([]),
    runs: /** @type {Array<any>} */ ([]),
    capped: false,
    unavailable: /** @type {Array<string>} */ ([]),
  };
  if (!spaceId) return outcome;
  try {
    const answer = await client.request(`/api/agents/catalog?spaceId=${encodeURIComponent(spaceId)}`);
    outcome.catalog = Array.isArray(answer?.agents) ? answer.agents : [];
    outcome.available = true;
  } catch {
    return outcome;
  }
  for (const [module, field, label] of [
    ['teammate-agent', 'agents', 'agenti'],
    ['teammate-assignment', 'assignments', 'incarichi'],
    ['teammate-run', 'runs', 'lavori fatti'],
  ]) {
    try {
      const page = await readModulePage(client, module, spaceId);
      outcome[field] = page.rows;
      if (page.capped) outcome.capped = true;
    } catch (error) {
      console.warn(`bo-agenti ${field} unreadable:`, error instanceof Error ? error.name : 'unknown');
      outcome.unavailable.push(label);
    }
  }
  return outcome;
}

/**
 * One user intent — this phrase, to this agent, in this space — and the
 * identities every retry of it reuses (review #661 P1): one assignment
 * sourceKey (the server's idempotency identity: create-assignment replays
 * a known key as `duplicate: true`), one Idempotency-Key per body, and the
 * «una volta» instant fixed at its first try. A lost response retried, or
 * a double submit, therefore never creates a second incarico. A different
 * phrase, agent or space is a new intent with new identities.
 * @param {any} previous the attempt kept from the last try, or null
 * @param {{ spaceId: string, agentSourceKey: string, phrase: string }} intent
 */
export function assignAttempt(previous, intent) {
  if (previous && previous.spaceId === intent.spaceId && previous.agentSourceKey === intent.agentSourceKey
    && previous.phrase === intent.phrase) return previous;
  return {
    spaceId: intent.spaceId,
    agentSourceKey: intent.agentSourceKey,
    phrase: intent.phrase,
    sourceKey: `bo-agent-assign:${issueAdminKey()}`,
    runAt: null,
    keys: { plain: null, once: null },
  };
}

/**
 * Give one agent an instruction through create-assignment. `once` is the
 * user's explicit «una volta, adesso» after a phrase with no schedule — the
 * screen never picks a plan on its own.
 * @param {{ request: (path: string, options?: any) => Promise<any> }} bound the mutation-bound client
 * @param {ReturnType<typeof assignAttempt>} attempt from assignAttempt — reused across retries
 * @param {{ once?: boolean, nowIso?: string }} [options]
 */
export async function assignToAgent(bound, attempt, options = {}) {
  const mode = options.once ? 'once' : 'plain';
  if (options.once && attempt.runAt === null) attempt.runAt = options.nowIso ?? new Date().toISOString();
  if (attempt.keys[mode] === null) attempt.keys[mode] = issueAdminKey();
  const body = {
    spaceId: attempt.spaceId,
    sourceKey: attempt.sourceKey,
    agentSourceKey: attempt.agentSourceKey,
    phrase: attempt.phrase,
    ...(options.once ? { plan: { cadence: 'once', runAt: attempt.runAt } } : {}),
  };
  const answer = await bound.request('/api/agents/assign', {
    method: 'POST',
    body,
    // Same body, same key; the «una volta» body has its own.
    idempotencyKey: attempt.keys[mode],
  });
  return answer?.assignment ?? null;
}

/** Whether a write failed only because the phrase names no schedule. @param {unknown} error */
export function isPhraseUnclear(error) {
  return Boolean(error && typeof error === 'object' && /** @type {any} */ (error).code === 'AGENT_PHRASE_UNCLEAR');
}

/** The one sentence under an instruction the parser could not place. */
export const PHRASE_UNCLEAR_NOTE = 'Non ho capito ogni quanto farlo. Puoi scrivere per esempio «ogni lunedì» o «ogni giorno», '
  + 'oppure farlo fare una volta sola, adesso.';

/** Italian message for a refused instruction. @param {unknown} error */
export function assignErrorText(error) {
  return humanWriteError(error, {
    failed: 'Non riesco a dare l’incarico adesso: riprova tra poco.',
    notComposed: 'Gli agenti non sono attivi in questo spazio.',
  });
}

/**
 * Agent rows for the Team (Spazi e accessi): the same row idiom as the
 * people, with an «Agente» badge. Returns null when there is nothing to
 * add, so the Team stays exactly as it was.
 * @param {any} doc @param {Array<any> | null} agents
 */
export function renderTeamAgentRows(doc, agents) {
  if (!Array.isArray(agents)) return null;
  const rows = agents.filter((row) => text(row?.name) !== null);
  if (rows.length === 0) return null;
  // Own classes (bo-agent-*), never bo-spazi-member: the people count of
  // the Team reads that class, and an agent is not a person.
  const wrap = el(doc, 'div', 'bo-agent-team');
  wrap.appendChild(el(doc, 'h4', 'bo-agent-team-title', 'Agenti di questo spazio'));
  for (const row of rows) {
    const item = el(doc, 'div', 'bo-agent-member');
    const identity = el(doc, 'div', 'bo-spazi-identity');
    const avatar = el(doc, 'span', 'bo-agent-avatar bo-agent-avatar-sm', agentInitials(row.name));
    avatar.setAttribute('aria-hidden', 'true');
    identity.appendChild(avatar);
    const names = el(doc, 'div', 'bo-spazi-names');
    names.appendChild(el(doc, 'div', 'bo-spazi-subject', String(row.name).trim()));
    names.appendChild(el(doc, 'div', 'bo-spazi-status', text(row.role) ?? ''));
    identity.appendChild(names);
    item.appendChild(identity);
    item.appendChild(uiBadge(doc, { authority: 'agent', text: 'Agente' }));
    const link = el(doc, 'a', 'bo-agent-team-link', AGENT_STATUS_LABEL[row.status === 'paused' ? 'paused' : 'active']);
    link.setAttribute('href', '#/agenti');
    item.appendChild(link);
    wrap.appendChild(item);
  }
  return wrap;
}

/** Local day and time of an instant, Europe/Rome, for the Da fare rows. @param {string | null} iso */
function romeStamp(iso) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '';
  try {
    return new Intl.DateTimeFormat('it-IT', {
      timeZone: 'Europe/Rome', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

/**
 * The Agenti screen.
 * @param {{ doc?: any, mount: any, client: any, submissions?: any, storage?: any, spaceId?: () => (string | null), navigate?: (hash: string) => void, now?: () => string }} deps
 */
export function createAgentiView({ doc = null, mount, client, submissions, storage, spaceId, navigate = () => {}, now = () => new Date().toISOString() }) {
  const documentNode = doc ?? (typeof document !== 'undefined' ? document : null);
  const { client: bound } = bindAdminMutations(client, { submissions, storage });
  const readSpace = typeof spaceId === 'function' ? spaceId : () => null;
  let renderToken = 0;
  const state = {
    loaded: false,
    available: false,
    space: /** @type {string | null} */ (null),
    catalog: /** @type {Array<any>} */ ([]),
    agents: /** @type {Array<any>} */ ([]),
    assignments: /** @type {Array<any>} */ ([]),
    runs: /** @type {Array<any>} */ ([]),
    capped: false,
    unavailable: /** @type {Array<string>} */ ([]),
    /** @type {Map<string, { text: string, busy: boolean, error: string, unclear: boolean, done: string, attempt: any }>} */
    drafts: new Map(),
    /** slug being added, or null */
    adding: /** @type {string | null} */ (null),
    /** @type {Map<string, string>} Idempotency-Key per (space, slug) add */
    addKeys: new Map(),
    addError: '',
    notice: '',
    /**
     * Backlog 31a76b6f19a3: one Approva per run id — busy while the request
     * flies (a double click sends one request), then a done/pending/error
     * line in Italian. The key stays the same until the answer is known.
     * @type {Map<string, { busy: boolean, pending: boolean, error: string, key: string | null }>}
     */
    decisions: new Map(),
  };

  function invalidate() {
    renderToken += 1;
  }

  function draftOf(key) {
    if (!state.drafts.has(key)) state.drafts.set(key, { text: '', busy: false, error: '', unclear: false, done: '', attempt: null });
    return /** @type {any} */ (state.drafts.get(key));
  }

  async function reload() {
    const token = ++renderToken;
    const data = await loadAgentiData(client, state.space);
    if (token !== renderToken) return false;
    state.available = data.available;
    state.catalog = data.catalog;
    state.agents = data.agents;
    state.assignments = data.assignments;
    state.runs = data.runs;
    state.capped = data.capped;
    state.unavailable = data.unavailable;
    state.loaded = true;
    return true;
  }

  async function addFromCatalog(slug) {
    if (readSpace() !== state.space) {
      await render();
      return;
    }
    if (state.adding !== null || !state.space) return;
    state.adding = slug;
    state.addError = '';
    state.notice = '';
    paint();
    try {
      // One key per (space, slug) until it succeeds (review #661 P3).
      const keyId = `${state.space}\u0000${slug}`;
      if (!state.addKeys.has(keyId)) state.addKeys.set(keyId, issueAdminKey());
      const answer = await bound.request('/api/agents/create', {
        method: 'POST',
        body: { spaceId: state.space, slug },
        idempotencyKey: state.addKeys.get(keyId),
      });
      state.addKeys.delete(keyId);
      const name = typeof answer?.agent?.name === 'string' ? answer.agent.name : 'L’agente';
      state.notice = answer?.duplicate === true ? `${name} era già nel tuo team.` : `${name} è entrato nel tuo team.`;
      state.adding = null;
      if (await reload()) paint();
    } catch (error) {
      state.adding = null;
      state.addError = humanWriteError(error, {
        failed: 'Non riesco ad aggiungere l’agente adesso: riprova tra poco.',
        notComposed: 'Gli agenti non sono attivi in questo spazio.',
      });
      paint();
    }
  }

  function decisionOf(runId) {
    if (!state.decisions.has(runId)) {
      state.decisions.set(runId, {
        busy: null, pending: false, unavailable: false, error: '', mode: null, reason: '', drafts: new Map(), keys: new Map(),
      });
    }
    return /** @type {any} */ (state.decisions.get(runId));
  }

  /**
   * Backlog 31a76b6f19a3: one decision on a Da fare run — Approva,
   * Rifiuta or Modifica — as one keyed POST with the run's id. While it
   * flies the row is locked (a double click sends one request); then an
   * Italian outcome. A queued answer (BO_*_PENDING) reads neutral and keeps
   * the row locked until the list is read again; a route this deployment
   * does not serve reads «Non ancora disponibile», never an error.
   * @param {any} item @param {'approve' | 'reject' | 'revise'} kind @param {Record<string, unknown>} extra
   */
  async function decide(item, kind, extra = {}) {
    if (readSpace() !== state.space) {
      await render();
      return;
    }
    if (!item.runId || !state.space) return;
    const decision = decisionOf(item.runId);
    if (decision.busy !== null || decision.pending) return;
    decision.busy = kind;
    decision.error = '';
    decision.unavailable = false;
    state.notice = '';
    const keyId = kind === 'revise' ? `revise:${String(extra.index)}:${JSON.stringify(extra.payload)}` : kind;
    if (!decision.keys.has(keyId)) decision.keys.set(keyId, issueAdminKey());
    paint();
    try {
      const answer = await bound.request(`/api/agents/${kind}`, {
        method: 'POST',
        body: { spaceId: state.space, runId: item.runId, ...extra },
        idempotencyKey: decision.keys.get(keyId),
      });
      if (kind === 'revise') {
        // The run keeps waiting in Da fare with the edited proposal.
        decision.busy = null;
        decision.mode = null;
        decision.keys.delete(keyId);
        state.notice = `Modifica salvata: la proposta di ${item.agentName} aspetta ancora il tuo ok.`;
      } else {
        state.decisions.delete(item.runId);
        state.notice = kind === 'approve'
          ? (answer?.duplicate === true
            ? `La proposta di ${item.agentName} era già approvata.`
            : `Approvato: la proposta di ${item.agentName} è applicata.`)
          : (answer?.duplicate === true
            ? `La proposta di ${item.agentName} era già rifiutata.`
            : `Rifiutata: la proposta di ${item.agentName} non sarà applicata.`);
      }
      if (await reload()) paint();
    } catch (error) {
      decision.busy = null;
      const code = typeof error?.code === 'string' ? error.code : '';
      if (/^BO_[A-Z_]*PENDING$/.test(code)) {
        // Still queued on the server: the outcome is unknown, never a
        // failure. Locked until the list is read again, so a second click
        // never queues a second decision.
        decision.pending = true;
      } else if (isDecisionUnavailable(error)) {
        decision.unavailable = true;
        decision.keys.delete(keyId);
      } else {
        decision.keys.delete(keyId);
        decision.error = humanWriteError(error, {
          failed: kind === 'approve'
            ? 'Non riesco ad approvare adesso: riprova tra poco.'
            : kind === 'reject'
              ? 'Non riesco a rifiutare adesso: riprova tra poco.'
              : 'Non riesco a salvare la modifica adesso: riprova tra poco.',
          notComposed: 'Gli agenti non sono attivi in questo spazio.',
        });
      }
      paint();
    }
  }

  async function sendInstruction(agent, once = false) {
    // Review #661: the shell space may have changed under this screen.
    // Never write to the space left behind: repaint on the active one.
    if (readSpace() !== state.space) {
      await render();
      return;
    }
    const draft = draftOf(agent.sourceKey);
    const phrase = draft.text.trim();
    if (draft.busy || phrase === '' || !state.space) return;
    draft.busy = true;
    draft.error = '';
    draft.done = '';
    paint();
    draft.attempt = assignAttempt(draft.attempt, { spaceId: state.space, agentSourceKey: agent.sourceKey, phrase });
    try {
      const made = await assignToAgent(bound, draft.attempt, { once, nowIso: now() });
      draft.busy = false;
      draft.unclear = false;
      draft.text = '';
      draft.attempt = null;
      draft.done = `Incarico dato a ${agent.name}: ${made ? describeSchedule(made).toLowerCase() : 'registrato'}.`;
      if (await reload()) paint();
    } catch (error) {
      draft.busy = false;
      if (isPhraseUnclear(error)) {
        draft.unclear = true;
      } else {
        draft.error = assignErrorText(error);
      }
      paint();
    }
  }

  function renderTop(page) {
    const top = el(documentNode, 'div', 'bo-seq-top bo-agenti-top');
    top.appendChild(el(documentNode, 'p', 'bo-kicker', 'MODULO NATIVO'));
    top.appendChild(el(documentNode, 'h2', 'bo-seq-title', 'Agenti'));
    top.appendChild(el(documentNode, 'p', 'lede',
      'Colleghi digitali che lavorano accanto a te. Gli dai un incarico come a una persona del team, e prima di fare qualcosa ti chiedono l’ok.'));
    page.appendChild(top);
  }

  function renderAgentCard(card) {
    const box = el(documentNode, 'article', 'bo-agent-card');
    box.setAttribute('data-agent', card.sourceKey);
    const head = el(documentNode, 'div', 'bo-agent-head');
    const avatar = el(documentNode, 'span', 'bo-agent-avatar', card.initials);
    avatar.setAttribute('aria-hidden', 'true');
    head.appendChild(avatar);
    const who = el(documentNode, 'div', 'bo-agent-who');
    who.appendChild(el(documentNode, 'h4', 'bo-agent-name', card.name));
    if (card.role !== '') who.appendChild(el(documentNode, 'p', 'bo-agent-role', card.role));
    head.appendChild(who);
    const status = el(documentNode, 'span', `bo-agent-status bo-agent-status-${card.status}`, card.statusLabel);
    head.appendChild(status);
    box.appendChild(head);

    const facts = el(documentNode, 'dl', 'bo-agent-facts');
    for (const [term, value] of [['Autonomia', card.autonomy], ['Speso questo mese', card.spentLabel], ['Da approvare', String(card.pending)]]) {
      const row = el(documentNode, 'div', 'bo-agent-fact');
      row.appendChild(el(documentNode, 'dt', null, term));
      row.appendChild(el(documentNode, 'dd', null, value));
      facts.appendChild(row);
    }
    box.appendChild(facts);

    if (card.assignments.length > 0) {
      const list = el(documentNode, 'ul', 'bo-agent-assignments');
      for (const assignment of card.assignments.slice(0, 5)) {
        const item = el(documentNode, 'li', 'bo-agent-assignment');
        item.appendChild(el(documentNode, 'p', 'bo-agent-phrase', `«${assignment.phrase}»`));
        item.appendChild(el(documentNode, 'p', 'bo-agent-when', `${assignment.schedule} · ${assignment.status}`));
        if (assignment.lastRun) item.appendChild(el(documentNode, 'p', 'bo-agent-lastrun', assignment.lastRun));
        list.appendChild(item);
      }
      box.appendChild(list);
    } else {
      box.appendChild(el(documentNode, 'p', 'bo-muted bo-agent-noassign', 'Nessun incarico per ora.'));
    }

    // Talk to the agent like to a colleague: one line, one button.
    const draft = draftOf(card.sourceKey);
    const form = el(documentNode, 'form', 'bo-agent-talk');
    const input = el(documentNode, 'input', 'ui-field bo-agent-input');
    input.setAttribute('type', 'text');
    input.setAttribute('name', `talk-${card.sourceKey}`);
    input.setAttribute('aria-label', `Scrivi a ${card.name}`);
    input.setAttribute('placeholder', `Scrivi a ${card.name}…`);
    input.setAttribute('maxlength', '280');
    input.value = draft.text;
    input.addEventListener('input', () => { draft.text = String(input.value ?? ''); });
    form.appendChild(input);
    const send = uiButton(documentNode, { variant: 'primary', label: draft.busy ? 'Invio…' : 'Affida', attrs: { type: 'submit', 'data-action': 'talk' } });
    send.disabled = draft.busy;
    form.appendChild(send);
    form.addEventListener('submit', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      draft.text = String(input.value ?? draft.text);
      void sendInstruction(card, false);
    });
    box.appendChild(form);
    if (draft.unclear) {
      const unclear = el(documentNode, 'div', 'bo-agent-unclear');
      unclear.appendChild(el(documentNode, 'p', null, PHRASE_UNCLEAR_NOTE));
      const once = uiButton(documentNode, { variant: 'secondary', small: true, label: 'Fallo una volta, adesso', attrs: { type: 'button', 'data-action': 'once' } });
      once.disabled = draft.busy;
      once.addEventListener('click', () => { void sendInstruction(card, true); });
      unclear.appendChild(once);
      box.appendChild(unclear);
    }
    if (draft.error !== '') box.appendChild(el(documentNode, 'p', 'bo-seq-error', draft.error));
    if (draft.done !== '') box.appendChild(el(documentNode, 'p', 'bo-agent-done', draft.done));
    return box;
  }

  function renderMine(page, cards) {
    const section = el(documentNode, 'section', 'bo-agenti-section');
    section.appendChild(el(documentNode, 'h3', null, 'I tuoi agenti'));
    if (cards.length === 0) {
      section.appendChild(uiEmpty(documentNode, {
        title: 'Nessun agente nel team',
        text: 'Scegline uno dal catalogo qui sotto: entra nel team e puoi dargli il primo incarico.',
      }));
    } else {
      const grid = el(documentNode, 'div', 'bo-agent-grid');
      for (const card of cards) grid.appendChild(renderAgentCard(card));
      section.appendChild(grid);
      section.appendChild(el(documentNode, 'p', 'bo-muted bo-agent-tip',
        'Puoi scrivere a un agente anche dalla barra in alto: «@Nome» e l’incarico.'));
    }
    page.appendChild(section);
  }

  function renderDaFare(page, items) {
    const section = el(documentNode, 'section', 'bo-agenti-section');
    const head = el(documentNode, 'div', 'bo-agenti-sectionhead');
    head.appendChild(el(documentNode, 'h3', null, 'Da fare'));
    if (items.length > 0) head.appendChild(el(documentNode, 'span', 'bo-agenti-count', String(items.length)));
    section.appendChild(head);
    if (items.length === 0) {
      section.appendChild(uiEmpty(documentNode, { title: 'Niente da approvare', text: AGENTS_IDLE_NOTE }));
      page.appendChild(section);
      return;
    }
    const list = el(documentNode, 'div', 'bo-dafare-list');
    for (const item of items) {
      const row = el(documentNode, 'article', 'bo-dafare-item');
      if (item.runId) row.setAttribute('data-run', item.runId);
      const top = el(documentNode, 'div', 'bo-dafare-head');
      top.appendChild(uiBadge(documentNode, { authority: 'agent', text: item.agentName }));
      const stamp = romeStamp(item.startedAt);
      if (stamp !== '') top.appendChild(el(documentNode, 'span', 'bo-dafare-when', stamp));
      row.appendChild(top);
      if (item.phrase) row.appendChild(el(documentNode, 'p', 'bo-dafare-phrase', `Incarico: «${item.phrase}»`));
      if (item.unreadable) {
        row.appendChild(el(documentNode, 'p', 'bo-seq-error', 'Non riesco a leggere questa proposta: non la approvo alla cieca.'));
      }
      const ul = el(documentNode, 'ul', 'bo-dafare-lines');
      for (const line of item.lines) ul.appendChild(el(documentNode, 'li', null, line));
      if (item.lines.length > 0) row.appendChild(ul);
      const actions = el(documentNode, 'div', 'bo-dafare-actions');
      const decision = item.runId ? decisionOf(item.runId) : null;
      // A row without an id has nothing to send; an unreadable proposal is
      // never approved or edited blind (it can still be refused).
      const locked = decision === null || decision.busy !== null || decision.pending;
      const button = (label, variant, action, busyLabel, onClick, off = false) => {
        const node = uiButton(documentNode, {
          variant, small: true, label: decision?.busy === action ? busyLabel : label,
          attrs: { type: 'button', 'data-action': action },
        });
        node.disabled = locked || off;
        if (decision?.busy === action) node.setAttribute('aria-busy', 'true');
        node.addEventListener('click', onClick);
        actions.appendChild(node);
      };
      button('Approva', 'cta', 'approve', 'Approvo…', () => { void decide(item, 'approve'); }, item.unreadable);
      button('Modifica', 'secondary', 'edit', 'Salvo…', () => {
        if (!decision || locked) return;
        decision.mode = decision.mode === 'edit' ? null : 'edit';
        paint();
      }, item.unreadable || item.edits.length === 0);
      button('Rifiuta', 'refusal', 'reject', 'Rifiuto…', () => {
        if (!decision || locked) return;
        decision.mode = decision.mode === 'reject' ? null : 'reject';
        paint();
      });
      row.appendChild(actions);
      if (decision && decision.mode === 'edit' && !decision.pending) {
        const editor = el(documentNode, 'div', 'bo-dafare-edit');
        for (const edit of item.edits) {
          const draftKey = `${edit.index}:${edit.field}`;
          const area = el(documentNode, 'textarea', 'ui-field bo-dafare-edit-text');
          area.setAttribute('aria-label', `Testo della proposta ${edit.index + 1}`);
          area.setAttribute('data-proposal', String(edit.index));
          area.value = decision.drafts.has(draftKey) ? decision.drafts.get(draftKey) : edit.value;
          area.addEventListener('input', () => { decision.drafts.set(draftKey, String(area.value ?? '')); });
          editor.appendChild(area);
          const save = uiButton(documentNode, {
            variant: 'primary', small: true, label: decision.busy === 'revise' ? 'Salvo…' : 'Salva modifica',
            attrs: { type: 'button', 'data-action': 'save-edit', 'data-proposal': String(edit.index) },
          });
          save.disabled = locked;
          save.addEventListener('click', () => {
            const value = String((decision.drafts.has(draftKey) ? decision.drafts.get(draftKey) : area.value) ?? '').trim();
            if (value === '') {
              decision.error = 'Scrivi il testo della proposta, poi salva.';
              paint();
              return;
            }
            void decide(item, 'revise', { index: edit.index, payload: { [edit.field]: value } });
          });
          editor.appendChild(save);
        }
        row.appendChild(editor);
      }
      if (decision && decision.mode === 'reject' && !decision.pending) {
        const box = el(documentNode, 'div', 'bo-dafare-reject');
        const input = el(documentNode, 'input', 'ui-field');
        input.setAttribute('type', 'text');
        input.setAttribute('maxlength', '280');
        input.setAttribute('aria-label', 'Motivo del rifiuto (facoltativo)');
        input.setAttribute('placeholder', 'Motivo (facoltativo)');
        input.value = decision.reason;
        input.addEventListener('input', () => { decision.reason = String(input.value ?? ''); });
        box.appendChild(input);
        const confirm = uiButton(documentNode, {
          variant: 'refusal', small: true, label: decision.busy === 'reject' ? 'Rifiuto…' : 'Conferma rifiuto',
          attrs: { type: 'button', 'data-action': 'confirm-reject' },
        });
        confirm.disabled = locked;
        confirm.addEventListener('click', () => {
          const reason = String(decision.reason ?? input.value ?? '').trim();
          void decide(item, 'reject', reason === '' ? {} : { reason });
        });
        box.appendChild(confirm);
        const cancel = uiButton(documentNode, { variant: 'secondary', small: true, label: 'Annulla', attrs: { type: 'button', 'data-action': 'cancel-reject' } });
        cancel.disabled = decision.busy !== null;
        cancel.addEventListener('click', () => { decision.mode = null; paint(); });
        box.appendChild(cancel);
        row.appendChild(box);
      }
      if (decision?.pending) {
        const note = el(documentNode, 'p', 'bo-muted bo-dafare-pending', DA_FARE_PENDING_NOTE);
        note.setAttribute('role', 'status');
        const again = uiButton(documentNode, { variant: 'secondary', small: true, label: 'Ricarica', attrs: { type: 'button', 'data-action': 'reload-dafare' } });
        again.addEventListener('click', () => { void render(); });
        note.appendChild(el(documentNode, 'span', null, ' '));
        note.appendChild(again);
        row.appendChild(note);
      }
      if (decision?.unavailable) {
        const note = el(documentNode, 'p', 'bo-muted bo-dafare-unavailable', DA_FARE_UNAVAILABLE_NOTE);
        note.setAttribute('role', 'status');
        row.appendChild(note);
      }
      if (decision && decision.error !== '') row.appendChild(el(documentNode, 'p', 'bo-seq-error', decision.error));
      list.appendChild(row);
    }
    section.appendChild(list);
    page.appendChild(section);
  }

  function renderCatalog(page, items) {
    const section = el(documentNode, 'section', 'bo-agenti-section');
    section.appendChild(el(documentNode, 'h3', null, 'Catalogo'));
    section.appendChild(el(documentNode, 'p', 'bo-muted', 'Agenti pronti: aggiungine uno e diventa un collega del team.'));
    const grid = el(documentNode, 'div', 'bo-catalog-grid');
    for (const item of items) {
      const tile = el(documentNode, 'article', 'bo-catalog-item');
      tile.setAttribute('data-slug', item.slug);
      const head = el(documentNode, 'div', 'bo-agent-head');
      const avatar = el(documentNode, 'span', 'bo-agent-avatar', agentInitials(item.name));
      avatar.setAttribute('aria-hidden', 'true');
      head.appendChild(avatar);
      const who = el(documentNode, 'div', 'bo-agent-who');
      who.appendChild(el(documentNode, 'h4', 'bo-agent-name', item.name));
      if (item.role !== '') who.appendChild(el(documentNode, 'p', 'bo-agent-role', item.role));
      head.appendChild(who);
      tile.appendChild(head);
      if (item.instructions !== '') tile.appendChild(el(documentNode, 'p', 'bo-catalog-text', item.instructions));
      if (item.examplePhrase !== '') {
        tile.appendChild(el(documentNode, 'p', 'bo-catalog-example', `Es. «@${item.name} ${item.examplePhrase}»`));
      }
      if (item.added) {
        tile.appendChild(uiBadge(documentNode, { authority: 'accord', text: 'Nel tuo team' }));
      } else {
        const add = uiButton(documentNode, {
          variant: 'cta',
          small: true,
          label: state.adding === item.slug ? 'Aggiungo…' : 'Aggiungi',
          attrs: { type: 'button', 'data-action': 'add', 'data-slug': item.slug },
        });
        add.disabled = state.adding !== null;
        add.addEventListener('click', () => { void addFromCatalog(item.slug); });
        tile.appendChild(add);
      }
      grid.appendChild(tile);
    }
    section.appendChild(grid);
    if (state.addError !== '') section.appendChild(el(documentNode, 'p', 'bo-seq-error', state.addError));
    page.appendChild(section);
  }

  function paint() {
    if (!documentNode) return;
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    const page = el(documentNode, 'div', 'bo-seq bo-agenti');
    mount.appendChild(page);
    renderTop(page);
    if (!state.loaded) {
      page.appendChild(el(documentNode, 'p', 'bo-muted', 'Leggo gli agenti…'));
      return;
    }
    if (!state.space) {
      page.appendChild(el(documentNode, 'p', 'bo-muted', 'Scegli uno spazio per vedere i suoi agenti.'));
      return;
    }
    if (!state.available) {
      page.appendChild(el(documentNode, 'p', 'bo-muted',
        'Gli agenti non sono attivi in questo spazio: niente da mostrare, e niente di finto al loro posto.'));
      return;
    }
    if (state.notice !== '') page.appendChild(el(documentNode, 'p', 'bo-agent-done', state.notice));
    if (state.unavailable.length > 0) {
      page.appendChild(el(documentNode, 'p', 'bo-seq-error',
        `Non riesco a leggere adesso: ${state.unavailable.join(', ')}. Mostro solo quello che ho letto davvero.`));
    }
    if (state.capped) {
      page.appendChild(el(documentNode, 'p', 'bo-muted', `Mostro i primi ${AGENTI_READ_LIMIT} elementi per elenco.`));
    }
    const nowIso = now();
    const cards = buildAgentCards({ agents: state.agents, assignments: state.assignments, runs: state.runs, nowIso });
    renderMine(page, cards);
    renderDaFare(page, buildDaFare({ runs: state.runs, agents: state.agents, assignments: state.assignments }));
    renderCatalog(page, buildCatalogItems({ catalog: state.catalog, agents: state.agents }));
    // The old Sequenze stay reachable for whoever still uses them.
    const legacy = el(documentNode, 'p', 'bo-muted bo-agenti-legacy');
    legacy.appendChild(el(documentNode, 'span', null, 'Cerchi le sequenze automatiche? '));
    const link = el(documentNode, 'a', null, 'Apri Sequenze');
    link.setAttribute('href', '#/sequenze');
    link.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      navigate('#/sequenze');
    });
    legacy.appendChild(link);
    page.appendChild(legacy);
  }

  async function render() {
    const space = readSpace();
    if (space !== state.space) {
      state.space = space;
      state.drafts = new Map();
      state.notice = '';
      state.addError = '';
    }
    // A fresh read is the truth: a pending approval is decided or still waits.
    state.decisions = new Map();
    state.loaded = false;
    paint();
    if (await reload()) paint();
  }

  return { render, paint, state, invalidate };
}
