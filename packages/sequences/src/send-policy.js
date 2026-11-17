// @ts-check

/**
 * Space send rules for every send agents or sequences propose
 * (backlog:b6f8a6504a24 — Kombo map 12/11, sections 8-9, «dopo il minimo
 * per Presti»).
 *
 * Four rules, one per acceptance criterion, all pure and framework-side so
 * both the sequences sweep and any agent path decide the same way:
 *
 * 1. **Sending window.** Days and hours come from the space playbook
 *    (`sales-playbook` `hours`, e.g. `Lun-Ven 6:30-22:00, Sab 8:00-13:00`).
 *    A due send outside the window waits for the next window start —
 *    nothing is queued and no proposal forms.
 * 2. **Daily per-channel cap.** Kombo-observed defaults (40 messages a day,
 *    20 for WhatsApp); per-space overrides are a follow-up. A send past the
 *    cap waits for the next day, and the approval proposal says so.
 * 3. **One active journey.** A person with an active enrollment in one
 *    sequence never enters a second (`SEQUENCE_ALREADY_ENROLLED`).
 * 4. **Do-not-contact.** A listed domain or contact never forms a proposal:
 *    the step is refused row-locally with the list's reason.
 *
 * What this file does NOT do: store anything (the sweep reads the
 * `sales-playbook` and `sequence-suppression` record services when the
 * composition provides them, and treats a missing module as «no rule» so
 * old compositions keep working), contact any provider, or decide anything
 * in another language than the playbook's Italian shorthand.
 */

export const SEND_POLICY_TIME_ZONE = 'Europe/Rome';

/** A channel send per day before the space must wait for tomorrow. */
export const DAILY_CHANNEL_CAP_DEFAULT = 40;

/**
 * Kombo-observed per-channel daily caps (KOMBO-MAPPA-E-PROPOSTA.md 12/11:
 * 25 collegamenti, 40 messaggi LinkedIn, 40 email, 20 WhatsApp). Only the
 * channels this framework sends on are listed; anything else — and any
 * future channel — falls back to the default above. Per-space overrides
 * are a follow-up, recorded in the PR.
 */
export const DAILY_CHANNEL_CAPS = Object.freeze({
  whatsapp: 20,
  email: 40,
  gmail: 40,
  instagram: 40,
  messenger: 40,
  telegram: 40,
  sms: 40,
  voice: 10,
});

/** @param {unknown} channel */
export function capForChannel(channel) {
  const key = typeof channel === 'string' ? channel.trim().toLowerCase() : '';
  if (key !== '' && Object.hasOwn(DAILY_CHANNEL_CAPS, key)) {
    return DAILY_CHANNEL_CAPS[key];
  }
  return DAILY_CHANNEL_CAP_DEFAULT;
}

/** Italian weekday roots, Monday-first (1) through Sunday (7). */
const WEEKDAY_ROOTS = Object.freeze(['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom']);

/** @param {string} token */
function weekdayNumber(token) {
  const bare = token.trim().toLowerCase().replace(/\.+$/, '');
  const index = WEEKDAY_ROOTS.findIndex((root) => bare.startsWith(root));
  return index === -1 ? null : index + 1;
}

/**
 * Expand one day token (`lun`, `lun-ven`) to weekday numbers. Null when the
 * token names no weekday — the caller drops the whole group, never a guess.
 * @param {string} token
 */
function expandDayToken(token) {
  const parts = token.split('-').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length === 1) {
    const day = weekdayNumber(parts[0]);
    return day === null ? null : [day];
  }
  if (parts.length === 2) {
    const from = weekdayNumber(parts[0]);
    const to = weekdayNumber(parts[1]);
    if (from === null || to === null) return null;
    const days = [];
    let cursor = from;
    for (;;) {
      days.push(cursor);
      if (cursor === to) break;
      cursor = cursor % 7 + 1;
    }
    return days;
  }
  return null;
}

/**
 * Parse one `hours` group (`Lun-Ven 6:30-22:00`, `Sab 8:00-13:00`).
 * Null when the group carries no usable day + time pair.
 * @param {string} group
 */
