// @ts-check

import { createDatabase } from '../../core/src/database.js';
import { AuditLog } from '../../core/src/audit.js';
import { EventBus } from '../../core/src/event-bus.js';
import { ModuleRegistry } from '../../core/src/module-registry.js';
import { CRM_SCHEMA } from '../../core/src/schema.js';
import { createCompanyModule } from '../../modules/company/src/index.js';
import { createContactModule } from '../../modules/contact/src/index.js';
import { createOpportunityModule } from '../../modules/opportunity/src/index.js';
import { createApprovalModule } from '../../modules/approval/src/index.js';
import { generatedModules } from '../../modules/generated/index.js';
import { validateGeneratedModuleDefinition } from '../../core/src/generated-module-contract.js';
import { createReferenceResolver } from '../../core/src/reference-resolver.js';
import {
  WorkflowEngine,
  decideOpportunityApprovalWorkflow,
  requestOpportunityStageChangeWorkflow,
} from '../../workflows/src/index.js';
import {
  MemoryNotificationProvider,
  ProviderRegistry,
} from '../../providers/src/index.js';

/**
 * @param {{dbPath?: string, approvalThresholdCents?: number}} [options]
 */
export function createAgentCrmApp(options = {}) {
  const database = createDatabase({
    path: options.dbPath,
    moduleMigrations: generatedModules.map((generated) => generated.migration),
  });
  const events = new EventBus();
  const audit = new AuditLog(database);
  const modules = new ModuleRegistry();
  const providers = new ProviderRegistry();

  const companyModule = createCompanyModule({ database, audit, events });
  modules.register(companyModule);

  const contactModule = createContactModule({
    database,
    audit,
    events,
    companies: companyModule.service,
  });
  modules.register(contactModule);

  const opportunityModule = createOpportunityModule({
    database,
    audit,
    events,
    companies: companyModule.service,
    contacts: contactModule.service,
  });
  modules.register(opportunityModule);

  const approvalModule = createApprovalModule({
    database,
    audit,
    events,
    opportunities: opportunityModule.service,
  });
  modules.register(approvalModule);

  // Reference resolver validates cross-module references at request time via
  // the target module's service (ADR-010). Built per app instance; resolution
  // is lazy, so modules may reference peers registered later, or themselves.
  const references = createReferenceResolver(modules);
  for (const generated of generatedModules) {
    // Fail closed at startup: a corrupted or hand-mangled registry entry stops
    // the app with a precise error instead of serving a half-working module.
    modules.register(
      validateGeneratedModuleDefinition(generated.createModule({ database, audit, events, references })),
    );
  }

  const notificationProvider = new MemoryNotificationProvider();
  providers.register({
    name: 'default-notifications',
    kind: 'notification',
    provider: notificationProvider,
  });

  const services = {
    companies: companyModule.service,
    contacts: contactModule.service,
    opportunities: opportunityModule.service,
    approvals: approvalModule.service,
  };

  const workflows = new WorkflowEngine({
    database,
    services,
    config: {
      approvalThresholdCents:
        options.approvalThresholdCents ??
        Number(process.env.APPROVAL_THRESHOLD_CENTS ?? 5_000_000),
    },
  });
  workflows.register(requestOpportunityStageChangeWorkflow);
  workflows.register(decideOpportunityApprovalWorkflow);

  events.subscribe('approval.requested', async ({ payload }) => {
    await notificationProvider.send({
      recipient: 'sales-manager',
      subject: `Approval required: ${payload.opportunityId}`,
      body: payload.reason,
    });
  });

  const app = {
    database,
    events,
    audit,
    modules,
    providers,
    workflows,
    services,
    schema: CRM_SCHEMA,
    config: {
      approvalThresholdCents:
        options.approvalThresholdCents ??
        Number(process.env.APPROVAL_THRESHOLD_CENTS ?? 5_000_000),
    },
    notifications: notificationProvider,
    close() {
      database.close();
    },
    doctor() {
      return {
        ok: true,
        name: 'agent-crm',
        version: '0.1.0',
        node: process.version,
        database: database.path,
        approvalThresholdCents: app.config.approvalThresholdCents,
        modules: modules.list(),
        workflows: workflows.list(),
        providers: providers.list(),
        counts: {
          companies: services.companies.list({ limit: 500 }).length,
          contacts: services.contacts.list({ limit: 500 }).length,
          opportunities: services.opportunities.list({ limit: 500 }).length,
          pendingApprovals: services.approvals.list({ status: 'pending', limit: 500 }).length,
          workflowRuns: workflows.listRuns({ limit: 500 }).length,
          auditEvents: audit.list({ limit: 500 }).length,
        },
      };
    },
    async seedDemo() {
      const actor = { type: 'system', id: 'demo-seed' };
      let company = services.companies.list({ limit: 500 }).find((item) => item.domain === 'acme.example');
      if (!company) {
        company = await services.companies.create(
          { name: 'Acme Italia', domain: 'acme.example' },
          { actor },
        );
      }

      let contact = services.contacts.list({ companyId: company.id, limit: 500 })
        .find((item) => item.email === 'mario.rossi@acme.example');
      if (!contact) {
        contact = await services.contacts.create(
          {
            companyId: company.id,
            firstName: 'Mario',
            lastName: 'Rossi',
            email: 'mario.rossi@acme.example',
            role: 'Head of Marketing',
          },
          { actor },
        );
      }

      const existing = services.opportunities.list({ companyId: company.id, limit: 500 });
      let standardRenewal = existing.find((item) => item.name === 'MailUp Renewal — Standard');
      if (!standardRenewal) {
        standardRenewal = await services.opportunities.create(
          {
            companyId: company.id,
            contactId: contact.id,
            name: 'MailUp Renewal — Standard',
            type: 'renewal',
            valueCents: 2_000_000,
            currency: 'EUR',
            stage: 'qualification',
            owner: 'alessandra',
          },
          { actor },
        );
      }

      let enterpriseRenewal = existing.find((item) => item.name === 'MailUp Renewal — Enterprise');
      if (!enterpriseRenewal) {
        enterpriseRenewal = await services.opportunities.create(
          {
            companyId: company.id,
            contactId: contact.id,
            name: 'MailUp Renewal — Enterprise',
            type: 'renewal',
            valueCents: 8_000_000,
            currency: 'EUR',
            stage: 'qualification',
            owner: 'walter',
          },
          { actor },
        );
      }

      return { company, contact, standardRenewal, enterpriseRenewal };
    },
    async runDemo() {
      const seeded = await app.seedDemo();
      const actor = { type: 'agent', id: 'demo-agent' };
      const results = [];
      for (const opportunity of [seeded.standardRenewal, seeded.enterpriseRenewal]) {
        const current = services.opportunities.get(opportunity.id);
        if (current.stage === 'qualification') {
          results.push(await workflows.run(
            'request-opportunity-stage-change',
            { opportunityId: current.id, targetStage: 'proposal' },
            { actor },
          ));
        }
      }
      return {
        seeded,
        results,
        opportunities: services.opportunities.list({ type: 'renewal' }),
        approvals: services.approvals.list(),
      };
    },
  };

  return app;
}
