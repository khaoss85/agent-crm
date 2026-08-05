// @ts-check

import { AppError, ConflictError, NotFoundError, ValidationError } from './errors.js';
import { computeDefinitionFingerprint, rankRoutingTargets } from './intelligence-registry.js';

/**
 * Framework-provided Lead Intelligence actions (ADR-015), starter-registered
 * like buildMoveStageAction (ADR-014): enrich, record-signal, score, route.
 *
 * Storage model: the snapshot/signal/run/assignment record modules declare
 * EVERY field `writable: "managed"`, so public create can only make an empty
 * row, public update is a structural no-op, and the sole data write path is
 * the in-process applyManaged used here — immutable through public CRUD by
 * construction. Records are created empty and filled with one applyManaged
 * call inside the action's transaction.
 *
 * Reads that need "all X for lead L" are bounded list-and-filter scans
 * (limit 500) — the documented local-development posture (ADR-013 precedent),
 * not a scalable index.
 */

const KEY_RE = /^[a-z][a-z0-9-]*$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const LANGUAGE_RE = /^[a-z]{2}$/;
const MAX_TEXT = 500;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** @typedef {{
 *   module?: string,
 *   snapshotModule?: string,
 *   signalModule?: string,
 *   scoreRunModule?: string,
 *   contributionModule?: string,
 *   routingRunModule?: string,
 *   assignmentModule?: string,
 *   timeoutMs?: number,
 * }} IntelligenceActionConfig */

/** @param {IntelligenceActionConfig} [config] */
function resolved(config = {}) {
  return {
    module: config.module ?? 'lead',
    snapshotModule: config.snapshotModule ?? 'enrichment-snapshot',
    signalModule: config.signalModule ?? 'behavioral-signal',
    scoreRunModule: config.scoreRunModule ?? 'score-run',
    contributionModule: config.contributionModule ?? 'score-contribution',
    routingRunModule: config.routingRunModule ?? 'routing-run',
    assignmentModule: config.assignmentModule ?? 'assignment',
    timeoutMs: Number.isSafeInteger(config.timeoutMs) && /** @type {number} */ (config.timeoutMs) > 0
      ? /** @type {number} */ (config.timeoutMs)
      : DEFAULT_TIMEOUT_MS,
  };
}

/** Create an all-managed record: empty create, then one managed fill. */
async function createManagedRecord(modules, moduleName, patch, actor) {
  const service = modules.get(moduleName).service;
  const empty = await service.create({}, { actor });
  return service.applyManaged(empty.id, patch, { actor });
}

/** Bounded list-and-filter over a generated module (documented 500-row local bound). */
function listForLead(modules, moduleName, leadId, field = 'leadId') {
  return modules
    .get(moduleName)
    .service.list({ limit: 500 })
    .filter((record) => record[field] === leadId);
}

/** @param {Promise<any>} promise @param {number} ms @param {string} label */
function withTimeout(promise, ms, label) {
  /** @type {any} */
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new AppError(`${label} timed out after ${ms}ms`, { code: 'PROVIDER_TIMEOUT', status: 504 })),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** @param {unknown} value @param {string} field @param {RegExp | null} [shape] */
function optionalBoundedText(value, field, shape = null) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_TEXT || (shape && !shape.test(value))) {
    throw new AppError(`Enrichment provider returned an invalid "${field}"`, {
      code: 'PROVIDER_INVALID',
      status: 502,
      details: { field },
    });
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Validate and normalize a provider result into the snapshot shape. Anything
 * outside the contract is PROVIDER_INVALID — the framework never persists
 * unvalidated third-party data, and never the full raw payload.
 * @param {unknown} raw
 */
function normalizeEnrichment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('Enrichment provider returned a non-object result', { code: 'PROVIDER_INVALID', status: 502 });
  }
  const result = /** @type {Record<string, any>} */ (raw);
  const fields = result.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new AppError('Enrichment provider result needs a "fields" object', { code: 'PROVIDER_INVALID', status: 502 });
  }
  const normalized = {
    companyDomain: optionalBoundedText(fields.companyDomain, 'companyDomain'),
    companyName: optionalBoundedText(fields.companyName, 'companyName'),
    country: optionalBoundedText(fields.country, 'country', COUNTRY_RE),
    employeeRange: optionalBoundedText(fields.employeeRange, 'employeeRange'),
    industry: optionalBoundedText(fields.industry, 'industry'),
    revenueRange: optionalBoundedText(fields.revenueRange, 'revenueRange'),
    language: optionalBoundedText(fields.language, 'language', LANGUAGE_RE),
  };
  let confidence = null;
  if (result.confidence !== undefined && result.confidence !== null) {
    if (!Number.isSafeInteger(result.confidence) || result.confidence < 0 || result.confidence > 100) {
      throw new AppError('Enrichment provider returned an invalid "confidence" (integer 0–100)', {
        code: 'PROVIDER_INVALID',
        status: 502,
      });
    }
    confidence = result.confidence;
  }
  const sourceRef = optionalBoundedText(result.sourceRef, 'sourceRef');
  let expiresAt = null;
  if (result.expiresAt !== undefined && result.expiresAt !== null) {
    if (typeof result.expiresAt !== 'string' || Number.isNaN(Date.parse(result.expiresAt))) {
      throw new AppError('Enrichment provider returned an invalid "expiresAt"', { code: 'PROVIDER_INVALID', status: 502 });
    }
    expiresAt = new Date(result.expiresAt).toISOString();
  }
  const partial = result.partial === true;
  return { fields: normalized, confidence, sourceRef, expiresAt, status: partial ? 'partial' : 'complete' };
}

