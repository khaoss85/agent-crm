// @ts-check

import {
  AppError, ConflictError, ValidationError, computeDefinitionFingerprint, withTimeout,
} from '../../core/index.js';
import { rankRoutingTargets } from './registry.js';

/**
 * Framework-provided Lead Intelligence actions (ADR-015), starter-registered
 * like buildMoveStageAction (ADR-014): enrich, record-signal, score, route.
 *
 * Storage model: the snapshot/signal/run/assignment record modules declare
 * EVERY field `writable: "managed"`, so the factory generates them READ-ONLY
 * on the public surface (capabilities get/list, no public create/update at
 * all) with a trusted in-process `createManaged` — no generic client can
 * create empty or forged rows, and records are immutable once written.
 *
 * Reads that decide correctness use the generated services' exact-match
 * `listWhere`/`countWhere` queries (complete, indexed via the manifests'
 * `index` flags) — never the paged `list()`, so no correctness decision
 * depends on a page bound.
 *
 * Lifecycle: the intelligence actions are server-gated to ACTIVE leads —
 * enrich/score/record-signal from `new` or `qualified`, route from `new` only
 * (an unrouted qualified lead was worked manually; converted/disqualified
 * leads are out of the intelligence lifecycle). The generic Admin hides the
 * actions in other states via the advertised fromStates, and the server
 * enforces them regardless of client.
 */

const KEY_RE = /^[a-z][a-z0-9-]*$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const LANGUAGE_RE = /^[a-z]{2}$/;
const MAX_TEXT = 500;
/**
 * Characters a single-line label may not contain: the C0 range including tab,
 * newline and carriage return, DEL, the C1 range, and the Unicode line and
 * paragraph separators.
 *
 * Deliberately stricter than this repository's prose rule elsewhere, which
 * permits tab and newline because a human-written *reason* is prose. A signal
 * `value` is not prose — see `optionalSignalValue` — so it is one line by
 * contract.
 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/**
 * Statuses that count toward a routing target's CURRENT load: capacity means
 * active workload, not lifetime assignments. A converted or disqualified lead
 * releases its slot (ADR-015 addendum).
 */
export const ACTIVE_LEAD_STATUSES = Object.freeze(['new', 'qualified']);

/** @typedef {{
 *   module?: string,
 *   snapshotModule?: string,
 *   signalModule?: string,
 *   scoreRunModule?: string,
 *   contributionModule?: string,
 *   routingRunModule?: string,
 *   routeEvaluationModule?: string,
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
    routeEvaluationModule: config.routeEvaluationModule ?? 'route-evaluation',
    assignmentModule: config.assignmentModule ?? 'assignment',
    timeoutMs: Number.isSafeInteger(config.timeoutMs) && /** @type {number} */ (config.timeoutMs) > 0
      ? /** @type {number} */ (config.timeoutMs)
      : DEFAULT_TIMEOUT_MS,
  };
}

