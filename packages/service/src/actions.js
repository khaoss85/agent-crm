// @ts-check

import { AppError, ValidationError, requiredString } from '../../core/index.js';
import {
  ACTIVITY_TYPES, CASE_PRIORITIES, CASE_STATES, CASE_TRANSITIONS, COVERAGE_STATES,
  ESCALATION_LEVELS, OPENING_COVERAGE_STATES, SLA_STATES, VISIBILITY,
  actorId, activationPolicy, activitySequence, addMinutes, boundedText, bySourceKey,
  calendarDate, callerActivityKey, computeActivation, coverageIn, evaluateSla,
  obligationsCapability, oneOf, readOverrides, recordActivity, requireHuman,
  requireSameRecord, serviceNames, trusted,
  MAX_KEY, MAX_LABEL, MAX_REF,
} from './service-actions.js';

/**
 * Every action the Service package contributes.
 *
 * @param {{modules?: Record<string, string>, policies?: any[]}} [options]
 */
export function buildServiceActions(options = {}) {
  const names = serviceNames(options.modules);
  const policies = options.policies ?? [];

  return [
    {
      module: names.contract,
      name: 'plan-service-activation',
      label: 'Plan service activation',
      description: 'Read-only: what this contract\'s pending service obligations would become. It records nothing — no coverage, no entitlement, no audit row and no event.',
      actionContract: 1,
      input: [
        { name: 'policy', type: 'string', required: false, hint: 'The activation policy name. Defaults to the only registered one.' },
        { name: 'policyVersion', type: 'integer', required: false },
        { name: 'overrides', type: 'json', required: false, hint: 'Human decisions for obligations the policy cannot decide. Each needs a stated reason.' },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, domains, actor, now, step }) {
        // Deliberately readable by an agent: planning is how an agent learns
        // what a human would be deciding, and it cannot change anything.
        const capability = obligationsCapability({ domains, modules, actor, now });
        const contract = capability.getContract(record.id);
        if (!contract) {
          throw new AppError('This contract could not be read through the service-obligations capability', {
            code: 'SERVICE_CONTRACT_UNREADABLE', status: 409,
          });
        }
        const obligations = capability.listPending(record.id);
        const { policy, fingerprint } = activationPolicy(policies, input);
        const plan = computeActivation({
          contract, obligations, policy, fingerprint, overrides: readOverrides(input),
        });
        step('service.activation.planned', { contractId: record.id, obligations: obligations.length });
        return {
          plan,
          writes: 'none — planning records nothing',
          notModeled: ['billing', 'renewal', 'customer authentication', 'notification', 'scheduling'],
        };
      },
    },

    {
      module: names.contract,
      name: 'activate-service',
      label: 'Activate service coverage',
      description: 'Turn this contract\'s pending service obligations into an operational Service Coverage with its Entitlements. It is not a signed agreement, it amends no commercial record, and nothing is billed or sent.',
      actionContract: 1,
      input: [
        { name: 'coverageKey', type: 'string', required: true, hint: 'Your identifier for this coverage. The same key activates once, so a retry is safe.' },
        { name: 'customerRef', type: 'string', required: true, hint: 'An operational label for the customer. It authenticates nobody.' },
        { name: 'startDate', type: 'string', required: true, hint: 'YYYY-MM-DD. Operational, never a signed commitment.' },
        { name: 'endDate', type: 'string', required: false },
        { name: 'policy', type: 'string', required: false },
        { name: 'policyVersion', type: 'integer', required: false },
        { name: 'overrides', type: 'json', required: false },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, domains, actor, now, step }) {
        requireHuman(actor, 'Activating service coverage');
        const coverages = trusted(modules, names.coverage);
        const coverageKey = boundedText(input.coverageKey, 'coverageKey', { required: true, max: MAX_KEY, singleLine: true });
        const sourceKey = `service-coverage:${record.id}:${coverageKey}`;
        const existing = bySourceKey(coverages, sourceKey);

        const customerRef = boundedText(input.customerRef, 'customerRef', { required: true, max: MAX_REF, singleLine: true });
        const startDate = calendarDate(input.startDate, 'startDate', { required: true });
        const endDate = calendarDate(input.endDate, 'endDate');
        if (endDate && endDate < startDate) {
          throw new ValidationError('endDate must not be before startDate', { field: 'endDate' });
        }

        if (existing) {
          // The policy a caller *stated* is part of what they asked for. A
          // retry that names a different policy is a different request, and
          // answering it from storage would report a policy decision that was
          // never applied. A retry that names none asked for whatever was
          // recorded, and is answered.
          const stated = {};
          if (input.policy !== undefined && input.policy !== null && input.policy !== '') {
            stated.policyName = requiredString(input.policy, 'policy');
          }
          if (input.policyVersion !== undefined && input.policyVersion !== null) {
            if (!Number.isSafeInteger(input.policyVersion)) {
              throw new ValidationError('policyVersion must be a whole number', { field: 'policyVersion' });
            }
            stated.policyVersion = Number(input.policyVersion);
          }
          requireSameRecord(existing, { customerRef, startDate, endDate, ...stated }, 'service coverage');
          step('service.coverage.already-activated', { id: existing.id });
          return { serviceCoverage: existing, entitlements: [], created: false };
        }

        const capability = obligationsCapability({ domains, modules, actor, now });
        const contract = capability.getContract(record.id);
        if (!contract) {
          throw new AppError('This contract could not be read through the service-obligations capability', {
            code: 'SERVICE_CONTRACT_UNREADABLE', status: 409,
          });
        }
        const obligations = capability.listPending(record.id);
        if (obligations.length === 0) {
          throw new AppError('This contract has no pending service obligations, so there is nothing to activate', {
            code: 'SERVICE_NOTHING_TO_ACTIVATE', status: 409,
          });
        }
        const { policy, fingerprint } = activationPolicy(policies, input);
        // Recomputed server-side from the source and the policy: a caller may
        // choose the policy and resolve an ambiguity, and supplies no outcome.
        const plan = computeActivation({
          contract, obligations, policy, fingerprint, overrides: readOverrides(input),
        });
        if (!plan.decidable) {
          throw new AppError(
            `${plan.ambiguous.length} service obligation(s) cannot be decided by "${policy.name}@${policy.version}". A human must supply an override with a reason, or the activation is a guess`,
            {
              code: 'SERVICE_ACTIVATION_AMBIGUOUS', status: 409,
              details: { ambiguous: plan.ambiguous.map((entry) => entry.obligationId).sort() },
            },
          );
        }

        const coverage = await coverages.createManaged({
          sourceKey,
          contractId: record.id,
          activationId: contract.activationId ?? null,
          orderId: contract.orderId ?? null,
          obligationRefs: JSON.stringify(plan.obligationIds),
          customerRef,
          customerNameSnapshot: contract.customerName ?? null,
          companyId: contract.companyId ?? null,
          contactId: contract.contactId ?? null,
          status: 'active',
          startDate,
          endDate,
          policyName: policy.name,
          policyVersion: policy.version,
          policyFingerprint: fingerprint,
          entitlementCount: plan.entitlements.length,
          activatedBy: actorId(actor), activatedAt: now(),
          endedReason: null, endedBy: null, endedAt: null,
        }, { actor });

        const entitlementService = trusted(modules, names.entitlement);
        const entitlements = [];
        let overrideCount = 0;
        for (const entry of plan.entitlements) {
          if (entry.decidedBy === 'human-override') overrideCount += 1;
          entitlements.push(await entitlementService.createManaged({
            sourceKey: `service-entitlement:${coverage.id}:${entry.obligationId}`,
            serviceCoverageId: coverage.id,
            contractId: record.id,
            serviceObligationId: entry.obligationId,
            label: entry.label,
            supportTier: entry.supportTier,
            categories: JSON.stringify(entry.categories),
            priorities: JSON.stringify(entry.priorities),
            firstResponseTargetMinutes: entry.firstResponseTargetMinutes,
            resolutionTargetMinutes: entry.resolutionTargetMinutes,
            maxOpenCases: entry.maxOpenCases,
            quantity: null,
            startDate, endDate,
            policyName: policy.name, policyVersion: policy.version, policyFingerprint: fingerprint,
            decisionReason: entry.reason ?? null,
            createdBy: actorId(actor), issuedAt: now(),
          }, { actor }));
        }

        // Consume the obligations inside this transaction, through the
        // capability. Contracts keeps its storage private and nothing
        // commercial is altered by it.
        await capability.markActivated({
          contractId: record.id,
          obligationIds: plan.obligationIds,
          coverageRef: coverage.id,
          actor,
        });

        const runs = trusted(modules, names.activationRun);
        await runs.createManaged({
          sourceKey: `service-activation-run:${coverage.id}`,
          contractId: record.id,
          serviceCoverageId: coverage.id,
          obligationRefs: JSON.stringify(plan.obligationIds),
          obligationCount: plan.obligationIds.length,
          entitlementCount: entitlements.length,
          policyName: policy.name, policyVersion: policy.version, policyFingerprint: fingerprint,
          overrideCount,
          activatedBy: actorId(actor), activatedAt: now(),
        }, { actor });

        step('service.coverage.activated', { id: coverage.id, entitlements: entitlements.length });
        return { serviceCoverage: coverage, entitlements, created: true, amendedCommercialRecord: false };
      },
    },

    {
      module: names.coverage,
      name: 'end-service-coverage',
      label: 'End service coverage',
      description: 'Record that this coverage stopped. It closes no case, cancels no subscription, bills nothing and reverses no obligation.',
      actionContract: 1,
      fromStates: ['active'],
      input: [
        { name: 'reason', type: 'string', required: true },
        { name: 'endDate', type: 'string', required: false, hint: 'YYYY-MM-DD. Defaults to the recorded start when omitted.' },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Ending service coverage');
        const coverages = trusted(modules, names.coverage);
        const reason = boundedText(input.reason, 'reason', { required: true, max: MAX_LABEL });
        const endDate = calendarDate(input.endDate, 'endDate') ?? record.endDate ?? record.startDate;
        if (endDate < record.startDate) {
          throw new ValidationError('endDate must not be before the coverage start', { field: 'endDate' });
        }
        // Open cases outlive the coverage on purpose: destroying them would
        // rewrite support history to make a lifecycle look tidy.
        const open = modules.get(names.supportCase).service
          .listWhere({ serviceCoverageId: record.id })
          .filter((row) => row.status !== 'closed').length;
        const ended = await coverages.applyManaged(record.id, {
          status: 'ended', endDate, endedReason: reason,
          endedBy: actorId(actor), endedAt: now(),
        }, { actor });
        step('service.coverage.ended', { id: record.id });
        return { serviceCoverage: ended, openCasesLeftIntact: open, billed: false };
      },
    },

    {
      module: names.entitlement,
      name: 'record-service-case',
      label: 'Record a support case',
      description: 'Record a support case against this entitlement. It is what a user actor recorded: no customer is authenticated, and nothing is emailed, called or messaged.',
      actionContract: 1,
      input: [
        { name: 'caseKey', type: 'string', required: true, hint: 'Your identifier. The same key records once.' },
        { name: 'title', type: 'string', required: true },
        { name: 'description', type: 'string', required: false },
        { name: 'category', type: 'string', required: true, hint: 'Must be one the entitlement covers.' },
        { name: 'priority', type: 'string', required: true },
        { name: 'source', type: 'string', required: false, hint: 'manual or api. A label for where the report came from — never a verified channel.' },
        { name: 'customerContactRef', type: 'string', required: false },
        { name: 'ownerRef', type: 'string', required: false, hint: 'Who is looking at it. A label, not a permission.' },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Recording a support case');
        const cases = trusted(modules, names.supportCase);
        const caseKey = boundedText(input.caseKey, 'caseKey', { required: true, max: MAX_KEY, singleLine: true });
        const sourceKey = `support-case:${record.id}:${caseKey}`;
        const existing = bySourceKey(cases, sourceKey);

        const title = boundedText(input.title, 'title', { required: true, max: MAX_LABEL, singleLine: true });
        const description = boundedText(input.description, 'description');
        const category = boundedText(input.category, 'category', { required: true, max: 60, singleLine: true });
        const priority = oneOf(input.priority, CASE_PRIORITIES, 'priority');
        const source = input.source === undefined || input.source === null || input.source === ''
          ? 'manual' : oneOf(input.source, ['manual', 'api'], 'source');
        const customerContactRef = boundedText(input.customerContactRef, 'customerContactRef', { max: MAX_REF, singleLine: true });
        const ownerRef = boundedText(input.ownerRef, 'ownerRef', { max: MAX_REF, singleLine: true });

        if (existing) {
          requireSameRecord(existing, { title, description, category, priority, source, customerContactRef, ownerRef }, 'support case');
          step('service.case.already-recorded', { id: existing.id });
          return { supportCase: existing, created: false };
        }

        // Server-authoritative entitlement enforcement. None of this depends on
        // the UI having filtered anything.
        const coverage = modules.get(names.coverage).service.get(record.serviceCoverageId);
        coverageIn(coverage, OPENING_COVERAGE_STATES, 'record a case against it');
        const today = now().slice(0, 10);
        if (record.startDate && today < record.startDate) {
          throw new AppError(`This entitlement starts on ${record.startDate}, so no case can be recorded against it yet`, {
            code: 'SERVICE_ENTITLEMENT_NOT_YET_EFFECTIVE', status: 409, details: { startDate: record.startDate },
          });
        }
        if (record.endDate && today > record.endDate) {
          throw new AppError(`This entitlement ended on ${record.endDate}, so no case can be recorded against it`, {
            code: 'SERVICE_ENTITLEMENT_EXPIRED', status: 409, details: { endDate: record.endDate },
          });
        }
        const categories = parseList(record.categories, 'categories');
        if (!categories.includes(category)) {
          throw new AppError(`This entitlement does not cover the category "${category}"`, {
            code: 'SERVICE_CATEGORY_NOT_COVERED', status: 409, details: { covered: categories },
          });
        }
        const priorities = parseList(record.priorities, 'priorities');
        if (!priorities.includes(priority)) {
          throw new AppError(`This entitlement does not cover the priority "${priority}"`, {
            code: 'SERVICE_PRIORITY_NOT_COVERED', status: 409, details: { covered: priorities },
          });
        }
        if (record.maxOpenCases !== null && record.maxOpenCases !== undefined) {
          // Exact and unpaged: a limit computed from a page bound would let the
          // 101st case through on a project with a large history.
          const open = cases.listWhere({ serviceEntitlementId: record.id })
            .filter((row) => row.status !== 'closed').length;
          if (open >= record.maxOpenCases) {
            throw new AppError(
              `This entitlement allows ${record.maxOpenCases} open case(s) and already has ${open}. Nothing is billed for exceeding it: the case is refused`,
              { code: 'SERVICE_OPEN_CASE_LIMIT_REACHED', status: 409, details: { limit: record.maxOpenCases, open } },
            );
          }
        }

        const openedAt = now();
        const created = await cases.createManaged({
          sourceKey,
          caseNumber: `CASE-${sourceKey.slice(-24)}`,
          serviceCoverageId: coverage.id,
          serviceEntitlementId: record.id,
          contractId: record.contractId,
          customerRef: coverage.customerRef,
          customerContactRef,
          source, category, priority, title, description,
          status: 'new',
          ownerRef,
          firstResponseDueAt: addMinutes(openedAt, record.firstResponseTargetMinutes),
          resolutionDueAt: addMinutes(openedAt, record.resolutionTargetMinutes),
          firstRespondedAt: null, resolvedAt: null, resolutionSummary: null, closedAt: null,
          openedBy: actorId(actor), openedAt,
        }, { actor });
        step('service.case.recorded', { id: created.id, priority });
        return { supportCase: created, created: true, customerAuthenticated: false };
      },
    },

    {
      module: names.supportCase,
      name: 'record-first-response',
      label: 'Record the first response',
      description: 'Record that somebody responded to this case for the first time. It is stamped once: a first response has one moment.',
      actionContract: 1,
      fromStates: ['new', 'in_progress', 'waiting_customer'],
      input: [
        { name: 'note', type: 'string', required: false },
        { name: 'visibility', type: 'string', required: false, hint: 'internal or customer_visible — an assertion by the recorder, never an access grant.' },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Recording a first response');
        if (record.firstRespondedAt) {
          throw new AppError(`support-case "${record.id}" already recorded its first response`, {
            code: 'SERVICE_FIRST_RESPONSE_ALREADY_RECORDED', status: 409,
            details: { firstRespondedAt: record.firstRespondedAt },
          });
        }
        const cases = trusted(modules, names.supportCase);
        const activities = trusted(modules, names.caseActivity);
        const note = boundedText(input.note, 'note');
        const visibility = input.visibility === undefined || input.visibility === null || input.visibility === ''
          ? 'internal' : oneOf(input.visibility, VISIBILITY, 'visibility');
        const at = now();
        const responded = await cases.applyManaged(record.id, {
          firstRespondedAt: at,
          status: record.status === 'new' ? 'in_progress' : record.status,
        }, { actor });
        await recordActivity(activities, {
          supportCaseId: record.id, serviceCoverageId: record.serviceCoverageId,
          type: 'note', body: note, visibility,
          fromStatus: record.status, toStatus: responded.status,
          actor, now, key: 'first-response',
        });
        step('service.case.first-response-recorded', { id: record.id });
        return { supportCase: responded, sent: false };
      },
    },

    {
      module: names.supportCase,
      name: 'transition-case',
      label: 'Move the case',
      description: 'Move this case to another state over the declared transition table. Nothing moves on a clock; every move is a human recording one.',
      actionContract: 1,
      fromStates: ['new', 'in_progress', 'waiting_customer', 'resolved'],
      input: [
        { name: 'toStatus', type: 'string', required: true },
        { name: 'note', type: 'string', required: false },
        { name: 'resolutionSummary', type: 'string', required: false, hint: 'Required when resolving.' },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Moving a support case');
        const toStatus = oneOf(input.toStatus, CASE_STATES, 'toStatus');
        const allowed = CASE_TRANSITIONS[record.status] ?? [];
        if (!allowed.includes(toStatus)) {
          throw new AppError(
            `support-case "${record.id}" cannot move from "${record.status}" to "${toStatus}"`,
            {
              code: 'SERVICE_TRANSITION_NOT_ALLOWED', status: 409,
              details: { id: record.id, from: record.status, to: toStatus, allowed: [...allowed] },
            },
          );
        }
        const cases = trusted(modules, names.supportCase);
        const activities = trusted(modules, names.caseActivity);
        const note = boundedText(input.note, 'note');
        const at = now();
        const patch = { status: toStatus };
        if (toStatus === 'resolved') {
          // A resolution nobody described is not evidence that anything was
          // resolved.
          patch.resolutionSummary = boundedText(input.resolutionSummary, 'resolutionSummary', { required: true });
          patch.resolvedAt = at;
        }
        if (toStatus === 'closed') patch.closedAt = at;
        const moved = await cases.applyManaged(record.id, patch, { actor });
        // The ordinal is what makes this evidence unique per *occurrence*. A
        // case legitimately loops in_progress ↔ waiting_customer, and keying the
        // evidence on the pair alone made the second identical move collide with
        // the first and leave the case stuck.
        const sequence = activitySequence(activities, record.id);
        await recordActivity(activities, {
          supportCaseId: record.id, serviceCoverageId: record.serviceCoverageId,
          type: 'transition', body: note,
          fromStatus: record.status, toStatus,
          actor, now, key: `transition:${sequence}:${record.status}:${toStatus}`,
        });
        step(`service.case.${toStatus === 'in_progress' ? 'started' : toStatus === 'waiting_customer' ? 'waiting-customer' : toStatus}`,
          { id: record.id, from: record.status, to: toStatus });
        return {
          supportCase: moved,
          customerAccepted: false,
          billed: false,
        };
      },
    },

    {
      module: names.supportCase,
      name: 'record-case-activity',
      label: 'Record case activity',
      description: 'Append a note, an internal note or a customer reply somebody reported. Append-only, and it grants no customer access: no attachment bytes are stored.',
      actionContract: 1,
      input: [
        { name: 'activityKey', type: 'string', required: true, hint: 'Your identifier. The same key records once.' },
        { name: 'type', type: 'string', required: true, hint: 'note, internal_note or customer_reply.' },
        { name: 'body', type: 'string', required: true },
        { name: 'visibility', type: 'string', required: false },
        { name: 'evidenceRef', type: 'string', required: false, hint: 'Your own reference. Nothing is stored or fetched here.' },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Recording case activity');
        const activities = trusted(modules, names.caseActivity);
        const activityKey = boundedText(input.activityKey, 'activityKey', { required: true, max: MAX_KEY, singleLine: true });
        // A caller's key lives in its own namespace. It used to share one with
        // the keys the framework writes itself, so a note recorded under
        // "first-response" or "transition:resolved:closed" permanently blocked
        // the action that owns that key — on append-only records with no
        // correction path.
        const sourceKey = callerActivityKey(record.id, activityKey);
        const existing = bySourceKey(activities, sourceKey);
        // `transition` and `escalation` are written by the actions that cause
        // them: letting a caller assert one would let it fabricate history.
        const type = oneOf(input.type, ['note', 'internal_note', 'customer_reply'], 'type');
        const body = boundedText(input.body, 'body', { required: true });
        const visibility = input.visibility === undefined || input.visibility === null || input.visibility === ''
          ? 'internal' : oneOf(input.visibility, VISIBILITY, 'visibility');
        const evidenceRef = boundedText(input.evidenceRef, 'evidenceRef', { max: MAX_REF, singleLine: true });

        if (existing) {
          requireSameRecord(existing, { type, body, visibility, evidenceRef }, 'case activity');
          step('service.case.activity-already-recorded', { id: existing.id });
          return { caseActivity: existing, created: false };
        }
        const created = await activities.createManaged({
          sourceKey,
          supportCaseId: record.id,
          serviceCoverageId: record.serviceCoverageId,
          type, body, evidenceRef, visibility,
          fromStatus: null, toStatus: null,
          recordedBy: actorId(actor), occurredAt: now(),
        }, { actor });
        step('service.case.activity-recorded', { id: created.id, type });
        return { caseActivity: created, created: true, customerNotified: false };
      },
    },

    {
      module: names.supportCase,
      name: 'preview-sla',
      label: 'Preview the SLA state',
      description: 'What the elapsed-time targets say about this case right now. Read-only: it records nothing, and an agent may call it.',
      actionContract: 1,
      input: [],
      /** @param {any} ctx */
      async execute({ record, now, step }) {
        const evaluation = evaluateSla(record, now());
        step('service.sla.previewed', { id: record.id });
        return {
          slaPreview: evaluation,
          persisted: false,
          limits: [
            'elapsed wall-clock minutes only',
            'no business-hours calendar', 'no holidays', 'no paused clock',
            'no contractual or legal SLA interpretation',
          ],
        };
      },
    },

    {
      module: names.supportCase,
      name: 'record-sla-evaluation',
      label: 'Record an SLA evaluation',
      description: 'Persist what the elapsed-time targets said at this instant, with the inputs it used. It is evidence about a moment, never current truth.',
      actionContract: 1,
      input: [
        { name: 'evaluationKey', type: 'string', required: true, hint: 'Your identifier. The same key records once.' },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Recording an SLA evaluation');
        const evaluations = trusted(modules, names.slaEvaluation);
        const evaluationKey = boundedText(input.evaluationKey, 'evaluationKey', { required: true, max: MAX_KEY, singleLine: true });
        const sourceKey = `service-sla-evaluation:${record.id}:${evaluationKey}`;
        const existing = bySourceKey(evaluations, sourceKey);
        if (existing) {
          step('service.sla.already-evaluated', { id: existing.id });
          return { slaEvaluation: existing, created: false };
        }
        const evaluation = evaluateSla(record, now());
        const created = await evaluations.createManaged({
          sourceKey,
          supportCaseId: record.id,
          serviceCoverageId: record.serviceCoverageId,
          serviceEntitlementId: record.serviceEntitlementId,
          firstResponseState: evaluation.firstResponseState,
          resolutionState: evaluation.resolutionState,
          evaluatedAt: evaluation.evaluatedAt,
          openedAt: evaluation.openedAt,
          firstResponseDueAt: evaluation.firstResponseDueAt,
          resolutionDueAt: evaluation.resolutionDueAt,
          firstRespondedAt: evaluation.firstRespondedAt,
          resolvedAt: evaluation.resolvedAt,
          basis: evaluation.basis,
          recordedBy: actorId(actor),
        }, { actor });
        step('service.sla.evaluated', { id: created.id });
        return { slaEvaluation: created, created: true, contractualBreach: false };
      },
    },

    {
      module: names.supportCase,
      name: 'record-escalation',
      label: 'Record an escalation',
      description: 'Record that a human escalated this case, and why. Nothing is routed, notified or assigned: there is no scheduler and no role enforcement, so a target is a label.',
      actionContract: 1,
      input: [
        { name: 'escalationKey', type: 'string', required: true },
        { name: 'level', type: 'string', required: true, hint: 'internal, management or vendor.' },
        { name: 'reason', type: 'string', required: true },
        { name: 'targetRef', type: 'string', required: false },
        { name: 'slaEvaluationId', type: 'string', required: false, hint: 'The recorded evaluation this escalation rests on, if any.' },
        { name: 'evidenceRef', type: 'string', required: false },
      ],
      /** @param {any} ctx */
      async execute({ record, input, modules, actor, now, step }) {
        requireHuman(actor, 'Recording an escalation');
        const escalations = trusted(modules, names.escalation);
        const activities = trusted(modules, names.caseActivity);
        const escalationKey = boundedText(input.escalationKey, 'escalationKey', { required: true, max: MAX_KEY, singleLine: true });
        const sourceKey = `service-escalation:${record.id}:${escalationKey}`;
        const existing = bySourceKey(escalations, sourceKey);
        const level = oneOf(input.level, ESCALATION_LEVELS, 'level');
        const reason = boundedText(input.reason, 'reason', { required: true });
        const targetRef = boundedText(input.targetRef, 'targetRef', { max: MAX_REF, singleLine: true });
        const evidenceRef = boundedText(input.evidenceRef, 'evidenceRef', { max: MAX_REF, singleLine: true });
        let slaEvaluationId = null;
        if (input.slaEvaluationId !== undefined && input.slaEvaluationId !== null && input.slaEvaluationId !== '') {
          const id = requiredString(input.slaEvaluationId, 'slaEvaluationId');
          const found = modules.get(names.slaEvaluation).service.listWhere({ id })
            .find((row) => row.supportCaseId === record.id);
          if (!found) throw new ValidationError('slaEvaluationId does not belong to this case', { field: 'slaEvaluationId' });
          slaEvaluationId = id;
        }

        if (existing) {
          requireSameRecord(existing, { level, reason, targetRef, slaEvaluationId, evidenceRef }, 'escalation');
          step('service.case.escalation-already-recorded', { id: existing.id });
          return { escalation: existing, created: false };
        }
        const created = await escalations.createManaged({
          sourceKey,
          supportCaseId: record.id,
          serviceCoverageId: record.serviceCoverageId,
          level, reason, targetRef, slaEvaluationId, evidenceRef,
          recordedBy: actorId(actor), recordedAt: now(),
        }, { actor });
        await recordActivity(activities, {
          supportCaseId: record.id, serviceCoverageId: record.serviceCoverageId,
          type: 'escalation', body: reason, evidenceRef,
          actor, now, key: `escalation:${escalationKey}`,
        });
        step('service.case.escalation-recorded', { id: created.id, level });
        return { escalation: created, created: true, routed: false, notified: false };
      },
    },
  ];
}