/** The latest non-expired snapshot for lead+provider, or null. */
function latestValidSnapshot(modules, snapshotModule, leadId, providerName, atIso) {
  const candidates = listForLead(modules, snapshotModule, leadId)
    .filter((snapshot) => snapshot.provider === providerName && snapshot.sourceKey)
    .filter((snapshot) => typeof snapshot.expiresAt === 'string' && snapshot.expiresAt > atIso)
    .sort((a, b) => (a.retrievedAt === b.retrievedAt ? (a.id < b.id ? 1 : -1) : a.retrievedAt < b.retrievedAt ? 1 : -1));
  return candidates[0] ?? null;
}

/** Public, provider-facing view of a lead record (no managed link fields). */
function providerLeadView(record) {
  return {
    id: record.id,
    firstName: record.firstName ?? null,
    lastName: record.lastName ?? null,
    email: record.email ?? null,
    companyName: record.companyName ?? null,
    source: record.source ?? null,
  };
}

/**
 * lead.enrich — call an enrichment provider OUTSIDE the transaction (prepare
 * phase), then persist one immutable snapshot and the Lead's managed links
 * atomically. Refresh semantics: a non-expired snapshot for the same
 * lead+provider is reused (no provider call); an expired one leads to a NEW
 * snapshot version — historical snapshots are never overwritten. Provider
 * failure/timeout/invalid data fails the action with an honest trace and
 * persists nothing (failed snapshots are deliberately not stored in v1).
 * @param {IntelligenceActionConfig} [config]
 */
