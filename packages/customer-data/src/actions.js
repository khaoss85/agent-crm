// @ts-check

import { AppError, ValidationError } from '../../core/index.js';
import { safeString } from './normalize.js';
import { deciding, orderedPair, resolvedNames, subjectFields, subjectKey, subjectOf, trusted } from './store.js';

/**
 * **The human decisions — the only writes in this package a person makes.**
 *
 * Three actions, all human-only. Canonical identity is the one that matters
 * most, and its semantics are stated in the code as plainly as in the docs:
 *
 * > **A canonical link is a LOGICAL canonical merge, not a deletion.** Every
 * > record in the cluster still exists, still resolves, and keeps every
 * > reference pointing at it. No field of any other package is rewritten and
 * > no cascade runs. Physical consolidation is deliberately future work.
 *
 * A decision writes a `canonical-link` row per member in one transaction:
 * either every member is linked or none is, so a cluster can never be half
 * decided. The refusals are stable codes, and the actor is audited.
 */

const MAX_REASON = 300;

/** Every human decision here requires a real person. */
function requireUser(actor, what) {
  if (!actor || typeof actor !== 'object' || /** @type {any} */ (actor).type !== 'user') {
    throw new AppError(`${what} requires a human user actor`, { code: 'HUMAN_APPROVAL_REQUIRED', status: 403 });
  }
  return actor;
}