/** Recursively freeze plain data (used for evaluation contexts and config). */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Create an immutable record through the trusted in-process path. */
async function createRecord(modules, moduleName, patch, actor) {
  const service = modules.get(moduleName).service;
  if (typeof service.createManaged !== 'function') {
    throw new AppError(
      `Module "${moduleName}" is not a read-only managed record module (createManaged missing) — regenerate it from the current manifest`,
      { code: 'INTELLIGENCE_STORAGE_INVALID', status: 500 },
    );
  }
  return service.createManaged(patch, { actor });
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
 * A caller-supplied signal `value`: optional, bounded, single-line.
 *
 * **What `value` is.** An optional scalar qualifier on an immutable observed
 * signal — which pricing page, which plan tier, which campaign. Measured before
 * choosing a rule: nothing in this repository *reads* it. Scoring counts
 * `signalType`, routing never sees it, no Admin section renders it. It is
 * stored evidence, and the thing stored evidence must be is bounded and
 * inspectable.
 *
 * **Why 500, and why nothing was copied.** `MAX_TEXT` above is this domain's
 * own existing bound, already governing every other text this file accepts;
 * `value` was simply never held to it. Reusing it keeps one number for one
 * domain instead of adding a third opinion. The larger prose bounds elsewhere
 * in this repository govern prose, and a short qualifier is not prose.
 *
 * **Why single-line.** The rule protects the record's *structural* integrity,
 * not its appearance. A NUL, a C0/C1 control or a line break changes what the
 * stored value **is** to anything that reads it line by line; that is a
 * storage-level concern and belongs here.
 *
 * It is deliberately **not** a rendering rule. Bidirectional overrides
 * (U+202E), zero-width characters and homoglyphs are display hazards, and they
 * are accepted today, unchanged — escaping and display safety are the
 * renderer's job, which is also why every accepted value is still stored
 * byte-identical. Drawing the line anywhere else would mean this function
 * quietly becoming a sanitizer, and a sanitizer that runs on write is how
 * evidence stops being evidence.
 *
 * **A known asymmetry, recorded rather than widened.** The provider-supplied
 * snapshot fields above share this `MAX_TEXT` bound but carry no control
 * character rule. They are a different trust boundary — provider output, a 502
 * — and holding them to this rule would be a second behaviour migration beyond
 * the two defects this change exists to close. Tracked in
 * `docs/architecture/EXTRACTION_PREPARATION.md`, not smuggled in here.
 *
 * A refusal is a `ValidationError` (400): this is caller input. Provider output
 * is a different failure with a different meaning and stays a 502.
 *
 * **Trimming and empty-to-null are pre-existing**, not introduced here: the
 * generated module service already trimmed and nullified. Verified against the
 * pre-fix tree, input by input, so this change adds no normalization of its
 * own — only a length bound and a control-character refusal.
 *
 * @param {unknown} value
 */
function optionalSignalValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ValidationError('value must be a string', { field: 'value' });
  }
  // Bound the raw input, not the trimmed one: 5,000 spaces is still 5,000
  // characters somebody sent, and accepting it to then discard it invites the
  // next caller to send 5,000,000.
  if (value.length > MAX_TEXT) {
    throw new ValidationError(`value must be at most ${MAX_TEXT} characters`, { field: 'value' });
  }
  if (CONTROL_RE.test(value)) {
    throw new ValidationError('value must not contain control characters or line breaks', { field: 'value' });
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Validate and normalize a provider result into the snapshot shape. Anything
 * outside the contract is PROVIDER_INVALID — the framework never persists
 * unvalidated third-party data, and never the full raw payload. Only declared
 * own properties are read; unknown fields are ignored.
 * @param {unknown} raw
 */
function normalizeEnrichment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('Enrichment provider returned a non-object result', { code: 'PROVIDER_INVALID', status: 502 });
  }
  const result = /** @type {Record<string, any>} */ (raw);
  const fields = Object.hasOwn(result, 'fields') ? result.fields : undefined;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new AppError('Enrichment provider result needs a "fields" object', { code: 'PROVIDER_INVALID', status: 502 });
  }
  const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
  const normalized = {
    companyDomain: optionalBoundedText(own(fields, 'companyDomain'), 'companyDomain'),
    companyName: optionalBoundedText(own(fields, 'companyName'), 'companyName'),
    country: optionalBoundedText(own(fields, 'country'), 'country', COUNTRY_RE),
    employeeRange: optionalBoundedText(own(fields, 'employeeRange'), 'employeeRange'),
    industry: optionalBoundedText(own(fields, 'industry'), 'industry'),
    revenueRange: optionalBoundedText(own(fields, 'revenueRange'), 'revenueRange'),
    language: optionalBoundedText(own(fields, 'language'), 'language', LANGUAGE_RE),
  };
  let confidence = null;
  const rawConfidence = own(result, 'confidence');
  if (rawConfidence !== undefined && rawConfidence !== null) {
    if (!Number.isSafeInteger(rawConfidence) || rawConfidence < 0 || rawConfidence > 100) {
      throw new AppError('Enrichment provider returned an invalid "confidence" (integer 0–100)', {
        code: 'PROVIDER_INVALID',
        status: 502,
      });
    }
    confidence = rawConfidence;
  }
  const sourceRef = optionalBoundedText(own(result, 'sourceRef'), 'sourceRef');
  let expiresAt = null;
  const rawExpires = own(result, 'expiresAt');
  if (rawExpires !== undefined && rawExpires !== null) {
    if (typeof rawExpires !== 'string' || Number.isNaN(Date.parse(rawExpires))) {
      throw new AppError('Enrichment provider returned an invalid "expiresAt"', { code: 'PROVIDER_INVALID', status: 502 });
    }
    expiresAt = new Date(rawExpires).toISOString();
  }
  const partial = own(result, 'partial') === true;
  return { fields: normalized, confidence, sourceRef, expiresAt, status: partial ? 'partial' : 'complete' };
}