function parseHoursGroup(group) {
  const text = group.trim().replace(/\s+/g, ' ');
  if (text === '') return null;
  const timeMatch = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/.exec(text);
  if (!timeMatch) return null;
  const daysPart = text.slice(0, timeMatch.index).trim();
  const timesPart = text.slice(timeMatch.index).trim();
  if (daysPart === '') return null;
  const days = new Set();
  for (const token of daysPart.split(/[\s,/]+/).filter((part) => part !== '')) {
    const expanded = expandDayToken(token);
    if (expanded === null) return null;
    for (const day of expanded) days.add(day);
  }
  if (days.size === 0) return null;
  const windows = [];
  for (const range of timesPart.split(/[,/]/).map((part) => part.trim()).filter((part) => part !== '')) {
    const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(range);
    if (!match) return null;
    const startHour = Number(match[1]);
    const startMinute = Number(match[2]);
    const endHour = Number(match[3]);
    const endMinute = Number(match[4]);
    if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null;
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    if (start === end) return null;
    windows.push({ days: new Set(days), start, end, overnight: end < start });
  }
  return windows.length === 0 ? null : windows;
}

/**
 * Parse a playbook `hours` text into weekly send windows. Null when the
 * text is absent, empty, or carries no usable window — the caller then
 * applies no constraint, so spaces compiled before this rule (and texts the
 * parser does not cover yet) keep sending exactly as before.
 * @param {unknown} value
 */
export function parsePlaybookHours(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\r\n/g, '\n').trim().replace(/\.\s*$/, '');
  if (cleaned === '') return null;
  const windows = [];
  for (const group of cleaned.split(/[,;\n]+/)) {
    const parsed = parseHoursGroup(group);
    if (parsed) windows.push(...parsed);
  }
  return windows.length === 0 ? null : Object.freeze(windows.map((entry) => Object.freeze({
    days: Object.freeze([...entry.days].sort((a, b) => a - b)),
    start: entry.start,
    end: entry.end,
    overnight: entry.overnight,
  })));
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: SEND_POLICY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: SEND_POLICY_TIME_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

const EN_WEEKDAY_TO_NUMBER = Object.freeze({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 });

/**
 * The zoned clock of one instant: Rome calendar day, Monday-first weekday,
 * and minutes since midnight. Pure and total — every finite instant maps.
 * @param {number} ms
 */
export function romeClock(ms) {
  const at = new Date(ms);
  const dayKey = DAY_FORMAT.format(at);
  const parts = Object.fromEntries(TIME_FORMAT.formatToParts(at).map((part) => [part.type, part.value]));
  const weekday = EN_WEEKDAY_TO_NUMBER[parts.weekday] ?? null;
  if (weekday === null || typeof parts.hour !== 'string' || typeof parts.minute !== 'string') {
    throw new Error('romeClock cannot read the zoned clock');
  }
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  return { dayKey, weekday, minutes };
}

/** The Rome calendar day of one instant (`YYYY-MM-DD`). @param {number} ms */
export function romeDayKey(ms) {
  return romeClock(ms).dayKey;
}

/**
 * True while a send may leave during `windows` at `ms`. Overnight windows
 * cover the small hours of the next calendar day too.
 * @param {number} ms @param {Array<{days: Array<number>, start: number, end: number, overnight: boolean}>} windows
 */
