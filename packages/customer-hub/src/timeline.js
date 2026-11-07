// @ts-check

import { NotFoundError, ValidationError } from '../../core/index.js';
import { PHONE_SYSTEMS, SOCIAL_SYSTEMS, toDialablePhone } from './card.js';
// This module imports nothing from any other domain package — not even the
// entries of the packages it reads. Conversations, messages, calls and
// appointments arrive as the providers' own created capability objects
// (`interaction-timeline@1`, `appointment-schedule@1`), handed to the hub
// factory at the composition site, so the shaping below cannot diverge from
// the providers' own reads.

/**
 * **The customer timeline: every conversation, every appointment, every way
 * to reach the customer — zero new records.**
 *
 * The timeline reuses the rows the owning packages already hold: conversation
 * threads and their messages/calls (`packages/interactions`), appointment
 * bookings (`packages/appointments`), and the channel identities held beside
 * the host record (`read-customer-profile` in `packages/customer-data`). It
 * creates nothing: no master customer row, no copy of any business record, no
 * new table. Every provider read behind it is a complete exact-match query,
 * never a bounded display page, so a section that outgrows a page loses
 * nothing — it reports truncated with its exact count instead.
 *
 * What it deliberately is **not**: a cross-channel merge (marketing,
 * analytics and external systems are absent by construction, like the
 * profile); an ownership view (the handover trail stays in Posta unica, which
 * reads the same threads); a scheduler (booking stays in appointments).
 */

export const CUSTOMER_TIMELINE_CONTRACT = 1;

/** Display caps, mirroring the profile's own 50-row slices. */
const CONVERSATION_LIMIT = 50;
const APPOINTMENT_LIMIT = 50;
const ENTRY_LIMIT = 50;

/**
 * @param {{core?: any, subject: {resource: string, id: string, owner?: string, ownerPackage?: string|null}, readProfile: (input: any) => Promise<any>, readConversations: (subject: any) => Promise<any>, readTimeline: (subject: any) => Promise<any>, readSchedule: (subject: any) => Promise<any>, readFlags?: ((entries: Array<any>) => Promise<Array<boolean|null>|null>)|null}} input
 *   readFlags answers the `read` verdicts over the history entries through
 *   the interactions timeline capability (backlog:9e003582): the same rule
 *   the customer list counts with, so the scheda badge and the list badge
 *   can never disagree. Absent (or answering null) the entries still read,
 *   with every `read` null and `readState.available` false — no read state,
 *   never an invented flag.
 */
export async function readCustomerTimeline({ core, subject, readProfile, readConversations, readTimeline, readSchedule, readFlags = null }) {
  const resource = subject?.resource;
  const id = subject?.id;
  if (typeof resource !== 'string' || typeof id !== 'string' || resource === '' || id === '') {
    throw new ValidationError('a customer timeline needs a subject resource and id', { field: 'id' });
  }
  for (const [name, reader] of [
    ['customer-profile@1', readProfile],
    ['interaction-timeline@1', readConversations],
    ['interaction-timeline@1', readTimeline],
    ['appointment-schedule@1', readSchedule],
  ]) {
    if (typeof reader !== 'function') {
      throw new ValidationError(`a customer timeline needs the ${name} reader`, { field: 'timeline' });
    }
  }
  // Host contacts and companies are host-owned records. The envelope below
  // satisfies the providers' strict subject validation; the providers match
  // on resource and id, so rows opened under either owner are all read.
  const envelope = Object.freeze({
    resource,
    id,
    owner: subject?.owner ?? 'host',
    ownerPackage: subject?.ownerPackage ?? null,
  });
  // Voce 908f2eb9bbfb: the profile stays first for the verdict (the shaping
  // below joins on it), but the provider reads never needed it — they take
  // the envelope only. They start together with the profile instead of
  // stacking a second wait behind it: one scheda open was paying the profile
  // twice here (once directly, once behind the card and the timeline).
  // A synchronously-throwing reader settles like a rejection instead of
  // escaping while the array is still being built.
  const call = (reader, input) => Promise.resolve().then(() => reader(input));
  const profilePromise = call(readProfile, { core, subject: { resource, id } });
  const providerPromises = [
    call(readConversations, envelope),
    call(readTimeline, envelope),
    call(readSchedule, envelope),
  ];
  // The profile error wins, exactly as when it ran first: a late provider
  // failure behind a failed profile must not surface as an unhandled
  // rejection, so every provider carries a noop catch until the join below.
  for (const pending of providerPromises) pending.catch(() => {});
  const profile = await profilePromise;
  const [threads, history, schedule] = await Promise.all(providerPromises);
  // The flags ride after: they read the entries the providers returned, so
  // they wait for the history instead of racing it.
  const read = await readFlagsFor(history?.entries ?? [], readFlags);
  return shapeCustomerTimeline({ profile, threads, history, schedule, subject: { resource, id }, read });
}

