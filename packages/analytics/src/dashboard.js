// @ts-check

import { ValidationError } from '../../core/src/errors.js';
import { OPPORTUNITY_STAGES } from '../../core/src/schema.js';
import { compileReport } from './compiler.js';
import { PIPELINE_SEMANTIC_MODEL } from './semantic-model.js';

/**
 * Reporting dashboard model (BO-F5-02, backlog:c3e66b36ddb7).
 *
 * The ONLY reader of pipeline numbers is the declared metric registry:
 * callers compile through {@link dashboardCompilations} and execute with
 * `runReport`, then shape the frozen results here. There is no storage
 * access in this file — an undeclared name fails closed in the compiler
 * before anything is read, and month bucketing below is explicit
 * post-processing over exact (owner, stage, ISO date) groups, never a
 * query of its own.
 *
 * Everything this file returns is frozen JSON-safe data: the HTTP route
 * serves it as-is and the admin screen renders it as text.
 */

export const WON_STAGE = 'won';
export const LOST_STAGE = 'lost';

/** Forward stages in funnel order (approval is a side state, kept in place). */
export const FUNNEL_STAGES = Object.freeze([
  'discovery',
  'qualification',
  'proposal',
  'approval_pending',
  'negotiation',
  'won',
]);

/** Stages that still hold value: every canonical stage except won/lost. */
export const OPEN_STAGES = Object.freeze(
  [...OPPORTUNITY_STAGES].filter((stage) => stage !== WON_STAGE && stage !== LOST_STAGE),
);

const STAGE_LABELS = Object.freeze({
  discovery: 'Scoperta',
  qualification: 'Qualifica',
  proposal: 'Preventivo',
  approval_pending: 'In approvazione',
  negotiation: 'Trattativa',
  won: 'Vinte',
  lost: 'Perse',
});

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export const DASHBOARD_DEFAULT_CURRENCY = 'EUR';
/** Monthly chart depth: the selected period plus the five after it — expected closings only, never the past (backlog:b3d88f6e38ef). */
export const DASHBOARD_MONTHS = 6;
/** Weekly bars on the channel card: the four weeks opening the period month. */
export const DASHBOARD_CHANNEL_WEEKS = 4;
/** CSV uses the Italian list separator, so Excel opens it as columns. */
export const DASHBOARD_CSV_SEPARATOR = ';';

/** @param {string} stage */
export function stageLabel(stage) {
  return /** @type {string} */ (STAGE_LABELS[/** @type {keyof typeof STAGE_LABELS} */ (stage)] ?? stage);
}

/**
 * ISO 4217 codes the runtime can actually format. Cached once: anything else
 * would throw RangeError inside Intl formatting and turn hostile input into
 * a 500, so the query refuses it as a 400 instead. Null when the runtime
 * cannot enumerate (then only the shape check applies and formatMinor fails
 * closed as ValidationError).
 */
const SUPPORTED_CURRENCIES = (() => {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      return new Set(Intl.supportedValuesOf('currency'));
    }
  } catch {
    // Fall through: no enumeration, formatting still fails closed below.
  }
  return null;
})();

/** @param {string} currency */
export function isSupportedCurrency(currency) {
  if (SUPPORTED_CURRENCIES === null) return CURRENCY_RE.test(currency);
  return SUPPORTED_CURRENCIES.has(currency);
}

/**
 * Strict dashboard query parsing. Everything refused is a 400, never a
 * silent default — except the period, which defaults to the current UTC
 * month because a bare GET must still answer something honest.
 *
 * `pipeline` names the composed pipeline the numbers read (backlog
 * 099c41c32355): the HTTP route resolves it server-side from the registry
 * (`pipelines.forModule('opportunity')`), never from caller input — one
 * pipeline per module, so the resolution is deterministic. Callers that
 * build the query object by hand (tests, the route) set the registered
 * name here; anything else is a 400.
 * @param {unknown} input
 */
