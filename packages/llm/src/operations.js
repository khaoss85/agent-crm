// @ts-check

import { AppError, ValidationError, requireActor } from '../../core/index.js';
import { LlmRegistries, assertGenerateInput } from './adapter.js';
import { FIXTURE_LLM_SECRET, createFixtureLlmAdapter } from './fixture.js';
import { OPENAI_DEFAULT_MODEL, createOpenAiLlmAdapter } from './openai.js';

/**
 * The LLM package operations (backlog:6e54d6a7988a).
 *
 * One space-scoped completion path with the guards the owner decision
 * demands: the space opts in explicitly (absent or disabled refuses with
 * `LLM_SPACE_DISABLED` before any provider is touched), the day's token
 * and cost ceilings refuse with `LLM_DAILY_CAP_EXCEEDED` before any
 * provider is touched, and the spend section serializes per space-day so
 * racing calls re-read fresh totals. With no `secretRef` configured
 * anywhere the call runs as an explicit dry-run on the fixture adapter —
 * announced in the result and the audit, with no network behind it. With
 * a key expected but custody failing or unwired the call refuses with
 * `LLM_SECRET_UNAVAILABLE` instead of serving canned text. The model
 * surface is closed (the default model plus the space allowlist) and every
 * allowed model needs a valid price, or the call refuses before the
 * provider is touched. Every attempt writes one audit row with the space,
 * the purpose, the adapter, the model, the token counts and the estimated
 * cost: never the prompt text, never the key.
 *
 * State lives in two managed record modules, like every sibling package:
 * `llm-usage-day` (one row per space per UTC day, the running totals the
 * cap reads) and `llm-call-audit` (one row per attempt). Spending is
 * estimated from a declared per-model table the deployment overrides when
 * OpenAI bills the first invoice; the estimate only drives caps and the
 * audit, never a charge.
 */

export const LLM_PACKAGE = 'llm';
export const LLM_RESOURCES = Object.freeze(['llm-usage-day', 'llm-call-audit']);
export const LLM_CAPABILITY = 'llm-complete';
export const LLM_CAPABILITY_VERSION = 1;

/** Where the framework's assistant, Advisor and write/suggest features call from. */
export const LLM_PURPOSES = Object.freeze([
  'assistant',
  'advisor',
  'write-assist',
  'suggest',
  'free-question',
]);

export const LLM_AUDIT_LIMIT = 200;
const SPACE_ID = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const SECRET_REF = /^secret:\/\/[^\/\s]+\/[^\/\s]+$/;
const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

/**
 * Same-process serialization for one space's daily spend, one FIFO chain
 * per space-day: two completions racing the same day re-read the winner's
 * totals instead of overwriting them with a stale snapshot, and the loser
 * of a filled cap refuses instead of spending past it. Cross-process
 * writers still serialize on the managed row. (MEM_ACC_REUSE: the tail
 * pattern of channels' import commits — a package imports only core, so
 * the helper lives here rather than crossing the boundary.)
 */
const daySpendChains = new Map();

/** @param {string} key @param {() => Promise<any>} critical */
function withDaySpend(key, critical) {
  const previous = daySpendChains.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current, () => current);
  daySpendChains.set(key, tail);
  // Synchronous until here: two callers racing in the same tick still
  // order. Tails never reject, so a refused call never wedges the chain.
  return (async () => {
    await previous;
    try {
      return await critical();
    } finally {
      if (daySpendChains.get(key) === tail) daySpendChains.delete(key);
      release();
    }
  })();
}

/**
 * Estimated provider price, US cents per 1000 tokens, by model. Estimates
 * only: the owner picked the cheapest OpenAI model (GPT-5.6 Luna) and the
 * key — hence the first invoice — arrives later. The deployment replaces
 * this table through `pricing` when billing is known.
 */
export const LLM_ESTIMATED_PRICING_CENTS_PER_1K = Object.freeze({
  [OPENAI_DEFAULT_MODEL]: Object.freeze({ input: 0.02, output: 0.08 }),
});

