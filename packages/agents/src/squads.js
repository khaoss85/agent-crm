// @ts-check

import { AppError, ValidationError } from '../../core/index.js';
import { AGENT_CATALOG } from './catalog.js';
import { checkCostCents, checkSpaceId, monthStartIso, spentSince } from './agents.js';

/**
 * Agent squads (backlog:0d2d8f2e) — teams of teammate agents with an
 * objective and a metric, phases with an approval mode, sources with a time,
 * outputs and a monthly spending cap. A squad is created from a ready-made
 * template or from a free-text brief (matched to a template by keywords, or
 * refused with SQUAD_BRIEF_UNCLEAR), or from an explicit plan (the fake-AI
 * seam, the same shape a deployment's planner produces).
 *
 * What this file owns: pure validation and read models. Writes go through
 * the operations in operations.js, which create the member agents and their
 * routines through the existing create-agent / create-assignment operations
 * (MEM_ACC_REUSE: no second agent engine, no second schedule).
 *
 * Honest limits, said on screen and never faked:
 * - the squad cap is counted in the overview (`spentCents` against
 *   `capCents`); stopping the sweep over the cap is engine work that ships
 *   after this slice (the member agents' own caps already stop them);
 * - the advisor metric `actual` is null until the native advisor of the
 *   engine feeds it (the Orchestro routine/advisor plan, asked 12/11); the
 *   overview counts run outcomes from production rows, never invents them.
 */

/** Approval a phase asks for: none (versioned artifact), a human review, the owner. */
export const PHASE_APPROVALS = Object.freeze(['none', 'review', 'owner']);

export const PHASE_APPROVAL_LABEL = Object.freeze({
  none: 'Nessuna approvazione',
  review: 'Revisione',
  owner: 'Proprietario',
});

/** @param {unknown} value @param {string} field @param {number} max */
function boundedLine(value, field, max = 1024) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidationError(`${field} must be bounded single-line text`, { field });
  }
  return value;
}

/** @param {unknown} value */
function foldBrief(value) {
  return String(value ?? '').toLowerCase()
    .replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôö]/g, 'o')
    .replace(/[ùúûü]/g, 'u');
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** @param {unknown} value @param {string} field */
function checkTimeOfDay(value, field) {
  if (typeof value !== 'string' || !TIME_RE.test(value)) {
    throw new ValidationError(`${field} must be HH:MM`, { field });
  }
  return value;
}

/**
 * @typedef {{ key: string, name?: string, role?: string, instructions?: string, catalogSlug?: string, spendingCapCents?: number|null }} SquadMemberSpec
 * @typedef {{ memberKey: string, phrase: string, plan?: unknown, costPerRunCents?: number }} SquadRoutineSpec
 * @typedef {{ name: string, approval: string }} SquadPhaseSpec
 * @typedef {{ channel: string, timeOfDay: string }} SquadSourceSpec
 */