export function parseDashboardQuery(input = {}) {
  const source = (input !== null && typeof input === 'object' && !Array.isArray(input))
    ? /** @type {Record<string, unknown>} */ (input)
    : {};
  let pipeline = source.pipeline;
  if (pipeline === undefined || pipeline === null || pipeline === '') {
    pipeline = null;
  } else if (typeof pipeline !== 'string' || !/^[a-z][a-z0-9-]*$/.test(pipeline) || pipeline.length > 200) {
    throw new ValidationError('dashboard query: pipeline must be a composed pipeline name', { field: 'pipeline' });
  }
  let period = source.period;
  if (period === undefined || period === null || period === '') {
    period = new Date().toISOString().slice(0, 7);
  }
  if (typeof period !== 'string' || !PERIOD_RE.test(period)) {
    throw new ValidationError('dashboard query: period must be YYYY-MM', { field: 'period' });
  }
  let owner = source.owner;
  if (owner === undefined || owner === null || owner === '') {
    owner = null;
  } else {
    // Same scalar rule as the compiler's filter values: a short non-empty
    // string that travels as a bound value, never as query text.
    if (typeof owner !== 'string' || owner.length === 0 || owner.length > 200) {
      throw new ValidationError('dashboard query: owner must be a string of 1..200 characters', { field: 'owner' });
    }
  }
  let currency = source.currency;
  if (currency === undefined || currency === null || currency === '') {
    currency = DASHBOARD_DEFAULT_CURRENCY;
  }
  if (typeof currency !== 'string' || !CURRENCY_RE.test(currency) || !isSupportedCurrency(currency)) {
    throw new ValidationError('dashboard query: currency must be a supported ISO 4217 code', { field: 'currency' });
  }
  return Object.freeze({ period, owner, currency, pipeline });
}

/**
 * The exact ISO month of a stored date, or null when the row carries no
 * usable date. Rows without a date still count in totals — they only stay
 * out of the monthly buckets, and the model says how many they are.
 * @param {unknown} value
 * @returns {string | null}
 */
export function monthOf(value) {
  if (typeof value !== 'string' || value.length < 7) return null;
  const month = value.slice(0, 7);
  return PERIOD_RE.test(month) ? month : null;
}

/**
 * The dashboard's report specs: plain data (metric, dimensions, filters) that
 * names DECLARED registry entries only. Specs — never pre-compiled storage
 * descriptors — are what crosses a trust boundary: the executor compiles
 * them itself through {@link compileReport}, so a forged descriptor cannot
 * reach storage (backlog:0e3e67eb review: an unvalidated compiled entry
 * forwarded verbatim would bypass the registry allowlist for every future
 * in-process caller of the facade).
 * @param {{period: string, owner: string | null, currency: string, pipeline?: string | null}} query
 */
export function dashboardSpecs(query) {
  const filters = query.owner === null ? {} : { 'opportunity.owner': query.owner };
  // Backlog 099c41c32355: with a composed pipeline the dashboard reads the
  // same placement the Pipeline board shows — per-pipeline stages, scoped to
  // that pipeline's key — instead of the legacy core `stage` column. Without
  // one the legacy specs below still answer, so spaces with no pipeline keep
  // the numbers they have today.
  if (typeof query.pipeline === 'string' && query.pipeline !== '') {
    const scoped = Object.freeze({ 'opportunity.pipelineKey': query.pipeline, ...filters });
    return Object.freeze({
      byStage: Object.freeze({
        metric: 'pipeline_value_by_pipeline_stage',
        dimensions: Object.freeze(['opportunity.pipelineStage']),
        filters: scoped,
      }),
      schedule: Object.freeze({
        metric: 'pipeline_close_schedule_by_pipeline',
        dimensions: Object.freeze(['opportunity.owner', 'opportunity.pipelineStage', 'opportunity.expectedCloseDate', 'opportunity.closedAt']),
        filters: scoped,
      }),
    });
  }
  return Object.freeze({
    byStage: Object.freeze({
      metric: 'pipeline_value_by_stage',
      dimensions: Object.freeze(['opportunity.stage']),
      filters: Object.freeze({ ...filters }),
    }),
    schedule: Object.freeze({
      metric: 'pipeline_close_schedule',
      dimensions: Object.freeze(['opportunity.owner', 'opportunity.stage', 'opportunity.expectedCloseDate', 'opportunity.closedAt']),
      filters: Object.freeze({ ...filters }),
    }),
  });
}

/**
 * Compile the dashboard's reports through the registry. The persona filter
 * is a declared `owner` filter on both metrics; the period is NOT a storage
 * filter (the registry groups exact dates) — the builder buckets the exact
 * groups into months below, inside the fetched bound.
 * @param {{period: string, owner: string | null, currency: string, pipeline?: string | null}} query
 */
export function dashboardCompilations(query) {
  const specs = dashboardSpecs(query);
  return Object.freeze({
    byStage: compileReport(specs.byStage),
    schedule: compileReport(specs.schedule),
  });
}

/**
 * A count with its Italian noun: only exactly one takes the singular
 * («1 persa», «2 perse»), like admin-labels plural() on the client.
 * @param {number} count @param {string} one @param {string} many
 */
