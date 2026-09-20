// @ts-check

import { AppError } from '../../core/index.js';
import { reviewProposal, approveProposal } from './proposal.js';
import { buildObservationActions } from './observations.js';

/**
 * The `campaign-proposal` record actions (MK1): plan-then-approve as a
 * human-actor boundary.
 *
 * `propose` is the plan step: read-only in spirit — it records nothing except
 * the review outcome on the proposal itself. A complete draft becomes
 * `proposed`; an incomplete one becomes `refused` with the named missing
 * sections, and the refusal is the answer, not an error. Either way the human
 * sees exactly what the policy version decided.
 *
 * `approve` is the human step. It requires a user actor, a `proposed`
 * proposal, and a draft that still states every section — recomputed here,
 * inside the transaction, from the stored record. It creates the immutable
 * campaign version and stamps the proposal approved. Everything commits or
 * nothing does. Nothing is sent, published or spent by either action, and no
 * code path here can reach a provider: there is no provider handle to reach
 * for.
 */

/** @param {Record<string, string>} [config] module renames */
function resolvedNames(config = {}) {
  return {
    proposal: config?.proposalModule ?? 'campaign-proposal',
    version: config?.versionModule ?? 'campaign-version',
  };
}

/** Trusted read-only managed storage handle; a CRUD-writable module is refused. */
function trusted(modules, name) {
  const service = modules.get(name)?.service;
  if (!service || typeof service.createManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a read-only managed record module — regenerate it from the current manifest`, {
      code: 'MARKETING_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

/**
 * `campaign-proposal.propose` — review the draft under an explicit policy
 * version. Complete becomes `proposed`; incomplete becomes `refused` with the
 * missing sections stored on the record. Never an error for content: the
 * refusal IS the outcome MK1 acceptance requires.
 *
 * @param {any} registries the package's MarketingRegistries instance
 * @param {Record<string, string>} [config] module renames
 */
export function buildProposeAction(registries, config) {
  const names = resolvedNames(config);
  return {
    module: names.proposal,
    name: 'propose',
    label: 'Propose campaign',
    description: 'Review this draft under the named proposal policy version. A complete draft becomes proposed; an incomplete one is refused with its missing sections.',
    actionContract: 1,
    input: [
      { name: 'policy', type: 'string', required: true, hint: 'Registered proposal policy name.' },
      { name: 'policyVersion', type: 'integer', required: true, hint: 'Explicit policy version — never an implicit latest.' },
    ],
    /** @param {any} ctx */
    async execute({ record: proposal, input, modules, domains, managed, now, step }) {
      if (proposal.status === 'approved') {
        throw new AppError('An approved proposal is terminal; prepare a new proposal for a change', { code: 'PROPOSAL_STATE_INVALID', status: 409 });
      }
      const { definition: policy, fingerprint } = domains.getPolicy('marketing', 'proposal-policy', input.policy, input.policyVersion);
      const review = reviewProposal(proposal, {
        allowedChannels: policy.config?.allowedChannels,
        allowedModes: policy.config?.allowedModes,
      });
      const at = now();
      if (!review.complete) {
        await managed(proposal.id, {
          status: 'refused',
          refusalReasonsJson: JSON.stringify(review.missing),
          policyName: policy.name,
          policyVersion: policy.version,
          policyFingerprint: fingerprint,
          decidedAt: at,
        });
        step('proposal.refused', { proposalId: proposal.id, missing: review.missing });
        return {
          refused: true,
          missing: [...review.missing],
          policy: { name: policy.name, version: policy.version, fingerprint },
        };
      }
      await managed(proposal.id, {
        status: 'proposed',
        refusalReasonsJson: null,
        proposedAt: at,
        policyName: policy.name,
        policyVersion: policy.version,
        policyFingerprint: fingerprint,
      });
      step('proposal.proposed', { proposalId: proposal.id });
      return {
        refused: false,
        missing: [],
        policy: { name: policy.name, version: policy.version, fingerprint },
      };
    },
  };
}

/**
 * `campaign-proposal.approve` — the human-approved transition. An agent may
 * prepare the draft and the review; it may not commit the campaign.
 *
 * @param {any} registries the package's MarketingRegistries instance (kept for symmetry with propose; the policy identity travels on the record)
 * @param {Record<string, string>} [config] module renames
 */
export function buildApproveAction(registries, config) {
  void registries;
  const names = resolvedNames(config);
  return {
    module: names.proposal,
    name: 'approve',
    label: 'Approve campaign',
    description: 'Approve this proposed campaign as a human user. Creates the immutable campaign version. Sends, publishes and spends nothing.',
    actionContract: 1,
    confirm: true,
    input: [
      { name: 'policy', type: 'string', required: true, hint: 'Registered proposal policy name — must match the review the proposal was proposed under.' },
      { name: 'policyVersion', type: 'integer', required: true, hint: 'Explicit policy version.' },
    ],
    /** @param {any} ctx */
    async execute({ record: proposal, input, actor, modules, domains, managed, now, step }) {
      // Approving a campaign is a human decision. An agent may prepare the
      // draft and the review; it may not commit the campaign.
      if (!actor || typeof actor !== 'object' || actor.type !== 'user') {
        throw new AppError('Approving a campaign proposal requires a human user actor', {
          code: 'HUMAN_APPROVAL_REQUIRED', status: 403,
        });
      }
      const { definition: policy, fingerprint } = domains.getPolicy('marketing', 'proposal-policy', input.policy, input.policyVersion);
      if (proposal.policyName !== policy.name || proposal.policyVersion !== policy.version
        || proposal.policyFingerprint !== fingerprint) {
        throw new AppError('This proposal was reviewed under a different policy version; re-propose it before approving', {
          code: 'PROPOSAL_POLICY_CHANGED', status: 409,
          details: {
            reviewed: { name: proposal.policyName ?? null, version: proposal.policyVersion ?? null },
            requested: { name: policy.name, version: policy.version },
          },
        });
      }
      const versions = trusted(modules, names.version);
      // Approval is terminal: later campaigns use a new proposal, never an
      // increment computed from a potentially bounded collection read.
      const versionNumber = 1;
      const at = now();
      const { version, proposalPatch } = approveProposal({
        proposal,
        actor,
        approvedAt: at,
        policy: { name: policy.name, version: policy.version, fingerprint },
        versionNumber,
        constraints: policy.config,
      });
      const created = await versions.createManaged({ ...version }, { actor });
      await managed(proposal.id, {
        ...proposalPatch,
        currentVersionId: created.id,
      });
      step('proposal.approved', { proposalId: proposal.id, versionId: created.id, versionNumber });
      return {
        versionId: created.id,
        versionNumber,
        policy: { name: policy.name, version: policy.version, fingerprint },
      };
    },
  };
}

/** @param {any} registries @param {Record<string, string>} [config] */
export function buildMarketingActions(registries, config) {
  return [...buildObservationActions(config), buildProposeAction(registries, config), buildApproveAction(registries, config)];
}