/** @type {ReadonlyArray<{ slug: string, name: string, objective: string, metric: { name: string, target: number, unit: string }, members: any, routines: any, phases: any, sources: any, outputs: any }>} */
export const SQUAD_TEMPLATES = Object.freeze([
  Object.freeze({
    slug: 'lead-generation',
    name: 'Acquisizione lead',
    objective: 'Riempire la settimana di nuovi contatti da lavorare.',
    metric: Object.freeze({ name: 'Nuovi lead contattati', target: 20, unit: 'lead/settimana' }),
    members: Object.freeze([
      Object.freeze({
        key: 'cacciatore',
        name: 'Cacciatore lead',
        role: 'Trova nuovi contatti dai canali',
        instructions: 'Cerca i nuovi contatti arrivati da WhatsApp, Instagram, form del sito e chiamate senza risposta, e prepara un primo messaggio per ciascuno. Ogni messaggio aspetta il tuo ok.',
      }),
      Object.freeze({ key: 'riaggancio', catalogSlug: 'riaggancio' }),
    ]),
    routines: Object.freeze([
      Object.freeze({ memberKey: 'cacciatore', phrase: 'ogni giorno trova i nuovi lead arrivati', plan: Object.freeze({ cadence: 'daily', timeOfDay: '08:00' }) }),
      Object.freeze({ memberKey: 'riaggancio', phrase: 'ogni giorno ricontatta i lead senza risposta', plan: Object.freeze({ cadence: 'daily', timeOfDay: '09:00' }) }),
    ]),
    phases: Object.freeze([
      Object.freeze({ name: 'Ricerca', approval: 'review' }),
      Object.freeze({ name: 'Primo contatto', approval: 'owner' }),
      Object.freeze({ name: 'Follow-up', approval: 'review' }),
    ]),
    sources: Object.freeze([
      Object.freeze({ channel: 'WhatsApp', timeOfDay: '08:00' }),
      Object.freeze({ channel: 'Instagram', timeOfDay: '08:00' }),
      Object.freeze({ channel: 'Form del sito', timeOfDay: '09:00' }),
    ]),
    outputs: Object.freeze(['Primo messaggio pronto per ogni lead', 'Lista dei lead senza risposta con sollecito']),
  }),
  Object.freeze({
    slug: 'social-posting',
    name: 'Presenza social',
    objective: 'Tenere i canali social vivi ogni settimana.',
    metric: Object.freeze({ name: 'Post pubblicati', target: 5, unit: 'post/settimana' }),
    members: Object.freeze([
      Object.freeze({
        key: 'social',
        name: 'Social media manager',
        role: 'Prepara i post della settimana',
        instructions: 'Prepara i testi dei post per Instagram, Facebook e TikTok partendo dalle novità della settimana: offerte, eventi, risultati dei clienti. Ogni post aspetta il tuo ok prima di uscire.',
      }),
      Object.freeze({
        key: 'idee',
        name: 'Cacciatore di idee',
        role: 'Raccoglie spunti per i contenuti',
        instructions: 'Raccoglie spunti per i post: recensioni, domande dei clienti, dietro le quinte. Ne fa una lista corta ogni settimana, senza pubblicare niente da solo.',
      }),
    ]),
    routines: Object.freeze([
      Object.freeze({ memberKey: 'social', phrase: 'ogni lunedì prepara i post della settimana', plan: Object.freeze({ cadence: 'weekly', weekday: 1, timeOfDay: '08:00' }) }),
      Object.freeze({ memberKey: 'idee', phrase: 'ogni venerdì raccogli gli spunti per i post', plan: Object.freeze({ cadence: 'weekly', weekday: 5, timeOfDay: '08:00' }) }),
    ]),
    phases: Object.freeze([
      Object.freeze({ name: 'Idee', approval: 'review' }),
      Object.freeze({ name: 'Bozze', approval: 'review' }),
      Object.freeze({ name: 'Pubblicazione', approval: 'owner' }),
    ]),
    sources: Object.freeze([
      Object.freeze({ channel: 'Instagram', timeOfDay: '08:00' }),
      Object.freeze({ channel: 'Facebook', timeOfDay: '08:00' }),
      Object.freeze({ channel: 'TikTok', timeOfDay: '08:00' }),
    ]),
    outputs: Object.freeze(['Calendario dei post della settimana', 'Testi pronti da approvare']),
  }),
  Object.freeze({
    slug: 'sales-outreach',
    name: 'Outreach vendite',
    objective: 'Riaprire le conversazioni che si sono fermate.',
    metric: Object.freeze({ name: 'Risposte ricevute', target: 10, unit: 'risposte/settimana' }),
    members: Object.freeze([
      Object.freeze({
        key: 'outreach',
        name: 'Addetto outreach',
        role: 'Scrive a chi si è fermato',
        instructions: 'Trova le conversazioni ferme da qualche giorno e prepara un messaggio per riaprirle, personale e corto. Ogni messaggio aspetta il tuo ok.',
      }),
      Object.freeze({ key: 'solleciti', catalogSlug: 'solleciti-offerte' }),
    ]),
    routines: Object.freeze([
      Object.freeze({ memberKey: 'outreach', phrase: 'ogni giorno riapri le conversazioni ferme', plan: Object.freeze({ cadence: 'daily', timeOfDay: '09:00' }) }),
      Object.freeze({ memberKey: 'solleciti', phrase: 'ogni giorno controlla le offerte ferme', plan: Object.freeze({ cadence: 'daily', timeOfDay: '10:00' }) }),
    ]),
    phases: Object.freeze([
      Object.freeze({ name: 'Selezione', approval: 'review' }),
      Object.freeze({ name: 'Messaggio', approval: 'owner' }),
      Object.freeze({ name: 'Sollecito', approval: 'review' }),
    ]),
    sources: Object.freeze([
      Object.freeze({ channel: 'WhatsApp', timeOfDay: '09:00' }),
      Object.freeze({ channel: 'Email', timeOfDay: '09:00' }),
    ]),
    outputs: Object.freeze(['Messaggi di riapertura pronti', 'Solleciti per le offerte ferme']),
  }),
  Object.freeze({
    slug: 'discovery',
    name: 'Discovery',
    objective: "Riempire l'agenda di prime chiamate utili.",
    metric: Object.freeze({ name: 'Prime chiamate fissate', target: 8, unit: 'chiamate/settimana' }),
    members: Object.freeze([
      Object.freeze({
        key: 'qualifica',
        name: 'Qualificatore',
        role: 'Sceglie chi chiamare per primo',
        instructions: 'Guarda i nuovi contatti e sceglie i più promettenti, con una riga di motivo per ciascuno. Non chiama nessuno da solo.',
      }),
      Object.freeze({
        key: 'agenda',
        name: 'Addetto agenda',
        role: 'Propone gli slot per la chiamata',
        instructions: 'Prepara la proposta di appuntamento per i contatti scelti, con due o tre orari. Ogni proposta aspetta il tuo ok.',
      }),
    ]),
    routines: Object.freeze([
      Object.freeze({ memberKey: 'qualifica', phrase: 'ogni giorno scegli i contatti da chiamare', plan: Object.freeze({ cadence: 'daily', timeOfDay: '08:00' }) }),
      Object.freeze({ memberKey: 'agenda', phrase: 'ogni giorno prepara le proposte di appuntamento', plan: Object.freeze({ cadence: 'daily', timeOfDay: '11:00' }) }),
    ]),
    phases: Object.freeze([
      Object.freeze({ name: 'Scelta', approval: 'review' }),
      Object.freeze({ name: 'Invito', approval: 'owner' }),
    ]),
    sources: Object.freeze([
      Object.freeze({ channel: 'Form del sito', timeOfDay: '08:00' }),
      Object.freeze({ channel: 'Chiamate', timeOfDay: '08:00' }),
    ]),
    outputs: Object.freeze(['Lista dei contatti da chiamare con motivo', 'Proposte di appuntamento']),
  }),
  Object.freeze({
    slug: 'contenuti',
    name: 'Contenuti',
    objective: 'Pubblicare contenuti utili ogni mese.',
    metric: Object.freeze({ name: 'Contenuti pubblicati', target: 4, unit: 'contenuti/mese' }),
    members: Object.freeze([
      Object.freeze({
        key: 'redattore',
        name: 'Redattore',
        role: 'Scrive le bozze',
        instructions: 'Scrive le bozze degli articoli e della newsletter partendo dagli appunti e dalle domande dei clienti. Ogni bozza aspetta la revisione.',
      }),
      Object.freeze({
        key: 'revisore',
        name: 'Revisore',
        role: 'Rilegge e chiude',
        instructions: "Rilegge le bozze, corregge e prepara la versione da pubblicare. Niente esce senza il tuo ok.",
      }),
    ]),
    routines: Object.freeze([
      Object.freeze({ memberKey: 'redattore', phrase: 'ogni mese scrivi la bozza dei contenuti', plan: Object.freeze({ cadence: 'monthly', timeOfDay: '08:00' }) }),
      Object.freeze({ memberKey: 'revisore', phrase: 'ogni mese rileggi le bozze', plan: Object.freeze({ cadence: 'monthly', timeOfDay: '08:00' }) }),
    ]),
    phases: Object.freeze([
      Object.freeze({ name: 'Bozza', approval: 'review' }),
      Object.freeze({ name: 'Revisione', approval: 'review' }),
      Object.freeze({ name: 'Pubblicazione', approval: 'owner' }),
    ]),
    sources: Object.freeze([
      Object.freeze({ channel: 'Email', timeOfDay: '08:00' }),
    ]),
    outputs: Object.freeze(['Bozze del mese', 'Versione da pubblicare']),
  }),
]);

