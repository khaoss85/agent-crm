// @ts-check

import { scaffoldModule } from '../../cli/src/scaffold-module.js';
import { requiredString } from '../../core/src/validation.js';

/**
 * Document-selected MCP doctor projects `{adapter, available}` and drops the
 * v1 filesystem path. Local `--db` keeps the characterized `database` field.
 *
 * @param {Record<string, unknown>} report
 * @param {{ adapter: string, available: boolean } | null | undefined} publicStorage
 */
function projectDoctor(report, publicStorage) {
  if (!publicStorage) return report;
  const { database: _database, ...rest } = report;
  return { ...rest, storage: { adapter: publicStorage.adapter, available: publicStorage.available } };
}

/**
 * The space's sales playbook, read-only over MCP: an external agent reads
 * the context the member compiled, it never writes it here. Missing
 * composition or a missing row is an honest error, never invented content.
 *
 * @param {any} app
 */
function playbookService(app) {
  const service = app?.modules?.get?.('sales-playbook')?.service;
  if (!service || typeof service.getBySpace !== 'function') {
    throw new Error('The sales-playbook module is not composed: no playbook to read');
  }
  return service;
}

/**
 * The human-decided AI proposals of one space, read-only over MCP and
 * always scoped to the caller's space: listing another space's queue is
 * not possible through this tool.
 *
 * @param {any} app
 */
function proposalService(app) {
  const service = app?.modules?.get?.('space-ai-proposal')?.service;
  if (!service || typeof service.listWhere !== 'function' || typeof service.get !== 'function') {
    throw new Error('The space-ai-proposal module is not composed: no proposals to read');
  }
  return service;
}

const PROPOSAL_DECISIONS = Object.freeze(['approved', 'refused']);
const PROPOSAL_STATUSES = Object.freeze(['proposed', 'approved', 'refused']);

