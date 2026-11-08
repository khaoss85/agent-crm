// @ts-check

import { AppError, normalizeActor } from '../../core/index.js';
import { CUSTOMER_SCAN_LIMIT, PHONE_BEARING_SYSTEMS } from './customers.js';
import { emailShape, normalizeCompanyName } from './normalize.js';
import { isNoCompany, recordCandidatePairs } from './sender.js';
import {
  deciding,
  optional,
  orderedPair,
  subjectKey,
  trusted,
} from './store.js';

/**
 * **Data-cleanup proposals (backlog:4c8bd203): the pilot agent's «pulizia dati».**
 *
 * A deterministic scan over the stored customer records, not a rules engine
 * and not an agent runtime: no LLM, no clock in any identity, no threshold
 * invented here. It finds duplicate suspects (same normalized name, same
 * phone digits), missing or malformed contact channels, and records with no
 * open next step — and it proposes corrections (merge, completion, next
 * step) as work tasks in «Da fare», through the single governed
 * `follow-up@1` path, plus deterministic `duplicate-candidate` rows for the
 * merge suspects through the reused `recordCandidatePairs`.
 *
 * What it never does, by construction:
 * - it writes no contact, company or identity row — a proposal changes no
 *   customer data. The merge happens only through the existing human-decided
 *   candidate paths (`decidedByType: 'user'`), the phone only through the
 *   human-gated `recordSubjectPhone`, the completion only through the
 *   governed record writes, after confirmation;
 * - it never claims absence from a partial read: an unreadable dependency
 *   skips its detector with a named reason, never with an exact-looking
 *   empty answer (the same discipline as the customer list scan);
 * - a rerun proposes nothing twice: every candidate and every task carries a
 *   deterministic source key, so a replay answers the stored row.
 *
 * The work edge is optional, like the channels send edge in appointments: a
 * composition without work still scans and still records duplicate
 * candidates, and the response names `tasksUnavailable` instead of writing
 * tasks that nobody could confirm. There is no `requires` on work on
 * purpose — the foundation keeps booting without it.
 */

/** Provenance for candidates this scan records: the scan, not a timestamped run. */
const CLEANUP_RUN_ID = 'data-cleanup';

/** The dialable shape the scheda's «Chiama» needs: mirrored from
 * `recordSubjectPhone` in `./operations.js` (same package, one rule). */
const E164_RE = /^\+[1-9]\d{6,14}$/;

const SOURCE_ACTION = 'propose-data-cleanup';

const CLEANUP_LIMITATIONS = Object.freeze([
  'NO_CUSTOMER_WRITES — the scan writes proposals only (duplicate candidates, work tasks): no contact, company or identity row is created, changed or deleted',
  'NO_AUTOMATIC_MERGE — a duplicate candidate is never resolved without a human decision, through the existing candidate paths',
  'NO_EMAIL_DUPLICATES — a contact needs a globally-unique email at write time, so two contacts cannot share one: same-email pairs are impossible, not absent',
  'SENDER_NUMBERS_KEEP_SENDER_SHAPE — a malformed-phone proposal covers operator-held `phone` identities only; channel-observed numbers keep the sender shape',
  'WINDOWED_SCAN — the scan reads the newest 500 contacts and companies: beyond that it reports complete:false and proposes on the window, missing nothing it saw and claiming nothing past it',
]);