/** The source key a squad takes in one space. @param {string} spaceId @param {string} key */
export function squadSourceKey(spaceId, key) {
  return `squad:${spaceId}:${key}`;
}

/** @param {unknown} key */
function checkCallerKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(key)) {
    throw new ValidationError('key must be a caller key of 8 to 80 safe characters', { field: 'key' });
  }
  return key;
}

const BRIEF_KEYWORDS = Object.freeze([
  ['lead-generation', ['lead', 'contatti', 'clienti nuovi', 'acquisizione', 'prospect']],
  ['social-posting', ['social', 'post', 'instagram', 'tiktok', 'facebook']],
  ['sales-outreach', ['vendite', 'outreach', 'offerte ferme', 'sollecit', 'preventiv', 'follow-up', 'followup']],
  ['discovery', ['discovery', 'chiamat', 'appuntament', 'conoscitiv', 'prime visite', 'agenda']],
  ['contenuti', ['contenut', 'articol', 'blog', 'newsletter', 'redazione']],
]);

/**
 * A free-text brief becomes the template its words name («una squadra che
 * segue i lead WhatsApp» → lead-generation). A brief that names none
 * refuses with SQUAD_BRIEF_UNCLEAR — the caller passes an explicit plan.
 * @param {unknown} brief
 */
