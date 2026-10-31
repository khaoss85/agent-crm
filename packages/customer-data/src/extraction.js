// @ts-check

import { createHash, randomUUID } from 'node:crypto';

import { AppError, ValidationError, normalizeActor } from '../../core/index.js';
import { CONTROL_RE, MAX_FIELD_LENGTH, safeString } from './normalize.js';
import { ENRICHABLE_FIELDS, canonicalPhone } from './enrichment.js';
import { canonicalClusterFor } from './profile.js';
import { isWinnerConflict, recordExternalIdentityRow } from './sender.js';
import { deciding, subjectFields, subjectKey, trusted } from './store.js';

/**
 * AI-assisted enrichment extraction (backlog:7837a4b1b3a9).
 *
 * The scheda's «Aggiorna» button asks the AI to extract contact attributes
 * from the customer's linked sources — Gmail signature blocks, channel
 * messages, the company website — and shows every proposed field with the
 * source that produced it, to accept or dismiss. This file is the
 * framework side of that flow; the pilot worker builds the adapter over
 * the space's OpenAI wiring and passes it in, like the Google import
 * passes its caller-built adapter.
 *
 * Governing shape, unchanged (ADR-037): the contact record is never
 * written — a manually entered value wins by construction. Extracted
 * fields land as `enriched-field` rows with status `proposed`, beside the
 * record. Accepting flips one row to `active`; dismissing flips it to
 * `dismissed` with the reason. A dismissal is final: re-running the same
 * extraction replays instead of resurrecting. `readCustomerEnrichment`
 * keeps reading `active` rows only, so a proposal never reads as a fact.
 *
 * No-AI discipline: without a caller-built adapter the extraction refuses
 * with ENRICHMENT_AI_UNAVAILABLE instead of running anything — the button
 * says so instead of doing nothing. Provider text never leaves the
 * package: an adapter failure becomes ENRICHMENT_EXTRACTION_FAILED with a
 * fixed message, never the provider's error.
 */

/** The linked sources an extraction may read. Caller-controlled strings are never provenance. */
export const EXTRACTION_SOURCE_KINDS = Object.freeze(['email-signature', 'channel-message', 'company-website']);
const MAX_SOURCES = 10;
const MAX_SOURCE_TEXT = 8000;
const MAX_DETAIL_LENGTH = 256;

function refusal(code, status, message) {
  return new AppError(message, { code, status });
}

function requireUser(actor, what) {
  const normalized = normalizeActor(actor);
  if (normalized.type !== 'user') {
    throw new AppError(`${what} requires a human user actor`, { code: 'HUMAN_APPROVAL_REQUIRED', status: 403 });
  }
  return normalized;
}

/**
 * Source text is a pasted block, like a signature: multi-line by nature.
 * Newlines, carriage returns and tabs separate lines; any other control
 * character refuses, and the value itself is never echoed back.
 */
