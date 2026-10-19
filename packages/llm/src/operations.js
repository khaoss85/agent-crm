// @ts-check

import { createHash, randomBytes } from 'node:crypto';
import { AppError, ValidationError } from '../../core/index.js';
import { assertLlmMaxTokens, assertLlmMessages, assertLlmModel } from './adapter.js';

/**
 * LLM operations (backlog:6e54d6a7988a).
 *
 * One guarded doorway between the team's features (assistente, Advisor,
 * "Scrivi/Suggerisci con AI", domande libere) and the provider adapter:
 *
 * 1. space without AI enabled → LLM_SPACE_DISABLED, and the adapter is
 *    never touched: no call, no bytes, no data leaves the space;
 * 2. daily cap per space → past it the call is refused with
 *    LLM_DAILY_CAP_EXCEEDED naming the cap and the UTC reset, before any
 *    provider traffic;
 * 3. space without a key → an explicit dry-run receipt (`dryRun: true`),
 *    with no transport call: the owner generates the real key later, and
 *    until then every feature renders its honest "AI non configurata"
 *    state instead of failing halfway;
 * 4. every decided call writes one `llm-call` audit row with counts, the
 *    outcome and a prompt hash — never the prompt text — and the provider
 *    key never reaches a row, a log line, or a thrown error.
 *
 * The audit is a managed evidence record (`modules/llm-call.module.json`):
 * it exists only through this operation. Key custody is deployment-owned
 * through the `resolveSecret` edge, like the channels package: a space
 * with a secret reference but no wired custody refuses instead of
 * inventing one.
 */

export const LLM_AUDIT_MODULE = 'llm-call';
export const LLM_SECRET_PURPOSE = 'llm-provider-key';

/** Managed-record handle; a CRUD-writable module is refused. */
function trusted(modules, name) {
  const service = modules?.get?.(name)?.service;
  if (!service || typeof service.createManaged !== 'function' || typeof service.listWhere !== 'function') {
    throw new AppError(`Module "${name}" is not a managed record module — apply its manifest first`, {
      code: 'LLM_AUDIT_UNAVAILABLE', status: 500,
    });
  }
  return service;
}

function llmError(code, status, message) {
  return new AppError(message, { code, status });
}

function assertSpaceId(spaceId) {
  if (typeof spaceId !== 'string' || spaceId.length < 1 || spaceId.length > 128) {
    throw new ValidationError('llm spaceId must be a 1-128 char string', { field: 'spaceId' });
  }
  return spaceId;
}

function assertPurpose(purpose) {
  if (typeof purpose !== 'string' || purpose.length < 1 || purpose.length > 128) {
    throw new ValidationError('llm purpose must be a 1-128 char string', { field: 'purpose' });
  }
  return purpose;
}

function assertActor(actor) {
  if (!actor || typeof actor !== 'object' || typeof actor.type !== 'string' || typeof actor.id !== 'string') {
    throw new ValidationError('llm complete needs an actor { type, id }', { field: 'actor' });
  }
  return actor;
}

function assertSpaceConfig(entry, spaceId) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw llmError('LLM_SPACE_NOT_CONFIGURED', 409, `space "${spaceId}" has no LLM configuration`);
  }
  if (entry.aiEnabled !== true) {
    throw llmError('LLM_SPACE_DISABLED', 403, `AI is not enabled for space "${spaceId}": no data was sent anywhere`);
  }
  const dailyCap = entry.dailyCap;
  if (!Number.isSafeInteger(dailyCap) || dailyCap < 1 || dailyCap > 1000000) {
    throw new ValidationError('llm space dailyCap must be 1-1000000', { field: 'spaces.dailyCap' });
  }
  if (entry.secretRef !== undefined && (typeof entry.secretRef !== 'string' || entry.secretRef === '')) {
    throw new ValidationError('llm space secretRef must be a non-empty string when set', { field: 'spaces.secretRef' });
  }
  if (entry.model !== undefined) assertLlmModel(entry.model);
  return entry;
}

/** UTC-midnight bucket for the daily cap, from the injected clock. */
export function utcDayStartMs(nowMs) {
  const dayMs = 24 * 3600 * 1000;
  return Math.floor(nowMs / dayMs) * dayMs;
}