/** Display text only: control characters never reach a stored title. */
function cleanLabel(value) {
  const text = String(value ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  return text.slice(0, 60);
}

function contactLabel(contact) {
  return cleanLabel(`${contact?.firstName ?? ''} ${contact?.lastName ?? ''}`.trim());
}

function digitsOf(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** Exact-match read or a named miss, never a display page (see `./store.js`). */
async function exactRows(service, shapes) {
  const rows = [];
  for (const shape of shapes) {
    if (Array.isArray(shape.subjectId) && shape.subjectId.length === 0) continue;
    for (const row of await deciding(service, shape)) rows.push(row);
  }
  return rows;
}

export function createCleanupProposals({ database, modules, policy, names, followUpProvider = null }) {
  if (!database || !modules) {
    throw new AppError('data-cleanup proposals need database and modules', { code: 'CLEANUP_UNAVAILABLE', status: 500 });
  }
  if (!policy || typeof policy.resolve !== 'function') {
    throw new AppError('data-cleanup proposals need the declared match policy', { code: 'CLEANUP_UNAVAILABLE', status: 500 });
  }

  // The work handle opens with await: at capability contract 2 `create`
  // is async and answers a Promise, so a sync open would hand `openTask`
  // a Promise instead of the handle (`followUps.createFollowUp is not a
  // function`). Awaiting a contract-1 open settles it unchanged.
  const openFollowUps = async (actor) => {
    if (!followUpProvider || typeof followUpProvider.create !== 'function') return null;
    return followUpProvider.create({ modules, actor, consumer: 'customer-data' });
  };

  /**
   * Scan the stored records and propose corrections in «Da fare».
   * @param {{actor?: unknown}} [request]
   */
  async function proposeDataCleanup(request) {
    const actor = normalizeActor(request?.actor);
    const contactsSvc = optional(modules, 'contact');
    const companiesSvc = optional(modules, 'company');
    if (!contactsSvc || typeof contactsSvc.list !== 'function') {
      throw new AppError('the cleanup scan needs the host contact records', { code: 'CLEANUP_UNAVAILABLE', status: 409 });
    }
    if (!companiesSvc || typeof companiesSvc.list !== 'function') {
      throw new AppError('the cleanup scan needs the host company records', { code: 'CLEANUP_UNAVAILABLE', status: 409 });
    }
    const contacts = await contactsSvc.list({ limit: CUSTOMER_SCAN_LIMIT });
    const companies = await companiesSvc.list({ limit: CUSTOMER_SCAN_LIMIT });
    const complete = contacts.length < CUSTOMER_SCAN_LIMIT && companies.length < CUSTOMER_SCAN_LIMIT;

    const contactIds = contacts.map((contact) => contact?.id).filter((id) => typeof id === 'string');
    const companyIds = companies.map((company) => company?.id).filter((id) => typeof id === 'string');

    const identitySvc = optional(modules, names.identity);
    let identities = [];
    let identitiesAvailable = false;
    if (identitySvc && typeof identitySvc.listWhere === 'function') {
      try {
        identities = await exactRows(identitySvc, [
          { subjectResource: 'contact', subjectId: contactIds },
          { subjectResource: 'company', subjectId: companyIds },
        ]);
        identitiesAvailable = true;
      } catch {
        identities = [];
        identitiesAvailable = false;
      }
    }

    const taskSvc = optional(modules, 'work-task');
    let taskRows = [];
    let tasksReadable = false;
    if (taskSvc && typeof taskSvc.listWhere === 'function') {
      try {
        taskRows = await exactRows(taskSvc, [
          { subjectResource: 'contact', subjectId: contactIds },
          { subjectResource: 'company', subjectId: companyIds },
        ]);
        tasksReadable = true;
      } catch {
        taskRows = [];
        tasksReadable = false;
      }
    }

    const subjects = [
      ...contacts.map((contact) => ({
        resource: 'contact',
        id: contact?.id,
        label: contactLabel(contact),
        companyId: contact?.companyId ?? null,
        email: contact?.email ?? null,
      })),
      ...companies.map((company) => ({
        resource: 'company',
        id: company?.id,
        label: cleanLabel(company?.name),
        companyId: null,
        email: null,
      })),
    ].filter((subject) => typeof subject.id === 'string' && subject.id !== '');

    const activeIdentities = identities.filter((row) => row?.status === 'active');
    const phonesBySubject = new Map(subjects.map((subject) => [subjectKey(subject), []]));
    for (const row of activeIdentities) {
      if (!PHONE_BEARING_SYSTEMS.includes(String(row?.system ?? '').toLowerCase())) continue;
      const key = `${row.subjectResource}:${row.subjectId}`;
      if (phonesBySubject.has(key)) phonesBySubject.get(key).push(row);
    }

    const openBySubject = new Map(subjects.map((subject) => [subjectKey(subject), 0]));
    for (const row of taskRows) {
      if (row?.status !== 'open') continue;
      const key = `${row.subjectResource}:${row.subjectId}`;
      if (openBySubject.has(key)) openBySubject.set(key, openBySubject.get(key) + 1);
    }
    // The card reads the next step off the contact together with its
    // company: a contact whose company holds an open task has one.
    const hasNextStep = (subject) => {
      if ((openBySubject.get(subjectKey(subject)) ?? 0) > 0) return true;
      if (subject.resource === 'contact' && typeof subject.companyId === 'string') {
        return (openBySubject.get(`company:${subject.companyId}`) ?? 0) > 0;
      }
      return false;
    };

    // ── Findings (pure: no writes yet) ──────────────────────────────
    const pairs = [];
    const seenPair = new Set();
    const addPair = (left, right, rule, evidence) => {
      const ordered = orderedPair(left, right);
      const key = `${subjectKey(ordered.left)}|${subjectKey(ordered.right)}`;
      if (subjectKey(ordered.left) === subjectKey(ordered.right) || seenPair.has(key)) return;
      seenPair.add(key);
      pairs.push({ ...ordered, rule, evidence });
    };

    const subjectOf = (resource, id, label) => ({
      resource, id, owner: 'host', ownerPackage: null, label: label ?? null,
    });

    const byName = new Map();
    for (const subject of subjects) {
      if (subject.resource !== 'contact') continue;
      const contact = contacts.find((entry) => entry?.id === subject.id);
      const full = `${contact?.firstName ?? ''} ${contact?.lastName ?? ''}`.trim();
      if (full === '') continue;
      const normalized = normalizeCompanyName(full);
      if (!byName.has(normalized)) byName.set(normalized, []);
      byName.get(normalized).push(subject);
    }
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => (subjectKey(a) < subjectKey(b) ? -1 : 1));
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          addPair(
            subjectOf(sorted[i].resource, sorted[i].id, sorted[i].label),
            subjectOf(sorted[j].resource, sorted[j].id, sorted[j].label),
            'cleanup-same-name',
            `contacts ${sorted[i].id} and ${sorted[j].id} carry the same normalized name`,
          );
        }
      }
    }

    const byCompanyName = new Map();
    for (const subject of subjects) {
      if (subject.resource !== 'company' || !subject.label) continue;
      // Every contact without Azienda has its own «Senza azienda»
      // placeholder (production 07/11): same name by design, never a
      // duplicate suspect.
      if (isNoCompany({ name: subject.label })) continue;
      const normalized = normalizeCompanyName(subject.label);
      if (!byCompanyName.has(normalized)) byCompanyName.set(normalized, []);
      byCompanyName.get(normalized).push(subject);
    }
    for (const group of byCompanyName.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => (subjectKey(a) < subjectKey(b) ? -1 : 1));
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          addPair(
            subjectOf(sorted[i].resource, sorted[i].id, sorted[i].label),
            subjectOf(sorted[j].resource, sorted[j].id, sorted[j].label),
            'cleanup-same-company',
            `companies ${sorted[i].id} and ${sorted[j].id} carry the same normalized name`,
          );
        }
      }
    }

    if (identitiesAvailable) {
      const byDigits = new Map();
      for (const [key, rows] of phonesBySubject) {
        for (const row of rows) {
          const digits = digitsOf(row?.externalId);
          if (digits === '') continue;
          if (!byDigits.has(digits)) byDigits.set(digits, new Set());
          byDigits.get(digits).add(key);
        }
      }
      for (const keys of byDigits.values()) {
        if (keys.size < 2) continue;
        const sorted = [...keys].sort();
        for (let i = 0; i < sorted.length; i += 1) {
          for (let j = i + 1; j < sorted.length; j += 1) {
            const [leftResource, leftId] = sorted[i].split(/:(.+)/);
            const [rightResource, rightId] = sorted[j].split(/:(.+)/);
            const left = subjects.find((entry) => entry.resource === leftResource && entry.id === leftId);
            const right = subjects.find((entry) => entry.resource === rightResource && entry.id === rightId);
            if (!left || !right) continue;
            addPair(
              subjectOf(left.resource, left.id, left.label),
              subjectOf(right.resource, right.id, right.label),
              'cleanup-same-phone',
              `subjects ${sorted[i]} and ${sorted[j]} hold phone identities with the same digits`,
            );
          }
        }
      }
    }

    const completions = [];
    if (identitiesAvailable) {
      for (const subject of subjects) {
        const phones = phonesBySubject.get(subjectKey(subject)) ?? [];
        if (phones.length === 0) {
          completions.push({
            kind: 'missing-phone',
            subject,
            title: `Completa i contatti di ${subject.label ?? 'una scheda'}: manca il telefono`,
            evidence: `subject ${subjectKey(subject)} holds no active phone identity`,
          });
        }
        for (const row of phones) {
          if (String(row?.system ?? '').toLowerCase() !== 'phone') continue;
          if (!E164_RE.test(String(row?.externalId ?? ''))) {
            completions.push({
              kind: 'malformed-phone',
              subject,
              title: `Correggi il telefono di ${subject.label ?? 'una scheda'}: non è in formato internazionale`,
              evidence: `subject ${subjectKey(subject)} holds a phone identity that is not callable E.164`,
            });
          }
        }
      }
    }
    for (const subject of subjects) {
      if (subject.resource !== 'contact' || subject.email === null || subject.email === '') continue;
      let shaped = null;
      try {
        shaped = emailShape(subject.email);
      } catch {
        shaped = { ok: false, reason: 'shape', value: null };
      }
      if (shaped && shaped.ok !== true) {
        completions.push({
          kind: 'malformed-email',
          subject,
          title: `Correggi l'email di ${subject.label ?? 'una scheda'}: formato non valido`,
          evidence: `contact ${subject.id} carries an email that is not a valid address shape (value not echoed)`,
        });
      }
    }

    const nextSteps = [];
    if (tasksReadable) {
      for (const subject of subjects) {
        if (hasNextStep(subject)) continue;
        nextSteps.push({
          kind: 'next-step',
          subject,
          title: `Definisci il prossimo passo per ${subject.label ?? 'una scheda'}`,
          evidence: `subject ${subjectKey(subject)} has no open work task`,
        });
      }
    }

    // ── Writes: one transaction, proposals only ─────────────────────
    // The records behind the task/activity pair are decided before the
    // handle opens: the provider edge is optional, the records are not.
    const activitySvc = optional(modules, 'work-activity');
    const recordsWritable = Boolean(taskSvc && typeof taskSvc.createManaged === 'function'
      && activitySvc && typeof activitySvc.createManaged === 'function');

    const proposals = [];
    let tasksWritten = 0;
    let tasksReplayed = 0;
    const receipt = await database.transactionAsync(async () => {
      // The work handle opens inside this transaction, with await: at
      // capability contract 2 `create` is async, and `createFollowUp`
      // proves this flow owns the open transaction — on SQLite and
      // PostgreSQL alike — instead of refusing WORK_TRANSACTION_REQUIRED.
      const followUps = await openFollowUps(actor);
      const canWriteTasks = followUps !== null && recordsWritable;
      const tasksUnavailable = canWriteTasks
        ? null
        : 'the composition wires no opened work follow-up@1 edge, so proposals are returned without «Da fare» tasks';
      if (followUps !== null && !canWriteTasks) {
        // An edge that cannot prove the task/activity pair is a wiring the
        // caller must see, not a silent skip: it refuses fail-closed.
        throw new AppError(
          'the cleanup scan found an opened work follow-up@1 edge without writable work-task and work-activity records',
          { code: 'CLEANUP_UNAVAILABLE', status: 500 },
        );
      }
      const openTask = async (proposal) => {
        if (!canWriteTasks) return { taskId: null, replayed: null };
        const subject = subjectOf(proposal.subject.resource, proposal.subject.id, proposal.subject.label);
        const { task, replayed } = await followUps.createFollowUp({
          sourceKey: proposal.sourceKey,
          title: proposal.title,
          dueAt: null,
          subject: {
            resource: subject.resource,
            id: subject.id,
            owner: 'host',
            label: subject.label,
          },
          source: { package: 'customer-data', action: SOURCE_ACTION },
        });
        if (replayed === true) tasksReplayed += 1;
        else tasksWritten += 1;
        return { taskId: task?.id ?? null, replayed: replayed ?? false };
      };

      let candidatesWritten = 0;
      for (const pair of pairs) {
        const written = await recordCandidatePairs({
          modules, names, policy,
          pairs: [{ left: pair.left, right: pair.right }],
          rule: pair.rule,
          evidence: pair.evidence,
          runId: CLEANUP_RUN_ID,
          actor,
        });
        candidatesWritten += written;
        const sourceKey = `duplicate:${subjectKey(pair.left)}|${subjectKey(pair.right)}`;
        const stored = (await deciding(trusted(modules, names.candidate), { sourceKey }))[0] ?? null;
        const mergeKey = `cleanup:merge:${subjectKey(pair.left)}:${subjectKey(pair.right)}`;
        const { taskId, replayed } = await openTask({
          subject: { resource: pair.left.resource, id: pair.left.id, label: pair.left.label },
          title: `Possibile doppione da unire: ${pair.left.label ?? pair.left.id} — ${pair.right.label ?? pair.right.id}`.slice(0, 200),
          sourceKey: mergeKey,
        });
        proposals.push({
          kind: 'merge',
          rule: pair.rule,
          subject: { resource: pair.left.resource, id: pair.left.id },
          title: `Possibile doppione da unire: ${pair.left.label ?? pair.left.id} — ${pair.right.label ?? pair.right.id}`.slice(0, 200),
          sourceKey: mergeKey,
          evidence: pair.evidence,
          candidateId: stored?.id ?? null,
          candidateReplayed: written === 0,
          taskId,
          taskReplayed: replayed,
        });
      }

      for (const completion of completions) {
        const sourceKey = `cleanup:${completion.kind}:${subjectKey(completion.subject)}`;
        const { taskId, replayed } = await openTask({ ...completion, sourceKey });
        proposals.push({ ...completion, sourceKey, candidateId: null, candidateReplayed: null, taskId, taskReplayed: replayed });
      }
      for (const step of nextSteps) {
        const sourceKey = `cleanup:next-step:${subjectKey(step.subject)}`;
        const { taskId, replayed } = await openTask({ ...step, sourceKey });
        proposals.push({ ...step, sourceKey, candidateId: null, candidateReplayed: null, taskId, taskReplayed: replayed });
      }

      return Object.freeze({
        operation: 'propose-data-cleanup',
        complete,
        scope: Object.freeze({ contacts: contacts.length, companies: companies.length }),
        counts: Object.freeze({
          subjects: subjects.length,
          duplicatePairs: pairs.length,
          candidatesWritten,
          tasksWritten,
          tasksReplayed,
        }),
        tasksUnavailable,
        identitiesAvailable,
        tasksReadable,
        proposals: Object.freeze(proposals.map((proposal) => Object.freeze({ ...proposal }))),
        limitations: CLEANUP_LIMITATIONS,
      });
    });

    return receipt;
  }

  return Object.freeze({ proposeDataCleanup });
}