function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** @param {number} minor @param {string} currency */
export function formatMinor(minor, currency) {
  // Explicit support check: Intl.NumberFormat formats unknown 3-letter codes
  // without throwing on lenient runtimes, so an unsupported code must be
  // refused here as a 400 instead of leaking into the model.
  if (typeof currency !== 'string' || !isSupportedCurrency(currency)) {
    throw new ValidationError('dashboard: unsupported currency', { field: 'currency' });
  }
  try {
    // Thousands always grouped («1.080,00 €», never «1080,00 €»): it-IT's
    // default minimum-grouping leaves four-digit amounts bare, which is how
    // the Reporting cards read (backlog:9236684c96a7, review #761).
    return new Intl.NumberFormat('it-IT', { style: 'currency', currency, useGrouping: 'always' }).format(minor / 100);
  } catch {
    // A runtime that cannot format an enumerated code still refuses as a 400.
    throw new ValidationError('dashboard: unsupported currency', { field: 'currency' });
  }
}

/**
 * Short Italian day label for a week start, like the prototype's bar axis
 * (`28 set`, `5 ott`): day number plus abbreviated month, no trailing dot.
 * @param {string} week YYYY-MM-DD Monday
 */
export function channelWeekLabel(week) {
  const date = new Date(`${week}T00:00:00.000Z`);
  return new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(date).replace(/\./g, '');
}

/**
 * The four Monday-start weeks opening a YYYY-MM period: the Monday of the
 * week containing the 1st, plus three. For 2026-10 that is 28 set, 5, 12
 * and 19 ott — the prototype's axis.
 * @param {string} period YYYY-MM
 * @returns {Array<{week: string, label: string}>}
 */
export function channelWeeksOf(period) {
  const first = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 1));
  const monday = new Date(first.getTime() - (((first.getUTCDay() + 6) % 7) * 24 * 60 * 60 * 1000));
  return Array.from({ length: DASHBOARD_CHANNEL_WEEKS }, (_, index) => {
    const start = new Date(monday.getTime() + index * 7 * 24 * 60 * 60 * 1000);
    const week = start.toISOString().slice(0, 10);
    return Object.freeze({ week, label: channelWeekLabel(week) });
  });
}

/**
 * Shape channel origins into the card model: per-channel weekly counts over
 * the period's four weeks, totals over those weeks, and the grand total the
 * subtitle reads as `<n> nel periodo`. Identities without a usable date stay
 * out of the bars — they name no week — and count in `undated` so the view
 * can say so honestly instead of silently dropping them.
 * @param {Array<{system: string, week: string | null, count: number}>} origins
 * @param {{period: string}} query
 */
export function buildChannelBreakdown(origins, query) {
  const weeks = channelWeeksOf(query.period);
  const inWindow = new Set(weeks.map((entry) => entry.week));
  /** @type {Map<string, {channel: string, weeks: number[], total: number}>} */
  const byChannel = new Map();
  let undated = 0;
  for (const entry of origins ?? []) {
    if (entry === null || typeof entry !== 'object') continue;
    const channel = typeof entry.system === 'string' && entry.system !== '' ? entry.system : 'unknown';
    const count = Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 0;
    if (typeof entry.week !== 'string' || !inWindow.has(entry.week)) {
      if (entry.week === null || entry.week === undefined) undated += count;
      continue;
    }
    let shaped = byChannel.get(channel);
    if (!shaped) {
      shaped = { channel, weeks: Array(DASHBOARD_CHANNEL_WEEKS).fill(0), total: 0 };
      byChannel.set(channel, shaped);
    }
    const at = weeks.findIndex((slot) => slot.week === entry.week);
    shaped.weeks[at] += count;
    shaped.total += count;
  }
  const channels = Object.freeze([...byChannel.values()]
    .sort((a, b) => b.total - a.total || (a.channel < b.channel ? -1 : 1))
    .map((entry) => Object.freeze({ ...entry, weeks: Object.freeze([...entry.weeks]) })));
  const total = channels.reduce((sum, entry) => sum + entry.total, 0);
  return Object.freeze({ weeks: Object.freeze(weeks), channels, total, undated });
}

export function formatMonth(period) {
  const match = PERIOD_RE.exec(period);
  if (!match) return period;
  const date = new Date(Date.UTC(Number(match[1]), Number(period.slice(5, 7)) - 1, 1));
  return new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(date);
}

/**
 * Shift a YYYY-MM month by whole months, for the monthly chart window.
 * @param {string} period @param {number} delta negative looks back
 */