export function isInsideSendWindow(ms, windows) {
  const clock = romeClock(ms);
  for (const entry of windows) {
    const days = new Set(entry.days);
    if (!entry.overnight) {
      if (days.has(clock.weekday) && clock.minutes >= entry.start && clock.minutes < entry.end) return true;
    } else if (
      (days.has(clock.weekday) && clock.minutes >= entry.start)
      || (days.has(clock.weekday === 1 ? 7 : clock.weekday - 1) && clock.minutes < entry.end)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The next instant at or after `fromMs` inside `windows`, minute-precise,
 * ISO. Null when `windows` is nullish (no constraint). Looks ahead eight
 * days so a week of closed days still lands; null past that (never, with a
 * non-empty parse, since every week repeats).
 * @param {number} fromMs @param {Array<{days: Array<number>, start: number, end: number, overnight: boolean}> | null} windows
 */
export function nextWindowStartMs(fromMs, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return null;
  const base = Math.floor(fromMs / 60000) * 60000;
  const limit = 8 * 24 * 60;
  for (let step = 0; step <= limit; step += 1) {
    const candidate = base + step * 60000;
    if (isInsideSendWindow(candidate, windows)) return candidate;
  }
  return null;
}

/**
 * The first instant of the next Rome calendar day after `fromMs`,
 * minute-precise. Binary search on the day key: the boundary is the only
 * instant in the range whose day flips.
 * @param {number} fromMs
 */
export function nextRomeDayStartMs(fromMs) {
  const key = romeDayKey(fromMs);
  let low = Math.floor(fromMs / 60000) * 60000;
  let high = low + 48 * 60 * 60000;
  if (romeDayKey(high) === key) throw new Error('nextRomeDayStartMs found no day flip in 48h');
  while (high - low > 60000) {
    const mid = low + Math.floor((high - low) / 2 / 60000) * 60000;
    if (romeDayKey(mid) === key) low = mid;
    else high = mid;
  }
  return high;
}

/**
 * Normalize one do-not-contact value for comparison. Domains travel
 * lowercased without a leading `@`; a contact holding an `@` compares
 * lowercased too, so `Nome@Esempio.it` still matches.
 * @param {unknown} value
 */
export function normalizeSuppressionValue(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return '';
  const bare = text.startsWith('@') ? text.slice(1) : text;
  return bare.includes('@') ? bare.toLowerCase() : bare;
}

/** The domain of a recipient or subject id, or '' when it names none. @param {unknown} value */
export function suppressionDomainOf(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  const at = text.lastIndexOf('@');
  if (at === -1 || at === text.length - 1) return '';
  return text.slice(at + 1).toLowerCase();
}

/**
 * The first active suppression listing `recipient` or `subjectId`, or null.
 * `contact` matches the exact value; `domain` matches the value's domain.
 * @param {{recipient?: unknown, subjectId?: unknown, rows?: Array<any>}} input
 */
export function matchSuppression({ recipient, subjectId, rows }) {
  const listed = Array.isArray(rows) ? rows : [];
  const contacts = [normalizeSuppressionValue(recipient), normalizeSuppressionValue(subjectId)]
    .filter((text) => text !== '');
  const domains = [suppressionDomainOf(recipient), suppressionDomainOf(subjectId)]
    .filter((text) => text !== '');
  for (const row of listed) {
    if (!row || typeof row !== 'object' || row.status !== 'active') continue;
    const kind = row.kind;
    const value = normalizeSuppressionValue(row.value);
    if (value === '') continue;
    if (kind === 'contact' && contacts.includes(value)) {
      return { kind, value, reason: typeof row.reason === 'string' ? row.reason : '' };
    }
    if (kind === 'domain' && domains.includes(value)) {
      return { kind, value, reason: typeof row.reason === 'string' ? row.reason : '' };
    }
  }
  return null;
}

/**
 * Count today's (Rome day) channel sends over send rows joined to their
 * steps. Only rows that took provider capacity count: queued and sent.
 * waiting-approval proposals and terminal skips never left, dead letters
 * are retried under the same key rather than sent twice.
 * @param {{nowMs: number, channel: unknown, sends?: Array<any>, stepsByKey?: Map<string, any>}} input
 */
export function countChannelSendsToday({ nowMs, channel, sends, stepsByKey }) {
  const key = typeof channel === 'string' ? channel.trim().toLowerCase() : '';
  if (key === '') return 0;
  const today = romeDayKey(nowMs);
  let count = 0;
  for (const row of Array.isArray(sends) ? sends : []) {
    if (!row || typeof row !== 'object') continue;
    if (row.status !== 'queued' && row.status !== 'sent') continue;
    const stepKey = `${row.sequenceSourceKey ?? ''} ${Number.isInteger(row.stepOrder) ? row.stepOrder : '?'}`;
    const step = stepsByKey instanceof Map ? stepsByKey.get(stepKey) : null;
    const rowChannel = typeof step?.channel === 'string' ? step.channel.trim().toLowerCase() : '';
    if (rowChannel !== key) continue;
    const at = typeof row.queuedAt === 'string' ? Date.parse(row.queuedAt) : NaN;
    if (!Number.isFinite(at) || romeDayKey(at) !== today) continue;
    count += 1;
  }
  return count;
}
