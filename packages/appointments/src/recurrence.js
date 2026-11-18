// @ts-check
import { ValidationError } from '../../core/index.js';
/**
 * **Recurrence (backlog:0f2ae629e09b): Google-Calendar-style series, small
 * scope.** The manual «Nuovo appuntamento» form offers four choices —
 * «Non si ripete», «Ogni giorno», «Ogni settimana di <giorno>»,
 * «Ogni mese il <n>° <giorno>» — valid only in spaces without a linked
 * Google Calendar. Yearly, weekdays and «Personalizza…» are follow-ups,
 * so the validator refuses them naming `recurrence` instead of guessing.
 *
 * One validated rule describes the whole series; `expandRecurrence` turns it
 * into concrete occurrence slots the booking path checks one by one (each
 * occurrence is refused 409 on its own conflict, naming its date).
 *
 * All calendar arithmetic runs in Europe/Rome wall time (the operator books
 * «ogni martedì alle 17:00», Rome time): occurrences keep their wall hour
 * across DST changes, and months without the named day are skipped, never
 * rolled into the next month. Anything unprovable fails closed with a
 * ValidationError naming `recurrence`, never a guessed slot.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Hard cap: a series expands to at most this many occurrences. */
export const RECURRENCE_MAX_OCCURRENCES = 365;
/** An open-ended series stops a year after its first slot. */
const OPEN_SERIES_DAYS = 366;

