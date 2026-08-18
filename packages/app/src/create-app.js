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
import { generatedActions } from '../../actions/generated/index.js';
import { generatedPipelines } from '../../pipelines/generated/index.js';
import { generatedDomains } from '../../domains/generated/index.js';
import { PipelineRegistry } from '../../core/src/pipeline-registry.js';
import { PackageRegistry } from '../../core/src/package-registry.js';
import { createOperationRuntime, composePackageOperations } from '../../core/src/operation-runtime.js';
import { ValidationError } from '../../core/src/errors.js';
import { validateGeneratedModuleDefinition } from '../../core/src/generated-module-contract.js';
import { ActionRegistry } from '../../core/src/action-registry.js';
import { runRecordAction } from '../../core/src/action-runtime.js';
import { resolveClock } from '../../core/src/time.js';
import { createCoreAdapters } from '../../core/src/core-adapters.js';
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
 * @param {{dbPath?: string, approvalThresholdCents?: number, busyTimeoutMs?: number}} [options]
 */
export function createAccordoApp(options = {}) {
  // The application clock (generic runtime capability): actions that decide
  // anything from the current instant read it here, so a test can pin "today"
  // and a run is reproducible. Defaults to the wall clock.
  const now = resolveClock(options.clock);
  const database = createDatabase({
    path: options.dbPath,
    busyTimeoutMs: options.busyTimeoutMs,
    // A generated module carries an append-only, ordered `migrations` list: its
    // create migration plus one per revision it has evolved through (ADR-019).
    // `migration` is the pre-evolution single-migration shape, still honoured so
    // a project generated before this contract keeps booting unchanged.
    moduleMigrations: generatedModules.flatMap((generated) => (
      Array.isArray(generated.migrations) ? generated.migrations
        : generated.migration ? [generated.migration] : []
    )),
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

  // Code-first action registry (ADR-011/014). Actions target generated modules
  // or handwritten core modules EXPLICITLY declared action-eligible below —
  // registering an action is the eligibility declaration for the generic
  // action route, while core CRUD stays on its dedicated endpoints and is
  // never exposed through the generic records surface. A malformed action
  // definition throws here and stops startup rather than exposing a
  // half-working action.
  const generatedModuleNames = new Set(generatedModules.map((generated) => generated.name));
  const ACTION_ELIGIBLE_CORE_MODULES = new Set(['opportunity']);
  const actionModuleExists = (name) => generatedModuleNames.has(name) || ACTION_ELIGIBLE_CORE_MODULES.has(name);
  const actions = new ActionRegistry({ moduleExists: actionModuleExists });
  for (const definition of generatedActions) actions.register(definition);

  // Code-first pipeline registry (ADR-014). Staged-eligible targets are the
  // modules that actually STORE pipeline state — today the explicitly
  // action-eligible core modules (opportunity, via core migration v3). A
  // generated module has no pipeline columns yet (manifest-declared pipeline
  // state is future work), so a pipeline targeting one would register cleanly
  // but be permanently unusable — rejected at startup instead, fail closed.
  const pipelines = new PipelineRegistry({ moduleExists: (name) => ACTION_ELIGIBLE_CORE_MODULES.has(name) });
  for (const definition of generatedPipelines) pipelines.register(definition);

  // Optional domain packages (ADR-018 addendum). The kernel knows only the
  // generic contract: a package contributes actions and versioned policies,
  // and the application composes it here. With none registered, everything
  // below behaves exactly as it did before this seam existed.
  const domains = new PackageRegistry({ packages: generatedDomains });
  domains.persistFingerprints(database);
  // A package extracted from the kernel may already have `definition_versions`
  // rows in shipped databases, written under its own type strings before it was
  // a package. Re-typing them would leave the originals unmatched and silently
  // retire the drift check that makes a registered version immutable, so such a
  // package persists its own and says so. Generic: the kernel names no domain.
  for (const pkg of generatedDomains) {
    if (typeof pkg.persistFingerprints === 'function') pkg.persistFingerprints(database);
  }
  // A domain's actions join the same registry, under the same validation and
  // the same eligibility rules as any other action. Registration order is
  // deterministic and a malformed action stops startup.
  for (const definition of domains.actions()) actions.register(definition);

  // ── Declared application operations (ADR-032) ─────────────────────────────
  // Packages contribute bounded application-scoped operations, and the
  // composition attaches each declared alias generically. This replaces the
  // two named residues the seam was designed against — the Commercial
  // `syncCatalog` lookup and the named Signature wiring: the names now live in
  // the package declarations, where names belong. Without the owning package
  // composed, an alias is simply absent and its route answers an honest 404.
  const operationRuntime = createOperationRuntime({
    database,
    modules,
    events,
    config: {
      catalogTimeoutMs: /** @type {any} */ (options).catalogTimeoutMs,
      signatureTimeoutMs: /** @type {any} */ (options).signatureTimeoutMs,
    },
  });
  const { aliases: operationAliases } = composePackageOperations({ registry: domains, runtime: operationRuntime });

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

  // Declared capabilities over the handwritten core modules (ADR-013): built
  // once per app instance — frozen, no global state, the only sanctioned way
  // for an action to create/reuse core records.
  const coreAdapters = createCoreAdapters({ database, services, pipelines });

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
    actions,
    pipelines,
    domains,
    actionEligibleCoreModules: [...ACTION_ELIGIBLE_CORE_MODULES].sort(),
    /**
     * Run a code-first record action atomically (ADR-011/012): the business
     * writes commit or roll back together and domain events become visible only
     * after the commit. Delegates to the shared action runtime so the HTTP route
     * and in-process callers share one implementation.
     *
     * @param {{module: string, action: string, recordId: string, input?: unknown, actor?: unknown}} params
     */
    runAction({ module, action, recordId, input, actor }) {
      return runRecordAction({
        database,
        events,
        registry: actions,
        modules,
        services,
        core: coreAdapters,
        pipelines,
        domains,
        now,
        config: app.config,
        module,
        action,
        recordId,
        input,
        actor,
      });
    },
    now,
    schema: CRM_SCHEMA,
    config: {
      approvalThresholdCents:
        options.approvalThresholdCents ??
        Number(process.env.APPROVAL_THRESHOLD_CENTS ?? 5_000_000),
      // Bound on every external-operation provider call (ADR-017).
      externalTimeoutMs: /** @type {any} */ (options).signatureTimeoutMs,
    },
    notifications: notificationProvider,
    close() {
      database.close();
    },
    doctor() {
      return {
        ok: true,
        name: 'accordo',
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

  // Generic alias attachment (ADR-032): a declared app method may add
  // application surface, never replace it — an alias that would shadow an
  // existing key is a composition defect and stops startup.
  for (const alias of operationAliases) {
    if (alias.appMethod in app) {
      throw new ValidationError(
        `package "${alias.package}" operation "${alias.name}": appMethod "${alias.appMethod}" would shadow an existing application key`,
      );
    }
    /** @type {any} */ (app)[alias.appMethod] = alias.fn;
  }

  return app;
}