/** @param {Record<string, string>} [config] */
export function buildCustomerDataActions(config) {
  const names = resolvedNames(config);

  return [
    /**
     * Link a duplicate candidate into one canonical identity cluster.
     */
    {
      module: names.candidate,
      name: 'link-canonical-identity',
      label: 'Link as one customer',
      description:
        'Record the human decision that these records are one customer. This is a LOGICAL canonical merge: every record '
        + 'survives, every reference keeps resolving, and nothing is deleted, rewritten or cascaded.',
      actionContract: 1,
      stateField: 'status',
      fromStates: ['unresolved'],
      confirm: true,
      input: [
        { name: 'canonicalResource', type: 'string', required: true, hint: 'Which side is canonical: the resource name, e.g. "company".' },
        { name: 'canonicalId', type: 'string', required: true, hint: 'The id of the record that becomes canonical.' },
        { name: 'reason', type: 'string', required: true, hint: 'Why these records are the same customer. Recorded with your identity.' },
      ],
      /** @param {any} ctx */
      async execute({ record: candidate, input, actor, modules, managed, now, step }) {
        requireUser(actor, 'Deciding canonical identity');
        const reason = safeString(input.reason, 'reason', { max: MAX_REASON, required: true });

        const left = subjectOf(candidate, 'left');
        const right = subjectOf(candidate, 'right');
        const canonicalResource = safeString(input.canonicalResource, 'canonicalResource', { required: true });
        const canonicalId = safeString(input.canonicalId, 'canonicalId', { required: true });
        const wanted = `${canonicalResource}:${canonicalId}`;
        if (wanted !== subjectKey(left) && wanted !== subjectKey(right)) {
          throw new ValidationError(
            'the canonical record must be one of the two records in this candidate',
            { field: 'canonicalId' },
          );
        }
        const canonical = wanted === subjectKey(left) ? left : right;
        const alias = wanted === subjectKey(left) ? right : left;

        const links = trusted(modules, names.link);
        // A record already inside a cluster cannot be silently re-parented:
        // that would rewrite a previous human decision without a decision.
        // The read is a COMPLETE one, not a page: a guard that stops firing
        // once the table outgrows a display bound is not a guard.
        for (const member of [canonical, alias]) {
          const existing = (await deciding(links, {
            subjectResource: member.resource, subjectId: member.id, status: 'active',
          }))[0];
          if (existing) {
            throw new AppError(
              'one of these records already belongs to a canonical identity cluster, so this decision would silently rewrite an earlier one',
              {
                code: 'ALREADY_IN_CANONICAL_CLUSTER', status: 409,
                details: Object.freeze({ subject: member, clusterKey: existing.clusterKey }),
              },
            );
          }
        }

        const decisionId = `decision:${candidate.id}`;
        const clusterKey = `cluster:${subjectKey(canonical)}`;
        const decidedAt = now();
        const actorId = String(/** @type {any} */ (actor).id ?? 'unknown');

        // One transaction's worth of writes: both members, or neither.
        for (const [member, role] of [[canonical, 'canonical'], [alias, 'alias']]) {
          const patch = {
            sourceKey: `canonical-link:${clusterKey}:${subjectKey(member)}`,
            clusterKey,
            ...subjectFields(member),
            role,
            decisionId,
            reason,
            decidedByType: 'user',
            decidedById: actorId,
            decidedAt,
            status: 'active',
            withdrawnReason: null,
            withdrawnAt: null,
          };
          // Undoing a merge withdraws the rows but keeps their sourceKey
          // occupied (unlink never deletes). Relinking the same pair with the
          // same canonical derives the same sourceKey, so a blind create
          // would collide on the UNIQUE left behind by the withdrawn
          // generation. Reactivate that history instead, with the new
          // decision stamped on it.
          const prior = (await deciding(links, { sourceKey: patch.sourceKey }))[0];
          if (prior) {
            await links.applyManaged(prior.id, patch, { actor });
          } else {
            await links.createManaged(patch, { actor });
          }
        }

        const updated = await managed(candidate.id, {
          status: 'linked',
          decisionId,
          decidedReason: reason,
          decidedByType: 'user',
          decidedById: actorId,
          decidedAt,
        });

        step('customer-data.canonical-identity-linked', {
          candidateId: candidate.id, clusterKey, canonical: subjectKey(canonical), alias: subjectKey(alias),
        });

        return {
          candidate: { id: updated.id, status: updated.status },
          clusterKey,
          decisionId,
          canonical,
          alias,
          semantics: 'logical canonical merge — both records still exist, both still resolve, nothing was deleted or rewritten',
        };
      },
    },

    /**
     * Dismiss a candidate: these are genuinely different customers.
     */
    {
      module: names.candidate,
      name: 'dismiss-duplicate-candidate',
      label: 'Not the same customer',
      description: 'Record the human decision that these records are different customers. Nothing is linked and nothing is deleted.',
      actionContract: 1,
      stateField: 'status',
      fromStates: ['unresolved'],
      confirm: true,
      input: [{ name: 'reason', type: 'string', required: true, hint: 'Why these are different customers.' }],
      /** @param {any} ctx */
      async execute({ record: candidate, input, actor, managed, now, step }) {
        requireUser(actor, 'Dismissing a duplicate candidate');
        const reason = safeString(input.reason, 'reason', { max: MAX_REASON, required: true });
        const updated = await managed(candidate.id, {
          status: 'dismissed',
          decidedReason: reason,
          decidedByType: 'user',
          decidedById: String(/** @type {any} */ (actor).id ?? 'unknown'),
          decidedAt: now(),
        });
        step('customer-data.duplicate-candidate-dismissed', { candidateId: candidate.id });
        return { candidate: { id: updated.id, status: updated.status }, reason };
      },
    },

    /**
     * Undo a wrong merge: separate the cluster this candidate created.
     *
     * A merge is logical, so undoing it withdraws the `canonical-link` rows
     * instead of deleting anything: every record survives, every message
     * stays where it was written, and the two schede read separate again
     * because the profile only aggregates `active` links. The candidate
     * returns to `unresolved` with its decision cleared, so a human can
     * decide again. Human-only, with confirmation like every merge.
     */
    {
      module: names.candidate,
      name: 'unlink-canonical-identity',
      label: 'Separate wrongly merged customers',
      description:
        'Undo a wrong merge from the scheda: withdraw the canonical-link rows this candidate created so every message reads under the right person again and the two cards read separate. Nothing is deleted; the candidate returns to unresolved for a new decision.',
      actionContract: 1,
      stateField: 'status',
      fromStates: ['linked'],
      confirm: true,
      input: [{ name: 'reason', type: 'string', required: true, hint: 'Why this merge was wrong.' }],
      /** @param {any} ctx */
      async execute({ record: candidate, input, actor, modules, managed, now, step }) {
        requireUser(actor, 'Undoing a canonical merge');
        const reason = safeString(input.reason, 'reason', { max: MAX_REASON, required: true });
        const decisionId = typeof candidate.decisionId === 'string' && candidate.decisionId !== ''
          ? candidate.decisionId
          : `decision:${candidate.id}`;
        const links = trusted(modules, names.link);
        const active = await deciding(links, { decisionId, status: 'active' });
        if (active.length === 0) {
          throw new AppError(
            'this merge has no active canonical links to withdraw, so there is nothing to separate',
            { code: 'CANONICAL_CLUSTER_NOT_FOUND', status: 409, details: Object.freeze({ candidateId: candidate.id }) },
          );
        }
        const withdrawnAt = now();
        const actorId = String(/** @type {any} */ (actor).id ?? 'unknown');
        for (const row of active) {
          await links.applyManaged(row.id, {
            status: 'withdrawn',
            withdrawnReason: reason,
            withdrawnAt,
          }, { actor });
        }
        const updated = await managed(candidate.id, {
          status: 'unresolved',
          decisionId: null,
          decidedReason: null,
          decidedByType: null,
          decidedById: null,
          decidedAt: null,
        });
        step('customer-data.canonical-identity-unlinked', {
          candidateId: candidate.id, decisionId, withdrawn: active.length,
        });
        return {
          candidate: { id: updated.id, status: updated.status },
          withdrawn: active.length,
          decidedById: actorId,
          semantics: 'unmerged — the links are withdrawn, both records still exist, each card reads its own again',
        };
      },
    },

    /**
     * Govern a data-quality issue. Resolution never erases the finding.
     */
    {
      module: names.issue,
      name: 'govern-data-quality-issue',
      label: 'Resolve or dismiss',
      description:
        'Record a human decision about a data-quality finding. The finding itself is kept: resolving it changes its status '
        + 'and records who decided and why, and erases nothing.',
      actionContract: 1,
      stateField: 'status',
      fromStates: ['open'],
      confirm: true,
      input: [
        { name: 'decision', type: 'enum', required: true, values: ['resolved', 'dismissed'], hint: 'resolved = the underlying data was fixed; dismissed = this is acceptable as it stands.' },
        { name: 'reason', type: 'string', required: true, hint: 'Why. Recorded with your identity.' },
      ],
      /** @param {any} ctx */
      async execute({ record: issue, input, actor, managed, now, step }) {
        requireUser(actor, 'Governing a data-quality issue');
        const reason = safeString(input.reason, 'reason', { max: MAX_REASON, required: true });
        if (input.decision !== 'resolved' && input.decision !== 'dismissed') {
          throw new ValidationError('decision must be "resolved" or "dismissed"', { field: 'decision' });
        }
        const updated = await managed(issue.id, {
          status: input.decision,
          resolutionReason: reason,
          decidedByType: 'user',
          decidedById: String(/** @type {any} */ (actor).id ?? 'unknown'),
          decidedAt: now(),
        });
        step('customer-data.issue-governed', { issueId: issue.id, decision: input.decision });
        return {
          issue: { id: updated.id, kind: updated.kind, status: updated.status },
          reason,
          retained: 'the finding and its evidence are kept; governing an issue never erases it',
        };
      },
    },
  ];
}

export { orderedPair };