/** A stored JSON list, refused rather than guessed when it cannot be read. */
function parseList(value, field) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch {
    throw new AppError(`The entitlement's ${field} could not be read, so nothing can be checked against it`, {
      code: 'SERVICE_ENTITLEMENT_CORRUPT', status: 409, details: { field },
    });
  }
}

/** Function-free schema metadata for the service surface. */
export function serviceMetadata(policies) {
  return {
    serviceContract: 1,
    coverageStates: [...COVERAGE_STATES],
    caseStates: [...CASE_STATES],
    caseTransitions: Object.fromEntries(
      Object.entries(CASE_TRANSITIONS).map(([from, to]) => [from, [...to]]),
    ),
    casePriorities: [...CASE_PRIORITIES],
    activityTypes: [...ACTIVITY_TYPES],
    visibility: [...VISIBILITY],
    escalationLevels: [...ESCALATION_LEVELS],
    slaStates: [...SLA_STATES],
    coverageMeaning: 'a service coverage is an OPERATIONAL record activated from a contract\'s service obligations. It is not a signed agreement: nobody signed it, it has no envelope, signer or artifact, and it neither amends nor replaces the Commercial Contract it came from',
    slaBasis: 'elapsed wall-clock minutes from openedAt against the injected UTC clock. There is no business-hours calendar, no holiday table, no paused clock (waiting_customer does NOT stop it) and no contractual or legal SLA interpretation. A recorded evaluation is what the clock said at a stated instant, never current truth',
    humanApproval: 'activating, ending, recording a case, a first response, a transition, an activity, an SLA evaluation and an escalation each require actor.type === "user"; an agent is refused 403 HUMAN_APPROVAL_REQUIRED. Planning and previewing are read-only and open to an agent. This is a human-actor boundary, not Service Manager or customer role enforcement',
    caseMeaning: 'a support case is what a USER ACTOR recorded. No customer is authenticated, no channel is integrated, nothing is emailed, called or messaged, and the visibility label is an assertion rather than an access grant',
    escalationMeaning: 'an escalation is recorded evidence that a human escalated. Nothing is routed, notified, assigned or scheduled by it',
    entitlementMeaning: 'an entitlement is immutable evidence derived from one service obligation under a versioned, fingerprinted policy. It is not a billing unit, not a consumption meter and not a permission',
    notModeled: [
      'billing', 'invoicing', 'payment', 'billing eligibility',
      'a second legal contract', 'contract amendment', 'renewal', 'expansion',
      'authenticated customer identity', 'customer portal', 'agent portal',
      'email', 'chat', 'WhatsApp', 'telephony', 'any external send or notification',
      'attachment or file storage', 'knowledge base',
      'business-hours or holiday calendars', 'paused SLA clocks',
      'automatic escalation', 'scheduling', 'a durable outbox',
      'customer success health scoring', 'RBAC', 'tenancy',
    ],
  };
}