/** Content-free fingerprint: proves what was asked without keeping it. */
export function hashPrompt(messages) {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

function scrubKeyText(text, key) {
  if (typeof text !== 'string' || typeof key !== 'string' || key === '') return text;
  return text.split(key).join('[REDACTED]');
}

/**
 * @param {{
 *   adapter: any,
 *   resolveSecret?: (reference: string, context: { spaceId: string, purpose: string }) => Promise<string>,
 *   spaces?: Record<string, { aiEnabled: boolean, dailyCap: number, secretRef?: string, model?: string }>,
 *   modules: any,
 *   now?: () => string,
 * }} deps `modules` is the module-service map holding the applied
 * `llm-call` manifest; audit writes refuse without it, fail-closed.
 */
export function createLlmOperations(deps = {}) {
  const { adapter } = deps;
  if (!adapter || typeof adapter.complete !== 'function') {
    throw new ValidationError('llm operations need an adapter with complete()', { field: 'adapter' });
  }
  const { resolveSecret } = deps;
  if (resolveSecret !== undefined && typeof resolveSecret !== 'function') {
    throw new ValidationError('llm resolveSecret must be a function', { field: 'resolveSecret' });
  }
  const spaces = deps.spaces ?? {};
  if (!spaces || typeof spaces !== 'object' || Array.isArray(spaces)) {
    throw new ValidationError('llm spaces must be a per-space config object', { field: 'spaces' });
  }
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
  const modules = deps.modules;
  const auditOf = () => trusted(modules, LLM_AUDIT_MODULE);

  async function audit(row) {
    const service = auditOf();
    // One row per decided call: the key is unique by construction (space +
    // prompt hash + instant + randomness), so a retry audits twice rather
    // than colliding — the audit counts attempts, never dedups them.
    const sourceKey = `llm:${row.spaceId}:${String(row.promptHash).slice(0, 12)}:${row.occurredAt}:${randomBytes(4).toString('hex')}`;
    return service.createManaged({ ...row, sourceKey });
  }

  async function countTodayCalls(spaceId, nowMs) {
    const service = auditOf();
    const start = utcDayStartMs(nowMs);
    const rows = await service.listWhere({ spaceId });
    let count = 0;
    for (const row of rows) {
      if (row.outcome !== 'ok' && row.outcome !== 'error') continue;
      const at = Date.parse(row.occurredAt);
      if (!Number.isNaN(at) && at >= start) count += 1;
    }
    return count;
  }

  /**
   * Complete one prompt for one space through the configured adapter.
   * Refusals throw typed errors; a space without a key returns an
   * explicit dry-run receipt. Every decided call is audited without the
   * prompt text and without key material.
   */
  async function complete(request = {}) {
    const spaceId = assertSpaceId(request.spaceId);
    assertActor(request.actor);
    const purpose = assertPurpose(request.purpose);
    const messages = assertLlmMessages(request.messages);
    const maxTokens = assertLlmMaxTokens(request.maxTokens);
    const promptHash = hashPrompt(messages);
    const occurredAt = now();
    const nowMs = Date.parse(occurredAt);
    if (Number.isNaN(nowMs)) throw new ValidationError('llm clock must return ISO time', { field: 'now' });

    const writeAudit = (outcome, extra = {}) => audit({
      spaceId, purpose, model: extra.model ?? null,
      inputTokens: extra.inputTokens ?? 0, outputTokens: extra.outputTokens ?? 0,
      outcome, errorCode: extra.errorCode ?? null, promptHash, occurredAt,
    });

    let space;
    try {
      space = assertSpaceConfig(spaces[spaceId], spaceId);
    } catch (error) {
      await writeAudit('refused', { errorCode: error?.code ?? 'LLM_SPACE_NOT_CONFIGURED' });
      throw error;
    }
    const model = request.model === undefined ? (space.model ?? adapter.model) : assertLlmModel(request.model);

    const used = await countTodayCalls(spaceId, nowMs);
    if (used >= space.dailyCap) {
      const resetsAt = new Date(utcDayStartMs(nowMs) + 24 * 3600 * 1000).toISOString();
      await writeAudit('refused', { model, errorCode: 'LLM_DAILY_CAP_EXCEEDED' });
      throw llmError('LLM_DAILY_CAP_EXCEEDED', 429,
        `daily AI cap for space "${spaceId}" reached (${space.dailyCap} calls, resets at ${resetsAt})`);
    }

    if (space.secretRef === undefined) {
      const row = await writeAudit('dry-run', { model });
      return {
        outcome: 'dry-run', dryRun: true, reason: 'LLM_KEY_MISSING',
        detail: 'no provider key is configured for this space yet: wire secretRef and resolveSecret, then retry',
        model, promptHash, auditId: row?.id ?? null,
      };
    }
    if (typeof resolveSecret !== 'function') {
      await writeAudit('refused', { model, errorCode: 'LLM_SECRET_UNAVAILABLE' });
      throw llmError('LLM_SECRET_UNAVAILABLE', 500,
        'LLM secret custody is not wired: compose the package with resolveSecret');
    }
    const key = await resolveSecret(space.secretRef, { spaceId, purpose: LLM_SECRET_PURPOSE });
    if (typeof key !== 'string' || key === '') {
      await writeAudit('refused', { model, errorCode: 'LLM_SECRET_UNAVAILABLE' });
      throw llmError('LLM_SECRET_UNAVAILABLE', 500, 'the per-space provider key did not resolve');
    }

    let result;
    try {
      result = await adapter.complete({ key, messages, model, maxTokens });
    } catch (error) {
      const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'LLM_PROVIDER_UNAVAILABLE';
      const status = error && typeof error === 'object' && Number.isSafeInteger(error.status) ? error.status : 503;
      await writeAudit('error', { model, errorCode: code });
      throw llmError(code, status, scrubKeyText(error?.message ?? 'llm provider failed', key));
    }
    const row = await writeAudit('ok', { model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
    return {
      outcome: 'ok', text: result.text, model: result.model, usage: { ...result.usage },
      promptHash, auditId: row?.id ?? null,
    };
  }

  return { complete, countTodayCalls, hashPrompt, utcDayStartMs };
}
