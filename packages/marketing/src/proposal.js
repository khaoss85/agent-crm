// @ts-check

import { AppError } from '../../core/index.js';

/**
 * The CampaignProposal completeness gate (MK1).
 *
 * A proposal that cannot state its audience, its exclusions, its channel, its
 * provider rationale, its content plan, its tracking plan, its risks and its
 * required approvals is not ready for a human, and the framework says so
 * rather than rendering a half-filled form: `reviewProposal` answers
 * `{complete: false, missing}` and the propose action records that refusal.
 *
 * Approval is a human-actor boundary: `approveProposal` refuses every actor
 * that is not a user, recomputes completeness from the stored record (a plan
 * the caller computed earlier is never trusted), and answers the immutable
 * version snapshot — it writes nothing itself; the action owns the write.
 */

/** The channels a proposal may name. A provider is never contacted to check them. */
export const PROPOSAL_CHANNELS = Object.freeze(['email', 'sms', 'whatsapp', 'ads', 'publishing', 'analytics']);

/** The campaign modes a proposal may carry. */
export const PROPOSAL_MODES = Object.freeze(['one-shot', 'rolling', 'triggered', 'journey']);

/**
 * The acceptance sections, each naming the record field that carries it.
 * Every entry is an MK1 acceptance clause: audience, exclusions, channel,
 * provider rationale, content plan, tracking plan, risks, required approvals.
 */
export const REQUIRED_PROPOSAL_SECTIONS = Object.freeze([
  { section: 'audience', field: 'audienceJson' },
  { section: 'exclusions', field: 'exclusionsJson' },
  { section: 'channel', field: 'channel' },
  { section: 'providerRationale', field: 'providerRationale' },
  { section: 'contentPlan', field: 'contentPlanJson' },
  { section: 'trackingPlan', field: 'trackingPlanJson' },
  { section: 'risks', field: 'risksJson' },
  { section: 'requiredApprovals', field: 'requiredApprovalsJson' },
]);

const MAX_TEXT = 10000;

/** @param {unknown} value */
function statedJson(value) {
  if (typeof value !== 'string' || value.length > MAX_TEXT) return false;
  let parsed;
  try { parsed = JSON.parse(value); } catch { return false; }
  if (!parsed || typeof parsed !== 'object') return false;
  const meaningful = (part, depth = 0) => {
    if (depth > 16) return false;
    if (typeof part === 'string') return part.trim().length > 0;
    if (typeof part === 'number') return Number.isFinite(part);
    if (typeof part === 'boolean') return true;
    if (!part || typeof part !== 'object') return false;
    const values = Object.values(part);
    return values.length > 0 && values.every(item => meaningful(item, depth + 1));
  };
  return meaningful(parsed);
}

/** @param {unknown} value */
function statedText(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TEXT;
}

/**
 * Review a proposal draft against the acceptance sections and the policy's
 * closed vocabularies. Never throws for content: unreadiness is data.
 *
 * @param {Record<string, any>} draft the stored proposal fields
 * @param {{allowedChannels?: readonly string[], allowedModes?: readonly string[]}} [policy]
 * @returns {{complete: boolean, missing: string[]}} frozen
 */
export function reviewProposal(draft, policy = {}) {
  const record = draft && typeof draft === 'object' ? draft : {};
  const allowedChannels = policy.allowedChannels ?? PROPOSAL_CHANNELS;
  const allowedModes = policy.allowedModes ?? PROPOSAL_MODES;
  /** @type {string[]} */
  const missing = [];
  for (const { section, field } of REQUIRED_PROPOSAL_SECTIONS) {
    const value = record[field];
    if (field === 'channel') {
      if (typeof value !== 'string' || !allowedChannels.includes(value)) {
        missing.push(section);
      }
      continue;
    }
    if (field === 'providerRationale') {
      if (!statedText(value)) missing.push(section);
      continue;
    }
    if (!statedJson(value)) missing.push(section);
  }
  if (record.mode !== undefined && record.mode !== null && !allowedModes.includes(record.mode)) {
    missing.push('mode');
  }
  if (typeof record.title !== 'string' || record.title.trim() === '') {
    missing.push('title');
  }
  return Object.freeze({ complete: missing.length === 0, missing: Object.freeze([...missing]) });
}

/**
 * Approve a proposed campaign: the human-actor boundary.
 *
 * Order matters and is load-bearing. The actor is checked FIRST, before any
 * completeness work: a non-human caller learns nothing about the draft beyond
 * the refusal, and a retry as a human gets the same stable answer. Then the
 * state is checked, then completeness is recomputed from the stored record.
 *
 * @param {{proposal: Record<string, any>, actor: any, approvedAt: string, policy: {name: string, version: number, fingerprint: string}, versionNumber: number, constraints?: {allowedChannels?: readonly string[], allowedModes?: readonly string[]}}} request
 * @returns {{version: Record<string, any>, proposalPatch: Record<string, any>}} frozen version row data (no id) plus the proposal patch
 */
export function approveProposal(request) {
  const { proposal, actor, approvedAt, policy, versionNumber } = request ?? {};
  if (!actor || typeof actor !== 'object' || actor.type !== 'user') {
    throw new AppError('Approving a campaign proposal requires a human user actor', {
      code: 'HUMAN_APPROVAL_REQUIRED', status: 403,
    });
  }
  if (!proposal || typeof proposal !== 'object') {
    throw new AppError('approveProposal needs the stored proposal', {
      code: 'PROPOSAL_REQUEST_INVALID', status: 400,
    });
  }
  if (proposal.status !== 'proposed') {
    throw new AppError(`Only a proposed campaign can be approved (status: ${String(proposal.status ?? 'missing')})`, {
      code: 'PROPOSAL_STATE_INVALID', status: 409,
    });
  }
  const review = reviewProposal(proposal, request.constraints);
  if (!review.complete) {
    throw new AppError('This proposal no longer states every required section, so it cannot be approved', {
      code: 'PROPOSAL_INCOMPLETE', status: 409,
      details: { missing: [...review.missing] },
    });
  }
  if (!policy || typeof policy.name !== 'string' || !Number.isSafeInteger(policy.version) || typeof policy.fingerprint !== 'string') {
    throw new AppError('approveProposal needs the versioned policy identity that reviewed this proposal', {
      code: 'PROPOSAL_POLICY_INVALID', status: 500,
    });
  }
  if (typeof approvedAt !== 'string' || approvedAt === '') {
    throw new AppError('approveProposal needs the approval instant', {
      code: 'PROPOSAL_REQUEST_INVALID', status: 400,
    });
  }
  const snapshot = {
    title: proposal.title,
    mode: proposal.mode ?? 'one-shot',
    insightId: proposal.insightId ?? null,
    audienceJson: proposal.audienceJson,
    exclusionsJson: proposal.exclusionsJson,
    channel: proposal.channel,
    providerRationale: proposal.providerRationale,
    contentPlanJson: proposal.contentPlanJson,
    trackingPlanJson: proposal.trackingPlanJson,
    risksJson: proposal.risksJson,
    requiredApprovalsJson: proposal.requiredApprovalsJson,
  };
  return Object.freeze({
    version: Object.freeze({
      proposalId: proposal.id,
      versionNumber,
      snapshotJson: JSON.stringify(snapshot),
      approvedBy: String(actor.id ?? 'unknown'),
      approvedAt,
      policyName: policy.name,
      policyVersion: policy.version,
      policyFingerprint: policy.fingerprint,
    }),
    proposalPatch: Object.freeze({
      status: 'approved',
      decidedBy: String(actor.id ?? 'unknown'),
      decidedAt: approvedAt,
    }),
  });
}