/** @param {{app: any, rootDir: string, publicStorage?: { adapter: string, available: boolean } | null}} dependencies */
export function createToolRegistry({ app, rootDir, publicStorage = null }) {
  const definitions = [
    {
      name: 'crm_project_context',
      title: 'Accordo Project Context',
      description: 'Inspect modules, workflows, providers, schema and architectural rules before changing the project.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnlyAnnotations(),
      handler: async () => ({
        product: 'Agent-native CRM development framework',
        principle: 'CRM state is deterministic; agents compose and invoke controlled services and workflows.',
        schema: app.schema,
        modules: app.modules.list(),
        workflows: app.workflows.list(),
        providers: app.providers.list(),
        policy: {
          renewalApprovalThresholdCents: app.config.approvalThresholdCents,
          protectedTransition: 'renewal → proposal',
        },
      }),
    },
    {
      name: 'crm_list_opportunities',
      title: 'List CRM Opportunities',
      description: 'List new-business, renewal or upsell opportunities with optional stage, type and company filters.',
      inputSchema: {
        type: 'object',
        properties: {
          stage: { type: 'string' },
          type: { type: 'string' },
          companyId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations(),
      handler: async (args) => ({ items: app.services.opportunities.list(args) }),
    },
    {
      name: 'crm_create_opportunity',
      title: 'Create CRM Opportunity',
      description: 'Create an opportunity through the Opportunity module service, preserving validation and audit.',
      inputSchema: {
        type: 'object',
        properties: {
          companyId: { type: 'string' },
          contactId: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['new_business', 'renewal', 'upsell'] },
          valueCents: { type: 'integer', minimum: 0 },
          currency: { type: 'string' },
          stage: { type: 'string' },
          owner: { type: 'string' },
          expectedCloseDate: { type: 'string' },
        },
        required: ['companyId', 'name', 'valueCents', 'owner'],
        additionalProperties: false,
      },
      annotations: writeAnnotations(),
      handler: async (args) => app.services.opportunities.create(args, {
        actor: { type: 'agent', id: 'mcp-client' },
      }),
    },
    {
      name: 'crm_request_stage_change',
      title: 'Request Opportunity Stage Change',
      description: 'Run the controlled stage-change workflow. High-value renewals moving to Proposal require human approval.',
      inputSchema: {
        type: 'object',
        properties: {
          opportunityId: { type: 'string' },
          targetStage: {
            type: 'string',
            enum: ['discovery', 'qualification', 'proposal', 'approval_pending', 'negotiation', 'won', 'lost'],
          },
        },
        required: ['opportunityId', 'targetStage'],
        additionalProperties: false,
      },
      annotations: writeAnnotations(),
      handler: async (args) => app.workflows.run(
        'request-opportunity-stage-change',
        args,
        { actor: { type: 'agent', id: 'mcp-client' } },
      ),
    },
    {
      name: 'crm_list_approvals',
      title: 'List Commercial Approvals',
      description: 'List pending, approved or rejected human approval requests.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
          opportunityId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations(),
      handler: async (args) => ({ items: app.services.approvals.list(args) }),
    },
    {
      name: 'crm_decide_approval',
      title: 'Decide Commercial Approval',
      description: 'Record an explicit human approval or rejection and apply the resulting opportunity stage.',
      inputSchema: {
        type: 'object',
        properties: {
          approvalId: { type: 'string' },
          decision: { type: 'string', enum: ['approved', 'rejected'] },
          decidedBy: { type: 'string', description: 'Identity of the human decision-maker.' },
        },
        required: ['approvalId', 'decision', 'decidedBy'],
        additionalProperties: false,
      },
      annotations: writeAnnotations(),
      _meta: { 'anthropic/requiresUserInteraction': true },
      handler: async (args) => {
        const decidedBy = requiredString(args.decidedBy, 'decidedBy');
        return app.workflows.run(
          'decide-opportunity-approval',
          { approvalId: args.approvalId, decision: args.decision },
          { actor: { type: 'user', id: decidedBy } },
        );
      },
    },
    {
      name: 'crm_get_trace',
      title: 'Get Workflow Trace',
      description: 'Read a workflow run with step-level inputs, outputs, status and errors.',
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations(),
      handler: async (args) => app.workflows.getRun(args.runId),
    },
    {
      name: 'crm_read_playbook',
      title: 'Read Space Sales Playbook',
      description: 'Read the sales playbook the member compiled for one space: who the space is, what it sells, to whom, in what tone. Read-only; a space with no playbook answers an error, never invented content.',
      inputSchema: {
        type: 'object',
        properties: {
          spaceId: { type: 'string', description: 'The Accordo space id — always explicit, never inferred.' },
        },
        required: ['spaceId'],
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations(),
      handler: async (args) => {
        const spaceId = requiredString(args.spaceId, 'spaceId');
        const playbook = playbookService(app).getBySpace(spaceId);
        if (!playbook) {
          throw new Error(`No sales playbook for space "${spaceId}": the member has not compiled one`);
        }
        return playbook;
      },
    },
    {
      name: 'crm_create_assignment',
      title: 'Create Teammate Assignment',
      description: 'Give a teammate agent an assignment from a human phrase with a cadence and a next run. Runs the governed create-assignment operation with the caller actor, so the write carries identity and audit; an unclear phrase or an unknown agent refuses instead of guessing.',
      inputSchema: {
        type: 'object',
        properties: {
          spaceId: { type: 'string', description: 'The Accordo space id — always explicit, never inferred.' },
          sourceKey: { type: 'string', description: 'Caller-supplied idempotency identity for the assignment: a retry replays, never doubles.' },
          agentSourceKey: { type: 'string', description: 'The agent this assignment belongs to.' },
          phrase: { type: 'string', description: 'The human phrase, e.g. ogni lunedi il report vendite.' },
          plan: { type: 'object', description: 'Optional explicit schedule (cadence, weekday, timeOfDay, runAt). Without it the built-in Italian parser places the phrase.' },
          costPerRunCents: { type: 'integer', minimum: 1, description: 'Cost of one run in cents — required on every assignment to an agent with a monthly spending cap.' },
          actorId: { type: 'string', description: 'Identity of the external agent giving the assignment. Required: the tool never invents it.' },
        },
        required: ['spaceId', 'sourceKey', 'agentSourceKey', 'phrase', 'actorId'],
        additionalProperties: false,
      },
      annotations: writeAnnotations(),
      handler: async (args) => app.createTeammateAssignment({
        actor: { type: 'agent', id: requiredString(args.actorId, 'actorId') },
        spaceId: args.spaceId,
        sourceKey: args.sourceKey,
        agentSourceKey: args.agentSourceKey,
        phrase: args.phrase,
        ...(args.plan === undefined ? {} : { plan: args.plan }),
        // backlog:1f7cb20d3c30 — the framework's single cost name: a capped
        // agent refuses an assignment without it (AGENT_COST_ESTIMATE_REQUIRED).
        ...(args.costPerRunCents === undefined ? {} : { costPerRunCents: args.costPerRunCents }),
      }),
    },
    {
      name: 'crm_list_proposals',
      title: 'List Space AI Proposals',
      description: 'List the AI action proposals of one space waiting for or holding a human decision. Always scoped to the given space; another space queue is not reachable through this tool.',
      inputSchema: {
        type: 'object',
        properties: {
          spaceId: { type: 'string', description: 'The Accordo space id — always explicit, never inferred.' },
          status: { type: 'string', enum: ['proposed', 'approved', 'refused'] },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['spaceId'],
        additionalProperties: false,
      },
      annotations: readOnlyAnnotations(),
      handler: async (args) => {
        const spaceId = requiredString(args.spaceId, 'spaceId');
        if (args.status !== undefined && !PROPOSAL_STATUSES.includes(args.status)) {
          throw new Error(`status must be one of: ${PROPOSAL_STATUSES.join(', ')}`);
        }
        const requested = Number.isInteger(args.limit) ? args.limit : 100;
        const limit = Math.min(Math.max(requested, 1), 500);
        const items = await proposalService(app).listWhere({
          spaceId,
          ...(args.status === undefined ? {} : { status: args.status }),
        });
        return { items: items.slice(0, limit) };
      },
    },
    {
      name: 'crm_decide_proposal',
      title: 'Decide Space AI Proposal',
      description: 'Record an explicit human approval or refusal of one proposed AI action of one space. Runs the governed decide record action with a human actor, so the write carries identity and audit; without the human identity the tool refuses, and a proposal of another space is refused.',
      inputSchema: {
        type: 'object',
        properties: {
          spaceId: { type: 'string', description: 'The Accordo space id — always explicit, never inferred.' },
          proposalId: { type: 'string', description: 'The proposal to decide.' },
          decision: { type: 'string', enum: ['approved', 'refused'] },
          decidedBy: { type: 'string', description: 'Identity of the human decision-maker. Required: the tool never invents it.' },
          refusalReason: { type: 'string', description: 'Why the action must not run (refused only).' },
        },
        required: ['spaceId', 'proposalId', 'decision', 'decidedBy'],
        additionalProperties: false,
      },
      annotations: writeAnnotations(),
      _meta: { 'anthropic/requiresUserInteraction': true },
      handler: async (args) => {
        const spaceId = requiredString(args.spaceId, 'spaceId');
        const decidedBy = requiredString(args.decidedBy, 'decidedBy');
        if (!PROPOSAL_DECISIONS.includes(args.decision)) {
          throw new Error(`decision must be one of: ${PROPOSAL_DECISIONS.join(', ')}`);
        }
        const proposal = await proposalService(app).get(args.proposalId);
        if (proposal.spaceId !== spaceId) {
          throw new Error('This proposal belongs to another space: deciding it from here is refused');
        }
        return app.runAction({
          module: 'space-ai-proposal',
          action: args.decision,
          recordId: args.proposalId,
          input: args.decision === 'refused' && args.refusalReason !== undefined
            ? { refusalReason: args.refusalReason }
            : {},
          actor: { type: 'user', id: decidedBy },
        });
      },
    },
    {
      name: 'crm_scaffold_module',
      title: 'Scaffold CRM Module',
      description: 'Plan or create a module service, metadata and test skeleton. Defaults to dry-run; apply must be explicitly true.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Lowercase module name, such as partner or subscription.' },
          apply: { type: 'boolean', default: false },
        },
        required: ['name'],
        additionalProperties: false,
      },
      annotations: writeAnnotations(),
      _meta: { 'anthropic/requiresUserInteraction': true },
      handler: async (args) => scaffoldModule({
        name: args.name,
        rootDir,
        apply: args.apply === true,
      }),
    },
    {
      name: 'crm_doctor',
      title: 'Diagnose Accordo Runtime',
      description: 'Inspect database, modules, workflows, providers and entity counts.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnlyAnnotations(),
      handler: async () => projectDoctor(app.doctor(), publicStorage),
    },
  ];

  const byName = new Map(definitions.map((tool) => [tool.name, tool]));
  return {
    list: () => definitions.map(({ handler: _handler, ...definition }) => definition),
    async call(name, args = {}) {
      const tool = byName.get(name);
      if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
      return tool.handler(args ?? {});
    },
  };
}

function readOnlyAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function writeAnnotations() {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
}