/**
 * The `read` verdicts over history entries, in order, or null when there
 * is no read state to answer for. No flag reader, or a null behind it —
 * every one of those reads null, never an invented all-unread map: without
 * read state the entries below carry `read: null` instead of lighting up.
 * A ragged answer (not an array) reads null too, never a shifted verdict.
 */
async function readFlagsFor(entries, readFlags) {
  if (typeof readFlags !== 'function') return null;
  const flags = await readFlags(entries);
  return Array.isArray(flags) ? flags : null;
}

/**
 * The pure shaping step, separated so the section layout is provable without
 * a database: every grouping, cap and contact-point branch is a unit test
 * over fabricated provider reads, while the database tests prove reuse and
 * no-write.
 *
 * @param {{profile: any, threads: Array<any>, history: any, schedule: Array<any>, subject: {resource: string, id: string}, read?: Array<boolean|null>|null}} input
 *   read is the capability's `read` verdicts over the history entries, in
 *   order, or null when there is no read state to answer for
 *   (backlog:9e003582).
 */
export function shapeCustomerTimeline({ profile, threads, history, schedule, subject, read = null }) {
  // Like the card: a missing canonical record is NOT_FOUND, never an empty
  // timeline that reads as "this customer never spoke to us".
  const contact = profile.identity?.contact ?? null;
  const company = profile.identity?.company ?? null;
  if (!contact && !company) {
    throw new NotFoundError(String(subject?.resource ?? 'Customer'), String(subject?.id ?? 'unknown'));
  }
  const contactPoints = shapeContactPoints(profile);
  const conversations = shapeConversations(threads ?? [], history?.entries ?? []);
  const entries = shapeEntries(history?.entries ?? [], read ?? null);
  const appointments = shapeAppointments(schedule ?? []);

  return Object.freeze({
    customerTimelineContract: CUSTOMER_TIMELINE_CONTRACT,
    subject: Object.freeze({ ...subject }),
    conversations,
    entries,
    appointments,
    contactPoints,
    // Whether the `read` flags below answer for somebody: false means every
    // one of them is null, never an invented flag.
    readState: Object.freeze({ available: read !== null && read !== undefined }),
    timelineNote:
      'Accordo-managed threads and bookings only: marketing, analytics and external systems are not represented. '
      + 'Threads are listed from their rows, so threads with no message or call logged yet are listed too.',
  });
}

/**
 * One item per thread row, oldest first, each with its own entries counted
 * and its latest entry previewed. Entries that name no thread (a call logged
 * without a conversation) belong to the customer but to no thread: they are
 * counted as unthreaded rather than silently dropped.
 */
