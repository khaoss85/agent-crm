// @ts-check

import { ValidationError } from '../../core/src/errors.js';
import { formatMinor, formatMonth, OPEN_STAGES, stageLabel } from './dashboard.js';

/**
 * Weekly report artifact (backlog:19bf5b6e8d73) — «Report settimanale».
 *
 * The Monday agent run takes the Reporting dashboard model
 * (`buildDashboardModel`) plus an appointment summary and publishes one new
 * immutable version of the artifact: sales, pipeline, channels and
 * appointments numbers with 2–3 deterministic observations and a recommended
 * action each. Rollback, like every policy in this repository, is a new
 * version — history is never rewritten
 * (`docs/strategy/ANALYTICS_STUDIO.md` §3).
 *
 * This module is pure: no storage, no clock, no network. `nowIso` is passed
 * in so the weekly run is pinned and tests stay deterministic. Numbers are
 * read only from the dashboard model's structured fields (valueByStage,
 * team, channels, forecast) — display strings are never parsed.
 *
 * What this file deliberately does NOT do (left to follow-ups):
 * - run on a schedule or store versions: the Monday scheduling and the
 *   version persistence live with the agent runner, not here;
 * - open from Reporting or «Da fare»: those are pilot surfaces reading the
 *   published versions.
 */

export const WEEKLY_REPORT_ARTIFACT = 'weekly-report';
export const WEEKLY_REPORT_SCHEMA = 1;

/**
 * Monday (UTC) starting the week that contains `nowIso`, as `YYYY-MM-DD`.
 * @param {string} nowIso
 */