function assertSpaceId(spaceId) {
  if (typeof spaceId !== 'string' || spaceId.length > 63 || !SPACE_ID.test(spaceId)) {
    throw new ValidationError('llm spaceId must be a lowercase slug (at most 63 characters)', { field: 'spaceId' });
  }
  return spaceId;
}

function assertPurpose(purpose) {
  if (!LLM_PURPOSES.includes(purpose)) {
    throw new ValidationError(`llm purpose must be one of: ${LLM_PURPOSES.join(', ')}`, { field: 'purpose' });
  }
  return purpose;
}

function assertSecretRef(secretRef) {
  if (typeof secretRef !== 'string' || secretRef.length > 256 || !SECRET_REF.test(secretRef)) {
    throw new ValidationError('llm secretRef must be a locator like secret://<space>/<name>', { field: 'secretRef' });
  }
  return secretRef;
}

function assertSources(sources) {
  if (sources === undefined) return [];
  if (!Array.isArray(sources) || sources.length > 32) {
    throw new ValidationError('llm sources must be an array of at most 32 record ids', { field: 'sources' });
  }
  return Object.freeze(sources.map((id, index) => {
    if (typeof id !== 'string' || !RECORD_ID.test(id)) {
      throw new ValidationError('llm source must be a bounded record id', { field: `sources[${index}]` });
    }
    return id;
  }));
}

function assertPositiveInt(value, field, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ValidationError(`llm ${field} must be an integer between 1 and ${max}`, { field });
  }
  return value;
}

function todayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function assertRateEntry(tableName, model, rate) {
  if (!rate || typeof rate !== 'object' || Array.isArray(rate)
    || typeof rate.input !== 'number' || typeof rate.output !== 'number'
    || !Number.isFinite(rate.input) || !Number.isFinite(rate.output)
    || rate.input < 0 || rate.output < 0) {
    throw new ValidationError(
      `llm ${tableName} needs finite non-negative input/output numbers for model "${model}"`, { field: 'pricing' });
  }
  return rate;
}

function assertPricingTable(pricing, defaultModel) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
    throw new ValidationError('llm pricing must be a plain object of model rates', { field: 'pricing' });
  }
  for (const [model, rate] of Object.entries(pricing)) {
    assertRateEntry('pricing', model, rate);
  }
  if (!Object.hasOwn(pricing, defaultModel)) {
    throw new ValidationError(`llm pricing is missing the default model "${defaultModel}"`, { field: 'pricing' });
  }
  return pricing;
}

/** @param {{inputTokens: number, outputTokens: number, model: string, pricing: any}} options */
export function estimateCostCents({ inputTokens, outputTokens, model, pricing }) {
  const table = pricing ?? LLM_ESTIMATED_PRICING_CENTS_PER_1K;
  const rate = table?.[model];
  // No cheapest-model fallback: pricing an unknown model at the Luna rate
  // would accrue pennies while the provider bills the premium tier, so the
  // cost ceiling refuses instead of capping against zero.
  if (!rate || typeof rate.input !== 'number' || typeof rate.output !== 'number'
    || !Number.isFinite(rate.input) || !Number.isFinite(rate.output)
    || rate.input < 0 || rate.output < 0) {
    throw new AppError(`llm has no valid price for model "${model}": refusing rather than capping against zero`, {
      code: 'LLM_PRICING_UNAVAILABLE', status: 500,
    });
  }
  return Math.max(0, Math.ceil((inputTokens / 1000) * rate.input + (outputTokens / 1000) * rate.output));
}