function requireSourceText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required`, { field });
  }
  if (value.length > MAX_SOURCE_TEXT) {
    throw new ValidationError(`${field} must be at most ${MAX_SOURCE_TEXT} characters`, { field });
  }
  for (const line of value.split(/\r?\n/)) {
    if (CONTROL_RE.test(line.replaceAll('\t', ''))) {
      throw new ValidationError(`${field} must not contain control characters`, { field });
    }
  }
  return value;
}

function requireSubject(request) {
  const resource = request?.resource;
  const id = request?.id;
  if (typeof resource !== 'string' || resource === '' || typeof id !== 'string' || id === '') {
    throw new ValidationError('an enrichment extraction needs a subject resource and id', { field: 'id' });
  }
  return { resource, id };
}

function requireSources(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError('an enrichment extraction needs at least one linked source to read', { field: 'sources' });
  }
  if (value.length > MAX_SOURCES) {
    throw new ValidationError(`an enrichment extraction reads at most ${MAX_SOURCES} sources`, { field: 'sources' });
  }
  return value.map((source, index) => {
    const at = `sources[${index}]`;
    if (!source || typeof source !== 'object') {
      throw new ValidationError('an extraction source needs a kind and text', { field: at });
    }
    const kind = source.kind;
    if (typeof kind !== 'string' || !EXTRACTION_SOURCE_KINDS.includes(kind)) {
      throw new ValidationError(
        `an extraction source kind must be one of: ${EXTRACTION_SOURCE_KINDS.join(', ')}`, { field: `${at}.kind` });
    }
    const text = requireSourceText(source.text, `${at}.text`);
    const detail = source.detail === undefined || source.detail === null
      ? null
      : safeString(source.detail, `${at}.detail`, { max: MAX_DETAIL_LENGTH });
    return Object.freeze({ kind, text, detail });
  });
}

function requireAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || typeof adapter.extractFields !== 'function') {
    throw refusal('ENRICHMENT_AI_UNAVAILABLE', 503,
      'no AI extraction is active for this space: configure the extraction adapter before retrying «Aggiorna»');
  }
  return adapter;
}

/**
 * A uniqueness conflict means a concurrent extraction won the race: the
 * row this call was about to write is already stored. The caller re-reads
 * and replays the winner instead of surfacing a raw constraint — the same
 * discipline the sender resolution and the free-source writes use.
 */
function isUniqueConflict(error) {
  if (error instanceof Error) {
    if (error.message.includes('UNIQUE constraint failed')) return true;
    if (error.message.includes('duplicate key value violates unique constraint')) return true;
  }
  if (error !== null && typeof error === 'object') {
    const code = /** @type {any} */ (error).code;
    if (code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  }
  return false;
}

function proposalKey({ resource, id, field, source, value, detail }) {
  const digest = createHash('sha1').update(`${value}\n${detail ?? ''}`).digest('hex').slice(0, 12);
  return `aiex:${resource}:${id}:${field}:${source}:${digest}`;
}

function shapeProposal(row) {
  return Object.freeze({
    id: row.id,
    field: row.field,
    value: row.value,
    source: row.source,
    sourceDetail: row.sourceDetail ?? null,
    observedAt: row.observedAt,
  });
}

/**
 * Validate the whole adapter answer before anything is stored: one bad
 * field refuses the run with nothing written, never a partial proposal
 * set. Sources must name one of the linked sources this run actually
 * read — the adapter cannot invent provenance.
 */
function requireProposals(answer, kinds) {
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.fields)) {
    throw refusal('ENRICHMENT_EXTRACTION_INVALID', 502,
      'the AI extraction returned no usable fields: nothing was stored');
  }
  return answer.fields.map((item, index) => {
    const at = `fields[${index}]`;
    if (!item || typeof item !== 'object') {
      throw refusal('ENRICHMENT_EXTRACTION_INVALID', 502,
        'the AI extraction returned no usable fields: nothing was stored');
    }
    if (typeof item.field !== 'string' || !ENRICHABLE_FIELDS.includes(item.field)) {
      throw refusal('ENRICHMENT_EXTRACTION_INVALID', 502,
        'the AI extraction named a field enrichment never fills: nothing was stored');
    }
    let value;
    try {
      value = safeString(item.value, `${at}.value`, { max: MAX_FIELD_LENGTH, required: true });
    } catch {
      throw refusal('ENRICHMENT_EXTRACTION_INVALID', 502,
        'the AI extraction returned no usable fields: nothing was stored');
    }
    if (item.field === 'phone') {
      // The free-source discipline: a phone-bearing identity IS a phone
      // number only when it dials. An undialable AI guess is refused with
      // the whole run, never stored as a proposal a human could accept.
      const dialable = canonicalPhone(value);
      if (!dialable) {
        throw refusal('ENRICHMENT_EXTRACTION_INVALID', 502,
          'the AI extraction returned no usable fields: nothing was stored');
      }
      value = dialable;
    }
    if (typeof item.source !== 'string' || !kinds.includes(item.source)) {
      throw refusal('ENRICHMENT_EXTRACTION_INVALID', 502,
        'the AI extraction cited a source this run never read: nothing was stored');
    }
    let sourceDetail = null;
    try {
      sourceDetail = item.sourceDetail === undefined || item.sourceDetail === null
        ? null
        : safeString(item.sourceDetail, `${at}.sourceDetail`, { max: MAX_DETAIL_LENGTH });
    } catch {
      throw refusal('ENRICHMENT_EXTRACTION_INVALID', 502,
        'the AI extraction returned no usable fields: nothing was stored');
    }
    return Object.freeze({ field: item.field, value, source: item.source, sourceDetail });
  });
}

/** @param {any} runtime */
export function createEnrichmentExtraction({ database, modules, events, names }) {
  if (!database || !modules || !events) {
    throw new ValidationError('enrichment extraction needs database, modules and events');
  }
  const enrichedName = names?.enriched ?? 'enriched-field';
  const optOutName = names?.optOut ?? 'enrichment-opt-out';

  async function optOutRow(resource, id) {
    const rows = await deciding(trusted(modules, optOutName), {
      subjectResource: resource, subjectId: id,
    });
    return rows[0] ?? null;
  }

  /**
   * The opt-out check for a named subject covers its whole canonical
   * cluster: enriched facts already read cluster-wide, so a member
   * contact's refusal must block an extraction (or an accept) named for
   * the company too — and a company subject carries no opt-out row of its
   * own. Only contact members can hold a refusal.
   */
  async function optedOutAnywhere(resource, id) {
    const cluster = await canonicalClusterFor({ modules, names, subject: { resource, id } });
    for (const member of cluster.members) {
      if (member.resource !== 'contact') continue;
      if (await optOutRow(member.resource, member.id)) return true;
    }
    return false;
  }

  /**
   * Run one AI extraction over the customer's linked sources. The adapter
   * call happens outside any transaction; the validated proposals land
   * together inside one, so a crash stores all of them or none.
   */
  async function extractCustomerEnrichment(request) {
    const actor = normalizeActor(request?.actor);
    const { resource, id } = requireSubject(request);
    const sources = requireSources(request?.sources);
    const adapter = requireAdapter(request?.adapter);

    if (await optedOutAnywhere(resource, id)) {
      throw refusal('ENRICHMENT_OPTED_OUT', 409,
        'this subject opted out of enrichment: no extraction runs and nothing is stored');
    }

    const kinds = sources.map((source) => source.kind);
    let answer;
    try {
      answer = await adapter.extractFields({
        subject: Object.freeze({ resource, id }),
        sources,
      });
    } catch {
      throw refusal('ENRICHMENT_EXTRACTION_FAILED', 502,
        'the AI extraction failed before storing anything: retry «Aggiorna» later');
    }
    const proposals = requireProposals(answer, kinds);

    const runId = randomUUID();
    const now = new Date().toISOString();
    const enriched = trusted(modules, enrichedName);
    const stored = await database.transactionAsync(async () => {
      // The opt-out is re-checked inside the write transaction, cluster-wide:
      // an opt-out that committed while the adapter was thinking refuses
      // here, so no fresh proposal lands after a purge.
      if (await optedOutAnywhere(resource, id)) {
        throw refusal('ENRICHMENT_OPTED_OUT', 409,
          'this subject opted out of enrichment: no extraction runs and nothing is stored');
      }
      const landed = [];
      for (const proposal of proposals) {
        const sourceKey = proposalKey({
          resource, id, field: proposal.field, source: proposal.source,
          value: proposal.value, detail: proposal.sourceDetail,
        });
        const existing = await deciding(enriched, { sourceKey });
        if (existing[0]) {
          // Deterministic replay: the same extraction retried returns the
          // stored row instead of duplicating it — and a dismissed row
          // stays dismissed, never resurrected as a proposal.
          landed.push({ row: existing[0], replayed: existing[0].status === 'proposed' });
          continue;
        }
        let row;
        try {
          row = await enriched.createManaged({
            sourceKey,
            ...subjectFields({ resource, id, owner: 'host', ownerPackage: null, label: null }),
            field: proposal.field,
            value: proposal.value,
            source: proposal.source,
            sourceDetail: proposal.sourceDetail,
            observedAt: now,
            observedByRunId: runId,
            status: 'proposed',
            purgedAt: null,
            purgeReason: null,
            decisionReason: null,
          }, { actor });
        } catch (error) {
          // A concurrent extraction committed the same row after the
          // re-check above: replay the winner instead of throwing its
          // constraint — unless the winner is decided, which stays put.
          if (!isUniqueConflict(error)) throw error;
          const winner = await deciding(enriched, { sourceKey });
          if (!winner[0]) throw error;
          landed.push({ row: winner[0], replayed: winner[0].status === 'proposed' });
          continue;
        }
        landed.push({ row, replayed: false });
      }
      return landed;
    });

    // Only undecided rows are proposals: an already-active row is a fact
    // the facts read shows, and a dismissed row stays recorded but unlisted.
    const listed = stored.filter(({ row }) => row.status === 'proposed').map(({ row }) => shapeProposal(row));
    const counts = {
      proposed: stored.filter(({ row, replayed }) => !replayed && row.status === 'proposed').length,
      replayed: stored.filter(({ replayed }) => replayed).length,
      alreadyActive: stored.filter(({ row, replayed }) => !replayed && row.status === 'active').length,
      skippedDismissed: stored.filter(({ row, replayed }) => !replayed && row.status === 'dismissed').length,
    };
    return Object.freeze({
      status: 'done',
      subject: Object.freeze({ resource, id }),
      runId,
      counts: Object.freeze(counts),
      proposals: Object.freeze(listed),
    });
  }

  /**
   * The pending proposals of one subject — what «Aggiorna» shows beside
   * the facts. Proposed rows only: facts keep reading through
   * `readCustomerEnrichment`, never from here. Cluster-wide like the
   * facts read: a proposal extracted for a member contact shows on the
   * company scheda too.
   */
  async function readCustomerEnrichmentProposals(request) {
    const { resource, id } = requireSubject(request);
    // Cluster privacy at read time: when any member opted out, no proposal
    // of the cluster is listed — the rows of other members stay stored
    // (the opt-out purges only the named contact), but the opted-out
    // scheda shows none of them.
    if (await optedOutAnywhere(resource, id)) {
      return Object.freeze({
        subject: Object.freeze({ resource, id }),
        proposals: Object.freeze([]),
      });
    }
    const cluster = await canonicalClusterFor({ modules, names, subject: { resource, id } });
    const memberIndex = new Map(cluster.members.map((member, index) => [subjectKey(member), index]));
    const fieldOrder = new Map(ENRICHABLE_FIELDS.map((field, index) => [field, index]));
    const enriched = trusted(modules, enrichedName);
    const collected = [];
    for (const member of cluster.members) {
      const rows = await deciding(enriched, {
        subjectResource: member.resource, subjectId: member.id, status: 'proposed',
      });
      for (const row of rows) collected.push(row);
    }
    collected.sort((a, b) => (
      (memberIndex.get(subjectKey({ resource: a.subjectResource, id: a.subjectId })) ?? 0)
        - (memberIndex.get(subjectKey({ resource: b.subjectResource, id: b.subjectId })) ?? 0)
      || (fieldOrder.get(a.field) ?? ENRICHABLE_FIELDS.length) - (fieldOrder.get(b.field) ?? ENRICHABLE_FIELDS.length)
      || String(a.source).localeCompare(String(b.source))
    ));
    return Object.freeze({
      subject: Object.freeze({ resource, id }),
      proposals: Object.freeze(collected.map(shapeProposal)),
    });
  }

  /**
   * A human accepts or dismisses one proposal. The decision is a status
   * flip on the same row with the reason beside it — the choice stays
   * registered, and deciding twice answers the stored decision instead
   * of moving the row again.
   */
  async function decideEnrichmentProposal(request) {
    const actor = requireUser(request?.actor, 'Deciding an enrichment proposal');
    const id = safeString(request?.id, 'id', { required: true });
    const decision = request?.decision;
    if (decision !== 'accepted' && decision !== 'dismissed') {
      throw new ValidationError('a proposal decision is "accepted" or "dismissed"', { field: 'decision' });
    }
    const reason = request?.reason === undefined || request?.reason === null
      ? null
      : safeString(request.reason, 'reason', { max: MAX_DETAIL_LENGTH });

    const enriched = trusted(modules, enrichedName);
    if (decision === 'accepted') {
      const identityName = names?.identity ?? 'external-identity';
      const holderOf = (row) => row !== null && typeof row === 'object'
        ? { resource: row.subjectResource, id: row.subjectId } : null;
      const outcome = await database.transactionAsync(async () => {
        // The row is re-read inside the write transaction: a concurrent
        // purge or dismissal that committed after the operator opened the
        // scheda always wins — only a still-proposed row flips to active.
        const current = await enriched.get(id);
        if (current.status !== 'proposed') {
          return { outcome: 'already-decided', proposal: shapeProposal(current) };
        }
        if (await optedOutAnywhere(current.subjectResource, current.subjectId)) {
          throw refusal('ENRICHMENT_OPTED_OUT', 409,
            'this subject opted out of enrichment: no proposal is accepted after the purge');
        }
        const refuseHeldPhone = (holder) => {
          if (holder === null || holder.resource !== current.subjectResource || holder.id !== current.subjectId) {
            throw refusal('PHONE_ALREADY_HELD', 409,
              'this phone number is already held beside another customer: it stays on the first card');
          }
        };
        if (current.field === 'phone' && current.value) {
          // The recordSubjectPhone discipline: one number names one record,
          // once. The shared identity helper refreshes any sighting, so the
          // holder is read by sourceKey before the flip — a foreign holder
          // refuses 409 and nothing flips.
          const seen = (await deciding(trusted(modules, identityName),
            { sourceKey: `phone:${current.value}` }))[0] ?? null;
          if (seen !== null) refuseHeldPhone(holderOf(seen));
        }
        const decided = await enriched.applyManaged(id, {
          status: 'active', decisionReason: reason,
        }, { actor });
        if (decided.field === 'phone' && decided.value) {
          // The free-source discipline: an accepted phone becomes a
          // phone-bearing external identity, so sender resolution and the
          // facts read see it exactly like a free-source phone.
          const sourceKey = `phone:${decided.value}`;
          try {
            await recordExternalIdentityRow({
              modules, names, system: 'phone', externalId: decided.value,
              subject: {
                resource: decided.subjectResource, id: decided.subjectId,
                owner: decided.subjectOwner ?? 'host',
                ownerPackage: decided.subjectOwnerPackage ?? null,
                label: decided.subjectLabel ?? null,
              },
              runId: decided.observedByRunId ?? 'enrichment:decide',
              actor,
            });
          } catch (error) {
            if (!isWinnerConflict(error)) throw error;
            const winner = (await deciding(trusted(modules, identityName), { sourceKey }))[0] ?? null;
            refuseHeldPhone(holderOf(winner));
          }
          // The helper refreshes any sighting, so the holder is re-read
          // inside the same transaction: a concurrent foreign hold refuses
          // 409 and rolls the flip back with it — no sighting is bumped.
          const linked = (await deciding(trusted(modules, identityName), { sourceKey }))[0] ?? null;
          refuseHeldPhone(holderOf(linked));
        }
        return { outcome: 'accepted', proposal: shapeProposal(decided) };
      });
      return Object.freeze(outcome);
    }
    const outcome = await database.transactionAsync(async () => {
      // A dismissal is final: a concurrent accept or purge that committed
      // first wins, and this call answers the stored decision instead of
      // moving the row again.
      const current = await enriched.get(id);
      if (current.status !== 'proposed') {
        return { outcome: 'already-decided', proposal: shapeProposal(current) };
      }
      const row = await enriched.applyManaged(id, {
        status: 'dismissed', decisionReason: reason,
      }, { actor });
      return { outcome: 'dismissed', proposal: shapeProposal(row) };
    });
    return Object.freeze(outcome);
  }

  return {
    extractCustomerEnrichment,
    readCustomerEnrichmentProposals,
    decideEnrichmentProposal,
  };
}
