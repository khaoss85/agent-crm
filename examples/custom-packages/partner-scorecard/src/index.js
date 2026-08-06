// @ts-check

import { AppError, ValidationError, definePackage, requiredString } from '../../../../packages/core/index.js';

/**
 * **A customer-authored domain package** — the conformance example for
 * `docs/PACKAGE_AUTHORING.md`.
 *
 * It is deliberately small and deliberately *not* a first-party domain: it
 * exists to prove that an agent can add a bounded domain to a customer's own
 * repository without touching the kernel, without deep-importing kernel
 * internals, and through exactly the registration path the first-party
 * packages use.
 *
 * What it models: a delivery partner's scorecard. A human records how a
 * partner performed on an engagement, with a bounded score and a reason. One
 * resource, one action, one versioned policy — the smallest thing that is
 * still honestly a package rather than a module.
 *
 * What it proves:
 *   - package identity, version and contract version;
 *   - a package-owned resource applied through the ordinary module factory;
 *   - a package-owned action on the generic action runtime;
 *   - a versioned, fingerprinted policy;
 *   - function-free schema metadata;
 *   - public kernel imports only (`packages/core/index.js`);
 *   - static registration in `packages/domains/generated/index.js`;
 *   - removal by deleting that one import, with the app still booting.
 */

export const PARTNER_SCORECARD_PACKAGE = 'partner-scorecard';
export const SCORING_POLICY_KIND = 'partner-rating-policy';
export const PARTNER_SCORECARD_RESOURCES = Object.freeze(['partner-scorecard']);

const MAX_REASON = 300;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * The versioned rating policy: bands are declared config, so they live inside
 * the definition fingerprint and cannot drift without publishing a version.
 */
export const standardPartnerRatingV1 = {
  name: 'standard-partner-rating',
  version: 1,
  label: 'Standard partner rating',
  config: { bands: [{ min: 90, rating: 'preferred' }, { min: 70, rating: 'approved' }, { min: 0, rating: 'watch' }] },
  /** @param {{score: number, config: any}} context */
  rate({ score, config }) {
    const band = config.bands.find((entry) => score >= entry.min);
    return { rating: band ? band.rating : 'watch' };
  },
};

/** @param {{policies?: any[], modules?: Record<string, string>}} [options] */
export function createPartnerScorecardPackage(options = {}) {
  const policies = (options.policies ?? [standardPartnerRatingV1]).map((definition) => ({
    kind: SCORING_POLICY_KIND,
    definition,
  }));

  return definePackage({
    packageContract: 1,
    name: PARTNER_SCORECARD_PACKAGE,
    version: 1,
    label: 'Partner scorecard',
    description: 'A customer-authored example package: records a human rating of a delivery partner after an engagement.',
    resources: [...PARTNER_SCORECARD_RESOURCES],
    actions: [buildRatePartnerAction(options.modules)],
    policies,
    metadata() {
      return {
        scorecardContract: 1,
        ratings: ['preferred', 'approved', 'watch'],
        note: 'An authoring/conformance example, not a first-party product workstream. A rating is internal opinion: it grants nothing, changes nothing commercially, and is never shown to the partner.',
        notModeled: ['partner access', 'partner portal', 'automatic rating', 'fee or revenue share', 'SLA'],
      };
    },
  });
}

/**
 * `delivery-partner-engagement.rate-partner` — a human records the score.
 *
 * A package action is an ordinary action definition: the same runtime, the
 * same transaction, the same audit, events and trace. Nothing here is special
 * because the package is customer-authored.
 */
export function buildRatePartnerAction(config = {}) {
  const engagementModule = config.engagementModule ?? 'delivery-partner-engagement';
  const scorecardModule = config.scorecardModule ?? 'partner-scorecard';
  return {
    module: engagementModule,
    name: 'rate-partner',
    label: 'Rate partner',
    description: 'Record a human rating of this delivery partner (0-100) with a reason.',
    actionContract: 1,
    input: [
      { name: 'policy', type: 'string', required: true, hint: 'Registered partner rating policy name.' },
      { name: 'policyVersion', type: 'integer', required: true, hint: 'Explicit policy version.' },
      { name: 'score', type: 'integer', required: true, hint: 'Whole number 0-100.' },
      { name: 'reason', type: 'string', required: true, hint: 'Why this score — a rating without a reason is an opinion nobody can check.' },
    ],
    /** @param {any} ctx */
    async execute({ record: engagement, input, actor, modules, domains, now }) {
      if (!actor || typeof actor !== 'object' || /** @type {any} */ (actor).type !== 'user') {
        throw new AppError('Rating a partner requires a human user actor', { code: 'HUMAN_APPROVAL_REQUIRED', status: 403 });
      }
      const { definition: policy, fingerprint } = domains.getPolicy(
        PARTNER_SCORECARD_PACKAGE, SCORING_POLICY_KIND, input.policy, input.policyVersion,
      );
      const score = input.score;
      if (!Number.isSafeInteger(score) || score < 0 || score > 100) {
        throw new ValidationError('score must be a whole number between 0 and 100', { field: 'score' });
      }
      const reason = requiredString(input.reason, 'reason');
      if (reason.length > MAX_REASON || CONTROL_RE.test(reason)) {
        throw new ValidationError(`reason must be at most ${MAX_REASON} characters and free of control characters`, { field: 'reason' });
      }
      const { rating } = policy.rate({ score, config: structuredClone(policy.config) });

      const scorecards = modules.get(scorecardModule).service;
      const existing = scorecards.listWhere({ engagementId: engagement.id })[0];
      if (existing) {
        throw new AppError('This engagement is already rated', {
          code: 'ALREADY_RATED', status: 409, details: { scorecardId: existing.id },
        });
      }
      const scorecard = await scorecards.createManaged(
        {
          sourceKey: `partner-scorecard:${engagement.id}`,
          engagementId: engagement.id,
          deliveryProjectId: engagement.deliveryProjectId,
          partnerRef: engagement.partnerRef,
          partnerNameSnapshot: engagement.partnerNameSnapshot,
          score,
          rating,
          reason,
          policy: policy.name,
          policyVersion: policy.version,
          policyFingerprint: fingerprint,
          ratedBy: String(/** @type {any} */ (actor).id ?? 'unknown'),
          ratedAt: now(),
        },
        { actor },
      );
      return { scorecard: { id: scorecard.id, score, rating } };
    },
  };
}
