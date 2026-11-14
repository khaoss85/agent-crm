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
// - writes: `POST /api/agents/create` (create-agent: a catalogue slug, or —
//   backlog:1f7cb20d3c30 — a hand-written agent from «Nuovo agente»),
//   `POST /api/agents/assign` (create-assignment),
//   `POST /api/agents/update` (update-agent: a hand-written agent's own
//   Modifica — name, role, instructions, cap) and
//   `POST /api/agents/set-status` (set-agent-status: its Ritira/Riattiva —
//   paused/resumed), all posted through the bound submission client so the
//   Admin mutation gate sees an Idempotency-Key. Nothing else writes from
//   here. The generic modules PATCH is never used for agents: teammate-agent
//   exposes no update capability, so it would answer 404 (review #879).
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
import { formatAmount, humanWriteError, parseEuroToCents } from './admin-core.js';
import { el, uiBadge, uiButton, uiEmpty, uiHold, uiMarkBusy } from './admin-ui.js';

/** How many rows each module read takes: one page, said out loud. */
export const AGENTI_READ_LIMIT = 200;

/**
 * Backlog 2df6a513cc4d: the worker runs an assignment after Affida, so the
 * card reads «In attesa di partire» until the first run lands. The screen
 * reads again on its own: every AGENTI_POLL_MS while it is shown, plus one
 * read at each AGENTI_FOLLOWUP_MS delay after an Affida that succeeded.
 */
export const AGENTI_POLL_MS = 20_000;
export const AGENTI_FOLLOWUP_MS = Object.freeze([10_000, 30_000]);

export const AGENT_STATUS_LABEL = Object.freeze({ active: 'Attivo', paused: 'In pausa' });

/**
 * backlog:1f7cb20d3c30 — an agent written by hand has no engine in this
 * space: the deployment runs only the catalogue agents it wired an
 * executor for (the catalogue read names their keys). The card says so and
 * never reads «Attivo» for an agent nothing runs. When a deployment gets a
 * generic engine, the catalogue read (or a field on the row) must carry
 * that signal; until then the catalogue is the whole truth.
 */
export const AGENT_NO_ENGINE_LABEL = 'Pronto, in attesa del motore';
export const AGENT_NO_ENGINE_NOTE = 'Non viene dal catalogo: in questo spazio lavorano solo gli agenti del catalogo. '
  + 'Resta nel tuo team e aspetta il motore, oppure scegli un agente dal catalogo qui sotto.';

/** A hand-written agent waits for the engine after Affida: the outcome says so. */
export const AGENT_WAIT_ENGINE_DONE = 'Per ora aspetta il motore: parte da solo appena arriva.';
/** A paused agent is off: Affida on its card says the incarico stays put. */
export const AGENT_PAUSED_DONE = 'è in pausa: l’incarico resta fermo finché non lo riattivi.';

/** Hand-written agents live under this source-key prefix (create-agent). @param {unknown} key */
export function isHandAgentKey(key) {
  return typeof key === 'string' && key.startsWith('custom-agent:');
}

/**
 * The first agent of a space that can work (not paused, with an engine), trimmed, or '' when none can.
 * @param {Array<any>} agents @param {Array<any> | null} [catalog]
 */
export function firstTeamAgent(agents = [], catalog = null) {
  // backlog:f06d06f242d6: the example names an agent that can work — not
  // paused, and run by an engine (a catalogue agent; with no catalogue
  // read the screen cannot tell, as on the cards) — never one that waits.
  const engines = Array.isArray(catalog)
    ? new Set(catalog.map((entry) => entry?.agentSourceKey).filter((key) => typeof key === 'string'))
    : null;
  const named = (Array.isArray(agents) ? agents : []).find((row) => text(row?.name) !== null
    && row?.status !== 'paused'
    && (engines === null || engines.has(String(row?.sourceKey ?? ''))));
  return named ? String(named.name).trim() : '';
}

/** backlog:f06d06f242d6: the AI bar on Agenti when no agent of the team can work. */
export const AGENT_MENTION_NEUTRAL = 'Scrivi @ e il nome di un agente, poi cosa deve fare';

/**
 * The AI-bar placeholder for the Agenti screen names an agent of this team,
 * so «@Nome» always reaches somebody. Falls back to the catalog example
 * when the team has no named agent yet.
 * @param {Array<any>} agents
 */
export function agentMentionPlaceholder(agents = [], catalog = null) {
  const name = firstTeamAgent(agents, catalog);
  if (name === '') return AGENT_MENTION_NEUTRAL;
  return `Scrivi: «@${name} …»`;
}

/** An incarico of an agent with no engine: kept, never «Non riuscito», it waits (run-due `runnable`). */
export const ASSIGNMENT_NO_ENGINE_LABEL = 'In attesa del motore';

/** A capped agent needs the cost of one run on every incarico (package rule requireCostEstimate). */
export const AGENT_COST_NEEDED_NOTE = 'Questo agente ha un tetto di spesa: scrivi quanto costa più o meno un giro, in euro.';

/** The ⌘K bar cannot ask for the cost of a run: a capped agent is instructed from its card. */
export const AGENT_CAP_USE_CARD_NOTE = 'Questo agente ha un tetto di spesa: dagli l’incarico dalla sua scheda in Agenti, dove scrivi anche quanto costa un giro.';

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

/**
 * Backlog «Agenti: layout delle card»: the outcome of a run as a short chip
 * on its row — the label the operator reads and the authority tone of the
 * design system (uiBadge). `artifact` has no authority: it reads neutral.
 */
export const RUN_OUTCOME_CHIP = Object.freeze({
  started: Object.freeze({ label: 'In corso', tone: 'agent' }),
  proposed: Object.freeze({ label: 'Da approvare', tone: 'pending' }),
  applied: Object.freeze({ label: 'Applicato', tone: 'accord' }),
  artifact: Object.freeze({ label: 'Niente da proporre', tone: 'neutral' }),
  capped: Object.freeze({ label: 'Tetto di spesa', tone: 'pending' }),
  failed: Object.freeze({ label: 'Non riuscito', tone: 'fault' }),
  rejected: Object.freeze({ label: 'Rifiutato', tone: 'human' }),
});

