// @ts-check

// Team member names for the offer screens (backlog:ddf7f416): the deal's
// Referente and its «Creata da» author paint with nome e cognome, never a
// technical id («coach-guido») or the generic «utente». The roster is
// `GET /api/spine/memberships` (enriched with displayName/email by the
// pilot; bare framework rows carry no name and resolve to nothing). Every
// read here is best-effort: an unreadable roster degrades to the stored
// value, never to a blocked screen.

/** UUID shape: a technical id, never a person's name. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Documented service identities: technical handles, never a person's name.
 * (Admin mutations write `admin-ui`; the system writes with `system`.)
 */
const SERVICE_HANDLES = new Set(['admin-ui', 'system']);

/**
 * Whether a stored value looks like a technical handle instead of a human
 * name: a UUID, a pipe subject (`github|…`, never painted anywhere) or a
 * known service handle. A plain handle such as `coach-guido` is not
 * detectable by shape alone — it resolves through the roster instead.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTechnicalHandle(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return false;
  return UUID_SHAPE.test(text) || text.includes('|') || SERVICE_HANDLES.has(text);
}

/**
 * Display name of one roster entry: the pilot-enriched displayName, else
 * the mailbox (recognizable, never an id), else null — a nameless entry
 * never contributes a painted value.
 * @param {any} member
 * @returns {string|null}
 */
function rosterDisplayName(member) {
  if (!member || typeof member !== 'object') return null;
  const display = typeof member.displayName === 'string' ? member.displayName.trim() : '';
  if (display !== '' && !isTechnicalHandle(display)) return display;
  const email = typeof member.email === 'string' ? member.email.trim() : '';
  if (email !== '' && !isTechnicalHandle(email)) return email;
  return null;
}

/**
 * Build the lookup tables from `GET /api/spine/memberships` items:
 * subject → display name, plus the sorted distinct labels for the
 * Referente selects. Nameless entries are skipped, never painted.
 * @param {unknown} items
 * @returns {{bySubject: Map<string, string>, labels: Array<string>}}
 */
export function teamRoster(items) {
  /** @type {Map<string, string>} */
  const bySubject = new Map();
  /** @type {Set<string>} */
  const seen = new Set();
  for (const member of Array.isArray(items) ? items : []) {
    const subject = member && typeof member.subject === 'string' ? member.subject.trim() : '';
    if (subject === '' || bySubject.has(subject)) continue;
    const display = rosterDisplayName(member);
    if (display === null) continue;
    bySubject.set(subject, display);
    seen.add(display);
  }
  return { bySubject, labels: [...seen].sort((a, b) => a.localeCompare('it')) };
}

/** An empty roster: every resolution misses, stored values paint as-is. */
export function emptyRoster() {
  return teamRoster([]);
}

/**
 * Best-effort roster read: a refused or unreadable membership list
 * (non-admin operators cannot list it) resolves to an empty roster, never
 * to a failed screen.
 * @param {{request: (path: string) => Promise<any>}} client
 * @returns {Promise<{bySubject: Map<string, string>, labels: Array<string>}>}
 */
export async function fetchTeamRoster(client) {
  try {
    const answer = await client.request('/api/spine/memberships');
    return teamRoster(answer?.items);
  } catch {
    return emptyRoster();
  }
}

/**
 * Resolve a stored referente/author value to its display name: a roster
 * subject reads its member name, an already-human value reads as-is, and
 * anything else misses (null) so the caller can degrade honestly.
 * @param {unknown} value
 * @param {{bySubject: Map<string, string>, labels: Array<string>}|null} roster
 * @returns {string|null}
 */
export function resolveTeamName(value, roster) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return null;
  const hit = roster?.bySubject?.get(text);
  if (typeof hit === 'string' && hit !== '') return hit;
  if (Array.isArray(roster?.labels) && roster.labels.includes(text)) return text;
  return null;
}

/**
 * The referente one offer screen paints: the roster name for a member
 * subject or a known member label, and an em dash for anything the
 * roster cannot resolve — never an id, never a bare handle. When the
 * roster names nobody (an unreadable or empty membership list) the
 * stored value still paints as-is, so the screen degrades instead of
 * going blank. A readable roster that cannot resolve the value means
 * the record holds a stale handle, not a chosen name: paint a dash.
 * @param {unknown} owner
 * @param {{bySubject: Map<string, string>, labels: Array<string>}|null} roster
 * @returns {string}
 */
export function paintOwnerName(owner, roster) {
  const raw = typeof owner === 'string' ? owner.trim() : '';
  if (raw === '') return '—';
  const hit = resolveTeamName(raw, roster);
  if (hit !== null) return hit;
  if (isTechnicalHandle(raw)) return '—';
  const labels = Array.isArray(roster?.labels) ? roster.labels : null;
  if (labels !== null && labels.length > 0) return '—';
  return raw;
}