export function parseSquadBrief(brief) {
  const text = foldBrief(boundedLine(brief, 'brief', 500));
  for (const [slug, words] of BRIEF_KEYWORDS) {
    if (words.some((word) => text.includes(word))) {
      return SQUAD_TEMPLATES.find((entry) => entry.slug === slug) ?? null;
    }
  }
  throw new AppError('This brief does not name a squad template: pass an explicit plan', {
    code: 'SQUAD_BRIEF_UNCLEAR', status: 422,
  });
}

/** @param {unknown} value */
export function checkPhaseApproval(value) {
  if (!PHASE_APPROVALS.includes(/** @type {any} */ (value))) {
    throw new ValidationError('phase approval must be one of none, review, owner', { field: 'phases.approval' });
  }
  return /** @type {string} */ (value);
}

/** Fill a member from the catalogue entry it names, or validate the hand-written one. @param {unknown} member */
export function checkSquadMember(member) {
  const record = member && typeof member === 'object' ? member : {};
  const key = boundedLine(/** @type {any} */ (record).key ?? '', 'members.key', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key)) {
    throw new ValidationError('members.key must be a safe key', { field: 'members.key' });
  }
  const catalogSlug = /** @type {any} */ (record).catalogSlug;
  if (catalogSlug !== undefined && catalogSlug !== null) {
    const slug = String(catalogSlug).trim().toLowerCase();
    const entry = AGENT_CATALOG.find((candidate) => candidate.slug === slug);
    if (!entry) throw new ValidationError(`unknown catalogue agent: ${slug.slice(0, 64)}`, { field: 'members.catalogSlug' });
    return {
      key,
      name: entry.name,
      role: entry.role,
      instructions: entry.instructions,
      spendingCapCents: checkCostCents(/** @type {any} */ (record).spendingCapCents ?? null, 'members.spendingCapCents'),
    };
  }
  return {
    key,
    name: boundedLine(/** @type {any} */ (record).name ?? '', 'members.name', 120),
    role: boundedLine(/** @type {any} */ (record).role ?? '', 'members.role', 120),
    instructions: boundedLine(/** @type {any} */ (record).instructions ?? '', 'members.instructions', 4000),
    spendingCapCents: checkCostCents(/** @type {any} */ (record).spendingCapCents ?? null, 'members.spendingCapCents'),
  };
}

/** @param {unknown} routine @param {ReadonlyArray<string>} memberKeys */
export function checkSquadRoutine(routine, memberKeys) {
  const record = routine && typeof routine === 'object' ? routine : {};
  const memberKey = boundedLine(/** @type {any} */ (record).memberKey ?? '', 'routines.memberKey', 64);
  if (!memberKeys.includes(memberKey)) {
    throw new ValidationError(`routine memberKey ${memberKey.slice(0, 64)} is not a squad member`, { field: 'routines.memberKey' });
  }
  const phrase = boundedLine(/** @type {any} */ (record).phrase ?? '', 'routines.phrase', 280);
  return {
    memberKey,
    phrase,
    plan: /** @type {any} */ (record).plan ?? null,
    costPerRunCents: checkCostCents(/** @type {any} */ (record).costPerRunCents ?? 0, 'routines.costPerRunCents') ?? 0,
  };
}