export function weekKeyOf(nowIso) {
  const at = new Date(nowIso);
  if (typeof nowIso !== 'string' || Number.isNaN(at.getTime())) {
    throw new ValidationError('weekly report: nowIso is not a valid date.', { field: 'nowIso' });
  }
  const monday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/**
 * @param {string} weekKey Monday date `YYYY-MM-DD`
 */
export function weekLabelOf(weekKey) {
  const date = new Date(`${weekKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('weekly report: weekKey is not a valid date.', { field: 'weekKey' });
  }
  const label = new Intl.DateTimeFormat('it-IT', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(date);
  return `settimana del ${label}`;
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function requireDashboardList(value, name) {
  if (!Array.isArray(value)) {
    throw new ValidationError(`weekly report: dashboard.${name} must be a list.`, { field: name });
  }
  return value;
}

/**
 * @param {unknown} appointments
 */
function requireAppointments(appointments) {
  if (appointments === null || typeof appointments !== 'object') {
    throw new ValidationError(
      'weekly report: appointments is required (pass { upcoming, done, noShow, cancelled } with zeros when there are none).',
      { field: 'appointments' },
    );
  }
  const record = /** @type {Record<string, unknown>} */ (appointments);
  const shaped = {};
  for (const field of ['upcoming', 'done', 'noShow', 'cancelled']) {
    const count = record[field];
    if (!Number.isInteger(count) || count < 0) {
      throw new ValidationError(
        `weekly report: appointments.${field} must be a non-negative integer.`,
        { field: `appointments.${field}` },
      );
    }
    shaped[field] = count;
  }
  return Object.freeze(shaped);
}

/**
 * @param {unknown} previous
 */
function requirePreviousVersion(previous) {
  if (previous === null || previous === undefined) return 1;
  if (typeof previous !== 'object' || !Number.isInteger(previous.version) || previous.version < 1) {
    throw new ValidationError('weekly report: previous.version must be a positive integer.', { field: 'previous' });
  }
  return previous.version + 1;
}

/**
 * @param {{
 *   dashboard: any,
 *   appointments: unknown,
 *   previous?: unknown,
 *   nowIso?: string,
 * }} input
 */
export function buildWeeklyReport({ dashboard, appointments, previous = null, nowIso = null }) {
  if (dashboard === null || typeof dashboard !== 'object') {
    throw new ValidationError('weekly report: dashboard must be a Reporting model.', { field: 'dashboard' });
  }
  if (typeof dashboard.period !== 'string' || dashboard.period === '') {
    throw new ValidationError('weekly report: dashboard.period must be a non-empty string.', { field: 'period' });
  }
  if (typeof dashboard.currency !== 'string' || dashboard.currency === '') {
    throw new ValidationError('weekly report: dashboard.currency must be a non-empty string.', { field: 'currency' });
  }
  const valueByStage = requireDashboardList(dashboard.valueByStage, 'valueByStage');
  const team = requireDashboardList(dashboard.team, 'team');
  const summary = requireAppointments(appointments);
  const version = requirePreviousVersion(previous);

  const at = nowIso ?? new Date().toISOString();
  if (typeof at !== 'string' || Number.isNaN(new Date(at).getTime())) {
    throw new ValidationError('weekly report: nowIso must be a valid date string.', { field: 'nowIso' });
  }
  const weekKey = weekKeyOf(at);

  const openMinor = valueByStage.reduce(
    (sum, entry) => sum + (Number.isInteger(entry?.minor) && entry.minor > 0 ? entry.minor : 0), 0,
  );
  const openCount = valueByStage.reduce(
    (sum, entry) => sum + (Number.isInteger(entry?.count) && entry.count > 0 ? entry.count : 0), 0,
  );
  const wonCount = team.reduce((sum, entry) => sum + (Number.isInteger(entry?.wonCount) ? entry.wonCount : 0), 0);
  const wonMinor = team.reduce((sum, entry) => sum + (Number.isInteger(entry?.wonMinor) ? entry.wonMinor : 0), 0);
  const lostCount = team.reduce((sum, entry) => sum + (Number.isInteger(entry?.lostCount) ? entry.lostCount : 0), 0);
  const decided = wonCount + lostCount;
  const winRate = decided === 0 ? null : wonCount / decided;

  const channels = dashboard.channels !== null && typeof dashboard.channels === 'object' ? dashboard.channels : null;
  const channelTotal = Number.isInteger(channels?.total) && channels.total > 0 ? channels.total : 0;
  const topChannels = Object.freeze(
    (Array.isArray(channels?.channels) ? channels.channels : [])
      .filter((entry) => entry !== null && typeof entry === 'object')
      .slice(0, 3)
      .map((entry) => Object.freeze({
        channel: typeof entry.channel === 'string' && entry.channel !== '' ? entry.channel : 'unknown',
        total: Number.isInteger(entry.total) && entry.total > 0 ? entry.total : 0,
      })),
  );

  const numbers = Object.freeze({
    period: dashboard.period,
    periodLabel: typeof dashboard.periodLabel === 'string' ? dashboard.periodLabel : formatMonth(dashboard.period),
    currency: dashboard.currency,
    sales: Object.freeze({ count: wonCount, minor: wonMinor }),
    lost: Object.freeze({ count: lostCount }),
    pipeline: Object.freeze({ count: openCount, minor: openMinor }),
    winRate,
    winRateDisplay: winRate === null ? 'n.d.' : `${Math.round(winRate * 100)}%`,
    forecastBestMinor: Number.isInteger(dashboard.forecast?.bestMinor) ? dashboard.forecast.bestMinor : null,
    heuristicForecast: true,
    channels: Object.freeze({
      total: channelTotal,
      undated: Number.isInteger(channels?.undated) && channels.undated > 0 ? channels.undated : 0,
      top: topChannels,
    }),
    appointments: summary,
    truncated: dashboard.truncated === true,
  });

  const observations = Object.freeze(pickObservations({ numbers, valueByStage, currency: dashboard.currency }));

  return Object.freeze({
    artifact: WEEKLY_REPORT_ARTIFACT,
    schemaVersion: WEEKLY_REPORT_SCHEMA,
    version,
    weekKey,
    weekLabel: weekLabelOf(weekKey),
    numbers,
    summary: `Nel periodo ${numbers.periodLabel}: ${wonCount} chiusure per ${formatMinor(wonMinor, dashboard.currency)}, pipeline aperto ${formatMinor(openMinor, dashboard.currency)} su ${openCount} preventivi.`,
    observations,
    updatedAt: at,
    previousVersion: version > 1 ? version - 1 : null,
  });
}

/**
 * @param {{ numbers: any, valueByStage: Array<any>, currency: string }} input
 */
function pickObservations({ numbers, valueByStage, currency }) {
  const { appointments } = numbers;
  /** @type {Array<{ id: string, text: string, action: string }>} */
  const candidates = [];
  const closedTotal = numbers.sales.count + numbers.lost.count;

  if (numbers.sales.count === 0 && numbers.pipeline.count > 0) {
    candidates.push({
      id: 'no-wins',
      text: `Nessuna chiusura nel periodo con ${numbers.pipeline.count} preventivi aperti (${formatMinor(numbers.pipeline.minor, currency)}): la pipeline non converte.`,
      action: 'Rileggi i preventivi aperti più vecchi e fissa la prossima mossa su ciascuno.',
    });
  }
  if (closedTotal > 0 && numbers.lost.count / closedTotal >= 0.3) {
    candidates.push({
      id: 'lost-rate',
      text: `${numbers.lost.count} preventivi persi su ${closedTotal} chiusi (${Math.round((numbers.lost.count / closedTotal) * 100)}%): il tasso di perdita è sopra la soglia.`,
      action: 'Rileggi i motivi di perdita prima di spingere le trattative aperte.',
    });
  }
  const stuck = [...OPEN_STAGES]
    .map((stage) => valueByStage.find((entry) => entry?.stage === stage))
    .filter((entry) => entry !== undefined && numbers.pipeline.minor > 0)
    .sort((a, b) => b.minor - a.minor)[0];
  if (stuck !== undefined && stuck.minor / numbers.pipeline.minor >= 0.5 && numbers.pipeline.count > 0) {
    candidates.push({
      id: 'funnel-stuck',
      text: `${formatMinor(stuck.minor, currency)} fermi in «${stageLabel(stuck.stage)}»: più della metà del valore aperto è in un solo stadio.`,
      action: `Sblocca lo stadio «${stageLabel(stuck.stage)}»: chi non avanza da settimane va chiuso o rilanciato.`,
    });
  }
  const [top] = numbers.channels.top;
  if (top !== undefined && numbers.channels.total > 0 && top.total / numbers.channels.total >= 0.7) {
    candidates.push({
      id: 'channel-focus',
      text: `Il canale «${top.channel}» porta ${top.total} contatti su ${numbers.channels.total} (${Math.round((top.total / numbers.channels.total) * 100)}%): quasi tutto dipende da una sola fonte.`,
      action: 'Apri una seconda fonte di contatti per non dipendere da un solo canale.',
    });
  }
  const held = appointments.done + appointments.noShow;
  if (held > 0 && appointments.noShow / held >= 0.3) {
    candidates.push({
      id: 'no-show-rate',
      text: `${appointments.noShow} appuntamenti saltati su ${held} fissati (${Math.round((appointments.noShow / held) * 100)}%): i buchi in agenda costano chiusure.`,
      action: 'Aggiungi un promemoria il giorno prima per gli appuntamenti a rischio.',
    });
  }
  if (numbers.winRate !== null && numbers.winRate >= 0.5 && closedTotal > 0) {
    candidates.push({
      id: 'win-rate-high',
      text: `Tasso di chiusura al ${numbers.winRateDisplay} su ${closedTotal} decisioni: la squadra converte bene.`,
      action: 'Proteggi il ritmo: priorità ai preventivi in chiusura nel periodo.',
    });
  }

  const picked = candidates.slice(0, 3).map((entry) => Object.freeze(entry));
  if (picked.length === 0) {
    return Object.freeze([
      Object.freeze({
        id: 'no-data',
        text: 'Ancora nessun movimento nei numeri di Reporting: il prossimo report si riempie da solo.',
        action: 'Inserisci i primi preventivi e fissa i primi appuntamenti.',
      }),
      Object.freeze({
        id: 'steady',
        text: 'Nessun segnale sopra le soglie questa settimana: distribuzione regolare.',
        action: 'Mantieni il ritmo su pipeline e appuntamenti.',
      }),
    ]);
  }
  if (picked.length === 1) {
    return Object.freeze([
      picked[0],
      Object.freeze({
        id: 'steady',
        text: 'Per il resto, distribuzione regolare: nessun altro segnale sopra le soglie.',
        action: 'Mantieni il ritmo su pipeline e appuntamenti.',
      }),
    ]);
  }
  return Object.freeze(picked);
}