function shapeConversations(threads, entries) {
  const byThread = new Map();
  let unthreadedMessages = 0;
  let unthreadedCalls = 0;
  for (const entry of entries ?? []) {
    if (entry?.conversationId === undefined || entry?.conversationId === null || entry?.conversationId === '') {
      // Only channel evidence counts here: work notes ride the same timeline
      // read but belong to the work views, and counting them as messages
      // would invent conversations that never happened.
      if (entry?.entry === 'call') unthreadedCalls += 1;
      else if (entry?.entry === 'message') unthreadedMessages += 1;
      continue;
    }
    const key = String(entry.conversationId);
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(entry);
  }
  const latest = (rows) => {
    const ordered = [...rows].sort((a, b) => (
      String(a.occurredAt ?? '').localeCompare(String(b.occurredAt ?? ''))
      || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
      || String(a.id ?? '').localeCompare(String(b.id ?? ''))
    ));
    return ordered[ordered.length - 1] ?? null;
  };
  const items = [];
  let capped = false;
  for (const thread of threads ?? []) {
    if (items.length >= CONVERSATION_LIMIT) { capped = true; break; }
    const rows = byThread.get(String(thread.id)) ?? [];
    const messages = rows.filter((row) => row.entry !== 'call');
    const calls = rows.filter((row) => row.entry === 'call');
    const last = latest(rows);
    items.push(Object.freeze({
      id: thread.id,
      channel: thread.channel ?? null,
      status: thread.status ?? null,
      openedAt: thread.openedAt ?? null,
      closedAt: thread.closedAt ?? null,
      peer: thread.remoteHandle ?? null,
      messageCount: messages.length,
      callCount: calls.length,
      lastOccurredAt: last?.occurredAt ?? null,
      last: last === null ? null : Object.freeze({
        entry: last.entry,
        direction: last.direction ?? null,
        channel: last.channel ?? null,
        body: last.entry === 'call' ? null : (last.body ?? null),
        attachment: last.entry === 'call' ? null : (last.attachment ?? null),
        subject: last.entry === 'call' ? null : (last.subject ?? null),
        attachments: last.entry === 'call' ? Object.freeze([]) : (last.attachments ?? Object.freeze([])),
        outcome: last.entry === 'call' ? (last.outcome ?? null) : null,
        occurredAt: last.occurredAt ?? null,
      }),
    }));
  }
  if ((threads ?? []).length > items.length) capped = true;
  return Object.freeze({
    available: true,
    count: (threads ?? []).length,
    truncated: capped,
    items: Object.freeze(items),
    unthreadedMessages,
    unthreadedCalls,
  });
}

/**
 * Every channel passage as its own row, oldest first: the flat list the
 * scheda cliente filters per channel. Each row names its channel, its
 * direction and its sync state — the message delivery lifecycle
 * (`received`, `sent`, `delivered`, `read`, `failed`) or, for a call that
 * already happened, its immutable outcome. Operator notes riding the same
 * timeline read (voce 714433c2, `work-note` rows from the `note` kind) are
 * listed too, as channel-less `note` rows: a note is a statement about the
 * customer, not a passage on a channel, so it never counts as channel
 * evidence — but the scheda cronologia is where the operator who wrote it
 * reads it back.
 */
/**
 * The `read` flag on one message row: the capability's verdict at the same
 * index, so the scheda badge and the list badge can never disagree about
 * the same message (backlog:9e003582). Only message rows carry a verdict —
 * the team does not unread its own words, and a call carries none — and
 * only when read state is available: without flags every verdict is null,
 * never an invented all-unread page. A non-boolean verdict reads null too,
 * never a shifted flag.
 */
function readFlagAt(read, index) {
  if (!Array.isArray(read)) return null;
  return typeof read[index] === 'boolean' ? read[index] : null;
}

