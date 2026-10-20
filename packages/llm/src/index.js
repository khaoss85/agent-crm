// @ts-check

import { AppError, ValidationError, definePackage, selectPackageGraph } from '../../core/index.js';
import { LlmRegistries } from './adapter.js';
import { createFixtureLlmAdapter, FIXTURE_LLM_ADAPTER_NAME, FIXTURE_LLM_ADAPTER_VERSION, FIXTURE_LLM_SECRET } from './fixture.js';
import { createOpenAiLlmAdapter, OPENAI_ADAPTER_NAME, OPENAI_ADAPTER_VERSION, OPENAI_DEFAULT_MODEL } from './openai.js';
import {
  LLM_AUDIT_LIMIT,
  LLM_CAPABILITY,
  LLM_CAPABILITY_VERSION,
  LLM_ESTIMATED_PRICING_CENTS_PER_1K,
  LLM_PACKAGE,
  LLM_PURPOSES,
  LLM_RESOURCES,
  createLlmOperations,
  estimateCostCents,
  openLlmComplete,
} from './operations.js';

/**
 * The LLM domain package (backlog:6e54d6a7988a).
 *
 * The framework-native language-model path the owner picked on 19/10 for
 * Q-L1 (docs/backoffice/OPEN-QUESTIONS.md): the assistant, the Advisor,
 * "write/suggest with AI" and free questions run on one adapter contract
 * with the cheapest OpenAI model, and the key arrives later from the
 * owner. Until then every call without a key is an explicit dry-run on
 * the fixture adapter — announced, audited, with no network behind it.
 *
 * It reuses and never duplicates: the adapter-contract shape (validate +
 * fingerprint + registry + shared kit) of `packages/channels` and
 * `packages/calendar-sync`, secret custody as a deployment-injected
 * `resolveSecret` edge, the module factory for its usage and audit rows,
 * and the caller's actor on every write. It changes no kernel file
 * (ADR-018). Answers that cite customer data carry their record ids in
 * `sources`, like the prototype demands — the ids travel, the records
 * stay where they are.
 *
 * What is deliberately NOT here: the key itself (never in the repo, never
 * in a log), a second provider (a new adapter proving the same kit), and
 * durable cross-process budgeting beyond the managed rows.
 */

export {
  FIXTURE_LLM_ADAPTER_NAME,
  FIXTURE_LLM_ADAPTER_VERSION,
  FIXTURE_LLM_SECRET,
  LLM_AUDIT_LIMIT,
  LLM_CAPABILITY,
  LLM_CAPABILITY_VERSION,
  LLM_ESTIMATED_PRICING_CENTS_PER_1K,
  LLM_PACKAGE,
  LLM_PURPOSES,
  LLM_RESOURCES,
  OPENAI_ADAPTER_NAME,
  OPENAI_ADAPTER_VERSION,
  OPENAI_DEFAULT_MODEL,
  createFixtureLlmAdapter,
  createLlmOperations,
  createOpenAiLlmAdapter,
  estimateCostCents,
  openLlmComplete,
};
export { LLM_ADAPTER_CONTRACT, LLM_MAX_CHARS_PER_TOKEN, LlmRegistries, assertCompletion, assertGenerateInput, validateLlmAdapter } from './adapter.js';
export { LLM_KIT_CHECKS, runLlmAdapterKit } from './kit.js';

/**
 * @param {{
 *   config?: Record<string, any>,
 *   adapters?: any[],
 *   resolveSecret?: (reference: string, context?: any) => Promise<string | null>,
 *   spaces?: Record<string, any>,
 *   spaceConfig?: (spaceId: string) => any,
 *   secretRef?: string,
 *   defaultAdapter?: {name: string, version: number},
 *   defaultModel?: string,
 *   defaultDailyTokenCap?: number,
 *   pricing?: Record<string, {input: number, output: number}>,
 *   clock?: () => number,
 * }} [options]
 */