/** Validate an explicit squad plan (the fake-AI seam). @param {unknown} plan */
export function checkSquadPlan(plan) {
  const record = plan && typeof plan === 'object' ? plan : {};
  const rawMembers = /** @type {any} */ (record).members;
  if (!Array.isArray(rawMembers) || rawMembers.length === 0 || rawMembers.length > 8) {
    throw new ValidationError('plan needs 1 to 8 members', { field: 'plan.members' });
  }
  const keys = rawMembers.map((member) => checkSquadMember(member).key);
  if (new Set(keys).size !== keys.length) {
    throw new ValidationError('plan member keys must be unique', { field: 'plan.members' });
  }
  const members = rawMembers.map((member) => checkSquadMember(member));
  const rawRoutines = /** @type {any} */ (record).routines ?? [];
  if (!Array.isArray(rawRoutines) || rawRoutines.length > 12) {
    throw new ValidationError('plan routines must be a list of at most 12', { field: 'plan.routines' });
  }
  const routines = rawRoutines.map((routine) => checkSquadRoutine(routine, keys));
  const rawPhases = /** @type {any} */ (record).phases;
  if (!Array.isArray(rawPhases) || rawPhases.length === 0 || rawPhases.length > 6) {
    throw new ValidationError('plan needs 1 to 6 phases', { field: 'plan.phases' });
  }
  const phases = rawPhases.map((phase) => {
    const item = phase && typeof phase === 'object' ? phase : {};
    return { name: boundedLine(/** @type {any} */ (item).name ?? '', 'phases.name', 80), approval: checkPhaseApproval(/** @type {any} */ (item).approval) };
  });
  const rawSources = /** @type {any} */ (record).sources ?? [];
  if (!Array.isArray(rawSources) || rawSources.length > 6) {
    throw new ValidationError('plan sources must be a list of at most 6', { field: 'plan.sources' });
  }
  const sources = rawSources.map((source) => {
    const item = source && typeof source === 'object' ? source : {};
    return {
      channel: boundedLine(/** @type {any} */ (item).channel ?? '', 'sources.channel', 80),
      timeOfDay: checkTimeOfDay(/** @type {any} */ (item).timeOfDay, 'sources.timeOfDay'),
    };
  });
  const rawOutputs = /** @type {any} */ (record).outputs ?? [];
  if (!Array.isArray(rawOutputs) || rawOutputs.length > 10) {
    throw new ValidationError('plan outputs must be a list of at most 10', { field: 'plan.outputs' });
  }
  const outputs = rawOutputs.map((output) => boundedLine(output, 'outputs', 140));
  const rawMetric = /** @type {any} */ (record).metric ?? {};
  const metricObject = rawMetric && typeof rawMetric === 'object' ? rawMetric : {};
  return {
    name: boundedLine(/** @type {any} */ (record).name ?? '', 'plan.name', 120),
    objective: boundedLine(/** @type {any} */ (record).objective ?? '', 'plan.objective', 280),
    metric: {
      name: boundedLine(/** @type {any} */ (metricObject).name ?? '', 'plan.metric.name', 80),
      target: checkCostCents(/** @type {any} */ (metricObject).target, 'plan.metric.target') ?? 0,
      unit: boundedLine(/** @type {any} */ (metricObject).unit ?? '', 'plan.metric.unit', 24),
    },
    members,
    routines,
    phases,
    sources,
    outputs,
  };
}

/**
 * Resolve what the squad becomes: a template by slug, a brief matched to a
 * template by keywords, or an explicit plan. Overrides (name, cap) win over
 * the template; the template keeps its slug on the row.
 * @param {{ templateSlug?: unknown, brief?: unknown, plan?: unknown, name?: unknown, spendingCapCents?: unknown }} input
 */