function shapeEntries(entries, read = null) {
  const rows = entries ?? [];
  const shaped = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.entry === 'message') {
      shaped.push(Object.freeze({
        entry: 'message',
        id: row.id,
        conversationId: row.conversationId ?? null,
        channel: row.channel ?? null,
        direction: row.direction ?? null,
        sync: row.status ?? null,
        read: readFlagAt(read, index),
        body: row.body ?? null,
        attachment: row.attachment ?? null,
        subject: row.subject ?? null,
        attachments: row.attachments ?? Object.freeze([]),
        teamAuthorId: row.teamAuthorId ?? null,
        remoteHandle: row.remoteHandle ?? null,
        errorCode: row.errorCode ?? null,
        occurredAt: row.occurredAt ?? null,
      }));
    } else if (row?.entry === 'call') {
      shaped.push(Object.freeze({
        entry: 'call',
        id: row.id,
        conversationId: row.conversationId ?? null,
        channel: row.channel ?? null,
        direction: row.direction ?? null,
        sync: row.outcome ?? null,
        durationSec: row.durationSec ?? null,
        teamAuthorId: row.teamAuthorId ?? null,
        remoteHandle: row.remoteHandle ?? null,
        errorCode: row.errorCode ?? null,
        occurredAt: row.occurredAt ?? null,
      }));
    } else if (row?.entry === 'work-note' && String(row?.kind ?? 'note') === 'note') {
      // Voce 714433c2: the operator note. Channel-less on purpose — it is
      // not channel evidence — with the writer when the row names one.
      // Only the `note` kind reads here: task lifecycle rows
      // (task_created/completed/cancelled) stay in the work views.
      shaped.push(Object.freeze({
        entry: 'note',
        id: row.id,
        conversationId: null,
        channel: null,
        direction: null,
        sync: null,
        body: typeof row.body === 'string' ? row.body : null,
        teamAuthorId: typeof row.actorId === 'string' ? row.actorId : null,
        remoteHandle: null,
        errorCode: null,
        occurredAt: row.occurredAt ?? null,
      }));
    }
  }
  // The provider read is oldest-first and complete. The scheda opens on
  // the newest, so the cut keeps the latest ENTRY_LIMIT rows (still oldest
  // first) and drops the oldest: a cut that dropped the newest hid today's
  // mail and the note the operator had just added (prod 06/11, 102 rows).
  const items = shaped.slice(Math.max(0, shaped.length - ENTRY_LIMIT));
  return Object.freeze({
    available: true,
    count: shaped.length,
    truncated: shaped.length > items.length,
    items: Object.freeze(items),
  });
}

/** The schedule rows as booked, soonest slot first, capped like the profile. */
function shapeAppointments(schedule) {
  const rows = schedule ?? [];
  const capped = rows.length > APPOINTMENT_LIMIT;
  const items = rows.slice(0, APPOINTMENT_LIMIT).map((row) => Object.freeze({
    id: row.id,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    serviceKey: row.serviceKey,
    teamMemberId: row.teamMemberId,
    priceCents: row.priceCents,
    currency: row.currency,
    notes: row.notes ?? null,
  }));
  return Object.freeze({
    available: true,
    count: rows.length,
    truncated: capped,
    items: Object.freeze(items),
  });
}

/**
 * Every dialable number, every inbox and every social handle the profile
 * holds beside the record — the same sources the card reads, so the two
 * never disagree on how to reach the customer. The identity reads behind the
 * profile are complete exact-match queries, so an empty list is an honest
 * empty: nothing held, not nothing read.
 */
function shapeContactPoints(profile) {
  const email = profile.identity?.contact?.email ?? null;
  const identities = Array.isArray(profile.externalIdentities) ? profile.externalIdentities : [];
  const items = [];
  const seen = new Set();
  const push = (channel, kind, value) => {
    const key = `${String(channel).toLowerCase()}|${kind}|${String(value)}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(Object.freeze({ channel, kind, value }));
  };
  for (const row of identities) {
    const system = String(row.system ?? '');
    if (system === '' || row.externalId === undefined || row.externalId === null || String(row.externalId) === '') continue;
    if (PHONE_SYSTEMS.includes(system.toLowerCase())) {
      if (toDialablePhone(row.externalId) !== null) push(row.system, 'phone', String(row.externalId));
    } else if (SOCIAL_SYSTEMS.includes(system.toLowerCase())) {
      push(row.system, 'social', String(row.externalId));
    }
  }
  if (typeof email === 'string' && email !== '') push('email', 'email', email);
  return Object.freeze({ available: true, count: items.length, items: Object.freeze(items) });
}
