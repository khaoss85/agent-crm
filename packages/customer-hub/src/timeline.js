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

/**
 * @param {{core?: any, subject: {resource: string, id: string, owner?: string, ownerPackage?: string|null}, readProfile: (input: any) => Promise<any>, readConversations: (subject: any) => Promise<any>, readTimeline: (subject: any) => Promise<any>, readSchedule: (subject: any) => Promise<any>}} input
 */
export async function readCustomerTimeline({ core, subject, readProfile, readConversations, readTimeline, readSchedule }) {
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
  const profile = await readProfile({ core, subject: { resource, id } });
  const threads = await readConversations(envelope);
  const history = await readTimeline(envelope);
  const schedule = await readSchedule(envelope);
  return shapeCustomerTimeline({ profile, threads, history, schedule, subject: { resource, id } });
}

/**
 * The pure shaping step, separated so the section layout is provable without
 * a database: every grouping, cap and contact-point branch is a unit test
 * over fabricated provider reads, while the database tests prove reuse and
 * no-write.
 *
 * @param {{profile: any, threads: Array<any>, history: any, schedule: Array<any>, subject: {resource: string, id: string}}} input
 */
export function shapeCustomerTimeline({ profile, threads, history, schedule, subject }) {
  // Like the card: a missing canonical record is NOT_FOUND, never an empty
  // timeline that reads as "this customer never spoke to us".
  const contact = profile.identity?.contact ?? null;
  const company = profile.identity?.company ?? null;
  if (!contact && !company) {
    throw new NotFoundError(String(subject?.resource ?? 'Customer'), String(subject?.id ?? 'unknown'));
  }
  const contactPoints = shapeContactPoints(profile);
  const conversations = shapeConversations(threads ?? [], history?.entries ?? []);
  const appointments = shapeAppointments(schedule ?? []);

  return Object.freeze({
    customerTimelineContract: CUSTOMER_TIMELINE_CONTRACT,
    subject: Object.freeze({ ...subject }),
    conversations,
    appointments,
    contactPoints,
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