export const RECURRENCE_KINDS = Object.freeze(['none', 'daily', 'weekly', 'monthly']);

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const IS_LEAP = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const MONTH_LENGTHS = (year) => [31, IS_LEAP(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const IT_WEEKDAYS_LONG = Object.freeze([
  'domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato',
]);

/**
 * Rome wall-clock parts of an instant, or null when unprovable. `en-CA`
 * paints the day as YYYY-MM-DD; the time comes from a 24 h read like the
 * admin calendar's own (midnight may read back as 24:00 on some ICU builds).
 * @param {number} ms
 */
function romeParts(ms) {
  try {
    const instant = new Date(ms);
    if (Number.isNaN(instant.getTime())) return null;
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(instant);
    if (!DATE_KEY_RE.test(day)) return null;
    const [year, month, date] = day.split('-').map(Number);
    const seen = new Intl.DateTimeFormat('it-IT', {
      timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(instant);
    const clock = seen === '24:00' ? '00:00' : seen;
    const match = /^(\d{2}):(\d{2})$/.exec(clock);
    if (!match) return null;
    return {
      year, month, date, hour: Number(match[1]), minute: Number(match[2]),
      /** 0 = Sunday … 6 = Saturday, from the Rome day itself. */
      weekday: new Date(Date.UTC(year, month - 1, date)).getUTCDay(),
    };
  } catch {
    return null;
  }
}

/**
 * A Rome wall datetime back to an instant, by round-trip: guess UTC, read
 * back the Rome wall, correct the guess. Accepted only when the full Rome
 * wall (day, hour, minute) matches; a drift that cannot be corrected fails
 * closed with null, never a neighboring slot.
 */
function romeWallToMs(year, month, date, hour, minute) {
  let guess = Date.UTC(year, month - 1, date, hour, minute);
  for (let round = 0; round < 3; round += 1) {
    const seen = romeParts(guess);
    if (seen === null) return null;
    const seenDayMs = Date.UTC(seen.year, seen.month - 1, seen.date);
    const wantDayMs = Date.UTC(year, month - 1, date);
    const driftMs = (wantDayMs - seenDayMs)
      + ((hour - seen.hour) * 60 + (minute - seen.minute)) * 60 * 1000;
    if (driftMs === 0) return guess;
    guess += driftMs;
  }
  return null;
}

/** The nth (1-based) weekday-of-month: which occurrence of `weekday` the date is. */
function nthOfMonth(date, weekday, monthStartWeekday) {
  return Math.floor((date - 1 - ((weekday - monthStartWeekday + 7) % 7)) / 7) + 1;
}

/**
 * Validate a recurrence rule. `null`, `undefined` and `{ kind: 'none' }` all
 * mean «Non si ripete» and answer null. Anything else answers a normalized
 * rule; anything unprovable throws a ValidationError naming `recurrence`.
 * Only daily, weekly and monthly are modelled in this scope: yearly,
 * weekdays and custom are refused with a plain sentence, never expanded
 * halfway.
 * @param {unknown} rule
 */
export function validateRecurrence(rule) {
  if (rule === null || rule === undefined) return null;
  if (typeof rule !== 'object' || Array.isArray(rule)) {
    throw new ValidationError('recurrence must be an object with a kind', { field: 'recurrence' });
  }
  const input = /** @type {any} */ (rule);
  const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
  if (kind === '' || kind === 'none') return null;
  if (!RECURRENCE_KINDS.includes(kind)) {
    throw new ValidationError(
      `recurrence kind "${kind}" is not offered yet: the form offers daily, weekly and monthly — yearly, weekdays and custom arrive later`,
      { field: 'recurrence' },
    );
  }
  const interval = input.interval === undefined || input.interval === null ? 1 : input.interval;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 99) {
    throw new ValidationError('recurrence interval must be an integer from 1 to 99', { field: 'recurrence' });
  }
  if (input.days !== undefined && input.days !== null) {
    throw new ValidationError(`recurrence days are not read on "${kind}": the day comes from the chosen date`, { field: 'recurrence' });
  }
  const unit = kind === 'daily' ? 'day' : kind === 'weekly' ? 'week' : 'month';
  let count = null;
  let until = null;
  if (input.count !== undefined && input.count !== null) {
    const n = typeof input.count === 'number' ? input.count : Number(String(input.count).trim());
    if (!Number.isSafeInteger(n) || n < 1 || n > RECURRENCE_MAX_OCCURRENCES) {
      throw new ValidationError(`recurrence count must be an integer from 1 to ${RECURRENCE_MAX_OCCURRENCES}`, { field: 'recurrence' });
    }
    count = n;
  }
  if (input.until !== undefined && input.until !== null) {
    const raw = String(input.until).trim();
    if (DATE_KEY_RE.test(raw)) {
      const [y, m, d] = raw.split('-').map(Number);
      if (m < 1 || m > 12 || d < 1 || d > MONTH_LENGTHS(y)[m - 1]) {
        throw new ValidationError(`recurrence until "${raw}" is not a real calendar date`, { field: 'recurrence' });
      }
      until = raw;
    } else {
      const ms = Date.parse(raw);
      if (!Number.isFinite(ms)) {
        throw new ValidationError('recurrence until must be a YYYY-MM-DD day or an ISO instant', { field: 'recurrence' });
      }
      until = new Date(ms).toISOString();
    }
  }
  if (count !== null && until !== null) {
    throw new ValidationError(
      'recurrence ends either after a number of times or on a date, never both: scegli o un numero di volte o una data di fine',
      { field: 'recurrence' },
    );
  }
  return Object.freeze({ kind, interval, days: null, unit, count, until });
}

/**
 * The «Si ripete» choices for a start instant, Google-Calendar-style: the
 * labels are computed from the chosen date (weekday, month position), so
 * «Ogni settimana di martedì» only ever names the real day.
 * @param {string} startsAtIso
 */
export function recurrenceOptions(startsAtIso) {
  const ms = Date.parse(String(startsAtIso ?? ''));
  const parts = Number.isFinite(ms) ? romeParts(ms) : null;
  const weekday = parts !== null ? IT_WEEKDAYS_LONG[parts.weekday] : '—';
  const monthLabel = parts !== null
    ? `Ogni mese il ${nthOfMonth(parts.date, parts.weekday, new Date(Date.UTC(parts.year, parts.month - 1, 1)).getUTCDay())}° ${IT_WEEKDAYS_LONG[parts.weekday]}`
    : 'Ogni mese';
  return Object.freeze([
    Object.freeze({ value: 'none', label: 'Non si ripete' }),
    Object.freeze({ value: 'daily', label: 'Ogni giorno' }),
    Object.freeze({ value: 'weekly', label: `Ogni settimana di ${weekday}` }),
    Object.freeze({ value: 'monthly', label: monthLabel }),
  ]);
}

/**
 * Turn a validated rule into occurrence slots. The first occurrence is the
 * named slot itself; every later one keeps the same Rome wall hour. Months
 * without the named day are skipped, never rolled. Open-ended rules stop a
 * year out; nothing ever expands past RECURRENCE_MAX_OCCURRENCES.
 * @param {{ startsAtMs: number, endsAtMs: number, recurrence: any }} input
 */
export function expandRecurrence({ startsAtMs, endsAtMs, recurrence }) {
  const rule = validateRecurrence(recurrence);
  if (rule === null) return [];
  if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs) || endsAtMs <= startsAtMs) {
    throw new ValidationError('a series expands from a real slot: startsAt before endsAt', { field: 'recurrence' });
  }
  const durationMs = endsAtMs - startsAtMs;
  const start = romeParts(startsAtMs);
  if (start === null) {
    throw new ValidationError('a series expands from a provable Rome wall time', { field: 'recurrence' });
  }
  const untilMs = rule.until !== null
    ? (DATE_KEY_RE.test(rule.until)
      ? Date.parse(`${rule.until}T23:59:59.999Z`)
      : Date.parse(rule.until))
    : startsAtMs + OPEN_SERIES_DAYS * DAY_MS;
  const wantCount = rule.count ?? RECURRENCE_MAX_OCCURRENCES;
  const starts = [];
  if (rule.kind === 'daily') {
    let day = { ...start };
    let step = 0;
    while (starts.length < wantCount && starts.length < RECURRENCE_MAX_OCCURRENCES) {
      const ms = step === 0 ? startsAtMs : romeWallToMs(day.year, day.month, day.date, start.hour, start.minute);
      if (ms === null) break;
      if (ms > untilMs) break;
      if (step > 0 && ms <= startsAtMs) break;
      starts.push(ms);
      step += 1;
      const next = new Date(Date.UTC(day.year, day.month - 1, day.date) + rule.interval * DAY_MS);
      day = { ...day, year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, date: next.getUTCDate() };
      if (step > RECURRENCE_MAX_OCCURRENCES + 2) break;
    }
  } else if (rule.kind === 'weekly') {
    const isoDay = start.weekday === 0 ? 7 : start.weekday;
    const baseMonday = Date.UTC(start.year, start.month - 1, start.date)
      - ((start.weekday + 6) % 7) * DAY_MS;
    let week = 0;
    let guard = 0;
    while (starts.length < wantCount && starts.length < RECURRENCE_MAX_OCCURRENCES && guard < 900) {
      guard += 1;
      const cursor = baseMonday + (week * rule.interval) * 7 * DAY_MS + (isoDay - 1) * DAY_MS;
      if (cursor < Date.UTC(start.year, start.month - 1, start.date)) { week += 1; continue; }
      const probe = new Date(cursor);
      const ms = cursor === Date.UTC(start.year, start.month - 1, start.date)
        ? startsAtMs
        : romeWallToMs(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate(), start.hour, start.minute);
      if (ms === null) { week += 1; continue; }
      if (ms > untilMs) break;
      if (ms >= startsAtMs) starts.push(ms);
      week += 1;
    }
  } else if (rule.kind === 'monthly') {
    const targetNth = nthOfMonth(start.date, start.weekday, new Date(Date.UTC(start.year, start.month - 1, 1)).getUTCDay());
    let step = 0;
    let guard = 0;
    while (starts.length < wantCount && starts.length < RECURRENCE_MAX_OCCURRENCES && guard < 400) {
      guard += 1;
      const monthIndex = (start.year * 12 + (start.month - 1)) + step * rule.interval;
      const year = Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      step += 1;
      const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
      const offset = (start.weekday - firstDow + 7) % 7;
      const date = 1 + offset + (targetNth - 1) * 7;
      if (date > MONTH_LENGTHS(year)[month - 1]) continue;
      const ms = step === 1 && month === start.month && year === start.year
        ? startsAtMs
        : romeWallToMs(year, month, date, start.hour, start.minute);
      if (ms === null) continue;
      if (ms < startsAtMs) continue;
      if (ms > untilMs) break;
      starts.push(ms);
    }
  }
  return Object.freeze(starts.map((slotMs) => {
    const slotStart = new Date(slotMs).toISOString();
    const slotEnd = new Date(slotMs + durationMs).toISOString();
    return Object.freeze({ startMs: slotMs, endMs: slotMs + durationMs, startsAt: slotStart, endsAt: slotEnd });
  }));
}
