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
/** Monthly chart depth: the selected period plus the five before it. */
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
 * @param {unknown} input
 */
export function parseDashboardQuery(input = {}) {
  const source = (input !== null && typeof input === 'object' && !Array.isArray(input))
    ? /** @type {Record<string, unknown>} */ (input)
    : {};
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
  return Object.freeze({ period, owner, currency });
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
 * @param {{period: string, owner: string | null, currency: string}} query
 */
export function dashboardSpecs(query) {
  const filters = query.owner === null ? {} : { 'opportunity.owner': query.owner };
  return Object.freeze({
    byStage: Object.freeze({
      metric: 'pipeline_value_by_stage',
      dimensions: Object.freeze(['opportunity.stage']),
      filters: Object.freeze({ ...filters }),
    }),
    schedule: Object.freeze({
      metric: 'pipeline_close_schedule',
      dimensions: Object.freeze(['opportunity.owner', 'opportunity.stage', 'opportunity.expectedCloseDate']),
      filters: Object.freeze({ ...filters }),
    }),
  });
}

/**
 * Compile the dashboard's reports through the registry. The persona filter
 * is a declared `owner` filter on both metrics; the period is NOT a storage
 * filter (the registry groups exact dates) — the builder buckets the exact
 * groups into months below, inside the fetched bound.
 * @param {{period: string, owner: string | null, currency: string}} query
 */
export function dashboardCompilations(query) {
  const specs = dashboardSpecs(query);
  return Object.freeze({
    byStage: compileReport(specs.byStage),
    schedule: compileReport(specs.schedule),
  });
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
    return new Intl.NumberFormat('it-IT', { style: 'currency', currency }).format(minor / 100);
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
 * Build the frozen dashboard model from executed registry reports.
 * @param {{byStage: any, schedule: any}} results runReport results
 * @param {unknown} bundleRows reporting-bundle rows for the obiettivo lookup
 * @param {{period: string, owner: string | null, currency: string}} query
 * @param {string} [nowIso] generation stamp (injectable for tests)
 * @param {Array<{system: string, week: string | null, count: number}>} [channelOrigins] channel aggregates (slice 2)
 */
export function buildDashboardModel(results, bundleRows, query, nowIso, channelOrigins = []) {
  const byStageRows = Array.isArray(results?.byStage?.rows) ? [...results.byStage.rows] : [];
  const scheduleRows = Array.isArray(results?.schedule?.rows) ? [...results.schedule.rows] : [];
  const inCurrency = (/** @type {Record<string, any>} */ row) => row['opportunity.currency'] === query.currency;
  const stageRows = byStageRows.filter(inCurrency);
  const dated = scheduleRows.filter(inCurrency);
  const otherCurrencies = [...new Set(
    [...byStageRows, ...scheduleRows]
      .map((row) => row['opportunity.currency'])
      .filter((code) => typeof code === 'string' && code !== query.currency),
  )].sort();

  const open = sumRows(stageRows, (row) => isOpenStage(row['opportunity.stage']));
  const won = sumRows(stageRows, (row) => row['opportunity.stage'] === WON_STAGE);
  const lost = sumRows(stageRows, (row) => row['opportunity.stage'] === LOST_STAGE);
  const closed = won.count + lost.count;
  const winRate = closed === 0 ? null : won.count / closed;

  const inPeriod = (/** @type {Record<string, any>} */ row) =>
    monthOf(row['opportunity.expectedCloseDate']) === query.period;
  const isOpen = (/** @type {Record<string, any>} */ row) => isOpenStage(row['opportunity.stage']);
  const openInPeriod = sumRows(dated, (row) => isOpen(row) && inPeriod(row));
  const wonInPeriod = sumRows(dated, (row) => row['opportunity.stage'] === WON_STAGE && inPeriod(row));
  const staleOpen = sumRows(dated, (row) => {
    if (!isOpen(row)) return false;
    const month = monthOf(row['opportunity.expectedCloseDate']);
    return month === null || month < query.period;
  });
  const undatedOpen = sumRows(dated, (row) => isOpen(row) && monthOf(row['opportunity.expectedCloseDate']) === null);

  const periodLabel = formatMonth(query.period);
  const kpis = Object.freeze([
    Object.freeze({
      id: 'open-value', label: 'Valore pipeline aperto',
      display: formatMinor(open.minor, query.currency),
      sub: `${open.count} preventivi aperti`,
    }),
    Object.freeze({
      id: 'open-count', label: 'Preventivi aperti',
      display: String(open.count),
      sub: formatMinor(open.minor, query.currency),
    }),
    Object.freeze({
      id: 'won-period', label: `Vinte in ${periodLabel}`,
      display: formatMinor(wonInPeriod.minor, query.currency),
      sub: `${wonInPeriod.count} chiusure`,
    }),
    Object.freeze({
      id: 'win-rate', label: 'Tasso di chiusura',
      display: winRate === null ? 'n.d.' : `${Math.round(winRate * 100)}%`,
      sub: `${won.count} vinte, ${lost.count} perse`,
    }),
    Object.freeze({
      id: 'closing-period', label: `In chiusura in ${periodLabel}`,
      display: formatMinor(openInPeriod.minor, query.currency),
      sub: undatedOpen.count > 0
        ? `${openInPeriod.count} preventivi, ${undatedOpen.count} senza data attesa`
        : `${openInPeriod.count} preventivi`,
    }),
  ]);

  const funnel = Object.freeze([...FUNNEL_STAGES].map((stage) => {
    const found = sumRows(stageRows, (row) => row['opportunity.stage'] === stage);
    return Object.freeze({ stage, label: stageLabel(stage), count: found.count, minor: found.minor });
  }));

  const valueByStage = Object.freeze([...OPEN_STAGES].map((stage) => {
    const found = sumRows(stageRows, (row) => row['opportunity.stage'] === stage);
    return Object.freeze({ stage, label: stageLabel(stage), count: found.count, minor: found.minor });
  }));

  const monthly = Object.freeze(
    Array.from({ length: DASHBOARD_MONTHS }, (_, index) => shiftMonth(query.period, index - DASHBOARD_MONTHS + 1))
      .map((month) => {
        const expected = sumRows(dated, (row) => isOpen(row) && monthOf(row['opportunity.expectedCloseDate']) === month);
        const closedRows = sumRows(dated, (row) => row['opportunity.stage'] === WON_STAGE && monthOf(row['opportunity.expectedCloseDate']) === month);
        return Object.freeze({
          month, label: formatMonth(month),
          openCount: expected.count, expectedMinor: expected.minor,
          wonCount: closedRows.count, wonMinor: closedRows.minor,
        });
      }),
  );

  // The table is titled with the queried month (`Team e vendite · <mese>`),
  // so open/won/lost accumulate only rows expected IN that month: the
  // periodo pill recalculates the table instead of showing lifetime totals
  // under a period title. Stale stays lifetime (past or undated open rows):
  // it is the redistribution backlog, visible from every period, and entries
  // exist for every owner in the filtered rows so that backlog never hides
  // its holder.
  const byOwner = new Map();
  for (const row of dated) {
    const owner = typeof row['opportunity.owner'] === 'string' ? row['opportunity.owner'] : '';
    if (owner === '') continue;
    let entry = byOwner.get(owner);
    if (!entry) {
      entry = { owner, openCount: 0, openMinor: 0, wonCount: 0, wonMinor: 0, lostCount: 0, staleCount: 0 };
      byOwner.set(owner, entry);
    }
    const expected = monthOf(row['opportunity.expectedCloseDate']);
    const expectedInPeriod = expected === query.period;
    if (isOpen(row)) {
      if (expectedInPeriod) {
        entry.openCount += row.count;
        entry.openMinor += row.totalMinor;
      }
      // Stale for redistribution: no expected date, or one already past.
      // Rows expected in a FUTURE period are somebody's plan, not neglect.
      if (expected === null || expected < query.period) {
        entry.staleCount += row.count;
      }
    } else if (row['opportunity.stage'] === WON_STAGE) {
      if (expectedInPeriod) {
        entry.wonCount += row.count;
        entry.wonMinor += row.totalMinor;
      }
    } else if (row['opportunity.stage'] === LOST_STAGE) {
      if (expectedInPeriod) {
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
    .sort((a, b) => b.openMinor - a.openMinor || (a.owner < b.owner ? -1 : 1)));
  const owners = Object.freeze(team.map((entry) => entry.owner));

  // Forecast: closed in the period plus a heuristic band over the open rows
  // expected in the period. `heuristic: true` is the contract the screen
  // must render — the number is arithmetic over history, never a promise.
  const probableMinor = winRate === null ? 0 : Math.round(openInPeriod.minor * winRate);
  const target = pickTarget(bundleRows, query);
  const forecast = Object.freeze({
    currency: query.currency,
    closedMinor: wonInPeriod.minor,
    probableMinor,
    bestMinor: openInPeriod.minor,
    targetMinor: target === null ? null : target.valueMinor,
    heuristic: true,
    label: 'Stima',
    method: 'Le probabili usano il tasso di chiusura storico (vinte su vinte + perse); non è una promessa.',
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
    const lostInPeriod = sumRows(dated, (row) => row['opportunity.stage'] === LOST_STAGE && inPeriod(row));
    const periodDecided = wonInPeriod.count + lostInPeriod.count;
    const periodOverall = periodDecided === 0 ? null : wonInPeriod.count / periodDecided;
    const candidate = [...team]
      .filter((entry) => entry.openCount >= 2 && entry.winRate !== null && periodOverall !== null && entry.winRate < periodOverall && entry.staleCount > 0)
      .sort((a, b) => /** @type {number} */ (a.winRate) - /** @type {number} */ (b.winRate))[0];
    const recipient = [...team]
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
        text: `${lost.count} preventivi persi su ${closed} chiusi (${Math.round((lost.count / closed) * 100)}%): rileggi i motivi prima di spingere le trattative.`,
      });
    }
    if (staleOpen.count > 0) {
      insights.push({
        id: 'stale',
        text: `${staleOpen.count} preventivi aperti senza data di chiusura attesa nel periodo: assegna una data o escono dalle previsioni.`,
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
