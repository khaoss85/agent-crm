// @ts-check

import { AppError } from '../../core/index.js';
import {
  handoverContext,
  normalizeHandoverDecision,
  normalizeModeOverrides,
  normalizePartner,
} from './handover-policy.js';
import { DATES_NOTE, DATES_SOURCE, requireDeliveryWindow } from './dates.js';

/**
 * Contract → Delivery handover (Milestone 13).
 *
 *   contract.plan-delivery-handover     read-only: what the handover WOULD create
 *   contract.create-delivery-handover   human-approved: creates all of it, atomically
 *
 * This milestone **plans and records** a handover. It does not execute
 * delivery: nothing starts, progresses, completes, schedules, staffs, costs or
 * bills. The Delivery Project it creates is a planned container with the work
 * the sale actually committed us to, traced back to the obligations the
 * contracts package raised.
 *
 * Everything it reads about the sale comes through the contracts package's
 * declared `delivery-obligations@1` capability. This package never imports a
 * contracts service, never reads a contracts table and never learns a
 * contracts source key.
 */

const POLICY_KIND = 'delivery-handover-policy';
const CAPABILITY = { name: 'delivery-obligations', version: 1 };
const MAX_JSON = 200_000;
const MAX_WORK_PACKAGES = 200;

/** @typedef {Record<string, string>} DeliveryModuleConfig */

/** @param {DeliveryModuleConfig} [config] */
export function resolvedNames(config = {}) {
  return {
    contract: config.contractModule ?? 'commercial-contract',
    project: config.projectModule ?? 'delivery-project',
    workPackage: config.workPackageModule ?? 'delivery-work-package',
    milestone: config.milestoneModule ?? 'delivery-milestone',
    partner: config.partnerModule ?? 'delivery-partner-engagement',
    run: config.runModule ?? 'delivery-handover-run',
  };
}