/** How many incarichi a card shows before «Mostra tutti (N)». */
export const AGENT_RUNS_VISIBLE = 2;

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
export function buildAgentCards({ agents = [], assignments = [], runs = [], nowIso, catalog = null }) {
  // backlog:1f7cb20d3c30: the agents this space can run are the catalogue
  // agents (their keys come with the catalogue read). Without a catalogue
  // read the screen knows nothing either way and keeps «Attivo».
  const engines = Array.isArray(catalog)
    ? new Set(catalog.map((entry) => entry?.agentSourceKey).filter((key) => typeof key === 'string'))
    : null;
  const cards = [];
  for (const agent of agents) {
    const key = text(agent?.sourceKey);
    const name = text(agent?.name);
    if (key === null || name === null) continue;
    const engine = engines === null || engines.has(key);
    const status = agent.status === 'paused' ? 'paused' : engine ? 'active' : 'waiting';
    const capCents = Number.isInteger(agent.spendingCapCents) && agent.spendingCapCents >= 0 ? agent.spendingCapCents : null;
    const own = assignments
      .filter((row) => row && row.agentSourceKey === key && text(row.phrase) !== null)
      .slice()
      .sort((a, b) => String(b.decidedAt ?? '').localeCompare(String(a.decidedAt ?? '')))
      .map((row) => ({
        sourceKey: String(row.sourceKey ?? ''),
        phrase: String(row.phrase).trim(),
        schedule: describeSchedule(row),
        // backlog:1f7cb20d3c30: an active incarico of an agent nothing runs
        // waits for the engine; paused or done still say so.
        status: !engine && row.status === 'active' ? ASSIGNMENT_NO_ENGINE_LABEL : assignmentStatusLabel(row, runs),
        lastRun: lastRunLine(runs, String(row.sourceKey ?? '')),
        lastOutcome: lastRunOf(runs, String(row.sourceKey ?? ''))?.outcome ?? null,
        lastStamp: lastRunStamp(runs, String(row.sourceKey ?? '')),
      }));
    const spentCents = spentThisMonthCents(runs, key, nowIso);
    cards.push({
      // The module row id keeps the card keyed to its row; Modifica/Ritira
      // write through the agents package routes by sourceKey, never by id.
      // `custom` gates them to hand-written agents (the catalogue owns its
      // own rows).
      id: agent?.id == null || String(agent.id).trim() === '' ? null : String(agent.id).trim(),
      custom: isHandAgentKey(key),
      sourceKey: key,
      name,
      role: text(agent.role) ?? '',
      instructions: text(agent.instructions) ?? '',
      initials: agentInitials(name),
      status,
      statusLabel: status === 'waiting' ? AGENT_NO_ENGINE_LABEL : AGENT_STATUS_LABEL[status],
      engine,
      capCents,
      capLabel: capCents === null ? null : formatAmount(capCents, 'EUR'),
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
 * Backlog 43e8e7c563c3 (narrows 31a76b6f19a3): an active assignment reads
 * «Attivo» only once the worker ran it at least once. A recurring one that
 * never ran reads «In attesa del primo giro» with its next run date, never
 * «Attivo» — the Mac check of 09/11 found «ogni venerdì» reading «Attivo»
 * before its first run, which tells the operator it already works.
 * Anything else that never started reads «In attesa di partire».
 * @param {any} assignment @param {Array<any>} runs
 */
export function assignmentStatusLabel(assignment, runs) {
  if (assignment?.status !== 'active') return ASSIGNMENT_STATUS_LABEL[assignment?.status] ?? 'Stato sconosciuto';
  const key = String(assignment.sourceKey ?? '');
  const ran = key !== '' && (Array.isArray(runs) ? runs : []).some((run) => run && run.assignmentSourceKey === key);
  if (ran) return ASSIGNMENT_STATUS_LABEL.active;
  const next = typeof assignment?.nextRunAt === 'string' ? assignment.nextRunAt : '';
  if (assignment?.cadence !== 'once' && Number.isFinite(Date.parse(next))) {
    const stamp = romeStamp(next);
    return stamp === '' ? 'In attesa del primo giro' : `In attesa del primo giro, ${stamp}`;
  }
  return 'In attesa di partire';
}

/**
 * Backlog 31a76b6f19a3: how the last run of one assignment went —
 * «Ultimo giro: niente da proporre, 7 nov, 14:30» — so a run that found
 * nothing to propose is seen somewhere. Null when the assignment never ran.
 * @param {Array<any>} runs @param {string} assignmentSourceKey
 * @returns {string | null}
 */
export function lastRunLine(runs, assignmentSourceKey) {
  const last = lastRunOf(runs, assignmentSourceKey);
  if (!last) return null;
  const stamp = lastRunStamp(runs, assignmentSourceKey);
  return `Ultimo giro: ${RUN_OUTCOME_LABEL[last.outcome]}${stamp === '' ? '' : `, ${stamp}`}`;
}

/** @param {any} run */
function runAt(run) {
  return String(run?.decidedAt ?? run?.startedAt ?? '');
}

/**
 * The newest run with a known outcome of one assignment, or null.
 * @param {Array<any>} runs @param {string} assignmentSourceKey
 */
function lastRunOf(runs, assignmentSourceKey) {
  if (assignmentSourceKey === '') return null;
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => run && run.assignmentSourceKey === assignmentSourceKey && Object.hasOwn(RUN_OUTCOME_LABEL, String(run.outcome)))
    .sort((a, b) => runAt(b).localeCompare(runAt(a)))[0] ?? null;
}

/** The Rome date of the last run, '' when it never ran. @param {Array<any>} runs @param {string} assignmentSourceKey */
function lastRunStamp(runs, assignmentSourceKey) {
  const last = lastRunOf(runs, assignmentSourceKey);
  return last ? romeStamp(runAt(last) || null) : '';
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
  const shown = editableField(proposal);
  return shown !== null ? shown.value.trim() : (text(proposal?.action) ?? 'Azione senza nome');
}

/**
 * The text fields a proposal line reads, in the one order the row and
 * «Modifica» share (review #688: the editor opened another field than the
 * one shown).
 */
const PROPOSAL_TEXT_FIELDS = Object.freeze(['summary', 'text', 'title']);

/**
 * Backlog 31a76b6f19a3: the text field a proposal line shows — and the one
 * «Modifica» edits — or null when it carries none.
 * @param {any} proposal
 * @returns {{ field: string, value: string } | null}
 */
function editableField(proposal) {
  const payload = proposal?.payload && typeof proposal.payload === 'object' ? proposal.payload : {};
  for (const field of PROPOSAL_TEXT_FIELDS) {
    if (typeof payload[field] === 'string' && payload[field].trim() !== '') return { field, value: payload[field] };
  }
  return null;
}

/**
 * Whether a decision route is simply not served here (backlog
 * 31a76b6f19a3, review #688): a 405 from the mount, or a 404 that names the
 * route as missing — no domain code, the routers' «Route not found», the
 * deployment's unknown agents route, or a deployment whose framework has
 * no such operation yet. Any other 404 (a run that is gone) and every
 * AGENT_ refusal is a real answer, never hidden.
 * @param {unknown} error
 */
export function isDecisionUnavailable(error) {
  const record = error && typeof error === 'object' ? /** @type {any} */ (error) : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message : '';
  const missing = code === '' || code === 'BO_AGENT_ROUTE_UNKNOWN' || code === 'BO_AGENT_DECISION_UNAVAILABLE';
  // Review #688 giro 2: a 405 is a missing route only with a routing code,
  // never with a domain refusal.
  if (record.status === 405) return missing || code === 'ADMIN_METHOD_NOT_ALLOWED' || code === 'NOT_FOUND';
  if (record.status !== 404) return false;
  if (missing) return true;
  if (code === 'NOT_FOUND' && message === 'Route not found') return true;
  // Review #879 giro 2: a deployment whose framework has no agents writes
  // yet answers the update/set-status POST with NotFoundError('Operation',
  // 'teammate agents'). That reads neutral, like any other unserved route —
  // while AGENT_UNKNOWN (the agent is gone) stays a real answer, never
  // hidden: its code is not NOT_FOUND-shaped like this one.
  return code === 'NOT_FOUND' && message.startsWith('Operation not found');
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
        // The run's source key names the run for the package operations
        // (agent-crm#684); the id is what the buttons send (backlog
        // 31a76b6f19a3) — the deployment refuses the key.
        runSourceKey: String(run.sourceKey),
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
 * @param {{ spaceId: string, agentSourceKey: string, phrase: string, costPerRunCents?: number }} intent
 */
export function assignAttempt(previous, intent) {
  const cost = Number.isInteger(intent.costPerRunCents) && intent.costPerRunCents > 0 ? intent.costPerRunCents : 0;
  if (previous && previous.spaceId === intent.spaceId && previous.agentSourceKey === intent.agentSourceKey
    && previous.phrase === intent.phrase && previous.costPerRunCents === cost) return previous;
  return {
    spaceId: intent.spaceId,
    agentSourceKey: intent.agentSourceKey,
    phrase: intent.phrase,
    // backlog:1f7cb20d3c30: the cost of one run, for an agent with a cap.
    costPerRunCents: cost,
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
    ...(attempt.costPerRunCents > 0 ? { costPerRunCents: attempt.costPerRunCents } : {}),
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
  if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'AGENT_COST_ESTIMATE_REQUIRED') return AGENT_COST_NEEDED_NOTE;
  return humanWriteError(error, {
    failed: 'Non riesco a dare l’incarico adesso: riprova tra poco.',
    notComposed: 'Gli agenti non sono attivi in questo spazio.',
  });
}

/** The bounds create-agent applies (packages/agents checkAgentInput). */
export const NEW_AGENT_LIMITS = Object.freeze({ name: 120, role: 120, instructions: 4000 });

/** The example under «Come lavora»: what an instruction looks like. */
export const NEW_AGENT_EXAMPLE = 'Es. Ogni mattina guarda chi compie gli anni tra i clienti e prepara un messaggio di auguri. '
  + 'Ogni messaggio aspetta il mio ok.';

/** The locked panel after a lost answer (review #836 P2). */
export const NEW_AGENT_PENDING_NOTE = 'Non so se l’agente è stato creato. Riprova: se c’è già, lo ritrovo senza crearne un altro.';

/** Two agents of one space never answer to the same @name (create-agent AGENT_NAME_TAKEN). */
export const AGENT_NAME_TAKEN_NOTE = 'C’è già un agente con questo nome nel tuo team: scegline un altro.';

/**
 * The error one field of «Nuovo agente» shows: the live check of Nome
 * first, else the error Crea left on that field.
 * @param {{ error: string, field: string | null, nameError?: string }} form @param {string} field
 */
function fieldErrorOf(form, field) {
  if (field === 'name' && typeof form.nameError === 'string' && form.nameError !== '') return form.nameError;
  return form.error !== '' && form.field === field ? form.error : '';
}

/** «Pronto, in attesa…» → «pronto, in attesa…», for a line that continues a sentence. @param {string} value */
function lowerFirst(value) {
  return value === '' ? value : value.charAt(0).toLocaleLowerCase('it-IT') + value.slice(1);
}

/** @param {unknown} error */
function isNameTaken(error) {
  return Boolean(error && typeof error === 'object' && /** @type {any} */ (error).code === 'AGENT_NAME_TAKEN');
}

/**
 * backlog:1f7cb20d3c30 — check the «Nuovo agente» panel before it posts:
 * every refusal in Italian, the body only when it is complete. The name
 * loses a leading «@» (it is how the operator will type it) and may not
 * fold to the name of an agent already in the space.
 * @param {{ name?: unknown, role?: unknown, instructions?: unknown, cap?: unknown }} form
 * @param {Array<any>} [agents]
 * @returns {{ error: string, field: 'name' | 'role' | 'instructions' | 'cap' } | { error?: undefined, field?: undefined, body: { name: string, role: string, instructions: string, spendingCapCents?: number } }}
 */
export function checkNewAgent(form, agents = []) {
  const line = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const name = line(form?.name).replace(/^@+\s*/, '');
  const role = line(form?.role);
  // create-agent keeps instructions on one line: the lines of the textarea
  // join with a space, never a 400 for an Enter the operator typed.
  const instructions = line(form?.instructions);
  if (name === '') return { error: 'Dagli un nome: è quello che scrivi dopo la @.', field: 'name' };
  if (name.length > NEW_AGENT_LIMITS.name) return { error: `Il nome è troppo lungo: al massimo ${NEW_AGENT_LIMITS.name} caratteri.`, field: 'name' };
  if (role === '') return { error: 'Scrivi in poche parole di cosa si occupa.', field: 'role' };
  if (role.length > NEW_AGENT_LIMITS.role) return { error: `«Di cosa si occupa» è troppo lungo: al massimo ${NEW_AGENT_LIMITS.role} caratteri.`, field: 'role' };
  if (instructions === '') return { error: 'Scrivi come lavora: cosa guarda e cosa ti propone.', field: 'instructions' };
  if (instructions.length > NEW_AGENT_LIMITS.instructions) return { error: `Le istruzioni sono troppo lunghe: al massimo ${NEW_AGENT_LIMITS.instructions} caratteri.`, field: 'instructions' };
  const wanted = foldName(name);
  if ((Array.isArray(agents) ? agents : []).some((row) => typeof row?.name === 'string' && foldName(row.name) === wanted)) {
    return { error: AGENT_NAME_TAKEN_NOTE, field: 'name' };
  }
  const rawCap = line(form?.cap).replace(/\s*€$/, '');
  if (rawCap === '') return { body: { name, role, instructions } };
  const cents = parseEuroToCents(rawCap);
  if (cents === null) return { error: 'Il tetto di spesa va scritto in euro, per esempio 10 o 7,50. Oppure lascialo vuoto.', field: 'cap' };
  if (cents <= 0) return { error: 'Il tetto di spesa deve essere più di 0 €. Oppure lascialo vuoto.', field: 'cap' };
  return { body: { name, role, instructions, spendingCapCents: cents } };
}

/** Italian text for a refused «Nuovo agente». @param {unknown} error */
export function newAgentErrorText(error) {
  if (isNameTaken(error)) return AGENT_NAME_TAKEN_NOTE;
  const status = error && typeof error === 'object' ? /** @type {any} */ (error).status : null;
  if (status === 403) return 'Non hai il permesso di creare agenti in questo spazio: chiedilo a chi gestisce il team.';
  return humanWriteError(error, {
    failed: 'Non riesco a creare l’agente adesso: riprova tra poco. Quello che hai scritto resta qui.',
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
/**
 * The last good read per space, module-wide: coming back to Agenti paints
 * this instantly (under a second) and then reads again, so a stale card
 * never outlives one reload. Only a finished `reload` writes it — a failed
 * part never becomes the painted truth.
 * @type {Map<string, { available: boolean, catalog: Array<any>, agents: Array<any>, assignments: Array<any>, runs: Array<any>, capped: boolean, unavailable: Array<string> }>}
 */
const AGENTI_CACHE = new Map();
const AGENTI_CACHE_SPACES = 20;

export function createAgentiView({ doc = null, mount, client, submissions, storage, spaceId, navigate = () => {}, now = () => new Date().toISOString(), setTimer, clearTimer, onTeamAgent }) {
  const documentNode = doc ?? (typeof document !== 'undefined' ? document : null);
  const { client: bound } = bindAdminMutations(client, { submissions, storage });
  const readSpace = typeof spaceId === 'function' ? spaceId : () => null;
  const tellTeam = typeof onTeamAgent === 'function' ? onTeamAgent : () => {};
  const later = typeof setTimer === 'function' ? setTimer : (fn, ms) => setTimeout(fn, ms);
  const forget = typeof clearTimer === 'function' ? clearTimer : (id) => clearTimeout(id);
  let renderToken = 0;
  /** Backlog 2df6a513cc4d: the self-refresh below lives here. */
  let polling = false;
  let pollTimer = null;
  const followupTimers = new Set();
  function arm(fn, ms) {
    let handle = null;
    try {
      handle = later(fn, ms);
    } catch {
      handle = null;
    }
    try {
      handle?.unref?.();
    } catch {
      // Browsers answer a number: nothing to release.
    }
    return handle;
  }
  function stopAutoRefresh() {
    polling = false;
    if (pollTimer !== null) {
      try {
        forget(pollTimer);
      } catch {
        // Stopping is best-effort.
      }
      pollTimer = null;
    }
    for (const handle of [...followupTimers]) {
      try {
        forget(handle);
      } catch {
        // Stopping is best-effort.
      }
    }
    followupTimers.clear();
  }
  function schedulePoll() {
    if (!polling || pollTimer !== null) return;
    pollTimer = arm(() => {
      pollTimer = null;
      if (!polling) return;
      pollOnce();
    }, AGENTI_POLL_MS);
  }
  async function pollOnce() {
    try {
      if (!polling || !state.space || readSpace() !== state.space) return;
      if (documentNode && documentNode.visibilityState === 'hidden') return;
      if (await reload()) paint();
    } catch {
      // A failed poll only waits for the next one, never breaks the screen.
    } finally {
      schedulePoll();
    }
  }
  function scheduleFollowups() {
    if (!polling) return;
    for (const ms of AGENTI_FOLLOWUP_MS) {
      const handle = arm(async () => {
        followupTimers.delete(handle);
        if (!polling) return;
        try {
          if (!state.space || readSpace() !== state.space) return;
          if (await reload()) paint();
        } catch {
          // The next follow-up or poll still comes.
        }
      }, ms);
      if (handle !== null && handle !== undefined) followupTimers.add(handle);
    }
  }
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
     * backlog:1f7cb20d3c30: the open «Nuovo agente» panel, or null.
     * `pending` is the body of a create whose answer was lost: the panel
     * is locked and «Riprova» sends exactly that body under its key
     * (review #836 P2), never the fields as they are now. `field` names
     * the control its `error` belongs to, for the inline error, the
     * aria-invalid mark and the focus that follows the repaint.
     * @type {{ key: string, name: string, role: string, instructions: string, cap: string, error: string, field: string | null, busy: boolean, pending: any } | null}
     */
    newAgent: null,
    /**
     * backlog:7d169a3b1dd2: the open «Modifica» panel of one hand-written
     * agent, by source key. Same shape as the creation panel, minus the
     * key/pending pair: a retry re-sends the same checked body under the
     * same key while the panel stays open.
     * @type {Map<string, { key: string, name: string, role: string, instructions: string, cap: string, error: string, field: string | null, busy: boolean }>}
     */
    editing: new Map(),
    /**
     * backlog:7d169a3b1dd2: the «Ritira» two-step of one hand-written
     * agent, by source key — an inline Conferma/Annulla, never a native
     * confirm(). `busy` flies the PATCH; `unavailable` is a deployment
     * that does not serve it yet.
     * @type {Map<string, { busy: boolean, error: string, unavailable: boolean, confirm: boolean, key: string | null }>}
     */
    retiring: new Map(),
    /** Agents whose card lists every incarico («Mostra tutti»). @type {Set<string>} */
    expandedRuns: new Set(),
    /** Incarichi whose phrase is shown whole. @type {Set<string>} */
    openPhrases: new Set(),
    /**
     * Backlog 31a76b6f19a3: one Approva per run id — busy while the request
     * flies (a double click sends one request), then a done/pending/error
     * line in Italian. The key stays the same until the answer is known.
     * @type {Map<string, { busy: boolean, pending: boolean, error: string, key: string | null }>}
     */
    decisions: new Map(),
    /**
     * Review #688: decisions still queued on the server, by run id, with
     * the Idempotency-Key each kind was sent under. A reload never forgets
     * them — the row stays locked and a retry reuses its key — until the
     * run leaves `proposed`.
     * @type {Map<string, { kind: string, keys: Map<string, string> }>}
     */
    queued: new Map(),
    /**
     * Review #688 giro 2: the keys of an edit still queued. An edit never
     * moves the run out of `proposed`, so it does not lock the row past a
     * reload; re-saving the same text reuses its key.
     * @type {Map<string, Map<string, string>>}
     */
    reviseKeys: new Map(),
    /** Review #688: a decision on a run that is gone, said above the list after the reload. */
    daFareError: '',
  };

  function invalidate() {
    renderToken += 1;
    stopAutoRefresh();
  }

  function draftOf(key) {
    if (!state.drafts.has(key)) state.drafts.set(key, { text: '', cost: '', busy: false, error: '', unclear: false, done: '', attempt: null });
    return /** @type {any} */ (state.drafts.get(key));
  }

  /** Paint a finished read into state; both the live reload and the cache use it. @param {any} data */
  function applyData(data) {
    state.available = data.available;
    state.catalog = data.catalog;
    state.agents = data.agents;
    state.assignments = data.assignments;
    state.runs = data.runs;
    state.capped = data.capped;
    state.unavailable = data.unavailable;
    state.loaded = true;
    forgetSettledQueue();
    tellTeam(firstTeamAgent(state.agents, state.catalog));
  }

  async function reload() {
    const token = ++renderToken;
    const data = await loadAgentiData(client, state.space);
    if (token !== renderToken) return false;
    applyData(data);
    // Only a finished read becomes the instant paint of the next return:
    // a failed part never overwrites the last good one.
    if (state.space) {
      AGENTI_CACHE.set(state.space, {
        available: data.available,
        catalog: data.catalog,
        agents: data.agents,
        assignments: data.assignments,
        runs: data.runs,
        capped: data.capped,
        unavailable: data.unavailable,
      });
      if (AGENTI_CACHE.size > AGENTI_CACHE_SPACES) AGENTI_CACHE.delete(AGENTI_CACHE.keys().next().value);
    }
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
      state.addError = isNameTaken(error) ? AGENT_NAME_TAKEN_NOTE : humanWriteError(error, {
        failed: 'Non riesco ad aggiungere l’agente adesso: riprova tra poco.',
        notComposed: 'Gli agenti non sono attivi in questo spazio.',
      });
      paint();
    }
  }

  function decisionOf(runId) {
    if (!state.decisions.has(runId)) {
      const queued = state.queued.get(runId) ?? null;
      state.decisions.set(runId, {
        busy: null, pending: queued !== null, unavailable: false, error: '', mode: null, reason: '', drafts: new Map(),
        keys: queued !== null ? queued.keys : (state.reviseKeys.get(runId) ?? new Map()),
      });
    }
    return /** @type {any} */ (state.decisions.get(runId));
  }

  /**
   * Review #688: a queued approval or refusal is forgotten only once its run
   * left `proposed`. A queued edit never moves the run, so a reload unlocks
   * its row (giro 2) and keeps its keys for a re-save of the same text.
   */
  function forgetSettledQueue() {
    const proposed = (runId) => {
      const run = state.runs.find((row) => row && row.id != null && String(row.id) === runId);
      return Boolean(run) && run.outcome === 'proposed';
    };
    for (const [runId, entry] of [...state.queued.entries()]) {
      if (entry.kind === 'revise' || !proposed(runId)) state.queued.delete(runId);
    }
    for (const runId of [...state.reviseKeys.keys()]) {
      if (!proposed(runId)) state.reviseKeys.delete(runId);
    }
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
    // Review #688: the space is fixed at the click; an answer that lands
    // after the operator moved to another space is dropped, never painted
    // on the space now shown.
    const space = state.space;
    const left = () => readSpace() !== space || state.space !== space;
    decision.busy = kind;
    decision.error = '';
    decision.unavailable = false;
    state.notice = '';
    state.daFareError = '';
    const keyId = kind === 'revise' ? `revise:${String(extra.index)}:${JSON.stringify(extra.payload)}` : kind;
    if (!decision.keys.has(keyId)) decision.keys.set(keyId, issueAdminKey());
    paint();
    try {
      const answer = await bound.request(`/api/agents/${kind}`, {
        method: 'POST',
        body: { spaceId: space, runId: item.runId, ...extra },
        idempotencyKey: decision.keys.get(keyId),
      });
      if (left()) {
        await render();
        return;
      }
      state.queued.delete(item.runId);
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
      if (left()) {
        await render();
        return;
      }
      decision.busy = null;
      const code = typeof error?.code === 'string' ? error.code : '';
      if (/^BO_[A-Z_]*PENDING$/.test(code)) {
        // Still queued on the server: the outcome is unknown, never a
        // failure. Locked — across reloads too (review #688) — until the
        // run leaves `proposed`, and a retry reuses the same key.
        decision.pending = true;
        state.queued.set(item.runId, { kind, keys: decision.keys });
        if (kind === 'revise') state.reviseKeys.set(item.runId, decision.keys);
      } else if (isDecisionUnavailable(error)) {
        decision.unavailable = true;
        decision.keys.delete(keyId);
      } else if (error?.status === 404) {
        // The run is gone (deleted, or never in this space): say it above
        // the list and read the list again, so the stale row leaves.
        decision.keys.delete(keyId);
        state.decisions.delete(item.runId);
        state.daFareError = humanWriteError(error, {
          failed: 'Questa proposta non c’è più: ho ricaricato l’elenco.',
          notComposed: 'Questa proposta non c’è più: ho ricaricato l’elenco.',
        });
        if (await reload()) paint();
        return;
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
    // backlog:1f7cb20d3c30: a capped agent needs the cost of one run.
    let costPerRunCents = 0;
    if (agent.capCents !== null && agent.capCents !== undefined) {
      const cents = parseEuroToCents(String(draft.cost ?? ''));
      if (cents === null || cents <= 0) {
        draft.error = AGENT_COST_NEEDED_NOTE;
        draft.done = '';
        paint();
        return;
      }
      costPerRunCents = cents;
    }
    draft.busy = true;
    draft.error = '';
    draft.done = '';
    paint();
    draft.attempt = assignAttempt(draft.attempt, { spaceId: state.space, agentSourceKey: agent.sourceKey, phrase, costPerRunCents });
    try {
      const made = await assignToAgent(bound, draft.attempt, { once, nowIso: now() });
      draft.busy = false;
      draft.unclear = false;
      draft.text = '';
      draft.cost = '';
      draft.attempt = null;
      // Backlog 7d169a3b1dd2: Affida says what the incarico does next — a
      // hand-written agent with no engine waits for it, a paused one stays
      // off until Riattiva.
      draft.done = `Incarico dato a ${agent.name}: ${made ? describeSchedule(made).toLowerCase() : 'registrato'}.`
        + (agent.engine === false ? ` ${AGENT_WAIT_ENGINE_DONE}` : '')
        + (agent.status === 'paused' ? ` ${agent.name} ${AGENT_PAUSED_DONE}` : '');
      if (await reload()) paint();
      // Backlog 2df6a513cc4d: the run lands after this answer, so read
      // again twice: the card leaves «In attesa di partire» on its own.
      scheduleFollowups();
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
    const factRows = [['Autonomia', card.autonomy], ['Speso questo mese', card.spentLabel], ['Da approvare', String(card.pending)]];
    if (card.capLabel !== null) factRows.push(['Tetto al mese', card.capLabel]);
    for (const [term, value] of factRows) {
      const row = el(documentNode, 'div', 'bo-agent-fact');
      row.appendChild(el(documentNode, 'dt', null, term));
      row.appendChild(el(documentNode, 'dd', null, value));
      facts.appendChild(row);
    }
    box.appendChild(facts);
    if (!card.engine) box.appendChild(el(documentNode, 'p', 'bo-agent-noengine', AGENT_NO_ENGINE_NOTE));

    if (card.assignments.length > 0) {
      // Backlog «Agenti: layout delle card»: the newest two incarichi as
      // compact rows, the rest behind «Mostra tutti (N)».
      const all = state.expandedRuns.has(card.sourceKey);
      const list = el(documentNode, 'ul', 'bo-agent-assignments');
      const shown = all ? card.assignments : card.assignments.slice(0, AGENT_RUNS_VISIBLE);
      for (const assignment of shown) list.appendChild(renderAssignmentRow(assignment));
      box.appendChild(list);
      if (card.assignments.length > AGENT_RUNS_VISIBLE) {
        const toggle = el(documentNode, 'button', 'bo-agent-runs-toggle', all ? 'Mostra meno' : `Mostra tutti (${card.assignments.length})`);
        toggle.setAttribute('type', 'button');
        toggle.setAttribute('data-action', 'runs-toggle');
        toggle.setAttribute('aria-expanded', all ? 'true' : 'false');
        toggle.addEventListener('click', () => {
          if (state.expandedRuns.has(card.sourceKey)) state.expandedRuns.delete(card.sourceKey);
          else state.expandedRuns.add(card.sourceKey);
          paint();
        });
        box.appendChild(toggle);
      }
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
    if (card.capCents !== null) {
      // backlog:1f7cb20d3c30: the package refuses an incarico to a capped
      // agent without the cost of one run, so the card asks for it here.
      const cost = el(documentNode, 'input', 'ui-field bo-agent-cost');
      cost.setAttribute('type', 'text');
      cost.setAttribute('inputmode', 'decimal');
      cost.setAttribute('name', `cost-${card.sourceKey}`);
      cost.setAttribute('aria-label', `Quanto costa un giro di ${card.name}, in euro`);
      cost.setAttribute('placeholder', '€ a giro');
      cost.value = draft.cost;
      cost.addEventListener('input', () => { draft.cost = String(cost.value ?? ''); });
      form.appendChild(cost);
    }
    const send = uiButton(documentNode, { variant: 'primary', label: draft.busy ? 'Invio…' : 'Affida', attrs: { type: 'submit', 'data-action': 'talk' } });
    send.disabled = draft.busy;
    form.appendChild(send);
    form.addEventListener('submit', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      draft.text = String(input.value ?? draft.text);
      const cost = form.querySelector(`input[name="cost-${card.sourceKey}"]`);
      if (cost) draft.cost = String(cost.value ?? draft.cost);
      // The shared wait (admin-cta-busy guard): Affida reads «Invio…» from
      // the press; the repaint keeps it from draft.busy, and a press that
      // writes nothing (empty line) gets the button back.
      const release = uiHold(send, 'Invio…');
      void sendInstruction(card, false).finally(() => release());
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
    // Backlog 7d169a3b1dd2: a hand-written agent is edited and retired
    // from its own card — the catalogue owns its rows, so its tiles keep
    // only Aggiungi. No native confirm() anywhere: Ritira asks inline.
    if (card.custom && card.id !== null) box.appendChild(renderManage(card));
    return box;
  }

  /**
   * Modifica/Ritira of one hand-written agent: the edit panel with the
   * same checks as «Nuovo agente» (errors next to their field), and the
   * two-step inline retire.
   * @param {any} card
   */
  function renderManage(card) {
    const manage = el(documentNode, 'div', 'bo-agent-manage');
    const paused = card.status === 'paused';
    const row = el(documentNode, 'div', 'bo-seq-btns');
    const editOpen = state.editing.has(card.sourceKey);
    const edit = uiButton(documentNode, {
      variant: 'secondary', small: true,
      label: editOpen ? 'Chiudi modifica' : 'Modifica',
      attrs: { type: 'button', 'data-action': 'edit-agent', 'aria-expanded': editOpen ? 'true' : 'false' },
    });
    edit.addEventListener('click', () => {
      if (state.editing.has(card.sourceKey)) state.editing.delete(card.sourceKey);
      else editOf(card);
      paint();
      if (state.editing.has(card.sourceKey)) {
        const panel = findNode(mount, (node) => node.getAttribute('data-edit') === card.sourceKey);
        focusFieldError(panel, 'agent-edit-name');
      }
    });
    row.appendChild(edit);
    const retireEntry = state.retiring.get(card.sourceKey) ?? null;
    const retire = uiButton(documentNode, {
      variant: 'secondary', small: true,
      label: paused ? 'Riattiva' : 'Ritira',
      attrs: { type: 'button', 'data-action': 'retire-agent' },
    });
    retire.disabled = (retireEntry?.busy ?? false);
    retire.addEventListener('click', () => {
      // The shared wait (admin-cta-busy guard, main rossa after #879): the
      // press shows it is working; the repaint keeps «Ritiro…» from
      // entry.busy, and a press that only opens Conferma gets the button back.
      const release = uiHold(retire, paused ? 'Riattivo…' : 'Ritiro…');
      void retireAgent(card, !paused).finally(() => release());
    });
    row.appendChild(retire);
    manage.appendChild(row);
    if (editOpen) manage.appendChild(renderEditPanel(card));
    if (retireEntry && (retireEntry.confirm || retireEntry.error !== '' || retireEntry.unavailable)) {
      manage.appendChild(renderRetireBox(card, paused, retireEntry));
    }
    return manage;
  }

  /** Inline Modifica panel of one hand-written agent. @param {any} card */
  function renderEditPanel(card) {
    const form = editOf(card);
    const panel = el(documentNode, 'div', 'bo-agent-edit');
    panel.setAttribute('data-edit', card.sourceKey);
    panel.appendChild(el(documentNode, 'h4', undefined, `Modifica ${card.name}`));
    // A refusal the server answered carries no field: like «Nuovo agente»,
    // it stays on top of the panel — only the checked field errors move
    // next to their control (review #879 giro 2 P2).
    if (form.error !== '' && form.field === null && !form.unavailable) {
      const top = el(documentNode, 'p', 'bo-seq-create-error', form.error);
      top.setAttribute('role', 'alert');
      panel.appendChild(top);
    }
    const fieldRow = (fieldKey, labelText, id, control) => {
      const rowEl = el(documentNode, 'div', 'ui-field-row bo-seq-field');
      const label = el(documentNode, 'label', 'ui-label bo-seq-field-label', labelText);
      label.setAttribute('for', id);
      control.setAttribute('id', id);
      rowEl.appendChild(label);
      rowEl.appendChild(control);
      if (form.error !== '' && form.field === fieldKey) showFieldError(rowEl, control, form.error);
      return rowEl;
    };
    const control = (tag, name, value, max, placeholder) => {
      const node = el(documentNode, tag, 'ui-field', undefined);
      if (tag === 'input') node.setAttribute('type', 'text');
      node.setAttribute('name', name);
      node.setAttribute('maxlength', String(max));
      if (placeholder) node.setAttribute('placeholder', placeholder);
      node.value = value;
      return node;
    };
    const name = control('input', 'agent-edit-name', form.name, NEW_AGENT_LIMITS.name, '');
    name.addEventListener('input', () => { form.name = String(name.value ?? ''); });
    panel.appendChild(fieldRow('name', 'Nome', `bo-agent-edit-name-${card.sourceKey}`, name));
    const role = control('input', 'agent-edit-role', form.role, NEW_AGENT_LIMITS.role, '');
    role.addEventListener('input', () => { form.role = String(role.value ?? ''); });
    panel.appendChild(fieldRow('role', 'Di cosa si occupa', `bo-agent-edit-role-${card.sourceKey}`, role));
    const instructions = control('textarea', 'agent-edit-instructions', form.instructions, NEW_AGENT_LIMITS.instructions, '');
    instructions.setAttribute('rows', '3');
    instructions.addEventListener('input', () => { form.instructions = String(instructions.value ?? ''); });
    panel.appendChild(fieldRow('instructions', 'Come lavora', `bo-agent-edit-instructions-${card.sourceKey}`, instructions));
    const cap = control('input', 'agent-edit-cap', form.cap, 12, 'Es. 10');
    cap.setAttribute('inputmode', 'decimal');
    cap.addEventListener('input', () => { form.cap = String(cap.value ?? ''); });
    panel.appendChild(fieldRow('cap', 'Tetto di spesa al mese, in euro (vuoto: nessun tetto)', `bo-agent-edit-cap-${card.sourceKey}`, cap));
    if (form.unavailable) {
      const note = el(documentNode, 'p', 'bo-muted bo-agent-edit-unavailable', DA_FARE_UNAVAILABLE_NOTE);
      note.setAttribute('role', 'status');
      panel.appendChild(note);
    }
    const saveRow = el(documentNode, 'div', 'bo-seq-btns');
    // backlog:f06d06f242d6: the same Salva/Annulla as «Nuovo agente» (size included).
    const save = uiButton(documentNode, { variant: 'cta', label: form.busy ? 'Salvo…' : 'Salva', attrs: { type: 'button', 'data-action': 'save-agent-edit' } });
    save.disabled = form.busy;
    save.addEventListener('click', () => {
      const release = uiHold(save, 'Salvo…');
      void saveAgentEdit(card).finally(() => release());
    });
    saveRow.appendChild(save);
    const cancel = uiButton(documentNode, { variant: 'secondary', label: 'Annulla', attrs: { type: 'button', 'data-action': 'cancel-agent-edit' } });
    cancel.disabled = form.busy;
    cancel.addEventListener('click', () => {
      state.editing.delete(card.sourceKey);
      paint();
    });
    saveRow.appendChild(cancel);
    panel.appendChild(saveRow);
    return panel;
  }

  /** Inline Ritira/Riattiva two-step: confirm on the card, never a native dialog. @param {any} card */
  function renderRetireBox(card, paused, entry) {
    const boxEl = el(documentNode, 'div', 'bo-agent-retire');
    if (entry.confirm && !entry.busy) {
      boxEl.appendChild(el(documentNode, 'p', null, paused
        ? `${card.name} torna attivo e riceve di nuovo incarichi. Continuo?`
        : `Ritiro ${card.name}? Resta nel team ma non riceve più incarichi; quelli dati restano.`));
      const confirmBtn = uiButton(documentNode, {
        variant: 'primary', small: true, label: 'Conferma',
        attrs: { type: 'button', 'data-action': 'confirm-retire-agent' },
      });
      confirmBtn.addEventListener('click', () => {
        // The shared wait (admin-cta-busy guard): «Ritiro…»/«Riattivo…» from
        // the press, the same line the box paints from entry.busy.
        const release = uiHold(confirmBtn, paused ? 'Riattivo…' : 'Ritiro…');
        void retireAgent(card, !paused).finally(() => release());
      });
      boxEl.appendChild(confirmBtn);
      const cancel = uiButton(documentNode, { variant: 'secondary', small: true, label: 'Annulla', attrs: { type: 'button', 'data-action': 'cancel-retire-agent' } });
      cancel.addEventListener('click', () => {
        state.retiring.delete(card.sourceKey);
        paint();
      });
      boxEl.appendChild(cancel);
    }
    if (entry.busy) boxEl.appendChild(el(documentNode, 'p', 'bo-muted', paused ? 'Riattivo…' : 'Ritiro…'));
    if (entry.unavailable) {
      const note = el(documentNode, 'p', 'bo-muted bo-agent-retire-unavailable', DA_FARE_UNAVAILABLE_NOTE);
      note.setAttribute('role', 'status');
      boxEl.appendChild(note);
    }
    if (entry.error !== '') boxEl.appendChild(el(documentNode, 'p', 'bo-seq-error', entry.error));
    return boxEl;
  }

  /**
   * One incarico as a compact row: the phrase on one line (cut with an
   * ellipsis; its full text on hover and on click), schedule and state
   * under it, the outcome chip and the date of the last run on the right.
   * @param {any} assignment
   */
  function renderAssignmentRow(assignment) {
    const item = el(documentNode, 'li', 'bo-agent-assignment');
    if (assignment.lastRun) item.setAttribute('title', assignment.lastRun);
    const main = el(documentNode, 'div', 'bo-agent-run-main');
    const open = state.openPhrases.has(assignment.sourceKey);
    const phrase = el(documentNode, 'button', `bo-agent-phrase${open ? ' is-open' : ''}`, `«${assignment.phrase}»`);
    phrase.setAttribute('type', 'button');
    phrase.setAttribute('title', assignment.phrase);
    phrase.setAttribute('aria-expanded', open ? 'true' : 'false');
    phrase.addEventListener('click', () => {
      const next = !state.openPhrases.has(assignment.sourceKey);
      if (next) state.openPhrases.add(assignment.sourceKey);
      else state.openPhrases.delete(assignment.sourceKey);
      phrase.classList.toggle('is-open', next);
      phrase.setAttribute('aria-expanded', next ? 'true' : 'false');
    });
    main.appendChild(phrase);
    main.appendChild(el(documentNode, 'p', 'bo-agent-when', `${assignment.schedule} · ${assignment.status}`));
    item.appendChild(main);
    const chip = assignment.lastOutcome ? RUN_OUTCOME_CHIP[assignment.lastOutcome] : null;
    if (chip) {
      const side = el(documentNode, 'div', 'bo-agent-run-side');
      // The design-system badge; `neutral` has no authority colour of its
      // own and reads as the plain surface chip.
      const badge = el(documentNode, 'span', null, chip.label);
      badge.setAttribute('class', `ui-badge${chip.tone === 'neutral' ? '' : ` ui-badge-${chip.tone}`} bo-agent-outcome bo-agent-outcome-${assignment.lastOutcome}`);
      side.appendChild(badge);
      if (assignment.lastStamp !== '') side.appendChild(el(documentNode, 'span', 'bo-agent-run-date', assignment.lastStamp));
      item.appendChild(side);
    }
    return item;
  }

  /** Space kept between the top bar (or the window's bottom) and a refused field. */
  const FIELD_SCROLL_GAP = 12;

  /**
   * backlog:f06d06f242d6: the error of one field, next to it and tied to it
   * (aria-describedby and aria-errormessage name the error line, role=alert
   * reads it). Updates in place: typing never repaints the panel.
   * @param {any} row @param {any} control @param {string} message
   */
  function showFieldError(row, control, message) {
    const id = `${control.getAttribute('id') ?? control.getAttribute('name')}-error`;
    let error = row.childNodes ? [...row.childNodes].find((node) => node?.getAttribute?.('data-field-error') === 'true') ?? null : null;
    if (!error) {
      error = el(documentNode, 'p', 'bo-seq-create-error bo-agent-field-error', message);
      error.setAttribute('role', 'alert');
      error.setAttribute('data-field-error', 'true');
      // Right under its control, before any hint.
      const next = control.nextSibling ?? null;
      if (next && typeof row.insertBefore === 'function') row.insertBefore(error, next);
      else row.appendChild(error);
    } else if (error.textContent !== message) {
      error.textContent = message;
    }
    error.setAttribute('id', id);
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-describedby', id);
    control.setAttribute('aria-errormessage', id);
  }
  /** @param {any} row @param {any} control */
  function clearFieldError(row, control) {
    const error = row.childNodes ? [...row.childNodes].find((node) => node?.getAttribute?.('data-field-error') === 'true') ?? null : null;
    if (error && typeof row.removeChild === 'function') row.removeChild(error);
    control.removeAttribute?.('aria-invalid');
    control.removeAttribute?.('aria-describedby');
    control.removeAttribute?.('aria-errormessage');
  }

  /** Focus the first match of `selector` in the mount, when the DOM can. @param {string} selector */
  function focusIn(selector) {
    if (!mount || typeof mount.querySelector !== 'function') return;
    const node = mount.querySelector(selector);
    if (node && typeof node.focus === 'function') node.focus();
  }

  /**
   * Backlog 7d169a3b1dd2: after a refused panel, the error sits next to
   * its field — scroll it into view and focus the control, so a keyboard
   * or screen-reader operator lands where the fix belongs. `scope` roots
   * the search (`null` is the whole mount); no-ops when the DOM cannot.
   * @param {any} scope @param {string | null} name the control's full `name`
   */
  function focusFieldError(scope, name) {
    if (!name || typeof mount?.querySelector !== 'function') return;
    const root = scope && typeof scope.querySelector === 'function' ? scope : mount;
    const node = root.querySelector(`[name="${name}"]`);
    if (!node) return;
    if (typeof node.focus === 'function') node.focus({ preventScroll: true });
    // backlog:f06d06f242d6: field and error (their row) come into view below
    // the sticky top bar, never under it — the bar's own height, measured,
    // is the scroll margin (desktop and phone bars differ).
    const row = typeof node.closest === 'function' ? node.closest('.ui-field-row') ?? node : node;
    try {
      const bar = typeof documentNode?.querySelector === 'function' ? documentNode.querySelector('.bo-topbar') : null;
      const barHeight = bar && typeof bar.getBoundingClientRect === 'function' ? Number(bar.getBoundingClientRect().height) : 0;
      const top = Math.ceil((Number.isFinite(barHeight) ? barHeight : 0) + FIELD_SCROLL_GAP);
      row.setAttribute?.('style', `scroll-margin-top: ${top}px; scroll-margin-bottom: ${FIELD_SCROLL_GAP}px`);
      row.scrollIntoView?.({ block: 'nearest' });
    } catch {
      // A control that cannot scroll still has the focus.
    }
  }

  function openNewAgent() {
    // One caller key per open panel: a retry or a double click replays it.
    // `nameError`: the live check of Nome (review Muse #895), its own slot
    // beside the error of Crea (`error`/`field`), so one never erases the other.
    state.newAgent = { key: issueAdminKey(), name: '', role: '', instructions: '', cap: '', error: '', field: null, nameError: '', busy: false, pending: null };
    paint();
    focusIn('input[name="agent-name"]');
  }

  function closeNewAgent() {
    if (state.newAgent?.busy) return;
    state.newAgent = null;
    paint();
    focusIn('button[data-action="new-agent"]');
  }

  /**
   * «Nuovo agente»: name, role, instructions with an example, optional
   * monthly cap — the same inline creation panel as «Nuova sequenza».
   * Fields write into `state.newAgent` on input, so a repaint (the
   * periodic read) never eats what the operator typed.
   */
  function renderNewAgentPanel() {
    const form = /** @type {any} */ (state.newAgent);
    const panel = el(documentNode, 'section', 'bo-seq-panel bo-agent-new');
    panel.setAttribute('aria-label', 'Nuovo agente');
    panel.addEventListener('keydown', (event) => {
      if (event?.key !== 'Escape') return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      closeNewAgent();
    });
    panel.appendChild(el(documentNode, 'h3', undefined, 'Nuovo agente'));
    // A refusal the server answered carries no field: it stays on top of
    // the panel, as before — only the checked field errors move next to
    // their control.
    if (form.error !== '' && form.field === null) {
      const error = el(documentNode, 'p', 'bo-seq-create-error', form.error);
      error.setAttribute('role', 'alert');
      panel.appendChild(error);
    }
    const fieldRow = (fieldKey, text, id, control, hint = null) => {
      const row = el(documentNode, 'div', 'ui-field-row bo-seq-field');
      const label = el(documentNode, 'label', 'ui-label bo-seq-field-label', text);
      label.setAttribute('for', id);
      control.setAttribute('id', id);
      row.appendChild(label);
      row.appendChild(control);
      // Backlog 7d169a3b1dd2: the refusal sits next to its field —
      // role="alert" for the screen reader — and the control carries
      // aria-invalid while it is the refused one. backlog:f06d06f242d6:
      // the error is tied to its field (aria-describedby, aria-errormessage).
      const own = fieldErrorOf(form, fieldKey);
      if (own !== '') showFieldError(row, control, own);
      else control.removeAttribute?.('aria-invalid');
      if (hint !== null) row.appendChild(el(documentNode, 'p', 'bo-agent-new-hint', hint));
      return row;
    };
    const locked = form.pending !== null;
    if (locked) panel.appendChild(el(documentNode, 'p', 'bo-agent-new-hint bo-agent-new-pending', NEW_AGENT_PENDING_NOTE));
    const field = (tag, name, value, max, placeholder) => {
      const node = el(documentNode, tag, 'ui-field', undefined);
      if (tag === 'input') node.setAttribute('type', 'text');
      if (locked) node.disabled = true;
      node.setAttribute('name', name);
      node.setAttribute('maxlength', String(max));
      if (placeholder) node.setAttribute('placeholder', placeholder);
      node.value = value;
      return node;
    };
    const name = field('input', 'agent-name', form.name, NEW_AGENT_LIMITS.name, 'Es. Auguri');
    const nameRow = fieldRow('name', 'Nome', 'bo-agent-new-name', name, 'È il nome che scrivi dopo la @ per dargli un incarico.');
    // backlog:f06d06f242d6: a name already in the team shows at once, while
    // typing — not after the other fields — and goes as soon as it changes.
    const checkName = () => {
      // An empty name is said at Crea, not while typing — but a stale
      // live line goes at once, so an empty Nome never keeps showing
      // «already taken» while Crea has not spoken yet.
      if (String(form.name ?? '').replace(/^\s*@*\s*/, '').trim() === '') {
        if (form.nameError === '') return;
        form.nameError = '';
        const cleared = fieldErrorOf(form, 'name');
        if (cleared !== '') showFieldError(nameRow, name, cleared);
        else clearFieldError(nameRow, name);
        return;
      }
      const checked = checkNewAgent({ name: form.name, role: 'x', instructions: 'x' }, state.agents);
      // Review Muse #895 (P2): only the name's own errors move here — an
      // error of Crea on another field stays, in state and on screen.
      form.nameError = checked.field === 'name' ? checked.error : '';
      if (form.nameError === '' && form.field === 'name') {
        form.error = '';
        form.field = null;
      }
      const shown = fieldErrorOf(form, 'name');
      if (shown !== '') showFieldError(nameRow, name, shown);
      else clearFieldError(nameRow, name);
    };
    name.addEventListener('input', () => { form.name = String(name.value ?? ''); checkName(); });
    name.addEventListener('blur', checkName);
    panel.appendChild(nameRow);
    const role = field('input', 'agent-role', form.role, NEW_AGENT_LIMITS.role, 'Es. Fa gli auguri ai clienti');
    role.addEventListener('input', () => { form.role = String(role.value ?? ''); });
    panel.appendChild(fieldRow('role', 'Di cosa si occupa', 'bo-agent-new-role', role));
    const instructions = field('textarea', 'agent-instructions', form.instructions, NEW_AGENT_LIMITS.instructions, NEW_AGENT_EXAMPLE);
    instructions.setAttribute('rows', '4');
    instructions.addEventListener('input', () => { form.instructions = String(instructions.value ?? ''); });
    panel.appendChild(fieldRow('instructions', 'Come lavora', 'bo-agent-new-instructions', instructions,
      'Scrivi cosa guarda e cosa ti propone. Prima di fare qualcosa ti chiede sempre l’ok.'));
    const cap = field('input', 'agent-cap', form.cap, 12, 'Es. 10');
    cap.setAttribute('inputmode', 'decimal');
    cap.addEventListener('input', () => { form.cap = String(cap.value ?? ''); });
    panel.appendChild(fieldRow('cap', 'Tetto di spesa al mese, in euro (facoltativo)', 'bo-agent-new-cap', cap,
      'Con un tetto, a ogni incarico scrivi anche quanto costa più o meno un giro.'));
    const row = el(documentNode, 'div', 'bo-seq-btns');
    const submit = uiButton(documentNode, { variant: 'cta', label: locked ? 'Riprova' : 'Crea l’agente', attrs: { type: 'button', 'data-action': 'create-agent' } });
    if (form.busy) uiMarkBusy(submit, 'Creo…');
    submit.addEventListener('click', () => {
      // The shared wait (admin-cta-busy guard): «Creo…» from the press; the
      // repaint keeps it from form.busy while the create runs.
      const release = uiHold(submit, 'Creo…');
      void submitNewAgent().finally(() => release());
    });
    row.appendChild(submit);
    const cancel = uiButton(documentNode, { variant: 'secondary', label: 'Annulla', attrs: { type: 'button', 'data-action': 'cancel-agent' } });
    cancel.disabled = form.busy;
    cancel.addEventListener('click', () => closeNewAgent());
    row.appendChild(cancel);
    panel.appendChild(row);
    return panel;
  }

  /** Create the hand-written agent: check, POST once under the panel key, show it in the team. */
  async function submitNewAgent() {
    const form = state.newAgent;
    if (!form || form.busy) return;
    if (readSpace() !== state.space) {
      await render();
      return;
    }
    // A create whose answer was lost is retried as it was sent: same body,
    // same key. Only a new, checked intent reads the fields.
    let body = form.pending;
    if (body === null) {
      const checked = checkNewAgent(form, state.agents);
      if (checked.error) {
        form.error = checked.error;
        form.field = checked.field ?? null;
        // This Crea just re-checked the name against the team: a live
        // line older than it goes, so an empty Nome reads the
        // missing-name error, never yesterday's «already taken».
        form.nameError = '';
        paint();
        focusFieldError(null, form.field === null ? null : `agent-${form.field}`);
        return;
      }
      body = { spaceId: state.space, key: form.key, ...checked.body };
    }
    form.busy = true;
    form.error = '';
    form.field = null;
    paint();
    try {
      const answer = await bound.request('/api/agents/create', {
        method: 'POST',
        body,
        idempotencyKey: body.key,
      });
      const name = typeof answer?.agent?.name === 'string' ? answer.agent.name : body.name;
      state.newAgent = null;
      state.notice = `${name} è entrato nel tuo team.`;
      if (await reload()) paint();
      else paint();
      focusIn('button[data-action="new-agent"]');
    } catch (error) {
      form.busy = false;
      form.error = newAgentErrorText(error);
      // A refusal the server answered wrote nothing: the corrected panel is
      // a new intent with a new key. A lost answer keeps its key, so the
      // retry replays instead of creating a second agent.
      const status = /** @type {any} */ (error)?.status;
      if (Number.isInteger(status) && status >= 400 && status < 500) {
        form.key = issueAdminKey();
        form.pending = null;
      } else {
        // No answer, or one that cannot say whether the agent was written:
        // lock the panel on what was sent until a retry settles it.
        form.pending = body;
      }
      paint();
    }
  }

  /**
   * Italian text for a refused hand-agent write (Modifica/Ritira).
   * Review #879 giro 2: no `notComposed` — an unserved route reads
   * neutral through isDecisionUnavailable, so a 404 here is a real
   * answer (the agent is gone), never «non sono attivi».
   * @param {unknown} error
   */
  function agentPatchErrorText(error, what) {
    return humanWriteError(error, {
      failed: `Non riesco a ${what} adesso: riprova tra poco. Quello che hai scritto resta qui.`,
    });
  }

  /**
   * Backlog 7d169a3b1dd2: a hand-written agent's own Modifica — name,
   * role, instructions, cap — through update-agent, under one
   * Idempotency-Key from the bound client. A deployment that does not
   * serve it yet (404/405) reads neutral, never an error.
   * @param {any} card @param {Record<string, unknown>} patch @param {string} key
   */
  async function updateHandAgent(card, patch, key) {
    return bound.request('/api/agents/update', {
      method: 'POST',
      body: { spaceId: state.space, agentSourceKey: card.sourceKey, ...patch },
      idempotencyKey: key,
    });
  }

  /**
   * Backlog 7d169a3b1dd2: a hand-written agent's own Ritira/Riattiva —
   * paused/resumed — through set-agent-status, under one Idempotency-Key
   * from the bound client. Writing the status it already carries replays.
   * @param {any} card @param {string} status @param {string} key
   */
  async function setHandAgentStatus(card, status, key) {
    return bound.request('/api/agents/set-status', {
      method: 'POST',
      body: { spaceId: state.space, agentSourceKey: card.sourceKey, status },
      idempotencyKey: key,
    });
  }

  function editOf(card) {
    if (!state.editing.has(card.sourceKey)) {
      state.editing.set(card.sourceKey, {
        key: issueAdminKey(),
        name: card.name,
        role: card.role ?? '',
        instructions: card.instructions ?? '',
        cap: card.capCents === null || card.capCents === undefined ? '' : String(card.capCents / 100),
        error: '',
        field: null,
        unavailable: false,
        busy: false,
      });
    }
    return /** @type {any} */ (state.editing.get(card.sourceKey));
  }

  function retireOf(card) {
    if (!state.retiring.has(card.sourceKey)) {
      state.retiring.set(card.sourceKey, { busy: false, error: '', unavailable: false, confirm: false, key: null });
    }
    return /** @type {any} */ (state.retiring.get(card.sourceKey));
  }

  /** Save the open Modifica panel of one hand-written agent. @param {any} card */
  async function saveAgentEdit(card) {
    const form = editOf(card);
    if (!form || form.busy) return;
    if (readSpace() !== state.space) {
      await render();
      return;
    }
    if (card.id === null) {
      form.error = 'Non riesco a modificare questo agente adesso: ricarica e riprova.';
      form.field = null;
      paint();
      return;
    }
    const others = state.agents.filter((row) => row?.sourceKey !== card.sourceKey);
    const checked = checkNewAgent({ name: form.name, role: form.role, instructions: form.instructions, cap: form.cap }, others);
    if (checked.error) {
      form.error = checked.error;
      form.field = checked.field ?? null;
      form.unavailable = false;
      paint();
      // Review #879 giro 2 P2: paint() detaches the pre-paint panel, so
      // the focus runs from the live mount — like the «Nuovo agente» path.
      focusFieldError(null, form.field === null ? null : `agent-edit-${form.field}`);
      return;
    }
    form.busy = true;
    form.error = '';
    // Review #879 giro 2 P2: a server refusal carries no field — it stays
    // on top of the panel, never next to a stale field marker.
    form.field = null;
    form.unavailable = false;
    paint();
    const body = { ...checked.body };
    // An emptied cap clears the ceiling; a kept value stays untouched —
    // the panel always opens with the current one written in.
    if (form.cap.trim() === '') body.spendingCapCents = null;
    try {
      await updateHandAgent(card, body, form.key);
      state.editing.delete(card.sourceKey);
      state.notice = `${checked.body.name} aggiornato.`;
      if (await reload()) paint();
      else paint();
    } catch (error) {
      form.busy = false;
      if (isDecisionUnavailable(error)) {
        form.unavailable = true;
      } else {
        // A refused Modifica names no field: like «Nuovo agente», a taken
        // name stays on top of the panel, and any other refusal reads as
        // a failure — never «non sono attivi» (an unknown agent is gone,
        // not uncomposed).
        form.error = isNameTaken(error)
          ? AGENT_NAME_TAKEN_NOTE
          : humanWriteError(error, {
            failed: 'Non riesco a salvare la modifica adesso: riprova tra poco. Quello che hai scritto resta qui.',
          });
        form.field = null;
        const status = /** @type {any} */ (error)?.status;
        if (Number.isInteger(status) && status >= 400 && status < 500) form.key = issueAdminKey();
      }
      paint();
    }
  }

  /**
   * Backlog 7d169a3b1dd2: Ritira (or Riattiva) a hand-written agent — an
   * inline Conferma/Annulla two-step, never a native confirm(). A refused
   * write rotates the key; an unserved route reads neutral.
   * @param {any} card @param {boolean} pause
   */
  async function retireAgent(card, pause) {
    const entry = retireOf(card);
    if (entry.busy) return;
    if (readSpace() !== state.space) {
      await render();
      return;
    }
    if (!entry.confirm) {
      entry.confirm = true;
      entry.error = '';
      entry.unavailable = false;
      paint();
      return;
    }
    if (card.id === null) {
      entry.error = 'Non riesco a ritirare questo agente adesso: ricarica e riprova.';
      paint();
      return;
    }
    entry.busy = true;
    entry.error = '';
    paint();
    try {
      if (entry.key === null) entry.key = issueAdminKey();
      await setHandAgentStatus(card, pause ? 'paused' : 'active', entry.key);
      state.retiring.delete(card.sourceKey);
      state.notice = pause
        ? `${card.name} ritirato: resta nel team ma non riceve più incarichi.`
        : `${card.name} riattivato.`;
      const fresh = await reload();
      // backlog:f06d06f242d6: the line uses the badge's own words — an agent
      // with no engine is «Pronto, in attesa del motore», never «attivo».
      if (!pause && fresh) {
        const back = buildAgentCards({ agents: state.agents, assignments: state.assignments, runs: state.runs, nowIso: now(), catalog: state.catalog })
          .find((item) => item.sourceKey === card.sourceKey);
        if (back) state.notice = `${card.name} riattivato: ${lowerFirst(back.statusLabel)}.`;
      }
      paint();
    } catch (error) {
      entry.busy = false;
      if (isDecisionUnavailable(error)) {
        entry.unavailable = true;
      } else {
        entry.error = agentPatchErrorText(error, pause ? 'ritirare l’agente' : 'riattivare l’agente');
        const status = /** @type {any} */ (error)?.status;
        if (Number.isInteger(status) && status >= 400 && status < 500) entry.key = issueAdminKey();
      }
      paint();
    }
  }

  function renderMine(page, cards) {
    const section = el(documentNode, 'section', 'bo-agenti-section');
    const head = el(documentNode, 'div', 'bo-agenti-sectionhead');
    head.appendChild(el(documentNode, 'h3', null, 'I tuoi agenti'));
    // backlog:1f7cb20d3c30: an agent written by hand, beside the catalogue.
    const create = uiButton(documentNode, {
      variant: 'cta',
      label: 'Nuovo agente',
      attrs: { type: 'button', 'data-action': 'new-agent', 'aria-expanded': state.newAgent !== null ? 'true' : 'false' },
    });
    create.addEventListener('click', () => {
      if (state.newAgent !== null) closeNewAgent();
      else openNewAgent();
    });
    head.appendChild(create);
    section.appendChild(head);
    if (state.newAgent !== null) section.appendChild(renderNewAgentPanel());
    if (cards.length === 0) {
      section.appendChild(uiEmpty(documentNode, {
        title: 'Nessun agente nel team',
        text: 'Scegline uno dal catalogo qui sotto, oppure creane uno nuovo: entra nel team e puoi dargli il primo incarico.',
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
    if (state.daFareError !== '') section.appendChild(el(documentNode, 'p', 'bo-seq-error', state.daFareError));
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
        // Review #688: Modifica's request is a «revise».
        const flying = decision !== null && (decision.busy === action || (action === 'edit' && decision.busy === 'revise'));
        const node = uiButton(documentNode, {
          variant, small: true, label: flying ? busyLabel : label,
          attrs: { type: 'button', 'data-action': action },
        });
        node.disabled = locked || off;
        if (flying) node.setAttribute('aria-busy', 'true');
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
          // The deployment's bound for an edited text (pilot#463).
          area.setAttribute('maxlength', '2000');
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
    const kept = focusedField();
    paintPage();
    if (kept) restoreField(kept);
  }

  /**
   * The form field that has the focus inside this view — by name, inside
   * its own edit panel — with the caret, or null.
   */
  function focusedField() {
    const active = documentNode?.activeElement ?? null;
    if (!active || typeof active.getAttribute !== 'function' || typeof mount?.contains !== 'function' || !mount.contains(active)) return null;
    const name = active.getAttribute('name');
    if (!name) return null;
    // Review Muse #895 (P2): the edit panel is found again by comparing its
    // data-edit value (a server sourceKey), never through a selector.
    let edit = null;
    for (let node = active.parentNode ?? null; node && node !== mount; node = node.parentNode ?? null) {
      const key = typeof node.getAttribute === 'function' ? node.getAttribute('data-edit') : null;
      if (key !== null && key !== undefined) { edit = key; break; }
    }
    return { name, edit, start: active.selectionStart ?? null, end: active.selectionEnd ?? null };
  }
  /** @param {{ name: string, edit: string | null, start: number | null, end: number | null }} kept */
  function restoreField(kept) {
    try {
      const root = kept.edit === null ? mount : findNode(mount, (node) => node.getAttribute('data-edit') === kept.edit);
      const node = root ? findNode(root, (candidate) => candidate.getAttribute('name') === kept.name) : null;
      if (!node || node === documentNode.activeElement || typeof node.focus !== 'function') return;
      node.focus({ preventScroll: true });
      if (Number.isInteger(kept.start) && Number.isInteger(kept.end) && typeof node.setSelectionRange === 'function') {
        node.setSelectionRange(kept.start, kept.end);
      }
    } catch {
      // A field that cannot take the caret back is left as it is.
    }
  }
  /**
   * The first element under `root`, in document order, that `test` accepts
   * — attribute values compared as values, never spliced into a selector.
   * @param {any} root @param {(node: any) => boolean} test
   */
  function findNode(root, test) {
    const kids = root?.children ?? root?.childNodes ?? [];
    for (const child of Array.from(kids)) {
      if (!child || typeof child.getAttribute !== 'function') continue;
      if (test(child)) return child;
      const found = findNode(child, test);
      if (found) return found;
    }
    return null;
  }

  function paintPage() {
    // backlog:f06d06f242d6: a repaint (the periodic read, a follow-up)
    // rebuilds the page: the field being typed in keeps the cursor and its
    // place in the text — opening «Nuovo agente» lands in Nome and stays.
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
    const cards = buildAgentCards({ agents: state.agents, assignments: state.assignments, runs: state.runs, nowIso, catalog: state.catalog });
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
    stopAutoRefresh();
    polling = true;
    const space = readSpace();
    if (space !== state.space) {
      state.space = space;
      state.drafts = new Map();
      state.expandedRuns = new Set();
      state.openPhrases = new Set();
      state.newAgent = null;
      state.editing.clear();
      state.retiring.clear();
      state.notice = '';
      state.addError = '';
    }
    // A fresh read is the truth for the row state; a decision still queued
    // stays locked through state.queued (review #688) until its run leaves
    // `proposed`.
    state.decisions = new Map();
    state.loaded = false;
    // Backlog 7d169a3b1dd2: coming back paints the last good read at once
    // (instant, under a second) and then reads again — the reload below
    // still replaces it, so stale cards never outlive one read.
    const hit = space === null ? null : AGENTI_CACHE.get(space) ?? null;
    if (hit !== null && space === state.space) {
      applyData(hit);
      paint();
    } else {
      paint();
    }
    if (await reload()) paint();
    // Backlog 2df6a513cc4d: keep reading while the screen is shown, so a
    // run that lands after Affida paints without a manual reload.
    schedulePoll();
  }

  return { render, paint, state, invalidate };
}
