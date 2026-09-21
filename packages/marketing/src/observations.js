// @ts-check
import { AppError, ValidationError } from '../../core/index.js';
import { deriveDropInsight } from './funnel.js';
import { PROPOSAL_MODES, REQUIRED_PROPOSAL_SECTIONS } from './proposal.js';

const DRAFT_FIELDS = ['title', 'mode', ...REQUIRED_PROPOSAL_SECTIONS.map(section => section.field)];

/** Accept only proposal content. Lifecycle, approvals and policy are server-owned. */
function draftContent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('draft must be an object');
  for (const key of Object.keys(value)) {
    if (!DRAFT_FIELDS.includes(key)) throw new ValidationError(`Unknown proposal content field: ${key}`);
    if (typeof value[key] !== 'string' || value[key].length > 10000) throw new ValidationError(`${key} must be bounded text`);
  }
  const result = Object.fromEntries(DRAFT_FIELDS.map(key => [key, (key === 'mode' ? (value[key] || 'one-shot') : (value[key]?.trim() ? value[key] : null))]));
  if (!PROPOSAL_MODES.includes(result.mode)) throw new ValidationError('Unknown campaign mode');
  return result;
}

function managedService(modules, name) {
  const service = modules.get(name)?.service;
  if (!service?.createManaged) throw new AppError(`Missing managed module ${name}`, { code: 'MARKETING_STORAGE_INVALID', status: 500 });
  return service;
}

/** Public record actions; each write runs in the existing action transaction. */
export function buildObservationActions(config = {}) {
  const names = {
    definition: config.definitionModule ?? 'funnel-definition',
    run: config.runModule ?? 'funnel-run',
    insight: config.insightModule ?? 'funnel-drop-insight',
    proposal: config.proposalModule ?? 'campaign-proposal',
  };
  return [{
    module: names.definition,
    name: 'observe', label: 'Record funnel observation', actionContract: 1,
    description: 'Record supplied counts with their source, snapshot the steps, and derive the largest relative loss. No source is queried.',
    input: [{ name: 'counts', type: 'json', required: true }, { name: 'source', type: 'string', required: true }],
    async execute({ record, input, modules, actor, now, step }) {
      if (!input.source.trim() || input.source.length > 1000) throw new ValidationError('Observation source must be stated and bounded');
      let steps;
      try { steps = JSON.parse(record.stepsJson); } catch { throw new ValidationError('Funnel steps must be a JSON array'); }
      const insight = deriveDropInsight({ steps, counts: input.counts });
      const at = now();
      const run = await managedService(modules, names.run).createManaged({
        funnelDefinitionId: record.id, stepsJson: JSON.stringify(steps), countsJson: JSON.stringify(input.counts), ranAt: at, source: input.source,
      }, { actor });
      const created = insight ? await managedService(modules, names.insight).createManaged({
        funnelRunId: run.id, step: insight.step, previousStep: insight.previousStep,
        previousCount: insight.previousCount, stepCount: insight.stepCount,
        dropRateBps: insight.dropRateBps, observedAt: at, status: 'observed',
      }, { actor }) : null;
      step('funnel.observed', { runId: run.id, insightId: created?.id ?? null });
      return { runId: run.id, insightId: created?.id ?? null };
    },
  }, {
    module: names.insight,
    name: 'prepare-proposal', label: 'Prepare campaign proposal', actionContract: 1,
    description: 'Prepare a draft from this insight. All sections must pass propose before a human can approve it.',
    input: [{ name: 'draft', type: 'json', required: true }],
    async execute({ record, input, modules, actor, managed, step }) {
      if (record.status !== 'observed') throw new AppError('This insight already has a proposal', { code: 'INSIGHT_ALREADY_PROPOSED', status: 409 });
      const proposal = await managedService(modules, names.proposal).createManaged({
        ...draftContent(input.draft), insightId: record.id, status: 'draft',
      }, { actor });
      await managed(record.id, { status: 'proposed' });
      step('proposal.prepared', { proposalId: proposal.id, insightId: record.id });
      return { proposalId: proposal.id };
    },
  }, {
    module: names.proposal,
    name: 'revise', label: 'Revise campaign draft', actionContract: 1,
    description: 'Replace draft or refused content. A proposed or approved proposal cannot change through this action.',
    input: [{ name: 'draft', type: 'json', required: true }],
    async execute({ record, input, managed, step }) {
      if (!['draft', 'refused'].includes(record.status)) throw new AppError('Only draft or refused proposals may be revised', { code: 'PROPOSAL_STATE_INVALID', status: 409 });
      await managed(record.id, {
        ...draftContent(input.draft), status: 'draft', refusalReasonsJson: null,
        policyName: null, policyVersion: null, policyFingerprint: null,
        decidedAt: null, proposedAt: null,
      });
      step('proposal.revised', { proposalId: record.id });
      return { proposalId: record.id };
    },
  }];
}