/** Trusted read-only managed storage handle; a CRUD-writable module is refused. */
function trusted(modules, name) {
  const service = modules.get(name).service;
  if (typeof service.createManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a read-only managed record module — regenerate it from the current manifest`, {
      code: 'DELIVERY_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

function toJson(value, label) {
  const text = JSON.stringify(value);
  if (text.length > MAX_JSON) {
    throw new AppError(`The ${label} exceeds the storable bound`, { code: 'EVIDENCE_TOO_LARGE', status: 409 });
  }
  return text;
}

/**
 * Open the contracts capability. An undeclared reach is refused by the
 * registry itself, and an application without the contracts package fails here
 * with a stable code rather than a missing-module stack trace.
 *
 * @param {{domains: any, modules: any, actor?: unknown, now?: () => string}} ctx
 */
function obligationsCapability({ domains, modules, actor, now }) {
  try {
    return domains.capability({
      consumer: 'delivery',
      capability: CAPABILITY.name,
      version: CAPABILITY.version,
      context: { modules, actor, now },
    });
  } catch (error) {
    if (error instanceof AppError && error.status !== 404) throw error;
    throw new AppError(
      'The delivery package requires the contracts package capability delivery-obligations@1, which is not available',
      { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
    );
  }
}

/**
 * Load and prove the handover source. Every refusal is stable: a contract
 * whose obligations are gone, already handed over, or whose project already
 * exists is never planned twice on the assumption that it is probably fine.
 */
export function loadHandoverSource({ obligations, contract, modules, names }) {
  if (!contract) {
    throw new AppError('No activated contract exists for this record', { code: 'CONTRACT_NOT_ACTIVATED', status: 409 });
  }
  const pending = obligations.listPending(contract.id);
  const existingProject = trusted(modules, names.project).listWhere({ contractId: contract.id })[0] ?? null;
  return { contract, pending, existingProject };
}

/** Apply the policy (and any human override) to every pending obligation. Pure. */
export function planObligations({ policy, fingerprint, contract, pending, overrides }) {
  const label = `Delivery handover policy "${policy.name}@${policy.version}"`;
  return pending.map((obligation, index) => {
    /** @type {unknown} */
    let raw;
    try {
      raw = policy.planObligation(handoverContext({ obligation, contract, config: policy.config }));
    } catch (error) {
      throw new AppError(
        `${label} threw (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}) — handover policies must be total and deterministic`,
        { code: 'HANDOVER_POLICY_INVALID', status: 500 },
      );
    }
    const decision = normalizeHandoverDecision(label, raw, obligation);
    const override = overrides.get(obligation.id) ?? null;
    const deliveryMode = override ? override.deliveryMode : decision.deliveryMode;
    return {
      obligation,
      position: index + 1,
      policyMode: decision.deliveryMode,
      deliveryMode,
      workPackageLabel: decision.workPackageLabel,
      milestoneKeys: decision.milestoneKeys,
      reason: override ? override.reason : decision.reason,
      override,
      requiresDecision: deliveryMode === 'ambiguous',
    };
  });
}

/** @param {any[]} decisions */
function summarize(decisions) {
  const counts = { workPackages: decisions.length, internal: 0, partner: 0, ambiguous: 0 };
  for (const decision of decisions) counts[decision.deliveryMode] += 1;
  return counts;
}

/** The milestone plan for the whole project: canonical, ordered, de-duplicated. */
function milestonePlan(decisions) {
  const keys = [];
  for (const decision of decisions) {
    for (const key of decision.milestoneKeys) if (!keys.includes(key)) keys.push(key);
  }
  return keys.map((key, index) => ({ key, position: index + 1 }));
}

/** The machine-readable plan an agent can prepare and a human can approve. */
function planPayload({ contract, decisions, existingProject, policy, fingerprint, partnerNeeded }) {
  const counts = summarize(decisions);
  return {
    contractId: contract.id,
    orderId: contract.orderId,
    activationId: contract.activationId,
    currency: contract.currency,
    customerName: contract.customerName,
    policy: policy.name,
    policyVersion: policy.version,
    policyFingerprint: fingerprint,
    alreadyHandedOver: Boolean(existingProject),
    deliveryProjectId: existingProject?.id ?? null,
    plannable: !existingProject && decisions.length > 0 && counts.ambiguous === 0,
    // Everything a caller must still decide or supply, stated rather than defaulted.
    requiredInputs: [
      ...(counts.ambiguous > 0 ? ['modeOverrides'] : []),
      ...(partnerNeeded ? ['partner'] : []),
    ],
    optionalInputs: ['targetStartDate', 'targetEndDate'],
    datesProvenance: { source: DATES_SOURCE, note: DATES_NOTE },
    partnerRequired: partnerNeeded,
    counts,
    workPackages: decisions.map((decision) => ({
      obligationId: decision.obligation.id,
      componentKey: decision.obligation.componentKey,
      label: decision.workPackageLabel,
      sku: decision.obligation.sku,
      quantity: decision.obligation.quantity,
      netAmountCents: decision.obligation.netAmountCents,
      currency: decision.obligation.currency,
      chargeType: decision.obligation.chargeType,
      deliveryMode: decision.deliveryMode,
      policyDeliveryMode: decision.policyMode,
      overridden: Boolean(decision.override),
      reason: decision.reason,
      requiresDecision: decision.requiresDecision,
      position: decision.position,
    })),
    milestones: milestonePlan(decisions),
    // Nothing about execution, cost, staffing, acceptance or service is
    // implied by this plan, and the payload says so.
    notModeled: [
      'delivery execution', 'progress', 'time tracking', 'cost', 'margin',
      'resource scheduling', 'change requests', 'customer acceptance',
      'billing milestones', 'partner access', 'service contracts', 'SLA',
    ],
  };
}

/**
 * `contract.plan-delivery-handover` — read-only. It computes exactly what
 * `create-delivery-handover` would create, writes no delivery record and emits
 * no business audit or event.
 *
 * @param {DeliveryModuleConfig} [config]
 */
export function buildPlanHandoverAction(config) {
  const names = resolvedNames(config);
  return {
    module: names.contract,
    name: 'plan-delivery-handover',
    label: 'Plan delivery handover',
    description: 'Show what handing this contract to delivery would create. Writes nothing.',
    actionContract: 1,
    input: [
      { name: 'policy', type: 'string', required: true, hint: 'Registered delivery handover policy name.' },
      { name: 'policyVersion', type: 'integer', required: true, hint: 'Explicit policy version — never an implicit latest.' },
      { name: 'modeOverrides', type: 'json', required: false, hint: 'Preview decisions: [{obligationId, deliveryMode, reason}].' },
    ],
    /** @param {any} ctx */
    async execute({ record: contract, input, modules, domains, actor, now, step }) {
      const { definition: policy, fingerprint } = domains.getPolicy('delivery', POLICY_KIND, input.policy, input.policyVersion);
      const obligations = obligationsCapability({ domains, modules, actor, now });
      const source = loadHandoverSource({ obligations, contract: obligations.getContract(contract.id), modules, names });
      const overrides = normalizeModeOverrides(input.modeOverrides, new Set(source.pending.map((row) => row.id)));
      const decisions = planObligations({ policy, fingerprint, contract: source.contract, pending: source.pending, overrides });
      const partnerNeeded = decisions.some((decision) => decision.deliveryMode === 'partner');
      step('delivery.handover.planned', { contractId: contract.id, ...summarize(decisions) });
      return {
        plan: planPayload({
          contract: source.contract, decisions, existingProject: source.existingProject,
          policy, fingerprint, partnerNeeded,
        }),
        policy: { name: policy.name, version: policy.version, fingerprint },
      };
    },
  };
}

/**
 * `contract.create-delivery-handover` — the human-approved transition. One
 * transaction creates the handover run, the delivery project, one work package
 * per obligation, the milestone plan and the optional partner engagement, and
 * marks the source obligations handed over through the contracts capability.
 * Everything commits or nothing does.
 *
 * @param {DeliveryModuleConfig} [config]
 */
export function buildCreateHandoverAction(config) {
  const names = resolvedNames(config);
  return {
    module: names.contract,
    name: 'create-delivery-handover',
    label: 'Create delivery handover',
    description: 'Hand this contract to delivery: create the delivery project, its work packages and milestones (human decision).',
    actionContract: 1,
    confirm: true,
    input: [
      { name: 'policy', type: 'string', required: true, hint: 'Registered delivery handover policy name.' },
      { name: 'policyVersion', type: 'integer', required: true, hint: 'Explicit policy version.' },
      { name: 'projectName', type: 'string', required: false, hint: 'Project label; defaults to the customer name.' },
      { name: 'targetStartDate', type: 'string', required: false, hint: 'Planning date YYYY-MM-DD — not a signed commitment.' },
      { name: 'targetEndDate', type: 'string', required: false, hint: 'Planning date YYYY-MM-DD — not a signed commitment.' },
      { name: 'partner', type: 'json', required: false, hint: '{partnerRef, partnerName, reason} — a business reference, never an account.' },
      { name: 'modeOverrides', type: 'json', required: false, hint: '[{obligationId, deliveryMode, reason}] — a human decision, with a reason.' },
    ],
    /** @param {any} ctx */
    async execute({ record: contract, input, actor, modules, domains, now, step }) {
      // Handing contracted work to a delivery team — and naming the partner
      // who will perform it — is a human decision. An agent may prepare it.
      if (!actor || typeof actor !== 'object' || /** @type {any} */ (actor).type !== 'user') {
        throw new AppError('Creating a delivery handover requires a human user actor', {
          code: 'HUMAN_APPROVAL_REQUIRED', status: 403,
        });
      }
      const { definition: policy, fingerprint } = domains.getPolicy('delivery', POLICY_KIND, input.policy, input.policyVersion);
      const obligations = obligationsCapability({ domains, modules, actor, now });
      const source = loadHandoverSource({ obligations, contract: obligations.getContract(contract.id), modules, names });

      // Already handed over is the first answer on a retry, before any policy
      // work: the refusal must not depend on whether the caller repeated the
      // overrides the first call carried.
      if (source.existingProject) {
        throw new AppError('This contract is already handed over to delivery', {
          code: 'HANDOVER_ALREADY_EXISTS', status: 409, details: { deliveryProjectId: source.existingProject.id },
        });
      }
      if (source.pending.length === 0) {
        throw new AppError('This contract has no pending delivery obligations', {
          code: 'NO_DELIVERY_OBLIGATIONS', status: 409,
        });
      }
      if (source.pending.length > MAX_WORK_PACKAGES) {
        throw new AppError('Too many delivery obligations for one handover', {
          code: 'OBLIGATIONS_TOO_MANY', status: 409,
        });
      }

      const overrides = normalizeModeOverrides(input.modeOverrides, new Set(source.pending.map((row) => row.id)));
      const decisions = planObligations({ policy, fingerprint, contract: source.contract, pending: source.pending, overrides });
      const undecided = decisions.filter((decision) => decision.requiresDecision);
      if (undecided.length > 0) {
        throw new AppError(
          `${undecided.length} delivery obligation(s) have no delivery mode and need an explicit human decision`,
          {
            code: 'DELIVERY_MODE_AMBIGUOUS', status: 409,
            details: { obligationIds: undecided.map((decision) => decision.obligation.id) },
          },
        );
      }

      const counts = summarize(decisions);
      const partner = normalizePartner(input.partner);
      if (counts.partner > 0 && !partner) {
        throw new AppError('A partner reference is required when any work package is delivered by a partner', {
          code: 'PARTNER_REQUIRED', status: 409, details: { partnerWorkPackages: counts.partner },
        });
      }
      if (counts.partner === 0 && partner) {
        throw new AppError('No work package is delivered by a partner, so no partner engagement can be planned', {
          code: 'PARTNER_NOT_APPLICABLE', status: 409,
        });
      }
      const window = requireDeliveryWindow(input, source.contract);
      const createdAt = now();
      const projectName = boundedName(input.projectName) ?? `${source.contract.customerName ?? 'Customer'} delivery`;

      const runs = trusted(modules, names.run);
      const run = await runs.createManaged(
        {
          sourceKey: `delivery-handover:contract:${source.contract.id}`,
          contractId: source.contract.id,
          orderId: source.contract.orderId,
          activationId: source.contract.activationId,
          policy: policy.name,
          policyVersion: policy.version,
          policyFingerprint: fingerprint,
          obligationCount: decisions.length,
          internalCount: counts.internal,
          partnerCount: counts.partner,
          overrideCount: decisions.filter((decision) => decision.override).length,
          milestoneCount: milestonePlan(decisions).length,
          obligationIdsJson: toJson(decisions.map((decision) => decision.obligation.id), 'obligation list'),
          decisionsJson: toJson(
            decisions.map((decision) => ({
              obligationId: decision.obligation.id,
              componentKey: decision.obligation.componentKey,
              policyDeliveryMode: decision.policyMode,
              deliveryMode: decision.deliveryMode,
              overridden: Boolean(decision.override),
              reason: decision.reason,
              workPackageLabel: decision.workPackageLabel,
              milestoneKeys: decision.milestoneKeys,
            })),
            'handover decisions',
          ),
          targetStartDate: window.targetStartDate,
          targetEndDate: window.targetEndDate,
          datesSource: window.datesSource,
          partnerRef: partner?.partnerRef ?? null,
          status: 'completed',
          handedOverBy: String(/** @type {any} */ (actor).id ?? 'unknown'),
          handedOverAt: createdAt,
        },
        { actor },
      );

      const projects = trusted(modules, names.project);
      const project = await projects.createManaged(
        {
          sourceKey: `delivery-project:contract:${source.contract.id}`,
          contractId: source.contract.id,
          contractVersionId: source.contract.currentVersionId,
          activationId: source.contract.activationId,
          orderId: source.contract.orderId,
          handoverRunId: run.id,
          // The customer is copied from what the contract published: the
          // project renders without reading a live CRM row.
          customerName: source.contract.customerName,
          customerEmail: source.contract.customerEmail,
          companyId: source.contract.companyId,
          contactId: source.contract.contactId,
          opportunityId: source.contract.opportunityId,
          name: projectName,
          currency: source.contract.currency,
          status: 'pending_kickoff',
          workPackageCount: decisions.length,
          milestoneCount: milestonePlan(decisions).length,
          partnerCount: partner ? 1 : 0,
          targetStartDate: window.targetStartDate,
          targetEndDate: window.targetEndDate,
          planDays: window.planDays,
          datesSource: window.datesSource,
          policy: policy.name,
          policyVersion: policy.version,
          policyFingerprint: fingerprint,
          plannedAt: createdAt,
        },
        { actor },
      );

      const workPackages = trusted(modules, names.workPackage);
      /** @type {Record<string, string[]>} */
      const workPackageIdsByMilestone = {};
      const createdWorkPackages = [];
      for (const decision of decisions) {
        const created = await workPackages.createManaged(
          {
            sourceKey: `delivery-work-package:${project.id}:${decision.obligation.id}`,
            deliveryProjectId: project.id,
            contractId: source.contract.id,
            obligationId: decision.obligation.id,
            contractLineId: decision.obligation.contractLineId,
            orderComponentId: decision.obligation.orderComponentId,
            componentKey: decision.obligation.componentKey,
            label: decision.workPackageLabel,
            sku: decision.obligation.sku,
            chargeType: decision.obligation.chargeType,
            interval: decision.obligation.interval,
            intervalCount: decision.obligation.intervalCount,
            quantity: decision.obligation.quantity,
            netAmountCents: decision.obligation.netAmountCents,
            currency: decision.obligation.currency,
            productId: decision.obligation.productId,
            productVersionId: decision.obligation.productVersionId,
            deliveryMode: decision.deliveryMode,
            policyDeliveryMode: decision.policyMode,
            modeOverridden: Boolean(decision.override),
            modeOverrideReason: decision.override?.reason ?? null,
            modeReason: decision.reason,
            overriddenBy: decision.override ? String(/** @type {any} */ (actor).id ?? 'unknown') : null,
            partnerRef: decision.deliveryMode === 'partner' ? partner?.partnerRef ?? null : null,
            policy: policy.name,
            policyVersion: policy.version,
            policyFingerprint: fingerprint,
            status: 'planned',
            handoverRunId: run.id,
            position: decision.position,
          },
          { actor },
        );
        createdWorkPackages.push(created);
        for (const key of decision.milestoneKeys) {
          (workPackageIdsByMilestone[key] ??= []).push(created.id);
        }
      }

      const milestones = trusted(modules, names.milestone);
      const createdMilestones = [];
      for (const { key, position } of milestonePlan(decisions)) {
        createdMilestones.push(await milestones.createManaged(
          {
            sourceKey: `delivery-milestone:${project.id}:${key}`,
            deliveryProjectId: project.id,
            contractId: source.contract.id,
            milestoneKey: key,
            label: key.replace(/-/g, ' '),
            position,
            status: 'planned',
            targetDate: null,
            workPackageIdsJson: toJson(workPackageIdsByMilestone[key] ?? [], 'milestone work packages'),
            policy: policy.name,
            policyVersion: policy.version,
            handoverRunId: run.id,
          },
          { actor },
        ));
      }

      let engagement = null;
      if (partner) {
        engagement = await trusted(modules, names.partner).createManaged(
          {
            sourceKey: `delivery-partner:${project.id}:${partner.partnerRef}`,
            deliveryProjectId: project.id,
            contractId: source.contract.id,
            partnerRef: partner.partnerRef,
            partnerNameSnapshot: partner.partnerName,
            role: 'delivery_partner',
            status: 'planned',
            workPackageIdsJson: toJson(
              createdWorkPackages.filter((row) => row.deliveryMode === 'partner').map((row) => row.id),
              'partner work packages',
            ),
            workPackageCount: counts.partner,
            scopeSnapshot: createdWorkPackages
              .filter((row) => row.deliveryMode === 'partner')
              .map((row) => row.label)
              .join('; ')
              .slice(0, 400),
            assignedBy: String(/** @type {any} */ (actor).id ?? 'unknown'),
            assignmentReason: partner.reason,
            handoverRunId: run.id,
            plannedAt: createdAt,
          },
          { actor },
        );
      }

      // The cross-package write, inside this same transaction: the contracts
      // package marks exactly these obligations handed over through its own
      // capability, and refuses anything that is not still pending.
      const handedOver = await obligations.markHandedOver({
        contractId: source.contract.id,
        obligationIds: decisions.map((decision) => decision.obligation.id),
        handoverRef: project.id,
        actor,
      });

      await runs.applyManaged(
        run.id,
        { deliveryProjectId: project.id, partnerEngagementId: engagement?.id ?? null, handedOverCount: handedOver },
        { actor },
      );

      step('delivery.handover.created', {
        deliveryProjectId: project.id,
        workPackages: createdWorkPackages.length,
        milestones: createdMilestones.length,
        partnerEngagementId: engagement?.id ?? null,
        obligationsHandedOver: handedOver,
      });

      return {
        handoverRunId: run.id,
        deliveryProject: {
          id: project.id,
          name: project.name,
          status: project.status,
          workPackageCount: createdWorkPackages.length,
          milestoneCount: createdMilestones.length,
          targetStartDate: window.targetStartDate,
          targetEndDate: window.targetEndDate,
          datesSource: window.datesSource,
        },
        workPackageIds: createdWorkPackages.map((row) => row.id),
        milestoneKeys: createdMilestones.map((row) => row.milestoneKey),
        partnerEngagementId: engagement?.id ?? null,
        obligationsHandedOver: handedOver,
        counts,
      };
    },
  };
}

/** @param {unknown} value */
function boundedName(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 120) {
    throw new AppError('projectName must be a non-empty string of at most 120 characters', {
      code: 'VALIDATION_ERROR', status: 400,
    });
  }
  return value.trim();
}

/** @param {DeliveryModuleConfig} [config] */
export function buildDeliveryActions(config) {
  return [buildPlanHandoverAction(config), buildCreateHandoverAction(config)];
}