export function buildEnrichAction(config) {
  const cfg = resolved(config);
  return {
    module: cfg.module,
    name: 'enrich',
    label: 'Enrich',
    description: 'Fetch firmographic data from an enrichment provider into an immutable snapshot.',
    actionContract: 1,
    input: [
      { name: 'provider', type: 'string', required: true, hint: 'Registered enrichment provider name (see schema intelligence.enrichmentProviders).' },
    ],
    /** @param {any} ctx */
    async prepare({ record, input, intelligence, modules, config: appConfig, now, step }) {
      const provider = intelligence.getProvider(input.provider);
      if (!provider.capabilities.includes('company')) {
        throw new ValidationError(`Enrichment provider "${provider.name}" does not support company enrichment`, {
          field: 'provider',
        });
      }
      const at = now();
      const reusable = latestValidSnapshot(modules, cfg.snapshotModule, record.id, provider.name, at);
      if (reusable) {
        step('enrich.reuse', { snapshotId: reusable.id, sourceKey: reusable.sourceKey });
        return { reuse: true };
      }
      const timeoutMs = Number.isSafeInteger(appConfig?.enrichTimeoutMs) && appConfig.enrichTimeoutMs > 0
        ? appConfig.enrichTimeoutMs
        : cfg.timeoutMs;
      const retrievedAt = at;
      /** @type {unknown} */
      let raw;
      try {
        raw = await withTimeout(
          Promise.resolve(provider.enrichCompany({ lead: providerLeadView(record) }, { now })),
          timeoutMs,
          `Enrichment provider "${provider.name}"`,
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new AppError(`Enrichment provider "${provider.name}" failed: ${message.slice(0, 200)}`, {
          code: 'PROVIDER_FAILED',
          status: 502,
        });
      }
      const normalized = normalizeEnrichment(raw);
      step('enrich.provider', { provider: provider.name, version: provider.version, status: normalized.status });
      return {
        reuse: false,
        provider: { name: provider.name, version: provider.version },
        normalized,
        retrievedAt,
        expiresAt: normalized.expiresAt ?? new Date(Date.parse(retrievedAt) + DEFAULT_TTL_MS).toISOString(),
      };
    },
    /** @param {any} ctx */
    async execute({ record, input, prepared, actor, modules, managed, now, step }) {
      // Authoritative re-check inside the transaction: a concurrent enrich may
      // have created a valid snapshot after prepare — reuse it and discard the
      // prepared provider result (recorded honestly as a step).
      const at = now();
      const existing = latestValidSnapshot(modules, cfg.snapshotModule, record.id, input.provider, at);
      if (existing) {
        if (prepared && prepared.reuse === false) {
          step('enrich.discarded-provider-result', { reason: 'a concurrent enrichment won; reusing its snapshot' });
        }
        const lead = await managed(record.id, { enrichmentSnapshotId: existing.id, enrichedAt: at });
        return { reused: true, snapshot: snapshotSummary(existing), lead: { id: lead.id, enrichmentSnapshotId: lead.enrichmentSnapshotId } };
      }
      if (!prepared || prepared.reuse !== false) {
        // prepare saw a reusable snapshot but it is gone/expired inside the
        // transaction — refuse rather than silently re-calling the provider
        // inside the write lock.
        throw new ConflictError('The reusable enrichment snapshot changed during the request; retry', { transient: true });
      }
      const sequence = listForLead(modules, cfg.snapshotModule, record.id)
        .filter((snapshot) => snapshot.provider === prepared.provider.name).length + 1;
      const sourceKey = `enrich:${record.id}:${prepared.provider.name}@${prepared.provider.version}:${sequence}`;
      const snapshot = await createManagedRecord(
        modules,
        cfg.snapshotModule,
        {
          leadId: record.id,
          provider: prepared.provider.name,
          providerVersion: prepared.provider.version,
          sourceKey,
          status: prepared.normalized.status,
          ...prepared.normalized.fields,
          confidence: prepared.normalized.confidence,
          sourceRef: prepared.normalized.sourceRef,
          retrievedAt: prepared.retrievedAt,
          expiresAt: prepared.expiresAt,
        },
        actor,
      );
      step('enrich.snapshot', { snapshotId: snapshot.id, sourceKey, status: snapshot.status });
      const lead = await managed(record.id, { enrichmentSnapshotId: snapshot.id, enrichedAt: at });
      return {
        reused: false,
        snapshot: snapshotSummary(snapshot),
        lead: { id: lead.id, enrichmentSnapshotId: lead.enrichmentSnapshotId, enrichedAt: lead.enrichedAt },
      };
    },
  };
}

/** @param {any} snapshot */
function snapshotSummary(snapshot) {
  return {
    id: snapshot.id,
    provider: snapshot.provider,
    providerVersion: snapshot.providerVersion,
    sourceKey: snapshot.sourceKey,
    status: snapshot.status,
    country: snapshot.country,
    language: snapshot.language,
    employeeRange: snapshot.employeeRange,
    confidence: snapshot.confidence,
    retrievedAt: snapshot.retrievedAt,
    expiresAt: snapshot.expiresAt,
  };
}

/**
 * lead.record-signal — append one immutable behavioral signal. The
 * deterministic sourceKey (explicit, or `signal:<leadId>:<type>:<observedAt>`)
 * dedupes repeats via the UNIQUE column: a duplicate is a stable 409 with no
 * second record, never a duplicated contribution.
 * @param {IntelligenceActionConfig} [config]
 */
export function buildRecordSignalAction(config) {
  const cfg = resolved(config);
  return {
    module: cfg.module,
    name: 'record-signal',
    label: 'Record signal',
    description: 'Append an immutable behavioral signal for this lead.',
    actionContract: 1,
    input: [
      { name: 'signalType', type: 'string', required: true, hint: 'Canonical key, e.g. pricing-page-visited, demo-requested.' },
      { name: 'source', type: 'string', required: false },
      { name: 'observedAt', type: 'timestamp', required: true },
      { name: 'value', type: 'string', required: false },
      { name: 'sourceKey', type: 'string', required: false, hint: 'Deterministic dedupe key; defaults to signal:<leadId>:<type>:<observedAt>.' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, actor, modules, step }) {
      if (!KEY_RE.test(input.signalType)) {
        throw new ValidationError('signalType must be a canonical key (lowercase letters, digits, hyphens)', {
          field: 'signalType',
        });
      }
      const sourceKey = input.sourceKey ?? `signal:${record.id}:${input.signalType}:${input.observedAt}`;
      const signal = await createManagedRecord(
        modules,
        cfg.signalModule,
        {
          leadId: record.id,
          signalType: input.signalType,
          source: input.source ?? null,
          observedAt: input.observedAt,
          value: input.value ?? null,
          sourceKey,
        },
        actor,
      );
      step('signal.recorded', { signalId: signal.id, sourceKey });
      return { signal: { id: signal.id, signalType: signal.signalType, observedAt: signal.observedAt, sourceKey } };
    },
  };
}

/**
 * lead.score — evaluate a versioned, explainable scoring model in one
 * transaction: every rule runs in declared order against frozen inputs, each
 * contribution is persisted, and the Lead's latest score/run links update
 * atomically with the run. Re-scoring creates a new run (deterministic for
 * identical inputs); historical runs stay readable forever.
 * @param {IntelligenceActionConfig} [config]
 */
export function buildScoreAction(config) {
  const cfg = resolved(config);
  return {
    module: cfg.module,
    name: 'score',
    label: 'Score',
    description: 'Calculate an explainable score with a versioned scoring model.',
    actionContract: 1,
    input: [
      { name: 'model', type: 'string', required: true, hint: 'Registered scoring model name (see schema intelligence.scoringModels).' },
      { name: 'version', type: 'integer', required: true, hint: 'Explicit model version — never an implicit latest.' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, actor, modules, intelligence, managed, now, step }) {
      const { definition, fingerprint } = intelligence.getScoringModel(input.model, input.version);
      const evaluatedAt = now();

      /** @type {any} */
      let snapshot = null;
      if (record.enrichmentSnapshotId) {
        snapshot = modules.get(cfg.snapshotModule).service.get(record.enrichmentSnapshotId);
        if (snapshot.leadId !== record.id) {
          throw new AppError('The lead\'s enrichment snapshot link points at another lead\'s snapshot', {
            code: 'INTELLIGENCE_STATE_CORRUPT',
            status: 409,
          });
        }
        // An expired snapshot is not a valid scoring input: score without it
        // rather than on stale firmographics (documented choice).
        if (typeof snapshot.expiresAt === 'string' && snapshot.expiresAt <= evaluatedAt) snapshot = null;
      }

      const signals = listForLead(modules, cfg.signalModule, record.id)
        .filter((signal) => signal.sourceKey)
        .sort((a, b) => (a.observedAt === b.observedAt ? (a.id < b.id ? -1 : 1) : a.observedAt < b.observedAt ? -1 : 1));

      const context = Object.freeze({
        lead: Object.freeze({ ...record }),
        snapshot: snapshot ? Object.freeze({ ...snapshot }) : null,
        signals: Object.freeze(signals.map((signal) => Object.freeze({ ...signal }))),
        evaluatedAt,
      });

      let total = 0;
      const contributions = [];
      for (const rule of definition.rules) {
        /** @type {any} */
        let outcome;
        try {
          outcome = rule.evaluate(context);
        } catch (error) {
          throw new AppError(
            `Scoring rule "${rule.key}" threw (${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}) — scoring models must be total and deterministic`,
            { code: 'SCORING_RULE_INVALID', status: 500, details: { rule: rule.key } },
          );
        }
        const matched = outcome === true || (outcome !== null && typeof outcome === 'object' && outcome.matched === true);
        if (typeof outcome !== 'boolean' && (outcome === null || typeof outcome !== 'object' || typeof outcome.matched !== 'boolean')) {
          throw new AppError(`Scoring rule "${rule.key}" must return a boolean or {matched, reason}`, {
            code: 'SCORING_RULE_INVALID',
            status: 500,
            details: { rule: rule.key },
          });
        }
        const reason = outcome && typeof outcome === 'object' && typeof outcome.reason === 'string'
          ? outcome.reason.slice(0, MAX_TEXT)
          : null;
        const contribution = matched ? rule.weight : 0;
        total += contribution;
        contributions.push({ ruleKey: rule.key, label: rule.label ?? rule.key, matched, contribution, reason });
      }
      if (Number.isSafeInteger(definition.maxScore) && total > definition.maxScore) total = definition.maxScore;
      if (Number.isSafeInteger(definition.minScore) && total < definition.minScore) total = definition.minScore;

      const signalsFingerprint = signals.length
        ? computeDefinitionFingerprint(signals.map((signal) => signal.id).sort())
        : null;
      const run = await createManagedRecord(
        modules,
        cfg.scoreRunModule,
        {
          leadId: record.id,
          model: definition.name,
          modelVersion: definition.version,
          fingerprint,
          snapshotId: snapshot?.id ?? null,
          signalCount: signals.length,
          signalsFingerprint,
          totalScore: total,
          evaluatedAt,
          status: 'completed',
        },
        actor,
      );
      for (const contribution of contributions) {
        await createManagedRecord(modules, cfg.contributionModule, { runId: run.id, ...contribution }, actor);
      }
      step('score.evaluated', { runId: run.id, model: definition.name, version: definition.version, total });

      const lead = await managed(record.id, { score: total, scoreRunId: run.id, scoredAt: evaluatedAt });
      return {
        runId: run.id,
        model: definition.name,
        version: definition.version,
        fingerprint,
        total,
        snapshotId: snapshot?.id ?? null,
        signalCount: signals.length,
        contributions,
        lead: { id: lead.id, score: lead.score, scoreRunId: lead.scoreRunId },
      };
    },
  };
}

/**
 * lead.route — deterministic assignment under a versioned routing policy, in
 * one transaction. Chosen v1 semantics: an already-assigned lead is a stable
 * `409 ALREADY_ASSIGNED` (explicit reroute is deferred); an unscored lead is
 * `409 LEAD_NOT_SCORED`. Current load = count of leads currently assigned to
 * each target, computed in-transaction from the lead module (the documented
 * capacity source). Ties break by the documented deterministic ranking
 * (priority desc → load asc → key asc) — never randomness. When nothing is
 * eligible the declared fallback target takes the lead with a recorded
 * reason; with no fallback the action is `409 NO_ELIGIBLE_TARGET`.
 * @param {IntelligenceActionConfig} [config]
 */
export function buildRouteAction(config) {
  const cfg = resolved(config);
  return {
    module: cfg.module,
    name: 'route',
    label: 'Route',
    description: 'Assign the lead with a versioned, deterministic routing policy.',
    actionContract: 1,
    input: [
      { name: 'policy', type: 'string', required: true, hint: 'Registered routing policy name (see schema intelligence.routingPolicies).' },
      { name: 'version', type: 'integer', required: true, hint: 'Explicit policy version — never an implicit latest.' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, actor, modules, intelligence, managed, now, step }) {
      if (record.assignedTargetId) {
        throw new AppError(`Lead is already assigned to "${record.assignedTargetId}" — rerouting is not supported in v1`, {
          code: 'ALREADY_ASSIGNED',
          status: 409,
          details: { assignedTargetId: record.assignedTargetId },
        });
      }
      if (!record.scoreRunId) {
        throw new AppError('Lead has no score run — run lead.score before routing', {
          code: 'LEAD_NOT_SCORED',
          status: 409,
        });
      }
      const { definition, fingerprint } = intelligence.getRoutingPolicy(input.policy, input.version);
      const scoreRun = modules.get(cfg.scoreRunModule).service.get(record.scoreRunId);
      if (scoreRun.leadId !== record.id) {
        throw new AppError('The lead\'s score-run link points at another lead\'s run', {
          code: 'INTELLIGENCE_STATE_CORRUPT',
          status: 409,
        });
      }
      const snapshot = record.enrichmentSnapshotId
        ? modules.get(cfg.snapshotModule).service.get(record.enrichmentSnapshotId)
        : null;
      const routedAt = now();

      // Current load per target: leads currently assigned to it (bounded scan).
      const leads = modules.get(cfg.module).service.list({ limit: 500 });
      const load = new Map();
      for (const lead of leads) {
        if (lead.assignedTargetId) load.set(lead.assignedTargetId, (load.get(lead.assignedTargetId) ?? 0) + 1);
      }
      const score = record.score ?? scoreRun.totalScore;
      const allTargets = intelligence
        .listTargets()
        .map((target) => Object.freeze({ ...target, currentLoad: load.get(target.key) ?? 0 }));
      const candidates = allTargets.filter((target) => target.kind !== 'fallback');
      const eligible = candidates.filter(
        (target) =>
          target.active === true &&
          (target.scoreMin === undefined || score >= target.scoreMin) &&
          (target.scoreMax === undefined || score <= target.scoreMax) &&
          (target.capacity === undefined || target.capacity === null || target.currentLoad < target.capacity),
      );

      const context = Object.freeze({
        lead: Object.freeze({ ...record }),
        score,
        snapshot: snapshot ? Object.freeze({ ...snapshot }) : null,
        targets: Object.freeze(eligible),
        allTargets: Object.freeze(allTargets),
        rank: rankRoutingTargets,
        routedAt,
      });
      /** @type {any} */
      let decision;
      try {
        decision = definition.route(context);
      } catch (error) {
        throw new AppError(
          `Routing policy "${definition.name}@${definition.version}" threw (${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}) — policies must be total and deterministic`,
          { code: 'ROUTING_POLICY_INVALID', status: 500 },
        );
      }

      let selected = null;
      let matchedRule = null;
      let fallbackReason = null;
      if (decision !== null && decision !== undefined) {
        if (typeof decision !== 'object' || typeof decision.target !== 'string') {
          throw new AppError('Routing policies must return {target, rule} or null', {
            code: 'ROUTING_POLICY_INVALID',
            status: 500,
          });
        }
        selected = eligible.find((target) => target.key === decision.target) ?? null;
        if (!selected) {
          throw new AppError(
            `Routing policy selected "${decision.target}", which is not an eligible target`,
            { code: 'ROUTING_POLICY_INVALID', status: 500 },
          );
        }
        matchedRule = typeof decision.rule === 'string' ? decision.rule.slice(0, MAX_TEXT) : null;
      } else {
        const fallback = intelligence.fallbackTarget();
        if (!fallback || fallback.active !== true) {
          throw new AppError('No eligible routing target and no active fallback queue', {
            code: 'NO_ELIGIBLE_TARGET',
            status: 409,
          });
        }
        selected = { ...fallback, currentLoad: load.get(fallback.key) ?? 0 };
        fallbackReason = eligible.length === 0 ? 'no eligible target' : 'policy declined all eligible targets';
      }

      const run = await createManagedRecord(
        modules,
        cfg.routingRunModule,
        {
          leadId: record.id,
          policy: definition.name,
          policyVersion: definition.version,
          fingerprint,
          scoreRunId: scoreRun.id,
          snapshotId: snapshot?.id ?? null,
          evaluatedTargets: candidates.length,
          eligibleTargets: eligible.length,
          selectedTarget: selected.key,
          matchedRule,
          fallbackReason,
          routedAt,
          status: 'completed',
        },
        actor,
      );
      const assignment = await createManagedRecord(
        modules,
        cfg.assignmentModule,
        {
          leadId: record.id,
          targetId: selected.key,
          source: 'automatic',
          routingRunId: run.id,
          previousAssignmentId: null,
          effectiveAt: routedAt,
          reason: matchedRule ?? fallbackReason,
        },
        actor,
      );
      step('route.assigned', { runId: run.id, target: selected.key, fallback: fallbackReason !== null });

      const lead = await managed(record.id, { assignedTargetId: selected.key, assignedAt: routedAt, routingRunId: run.id });
      return {
        runId: run.id,
        assignmentId: assignment.id,
        policy: definition.name,
        version: definition.version,
        fingerprint,
        target: { key: selected.key, kind: selected.kind, label: selected.label ?? selected.key },
        matchedRule,
        fallbackReason,
        evaluatedTargets: candidates.length,
        eligibleTargets: eligible.length,
        lead: { id: lead.id, assignedTargetId: lead.assignedTargetId, assignedAt: lead.assignedAt },
      };
    },
  };
}