/**
 * The latest non-expired snapshot for lead+provider, or null. Exact query —
 * complete regardless of table size; deterministic tie-break retrievedAt desc,
 * id desc.
 */
function latestValidSnapshot(modules, snapshotModule, leadId, providerName, atIso) {
  const candidates = modules
    .get(snapshotModule)
    .service.listWhere({ leadId, provider: providerName })
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
 * The declared-fingerprintable projection of the lead fields a scoring model
 * may read: the public fields plus lifecycle status — recorded per ScoreRun so
 * a historical score's mutable inputs are evidenced even after the lead
 * changes (values are fingerprinted, not copied — LI-09 stays partial).
 */
function leadInputView(record) {
  return {
    id: record.id,
    firstName: record.firstName ?? null,
    lastName: record.lastName ?? null,
    email: record.email ?? null,
    companyName: record.companyName ?? null,
    source: record.source ?? null,
    status: record.status ?? null,
  };
}

/**
 * lead.enrich — call an enrichment provider OUTSIDE the transaction (prepare
 * phase), then persist one immutable snapshot and the Lead's managed links
 * atomically. Refresh semantics: a non-expired snapshot for the same
 * lead+provider is reused (no provider call); an expired one leads to a NEW
 * snapshot version — historical snapshots are never overwritten. Provider
 * failure/timeout/invalid data fails the action with an honest trace and
 * persists nothing.
 * @param {IntelligenceActionConfig} [config]
 */
export function buildEnrichAction(config, registries) {
  const cfg = resolved(config);
  return {
    module: cfg.module,
    name: 'enrich',
    label: 'Enrich',
    description: 'Fetch firmographic data from an enrichment provider into an immutable snapshot.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['new', 'qualified'],
    input: [
      { name: 'provider', type: 'string', required: true, hint: 'Registered enrichment provider name (see schema intelligence.enrichmentProviders).' },
    ],
    /** @param {any} ctx */
    async prepare({ record, input, modules, config: appConfig, now, step }) {
      const { definition: provider, fingerprint } = registries.getProvider(input.provider);
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
        provider: { name: provider.name, version: provider.version, fingerprint },
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
      const snapshots = modules.get(cfg.snapshotModule).service;
      const sequence = snapshots.countWhere({ leadId: record.id, provider: prepared.provider.name }) + 1;
      const sourceKey = `enrich:${record.id}:${prepared.provider.name}@${prepared.provider.version}:${sequence}`;
      const snapshot = await createRecord(
        modules,
        cfg.snapshotModule,
        {
          leadId: record.id,
          provider: prepared.provider.name,
          providerVersion: prepared.provider.version,
          providerFingerprint: prepared.provider.fingerprint,
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
    providerFingerprint: snapshot.providerFingerprint ?? null,
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
export function buildRecordSignalAction(config, registries) {
  const cfg = resolved(config);
  return {
    module: cfg.module,
    name: 'record-signal',
    label: 'Record signal',
    description: 'Append an immutable behavioral signal for this lead.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['new', 'qualified'],
    input: [
      { name: 'signalType', type: 'string', required: true, hint: 'Canonical key, e.g. pricing-page-visited, demo-requested.' },
      { name: 'source', type: 'string', required: false },
      { name: 'observedAt', type: 'timestamp', required: true },
      { name: 'value', type: 'string', required: false, hint: 'Optional single-line qualifier, at most 500 characters; no control characters.' },
      { name: 'sourceKey', type: 'string', required: false, hint: 'Deterministic dedupe key; defaults to signal:<leadId>:<type>:<observedAt>.' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, actor, modules, step }) {
      if (!KEY_RE.test(input.signalType)) {
        throw new ValidationError('signalType must be a canonical key (lowercase letters, digits, hyphens)', {
          field: 'signalType',
        });
      }
      // Validated before anything is written, so an invalid value leaves no
      // record, no audit entry and no trace step behind.
      const value = optionalSignalValue(input.value);
      const sourceKey = input.sourceKey ?? `signal:${record.id}:${input.signalType}:${input.observedAt}`;
      const signal = await createRecord(
        modules,
        cfg.signalModule,
        {
          leadId: record.id,
          signalType: input.signalType,
          source: input.source ?? null,
          observedAt: input.observedAt,
          value,
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
 * transaction. Chosen semantics: EVERY explicit score request creates a new
 * historical run (safe retry, deterministic for identical inputs); the Lead's
 * latest links update atomically with the run. The run records the declared
 * model fingerprint, the snapshot id, the ordered signal-set fingerprint AND a
 * fingerprint of the mutable lead fields read by rules, so historical runs
 * stay evidenced after the lead changes.
 * @param {IntelligenceActionConfig} [config]
 */
export function buildScoreAction(config, registries) {
  const cfg = resolved(config);
  return {
    module: cfg.module,
    name: 'score',
    label: 'Score',
    description: 'Calculate an explainable score with a versioned scoring model.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['new', 'qualified'],
    input: [
      { name: 'model', type: 'string', required: true, hint: 'Registered scoring model name (see schema intelligence.scoringModels).' },
      { name: 'version', type: 'integer', required: true, hint: 'Explicit model version — never an implicit latest.' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, actor, modules, managed, now, step }) {
      const { definition, fingerprint } = registries.getScoringModel(input.model, input.version);
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

      const signals = modules
        .get(cfg.signalModule)
        .service.listWhere({ leadId: record.id })
        .sort((a, b) => (a.observedAt === b.observedAt ? (a.id < b.id ? -1 : 1) : a.observedAt < b.observedAt ? -1 : 1));

      const context = Object.freeze({
        lead: Object.freeze({ ...record }),
        snapshot: snapshot ? Object.freeze({ ...snapshot }) : null,
        signals: Object.freeze(signals.map((signal) => Object.freeze({ ...signal }))),
        config: deepFreeze(structuredClone(definition.config ?? {})),
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
        const matched = outcome === true || (outcome !== null && typeof outcome === 'object' && !(outcome instanceof Promise) && outcome.matched === true);
        if (typeof outcome !== 'boolean' && (outcome === null || typeof outcome !== 'object' || outcome instanceof Promise || typeof outcome.matched !== 'boolean')) {
          throw new AppError(`Scoring rule "${rule.key}" must return a synchronous boolean or {matched, reason} — Promises are rejected`, {
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
      const run = await createRecord(
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
          leadFingerprint: computeDefinitionFingerprint(leadInputView(record)),
          totalScore: total,
          evaluatedAt,
          status: 'completed',
        },
        actor,
      );
      for (const contribution of contributions) {
        await createRecord(modules, cfg.contributionModule, { runId: run.id, ...contribution }, actor);
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
 * `409 LEAD_NOT_SCORED`. Current load = exact indexed count of ACTIVE leads
 * (status new|qualified) assigned to each target, computed in-transaction —
 * converted/disqualified leads release their capacity slot. The run records
 * the target-set fingerprint plus one route-evaluation row per candidate
 * target (eligible or not, with reason, load, capacity, priority), so a
 * historical decision stays explainable after target data changes.
 * @param {IntelligenceActionConfig} [config]
 */
export function buildRouteAction(config, registries) {
  const cfg = resolved(config);
  return {
    module: cfg.module,
    name: 'route',
    label: 'Route',
    description: 'Assign the lead with a versioned, deterministic routing policy.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['new'],
    input: [
      { name: 'policy', type: 'string', required: true, hint: 'Registered routing policy name (see schema intelligence.routingPolicies).' },
      { name: 'version', type: 'integer', required: true, hint: 'Explicit policy version — never an implicit latest.' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, actor, modules, managed, now, step }) {
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
      const { definition, fingerprint } = registries.getRoutingPolicy(input.policy, input.version);
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

      // Exact indexed ACTIVE-workload count per target (capacity semantics).
      const leadService = modules.get(cfg.module).service;
      const loadOf = (key) => leadService.countWhere({ assignedTargetId: key, status: [...ACTIVE_LEAD_STATUSES] });
      const score = record.score ?? scoreRun.totalScore;
      const allTargets = registries
        .listTargets()
        .map((target) => Object.freeze({ ...target, currentLoad: loadOf(target.key) }));
      const candidates = allTargets.filter((target) => target.kind !== 'fallback');
      /** @param {any} target — null when eligible, else the exclusion reason */
      const exclusionReason = (target) => {
        if (target.active !== true) return 'inactive';
        if (target.scoreMin !== undefined && score < target.scoreMin) return `score ${score} below scoreMin ${target.scoreMin}`;
        if (target.scoreMax !== undefined && score > target.scoreMax) return `score ${score} above scoreMax ${target.scoreMax}`;
        if (target.capacity !== undefined && target.capacity !== null && target.currentLoad >= target.capacity) {
          return `at capacity (${target.currentLoad}/${target.capacity} active leads)`;
        }
        return null;
      };
      const eligible = candidates.filter((target) => exclusionReason(target) === null);

      const context = Object.freeze({
        lead: Object.freeze({ ...record }),
        score,
        snapshot: snapshot ? Object.freeze({ ...snapshot }) : null,
        targets: Object.freeze(eligible),
        allTargets: Object.freeze(allTargets),
        config: deepFreeze(structuredClone(definition.config ?? {})),
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
      if (decision instanceof Promise) {
        throw new AppError('Routing policies must return synchronously — Promises are rejected', {
          code: 'ROUTING_POLICY_INVALID',
          status: 500,
        });
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
        const fallback = registries.fallbackTarget();
        if (!fallback || fallback.active !== true) {
          throw new AppError('No eligible routing target and no active fallback queue', {
            code: 'NO_ELIGIBLE_TARGET',
            status: 409,
          });
        }
        selected = { ...fallback, currentLoad: loadOf(fallback.key) };
        fallbackReason = eligible.length === 0 ? 'no eligible target' : 'policy declined all eligible targets';
      }

      const run = await createRecord(
        modules,
        cfg.routingRunModule,
        {
          leadId: record.id,
          policy: definition.name,
          policyVersion: definition.version,
          fingerprint,
          targetsFingerprint: registries.targetsFingerprint(),
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
      // Per-candidate evaluation evidence: why each target was in or out, with
      // the exact load/capacity/priority the decision saw.
      for (const target of candidates) {
        const reason = exclusionReason(target);
        await createRecord(
          modules,
          cfg.routeEvaluationModule,
          {
            runId: run.id,
            targetKey: target.key,
            kind: target.kind,
            eligible: reason === null,
            reason: reason ?? (target.key === selected.key ? 'selected' : 'eligible, not selected'),
            currentLoad: target.currentLoad,
            capacity: target.capacity ?? null,
            priority: target.priority ?? 0,
          },
          actor,
        );
      }
      const assignment = await createRecord(
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
        targetsFingerprint: run.targetsFingerprint,
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