function trusted(modules, name) {
  const service = modules.get(name)?.service;
  if (!service || typeof service.createManaged !== 'function' || typeof service.applyManaged !== 'function'
    || typeof service.listWhere !== 'function') {
    throw new AppError(`Module "${name}" is not a managed record module — apply its manifest first`, {
      code: 'LLM_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

function isUniqueConflict(error) {
  if (error !== null && typeof error === 'object') {
    const code = /** @type {any} */ (error).code;
    if (code === 'CONFLICT' || code === 'SQLITE_CONSTRAINT_UNIQUE' || code === '23505') return true;
  }
  if (error instanceof Error) {
    if (error.message.includes('UNIQUE constraint failed')) return true;
    if (error.message.includes('duplicate key value violates unique constraint')) return true;
  }
  return false;
}

/**
 * @param {{
 *   adapters?: any[],
 *   defaultAdapter?: {name: string, version: number},
 *   defaultModel?: string,
 *   spaces?: Record<string, any>,
 *   spaceConfig?: (spaceId: string) => any,
 *   secretRef?: string,
 *   resolveSecret?: (reference: string, context?: any) => Promise<string | null>,
 *   defaultDailyTokenCap?: number,
 *   pricing?: Record<string, {input: number, output: number}>,
 *   clock?: () => number,
 *   randomId?: () => string,
 * }} [options]
 */
export function createLlmOperations(options = {}) {
  const registries = new LlmRegistries({ llmAdapters: options.adapters ?? [] });
  const defaultAdapter = options.defaultAdapter ?? { name: 'openai', version: 1 };
  const defaultModel = options.defaultModel ?? OPENAI_DEFAULT_MODEL;
  if (typeof defaultModel !== 'string' || defaultModel.trim() === '' || defaultModel.length > 128) {
    throw new ValidationError('llm defaultModel must be a bounded non-blank name', { field: 'defaultModel' });
  }
  const defaultDailyTokenCap = options.defaultDailyTokenCap ?? 200000;
  assertPositiveInt(defaultDailyTokenCap, 'defaultDailyTokenCap', 100000000);
  // A typo'd table must fail here, not silently zero every cost ceiling.
  const pricing = assertPricingTable(options.pricing ?? LLM_ESTIMATED_PRICING_CENTS_PER_1K, defaultModel);
  const clock = options.clock ?? Date.now;
  const randomId = options.randomId ?? (() => /** @type {any} */ (crypto).randomUUID());
  const { resolveSecret } = options;
  if (resolveSecret !== undefined && typeof resolveSecret !== 'function') {
    throw new ValidationError('llm resolveSecret must be a function', { field: 'resolveSecret' });
  }
  if (options.secretRef !== undefined) assertSecretRef(options.secretRef);

  // The dry-run adapter is fixture-only and never touches the network: it
  // answers the explicit no-key path, never a production call.
  const dryRun = createFixtureLlmAdapter({ name: 'fixture-llm-dry-run' });

  const readSpace = (spaceId) => {
    if (typeof options.spaceConfig === 'function') {
      const resolved = options.spaceConfig(spaceId);
      if (resolved === null || resolved === undefined) return { enabled: false };
      if (typeof resolved !== 'object' || Array.isArray(resolved)) {
        throw new ValidationError('llm spaceConfig must resolve a plain object', { field: 'spaceConfig' });
      }
      return resolved;
    }
    const spaces = options.spaces ?? {};
    if (spaces === null || typeof spaces !== 'object' || Array.isArray(spaces)) {
      throw new ValidationError('llm spaces must be a plain object', { field: 'spaces' });
    }
    return spaces[spaceId] ?? { enabled: false };
  };

  const adapterFor = (space) => {
    const name = space.adapter ?? defaultAdapter.name;
    const version = space.adapterVersion ?? defaultAdapter.version;
    return registries.getAdapter(name, version);
  };

  // The model surface is closed: the default model plus the space's
  // explicit allowlist, nothing else. An unknown model priced at the
  // cheapest-model rate would accrue pennies while the provider bills the
  // premium tier, so unknown and unpriced models refuse fail-closed.
  const allowedModelsFor = (space) => {
    const extra = space.models ?? [];
    if (!Array.isArray(extra)
      || extra.some((name) => typeof name !== 'string' || name.trim() === '' || name.length > 128)) {
      throw new ValidationError('llm space models must be an array of bounded non-blank names', {
        field: 'space.models',
      });
    }
    return new Set([defaultModel, ...extra]);
  };

  const modelFor = (space, request) => {
    const allowed = allowedModelsFor(space);
    if (request?.model !== undefined) {
      if (typeof request.model !== 'string' || request.model.trim() === '' || request.model.length > 128) {
        throw new ValidationError('llm model must be a bounded non-blank name', { field: 'model' });
      }
      if (!allowed.has(request.model)) {
        throw new ValidationError(`llm model "${request.model}" is not enabled for this space`, { field: 'model' });
      }
      return request.model;
    }
    const configured = space.model ?? defaultModel;
    if (!allowed.has(configured)) {
      throw new AppError(`llm space model "${configured}" is not in the space model allowlist`, {
        code: 'LLM_MODEL_UNAVAILABLE', status: 500,
      });
    }
    return configured;
  };

  const capsFor = (space) => ({
    dailyTokenCap: space.dailyTokenCap ?? defaultDailyTokenCap,
    dailyCostCentsCap: space.dailyCostCentsCap ?? null,
  });

  async function usageToday(usageService, spaceId, actor) {
    const day = todayKey(clock());
    const key = `${spaceId}:${day}`;
    const existing = (await usageService.listWhere({ dayKey: key }))[0] ?? null;
    if (existing) return { day, key, row: existing };
    try {
      const created = await usageService.createManaged({
        dayKey: key, spaceId, day, inputTokens: 0, outputTokens: 0, estimatedCostCents: 0, calls: 0,
      }, { actor });
      return { day, key, row: created };
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      // A concurrent first call of the day won the race: re-read the winner.
      const winner = (await usageService.listWhere({ dayKey: key }))[0] ?? null;
      if (!winner) throw error;
      return { day, key, row: winner };
    }
  }

  async function addUsage(usageService, current, delta, actor) {
    const patch = {
      inputTokens: current.inputTokens + delta.inputTokens,
      outputTokens: current.outputTokens + delta.outputTokens,
      estimatedCostCents: current.estimatedCostCents + delta.estimatedCostCents,
      calls: current.calls + 1,
    };
    try {
      return await usageService.applyManaged(current.id, patch, { actor });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const fresh = (await usageService.listWhere({ dayKey: current.dayKey }))[0] ?? current;
      return usageService.applyManaged(fresh.id, {
        inputTokens: fresh.inputTokens + delta.inputTokens,
        outputTokens: fresh.outputTokens + delta.outputTokens,
        estimatedCostCents: fresh.estimatedCostCents + delta.estimatedCostCents,
        calls: fresh.calls + 1,
      }, { actor });
    }
  }

  /**
   * One audit row per attempt — refused or completed — with the space, the
   * purpose, the adapter, the model, the token counts and the estimated
   * cost. The prompt text is never a column, so it can never be a row.
   */
  async function audit(auditService, entry, actor) {
    const sources = entry.sources ?? [];
    await auditService.createManaged({
      callKey: `call:${entry.spaceId}:${randomId()}`,
      at: new Date(clock()).toISOString(),
      spaceId: entry.spaceId,
      purpose: entry.purpose,
      adapter: entry.adapter,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      estimatedCostCents: entry.estimatedCostCents,
      dryRun: entry.dryRun,
      refused: entry.refused ?? '',
      errorCode: entry.errorCode ?? '',
      sourceCount: sources.length,
      // Every validated id is persisted: the result and the audit row agree,
      // so readAudit can always reconstruct which records an answer cited.
      sources: sources.join(','),
    }, { actor });
  }

  async function complete(request, modules) {
    const actor = requireActor(request?.actor);
    const spaceId = assertSpaceId(request?.spaceId);
    const purpose = assertPurpose(request?.purpose);
    const sources = assertSources(request?.sources);
    const { messages, maxTokens } = assertGenerateInput({
      messages: request?.messages, model: 'pending', maxTokens: request?.maxTokens ?? 1024,
    });
    const usageService = trusted(modules, 'llm-usage-day');
    const auditService = trusted(modules, 'llm-call-audit');

    const space = readSpace(spaceId);
    if (space.enabled !== true) {
      // Disabled is the default: no provider sees the prompt. The refusal
      // is audited with zero tokens, like every other attempt.
      await audit(auditService, {
        spaceId, purpose, adapter: '', model: '', inputTokens: 0, outputTokens: 0,
        estimatedCostCents: 0, dryRun: false, refused: 'space-disabled', sources,
      }, actor);
      throw new AppError('AI is not enabled for this space: no text was sent anywhere', {
        code: 'LLM_SPACE_DISABLED', status: 403,
      });
    }

    const model = modelFor(space, request);
    const caps = capsFor(space);
    assertPositiveInt(caps.dailyTokenCap, 'dailyTokenCap', 100000000);
    if (caps.dailyCostCentsCap !== null) assertPositiveInt(caps.dailyCostCentsCap, 'dailyCostCentsCap', 100000000);
    const timeoutMs = space.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
      throw new ValidationError('llm timeoutMs must be 1000-300000 ms', { field: 'timeoutMs' });
    }

    const secretRef = space.secretRef ?? options.secretRef;
    if (secretRef !== undefined) assertSecretRef(secretRef);
    // The price must exist before the provider is touched: spending first
    // and refusing to account after would leave real money unaudited.
    try {
      assertRateEntry('pricing', model, pricing[model]);
    } catch {
      throw new AppError(`llm has no valid price for model "${model}": refusing before the provider is touched`, {
        code: 'LLM_PRICING_UNAVAILABLE', status: 500,
      });
    }

    // One serialized spend section per space-day: the ceiling re-reads
    // fresh totals and every usage write lands on the winner's row, so
    // racing calls neither bypass the cap nor lose each other's tokens.
    // Computed synchronously so same-tick racers still order on the chain.
    const spendKey = `${spaceId}:${todayKey(clock())}`;
    return withDaySpend(spendKey, async () => {
      const current = await usageToday(usageService, spaceId, actor);
      const usedTokens = current.row.inputTokens + current.row.outputTokens;
      if (usedTokens >= caps.dailyTokenCap
        || (caps.dailyCostCentsCap !== null && current.row.estimatedCostCents >= caps.dailyCostCentsCap)) {
        await audit(auditService, {
          spaceId, purpose, adapter: '', model, inputTokens: 0, outputTokens: 0,
          estimatedCostCents: 0, dryRun: false, refused: 'daily-cap', sources,
        }, actor);
        throw new AppError('the space spent its daily AI budget: the call is refused with its reason', {
          code: 'LLM_DAILY_CAP_EXCEEDED', status: 429,
        });
      }

      if (secretRef === undefined) {
        // No key configured anywhere, no network: the fixture answers
        // explicitly as a dry run and says so in the result and the audit.
        const completion = await dryRun.definition.generate({
          secret: FIXTURE_LLM_SECRET, messages, model, maxTokens,
        });
        const cost = estimateCostCents({ inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, model, pricing });
        await addUsage(usageService, current.row, {
          inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, estimatedCostCents: cost,
        }, actor);
        await audit(auditService, {
          spaceId, purpose, adapter: dryRun.definition.name, model,
          inputTokens: completion.inputTokens, outputTokens: completion.outputTokens,
          estimatedCostCents: cost, dryRun: true, sources,
        }, actor);
        return Object.freeze({
          text: completion.text,
          model: completion.model,
          adapter: dryRun.definition.name,
          dryRun: true,
          dryRunReason: 'missing-key',
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          estimatedCostCents: cost,
          sources,
        });
      }

      // A key is expected: resolve it or refuse. A vault outage, an empty
      // value, or custody never wired must never degrade to a fixture
      // dry-run with canned text — channels refuses
      // CHANNEL_SECRET_UNAVAILABLE and calendar-sync
      // CALENDAR_SECRET_UNAVAILABLE on the same shape, because a consumer
      // that does not branch on dryRun would present fabricated text as
      // the model answer.
      let secret = null;
      if (typeof resolveSecret === 'function') {
        try {
          secret = await resolveSecret(secretRef, { spaceId, purpose: 'llm-complete' });
        } catch {
          secret = null;
        }
      }
      if (typeof secret !== 'string' || secret === '') {
        await audit(auditService, {
          spaceId, purpose, adapter: '', model,
          inputTokens: 0, outputTokens: 0, estimatedCostCents: 0,
          dryRun: false, errorCode: 'LLM_SECRET_UNAVAILABLE', sources,
        }, actor);
        throw new AppError('the llm key is unavailable: no text was sent anywhere', {
          code: 'LLM_SECRET_UNAVAILABLE', status: 500,
        });
      }

      const { definition } = adapterFor(space);
      let completion;
      try {
        completion = await definition.generate({ secret, messages, model, maxTokens, timeoutMs });
      } catch (error) {
        // The adapter's typed error travels intact — its text carries no key
        // and no prompt by construction — with the failure audited.
        const code = error && typeof error === 'object' && typeof /** @type {any} */ (error).code === 'string'
          ? /** @type {any} */ (error).code : 'LLM_PROVIDER_FAILED';
        await audit(auditService, {
          spaceId, purpose, adapter: definition.name, model,
          inputTokens: 0, outputTokens: 0, estimatedCostCents: 0,
          dryRun: false, errorCode: code, sources,
        }, actor);
        throw error;
      }
      const cost = estimateCostCents({
        inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, model, pricing,
      });
      const updated = await addUsage(usageService, current.row, {
        inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, estimatedCostCents: cost,
      }, actor);
      await audit(auditService, {
        spaceId, purpose, adapter: definition.name, model,
        inputTokens: completion.inputTokens, outputTokens: completion.outputTokens,
        estimatedCostCents: cost, dryRun: false, sources,
      }, actor);
      return Object.freeze({
        text: completion.text,
        model: completion.model,
        adapter: definition.name,
        dryRun: false,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        estimatedCostCents: cost,
        sources,
        usage: Object.freeze({
          dayTokens: updated.inputTokens + updated.outputTokens,
          dayCostCents: updated.estimatedCostCents,
        }),
      });
    });
  }

  async function readUsage(request, modules) {
    requireActor(request?.actor);
    const spaceId = assertSpaceId(request?.spaceId);
    const usageService = trusted(modules, 'llm-usage-day');
    const rows = await usageService.listWhere({ spaceId });
    return Object.freeze(rows.map((row) => Object.freeze({
      day: row.day,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      estimatedCostCents: row.estimatedCostCents,
      calls: row.calls,
    })));
  }

  async function readAudit(request, modules) {
    requireActor(request?.actor);
    const spaceId = assertSpaceId(request?.spaceId);
    const auditService = trusted(modules, 'llm-call-audit');
    const limit = request?.limit === undefined ? 50 : request.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LLM_AUDIT_LIMIT) {
      throw new ValidationError(`llm limit must be an integer between 1 and ${LLM_AUDIT_LIMIT}`, { field: 'limit' });
    }
    const rows = await auditService.listWhere({ spaceId });
    const ordered = [...rows].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    return Object.freeze(ordered.slice(-limit).map((row) => Object.freeze({
      at: row.at,
      purpose: row.purpose,
      adapter: row.adapter,
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      estimatedCostCents: row.estimatedCostCents,
      dryRun: row.dryRun,
      refused: row.refused,
      errorCode: row.errorCode,
      sourceCount: row.sourceCount,
      sources: row.sources,
    })));
  }

  return { complete, readUsage, readAudit, registries };
}

/**
 * Open the `llm-complete` capability for one consumer runtime: the path
 * the assistant, the Advisor and the write/suggest features call through
 * once they declare `requires: [{ package: 'llm', capability:
 * 'llm-complete', version: 1 }]`.
 */
export function openLlmComplete(handle, runtime) {
  if (!handle || typeof handle.complete !== 'function') {
    throw new AppError('llm-complete opens no complete', { code: 'LLM_CAPABILITY_INVALID', status: 500 });
  }
  const modules = runtime?.modules;
  if (!modules || typeof modules.get !== 'function') {
    throw new AppError('llm-complete@1 requires the caller\'s modules view', {
      code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
    });
  }
  return Object.freeze({
    capabilityContract: 1,
    complete: (request) => handle.complete(request, modules),
    readUsage: (request) => handle.readUsage(request, modules),
    readAudit: (request) => handle.readAudit(request, modules),
  });
}