export function shiftMonth(period, delta) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7)) - 1 + delta;
  const date = new Date(Date.UTC(year, month, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The operator-set goal for a period: a reporting-bundle row with
 * metric `obiettivo`, the queried period and the shown currency as unit.
 * First match in list order wins; anything else (missing bundle, no row,
 * bad shape) is null, never invented.
 * @param {unknown} rows @param {{period: string, currency: string}} query
 */
export function pickTarget(rows, query) {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (row);
    if (record.metric !== 'obiettivo' || record.period !== query.period || record.unit !== query.currency) continue;
    if (!Number.isInteger(record.value) || /** @type {number} */ (record.value) < 0) continue;
    return Object.freeze({
      valueMinor: /** @type {number} */ (record.value),
      currency: query.currency,
      source: 'bundle reporting',
    });
  }
  return null;
}

/**
 * @param {Array<Record<string, any>>} rows
 * @param {(row: Record<string, any>) => boolean} predicate
 */
function sumRows(rows, predicate) {
  let minor = 0;
  let count = 0;
  for (const row of rows) {
    if (!predicate(row)) continue;
    minor += row.totalMinor;
    count += row.count;
  }
  return { minor, count };
}

/** @param {unknown} value */
function isOpenStage(value) {
  return typeof value === 'string' && /** @type {Array<string>} */ ([...OPEN_STAGES]).includes(value);
}

/**
 * backlog:48993bed7294 (review lead #896): the historical close rate needs
 * at least this many decided offers (won, paid or lost) before it drives
 * the forecast; below it the declared fallback rate is used.
 */
export const FORECAST_MIN_DECIDED = 5;
/** The declared fallback close rate (the board's historical 60%). */
export const FORECAST_FALLBACK_RATE = 0.6;

/**
 * The forecast rule in words, the same sentence the Pipeline prints.
 * @param {number | null} steadyRate the historical rate when it is steady, else null
 * @param {number} decided decided offers behind it
 */
export function forecastMethod(steadyRate, decided) {
  const rate = steadyRate === null
    ? `${Math.round(FORECAST_FALLBACK_RATE * 100)}% (stima: poche offerte chiuse, ${decided} su almeno ${FORECAST_MIN_DECIDED})`
    : `${Math.round(steadyRate * 100)}% (tasso di chiusura storico)`;
  return `Chiuse nel mese, più il ${rate} delle aperte attese nel mese o senza data. Non è una promessa.`;
}

/**
 * Build the frozen dashboard model from executed registry reports.
 *
 * Backlog 099c41c32355 (Reporting like the Pipeline board): when `query`
 * names a pipeline composed in `pipelines` (same shape as `/api/schema`
 * `pipelines`, the board's own source), the funnel, the per-phase value and
 * every open/won/lost sum read the per-pipeline placement — same phases,
 * same open count, same total as the board. A move-stage touches only the
 * placement, so grouping by the legacy core `stage` column would pile every
 * offer under one label while the board moves on. Without a pipeline the
 * legacy grouping below still answers, byte for byte as before.
 * @param {{byStage: any, schedule: any}} results runReport results
 * @param {unknown} bundleRows reporting-bundle rows for the obiettivo lookup
 * @param {{period: string, owner: string | null, currency: string, pipeline?: string | null}} query
 * @param {string} [nowIso] generation stamp (injectable for tests)
 * @param {Array<{system: string, week: string | null, count: number}>} [channelOrigins] channel aggregates (slice 2)
 * @param {Array<{name?: unknown, stages?: unknown}>} [pipelines] composed pipeline definitions (`/api/schema` shape)
 */
export function buildDashboardModel(results, bundleRows, query, nowIso, channelOrigins = [], pipelines = []) {
  const pipeline = typeof query.pipeline === 'string' && query.pipeline !== ''
    ? (Array.isArray(pipelines) ? pipelines : []).find((entry) =>
      entry !== null && typeof entry === 'object' && entry.name === query.pipeline && Array.isArray(entry.stages),
    ) ?? null
    : null;
  // Pipeline stages in board order; off-definition rows (drift the board
  // shows aside, never in a column or a total) stay out of every sum here
  // too, so the totals match the board instead of exceeding it.
  const ordered = pipeline
    ? [...pipeline.stages]
      .filter((stage) => stage !== null && typeof stage === 'object' && typeof stage.key === 'string')
      .sort((a, b) => a.order - b.order)
    : null;
  const typeOf = ordered ? new Map(ordered.map((stage) => [stage.key, stage.type])) : null;
  /** Same open rule as the board's working columns: open and renewal hold value. */
  const isOpenValue = (/** @type {unknown} */ value) => pipeline
    ? typeOf.get(value) === 'open' || typeOf.get(value) === 'renewal'
    : isOpenStage(value);
  /** Same close rule as the board: won and paid close at face value. */
  const isWonValue = (/** @type {unknown} */ value) => pipeline
    ? typeOf.get(value) === 'won' || typeOf.get(value) === 'paid'
    : value === WON_STAGE;
  const isLostValue = (/** @type {unknown} */ value) => pipeline
    ? typeOf.get(value) === 'lost'
    : value === LOST_STAGE;
  const nameOf = (/** @type {unknown} */ value) => {
    if (!pipeline) return stageLabel(value);
    const stage = ordered.find((entry) => entry?.key === value);
    const label = stage && typeof stage.label === 'string' && stage.label.trim() !== '' ? stage.label : null;
    return label ?? value;
  };
  const onBoard = (/** @type {Record<string, any>} */ row) => {
    if (!pipeline) return row;
    const stage = row['opportunity.pipelineStage'];
    if (typeof stage !== 'string' || !typeOf.has(stage)) return null;
    return { ...row, 'opportunity.stage': stage };
  };
  const byStageRows = (Array.isArray(results?.byStage?.rows) ? results.byStage.rows : [])
    .map(onBoard).filter((row) => row !== null);
  const scheduleRows = (Array.isArray(results?.schedule?.rows) ? results.schedule.rows : [])
    .map(onBoard).filter((row) => row !== null);
  const inCurrency = (/** @type {Record<string, any>} */ row) => row['opportunity.currency'] === query.currency;
  const stageRows = byStageRows.filter(inCurrency);
  const dated = scheduleRows.filter(inCurrency);
  const otherCurrencies = [...new Set(
    [...byStageRows, ...scheduleRows]
      .map((row) => row['opportunity.currency'])
      .filter((code) => typeof code === 'string' && code !== query.currency),
  )].sort();

  const open = sumRows(stageRows, (row) => isOpenValue(row['opportunity.stage']));
  const won = sumRows(stageRows, (row) => isWonValue(row['opportunity.stage']));
  const lost = sumRows(stageRows, (row) => isLostValue(row['opportunity.stage']));
  const closed = won.count + lost.count;
  const winRate = closed === 0 ? null : won.count / closed;

  const inPeriod = (/** @type {Record<string, any>} */ row) =>
    monthOf(row['opportunity.expectedCloseDate']) === query.period;
  // backlog:48993bed7294 (verifica 13/11: «Vinte in novembre 0,00 €» with
  // an offer paid on 7 nov, while the Pipeline counted it): a closed sale
  // belongs to the month it closed (`closedAt`), the expected date only
  // when the close date is missing. One rule with the Pipeline forecast.
  const closeMonthOf = (/** @type {Record<string, any>} */ row) =>
    monthOf(row['opportunity.closedAt']) ?? monthOf(row['opportunity.expectedCloseDate']);
  const closedInPeriod = (/** @type {Record<string, any>} */ row) => closeMonthOf(row) === query.period;
  const isOpen = (/** @type {Record<string, any>} */ row) => isOpenValue(row['opportunity.stage']);
  const openInPeriod = sumRows(dated, (row) => isOpen(row) && inPeriod(row));
  const wonInPeriod = sumRows(dated, (row) => isWonValue(row['opportunity.stage']) && closedInPeriod(row));
  // The open value the month may still close: expected in the month, or
  // with no expected date at all (it can close any day). Past-dated rows
  // are stale, never «in attesa». Same window as the Pipeline forecast.
  const waitingInPeriod = sumRows(dated, (row) => {
    if (!isOpen(row)) return false;
    const month = monthOf(row['opportunity.expectedCloseDate']);
    return month === null || month === query.period;
  });
  // Review Muse #896: undated open rows are inside the forecast window
  // (they can close any day); only a date already past keeps an open offer
  // out of it, so only those are the forecast's stale rows.
  const staleOpen = sumRows(dated, (row) => {
    if (!isOpen(row)) return false;
    const month = monthOf(row['opportunity.expectedCloseDate']);
    return month !== null && month < query.period;
  });
  const undatedOpen = sumRows(dated, (row) => isOpen(row) && monthOf(row['opportunity.expectedCloseDate']) === null);

  const periodLabel = formatMonth(query.period);
  const kpis = Object.freeze([
    Object.freeze({
      id: 'open-value', label: 'Valore pipeline aperto',
      display: formatMinor(open.minor, query.currency),
      sub: plural(open.count, 'preventivo aperto', 'preventivi aperti'),
    }),
    Object.freeze({
      id: 'open-count', label: 'Preventivi aperti',
      display: String(open.count),
      sub: formatMinor(open.minor, query.currency),
    }),
    Object.freeze({
      id: 'won-period', label: `Vinte in ${periodLabel}`,
      display: formatMinor(wonInPeriod.minor, query.currency),
      sub: plural(wonInPeriod.count, 'chiusura', 'chiusure'),
    }),
    Object.freeze({
      id: 'win-rate', label: 'Tasso di chiusura',
      display: winRate === null ? 'n.d.' : `${Math.round(winRate * 100)}%`,
      sub: `${plural(won.count, 'vinta', 'vinte')}, ${plural(lost.count, 'persa', 'perse')}`,
    }),
    Object.freeze({
      id: 'closing-period', label: `In chiusura in ${periodLabel}`,
      display: formatMinor(openInPeriod.minor, query.currency),
      sub: undatedOpen.count > 0
        ? `${plural(openInPeriod.count, 'preventivo', 'preventivi')}, ${undatedOpen.count} senza data attesa`
        : plural(openInPeriod.count, 'preventivo', 'preventivi'),
    }),
  ]);

  // Same phases as the board: working stages in board order, then the
  // closing stages — never the fixed legacy list when a pipeline is set.
  const openKeys = pipeline
    ? ordered.filter((stage) => stage.type === 'open' || stage.type === 'renewal').map((stage) => stage.key)
    : [...OPEN_STAGES];
  const wonKeys = pipeline
    ? ordered.filter((stage) => stage.type === 'won' || stage.type === 'paid').map((stage) => stage.key)
    : [WON_STAGE];
  const funnel = Object.freeze([...openKeys, ...wonKeys].map((stage) => {
    const found = sumRows(stageRows, (row) => row['opportunity.stage'] === stage);
    return Object.freeze({ stage, label: nameOf(stage), count: found.count, minor: found.minor });
  }));

  const valueByStage = Object.freeze([...openKeys].map((stage) => {
    const found = sumRows(stageRows, (row) => row['opportunity.stage'] === stage);
    return Object.freeze({ stage, label: nameOf(stage), count: found.count, minor: found.minor });
  }));

  // «Chiusure attese per mese» (backlog:b3d88f6e38ef): expected closings run
  // from the selected period onward — a past month is never "atteso", it is
  // either won or stale (stale stays visible in the KPIs and insights).
  const monthly = Object.freeze(
    Array.from({ length: DASHBOARD_MONTHS }, (_, index) => shiftMonth(query.period, index))
      .map((month) => {
        const expected = sumRows(dated, (row) => isOpen(row) && monthOf(row['opportunity.expectedCloseDate']) === month);
        const closedRows = sumRows(dated, (row) => isWonValue(row['opportunity.stage']) && closeMonthOf(row) === month);
        return Object.freeze({
          month, label: formatMonth(month),
          openCount: expected.count, expectedMinor: expected.minor,
          wonCount: closedRows.count, wonMinor: closedRows.minor,
        });
      }),
  );

  // backlog:48993bed7294 (verifica 13/11: «0 · 0,00 €» for everyone while
  // the Pipeline showed a referente with three open offers): the open value
  // follows the referente like the board — every open offer they hold —
  // and won and lost count in the month they closed. Offers without a
  // referente gather in one row (`owner: ''`, «senza referente»), never
  // dropped. Stale stays the redistribution backlog (past or undated open
  // rows), visible from every period.
  const byOwner = new Map();
  for (const row of dated) {
    const owner = typeof row['opportunity.owner'] === 'string' ? row['opportunity.owner'].trim() : '';
    let entry = byOwner.get(owner);
    if (!entry) {
      entry = { owner, openCount: 0, openMinor: 0, wonCount: 0, wonMinor: 0, lostCount: 0, staleCount: 0 };
      byOwner.set(owner, entry);
    }
    const expected = monthOf(row['opportunity.expectedCloseDate']);
    if (isOpen(row)) {
      entry.openCount += row.count;
      entry.openMinor += row.totalMinor;
      // Stale for redistribution: no expected date, or one already past.
      // Rows expected in a FUTURE period are somebody's plan, not neglect.
      if (expected === null || expected < query.period) {
        entry.staleCount += row.count;
      }
    } else if (isWonValue(row['opportunity.stage'])) {
      if (closedInPeriod(row)) {
        entry.wonCount += row.count;
        entry.wonMinor += row.totalMinor;
      }
    } else if (isLostValue(row['opportunity.stage'])) {
      if (closedInPeriod(row)) {
        entry.lostCount += row.count;
      }
    }
  }
  const team = Object.freeze([...byOwner.values()]
    .map((entry) => {
      const decided = entry.wonCount + entry.lostCount;
      const rate = decided === 0 ? null : entry.wonCount / decided;
      return Object.freeze({
        ...entry,
        winRate: rate,
        winRateDisplay: rate === null ? 'n.d.' : `${Math.round(rate * 100)}%`,
      });
    })
    // The «senza referente» row closes the table.
    .sort((a, b) => Number(a.owner === '') - Number(b.owner === '') || b.openMinor - a.openMinor || (a.owner < b.owner ? -1 : 1)));
  // The persona pills filter by referente: the «senza referente» row is no
  // person to filter by.
  const owners = Object.freeze(team.map((entry) => entry.owner).filter((owner) => owner !== ''));

  // Forecast: closed in the period plus a heuristic band over the open rows
  // expected in the period. `heuristic: true` is the contract the screen
  // must render — the number is arithmetic over history, never a promise.
  // Review lead #896: with fewer than FORECAST_MIN_DECIDED decided offers a
  // historical rate is noise (one sale reads 100%): the forecast uses the
  // declared fallback rate and says so.
  const steadyRate = winRate !== null && closed >= FORECAST_MIN_DECIDED;
  const forecastRate = steadyRate ? winRate : FORECAST_FALLBACK_RATE;
  const probableMinor = Math.round(waitingInPeriod.minor * forecastRate);
  const target = pickTarget(bundleRows, query);
  const forecast = Object.freeze({
    currency: query.currency,
    closedMinor: wonInPeriod.minor,
    probableMinor,
    bestMinor: waitingInPeriod.minor,
    winRate: forecastRate,
    rateSource: steadyRate ? 'history' : 'fallback',
    targetMinor: target === null ? null : target.valueMinor,
    heuristic: true,
    label: 'Stima',
    method: forecastMethod(steadyRate ? winRate : null, closed),
    note: target === null
      ? 'Obiettivo non impostato: aggiungi una riga obiettivo nel report.'
      : `Obiettivo ${formatMinor(target.valueMinor, query.currency)}.`,
  });

  const insights = [];
  let proposal = null;
  if (stageRows.length === 0) {
    insights.push({ id: 'no-data', text: 'Ancora nessun preventivo in questa vista: i grafici si riempiono da soli.' });
  } else {
    // The redistribution compares win rates inside ONE window: the team's
    // rates are accumulated for the queried month, so the baseline they are
    // measured against is the month's own close rate — never a lifetime rate
    // that would flag an owner who merely matches the period.
    const lostInPeriod = sumRows(dated, (row) => isLostValue(row['opportunity.stage']) && closedInPeriod(row));
    const periodDecided = wonInPeriod.count + lostInPeriod.count;
    const periodOverall = periodDecided === 0 ? null : wonInPeriod.count / periodDecided;
    // Review Muse #896: the «senza referente» row is nobody — never a
    // redistribution source or target.
    const people = team.filter((entry) => entry.owner !== '');
    const candidate = [...people]
      .filter((entry) => entry.openCount >= 2 && entry.winRate !== null && periodOverall !== null && entry.winRate < periodOverall && entry.staleCount > 0)
      .sort((a, b) => /** @type {number} */ (a.winRate) - /** @type {number} */ (b.winRate))[0];
    const recipient = [...people]
      .filter((entry) => entry.wonCount > 0 && (!candidate || entry.owner !== candidate.owner))
      .sort((a, b) => /** @type {number} */ (b.winRate ?? -1) - /** @type {number} */ (a.winRate ?? -1))[0];
    if (candidate && recipient) {
      proposal = Object.freeze({
        title: 'Proposta di ridistribuzione lead',
        moves: Object.freeze([Object.freeze({
          from: candidate.owner,
          to: recipient.owner,
          count: candidate.staleCount,
          reason: `${candidate.staleCount} preventivi aperti senza data di chiusura attesa, tasso ${candidate.winRateDisplay} contro ${recipient.winRateDisplay}`,
        })]),
        note: 'La proposta non sposta nulla da sola: la riassegnazione resta dell\u2019operatore.',
      });
      insights.push({
        id: 'redistribute',
        text: `${candidate.owner} tiene ${formatMinor(candidate.openMinor, query.currency)} aperti con il tasso più basso (${candidate.winRateDisplay}): propone di spostare i lead senza data a ${recipient.owner}.`,
      });
    }
    if (lost.count > 0 && closed > 0 && lost.count / closed >= 0.3) {
      insights.push({
        id: 'lost-rate',
        // backlog:48993bed7294: «1 preventivo perso», never «1 preventivi persi».
        text: `${plural(lost.count, 'preventivo perso', 'preventivi persi')} su ${plural(closed, 'chiuso', 'chiusi')} (${Math.round((lost.count / closed) * 100)}%): rileggi i motivi prima di spingere le trattative.`,
      });
    }
    if (staleOpen.count > 0) {
      insights.push({
        id: 'stale',
        text: `${plural(staleOpen.count, 'preventivo aperto', 'preventivi aperti')} con la data di chiusura attesa già passata: aggiornala, così la previsione li conta di nuovo.`,
      });
    }
    if (insights.length === 0) {
      insights.push({ id: 'steady', text: 'Distribuzione regolare: nessun segnale sopra le soglie in questo periodo.' });
    }
  }

  const channels = buildChannelBreakdown(channelOrigins, query);
  const csv = buildDashboardCsv({ kpis, funnel, team, forecast, query });

  return Object.freeze({
    period: query.period,
    periodLabel,
    owner: query.owner,
    currency: query.currency,
    channels,
    currencies: Object.freeze({ shown: query.currency, others: Object.freeze(otherCurrencies) }),
    generatedAt: nowIso ?? new Date().toISOString(),
    metrics: Object.freeze({
      modelVersion: PIPELINE_SEMANTIC_MODEL.version,
      byStage: byStageMetricVersion(results?.byStage),
      schedule: byStageMetricVersion(results?.schedule),
    }),
    truncated: Boolean(results?.byStage?.truncated) || Boolean(results?.schedule?.truncated),
    kpis,
    funnel,
    valueByStage,
    monthly,
    team,
    owners,
    forecast,
    insights: Object.freeze(insights.map((entry) => Object.freeze(entry))),
    proposal,
    csv,
  });
}

/** @param {any} result */
function byStageMetricVersion(result) {
  return Object.freeze({
    metric: typeof result?.metric === 'string' ? result.metric : 'unknown',
    metricVersion: Number.isInteger(result?.metricVersion) ? result.metricVersion : 0,
    truncated: Boolean(result?.truncated),
  });
}

/**
 * CSV of the dashboard: team table then funnel. Pure, so the screen test
 * pins the exact bytes the operator downloads.
 * @param {{kpis: any, funnel: any, team: any, forecast: any, query: {period: string, owner: string | null, currency: string}}} model
 */
export function buildDashboardCsv(model) {
  const sep = DASHBOARD_CSV_SEPARATOR;
  const cell = (/** @type {unknown} */ value) => {
    // Spreadsheet import strips CSV quotes BEFORE interpreting the cell, so
    // quoting alone still exports an executable formula: `=2+2` quoted is
    // the formula `=2+2` again once opened. Formula-leading text is first
    // neutralized with the spreadsheet text marker (`'`), which renders as
    // literal text in Excel/LibreOffice, and only then CSV-escaped.
    let text = String(value ?? '');
    let neutralized = false;
    if (/^[=+\-@\t\r]/.test(text)) {
      text = `'${text}`;
      neutralized = true;
    }
    const needsQuotes = neutralized || /["\n\r;]/.test(text);
    return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    ['reporting', model.query.period, model.query.owner ?? 'tutti', model.query.currency].map(cell).join(sep),
    '',
    ['persona', 'preventivi_aperti', 'valore_aperto_minor', 'vinte', 'vinte_minor', 'perse', 'tasso'].map(cell).join(sep),
  ];
  for (const row of model.team) {
    lines.push([
      row.owner, row.openCount, row.openMinor, row.wonCount, row.wonMinor, row.lostCount,
      row.winRate === null ? 'n.d.' : `${Math.round(row.winRate * 100)}%`,
    ].map(cell).join(sep));
  }
  lines.push(
    '',
    ['fase', 'preventivi', 'valore_minor'].map(cell).join(sep),
  );
  for (const row of model.funnel) {
    lines.push([row.stage, row.count, row.minor].map(cell).join(sep));
  }
  lines.push(
    '',
    ['previsione', 'minor'].map(cell).join(sep),
    ['chiuse', model.forecast.closedMinor].map(cell).join(sep),
    ['probabili_euristica', model.forecast.probableMinor].map(cell).join(sep),
    ['se_chiudi_tutto', model.forecast.bestMinor].map(cell).join(sep),
    ['obiettivo', model.forecast.targetMinor ?? 'non_impostato'].map(cell).join(sep),
  );
  const ownerPart = model.query.owner === null ? '' : `-${model.query.owner}`;
  return Object.freeze({
    filename: `reporting-${model.query.period}${ownerPart}.csv`,
    content: `${lines.join('\n')}\n`,
  });
}