export function resolveSquadSpec(input) {
  const record = input && typeof input === 'object' ? input : {};
  const plan = /** @type {any} */ (record).plan;
  const templateSlug = /** @type {any} */ (record).templateSlug;
  const brief = /** @type {any} */ (record).brief;
  let spec;
  let slug = null;
  if (plan !== undefined && plan !== null) {
    spec = checkSquadPlan(plan);
  } else if (templateSlug !== undefined && templateSlug !== null) {
    slug = String(templateSlug).trim().toLowerCase();
    const template = SQUAD_TEMPLATES.find((entry) => entry.slug === slug);
    if (!template) throw new ValidationError(`unknown squad template: ${slug.slice(0, 64)}`, { field: 'templateSlug' });
    spec = {
      name: template.name,
      objective: template.objective,
      metric: { ...template.metric },
      members: template.members.map((member) => checkSquadMember(member)),
      routines: template.routines.map((routine) => checkSquadRoutine(routine, template.members.map((member) => member.key))),
      phases: template.phases.map((phase) => ({ ...phase })),
      sources: template.sources.map((source) => ({ ...source })),
      outputs: [...template.outputs],
    };
  } else if (brief !== undefined && brief !== null && String(brief).trim() !== '') {
    const template = parseSquadBrief(brief);
    slug = template.slug;
    spec = {
      name: template.name,
      objective: template.objective,
      metric: { ...template.metric },
      members: template.members.map((member) => checkSquadMember(member)),
      routines: template.routines.map((routine) => checkSquadRoutine(routine, template.members.map((member) => member.key))),
      phases: template.phases.map((phase) => ({ ...phase })),
      sources: template.sources.map((source) => ({ ...source })),
      outputs: [...template.outputs],
    };
  } else {
    throw new ValidationError('a squad needs a templateSlug, a brief or an explicit plan', { field: 'templateSlug' });
  }
  const name = /** @type {any} */ (record).name;
  if (name !== undefined && name !== null && String(name).trim() !== '') {
    spec.name = boundedLine(name, 'name', 120);
  }
  const spendingCapCents = checkCostCents(/** @type {any} */ (record).spendingCapCents ?? null, 'spendingCapCents');
  return { ...spec, templateSlug: slug, spendingCapCents };
}

/** Validate the create-squad input. */
export function checkSquadInput(record) {
  const input = record && typeof record === 'object' ? record : {};
  if (/** @type {any} */ (input).plan === undefined && /** @type {any} */ (input).templateSlug === undefined && /** @type {any} */ (input).brief === undefined) {
    throw new ValidationError('a squad needs a templateSlug, a brief or an explicit plan', { field: 'templateSlug' });
  }
  // backlog:0d2d8f2e (review #875): squads store no ownership field, so an
  // ownerId would be accepted and silently dropped — the caller would
  // believe ownership was recorded while any future owner-based check would
  // fail open. Refuse it instead: pass no ownerId.
  if (/** @type {any} */ (input).ownerId !== undefined && /** @type {any} */ (input).ownerId !== null) {
    throw new ValidationError('squads store no ownerId: drop it from the request', { field: 'ownerId' });
  }
  const spec = resolveSquadSpec(input);
  if (spec.metric.target <= 0) {
    throw new ValidationError('plan.metric.target must be positive', { field: 'plan.metric.target' });
  }
  return {
    spaceId: checkSpaceId(input.spaceId),
    sourceKey: boundedLine(input.sourceKey, 'sourceKey', 256),
    name: spec.name,
    objective: spec.objective,
    metric: spec.metric,
    members: spec.members,
    routines: spec.routines,
    phases: spec.phases,
    sources: spec.sources,
    outputs: spec.outputs,
    spendingCapCents: spec.spendingCapCents,
    templateSlug: spec.templateSlug,
    brief: /** @type {any} */ (input).brief === undefined || /** @type {any} */ (input).brief === null
      ? null
      : boundedLine(/** @type {any} */ (input).brief, 'brief', 500),
  };
}

/** A member agent answers in the squad's name, so two squads never share an @name. */
export function squadMemberAgentName(squadName, memberName) {
  return `${squadName} · ${memberName}`;
}

/** Fail-closed decode of a stored squad row (members, phases, sources, outputs). @param {any} row */
export function decodeSquadRow(row) {
  const corrupt = (field) => {
    throw new AppError(`Stored squad ${field} is not a list`, { code: 'SQUAD_ROW_CORRUPT', status: 500 });
  };
  const parse = (value, field) => {
    if (value === null || value === undefined || value === '') return field === 'sources' || field === 'outputs' ? [] : null;
    let parsed;
    try {
      parsed = JSON.parse(String(value));
    } catch {
      throw new AppError(`Stored squad ${field} is not JSON`, { code: 'SQUAD_ROW_CORRUPT', status: 500 });
    }
    // backlog:0d2d8f2e (review #875): valid JSON of the wrong shape (a
    // string, a number, an object) is still corrupt — the overview maps
    // over these lists and must answer SQUAD_ROW_CORRUPT, never TypeError.
    if (!Array.isArray(parsed)) corrupt(field);
    return parsed;
  };
  const members = parse(row?.membersJson, 'members') ?? [];
  for (const member of members) {
    if (!member || typeof member !== 'object' || typeof member.agentSourceKey !== 'string' || member.agentSourceKey === '') {
      corrupt('members');
    }
  }
  return {
    ...row,
    members,
    phases: parse(row?.phasesJson, 'phases') ?? [],
    sources: parse(row?.sourcesJson, 'sources') ?? [],
    outputs: parse(row?.outputsJson, 'outputs') ?? [],
  };
}

