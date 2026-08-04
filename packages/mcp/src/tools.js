// @ts-check

import { scaffoldModule } from '../../cli/src/scaffold-module.js';
import { requiredString } from '../../core/src/validation.js';

/** @param {{app: any, rootDir: string}} dependencies */
export function createToolRegistry({ app, rootDir }) {
  const definitions = [
    {
      name: 'crm_project_context',
      title: 'Agent CRM Project Context',
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
      title: 'Diagnose Agent CRM Runtime',
      description: 'Inspect database, modules, workflows, providers and entity counts.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnlyAnnotations(),
      handler: async () => app.doctor(),
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