export function createLlmPackage(options = {}) {
  const { resolveSecret } = options;
  if (resolveSecret !== undefined && typeof resolveSecret !== 'function') {
    throw new ValidationError('llm resolveSecret must be a function', { field: 'resolveSecret' });
  }
  const handle = createLlmOperations({
    adapters: options.adapters,
    defaultAdapter: options.defaultAdapter,
    defaultModel: options.defaultModel,
    spaces: options.spaces,
    spaceConfig: options.spaceConfig,
    secretRef: options.secretRef,
    resolveSecret,
    defaultDailyTokenCap: options.defaultDailyTokenCap,
    pricing: options.pricing,
    clock: options.clock,
  });

  const pkg = definePackage({
    packageContract: 1,
    name: LLM_PACKAGE,
    version: 1,
    label: 'Language-model completions',
    description:
      'One space-scoped LLM path on a single adapter contract: an explicit dry-run without a key, a daily '
      + 'token and cost ceiling per space, no provider call for spaces without AI, and one audit row per '
      + 'attempt with usage but never prompt text. First real adapter: OpenAI on the cheapest model.',
    resources: [...LLM_RESOURCES],
    requires: [],
    actions: [],
    capabilities: [
      {
        name: LLM_CAPABILITY,
        version: LLM_CAPABILITY_VERSION,
        description:
          'Complete one bounded prompt for an enabled space: dry-run without a key, daily ceilings '
          + 'enforced, one audit row per attempt. Async like the channel template-send capability.',
        /** @param {{modules: any}} context */
        create(context = {}) {
          const modules = context?.modules;
          if (!modules || typeof modules.get !== 'function') {
            throw new AppError('llm-complete@1 requires the caller\'s modules view', {
              code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
            });
          }
          return openLlmComplete(handle, { modules });
        },
      },
    ],
    operations: [
      {
        operationContract: 1,
        name: 'complete-llm-call',
        label: 'Complete one LLM call',
        appMethod: 'completeLlmCall',
        description:
          'Run one bounded completion for an enabled space through the composed adapter: dry-run without '
          + 'a key, daily ceilings enforced before any provider is touched, one audit row per attempt.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space slug — always explicit, never inferred.' },
          { name: 'purpose', type: 'string', hint: `One of: ${LLM_PURPOSES.join(', ')}.` },
          { name: 'messages', type: 'json', hint: '1-64 {role, content} messages; content is bounded text.' },
          { name: 'model', type: 'string', hint: `Optional: ${OPENAI_DEFAULT_MODEL} unless the space allowlists more.` },
        ],
        create(runtime) {
          const modules = runtime.modules;
          return async (request) => handle.complete(request, modules);
        },
      },
      {
        operationContract: 1,
        name: 'read-llm-usage',
        label: 'Read LLM usage',
        appMethod: 'readLlmUsage',
        description: 'Read the per-day token and estimated-cost totals of one space.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space slug — always explicit, never inferred.' },
        ],
        create(runtime) {
          const modules = runtime.modules;
          return async (request) => handle.readUsage(request, modules);
        },
      },
      {
        operationContract: 1,
        name: 'read-llm-audit',
        label: 'Read LLM audit',
        appMethod: 'readLlmAudit',
        description: 'Read the recent LLM attempt rows of one space: usage and verdicts, never prompt text.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space slug — always explicit, never inferred.' },
        ],
        create(runtime) {
          const modules = runtime.modules;
          return async (request) => handle.readAudit(request, modules);
        },
      },
    ],
  });

  /**
   * Adapter fingerprints persist exactly where every other declared
   * definition's do — the package definition-version store — so a moved
   * adapter source stops the boot like any other drift (ADR-015, same
   * shape as `packages/channels/src/index.js`).
   * @param {any} database
   */
  pkg.persistFingerprints = (database) => handle.registries.persistFingerprints(database);

  /** The registries, for the composition that owns this package instance. */
  pkg.registries = handle.registries;
  return selectPackageGraph(pkg);
}