/**
 * The per-squad view (backlog:0d2d8f2e §2): backlog A (active assignments of
 * the member agents, the work to do), routines (the recurring ones), backlog
 * B (proposed runs waiting for a human — the same rows the owner approves,
 * rejects or edits through approve-run / reject-run / revise-run), and the
 * advisor metric against the objective (`actual` stays null until the native
 * advisor of the engine feeds it; outcome counts come from production rows).
 */
export function buildSquadOverview({ squad, agents, assignments, runs, now }) {
  const agentByKey = new Map((agents ?? []).map((agent) => [agent?.sourceKey, agent]));
  const backlogA = (assignments ?? [])
    .filter((assignment) => assignment?.status === 'active')
    .map((assignment) => ({
      agentSourceKey: assignment?.agentSourceKey,
      agentName: agentByKey.get(assignment?.agentSourceKey)?.name ?? null,
      phrase: assignment?.phrase,
      cadence: assignment?.cadence,
      nextRunAt: assignment?.nextRunAt,
      costPerRunCents: assignment?.costPerRunCents ?? 0,
    }))
    .sort((left, right) => String(left.nextRunAt ?? '').localeCompare(String(right.nextRunAt ?? '')));
  const routines = backlogA.filter((item) => item.cadence !== 'once');
  const countProposals = (run) => {
    const raw = run?.proposals;
    if (Array.isArray(raw)) return raw.length;
    if (typeof raw === 'string' && raw !== '') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.length : 0;
      } catch {
        return 0;
      }
    }
    return 0;
  };
  const backlogB = (runs ?? [])
    .filter((run) => run?.outcome === 'proposed')
    .map((run) => ({
      runSourceKey: run?.sourceKey,
      agentSourceKey: run?.agentSourceKey,
      agentName: agentByKey.get(run?.agentSourceKey)?.name ?? null,
      decidedAt: run?.decidedAt ?? run?.startedAt,
      proposals: countProposals(run),
      costCents: run?.costCents ?? 0,
    }))
    .sort((left, right) => String(left.decidedAt ?? '').localeCompare(String(right.decidedAt ?? '')));
  const runsByOutcome = {};
  for (const run of runs ?? []) {
    const outcome = run?.outcome;
    if (typeof outcome === 'string' && outcome !== '') {
      runsByOutcome[outcome] = (runsByOutcome[outcome] ?? 0) + 1;
    }
  }
  const spentCents = spentSince(runs ?? [], monthStartIso(now));
  const capCents = squad?.spendingCapCents ?? null;
  return {
    squad: {
      sourceKey: squad?.sourceKey,
      name: squad?.name,
      objective: squad?.objective,
      metric: { name: squad?.metricName, target: squad?.metricTarget, unit: squad?.metricUnit, actual: null },
      phases: squad?.phases ?? [],
      sources: squad?.sources ?? [],
      outputs: squad?.outputs ?? [],
      templateSlug: squad?.templateSlug ?? null,
      status: squad?.status,
    },
    members: (agents ?? []).map((agent) => ({
      agentSourceKey: agent?.sourceKey,
      name: agent?.name,
      role: agent?.role,
      status: agent?.status,
    })),
    backlogA,
    routines,
    backlogB,
    metrics: {
      ...{ name: squad?.metricName, target: squad?.metricTarget, unit: squad?.metricUnit },
      actual: null,
      actualNote: "Lo aggiorna l'advisor nativo del motore (piano routine/advisor chiesto a Orchestro Core il 12/11).",
      runsByOutcome,
      spentCents,
      capCents,
      overCap: capCents !== null && spentCents > capCents,
      capNote: 'Il tetto si conta qui; fermare i giri oltre il tetto arriva con il motore.',
    },
  };
}

export { checkCallerKey };
